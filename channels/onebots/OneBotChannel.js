/**
 * 通用 OneBot V12 渠道适配器。
 *
 * @imhelper/onebot-v12 将入站事件规范化为 message.private/message.group，
 * 将下行消息暴露为 sendPrivateMessage/sendGroupMessage。这里保持
 * BaseChannel 的会话、防抖、流式发送和降级语义，只处理协议差异。
 */

import { BaseChannel } from '../common/BaseChannel.js'
import { bufferToImageUrl } from '../../utils/imgTools.js'
import storageService from '../../lib/storage/StorageService.js'

const MEDIA_TYPES = new Set(['image', 'file', 'video', 'audio', 'voice', 'record'])
const INBOUND_DEDUPE_TTL_MS = 10 * 60 * 1000
const INBOUND_DEDUPE_MAX_SIZE = 2048

function asString(value) {
  return value == null ? '' : String(value)
}

function segmentData(segment) {
  return segment && typeof segment === 'object' && segment.data && typeof segment.data === 'object'
    ? segment.data
    : {}
}

function contentSegments(msg) {
  const content = msg?.content ?? msg?.message ?? msg?.segments ?? []
  if (Array.isArray(content)) return content
  if (content == null || content === '') return []
  return [content]
}

function segmentType(segment) {
  return typeof segment === 'object' ? asString(segment.type).toLowerCase() : 'text'
}

function sourceFromData(data) {
  // OneBot file may be a URL, local path, base64:// URI, or an implementation
  // specific file id. Preserve the value instead of downloading it here.
  return data.url ?? data.file ?? data.path ?? data.local_path ?? data.base64 ?? data.file_id ?? null
}

function fileNameFromData(data, source) {
  if (data.file_name || data.filename || data.name) return asString(data.file_name || data.filename || data.name)
  if (typeof source === 'string') {
    const clean = source.split('?')[0].replace(/\\/g, '/')
    return clean.slice(clean.lastIndexOf('/') + 1) || 'file'
  }
  return 'file'
}

function mediaDescriptor(type, data, source) {
  return {
    name: fileNameFromData(data, source),
    type,
    url: source,
    ...(data.file_id != null ? { fileId: data.file_id } : {}),
    ...(data.duration != null ? { duration: data.duration } : {}),
  }
}

function wechatMediaSegments(msg) {
  return contentSegments(msg)
    .map((segment, index) => ({ segment, index, type: segmentType(segment), data: segmentData(segment) }))
    .filter(({ type, data }) => {
      const source = sourceFromData(data)
      return (type === 'image' || type === 'file') && source != null && source !== ''
    })
}

function rawWechatMediaItem(item, type) {
  if (!item || typeof item !== 'object') return null
  if (type === 'image') return item.image_item?.media ?? null
  if (type === 'file') return item.file_item?.media ?? null
  return null
}

function sameMediaHandle(data, rawMedia) {
  if (!rawMedia) return false
  const fileId = data.file_id ?? data.fileId
  const url = data.url
  return (fileId != null && fileId === rawMedia.encrypt_query_param) ||
    (url != null && url === rawMedia.full_url)
}

/**
 * Resolve iLink item indexes without guessing. The OneBots protocol projects
 * raw media handles into V12 segments, while the ClawBot action addresses the
 * original iLink item list.
 */
function reliableWechatItemIndexes(msg, mediaSegments) {
  const explicit = mediaSegments.map(({ data }) => data.item_index ?? data.itemIndex)
  const rawItems = msg?.raw_event?.item_list
  if (!Array.isArray(rawItems)) {
    return explicit.every(index => Number.isSafeInteger(index) && index >= 0) ? explicit : null
  }

  const used = new Set()
  const indexes = []
  for (let i = 0; i < mediaSegments.length; i++) {
    const { type, data } = mediaSegments[i]
    const candidate = explicit[i]
    if (Number.isSafeInteger(candidate) && candidate >= 0) {
      if (!rawWechatMediaItem(rawItems[candidate], type) || used.has(candidate)) return null
      used.add(candidate)
      indexes.push(candidate)
      continue
    }

    const matches = rawItems
      .map((item, index) => ({ item, index }))
      .filter(({ item, index }) => !used.has(index) && sameMediaHandle(data, rawWechatMediaItem(item, type)))
    if (matches.length !== 1) return null
    used.add(matches[0].index)
    indexes.push(matches[0].index)
  }
  return indexes
}

function rawWechatMessageId(msg) {
  const raw = msg?.raw_event
  const value = raw?.message_id ?? raw?.seq ?? raw?.client_id ?? msg?.message_id ?? msg?.messageId
  return value == null || value === '' ? null : String(value)
}

/** Extract plain text from a OneBot V12 event (SDK event or raw protocol event). */
export function extractText(msg) {
  const texts = []
  for (const segment of contentSegments(msg)) {
    if (typeof segment === 'string') {
      texts.push(segment)
      continue
    }
    const data = segmentData(segment)
    if (segmentType(segment) === 'text' || data.text != null) texts.push(asString(data.text ?? segment.text))
  }
  return texts.join('')
}

/** Extract media into the shapes consumed by BaseChannel's multimodal route. */
export function extractMedia(msg) {
  const images = []
  const files = []
  for (const segment of contentSegments(msg)) {
    const type = segmentType(segment)
    if (!MEDIA_TYPES.has(type)) continue
    const data = segmentData(segment)
    const source = sourceFromData(data)
    if (source == null || source === '') continue
    if (type === 'image') images.push(source)
    else files.push(mediaDescriptor(type === 'record' ? 'audio' : type, data, source))
  }
  return { images, files }
}

function mediaFileValue({ buffer, localPath, url, base64 }) {
  if (buffer != null) {
    if (Buffer.isBuffer(buffer)) return `base64://${buffer.toString('base64')}`
    if (buffer instanceof Uint8Array) return `base64://${Buffer.from(buffer).toString('base64')}`
    if (typeof buffer === 'string') return buffer
  }
  if (base64 != null && base64 !== '') {
    const value = String(base64)
    if (value.startsWith('base64://') || value.startsWith('http://') || value.startsWith('https://')) return value
    if (value.startsWith('data:')) return `base64://${value.slice(value.indexOf(',') + 1)}`
    return `base64://${value}`
  }
  return localPath || url || null
}

function normalizeStatus(status) {
  if (status === 'active' || status === 1 || status === true) return 'active'
  return 'idle'
}

export class OneBotChannel extends BaseChannel {
  constructor(opts) {
    super({ ...opts, channelType: opts?.channelType || 'onebot' })
    this.channel = opts?.channel ?? null
    this.gateway = opts?.gateway ?? null
    this.platform = opts?.platform ?? this.channel?.platform ?? null
    this._eventsBound = false
    this._privateHandler = null
    this._groupHandler = null
    this._startPromise = null
    this._stopPromise = null
    this._recentInboundMessages = new Map()
  }

  _isWechatClawbot() {
    const platform = String(
      this.platform ?? this.channel?.platform ?? this.client?.platform ?? '',
    ).toLowerCase()
    if (platform === 'wechat-clawbot') return true
    // OneBots currently defaults every embedded account to the ClawBot
    // adapter. Keep an explicitly named non-WeChat platform on the generic
    // path so future adapters retain their existing media behavior.
    return !platform && String(this.channel?.type ?? '').toLowerCase().startsWith('onebots')
  }

  async _downloadWechatMedia(msg, mediaSegments) {
    const messageId = rawWechatMessageId(msg)
    if (!messageId) {
      this.log?.warn?.(`[${this.channelType}] 微信媒体缺少可靠 message_id，已跳过下载`)
      return { files: [], images: [] }
    }

    const indexes = reliableWechatItemIndexes(msg, mediaSegments)
    if (mediaSegments.length > 1 && !indexes) {
      this.log?.warn?.(
        `[${this.channelType}] 微信多媒体消息缺少可靠 item_index，已拒绝媒体下载`,
      )
      return { files: [], images: [] }
    }
    const canCall = typeof this.client?.call === 'function'
    if (!canCall) {
      this.log?.warn?.(`[${this.channelType}] 微信媒体客户端不支持 download_media`)
      return { files: [], images: [] }
    }

    const images = []
    const files = []
    for (let i = 0; i < mediaSegments.length; i++) {
      const { type, data } = mediaSegments[i]
      const params = { message_id: messageId }
      if (indexes?.[i] != null) params.item_index = indexes[i]
      try {
        const response = await this.client.call('download_media', params)
        const result = response?.data && typeof response.data === 'object'
          ? response.data
          : response
        if (typeof result?.base64 !== 'string' || !result.base64.trim()) {
          throw new Error('download_media 未返回有效 Base64')
        }
        const buffer = Buffer.from(result.base64, 'base64')
        if (buffer.length === 0) throw new Error('download_media 返回空媒体')

        if (type === 'image') {
          const localUrl = typeof this.bufferToImageUrl === 'function'
            ? await this.bufferToImageUrl(buffer)
            : await bufferToImageUrl(this.baseUrl || '', buffer)
          if (localUrl) images.push(localUrl)
        } else {
          const fileName = result.file_name || result.fileName || fileNameFromData(data, sourceFromData(data))
          const stored = await storageService.upload(
            buffer,
            fileName,
            'file',
            { contentType: result.mime_type || result.mimeType || 'application/octet-stream' },
          )
          if (stored?.url) files.push({ name: fileName, url: stored.url })
        }
      } catch (error) {
        this.log?.warn?.(
          `[${this.channelType}] 微信媒体下载解密失败: ${error?.message || error}`,
        )
      }
    }
    return { files, images }
  }

  _isDuplicateInbound(msg) {
    const messageId = msg?.message_id ?? msg?.messageId
    if (messageId == null || messageId === '') return false

    const now = Date.now()
    const key = [
      msg?.self_id ?? msg?.selfId ?? '',
      msg?.detail_type ?? msg?.message_type ?? '',
      msg?.group_id ?? msg?.groupId ?? '',
      msg?.user_id ?? msg?.userId ?? '',
      messageId,
    ].join(':')
    const seenAt = this._recentInboundMessages.get(key)
    if (seenAt != null && now - seenAt < INBOUND_DEDUPE_TTL_MS) return true

    this._recentInboundMessages.set(key, now)
    if (this._recentInboundMessages.size > INBOUND_DEDUPE_MAX_SIZE) {
      for (const [candidate, timestamp] of this._recentInboundMessages) {
        if (
          now - timestamp >= INBOUND_DEDUPE_TTL_MS ||
          this._recentInboundMessages.size > INBOUND_DEDUPE_MAX_SIZE
        ) {
          this._recentInboundMessages.delete(candidate)
        }
      }
    }
    return false
  }

  _bindEvents() {
    if (this._eventsBound || typeof this.client?.on !== 'function') return
    const handle = (event, type) => {
      Promise.resolve(this.handleIncomingMessage(event, type)).catch((error) => {
        this.log?.error?.(`[${this.channelType}] 处理 OneBot 入站消息失败: ${error?.message || error}`)
      })
    }
    this._privateHandler = (event) => handle(event, 'private')
    this._groupHandler = (event) => handle(event, 'group')
    this.client.on('message.private', this._privateHandler)
    this.client.on('message.group', this._groupHandler)
    this._eventsBound = true
  }

  _unbindEvents() {
    if (!this._eventsBound) return
    const remove = typeof this.client?.off === 'function' ? this.client.off.bind(this.client) : this.client?.removeListener?.bind(this.client)
    if (remove) {
      remove('message.private', this._privateHandler)
      remove('message.group', this._groupHandler)
    }
    this._privateHandler = null
    this._groupHandler = null
    this._eventsBound = false
  }

  async start() {
    if (this._startPromise) return this._startPromise
    if (this.running) return
    this._startPromise = (async () => {
      this.running = true
      this._abort = new AbortController()
      if (this.memory?.getAgentMeta) {
        try {
          this.latestContextToken = await this.memory.getAgentMeta('latestContextToken', null)
        } catch {}
      }
      this.keepAlive.start()
      this._bindEvents()
      try {
        await this.client.start?.()
      } catch (error) {
        this._unbindEvents()
        this.running = false
        this.keepAlive.stop()
        this._abort?.abort()
        this._abort = null
        throw error
      }
    })()
    try {
      return await this._startPromise
    } finally {
      this._startPromise = null
    }
  }

  async stop() {
    if (this._stopPromise) return this._stopPromise
    if (!this.running && !this._eventsBound) return
    this._stopPromise = (async () => {
      this._unbindEvents()
      let error = null
      try {
        // Let BaseChannel clear typing/keep-alive state while the client is
        // still available, then stop the SDK receive transport.
        await super.stop()
      } catch (e) {
        error = e
      }
      try {
        await this.client.stop?.()
      } catch (e) {
        error ||= e
      }
      if (error) throw error
    })()
    try {
      return await this._stopPromise
    } finally {
      this._stopPromise = null
    }
  }

  // BaseChannel.start is intentionally not used: the SDK owns its receive loop.
  async _loop() {}

  async handleIncomingMessage(msg, detailType = null) {
    if (!msg) return
    const metadata = this.gateway?.getInboundMetadata?.(
      this.channel?.id ?? this.channelId,
      msg.message_id ?? msg.messageId,
    )
    if (metadata) {
      msg = {
        ...metadata,
        ...msg,
        extensions: msg.extensions ?? metadata.extensions,
        raw_event: msg.raw_event ?? metadata.raw_event,
      }
    }
    const type = detailType || msg.message_type || msg.detail_type
    const userId = msg.user_id ?? msg.userId
    const groupId = msg.group_id ?? msg.groupId
    if (type === 'private') {
      if (userId == null || String(userId) !== String(this.masterId)) return
    } else if (type !== 'group' || groupId == null) {
      return
    }

    // OneBots transports may redeliver the same event while reconnecting or
    // before their durable receive cursor is committed. Record the id before
    // the first await so concurrent copies cannot both enter BaseChannel's
    // session queue.
    if (this._isDuplicateInbound(msg)) {
      this.log?.debug?.(
        `[${this.channelType}] 忽略重复 OneBot 入站消息: ${msg.message_id ?? msg.messageId}`,
      )
      return
    }

    const extracted = extractMedia(msg)
    const isWechatClawbot = this._isWechatClawbot()
    const wechatSegments = isWechatClawbot ? wechatMediaSegments(msg) : []
    const hasWechatMedia = wechatSegments.length > 0
    const images = isWechatClawbot ? [] : extracted.images
    const files = isWechatClawbot ? [] : extracted.files
    const text = extractText(msg) || (extracted.images.length ? '[图片]' : extracted.files.length ? `[文件: ${extracted.files[0].name}]` : '')
    const pendingMediaPromise = hasWechatMedia
      ? this._downloadWechatMedia(msg, wechatSegments)
      : null
    const from = type === 'group' ? `group:${groupId}` : String(userId)
    const messageContext = {
      messageId: msg.message_id ?? msg.messageId,
      messageType: type,
      userId,
      ...(type === 'group' ? { groupId } : {}),
    }
    const contextToken = msg.context_token ?? msg.contextToken ??
      msg.extensions?.wechat_clawbot?.context_token ?? null
    const isSlash = text.trim().startsWith('/')
    return this.enqueueInboundDebounce(from, {
      contextToken,
      files,
      hasMedia: hasWechatMedia || images.length > 0 || files.length > 0,
      images,
      immediate: isSlash,
      pendingMediaPromise,
      rawMsg: msg,
      text,
      ctx: messageContext,
    })
  }

  extractText(msg) {
    return extractText(msg)
  }

  _target(to) {
    const value = to == null || to === 'system' || to === 'system_trigger' ? this.masterId : to
    const text = String(value)
    if (text.startsWith('group:')) return { scene_type: 'group', scene_id: text.slice(6) }
    return { scene_type: 'private', scene_id: value }
  }

  buildSendMsg({ to, _to, text, _text } = {}) {
    const target = this._target(to ?? _to)
    return {
      ...target,
      message: [{ type: 'text', data: { text: asString(text ?? _text) } }],
    }
  }

  async doSendMessage(payload) {
    if (!payload) return null
    const target = payload.scene_type
      ? payload
      : payload.detail_type === 'group' || payload.group_id != null
        ? { scene_type: 'group', scene_id: payload.group_id, message: payload.message }
        : { scene_type: 'private', scene_id: payload.user_id ?? this.masterId, message: payload.message }
    const message = target.message ?? []
    try {
      if (target.scene_type === 'group' && typeof this.client?.sendGroupMessage === 'function') {
        return await this.client.sendGroupMessage(target.scene_id, message)
      }
      if (target.scene_type === 'private' && typeof this.client?.sendPrivateMessage === 'function') {
        return await this.client.sendPrivateMessage(target.scene_id, message)
      }
      if (typeof this.client?.sendMessage === 'function') return await this.client.sendMessage(target)
      this.log?.warn?.(`[${this.channelType}] 客户端不支持 OneBot 消息发送`)
      return null
    } catch (error) {
      this.log?.warn?.(`[${this.channelType}] OneBot 消息发送失败: ${error?.message || error}`)
      throw error
    }
  }

  _mediaPayload(type, options = {}) {
    const value = mediaFileValue(options)
    if (!value) return null
    const data = { file: value }
    if (options.fileName) data.name = options.fileName
    if (options.durationMs != null) data.duration = options.durationMs
    return {
      ...this._target(options.to),
      message: [{ type, data }],
    }
  }

  async _sendMedia(type, options, label) {
    const payload = this._mediaPayload(type, options)
    if (payload) return this.doSendMessage(payload)
    // A media resolver is deliberately not required by OneBot: unsupported or
    // unavailable media safely degrades to a small textual notification.
    const target = options?.to
    return this.doSendMessage(this.buildSendMsg({ to: target, text: label }))
  }

  doSendImage(options = {}) {
    return this._sendMedia('image', options, '🖼️ [图片]')
  }

  doSendFile(options = {}) {
    return this._sendMedia('file', options, `📁 [文件: ${options.fileName || 'file'}]`)
  }

  doSendVideo(options = {}) {
    return this._sendMedia('video', options, '🎬 [视频]')
  }

  doSendVoice(options = {}) {
    return this._sendMedia('audio', options, '🎙️ [语音消息]')
  }

  async doSendTyping(ctx = {}, status) {
    if (!this.typing || typeof this.client?.call !== 'function') return null
    const userId = ctx.userId ?? (String(ctx.from || '').startsWith('group:') ? null : ctx.from)
    const params = {
      user_id: userId ?? this.masterId,
      context_token: ctx.contextToken ?? ctx.context_token ?? null,
      status: normalizeStatus(status),
    }
    try {
      return await this.client.call('send_typing', params)
    } catch (error) {
      this.log?.debug?.(`[${this.channelType}] send_typing 不可用: ${error?.message || error}`)
      return null
    }
  }
}

export default OneBotChannel
