/**
 * Configuration used by the embedded OneBots runtime.
 *
 * The runtime deliberately does not expose an HTTP listener.  These values
 * are still kept in one place because clients and future transport adapters
 * use the same loopback identity when constructing URLs.
 */
export const ONEBOTS_HOST = '127.0.0.1'

const configuredPort = Number.parseInt(process.env.ONEBOTS_PORT ?? '5727', 10)
export const ONEBOTS_PORT = Number.isInteger(configuredPort) && configuredPort >= 0 && configuredPort <= 65535
  ? configuredPort
  : 5727

export const ONEBOTS_PROTOCOL = 'onebot.v12'
export const ONEBOTS_PLATFORM = 'wechat-clawbot'
export const ONEBOTS_RECEIVE_MODE = 'manual'

/**
 * Resolve persisted channel aliases to the unified OneBots runtime.
 *
 * `wechat` is intentionally kept as a storage/API compatibility alias: old
 * records do not need a schema migration or a new QR binding. The former
 * MIO_WECHAT_DRIVER rollout flag is accepted but no longer controls routing.
 */
export function isOneBotsChannel(channel, _env = process.env) {
  if (!channel) return false
  const driver = String(channel.driver || '').toLowerCase()
  const type = String(channel.type || '').toLowerCase()
  const platform = String(channel.platform || '').toLowerCase()
  return type === 'wechat' ||
    driver === 'onebots' ||
    type === 'onebots' ||
    type === 'onebot' ||
    type.startsWith('onebots:') ||
    type.startsWith('onebots-') ||
    driver === 'onebot' ||
    platform === 'onebots' ||
    platform === ONEBOTS_PLATFORM
}

/** Resolve the concrete OneBots adapter while retaining old WeChat records. */
export function resolveOneBotsPlatform(channel = {}) {
  const explicit = String(channel.platform || '').trim().toLowerCase()
  if (explicit && explicit !== 'onebots') return explicit
  const type = String(channel.type || '').trim().toLowerCase()
  const compact = type.match(/^onebots?[:/-](.+)$/)
  if (compact?.[1]) return compact[1]
  return ONEBOTS_PLATFORM
}

/** Protocol settings for an in-process account. */
export function createProtocolConfig(overrides = {}) {
  return {
    use_http: false,
    use_ws: false,
    http_webhook: [],
    ws_reverse: [],
    ...overrides,
  }
}

/** A valid loopback URL for clients which require a base URL even in manual mode. */
export function createLoopbackUrl(port = ONEBOTS_PORT) {
  return `http://${ONEBOTS_HOST}:${port}`
}

export default {
  ONEBOTS_HOST,
  ONEBOTS_PORT,
  ONEBOTS_PROTOCOL,
  ONEBOTS_PLATFORM,
  ONEBOTS_RECEIVE_MODE,
  isOneBotsChannel,
  resolveOneBotsPlatform,
  createProtocolConfig,
  createLoopbackUrl,
}
