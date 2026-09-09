import { bufferToImageUrl } from '../../utils/imgTools.js'
import storageService from '../../lib/storage/StorageService.js'
import {
  OneBotChannel,
  contentSegments,
  fileNameFromData,
  segmentData,
  segmentType,
  sourceFromData,
} from '../onebots/OneBotChannel.js'

function mediaSegments(msg) {
  return contentSegments(msg)
    .map((segment, index) => ({ segment, index, type: segmentType(segment), data: segmentData(segment) }))
    .filter(({ type, data }) =>
      (type === 'image' || type === 'file') && sourceFromData(data) != null && sourceFromData(data) !== '',
    )
}

function rawMediaItem(item, type) {
  if (!item || typeof item !== 'object') return null
  if (type === 'image') return item.image_item?.media ?? null
  if (type === 'file') return item.file_item?.media ?? null
  return null
}

function sameMediaHandle(data, rawMedia) {
  if (!rawMedia) return false
  const fileId = data.file_id ?? data.fileId
  return (fileId != null && fileId === rawMedia.encrypt_query_param) ||
    (data.url != null && data.url === rawMedia.full_url)
}

function reliableItemIndexes(msg, segments) {
  const explicit = segments.map(({ data }) => data.item_index ?? data.itemIndex)
  const rawItems = msg?.raw_event?.item_list
  if (!Array.isArray(rawItems)) {
    return explicit.every(index => Number.isSafeInteger(index) && index >= 0) ? explicit : null
  }
  const used = new Set()
  const indexes = []
  for (let i = 0; i < segments.length; i++) {
    const { type, data } = segments[i]
    const candidate = explicit[i]
    if (Number.isSafeInteger(candidate) && candidate >= 0) {
      if (!rawMediaItem(rawItems[candidate], type) || used.has(candidate)) return null
      used.add(candidate)
      indexes.push(candidate)
      continue
    }
    const matches = rawItems
      .map((item, index) => ({ item, index }))
      .filter(({ item, index }) => !used.has(index) && sameMediaHandle(data, rawMediaItem(item, type)))
    if (matches.length !== 1) return null
    used.add(matches[0].index)
    indexes.push(matches[0].index)
  }
  return indexes
}

function rawMessageId(msg) {
  const raw = msg?.raw_event
  const value = raw?.message_id ?? raw?.seq ?? raw?.client_id ?? msg?.message_id ?? msg?.messageId
  return value == null || value === '' ? null : String(value)
}

export class WeixinIlinkChannel extends OneBotChannel {
  constructor(options) {
    super({ ...options, channelType: 'weixin-ilink' })
  }

  extractContextToken(msg) {
    return super.extractContextToken(msg) ?? msg.extensions?.wechat_clawbot?.context_token ?? null
  }

  resolveInboundMedia(msg, extracted) {
    const segments = mediaSegments(msg)
    if (segments.length === 0) return super.resolveInboundMedia(msg, extracted)
    return {
      files: [],
      hasMedia: true,
      images: [],
      pendingMediaPromise: this._downloadMedia(msg, segments),
    }
  }

  async _downloadMedia(msg, segments) {
    const messageId = rawMessageId(msg)
    if (!messageId) {
      this.log?.warn?.('[weixin-ilink] 媒体缺少可靠 message_id，已跳过下载')
      return { files: [], images: [] }
    }
    const indexes = reliableItemIndexes(msg, segments)
    if (segments.length > 1 && !indexes) {
      this.log?.warn?.('[weixin-ilink] 多媒体消息缺少可靠 item_index，已拒绝下载')
      return { files: [], images: [] }
    }
    if (typeof this.client?.call !== 'function') {
      this.log?.warn?.('[weixin-ilink] OneBot 客户端不支持 download_media')
      return { files: [], images: [] }
    }

    const images = []
    const files = []
    for (let i = 0; i < segments.length; i++) {
      const { type, data } = segments[i]
      const params = { message_id: messageId }
      if (indexes?.[i] != null) params.item_index = indexes[i]
      try {
        const response = await this.client.call('download_media', params)
        const result = response?.data && typeof response.data === 'object' ? response.data : response
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
          const fileName = result.file_name || result.fileName ||
            fileNameFromData(data, sourceFromData(data))
          const stored = await storageService.upload(buffer, fileName, 'file', {
            contentType: result.mime_type || result.mimeType || 'application/octet-stream',
          })
          if (stored?.url) files.push({ name: fileName, url: stored.url })
        }
      } catch (error) {
        this.log?.warn?.(`[weixin-ilink] 媒体下载解密失败: ${error?.message || error}`)
      }
    }
    return { files, images }
  }
}

export default WeixinIlinkChannel
