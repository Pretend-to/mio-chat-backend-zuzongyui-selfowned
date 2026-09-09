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
export const ONEBOTS_RECEIVE_MODE = 'manual'

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
  ONEBOTS_RECEIVE_MODE,
  createProtocolConfig,
  createLoopbackUrl,
}
