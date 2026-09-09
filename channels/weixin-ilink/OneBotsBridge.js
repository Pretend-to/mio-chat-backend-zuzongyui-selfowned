import fs from 'node:fs'
import path from 'node:path'

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeContextTokens(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter(([peerId, token]) => nonEmptyString(peerId) && nonEmptyString(token))
      .map(([peerId, token]) => [String(peerId), String(token).trim()]),
  )
}

/** Fix malformed private packets at the Weixin iLink adapter boundary. */
export function normalizeIlinkInboundPacket(packet) {
  if (!packet || typeof packet !== 'object' || !Object.hasOwn(packet, 'group_id')) return packet
  if (packet.group_id !== null && !(typeof packet.group_id === 'string' && !packet.group_id.trim())) {
    return packet
  }
  const normalized = { ...packet }
  delete normalized.group_id
  return normalized
}

function sessionFile(gateway, accountId) {
  const sessionDir = path.resolve(
    gateway.options.sessionDataDir ?? path.join(process.cwd(), 'data', 'wechat-clawbot'),
  )
  return path.join(sessionDir, `${encodeURIComponent(accountId)}.json`)
}

export const weixinIlinkOneBotsBridge = {
  configureAccount(channelConfig, normalized) {
    return {
      ...normalized,
      outbound_text_format: channelConfig.config?.outbound_text_format
        ?? channelConfig.credentials?.outbound_text_format
        ?? 'markdown',
    }
  },

  async beforeAccountStart({ channelConfig, accountId, gateway }) {
    const token = nonEmptyString(channelConfig?.token)
    const botId = nonEmptyString(channelConfig?.botId ?? channelConfig?.bot_id)
    if (!token || !botId) return false

    const filePath = sessionFile(gateway, accountId)
    const session = {
      token,
      accountId: botId,
      ...(nonEmptyString(channelConfig?.userId ?? channelConfig?.user_id)
        ? { userId: nonEmptyString(channelConfig?.userId ?? channelConfig?.user_id) }
        : {}),
      contextTokens: normalizeContextTokens(channelConfig?.contextTokens),
    }
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
    let handle = null
    let created = false
    try {
      handle = await fs.promises.open(filePath, 'wx', 0o600)
      created = true
      await handle.writeFile(`${JSON.stringify(session, null, 2)}\n`, 'utf8')
      await handle.sync()
      return true
    } catch (error) {
      if (error?.code === 'EEXIST') return false
      if (created) await fs.promises.unlink(filePath).catch(() => {})
      throw error
    } finally {
      await handle?.close().catch(() => {})
    }
  },

  installCompatibility({ state }) {
    const client = state.account?.client
    if (typeof client?.ingest !== 'function') return null
    const original = client.ingest
    const wrapped = function (packet, ...args) {
      return Reflect.apply(original, this, [normalizeIlinkInboundPacket(packet), ...args])
    }
    client.ingest = wrapped
    return () => {
      if (client.ingest === wrapped) client.ingest = original
    }
  },

  async deleteAccountData({ accountId, gateway }) {
    await fs.promises.unlink(sessionFile(gateway, accountId)).catch(error => {
      if (error?.code !== 'ENOENT') throw error
    })
  },
}

export default weixinIlinkOneBotsBridge
