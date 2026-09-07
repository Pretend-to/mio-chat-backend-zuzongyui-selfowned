import { spawn } from 'node:child_process'
import path from 'node:path'
import { WAKE_PREFIX, WakeProtocol } from './WakeProtocol.js'
import logger from '../../utils/logger.js'

const MAX_STDOUT_BYTES = 64 * 1024 // 64KB
const DEFAULT_TIMEOUT_MS = 10000 // 10s
const RUN_MODES = new Set(['test', 'loop'])

/**
 * TriggerRunner — 哨兵脚本执行器与进程生命周期管理
 */
export class TriggerRunner {
  constructor({ timeoutMs = DEFAULT_TIMEOUT_MS, maxStdoutBytes = MAX_STDOUT_BYTES } = {}) {
    this.timeoutMs = timeoutMs
    this.maxStdoutBytes = maxStdoutBytes
    this._children = new Set()
    this._onProcessExit = () => this.stopAll({ force: true })
    process.once('exit', this._onProcessExit)
  }

  _resolveCommand(trigger, runMode = 'test') {
    if (!RUN_MODES.has(runMode)) {
      throw new Error(`Unsupported sentinel run mode: ${runMode}`)
    }
    if (!trigger.scriptPath) {
      throw new Error(`Trigger "${trigger.id}" has no scriptPath`)
    }

    const scriptPath = path.resolve(trigger.scriptPath)
    const ext = path.extname(scriptPath).toLowerCase()
    let command = scriptPath
    let args = []

    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
      command = process.execPath
      args = [scriptPath, runMode]
    } else if (ext === '.py') {
      command = process.env.PYTHON_BIN || 'python3'
      args = [scriptPath, runMode]
    } else if (ext === '.sh' || ext === '.bash') {
      command = 'bash'
      args = [scriptPath, runMode]
    } else {
      args = [runMode]
    }

    return { args, command, cwd: path.dirname(scriptPath), scriptPath }
  }

  _buildEnv(trigger) {
    // Sentinel 脚本属于 AdminOnly 的受信任本地代码，保留宿主环境以兼容
    // OpenCV、Python 虚拟环境和其他本地工具链。
    return {
      ...process.env,
      TRIGGER_AGENT_ID: trigger.agentId || '',
      TRIGGER_ID: trigger.id || '',
      TRIGGER_PARAMS: JSON.stringify(trigger.params || {}),
      TRIGGER_SESSION_ID: trigger.sessionId || '',
    }
  }

  _killChild(child, signal) {
    if (!child?.pid) return false
    if (process.platform !== 'win32') {
      try {
        process.kill(-child.pid, signal)
        return true
      } catch {}
    }
    try {
      return child.kill(signal)
    } catch {
      return false
    }
  }

  stopAll({ force = false } = {}) {
    for (const child of this._children) {
      this._killChild(child, force ? 'SIGKILL' : 'SIGTERM')
    }
  }

  /**
   * 执行单个哨兵脚本文件，并解析 stdio 契约
   * @param {object} trigger - 触发器对象
   * @returns {Promise<{ wake: boolean, reason?: string, data?: any, stdout: string, stderr: string, durationMs: number, error?: string }>}
   */
  async executeScript(trigger) {
    const { args, command, cwd } = this._resolveCommand(trigger, 'test')

    const startTime = Date.now()

    return new Promise((resolve) => {
      let stdout = ''
      let stderr = ''
      let killedDueToTimeout = false
      let resolved = false

      const env = this._buildEnv(trigger)

      let child = null
      try {
        child = spawn(command, args, {
          cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (spawnError) {
        return resolve({
          durationMs: Date.now() - startTime,
          error: `Spawn failed: ${spawnError.message}`,
          stderr: spawnError.message,
          stdout: '',
          wake: false,
        })
      }

      const timer = setTimeout(() => {
        killedDueToTimeout = true
        try {
          child.kill('SIGKILL')
        } catch {}
      }, this.timeoutMs)

      child.stdout.on('data', (chunk) => {
        if (stdout.length < this.maxStdoutBytes) {
          stdout += chunk.toString('utf-8')
          if (stdout.length > this.maxStdoutBytes) {
            stdout = stdout.slice(0, this.maxStdoutBytes) + '\n[STDOUT TRUNCATED AT 64KB]'
          }
        }
      })

      child.stderr.on('data', (chunk) => {
        if (stderr.length < this.maxStdoutBytes) {
          stderr += chunk.toString('utf-8')
          if (stderr.length > this.maxStdoutBytes) {
            stderr = stderr.slice(0, this.maxStdoutBytes) + '\n[STDERR TRUNCATED AT 64KB]'
          }
        }
      })

      const cleanupAndResolve = (exitCode, signal) => {
        if (resolved) return
        resolved = true
        clearTimeout(timer)
        const durationMs = Date.now() - startTime

        if (killedDueToTimeout) {
          return resolve({
            durationMs,
            error: `Execution timed out after ${this.timeoutMs}ms`,
            stderr,
            stdout,
            wake: false,
          })
        }

        // 解析契约
        const wakeResult = WakeProtocol.parseWakeLine(stdout)

        let error = null
        if (exitCode !== 0 && !wakeResult.wake) {
          error = `Script exited with code ${exitCode}${signal ? ` (${signal})` : ''}: ${stderr.trim() || 'Non-zero exit'}`
        } else if (wakeResult.error) {
          error = wakeResult.error
        }

        resolve({
          data: wakeResult.data,
          durationMs,
          error,
          rawWakeLine: wakeResult.rawLine,
          reason: wakeResult.reason,
          stderr,
          stdout,
          wake: wakeResult.wake,
        })
      }

      child.on('close', (code, signal) => cleanupAndResolve(code, signal))
      child.on('error', (err) => {
        clearTimeout(timer)
        if (!resolved) {
          resolved = true
          resolve({
            durationMs: Date.now() - startTime,
            error: `Process error: ${err.message}`,
            stderr: err.message,
            stdout,
            wake: false,
          })
        }
      })
    })
  }

  /**
   * 启动一个由脚本自身负责循环/等待条件的长期哨兵进程。
   * 进程在 stdout 输出第一条有效 @WAKE@ 后仍可继续运行；上层服务会
   * 立即停止它，并在 persistent 模式下重新拉起一个干净实例，保证一次
   * 进程生命周期最多产生一次唤醒。
   */
  startScript(trigger, { onError, onExit, onWake } = {}) {
    const { args, command, cwd } = this._resolveCommand(trigger, 'loop')
    const startedAt = Date.now()
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== 'win32',
      env: this._buildEnv(trigger),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this._children.add(child)
    logger.info(
      `[TriggerRunner] 🚀 启动哨兵 "${trigger.id}" 进程 (PID: ${child.pid}, 模式: loop, 脚本: ${trigger.scriptPath})`,
    )

    let stdout = ''
    let stderr = ''
    let pending = ''
    let wakeSeen = false
    let stopping = false
    let closed = false
    let stopTimer = null
    let resolveDone
    const done = new Promise((resolve) => {
      resolveDone = resolve
    })

    const appendOutput = (current, chunk, label) => {
      const next = current + chunk.toString('utf-8')
      if (next.length <= this.maxStdoutBytes) return next
      return `${next.slice(-this.maxStdoutBytes)}\n[${label} TRUNCATED AT ${this.maxStdoutBytes} BYTES]`
    }

    const handleLine = (line) => {
      const trimmed = line.trim()
      if (!trimmed.startsWith(WAKE_PREFIX) || wakeSeen) return
      const parsed = WakeProtocol.parseWakeLine(trimmed)
      if (parsed.error) {
        logger.warn(
          `[TriggerRunner] ⚠️ 哨兵 "${trigger.id}" (PID: ${child.pid}) 协议解析失败: ${parsed.error}`,
        )
        onError?.(new Error(parsed.error), { line: trimmed, pid: child.pid })
        return
      }
      if (!parsed.wake) return
      wakeSeen = true
      logger.info(
        `[TriggerRunner] 🔔 哨兵 "${trigger.id}" (PID: ${child.pid}) 捕获到 @WAKE@ 触发信号 | reason: "${parsed.reason || '(无)'}"`,
      )
      Promise.resolve(
        onWake?.(parsed, {
          durationMs: Date.now() - startedAt,
          pid: child.pid,
          stderr,
          stdout,
        }),
      ).catch((error) => onError?.(error, { pid: child.pid }))
    }

    child.stdout.on('data', (chunk) => {
      stdout = appendOutput(stdout, chunk, 'STDOUT')
      pending += chunk.toString('utf-8')
      if (pending.length > this.maxStdoutBytes) {
        pending = pending.slice(-this.maxStdoutBytes)
      }
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() || ''
      for (const line of lines) handleLine(line)
    })

    child.stderr.on('data', (chunk) => {
      stderr = appendOutput(stderr, chunk, 'STDERR')
    })

    child.on('error', (error) => {
      onError?.(error, { pid: child.pid })
    })

    child.on('close', (code, signal) => {
      if (closed) return
      closed = true
      this._children.delete(child)
      if (stopTimer) clearTimeout(stopTimer)
      if (pending) handleLine(pending)
      const result = {
        code,
        durationMs: Date.now() - startedAt,
        pid: child.pid,
        signal,
        stderr,
        stdout,
        stopped: stopping,
        wake: wakeSeen,
      }
      Promise.resolve(onExit?.(result)).then(
        () => resolveDone(result),
        () => resolveDone(result),
      )
    })

    const stop = (signal = 'SIGTERM') => {
      if (closed || stopping) return false
      stopping = true
      if (!this._killChild(child, signal)) {
        stopping = false
        return false
      }
      if (signal !== 'SIGKILL') {
        stopTimer = setTimeout(() => {
          if (!closed) {
            this._killChild(child, 'SIGKILL')
          }
        }, 2000)
        stopTimer.unref?.()
      }
      return true
    }

    return {
      child,
      done,
      pid: child.pid,
      startedAt,
      stop,
    }
  }
}
