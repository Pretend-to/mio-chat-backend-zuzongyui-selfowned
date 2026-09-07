/**
 * BaseChannel — 多渠道（微信、飞书、钉钉、Telegram、QQ 等）统一抽象基类
 *
 * 核心架构与职责：
 * 1. 统一渠道生命周期管理 (start, stop, error handling)；
 * 2. 统一消息路由与通用 Slash 处理器 (SlashHandler)；
 * 3. 统一高危动作挂起确认拦截器 (ConfirmationManager)；
 * 4. 统一保活与心跳检查管理器 (KeepAliveManager)；
 * 5. 统一流式响应、多模态分发流水线 (Image/Voice/File/Video/Text) 与降级通知；
 * 6. 统一持久化与会话记忆结晶 (MemoryStore)。
 */

import { SlashHandler } from './SlashHandler.js'
import { ConfirmationManager } from './ConfirmationManager.js'
import { KeepAliveManager } from './KeepAliveManager.js'
import {
  getSessionYolo,
  setSessionYolo,
} from '../../lib/chat/sessionExecutionState.js'
import { ensureMessageTime } from '../../lib/chat/messageTimestamp.js'
import {
  appendRecursiveContextMessages,
  prepareChannelUserInput,
} from '../llm.js'
import sessions from '../../lib/server/socket.io/services/sessions.js'

export class BaseChannel {
  /**
   * @param {object} opts
   * @param {object} opts.client      底层协议客户端实现
   * @param {import('../memory/MemoryStore.js').MemoryStore} opts.memory     会话与记忆存储
   * @param {string} opts.masterId   绑定主用户 UID
   * @param {object} opts.llm        LLM 处理器
   * @param {string} [opts.channelType='base'] 渠道标识（如 'wechat', 'feishu', 'dingtalk'）
   * @param {string} [opts.provider] 大模型提供商
   * @param {string} [opts.model]    大模型名称
   * @param {boolean} [opts.typing=true] 是否启用打字中状态反馈
   * @param {object} [opts.keepAlive] 保活配置
   * @param {object} [opts.logger=console] 日志输出
   * @param {Function} [opts.onActivity] 活跃状态回调
   */
  constructor({
    client,
    memory,
    masterId,
    llm,
    channelType = 'base',
    provider = null,
    model = null,
    typing = true,
    keepAlive = {},
    logger = console,
    onActivity = null,
    id = null,
    channelId = null,
    debounceConfig = {},
    debounceEnabled = null,
  }) {
    if (!client || !memory || !masterId) {
      throw new Error(
        `[${this.constructor.name}] requires client, memory, and masterId`,
      )
    }
    this.id = id || channelId || (memory && memory.agentId) || channelType
    this.channelId = this.id
    this.client = client
    this.memory = memory
    this.masterId = masterId
    this.llm = llm
    this.channelType = channelType
    this.provider = provider
    this.model = model
    this.defaultProvider = provider
    this.defaultModel = model
    this.typing = typing
    this.log = logger
    this.onActivity = onActivity
    this.activeJobs = new Map() // sessionId -> { startTime, text, currentTool, toolCount, lastProgressText }
    this._sessionQueues = new Map() // sessionId -> Promise chain (FIFO 互斥队列兼容)
    this._sessionLocks = new Set() // sessionId -> 互斥单飞锁
    this._sessionWaitingQueues = new Map() // sessionId -> QueueItem[] 排队与合并队列
    this._inboundDebounceBuffers = new Map() // from -> 滑动防抖缓冲桶
    this._sessionTypingTrackers = new Map() // key (sid/from) -> { ctx, sid, timer }
    this.debounceConfig = {
      mediaMs: 10000, // 富媒体（图片/文件/语音）10 秒防抖
      textMs: 5000, // 纯文本 5 秒防抖
      ...debounceConfig,
    }
    const isTestEnv =
      process.env.NODE_ENV === 'test' ||
      Boolean(process.env.NODE_TEST_CONTEXT) ||
      process.execArgv.includes('--test')
    this.debounceEnabled = debounceEnabled ?? !isTestEnv
    this._sessionYolo = new Map()

    this.running = false
    this._abort = null

    // 初始化子系统
    this.confirmations = new ConfirmationManager({ channel: this })
    this.slashHandler = new SlashHandler({ channel: this, memory: this.memory })
    this.keepAlive = new KeepAliveManager({
      client: this.client,
      config: keepAlive,
      logger: this.log,
      masterId: this.masterId,
      memory: this.memory,
    })
  }

  /** 兼容性 getter：直接访问 pendingConfirmations Map */
  get pendingConfirmations() {
    return this.confirmations.pendingConfirmations
  }

  // ===============================================================
  // 抽象方法（由具体渠道子类实现协议特异性）
  // ===============================================================

  /** 从原始入站数据包中提取文本消息 */
  extractText(_msg) {
    throw new Error('extractText(msg) must be implemented by subclass')
  }

  /** 构造下行文本消息数据包 */
  buildSendMsg({ _contextToken, _text, _to } = {}) {
    throw new Error('buildSendMsg() must be implemented by subclass')
  }

  /** 发送原始下行数据包至渠道服务端 */
  async doSendMessage(_payload) {
    throw new Error('doSendMessage() must be implemented by subclass')
  }

  /** 发送原生图片（Buffer 或 URL） */
  async doSendImage({ _buffer, _contextToken, _localPath, _to, _url } = {}) {
    throw new Error('doSendImage() must be implemented by subclass')
  }

  /** 发送原生语音（Buffer 或 URL，自动转码为 Silk） */
  async doSendVoice({
    _buffer,
    _contextToken,
    _durationMs,
    _localPath,
    _text,
    _to,
    _url,
  } = {}) {
    throw new Error('doSendVoice() must be implemented by subclass')
  }

  /** 发送原生文件（Buffer 或 URL） */
  async doSendFile({
    _buffer,
    _contextToken,
    _fileName,
    _localPath,
    _to,
    _url,
  } = {}) {
    throw new Error('doSendFile() must be implemented by subclass')
  }

  /** 发送原生视频（Buffer 或 URL） */
  async doSendVideo({
    _buffer,
    _contextToken,
    _durationMs,
    _localPath,
    _to,
    _url,
  } = {}) {
    throw new Error('doSendVideo() must be implemented by subclass')
  }

  /**
   * 发送结构化链接 / 网页卡片消息
   * @param {Object} options
   * @param {string} options.to 接收人 ID
   * @param {string} [options.contextToken] 上下文票据（微信等渠道）
   * @param {string} options.url 链接目标 URL
   * @param {string} [options.text] 链接文案或按钮文本
   * @param {string} [options.title] 标题
   * @param {string} [options.description] 描述
   * @param {Object} [options.extraRender] 原始完整 extraRender 对象
   */
  async doSendLink({
    contextToken,
    description: _description,
    extraRender: _extraRender,
    text,
    title,
    to,
    url,
  } = {}) {
    // 默认降级实现：若适配器未重写原生富文本卡片发送，则默认以结构化信息格式化为文本兜底
    const label = text || title || '网页链接'
    const noticeText = url ? `${label}\n🔗 链接: ${url}` : label
    const payload = this.buildSendMsg({
      contextToken,
      fromBot: this.client?.botId,
      text: noticeText,
      to,
    })
    return this.doSendMessage(payload)
  }

  /**
   * 发送结构化卡片 / 复杂富媒体消息
   * @param {Object} options
   * @param {string} options.to 接收人 ID
   * @param {string} [options.contextToken] 上下文票据
   * @param {Object} options.card 卡片元数据
   * @param {Object} [options.extraRender] 原始完整 extraRender 对象
   */
  async doSendCard({
    card = {},
    contextToken,
    extraRender: _extraRender,
    to,
  } = {}) {
    // 默认降级实现：提取标题、描述和链接构建文本兜底发送
    const title = card.title ? `[${card.title}] ` : ''
    const desc = card.description || card.text || ''
    const url =
      card.url || card.href ? `\n🔗 链接: ${card.url || card.href}` : ''
    const noticeText = `${title}${desc}${url}`.trim() || '[富媒体卡片]'
    const payload = this.buildSendMsg({
      contextToken,
      fromBot: this.client?.botId,
      text: noticeText,
      to,
    })
    return this.doSendMessage(payload)
  }

  // ===============================================================
  // 会话输入状态与心跳保活管理 (Channel-Agnostic Typing Lifecycle)
  // ===============================================================

  _getTypingTracker(sid, from) {
    if (!this._sessionTypingTrackers) return null
    if (sid && this._sessionTypingTrackers.has(sid)) {
      return { key: sid, tracker: this._sessionTypingTrackers.get(sid) }
    }
    if (from && this._sessionTypingTrackers.has(from)) {
      return { key: from, tracker: this._sessionTypingTrackers.get(from) }
    }
    return null
  }

  /**
   * 启动会话/用户输入中状态与保活心跳 (Channel-Agnostic)
   * 即使在防抖进程中、暂时未实际运行任务，也会立即给用户反馈正在输入状态。
   * 只要当前会话在防抖缓冲、排队或执行中，持续维持 typing=1
   * @param {object} ctx - 消息上下文 (含 from, contextToken, isWeb 等)
   * @param {object} [options]
   * @param {string} [options.sessionId] - 会话 ID
   */
  startTyping(ctx = {}, { sessionId = null } = {}) {
    if (!ctx || ctx.isWeb) return
    const sid = sessionId || ctx.sid || null
    const from = ctx.from || null
    const key = sid || from || 'default'

    if (!this._sessionTypingTrackers) {
      this._sessionTypingTrackers = new Map()
    }

    const found = this._getTypingTracker(sid, from)
    if (found) {
      found.tracker.ctx = { ...found.tracker.ctx, ...ctx }
      if (sid && found.key !== sid) {
        this._sessionTypingTrackers.delete(found.key)
        this._sessionTypingTrackers.set(sid, found.tracker)
      }
      return
    }

    // 立即向客户端推送正在输入状态
    this.doSendTyping(ctx, 1).catch(() => {})

    // 启动周期性心跳定时器（默认 4 秒一次），避免微信等 IM 平台输入状态超时熄灭
    const timer = setInterval(() => {
      const current = this._getTypingTracker(sid, from)?.tracker
      if (current) {
        this.doSendTyping(current.ctx, 1).catch(() => {})
      }
    }, 4000)
    timer.unref?.()

    this._sessionTypingTrackers.set(key, {
      ctx: { ...ctx },
      sid,
      timer,
    })
  }

  /**
   * 检查指定 Session 或用户当前是否仍有待处理/正在处理的任务
   * 渠道无关的统一状态判断方法
   * @param {string} [sessionId]
   * @param {object} [ctx]
   * @returns {boolean}
   */
  isSessionBusy(sessionId, ctx = {}) {
    const sid = sessionId || ctx?.sid || null
    if (sid) {
      if (this.activeJobs?.has(sid)) return true
      if (this._sessionWaitingQueues?.get(sid)?.length > 0) return true
      if (this._sessionLocks?.has(sid)) return true
    }
    const from = ctx?.from
    if (from && this._inboundDebounceBuffers?.has(from)) {
      return true
    }
    return false
  }

  /**
   * 停止会话/用户输入中状态 (Channel-Agnostic)
   * 只有当当前 session 既无活跃任务、也无排队任务、无防抖缓冲时才真正熄灭 typing (status=2)
   * @param {object} ctx - 消息上下文
   * @param {object} [options]
   * @param {string} [options.sessionId] - 会话 ID
   * @param {boolean} [options.force] - 是否忽略忙碌检查强制关闭
   */
  async stopTyping(ctx = {}, { sessionId = null, force = false } = {}) {
    if (!ctx || ctx.isWeb) return
    const sid = sessionId || ctx.sid || null
    const from = ctx.from || null

    if (!this._sessionTypingTrackers) return
    const found = this._getTypingTracker(sid, from)
    if (!found) return

    // 如果未强制停止且当前 session 依然繁忙（有队列任务或防抖任务），则保持 typing 心跳
    if (!force && this.isSessionBusy(sid, ctx)) {
      return
    }

    clearInterval(found.tracker.timer)
    this._sessionTypingTrackers.delete(found.key)

    try {
      await this.doSendTyping(found.tracker.ctx || ctx, 2)
    } catch {}
  }

  /**
   * 清理全部会话的 Typing 状态与心跳（常用于 stop/销毁）
   */
  clearAllTyping() {
    if (!this._sessionTypingTrackers) return
    for (const tracker of this._sessionTypingTrackers.values()) {
      clearInterval(tracker.timer)
      this.doSendTyping(tracker.ctx, 2).catch(() => {})
    }
    this._sessionTypingTrackers.clear()
  }

  /** 发送打字中状态反馈 */
  async doSendTyping(_ctx, _status) {
    // 默认空操作，子类按需覆写
  }

  /** 渠道专属回复风格与格式系统提示词（子类按需覆写） */
  getChannelPrompt() {
    return ''
  }

  /**
   * 将一段完整文本块切分为渠道最终落地的独立消息段（默认不切分、整段发送）。
   * 微信覆写：按 <msg>...</msg> / <break/> 拆分为多条微信气泡。
   */
  splitTextToSegments(text, _ctx = {}) {
    const t = (text || '').trim()
    return t ? [t] : []
  }

  /** 渠道主长轮询/接收循环 */
  async _loop() {
    throw new Error('_loop() must be implemented by subclass')
  }

  // ===============================================================
  // 生命周期与保活管理
  // ===============================================================
  async start() {
    this.running = true
    this._abort = new AbortController()
    if (this.memory) {
      try {
        this.latestContextToken = await this.memory.getAgentMeta(
          'latestContextToken',
          null,
        )
      } catch {}
    }
    this.keepAlive.start()
    this._loop().catch((e) => {
      this.log?.error?.(`[${this.channelType}] 运行主循环异常:`, e)
    })
  }

  async stop() {
    this.running = false
    this.keepAlive.stop()
    this.confirmations.clear()
    this.clearAllTyping()
    if (this._abort) {
      this._abort.abort()
      this._abort = null
    }
  }

  /**
   * Session-scoped shell approval override used by /yolo. The persisted map
   * keeps the setting stable across channel restarts while the local cache
   * avoids another metadata read for every shell tool call.
   */
  async isSessionYoloEnabled(sessionId) {
    if (!sessionId) return false
    if (this._sessionYolo.has(sessionId))
      return this._sessionYolo.get(sessionId)
    const enabled = await getSessionYolo(this.memory, sessionId)
    this._sessionYolo.set(sessionId, enabled)
    return enabled
  }

  async setSessionYolo(sessionId, enabled) {
    const value = await setSessionYolo(this.memory, sessionId, enabled)
    this._sessionYolo.set(sessionId, value)
    return value
  }

  // ===============================================================
  // 消息路由、确认拦截与临时插话处理
  // ===============================================================
  async _safeSend(from, contextToken, text) {
    const targetToken = contextToken || this.latestContextToken || null
    try {
      for (const seg of this.splitTextToSegments(text, {
        contextToken: targetToken,
        from,
      })) {
        const payload = this.buildSendMsg({
          contextToken: targetToken,
          fromBot: this.client.botId,
          text: seg,
          to: from,
        })
        await this.doSendMessage(payload)
      }
    } catch {}
  }

  /** 高危动作挂起确认代理 */
  requestConfirmation(
    { description, title = '安全操作确认', ...options },
    ctx,
  ) {
    return this.confirmations.request({ description, title, ...options }, ctx)
  }

  /** 高危动作用户输入拦截检查代理 */
  _handlePendingConfirmation(text, ctx) {
    return this.confirmations.handleMessage(text, ctx)
  }

  /**
   * 渠道通用入站大防抖中心 (Unified Inbound Debounce)
   * 纯文本默认 5s 滑动防抖，富媒体（图片/文件/语音）默认 10s 滑动防抖
   */
  async enqueueInboundDebounce(from, packet = {}) {
    const sid = (await this.memory?.getActiveSession?.()) || null
    const typingCtx = {
      contextToken: packet.contextToken || this.latestContextToken || null,
      from: from || this.masterId,
      isWeb: Boolean(packet.ctx?.isWeb),
      sid,
    }
    const isSlash = typeof packet.text === 'string' && packet.text.trim().startsWith('/')
    if (!isSlash) {
      this.startTyping(typingCtx, { sessionId: sid })
    }

    if (!from || this.debounceEnabled === false || packet.immediate || isSlash) {
      const activeSid = sid || (await this.memory?.getActiveSession?.())
      const ctx = {
        contextToken: packet.contextToken || this.latestContextToken || null,
        files: packet.files || [],
        from: from || this.masterId,
        images: packet.images || [],
        rawMsg: packet.rawMsg || null,
        sid: activeSid,
        text: packet.text || '',
        ...packet.ctx,
      }
      return this._route(packet.text || '', ctx)
    }

    if (!this._inboundDebounceBuffers) {
      this._inboundDebounceBuffers = new Map()
    }
    let buf = this._inboundDebounceBuffers.get(from)
    if (!buf) {
      buf = {
        contextToken: null,
        files: [],
        hasMedia: false,
        images: [],
        pendingMediaCount: 0,
        rawMsg: null,
        textParts: [],
        timer: null,
      }
      this._inboundDebounceBuffers.set(from, buf)
    }

    if (packet.contextToken) buf.contextToken = packet.contextToken
    if (packet.rawMsg) buf.rawMsg = packet.rawMsg

    // 收集文本
    const text = (packet.text || '').trim()
    if (text && !text.startsWith('[图片]') && !text.startsWith('[文件:')) {
      buf.textParts.push(text)
    }

    // 收集图片和文件
    if (Array.isArray(packet.images) && packet.images.length > 0) {
      buf.images.push(...packet.images)
      buf.hasMedia = true
    }
    if (Array.isArray(packet.files) && packet.files.length > 0) {
      buf.files.push(...packet.files)
      buf.hasMedia = true
    }
    if (packet.hasMedia) {
      buf.hasMedia = true
    }

    // 处理挂起的异步转存 Promise
    if (packet.pendingMediaPromise) {
      buf.hasMedia = true
      buf.pendingMediaCount++
      packet.pendingMediaPromise
        .then((res) => {
          if (res?.images) buf.images.push(...res.images)
          if (res?.files) buf.files.push(...res.files)
        })
        .catch((err) => {
          this.log?.warn?.(
            `[${this.channelType}] 媒体异步下载转存异常:`,
            err.message,
          )
        })
        .finally(() => {
          buf.pendingMediaCount = Math.max(0, buf.pendingMediaCount - 1)
        })
    }

    const delayMs = buf.hasMedia
      ? this.debounceConfig?.mediaMs || 10000
      : this.debounceConfig?.textMs || 5000

    if (buf.timer) {
      clearTimeout(buf.timer)
    }

    return new Promise((resolve, reject) => {
      buf.timer = setTimeout(async () => {
        try {
          // 若仍有媒体任务在异步下载转存中，等待最多 5 秒
          let waitTimes = 0
          while (buf.pendingMediaCount > 0 && waitTimes < 50) {
            await new Promise((r) => setTimeout(r, 100))
            waitTimes++
          }

          this._inboundDebounceBuffers.delete(from)

          let mergedText = buf.textParts.join('\n').trim()
          if (buf.files.length > 0) {
            const fileLinks = buf.files
              .map((f) => `[文件: ${f.name}](${f.url})`)
              .join('\n')
            mergedText = mergedText ? `${mergedText}\n${fileLinks}` : fileLinks
          }

          const activeSid = (await this.memory?.getActiveSession?.()) || sid
          const ctx = {
            contextToken: buf.contextToken || this.latestContextToken || null,
            files: buf.files,
            from,
            images: [...new Set(buf.images)],
            rawMsg: buf.rawMsg,
            sid: activeSid,
            text: mergedText,
            ...packet.ctx,
          }

          // 保持并更新 typing 上下文
          this.startTyping(ctx, { sessionId: sid })

          const res = await this._route(mergedText, ctx)
          resolve(res)
        } catch (err) {
          this.stopTyping(typingCtx, { sessionId: sid }).catch(() => {})
          reject(err)
        }
      }, delayMs)
    })
  }

  /** 统一消息路由入口：拦截确认 -> Slash 指令 -> 主路会话排队 */
  async _route(text, ctx) {
    ctx.messageTime = ensureMessageTime(ctx.messageTime)

    if (ctx?.contextToken) {
      this.latestContextToken = ctx.contextToken
      if (this.memory) {
        this.memory
          .setAgentMeta('latestContextToken', ctx.contextToken)
          .catch(() => {})
      }
    }

    // 0. 保活：记录用户活动时间并缓存 contextToken
    await this.keepAlive.recordActivity(
      ctx?.contextToken || this.latestContextToken || null,
    )

    // 1. 优先检查高危操作确认回复
    if (this._handlePendingConfirmation(text, ctx)) {
      return
    }

    // 2. 检查 Slash 斜杠指令
    if (text.trim().startsWith('/')) {
      const trimmed = text.trim()
      // 专属于旁路即时插话的 /btw 指令
      if (
        trimmed === '/btw' ||
        trimmed.startsWith('/btw ') ||
        trimmed.startsWith('/btw\n')
      ) {
        const followupText = trimmed.slice(4).trim()
        const sid = ctx.sid || (await this.memory.getActiveSession())
        const activeJob = sid ? this.activeJobs.get(sid) : null
        if (activeJob) {
          return this._handleTransientFollowup(
            followupText || '汇报一下当前任务的最新进度',
            activeJob,
            ctx,
          )
        } else {
          return this._safeSend(
            ctx.from,
            ctx.contextToken,
            '当前没有正在执行的后台任务哦～如有问题可直接发送给我～',
          )
        }
      }

      const slashRes = await this.slashHandler.handle(text.trim(), ctx)
      if (slashRes?.text) {
        if (ctx.isWeb && ctx.webClient && ctx.messageId) {
          const metaData = {
            contactorId: ctx.channelId,
            messageId: ctx.messageId,
          }
          ctx.webClient.sendOpenaiMessage(
            'update',
            {
              content: slashRes.text,
              metaData,
              type: 'content',
            },
            ctx.messageId,
          )
          ctx.webClient.sendOpenaiMessage(
            'complete',
            {
              metaData,
            },
            ctx.messageId,
          )
        } else {
          await this._safeSend(ctx.from, ctx.contextToken, slashRes.text)
        }
      }
      return slashRes
    }

    // 3. 所有普通业务输入、定时任务与唤醒一律进入主路单飞锁队列
    let sid = ctx.sid || (await this.memory?.getActiveSession())
    if (!sid && this.memory) {
      const s = await this.memory.createSession({ title: '默认会话' })
      await this.memory.setActiveSession(s.id)
      sid = s.id
      ctx.sid = sid
    }
    return this._enqueueSession(sid, text.trim(), ctx)
  }

  /**
   * 会话单飞互斥锁与排位等待队列 (Single-Flight Lock & Queue)
   */
  async _enqueueSession(sid, textOrFn, ctx = {}) {
    let targetSid = sid
    if (!targetSid && this.memory) {
      targetSid = await this.memory.getActiveSession()
      if (!targetSid) {
        const s = await this.memory.createSession({ title: '默认会话' })
        await this.memory.setActiveSession(s.id)
        targetSid = s.id
      }
      if (ctx) ctx.sid = targetSid
    }

    if (!targetSid) {
      if (typeof textOrFn === 'function') return await textOrFn()
      return await this._processChat(textOrFn, ctx)
    }

    sid = targetSid

    if (!this._sessionWaitingQueues) {
      this._sessionWaitingQueues = new Map()
    }
    if (!this._sessionLocks) {
      this._sessionLocks = new Set()
    }

    const isFn = typeof textOrFn === 'function'
    const text = isFn ? '' : String(textOrFn || '')

    // 如果当前会话空闲，立即获取锁并执行
    if (!this._sessionLocks.has(sid)) {
      this._sessionLocks.add(sid)
      if (isFn) {
        return this._runSessionLegacyFn(sid, textOrFn)
      }
      return this._runSessionJob(sid, text, ctx)
    }

    // 会话繁忙：压入排队等待队列，并确保会话维持 typing 输入中状态
    this.startTyping(ctx, { sessionId: sid })
    let queue = this._sessionWaitingQueues.get(sid)
    if (!queue) {
      queue = []
      this._sessionWaitingQueues.set(sid, queue)
    }

    return new Promise((resolve, reject) => {
      const queueItem = {
        ctx,
        enqueuedAt: Date.now(),
        fn: isFn ? textOrFn : null,
        isFn,
        reject,
        resolve,
        text,
      }
      queue.push(queueItem)
      const rank = queue.length

      // 仅对真实活人用户的输入进行实时排位反馈（排除后台任务、哨兵与静默入队）
      if (!ctx.isTask && !ctx.isWake && ctx.from && !ctx.silentQueue && !isFn) {
        this._safeSend(
          ctx.from,
          ctx.contextToken || this.latestContextToken,
          `📥 已收到您的请求。当前有任务正在全力处理中，已将您的任务加入处理队列，当前排位 [${rank}/${rank}]，请稍候～`,
        ).catch(() => {})
      }
    })
  }

  async _runSessionLegacyFn(sid, fn) {
    try {
      return await fn()
    } finally {
      this._drainNextSessionBatch(sid).catch((err) => {
        this.log?.error?.(`[${this.channelType}] 队列后续任务调度异常:`, err)
      })
    }
  }

  async _runSessionJob(sid, text, ctx) {
    try {
      return await this._processChat(text, ctx)
    } finally {
      this._drainNextSessionBatch(sid).catch((err) => {
        this.log?.error?.(`[${this.channelType}] 队列后续任务调度异常:`, err)
      })
    }
  }

  async _drainNextSessionBatch(sid) {
    const queue = this._sessionWaitingQueues?.get(sid)
    if (!queue || queue.length === 0) {
      this._sessionLocks.delete(sid)
      await this.stopTyping({}, { sessionId: sid })
      return
    }

    // 一次性取出当前排队的所有任务进行合并处理 (Batch Merging)
    const batch = queue.splice(0, queue.length)
    if (batch.length === 1) {
      const single = batch[0]
      try {
        let res
        if (single.isFn) {
          res = await single.fn()
        } else {
          res = await this._processChat(single.text, single.ctx)
        }
        single.resolve(res)
      } catch (err) {
        single.reject(err)
      } finally {
        await this._drainNextSessionBatch(sid)
      }
      return
    }

    // 若 batch 中全为传统函数，则依次顺序执行
    if (batch.every((b) => b.isFn)) {
      for (const item of batch) {
        try {
          const res = await item.fn()
          item.resolve(res)
        } catch (e) {
          item.reject(e)
        }
      }
      await this._drainNextSessionBatch(sid)
      return
    }

    // 待处理任务数 > 1：执行任务合并
    const latestUserItem =
      batch.toReversed().find((b) => !b.ctx.isTask && !b.ctx.isWake) ||
      batch[batch.length - 1]
    if (latestUserItem?.ctx?.from) {
      await this._safeSend(
        latestUserItem.ctx.from,
        latestUserItem.ctx.contextToken || this.latestContextToken,
        `⚡ 检测到当前队列中有 ${batch.length} 个待处理任务，开始合并处理～`,
      ).catch(() => {})
    }

    // 拼装合并上下文
    const mergedLines = [
      `[系统说明：在等待处理期间，共收到了以下 ${batch.length} 条待处理内容，请一并合并理解并逐一完整解答]：`,
    ]
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i]
      const timeStr = new Date(
        item.ctx.messageTime || item.enqueuedAt,
      ).toLocaleTimeString('zh-CN', {
        timeZone: 'Asia/Shanghai',
      })
      const tag = item.ctx.isTask
        ? '定时任务'
        : item.ctx.isWake
          ? '哨兵事件'
          : '用户输入'
      mergedLines.push(`• [${timeStr} ${tag}]: ${item.text}`)
    }
    const mergedText = mergedLines.join('\n')

    const latestCtx = batch[batch.length - 1].ctx
    const mergedImages = [...new Set(batch.flatMap((b) => b.ctx.images || []))]
    const mergedFiles = batch.flatMap((b) => b.ctx.files || [])
    const mergedCtx = {
      ...latestCtx,
      batchCount: batch.length,
      files: mergedFiles,
      images: mergedImages,
      isBatch: true,
    }

    try {
      const res = await this._processChat(mergedText, mergedCtx)
      for (const item of batch) {
        item.resolve(res)
      }
      // 若合并批次中包含被合并的 Web 请求，为其向 Web 客户端补发 complete 帧，消除前端死等 pending
      for (let i = 0; i < batch.length - 1; i++) {
        const itemCtx = batch[i].ctx
        if (itemCtx?.isWeb && itemCtx?.messageId) {
          const targetClients = sessions.getAllAdminClients() || []
          for (const c of targetClients) {
            c.popEvent?.(itemCtx.messageId)
            c.sendOpenaiMessage?.(
              'complete',
              {
                metaData: {
                  contactorId: itemCtx.channelId || this.channelId || this.id,
                  messageId: itemCtx.messageId,
                },
              },
              itemCtx.messageId,
            )
          }
        }
      }
    } catch (err) {
      for (const item of batch) {
        item.reject(err)
      }
      for (let i = 0; i < batch.length - 1; i++) {
        const itemCtx = batch[i].ctx
        if (itemCtx?.isWeb && itemCtx?.messageId) {
          const targetClients = sessions.getAllAdminClients() || []
          for (const c of targetClients) {
            c.popEvent?.(itemCtx.messageId)
            c.sendOpenaiMessage?.(
              'failed',
              {
                message: err.message || String(err),
                metaData: {
                  contactorId: itemCtx.channelId || this.channelId || this.id,
                  messageId: itemCtx.messageId,
                },
              },
              itemCtx.messageId,
            )
          }
        }
      }
    } finally {
      await this._drainNextSessionBatch(sid)
    }
  }

  /**
   * 向指定 session 追加一条 user 消息并触发完整处理管线（支持 Cron、Trigger、外部调用）
   * @param {string} sessionId - 目标会话 ID
   * @param {string} text - 消息正文
   * @param {object} [options] - 附加选项 (isTask, isWake, from, triggerId 等)
   */
  async appendUserMessage(sessionId, text, options = {}) {
    const targetSid = sessionId || (await this.memory.getActiveSession())
    const targetFrom =
      options.from && options.from !== 'system_trigger' && options.from !== 'system'
        ? options.from
        : (this.masterId || options.from || 'system_trigger')
    const ctx = {
      channelId: this.id || this.channelId,
      contextToken: options.contextToken || this.latestContextToken || null,
      from: targetFrom,
      isTask: Boolean(options.isTask || options.isWake),
      isWake: Boolean(options.isWake),
      sid: targetSid,
      triggerId: options.triggerId || null,
      ...options,
    }
    if (!ctx.from || ctx.from === 'system_trigger') {
      ctx.from = targetFrom
    }
    if (!ctx.contextToken && this.latestContextToken) {
      ctx.contextToken = this.latestContextToken
    }
    ctx.messageTime = ensureMessageTime(ctx.messageTime)
    this.log?.info?.(
      `[${this.channelType}] 📥 接收外部/唤醒消息并加入会话队列 | 会话: ${targetSid} | 来源: ${options.source || options.from || 'trigger'} | 目标接收者: ${ctx.from}`,
    )
    return this._enqueueSession(targetSid, text.trim(), ctx)
  }

  /** 处理任务执行中途的用户即时插话 */
  async _handleTransientFollowup(text, activeJob, ctx) {
    ctx.messageTime = ensureMessageTime(ctx.messageTime)
    const elapsedSec = Math.floor((Date.now() - activeJob.startTime) / 1000)
    const promptStatus = [
      `【系统上下文 - 即时任务状态】`,
      `你之前正在处理用户的上一条任务：${JSON.stringify(activeJob.text)}`,
      `当前任务已持续耗时：${elapsedSec} 秒`,
      activeJob.currentTool
        ? `当前正在执行的工具：${activeJob.currentTool}`
        : '',
      activeJob.lastProgressText
        ? `上一步阶段性说明：${activeJob.lastProgressText}`
        : '',
      '',
      `用户刚刚又发送了一条即时消息：${JSON.stringify(text)}`,
      '',
      `【回复要求】：`,
      `1. 这是一次即时插话交互，请以自然、亲切、简短的口吻（1~2 句话）向用户反馈你当前正在全力处理上个任务的最新进度，或对他的临时疑问做快速解答；`,
      `2. 不要重复调用重度工具，直接输出文本；`,
      `3. 依然可以使用 <msg>...</msg> 分条。`,
    ]
      .filter(Boolean)
      .join('\n')

    try {
      this.doSendTyping(ctx, 1).catch(() => {})
      const reply = await this.llm.process({
        agentId: this.memory.agentId,
        channel: this,
        chat: [],
        contextToken: ctx.contextToken || this.latestContextToken || null,
        crystal: '',
        from: ctx.from,
        globalMem: '',
        guidance: false,
        memory: this.memory,
        model: this.model,
        messageTime: ctx.messageTime,
        onEmitTextBlock: async (msgContent) => {
          if (msgContent?.trim()) {
            await this._safeSend(
              ctx.from,
              ctx.contextToken || this.latestContextToken,
              msgContent.trim(),
            )
          }
        },
        provider: this.provider,
        sessionId: `transient_${ctx.sid}_${Date.now()}`,
        soul: (await this.memory.readSoul()) || '',
        text: promptStatus,
      })
      if (reply?.text?.trim()) {
        await this._safeSend(
          ctx.from,
          ctx.contextToken || this.latestContextToken,
          reply.text.trim(),
        )
      }
    } catch (e) {
      this.log?.warn?.(`[${this.channelType}] 临时插话回复失败: ${e.message}`)
      await this._safeSend(
        ctx.from,
        ctx.contextToken || this.latestContextToken,
        `我正在后台全力处理刚才的任务（已运行 ${elapsedSec}s），马上就好哦～`,
      )
    }
  }

  // ===============================================================
  // 核心对话处理、多模态流式流水线与持久化落盘
  // ===============================================================
  async _processChat(text, ctx) {
    // 消息时间由公共管线统一生成，与具体渠道协议解耦。后续的 Web 镜像、
    // session 持久化和 LLM 请求必须复用同一个值，保证跨轮次输入稳定。
    ctx.messageTime = ensureMessageTime(ctx.messageTime)

    if (this.onActivity) {
      this.onActivity()
    }
    const soul = await this.memory.readSoul()
    const globalMem = await this.memory.readAllGlobal()
    let sid = ctx.sid || (await this.memory.getActiveSession())
    if (!sid) {
      const s = await this.memory.createSession({ title: '默认会话' })
      await this.memory.setActiveSession(s.id)
      sid = s.id
    }
    const crystal = await this.memory.getCrystal(sid)
    const pendingMemories =
      typeof this.memory.getPendingMemories === 'function'
        ? await this.memory.getPendingMemories(sid)
        : []
    const session = await this.memory.getSession(sid)
    const chat = session?.chat || []

    ctx.channelId =
      ctx.channelId || this.channelId || this.id || this.memory?.agentId
    // Resolve the same image source that is forwarded to createBackendLlm.
    // Keeping this decision in one place prevents the live mirror, persisted
    // MessageChain, and current request from receiving different prefixes.
    const channelImages = ctx.rawMsg?.images ?? ctx.images
    const preparedUserInput = prepareChannelUserInput(
      text,
      channelImages,
      ctx.messageTime,
    )
    const persistedUserText =
      Array.isArray(preparedUserInput.imageList) &&
      preparedUserInput.imageList.length > 0
        ? `${preparedUserInput.sourceText}\n${preparedUserInput.imageList
            .filter(
              (image) =>
                !preparedUserInput.sourceText.includes(`![图片](${image})`),
            )
            .map((image) => `![图片](${image})`)
            .join('\n')}`.trim()
        : preparedUserInput.sourceText

    // 当消息来自第三方渠道（!ctx.isWeb）时，若 Web 客户端在线，向其广播用户消息并建立 Blank 占位
    if (!ctx.isWeb) {
      const userMsgId =
        ctx.userMessageId ||
        `msg_u_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      const assistantMsgId =
        ctx.messageId ||
        `msg_a_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      ctx.messageId = assistantMsgId

      const onlineWebClients = sessions.getAllAdminClients()
      if (onlineWebClients && onlineWebClients.length > 0) {
        const userMsgContent = [...preparedUserInput.persistedContent]
        if (Array.isArray(ctx.files)) {
          for (const f of ctx.files) {
            userMsgContent.push({
              data: { file: f.url, name: f.name },
              type: 'file',
            })
          }
        }
        for (const client of onlineWebClients) {
          client.send({
            data: {
              assistantMessageId: assistantMsgId,
              contactorId: ctx.channelId,
              userMessage: {
                content: userMsgContent,
                id: userMsgId,
                role: 'user',
                text: persistedUserText,
                time: ctx.messageTime,
              },
            },
            protocol: 'channel',
            type: 'channel_user_message',
          })
        }
      }
    }

    const emittedBlocks = []
    let didEmitTextBlock = false
    const supportsPersistenceLifecycle =
      typeof this.memory.beginAssistantMessage === 'function' &&
      typeof this.memory.finalizeAssistantMessage === 'function'
    let assistantPersistenceId = null
    let persistenceQueue = Promise.resolve()
    let userPersistedBeforeLlm = false

    if (supportsPersistenceLifecycle) {
      const persistUser =
        typeof this.memory.appendUserMessage === 'function'
          ? this.memory.appendUserMessage.bind(this.memory)
          : this.memory.appendToChat.bind(this.memory)
      await persistUser(sid, {
        content: preparedUserInput.persistedContent,
        from_user_id: ctx.from,
        role: 'user',
        text: persistedUserText,
        time: ctx.messageTime,
      })
      userPersistedBeforeLlm = true
      assistantPersistenceId = await this.memory.beginAssistantMessage(sid, {
        content: [],
        id: ctx.messageId,
        role: 'assistant',
        text: '',
        time: Date.now(),
      })
    }
    const activeJobObj = {
      _abortLlm: null,
      abort: () => {
        if (typeof activeJobObj._abortLlm === 'function') {
          activeJobObj._abortLlm()
        }
      },
      currentTool: null,
      lastProgressText: '',
      startTime: Date.now(),
      text,
      toolCount: 0,
    }
    this.activeJobs.set(sid, activeJobObj)
    this.startTyping(ctx, { sessionId: sid })

    try {
      let sendQueue = Promise.resolve()
      let lastSendTimeMs = 0

      // 流式分发回调：检测到完整文本块或多模态 extraRender 时进入串行发送流水线
      const onEmitTextBlock = (textBlock, meta = {}) => {
        didEmitTextBlock = true
        if (
          assistantPersistenceId &&
          typeof this.memory.appendAssistantChunk === 'function'
        ) {
          const rawRender = meta.extraRender
          const render = Array.isArray(rawRender)
            ? rawRender[0] || {}
            : rawRender || {}
          persistenceQueue = persistenceQueue
            .then(() =>
              this.memory.appendAssistantChunk(
                assistantPersistenceId,
                'semantic_block',
                {
                  render: {
                    description: render.description || null,
                    fileName: render.fileName || render.name || null,
                    localPath: render.localPath || null,
                    text: render.text || null,
                    title: render.title || null,
                    type: render.type || null,
                    url:
                      render.imageUrl ||
                      render.audioUrl ||
                      render.fileUrl ||
                      render.videoUrl ||
                      render.url ||
                      render.href ||
                      null,
                  },
                  text: textBlock || '',
                },
              ),
            )
            .catch((error) => {
              this.log?.error?.(
                `[${this.channelType}] 流式语义块持久化失败: ${error.message}`,
              )
            })
        }
        if (ctx.isWeb) {
          // Web 客户端已通过 Socket 实时流推送，无需向第三方 IM 网关重复发送
          return Promise.resolve()
        }
        sendQueue = sendQueue
          .then(async () => {
            const rawRender = meta.extraRender
            const renderItems = Array.isArray(rawRender)
              ? rawRender
              : rawRender
                ? [rawRender]
                : []
            const primaryRender = renderItems[0] || {}

            // 1. 原生图片下发 (Image)
            if (
              meta.image ||
              primaryRender?.type === 'image' ||
              primaryRender?.imageUrl
            ) {
              const imgUrl =
                meta.image || primaryRender?.imageUrl || primaryRender?.url
              const imgBuffer = meta.imageBuffer || primaryRender?.buffer
              const localPath = primaryRender?.localPath
              this.log?.info?.(
                `[${this.channelType}] 🖼️ 正在发送原生图片: ${imgUrl || localPath || 'buffer'}`,
              )
              try {
                await this.doSendImage({
                  buffer: imgBuffer,
                  contextToken: ctx.contextToken,
                  localPath,
                  to: ctx.from,
                  url: imgUrl,
                })
              } catch (e) {
                this.log?.warn?.(
                  `[${this.channelType}] ⚠️ 原生图片发送失败 (${e.message})，降级为图文通知`,
                )
                if (imgUrl) {
                  const noticeText = `🖼️ [图片已生成]\n查看原图: ${imgUrl}`
                  emittedBlocks.push(noticeText)
                  const payload = this.buildSendMsg({
                    contextToken: ctx.contextToken,
                    fromBot: this.client.botId,
                    text: noticeText,
                    to: ctx.from,
                  })
                  await this.doSendMessage(payload).catch(() => {})
                }
              }
              await new Promise((r) => setTimeout(r, 100))
            }

            // 2. 原生语音下发 (Audio / Voice - Silk 转码)
            else if (
              meta.audio ||
              primaryRender?.type === 'audio' ||
              primaryRender?.type === 'voice' ||
              primaryRender?.audioUrl
            ) {
              const audioUrl =
                meta.audio || primaryRender?.audioUrl || primaryRender?.url
              const audioBuffer = meta.audioBuffer || primaryRender?.buffer
              const localPath = primaryRender?.localPath
              const durationMs =
                primaryRender?.durationMs || primaryRender?.duration
              const audioText =
                primaryRender?.text || primaryRender?.title || ''
              this.log?.info?.(
                `[${this.channelType}] 🎙️ 正在发送原生语音: ${audioUrl || localPath || 'buffer'}`,
              )
              try {
                await this.doSendVoice({
                  buffer: audioBuffer,
                  contextToken: ctx.contextToken,
                  durationMs,
                  extraRender: primaryRender,
                  fileName: primaryRender?.fileName || primaryRender?.name,
                  localPath,
                  text: audioText,
                  to: ctx.from,
                  url: audioUrl,
                })
              } catch (e) {
                this.log?.warn?.(
                  `[${this.channelType}] ⚠️ 原生语音发送失败 (${e.message})，降级为链接通知`,
                )
                if (audioUrl) {
                  const noticeText = `🎙️ [语音消息]\n音频链接: ${audioUrl}`
                  emittedBlocks.push(noticeText)
                  const payload = this.buildSendMsg({
                    contextToken: ctx.contextToken,
                    fromBot: this.client.botId,
                    text: noticeText,
                    to: ctx.from,
                  })
                  await this.doSendMessage(payload).catch(() => {})
                }
              }
              await new Promise((r) => setTimeout(r, 100))
            }

            // 3. 原生文件下发 (File / Document)
            else if (
              meta.file ||
              primaryRender?.type === 'file' ||
              primaryRender?.type === 'document' ||
              primaryRender?.fileUrl
            ) {
              const fileUrl =
                meta.file || primaryRender?.fileUrl || primaryRender?.url
              const fileBuffer = meta.fileBuffer || primaryRender?.buffer
              const localPath = primaryRender?.localPath
              const fileName =
                primaryRender?.fileName ||
                primaryRender?.name ||
                (fileUrl ? fileUrl.split('/').pop() : 'file')
              this.log?.info?.(
                `[${this.channelType}] 📁 正在发送原生文件: ${fileName}`,
              )
              try {
                await this.doSendFile({
                  buffer: fileBuffer,
                  contextToken: ctx.contextToken,
                  fileName,
                  localPath,
                  to: ctx.from,
                  url: fileUrl,
                })
              } catch (e) {
                this.log?.warn?.(
                  `[${this.channelType}] ⚠️ 原生文件发送失败 (${e.message})，降级为下载链接`,
                )
                if (fileUrl) {
                  const noticeText = `📁 [文件分享: ${fileName}]\n下载链接: ${fileUrl}`
                  emittedBlocks.push(noticeText)
                  const payload = this.buildSendMsg({
                    contextToken: ctx.contextToken,
                    fromBot: this.client.botId,
                    text: noticeText,
                    to: ctx.from,
                  })
                  await this.doSendMessage(payload).catch(() => {})
                }
              }
              await new Promise((r) => setTimeout(r, 100))
            }

            // 4. 原生视频下发 (Video)
            else if (
              meta.video ||
              primaryRender?.type === 'video' ||
              primaryRender?.videoUrl
            ) {
              const videoUrl =
                meta.video || primaryRender?.videoUrl || primaryRender?.url
              const videoBuffer = meta.videoBuffer || primaryRender?.buffer
              const localPath = primaryRender?.localPath
              const durationMs =
                primaryRender?.durationMs || primaryRender?.duration
              this.log?.info?.(
                `[${this.channelType}] 🎬 正在发送原生视频: ${videoUrl || localPath || 'buffer'}`,
              )
              try {
                await this.doSendVideo({
                  buffer: videoBuffer,
                  contextToken: ctx.contextToken,
                  durationMs,
                  localPath,
                  to: ctx.from,
                  url: videoUrl,
                })
              } catch (e) {
                this.log?.warn?.(
                  `[${this.channelType}] ⚠️ 原生视频发送失败 (${e.message})，降级为视频链接通知`,
                )
                if (videoUrl) {
                  const noticeText = `🎬 [视频消息]\n视频链接: ${videoUrl}`
                  emittedBlocks.push(noticeText)
                  const payload = this.buildSendMsg({
                    contextToken: ctx.contextToken,
                    fromBot: this.client.botId,
                    text: noticeText,
                    to: ctx.from,
                  })
                  await this.doSendMessage(payload).catch(() => {})
                }
              }
              await new Promise((r) => setTimeout(r, 100))
            }

            // 5. 结构化链接/网页卡片下发 (Link / Web Preview)
            const linkCandidates = []
            const seenLinkUrls = new Set()
            for (const item of renderItems) {
              if (
                item &&
                (item.type === 'link' ||
                  (!item.type && (item.url || item.href)))
              ) {
                const u = item.url || item.href
                if (u && !seenLinkUrls.has(u)) {
                  seenLinkUrls.add(u)
                  linkCandidates.push(item)
                }
              }
            }
            if (meta.link && !seenLinkUrls.has(meta.link)) {
              seenLinkUrls.add(meta.link)
              linkCandidates.push({ url: meta.link })
            }
            if (linkCandidates.length > 0) {
              for (const item of linkCandidates) {
                const linkUrl = item.url || item.href
                if (linkUrl) {
                  this.log?.info?.(
                    `[${this.channelType}] 🔗 正在下发结构化链接: ${linkUrl}`,
                  )
                  try {
                    const sendRes = await this.doSendLink({
                      contextToken: ctx.contextToken,
                      description: item.description || null,
                      extraRender: item,
                      text: item.text || null,
                      title: item.title || null,
                      to: ctx.from,
                      url: linkUrl,
                    })
                    const label =
                      item.text || item.title || '打开已发布的网页 🌐'
                    emittedBlocks.push(`${label}\n🔗 链接: ${linkUrl}`)
                    this.log?.info?.(
                      `[${this.channelType}] 📤 链接消息发送结果: ${JSON.stringify(sendRes)}`,
                    )
                  } catch (e) {
                    this.log?.warn?.(
                      `[${this.channelType}] ⚠️ 结构化链接发送异常 (${e.message})`,
                    )
                  }
                  await new Promise((r) => setTimeout(r, 100))
                }
              }
            }

            // 6. 结构化卡片/UI富媒体下发 (Card / UI)
            const cardCandidates = renderItems.filter(
              (r) => r && (r.type === 'card' || r.type === 'html'),
            )
            if (cardCandidates.length > 0) {
              for (const item of cardCandidates) {
                this.log?.info?.(
                  `[${this.channelType}] 🃏 正在下发结构化卡片: ${item.title || item.type}`,
                )
                try {
                  const sendRes = await this.doSendCard({
                    card: item,
                    contextToken: ctx.contextToken,
                    extraRender: item,
                    to: ctx.from,
                  })
                  emittedBlocks.push(item.text || item.title || '[富媒体卡片]')
                  this.log?.info?.(
                    `[${this.channelType}] 📤 卡片消息发送结果: ${JSON.stringify(sendRes)}`,
                  )
                } catch (e) {
                  this.log?.warn?.(
                    `[${this.channelType}] ⚠️ 结构化卡片发送异常 (${e.message})`,
                  )
                }
                await new Promise((r) => setTimeout(r, 100))
              }
            }

            // 7. 普通文本分条下发
            if (textBlock?.trim()) {
              const segments = this.splitTextToSegments(textBlock.trim(), ctx)
              for (const seg of segments) {
                emittedBlocks.push(seg)
                this.log?.info?.(
                  `[${this.channelType}] 🤖 实时推送文本块: "${seg.slice(0, 50)}${seg.length > 50 ? '...' : ''}"`,
                )
                const now = Date.now()
                lastSendTimeMs = Math.max(now, lastSendTimeMs + 10)
                const payload = this.buildSendMsg({
                  contextToken: ctx.contextToken,
                  fromBot: this.client.botId,
                  text: seg,
                  to: ctx.from,
                })
                payload.create_time_ms = lastSendTimeMs
                const sendRes = await this.doSendMessage(payload)
                this.log?.info?.(
                  `[${this.channelType}] 📤 实时文本块发送结果: ${JSON.stringify(sendRes)}`,
                )
                await new Promise((r) => setTimeout(r, 80))
              }
            }

            if (meta.soulDraft) {
              await this.memory.writeSoul(meta.soulDraft)
            }
          })
          .catch((err) => {
            this.log?.error?.(`[${this.channelType}] 队列发送异常:`, err)
          })
        return sendQueue
      }

      // 调用底层 LLM
      const reply = await this.llm.process({
        agentId: this.memory.agentId,
        channel: this,
        channelId: ctx.channelId,
        chat,
        contextToken: ctx.contextToken,
        crystal: crystal || '',
        from: ctx.from,
        globalMem: globalMem || '',
        guidance: !soul,
        images: channelImages,
        isWeb: ctx.isWeb,
        memory: this.memory,
        messageTime: ctx.messageTime,
        messageId: ctx.messageId,
        model: this.model,
        onEmitTextBlock,
        onRegisterAbort: (abortFn) => {
          activeJobObj._abortLlm = abortFn
        },
        pendingMemories,
        provider: this.provider,
        sessionId: sid,
        soul: soul || '',
        text,
        webClient: ctx.webClient,
      })

      // 兼容传统同步返回
      if (!didEmitTextBlock && reply?.text?.trim()) {
        const replyText = reply.text.trim()
        if (reply?.soulDraft) {
          await this.memory.writeSoul(reply.soulDraft)
        }
        await onEmitTextBlock(replyText, { extraRender: reply.extraRender })
      }

      await sendQueue

      // 会话持久化落盘（包含完整 Tool Calls、参数、运行结果、思考链以及文本节点）
      if (
        emittedBlocks.length > 0 ||
        (reply?.content && reply.content.length > 0) ||
        (reply?.recursiveUserMessages &&
          reply.recursiveUserMessages.length > 0) ||
        reply?.aborted
      ) {
        const fullAssistantReply = emittedBlocks.join('\n\n')

        const now = Date.now()
        const userMsg = {
          content: preparedUserInput.persistedContent,
          from_user_id: ctx.from,
          role: 'user',
          text: persistedUserText,
          time: ctx.messageTime || now,
        }
        if (!userPersistedBeforeLlm)
          await this.memory.appendToChat(sid, userMsg)

        const assembledAssistantContent = Array.isArray(reply?.content)
          ? appendRecursiveContextMessages(
              reply.content,
              reply.recursiveUserMessages,
            )
          : []
        const assistantContent = Array.isArray(reply?.content)
          ? [...assembledAssistantContent]
          : [
              {
                data: {
                  text:
                    fullAssistantReply ||
                    (reply?.aborted
                      ? '⏹️ [用户已中止任务 / User aborted]'
                      : ''),
                },
                type: 'text',
              },
            ]

        const hasTextNode = assistantContent.some(
          (c) => c.type === 'text' && c.data?.text?.trim(),
        )
        if (!hasTextNode) {
          if (fullAssistantReply?.trim()) {
            assistantContent.push({
              data: { text: fullAssistantReply.trim() },
              type: 'text',
            })
          } else if (reply?.aborted) {
            assistantContent.push({
              data: { text: '⏹️ [用户已中止任务 / User aborted]' },
              type: 'text',
            })
          }
        }

        const assistantMsg = {
          content: assistantContent,
          role: 'assistant',
          text:
            fullAssistantReply ||
            (reply?.aborted ? '⏹️ [用户已中止任务 / User aborted]' : ''),
          time: Date.now(),
        }

        let updatedSession
        if (assistantPersistenceId) {
          await persistenceQueue
          await this.memory.finalizeAssistantMessage(
            assistantPersistenceId,
            assistantMsg,
            reply?.aborted ? 'aborted' : 'final',
          )
          updatedSession = await this.memory.getSession(sid)
          assistantPersistenceId = null
        } else {
          updatedSession = await this.memory.appendToChat(sid, assistantMsg)
        }
        const currentCount = updatedSession?.chat?.length || 0
        const toolCallCount = assistantContent.filter(
          (c) => c.type === 'tool_call',
        ).length
        this.log?.info?.(
          `[${this.channelType}] 💾 会话历史已成功落盘 | 会话: ${sid} | 本轮交互已追加 (含 ${toolCallCount} 个 ToolCalls${reply?.aborted ? ', 用户中止' : ''}) | 累计条数: ${currentCount} 条`,
        )
        if (reply?.crystal && !reply?.crystalPersisted) {
          await this.memory.setCrystal(sid, reply.crystal)
          this.log?.info?.(
            `[${this.channelType}] 💎 会话结晶已更新 | 会话: ${sid} | 结晶长度: ${reply.crystal.length} 字符`,
          )
        }
      }

      if (assistantPersistenceId) {
        await persistenceQueue
        await this.memory.finalizeAssistantMessage(assistantPersistenceId, {
          content: [],
          role: 'assistant',
          text: '',
          time: Date.now(),
        })
        assistantPersistenceId = null
      }
      return null
    } catch (error) {
      if (assistantPersistenceId) {
        await persistenceQueue
        const partialText = emittedBlocks.join('\n\n')
        await this.memory
          .finalizeAssistantMessage(
            assistantPersistenceId,
            {
              content: partialText
                ? [{ data: { text: partialText }, type: 'text' }]
                : [],
              role: 'assistant',
              text: partialText,
              time: Date.now(),
            },
            'failed',
          )
          .catch((finalizeError) => {
            this.log?.error?.(
              `[${this.channelType}] 失败消息收口异常: ${finalizeError.message}`,
            )
          })
        assistantPersistenceId = null
      }
      throw error
    } finally {
      this.activeJobs.delete(sid)
      await this.stopTyping(ctx, { sessionId: sid })
    }
  }

  // ===============================================================
  // 兼容别名与单测调用接口
  // ===============================================================
  async _handleMessage(msg) {
    return this.handleIncomingMessage(msg)
  }

  async _slash(cmd, ctx = {}) {
    return this.slashHandler.handle(cmd, ctx)
  }

  async _checkKeepAlive() {
    return this.keepAlive.check()
  }

  async _recordActivity(token = null) {
    return this.keepAlive.recordActivity(token)
  }
}

export default BaseChannel
