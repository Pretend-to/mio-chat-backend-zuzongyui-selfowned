import { makeStandardResponse } from '../utils/responseFormatter.js'
import { ChannelStore } from '../../../../channels/index.js'
import { ChannelRuntime } from '../../../../channels/ChannelRuntime.js'
import { isOneBotsChannel } from '../../../../channels/onebots/config.js'
import {
  IlinkClient,
  DEFAULT_BASE_URL,
} from '../../../../channels/wechat/IlinkClient.js'
import {
  getRegisteredSystemToolNames,
  completeToolHashes,
} from '../../../../channels/llm.js'
import { mountTriggersToRuntime } from '../../../../channels/triggers/index.js'

/**
 * Channel 管理 API（M6）
 * 依赖可注入（initChannelController），便于测试走 mock iLink 服务。
 * API：
 *   GET    /api/channels                   列表（脱敏）
 *   POST   /api/channels {name,type}       新建（未绑定）
 *   POST   /api/channels/:id/qrcode        生成登录二维码
 *   POST   /api/channels/:id/poll {qrcode} 轮询扫码 → confirmed 自动写 token 等
 *   PUT    /api/channels/:id {name,avatar,agentId} 编辑基本信息
 *   POST   /api/channels/:id/start|stop    运行时启停
 *   DELETE /api/channels/:id               删除（运行时先停下）
 */
let deps = null

export function initChannelController(o = {}) {
  const store = o.channelStore || new ChannelStore()
  const runtime = o.runtime || new ChannelRuntime({
    channelStore: store,
    onebotsGateway: o.onebotsGateway,
    onebotChannelFactory: o.onebotChannelFactory,
  })
  // Allow callers that supply an existing runtime to inject the gateway/factory
  // through this initializer as well.
  if (o.onebotsGateway && !runtime.onebotsGateway) runtime.onebotsGateway = o.onebotsGateway
  if (o.onebotChannelFactory && !runtime.onebotChannelFactory) runtime.onebotChannelFactory = o.onebotChannelFactory
  deps = {
    baseUrl: o.baseUrl || DEFAULT_BASE_URL,
    runtime,
    store,
    onebotsGateway: o.onebotsGateway || runtime.onebotsGateway || null,
  }
  mountTriggersToRuntime(runtime, { start: o.startTriggers !== false })
}
/** 获取 ChannelRuntime 单例（供外部模块如 cron.js 使用） */
export function getChannelRuntime() {
  if (!deps) initChannelController()
  return deps.runtime
}
function d() {
  if (!deps) initChannelController()
  return deps
}
function ilink() {
  return new IlinkClient({ baseUrl: d().baseUrl })
}
const ok = (res, data) => res.json(makeStandardResponse(data))
const fail = (res, e) => res.status(500).json({ code: 1, message: e.message })

export async function listChannels(req, res) {
  try {
    const channels = await d().store.list()
    for (const c of channels) {
      try {
        const memory = await d().runtime.createMemory(
          c.agentId || 'wechat-master',
        )
        const sid = await memory.getActiveSession()
        if (sid) {
          const session = await memory.getSession(sid)
          if (session?.chat?.length > 0) {
            const last = session.chat[session.chat.length - 1]
            let summary = ''
            if (Array.isArray(last.content)) {
              const textNode = last.content.find((n) => n.type === 'text')
              summary = textNode?.data?.text || ''
            } else if (last.text) {
              summary = last.text
            }
            if (summary.length > 80) summary = summary.slice(0, 80) + '...'
            c.lastMessage = summary
            // 会话消息时间由公共渠道管线生成；这里不再回读微信协议字段，
            // 避免管理面板的活动时间与渠道来源耦合。
            c.lastActive = last.time || session.created_at || c.lastActive
          }
        }
      } catch {}
    }
    ok(res, { channels })
  } catch (e) {
    fail(res, e)
  }
}
export async function createChannel(req, res) {
  try {
    const { name, type = 'wechat' } = req.body || {}
    ok(res, await d().store.create({ name, type }))
  } catch (e) {
    fail(res, e)
  }
}
export async function getChannelQrcode(req, res) {
  try {
    const id = req.params.id
    const ch = await d().store.get(id)
    if (!ch) throw new Error(`channel ${id} not found`)
    if (isOneBotsChannel(ch)) {
      const gateway = d().onebotsGateway || await d().runtime.getOnebotsGateway()
      if (typeof gateway.requestQrLogin !== 'function') {
        throw new Error('OneBots gateway does not provide requestQrLogin(channel)')
      }
      const qr = await gateway.requestQrLogin(ch)
      const qrObject = qr && typeof qr === 'object' ? qr : {}
      const img = qrObject.img || qrObject.qrCodeUrl || qrObject.qrcode_url ||
        qrObject.qrcode_img_content || (typeof qr === 'string' ? qr : '')
      return ok(res, {
        ...qrObject,
        channelId: id,
        img,
        qrcode: qrObject.qrcode || qrObject.qrCode || (typeof qr === 'string' ? qr : null),
      })
    }
    const qr = await ilink().getLoginQrCode()
    // 微信 iLink 的 qrcode_img_content 可能是 base64 字符串，也可能是 URL；
    // 部分接口版本返回的是 qrcode_url 字段，这里做兼容取值。
    const img = qr.qrcode_img_content || qr.qrcode_url || ''
    ok(res, { channelId: id, img, qrcode: qr.qrcode || null })
  } catch (e) {
    fail(res, e)
  }
}
export async function pollChannelQr(req, res) {
  try {
    const id = req.params.id
    const { qrcode } = req.body || {}
    const store = d().store
    const ch = await store.get(id)
    if (!ch) throw new Error(`channel ${id} not found`)

    if (isOneBotsChannel(ch)) {
      const gateway = d().onebotsGateway || await d().runtime.getOnebotsGateway()
      if (typeof gateway.getAccountState !== 'function') {
        throw new Error('OneBots gateway does not provide getAccountState(id)')
      }
      for (let i = 0; i < 10; i++) {
        const state = await gateway.getAccountState(id)
        const status = String(state?.status || '').toLowerCase()
        if (status === 'confirmed' || status === 'online' || state?.confirmed === true) {
          const userId = state?.userId || state?.user_id || state?.ilink_user_id ||
            state?.credentials?.userId || state?.credentials?.user_id ||
            state?.account?.userId || state?.account?.user_id || ch.userId || ''
          const botId = state?.botId || state?.bot_id || state?.ilink_bot_id ||
            state?.credentials?.botId || state?.credentials?.bot_id ||
            state?.account?.botId || state?.account?.bot_id || ch.botId || ''
          const token = state?.token || state?.botToken || state?.bot_token ||
            state?.credentials?.token || state?.credentials?.botToken || ''
          const patch = { userId, botId, status: 'bound' }
          if (token) patch.token = token
          await store.update(id, patch)
          try {
            if (d().runtime.isRunning(id)) await d().runtime.stop(id)
            await d().runtime.start(id)
          } catch (startErr) {
            console.warn(
              `[ChannelController] 扫码确认后自动启动 OneBots 渠道 "${id}" 失败:`,
              startErr.message,
            )
          }
          return ok(res, { botId, status: 'confirmed', userId })
        }
        if (status === 'expired') return ok(res, { status: 'expired' })
        if (i < 9) await new Promise((r) => setTimeout(r, 500))
      }
      return ok(res, { status: 'wait' })
    }

    if (!qrcode) throw new Error('qrcode required')
    const cli = ilink()
    for (let i = 0; i < 10; i++) {
      const s = await cli.pollQrStatus(qrcode, { timeoutMs: 2000 })
      if (s?.status === 'confirmed') {
        await store.update(id, {
          botId: s.ilink_bot_id,
          status: 'bound',
          token: s.bot_token,
          userId: s.ilink_user_id,
        })
        // 扫码确认成功后，自动拉起并启动渠道服务
        try {
          if (d().runtime.isRunning(id)) {
            await d().runtime.stop(id)
          }
          await d().runtime.start(id)
        } catch (startErr) {
          console.warn(
            `[ChannelController] 扫码确认后自动启动渠道 "${id}" 失败:`,
            startErr.message,
          )
        }
        return ok(res, {
          botId: s.ilink_bot_id,
          status: 'confirmed',
          userId: s.ilink_user_id,
        })
      }
      if (s?.status === 'expired') return ok(res, { status: 'expired' })
      await new Promise((r) => setTimeout(r, 500))
    }
    ok(res, { status: 'wait' })
  } catch (e) {
    fail(res, e)
  }
}
export async function getChannel(req, res) {
  try {
    const id = req.params.id
    const ch = await d().store.get(id)
    if (!ch)
      return res
        .status(404)
        .json({ code: 404, message: `channel ${id} not found` })
    const isRunning = d().runtime.isRunning(id)
    const runningEntry = d().runtime.running.get(id)
    const chn = runningEntry?.chn
    const connected = isRunning ? (chn?.connected ?? false) : false
    const lastActive = chn?.lastActive || ch.lastActive || null
    const lastPollSuccess = chn?.lastPollSuccess || null
    const lastError = chn?.lastError || null

    const defaultChannelTools = getRegisteredSystemToolNames()
    const memory =
      runningEntry?.memory ||
      (await d().runtime.createMemory(ch.agentId || 'wechat-master'))
    let tools = await memory.getAgentMeta('tools', null)
    if (Array.isArray(tools)) {
      const { migrated, tools: completedTools } = completeToolHashes(
        tools,
        defaultChannelTools,
      )
      if (migrated) {
        tools = completedTools
        await memory.setAgentMeta('tools', completedTools)
      }
    }
    const toolCallMode = await memory.getAgentMeta('tool_call_mode', 'AUTO')

    ok(res, {
      ...ch,
      connected,
      isRunning,
      lastActive,
      lastError,
      lastPollSuccess,
      status: isRunning ? 'running' : 'stopped',
      toolCallMode,
      tools: tools !== null ? tools : defaultChannelTools,
    })
  } catch (e) {
    fail(res, e)
  }
}
export async function updateChannel(req, res) {
  try {
    const { name, avatar, agentId, provider, model, tools, toolCallMode } =
      req.body || {}
    const patch = {}
    if (name != null) patch.name = name
    if (avatar != null) patch.avatar = avatar
    if (agentId != null) patch.agentId = agentId
    if (provider != null) patch.provider = provider
    if (model != null) patch.model = model
    const c = await d().store.update(req.params.id, patch)
    if (!c)
      return res
        .status(404)
        .json({ code: 404, message: `channel ${req.params.id} not found` })
    // 若正在运行，同步更新运行时配置
    const runningEntry = d().runtime.running.get(req.params.id)
    if (runningEntry?.chn) {
      if (provider !== undefined) runningEntry.chn.provider = provider
      if (model !== undefined) runningEntry.chn.model = model
    }
    // 持久化工具与调用模式
    if (tools !== undefined || toolCallMode !== undefined) {
      const memory =
        runningEntry?.memory ||
        (await d().runtime.createMemory(c.agentId || 'wechat-master'))
      if (Array.isArray(tools)) await memory.setAgentMeta('tools', tools)
      if (toolCallMode !== undefined)
        await memory.setAgentMeta('tool_call_mode', toolCallMode)
    }
    ok(res, c)
  } catch (e) {
    fail(res, e)
  }
}
export async function startChannel(req, res) {
  try {
    const chn = await d().runtime.start(req.params.id)
    ok(res, {
      connected: chn?.connected ?? false,
      isRunning: true,
      started: true,
      status: 'running',
    })
  } catch (e) {
    fail(res, e)
  }
}
export async function stopChannel(req, res) {
  try {
    await d().runtime.stop(req.params.id)
    ok(res, {
      connected: false,
      isRunning: false,
      stopped: true,
      status: 'stopped',
    })
  } catch (e) {
    fail(res, e)
  }
}
export async function deleteChannel(req, res) {
  try {
    const store = d().store
    const runtime = d().runtime
    const id = req.params.id
    if (runtime.isRunning(id)) await runtime.stop(id)
    const removed = await store.remove(id)
    if (!removed) throw new Error(`channel ${id} not found`)
    ok(res, { deleted: true })
  } catch (e) {
    fail(res, e)
  }
}
