import fs from 'fs'
import path from 'path'
import { MioFunction } from '../../../function.js'
import { getTriggerService } from '../../../triggers/index.js'

export default class SentinelTool extends MioFunction {
  constructor({ service = null } = {}) {
    super({
      adminOnly: true,
      channelOnly: true,
      description: [
        '管理后台条件监控哨兵 (Sentinel System)。',
        '用于在后台静默巡检行情走势、价格突破、接口状态、网页变动、系统指标等外部条件，并在条件达成时携带证据唤醒 Agent。',
        '【核心特点】：平时后台轻量运行，零 Token 消耗；仅当巡检脚本检测到预设条件达成并输出 @WAKE@ 契约行时，才将事件证据注入会话唤醒你。',
        '【脚本运行契约】：脚本必须实现一级参数 test / loop；test 只快速验证一次并退出，loop 才是后台模式；缺少参数不得默认运行。',
        '',
        '【标准两步工作流（铁律）】：',
        '1. 第一步：必须先用文件工具在 channels-data/triggers/scripts/ 下编写好独立的巡检脚本（Node.js / Python / Bash）。脚本可通过 process.env.TRIGGER_PARAMS 读取动态参数；满足条件时输出：',
        '   @WAKE@ {"wake": true, "reason": "...", "data": {...}}',
        '2. 第二步：调用本工具 sentinel(action="create", id="...", scriptPath="...", params={...}, mode="once") 部署并启动哨兵。脚本自行负责循环、等待和退出。',
        '',
        '【禁令】：严禁用于无脑定时提醒或无外部条件的周期任务！纯时间定时任务请使用 cron 工具。',
      ].join('\n'),
      name: 'sentinel',
      parameters: {
        properties: {
          action: {
            default: 'list',
            description:
              '操作类型：create (创建新哨兵), update (更新哨兵配置并按需重启), list (列出所有哨兵), remove (删除哨兵), enable (启用), disable (禁用), run (调试试跑一次脚本), logs (查看最近审计执行日志)',
            enum: [
              'create',
              'update',
              'list',
              'remove',
              'enable',
              'disable',
              'run',
              'logs',
            ],
            type: 'string',
          },
          cooldownSec: {
            default: 1800,
            description:
              '唤醒冷却时间（秒，默认 1800 秒 / 30 分钟），在冷却期内即使哨兵触发也不会重复唤醒 LLM',
            type: 'number',
          },
          id: {
            description:
              '哨兵唯一标识（英文小写与下划线，例如 btc_price_alert、api_monitor）',
            type: 'string',
          },
          maxFiresPerDay: {
            default: 5,
            description:
              '每日最大允许唤醒次数（默认 5 次，防止死循环或行情频繁波动导致的 Token 消耗）',
            type: 'number',
          },
          mode: {
            default: 'persistent',
            description:
              '生命周期模式：once (唤醒一次后停止并保留审计), persistent (每次唤醒后重启脚本继续监听)',
            enum: ['once', 'persistent'],
            type: 'string',
          },
          params: {
            description:
              '传给哨兵脚本的运行时配置参数对象（脚本可通过 process.env.TRIGGER_PARAMS 读取 JSON 字符串）',
            type: 'object',
          },
          promptTemplate: {
            description:
              '唤醒时追加到会话中的关注提示词模板（支持 {{payload.reason}} 或 {{payload.data.key}} 插值）',
            type: 'string',
          },
          restart: {
            description:
              'update 时是否强制重启哨兵进程。params、sessionId、mode、scriptPath 变化时会自动重启。',
            type: 'boolean',
          },
          scriptPath: {
            description:
              '【create 必填，update 可选】已编写落盘的哨兵脚本文件路径（如 channels-data/triggers/scripts/btc_alert.js）。必须先落盘文件再传路径！',
            type: 'string',
          },
          sessionId: {
            description: '唤醒注入的目标会话 ID（可选，默认绑定当前会话）',
            type: 'string',
          },
        },
        type: 'object',
      },
    })
    this.triggerService = service
    this.func = this.execute
  }

  async execute(e) {
    const params = e.params || {}
    let action = params.action || 'list'
    if (action === 'run_once') action = 'run'

    const service = this.triggerService || getTriggerService()
    const registry = service.registry

    const agentId =
      e.channel?.memory?.agentId || e.user?.agentId || 'wechat-master'
    const currentSessionId =
      e.sessionId ||
      e.body?.sessionId ||
      (e.channel?.memory ? await e.channel.memory.getActiveSession() : null)
    const channelId =
      e.channel?.channelId ||
      e.channel?.id ||
      e.body?.channelId ||
      e.metaData?.channelId ||
      null
    const scope = { agentId }

    const getOwnedTrigger = async (id, { includeDeleted = false } = {}) => {
      const trigger = await registry.get(id, { ...scope, includeDeleted })
      if (!trigger) throw new Error(`未找到属于当前 Agent 的哨兵: "${id}"`)
      return trigger
    }

    switch (action) {
      case 'create': {
        const rawPath = params.scriptPath || params.script_path
        if (!rawPath) {
          throw new Error(
            '创建哨兵必须提供已落盘的 scriptPath 脚本路径。请先用文件工具在 channels-data/triggers/scripts/ 编写好脚本文件后再调用本工具。',
          )
        }

        let resolvedPath = path.resolve(rawPath)
        if (!fs.existsSync(resolvedPath)) {
          const fallbackPath = path.resolve(
            process.cwd(),
            'channels-data/triggers/scripts',
            rawPath,
          )
          if (fs.existsSync(fallbackPath)) {
            resolvedPath = fallbackPath
          } else {
            throw new Error(
              `指定的哨兵脚本文件不存在: "${rawPath}"。请确认已先写入该脚本文件。`,
            )
          }
        }

        const trigger = await registry.create({
          agentId,
          channelId,
          cooldownSec: params.cooldownSec,
          id: params.id,
          maxFiresPerDay: params.maxFiresPerDay,
          mode: params.mode || 'persistent',
          params: params.params || {},
          promptTemplate: params.promptTemplate,
          scriptPath: resolvedPath,
          sessionId: params.sessionId || currentSessionId,
          type: 'script',
        })
        const runtime = await service.startTrigger(trigger)

        return {
          message: `哨兵 "${trigger.id}" 创建并启动成功 ✅ [模式: ${trigger.mode}, 脚本: ${path.basename(resolvedPath)}, PID: ${runtime?.pid || 'starting'}]`,
          success: true,
          trigger,
          runtime,
        }
      }

      case 'list': {
        const triggers = await registry.list({ agentId })
        return {
          count: triggers.length,
          success: true,
          triggers: triggers.map((t) => {
            const runtime = service.getRuntimeState(t.id)
            return {
              cooldownSec: t.cooldownSec,
              fireCount: t.fireCount,
              id: t.id,
              lastFiredAt: t.lastFiredAt,
              maxFiresPerDay: t.maxFiresPerDay,
              mode: t.mode,
              params: t.params,
              scriptPath: t.scriptPath,
              status: t.enabled ? runtime?.status || 'stopped' : 'disabled',
              runtime,
              wakeCount: t.wakeCount,
            }
          }),
        }
      }

      case 'update': {
        if (!params.id) throw new Error('update 操作必须指定 id 参数')
        await getOwnedTrigger(params.id)

        const patch = {}
        for (const field of ['cooldownSec', 'maxFiresPerDay', 'mode', 'params', 'promptTemplate', 'sessionId']) {
          if (Object.hasOwn(params, field)) patch[field] = params[field]
        }
        if (Object.hasOwn(params, 'scriptPath')) {
          const rawPath = params.scriptPath
          if (!rawPath) throw new Error('update 的 scriptPath 不能为空')
          let resolvedPath = path.resolve(rawPath)
          if (!fs.existsSync(resolvedPath)) {
            const fallbackPath = path.resolve(
              process.cwd(),
              'channels-data/triggers/scripts',
              rawPath,
            )
            if (fs.existsSync(fallbackPath)) {
              resolvedPath = fallbackPath
            } else {
              throw new Error(`指定的哨兵脚本文件不存在: "${rawPath}"`)
            }
          }
          patch.scriptPath = resolvedPath
        }

        const restart = Boolean(params.restart)
          || ['mode', 'params', 'scriptPath', 'sessionId'].some((field) => Object.hasOwn(params, field))
        const updated = await service.updateTrigger(
          params.id,
          { ...patch, restart },
          scope,
        )
        return {
          message: updated
            ? `哨兵 "${params.id}" 更新成功${restart ? '并已重启' : ''} ✅`
            : `未找到哨兵 "${params.id}"`,
          runtime: service.getRuntimeState(params.id),
          success: Boolean(updated),
          trigger: updated,
        }
      }

      case 'remove': {
        if (!params.id) throw new Error('remove 操作必须指定 id 参数')
        await getOwnedTrigger(params.id)
        const ok = await service.removeTrigger(params.id, scope)
        return {
          message: ok
            ? `哨兵 "${params.id}" 已成功删除 🗑️`
            : `未找到哨兵 "${params.id}"`,
          success: ok,
        }
      }

      case 'enable': {
        if (!params.id) throw new Error('enable 操作必须指定 id 参数')
        const updated = await service.enableTrigger(params.id, scope)
        return {
          message: updated
            ? `哨兵 "${params.id}" 已启用 ✅`
            : `未找到哨兵 "${params.id}"`,
          success: Boolean(updated),
          trigger: updated,
        }
      }

      case 'disable': {
        if (!params.id) throw new Error('disable 操作必须指定 id 参数')
        await getOwnedTrigger(params.id)
        const updated = await service.disableTrigger(params.id, scope)
        return {
          message: updated
            ? `哨兵 "${params.id}" 已禁用 🚫`
            : `未找到哨兵 "${params.id}"`,
          success: Boolean(updated),
          trigger: updated,
        }
      }

      case 'run': {
        if (!params.id) throw new Error('run 操作必须指定 id 参数')
        const result = await service.runOnce(params.id, {
          agentId,
          forceWake: false,
        })
        return {
          message: result.wake
            ? `哨兵试跑成功并捕获唤醒契约: "${result.reason || 'WAKE'}"`
            : result.error
              ? `哨兵试跑异常: ${result.error}`
              : '哨兵试跑完毕（未达到唤醒条件，保持静默）',
          result,
          success: !result.error,
        }
      }

      case 'logs': {
        let logs
        if (params.id) {
          await getOwnedTrigger(params.id, { includeDeleted: true })
          logs = await registry.listExecutions(params.id, { limit: 20 })
        } else {
          const triggers = await registry.list({ agentId })
          const groups = await Promise.all(
            triggers.map((trigger) =>
              registry.listExecutions(trigger.id, { limit: 20 }),
            ),
          )
          logs = groups
            .flat()
            .toSorted((a, b) => (b.firedAt || 0) - (a.firedAt || 0))
            .slice(0, 20)
        }
        return {
          count: logs.length,
          logs,
          success: true,
        }
      }

      default:
        throw new Error(`未知 action: "${action}"`)
    }
  }
}
