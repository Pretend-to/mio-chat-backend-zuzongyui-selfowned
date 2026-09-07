/**
 * WechatChannel — 微信 iLink 渠道专属适配器
 *
 * 继承自 BaseChannel 统一基类，专注于处理微信 iLink 协议特异性：
 *   - 微信长轮询 getUpdates 循环与心跳重试
 *   - 微信专有 WeixinMessage 消息解析 (extractText) 与消息构建 (buildSendMsg)
 *   - 微信官方多模态 CDN 加密直传 (doSendImage, doSendVoice Silk 转码, doSendFile, doSendVideo)
 *   - 微信 24h ContextToken 额度防护与智能紧凑合并 (splitTextToSegments)
 *   - 微信 Typing 状态票据交互 (doSendTyping)
 */

import { sleep } from '../memory/sleep.js'
import { BaseChannel } from '../common/BaseChannel.js'
import { MediaResolver } from '../common/MediaResolver.js'
import {
  extractText,
  buildSendMsg,
  buildSendImageMsg,
  buildSendFileMsg,
  buildSendVideoMsg,
  splitWechatText,
  extractImages,
  extractFiles,
} from './msgHelper.js'
import { bufferToImageUrl } from '../../utils/imgTools.js'
import storageService from '../../lib/storage/StorageService.js'

const LONG_POLL_MS = 30_000
const RETRY_DELAY_MS = 3_000

export class WechatChannel extends BaseChannel {
  /**
   * @param {object} opts
   * @param {import('./IlinkClient.js').IlinkClient} opts.client      iLink 协议客户端
   * @param {import('../memory/MemoryStore.js').MemoryStore} opts.memory     记忆/会话落盘
   * @param {string} opts.masterId   绑定者微信 UID（唯一对话用户，跳过其他）
   * @param {object} opts.llm        { async process(ctx) -> { completed } } 处理普通消息
   * @param {boolean} [opts.typing]  是否启用"正在输入"反馈（默认 true）
   */
  constructor(opts) {
    super({
      ...opts,
      channelType: 'wechat',
    })
    this._buf = ''
    this._typingTickets = new Map() // userId -> typing_ticket（可缓存）
    this._tokenQuotaMap = new Map() // contextToken -> count (微信 24h 内限额回复 10 条消息)
  }

  // ===============================================================
  // Token 配额监控与智能分条合并
  // ===============================================================
  _recordTokenUsage(contextToken) {
    if (!contextToken) return
    const current = this._tokenQuotaMap.get(contextToken) || 0
    this._tokenQuotaMap.set(contextToken, current + 1)
  }

  _getTokenUsageCount(contextToken) {
    if (!contextToken) return 0
    return this._tokenQuotaMap.get(contextToken) || 0
  }

  /**
   * 微信协议文本切分：
   * 1. 正常情况下解析 <msg>...</msg> / <break/> 切为多条气泡；
   * 2. 当检测到该 contextToken 额度即将耗尽（已用 >= 7 条）时，智能紧凑化合并为 1 条微信气泡下发。
   */
  splitTextToSegments(text, ctx = {}) {
    const rawSegments = splitWechatText(text)
    if (rawSegments.length <= 1) return rawSegments

    const token = ctx.contextToken || this.latestContextToken
    const usedCount = this._getTokenUsageCount(token)
    const MAX_SAFE_QUOTA = 7 // 微信单 Token 上限 10 条，阈值设为 7

    if (usedCount >= MAX_SAFE_QUOTA) {
      this.log?.warn?.(
        `[WechatChannel] 🛡️ 配额智能防护触发：contextToken 额度已用 ${usedCount}/10，将 ${rawSegments.length} 段分条合并为 1 条微信气泡下发！`,
      )
      return [rawSegments.join('\n\n')]
    }

    return rawSegments
  }

  // ===============================================================
  // 微信长轮询主循环与入站消息处理
  // ===============================================================
  async _loop() {
    this.log?.info?.(
      `[WechatChannel] 微信长轮询已启动，监听来自 masterId=${this.masterId} 的消息`,
    )
    while (this.running) {
      try {
        // 注意：IlinkClient.getUpdates 签名为 (buff, { timeoutMs, signal })，
        // 第一参数是字符串游标，不可传对象，否则 get_updates_buf 非法导致服务端 ret=-12
        const res = await this.client.getUpdates(this._buf, {
          signal: this._abort?.signal,
          timeoutMs: LONG_POLL_MS,
        })
        if (!this.running) break

        // iLink 空轮询超时响应可能不带 ret 字段（如空 body → {}），缺省视为成功；
        // 旧版 _loop 从不检查 ret，仅此处的 -14/-12 等显式错误码需要处理
        const ret = res?.ret ?? 0
        if (ret === 0) {
          this.connected = true
          this.lastPollSuccess = Date.now()
          this.lastError = null
          if (res.get_updates_buf != null) {
            this._buf = res.get_updates_buf
          }
          const msgs = res.msgs || []
          for (const msg of msgs) {
            this.lastActive = Date.now()
            this.onActivity?.()
            this.handleIncomingMessage(msg).catch((err) => {
              this.log?.error?.('[WechatChannel] 处理入站消息异常:', err)
            })
          }
        } else if (ret === -14) {
          this.connected = false
          this.lastError = '微信会话已过期 (ret=-14)，需要重新扫码'
          this.log?.error?.(
            '[WechatChannel] 微信会话已过期 (ret=-14)，需要重新扫码',
          )
          this.stop()
          break
        } else {
          this.connected = false
          this.lastError = `微信接口返回异常 (ret=${ret})`
          this.log?.warn?.(`[WechatChannel] getUpdates 返回异常: ret=${ret}`)
          await sleep(RETRY_DELAY_MS)
        }
      } catch (err) {
        if (!this.running) break
        if (
          err?.name === 'TimeoutError' ||
          err?.message?.includes('timeout') ||
          err?.code === 20 ||
          err?.name === 'AbortError'
        ) {
          if (err?.name !== 'AbortError') {
            this.connected = true
            this.lastPollSuccess = Date.now()
          }
          continue
        }
        this.connected = false
        this.lastError = err?.message || '轮询网络异常'
        this.log?.error?.('[WechatChannel] 轮询异常:', err?.message)
        await sleep(RETRY_DELAY_MS)
      }
    }
    this.connected = false
  }

  async handleIncomingMessage(msg) {
    if (!msg) return
    const from = msg.from_user_id || msg.userId || msg.from
    if (from !== this.masterId) {
      return
    }

    const text = extractText(msg)
    const contextToken = msg.context_token || null
    if (contextToken) {
      this.latestContextToken = contextToken
      if (this.memory) {
        await this.memory
          .setAgentMeta('latestContextToken', contextToken)
          .catch(() => {})
      }
    }
    await this.keepAlive.recordActivity(
      contextToken || this.latestContextToken || null,
    )

    const rawImages = extractImages(msg)
    const rawFiles = extractFiles(msg)

    const hasMedia = rawImages.length > 0 || rawFiles.length > 0
    let pendingMediaPromise = null

    if (hasMedia) {
      pendingMediaPromise = (async () => {
        const images = []
        const files = []

        for (const img of rawImages) {
          try {
            const downloadFn =
              this.client.downloadAndDecryptMedia || this.client.downloadMedia
            const buffer =
              typeof downloadFn === 'function'
                ? await downloadFn.call(this.client, img.full_url, img.aes_key)
                : null
            let localUrl = null
            if (typeof this.bufferToImageUrl === 'function') {
              localUrl = await this.bufferToImageUrl(buffer)
            } else if (buffer) {
              localUrl = await bufferToImageUrl(this.baseUrl || '', buffer)
            }
            if (localUrl) {
              images.push(localUrl)
            }
          } catch (e) {
            this.log?.warn?.(`[WechatChannel] 图片下载解密失败: ${e.message}`)
          }
        }

        for (const f of rawFiles) {
          try {
            const downloadFn =
              this.client.downloadAndDecryptMedia || this.client.downloadMedia
            const buffer =
              typeof downloadFn === 'function'
                ? await downloadFn.call(this.client, f.full_url, f.aes_key)
                : null
            let fileUrl = null
            if (typeof this.uploadFile === 'function') {
              fileUrl = await this.uploadFile(buffer, f.file_name)
            } else if (buffer) {
              const stored = await storageService.upload(
                buffer,
                f.file_name,
                'file',
                { contentType: 'application/octet-stream' },
              )
              fileUrl = stored?.url
            }
            if (fileUrl) {
              files.push({ name: f.file_name, url: fileUrl })
            }
          } catch (e) {
            this.log?.warn?.(`[WechatChannel] 文件下载解密失败: ${e.message}`)
          }
        }

        return { files, images }
      })().catch((e) => {
        this.log?.error?.(`[WechatChannel] 媒体处理异常: ${e.message}`)
        return { files: [], images: [] }
      })
    }

    const isSlash = typeof text === 'string' && text.trim().startsWith('/')
    return this.enqueueInboundDebounce(from, {
      contextToken,
      hasMedia,
      immediate: isSlash,
      pendingMediaPromise,
      rawMsg: msg,
      text,
    })
  }

  // ===============================================================
  // 微信专用消息构建与发送
  // ===============================================================
  extractText(msg) {
    return extractText(msg)
  }

  buildSendMsg({ to, text, contextToken, fromBot }) {
    const targetTo =
      to && to !== 'system_trigger' && to !== 'system'
        ? to
        : this.masterId
    const targetToken = contextToken || this.latestContextToken || null
    return buildSendMsg({
      contextToken: targetToken,
      fromBot: fromBot || this.client?.botId,
      text,
      to: targetTo,
    })
  }

  async doSendMessage(payload) {
    if (payload?.context_token) {
      this._recordTokenUsage(payload.context_token)
    }
    return this.client.sendMessage(payload)
  }

  /**
   * 微信链接/网页卡片下发实现
   * 微信客户端原生支持将 http(s):// 识别为可点击超链接，基于结构化数据拼装最优气泡并记录 token
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
    if (contextToken) {
      this._recordTokenUsage(contextToken)
    }
    const label = text || title || '打开已发布的网页 🌐'
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
   * 微信卡片/富媒体下发实现
   */
  async doSendCard({
    card = {},
    contextToken,
    extraRender: _extraRender,
    to,
  } = {}) {
    if (contextToken) {
      this._recordTokenUsage(contextToken)
    }
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

  /**
   * 微信原生图片发送实现 (IMAGE=1)
   */
  async doSendImage({ to, contextToken, buffer, url, localPath }) {
    if (contextToken) {
      this._recordTokenUsage(contextToken)
    }
    const imgBuffer = await MediaResolver.resolveBuffer({
      buffer,
      localPath,
      url,
    })
    if (!imgBuffer || imgBuffer.length === 0) {
      throw new Error(
        `无法获取有效的图片二进制数据 (url=${url}, localPath=${localPath})`,
      )
    }

    const mediaInfo = await this.client.uploadMedia(imgBuffer, {
      mediaType: 1,
      toUserId: to,
    })
    const imgMsg = buildSendImageMsg({
      contextToken,
      fromBot: this.client.botId,
      mediaInfo,
      to,
    })

    const sendRes = await this.client.sendMessage(imgMsg)
    this.log?.info?.(
      `[WechatChannel] 📤 原生图片消息发送结果: ${JSON.stringify(sendRes)}`,
    )
    return sendRes
  }

  /**
   * 微信语音发送实现：
   * 微信官方 Bot 不支持渲染原生语音气泡 (VOICE=4)，因此按照设计以音频文件 (FILE=3) 形式分享发送 (支持 mp3/wav)。
   */
  async doSendVoice({
    to,
    contextToken,
    buffer,
    url,
    localPath,
    fileName,
    text: _text = '',
    durationMs: _durationMs = 0,
    extraRender = {},
  } = {}) {
    this.log?.info?.(
      `[WechatChannel] 🎙️ 微信 Bot 不支持原生语音气泡，转为音频文件 (wav/mp3) 分享形式发送`,
    )

    let finalFileName =
      fileName ||
      extraRender?.fileName ||
      extraRender?.name ||
      (localPath ? localPath.split('/').pop() : '') ||
      (url ? url.split('/').pop()?.split('?')[0] : '')

    if (finalFileName) {
      const lower = finalFileName.toLowerCase()
      if (
        !lower.endsWith('.mp3') &&
        !lower.endsWith('.wav') &&
        !lower.endsWith('.m4a') &&
        !lower.endsWith('.aac') &&
        !lower.endsWith('.ogg') &&
        !lower.endsWith('.flac')
      ) {
        finalFileName = `${finalFileName}.mp3`
      }
    } else {
      if (
        buffer &&
        buffer.length >= 4 &&
        buffer[0] === 0x52 &&
        buffer[1] === 0x49 &&
        buffer[2] === 0x46 &&
        buffer[3] === 0x46
      ) {
        finalFileName = `语音消息_${Date.now()}.wav`
      } else {
        finalFileName = `语音消息_${Date.now()}.mp3`
      }
    }

    return this.doSendFile({
      buffer,
      contextToken,
      fileName: finalFileName,
      localPath,
      to,
      url,
    })
  }

  /**
   * 微信原生文件发送实现 (FILE=3)
   */
  async doSendFile({ to, contextToken, buffer, url, localPath, fileName }) {
    if (contextToken) {
      this._recordTokenUsage(contextToken)
    }
    const fileBuffer = await MediaResolver.resolveBuffer({
      buffer,
      localPath,
      url,
    })
    if (!fileBuffer || fileBuffer.length === 0) {
      throw new Error(
        `无法获取有效的文件二进制数据 (url=${url}, localPath=${localPath})`,
      )
    }

    const finalFileName =
      fileName ||
      (localPath
        ? localPath.split('/').pop()
        : url
          ? url.split('/').pop()
          : 'file')
    const mediaInfo = await this.client.uploadMedia(fileBuffer, {
      mediaType: 3,
      toUserId: to,
    })
    const fileMsg = buildSendFileMsg({
      contextToken,
      fileName: finalFileName,
      fromBot: this.client.botId,
      mediaInfo,
      to,
    })

    const sendRes = await this.client.sendMessage(fileMsg)
    this.log?.info?.(
      `[WechatChannel] 📤 原生文件消息发送结果 (${finalFileName}): ${JSON.stringify(sendRes)}`,
    )
    return sendRes
  }

  /**
   * 微信原生视频发送实现 (VIDEO=2)
   */
  async doSendVideo({
    to,
    contextToken,
    buffer,
    url,
    localPath,
    durationMs = 0,
  }) {
    if (contextToken) {
      this._recordTokenUsage(contextToken)
    }
    const videoBuffer = await MediaResolver.resolveBuffer({
      buffer,
      localPath,
      url,
    })
    if (!videoBuffer || videoBuffer.length === 0) {
      throw new Error(
        `无法获取有效的视频二进制数据 (url=${url}, localPath=${localPath})`,
      )
    }

    const mediaInfo = await this.client.uploadMedia(videoBuffer, {
      mediaType: 2,
      toUserId: to,
    })
    const videoMsg = buildSendVideoMsg({
      contextToken,
      durationMs,
      fromBot: this.client.botId,
      mediaInfo,
      to,
    })

    const sendRes = await this.client.sendMessage(videoMsg)
    this.log?.info?.(
      `[WechatChannel] 📤 原生视频消息发送结果: ${JSON.stringify(sendRes)}`,
    )
    return sendRes
  }

  // ===============================================================
  // Typing 状态交互
  // ===============================================================
  async doSendTyping(ctx, status) {
    if (!this.typing) return
    try {
      const ticket = await this._getTypingTicket(ctx.from, ctx.contextToken)
      if (!ticket) return
      await this.client.sendTyping({
        ilinkUserId: ctx.from,
        status,
        typingTicket: ticket,
      })
    } catch (e) {
      this.log?.warn?.(`[WechatChannel] sendTyping 失败: ${e?.message}`)
    }
  }

  async _getTypingTicket(userId, contextToken) {
    if (this._typingTickets.has(userId)) return this._typingTickets.get(userId)
    const cfg = await this.client.getConfig({
      contextToken,
      ilinkUserId: userId,
    })
    const ticket = cfg?.typing_ticket
    if (ticket) this._typingTickets.set(userId, ticket)
    return ticket
  }
}

export default WechatChannel
