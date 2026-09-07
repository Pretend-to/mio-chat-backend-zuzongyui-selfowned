import { TriggerRegistry } from './TriggerRegistry.js'
import { TriggerRunner } from './TriggerRunner.js'
import { WakeInjector } from './WakeInjector.js'
import { WakeProtocol } from './WakeProtocol.js'

export { TriggerRegistry, TriggerRunner, WakeInjector, WakeProtocol }

const RESTART_DELAY_MS = 500
const MAX_RESTART_DELAY_MS = 60_000

/**
 * TriggerService — 触发器与哨兵系统门面服务单例。
 *
 * Sentinel 脚本是长期运行的独立进程，巡检频率/循环由脚本自己控制。
 * 这里仅负责进程生命周期、@WAKE@ 事件注入，以及 once/persistent 生命周期。
 */
export class TriggerService {
  constructor(opts = {}) {
    this.registry = opts.registry || new TriggerRegistry(opts)
    this.runner = opts.runner || new TriggerRunner(opts)
    this.injector = opts.injector || new WakeInjector({
      channelRuntime: opts.channelRuntime,
      registry: this.registry,
    })
    this._processes = new Map()
    this._runtimeStates = new Map()
    this._restartAttempts = new Map()
    this._restartTimers = new Map()
    this._schedulerStarted = false
    this._stopping = false
  }

  setChannelRuntime(channelRuntime) {
    this.injector.channelRuntime = channelRuntime
  }

  /**
   * 手动或调试触发一次脚本执行（不会复用长期哨兵进程）。
   * @param {string} id - 触发器 ID
   * @param {boolean} [forceWake=false] - 是否在 wake=true 时强制执行唤醒注入
   * @param {string} [agentId] - 可选的 Agent 作用域
   */
  async runOnce(id, { agentId, forceWake = false } = {}) {
    const trigger = await this.registry.get(id, { agentId })
    if (!trigger) {
      throw new Error(`Trigger with id "${id}" not found`)
    }

    if (trigger.type === 'script') {
      const execResult = await this.runner.executeScript(trigger)
      let wakeResult = null
      if (execResult.wake) {
        if (forceWake) {
          wakeResult = await this.injector.processWake(
            trigger,
            {
              data: execResult.data,
              reason: execResult.reason,
            },
            { durationMs: execResult.durationMs },
          )
        }
      } else {
        await this.registry.recordExecution({
          data: execResult.data,
          durationMs: execResult.durationMs,
          error: execResult.error,
          reason: execResult.reason || 'No wake signal',
          status: execResult.error ? 'error' : 'checked_no_wake',
          triggerId: trigger.id,
          wake: false,
        })
      }

      return {
        ...execResult,
        wakeResult,
      }
    }

    return {
      error: `Trigger type "${trigger.type}" does not support script execution`,
      wake: false,
    }
  }

  /**
   * 启动所有已启用的哨兵。保留 startScheduler 名称以兼容现有挂载入口，
   * 但不再创建定时轮询器；后续巡检完全由哨兵脚本内部循环负责。
   */
  async startScheduler() {
    this._stopping = false
    this._schedulerStarted = true
    await this._reconcile()
  }

  /** 停止所有哨兵子进程。 */
  stopScheduler() {
    this._stopping = true
    for (const timer of this._restartTimers.values()) clearTimeout(timer)
    this._restartTimers.clear()
    for (const state of this._processes.values()) {
      state.stopRequested = true
      state.status = 'stopping'
      this._rememberRuntimeState(state)
      state.handle?.stop()
    }
    this.runner.stopAll?.()
  }

  /** 兼容旧的内部调用名：只做一次生命周期对账，不执行脚本本身。 */
  async _tick() {
    await this._reconcile()
  }

  async _reconcile() {
    if (this._stopping) return
    const activeTriggers = await this.registry.list({
      enabled: true,
      type: 'script',
    })
    const activeIds = new Set(activeTriggers.map((trigger) => trigger.id))

    for (const state of this._processes.values()) {
      if (!activeIds.has(state.id)) {
        state.stopRequested = true
        state.status = 'stopping'
        this._rememberRuntimeState(state)
        state.handle?.stop()
      }
    }

    const results = await Promise.allSettled(
      activeTriggers
        .filter(
          (trigger) =>
            !this._processes.has(trigger.id) &&
            !this._restartTimers.has(trigger.id),
        )
        .map((trigger) => this.startTrigger(trigger)),
    )
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('[TriggerService] failed to start sentinel:', result.reason)
      }
    }
  }

  /** 启动一个长期哨兵进程，并在运行态中记录 PID。 */
  async startTrigger(triggerOrId, { agentId } = {}) {
    if (this._stopping) return null
    const trigger =
      typeof triggerOrId === 'string'
        ? await this.registry.get(triggerOrId, { agentId })
        : triggerOrId
    if (!trigger || !trigger.enabled || trigger.type !== 'script') return null
    const pendingRestart = this._restartTimers.get(trigger.id)
    if (pendingRestart) {
      clearTimeout(pendingRestart)
      this._restartTimers.delete(trigger.id)
    }

    const existing = this._processes.get(trigger.id)
    if (existing) {
      if (existing.status === 'stopping' && existing.handle?.done) {
        await existing.handle.done
        if (this._processes.get(trigger.id) === existing) {
          this._processes.delete(trigger.id)
        }
      } else {
        return this.getRuntimeState(trigger.id)
      }
    }

    const state = {
      id: trigger.id,
      lastError: null,
      lastExitAt: null,
      lastWakeAt: null,
      pid: null,
      restartCount: 0,
      startedAt: Date.now(),
      status: 'starting',
      stopRequested: false,
      wakePromise: null,
      restartRequested: false,
      wakeResult: null,
      handle: null,
      stableTimer: null,
    }
    this._processes.set(trigger.id, state)

    try {
      state.handle = this.runner.startScript(trigger, {
        onError: (error) => {
          state.lastError = error?.message || String(error)
          if (state.status === 'running' || state.status === 'starting') {
            state.status = 'error'
          }
          this._rememberRuntimeState(state)
        },
        onExit: (result) => {
          return this._handleProcessExit(trigger, state, result).catch(
            (error) => this._recoverAfterExitHandlingFailure(trigger, state, error),
          )
        },
        onWake: (payload, meta) => {
          state.wakePromise = this._handleScriptWake(
            trigger,
            state,
            payload,
            meta,
          )
          return state.wakePromise
        },
      })
      state.pid = state.handle.pid
      state.status = 'running'
      state.startedAt = state.handle.startedAt
      state.stableTimer = setTimeout(() => {
        if (this._processes.get(trigger.id) === state) {
          this._restartAttempts.delete(trigger.id)
        }
      }, 5000)
      state.stableTimer.unref?.()
      this._rememberRuntimeState(state)
      return this.getRuntimeState(trigger.id)
    } catch (error) {
      this._processes.delete(trigger.id)
      await this.registry.recordExecution({
        error: error.message,
        reason: 'Sentinel spawn failed',
        status: 'error',
        triggerId: trigger.id,
        wake: false,
      })
      throw error
    }
  }

  /** 停止指定 Agent 的哨兵进程，删除/禁用前由工具显式调用。 */
  async stopTrigger(id, { agentId } = {}) {
    const trigger = await this.registry.get(id, { agentId })
    if (!trigger) return false
    const pendingRestart = this._restartTimers.get(id)
    if (pendingRestart) {
      clearTimeout(pendingRestart)
      this._restartTimers.delete(id)
    }
    const state = this._processes.get(id)
    if (state) {
      state.stopRequested = true
      state.status = 'stopping'
      this._rememberRuntimeState(state)
      state.handle?.stop()
      if (state.handle?.done) await state.handle.done
      this._restartAttempts.delete(id)
      if (this._processes.get(id) === state) this._processes.delete(id)
    } else {
      this._restartAttempts.delete(id)
    }
    return true
  }

  async enableTrigger(id, { agentId } = {}) {
    const updated = await this.registry.update(
      id,
      { enabled: true },
      { agentId },
    )
    if (updated) await this.startTrigger(updated)
    return updated
  }

  async disableTrigger(id, { agentId } = {}) {
    const trigger = await this.registry.get(id, { agentId })
    if (!trigger) return null
    await this.stopTrigger(id, { agentId })
    return await this.registry.update(id, { enabled: false }, { agentId })
  }

  /**
   * 更新哨兵配置，并在会影响进程启动参数或生命周期的字段变化时重启。
   * TRIGGER_PARAMS 等环境变量只在 spawn 时注入，因此 params/session/mode/
   * scriptPath 的变更不能只更新 Registry，否则运行中的脚本仍使用旧配置。
   */
  async updateTrigger(id, patch = {}, { agentId } = {}) {
    const current = await this.registry.get(id, { agentId })
    if (!current) return null

    const mutableFields = [
      'cooldownSec',
      'maxFiresPerDay',
      'mode',
      'params',
      'promptTemplate',
      'scriptPath',
      'sessionId',
    ]
    const registryPatch = Object.fromEntries(
      mutableFields
        .filter((field) => Object.hasOwn(patch, field))
        .map((field) => [field, patch[field]]),
    )
    const restartFields = ['mode', 'params', 'scriptPath', 'sessionId']
    const shouldRestart = Boolean(patch.restart)
      || restartFields.some((field) => Object.hasOwn(registryPatch, field))
    const updated = await this.registry.update(id, registryPatch, { agentId })
    if (!updated) return null

    if (!updated.enabled) {
      await this.stopTrigger(id, { agentId })
    } else if (
      shouldRestart
      || current.enabled !== updated.enabled
      || !this._processes.has(id)
    ) {
      await this.stopTrigger(id, { agentId })
      await this.startTrigger(updated, { agentId })
    }
    return updated
  }

  async removeTrigger(id, { agentId } = {}) {
    const trigger = await this.registry.get(id, { agentId })
    if (!trigger) return false
    await this.stopTrigger(id, { agentId })
    return await this.registry.remove(id, { agentId })
  }

  getRuntimeState(id) {
    const state = this._processes.get(id)
    if (!state) return this._runtimeStates.get(id) || null
    return this._runtimeSnapshot(state)
  }

  _runtimeSnapshot(state) {
    return {
      lastError: state.lastError,
      lastExitAt: state.lastExitAt,
      lastWakeAt: state.lastWakeAt,
      pid: state.pid,
      restartCount: state.restartCount,
      startedAt: state.startedAt,
      status: state.status,
    }
  }

  _rememberRuntimeState(state) {
    this._runtimeStates.set(state.id, this._runtimeSnapshot(state))
  }

  async _recoverAfterExitHandlingFailure(trigger, state, error) {
    if (this._processes.get(trigger.id) !== state) return

    state.lastError = error?.message || String(error)
    if (state.stableTimer) clearTimeout(state.stableTimer)

    if (state.stopRequested || this._stopping) {
      state.status = this._stopping ? 'stopped' : 'error'
      this._rememberRuntimeState(state)
      this._processes.delete(trigger.id)
      console.error(
        `[TriggerService] sentinel ${trigger.id} exit handling failed:`,
        error,
      )
      return
    }

    this._processes.delete(trigger.id)
    state.status = 'restarting'
    this._rememberRuntimeState(state)
    console.error(
      `[TriggerService] sentinel ${trigger.id} exit handling failed; scheduling recovery:`,
      error,
    )
    this._scheduleRestart(trigger, state)
  }

  _scheduleRestart(trigger, state) {
    if (this._stopping || state.stopRequested) {
      state.status = this._stopping ? 'stopped' : state.status
      this._rememberRuntimeState(state)
      return
    }
    if (this._restartTimers.has(trigger.id)) return

    const restartAttempt = this._restartAttempts.get(trigger.id) || 0
    const delay = Math.min(
      MAX_RESTART_DELAY_MS,
      RESTART_DELAY_MS * 2 ** Math.min(restartAttempt, 7),
    )
    this._restartAttempts.set(trigger.id, restartAttempt + 1)
    state.restartCount = restartAttempt + 1
    state.status = 'restarting'
    this._rememberRuntimeState(state)

    const timer = setTimeout(async () => {
      this._restartTimers.delete(trigger.id)
      try {
        const latest = await this.registry.get(trigger.id, {
          agentId: trigger.agentId,
        })
        if (!latest || !latest.enabled || this._stopping) {
          state.status = !latest || this._stopping ? 'stopped' : 'disabled'
          this._rememberRuntimeState(state)
          return
        }
        await this.startTrigger(latest)
      } catch (error) {
        state.lastError = error?.message || String(error)
        state.status = 'error'
        this._rememberRuntimeState(state)
        console.error(
          `[TriggerService] restart sentinel ${trigger.id} failed; retrying:`,
          error,
        )
        this._scheduleRestart(trigger, state)
      }
    }, delay)
    timer.unref?.()
    this._restartTimers.set(trigger.id, timer)
  }

  async _handleScriptWake(trigger, state, payload, meta = {}) {
    if (state.stopRequested || this._stopping) return null
    state.status = 'waking'
    // 一个进程只处理一条 wake。即使脚本没有自行退出，也立即停掉它，
    // 防止同一轮内部循环产生重复事件。
    state.handle?.stop()
    state.lastWakeAt = Date.now()

    let wakeResult
    try {
      wakeResult = await this.injector.processWake(
        trigger,
        {
          data: payload.data,
          reason: payload.reason,
        },
        { durationMs: meta.durationMs || 0 },
      )
      state.wakeResult = wakeResult
    } catch (error) {
      state.lastError = error.message
      state.status = 'error'
      state.restartRequested = trigger.mode !== 'once'
      this._rememberRuntimeState(state)
      return null
    }

    const current = await this.registry.get(trigger.id, {
      agentId: trigger.agentId,
    })

    if (wakeResult?.status === 'target_unavailable') {
      // 目标不在运行时就停止并禁用，避免 persistent 哨兵不断刷错误审计。
      if (current) {
        await this.registry.update(
          trigger.id,
          { enabled: false },
          { agentId: trigger.agentId },
        )
      }
      state.stopRequested = true
      state.status = 'target_unavailable'
      this._rememberRuntimeState(state)
      return wakeResult
    }

    if (!current || !current.enabled || current.mode === 'once') {
      if (!current || !current.enabled) {
        state.stopRequested = true
        state.status = !current ? 'removed' : 'stopped'
        this._rememberRuntimeState(state)
        return wakeResult
      }
      if (wakeResult.injected && current.mode === 'once') {
        state.stopRequested = true
        state.status = 'stopped'
        this._rememberRuntimeState(state)
        return wakeResult
      }
    }

    state.restartRequested = true
    state.status = wakeResult.injected ? 'woken' : 'wake_skipped'
    this._rememberRuntimeState(state)
    return wakeResult
  }

  async _handleProcessExit(trigger, state, result) {
    if (this._processes.get(trigger.id) !== state) return
    state.lastExitAt = Date.now()
    if (state.wakePromise) await state.wakePromise

    if (this._processes.get(trigger.id) !== state) return
    const current = await this.registry.get(trigger.id, {
      agentId: trigger.agentId,
    })

    if (state.stopRequested || this._stopping || !current || !current.enabled) {
      if (state.stableTimer) clearTimeout(state.stableTimer)
      state.status = state.status === 'stopping' ? 'stopped' : state.status
      this._rememberRuntimeState(state)
      this._processes.delete(trigger.id)
      return
    }

    if (!result.wake) {
      const error =
        state.lastError ||
        (result.code !== 0
          ? `Sentinel exited with code ${result.code}${result.signal ? ` (${result.signal})` : ''}: ${result.stderr?.trim() || 'Process exited'}`
          : null)
      state.lastError = error
      await this.registry.recordExecution({
        durationMs: result.durationMs,
        error,
        reason: error || 'Sentinel process exited without wake',
        status: error ? 'error' : 'checked_no_wake',
        triggerId: trigger.id,
        wake: false,
      })
    }

    if (current.mode === 'once' && state.wakeResult?.injected) {
      if (state.stableTimer) clearTimeout(state.stableTimer)
      this._processes.delete(trigger.id)
      return
    }

    if (state.stableTimer) clearTimeout(state.stableTimer)
    this._processes.delete(trigger.id)
    this._scheduleRestart(trigger, state)
  }
}

let defaultTriggerService = null

export function getTriggerService(opts = {}) {
  if (!defaultTriggerService) {
    defaultTriggerService = new TriggerService(opts)
  }
  return defaultTriggerService
}
