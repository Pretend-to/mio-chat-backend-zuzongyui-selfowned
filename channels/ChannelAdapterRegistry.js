import { weixinIlinkAdapter } from './weixin-ilink/index.js'

const CATALOG_VERSION = 1
const definitions = []
const aliases = new Map()

function normalizeId(value) {
  return String(value || '').trim().toLowerCase()
}

export function registerChannelAdapter(definition) {
  const id = normalizeId(definition?.id)
  if (!id) throw new TypeError('Channel adapter requires a non-empty id')
  const runtime = normalizeId(definition?.runtime)
  const protocol = normalizeId(definition?.protocol)
  if (!definition?.name || !runtime || !protocol) {
    throw new TypeError(`Channel adapter ${id} requires name, runtime, and protocol`)
  }
  if (runtime !== 'onebots' || protocol !== 'onebot.v12') {
    throw new TypeError(`Channel adapter ${id} requires the supported onebots/onebot.v12 runtime`)
  }
  if (!normalizeId(definition.onebots?.platform)) {
    throw new TypeError(`Channel adapter ${id} requires onebots.platform`)
  }
  const normalized = {
    ...definition,
    id,
    runtime,
    protocol,
    aliases: Array.isArray(definition.aliases) ? definition.aliases.map(normalizeId).filter(Boolean) : [],
    auth: definition.auth && typeof definition.auth === 'object'
      ? { ...definition.auth }
      : { type: 'none', label: '无需绑定' },
    capabilities: definition.capabilities && typeof definition.capabilities === 'object'
      ? { ...definition.capabilities }
      : {},
    defaults: definition.defaults && typeof definition.defaults === 'object'
      ? { ...definition.defaults }
      : {},
    configSchema: Array.isArray(definition.configSchema) ? [...definition.configSchema] : [],
    onebots: {
      ...definition.onebots,
      platform: normalizeId(definition.onebots.platform),
    },
  }
  const index = definitions.findIndex(item => item.id === id)
  if (index >= 0) definitions[index] = normalized
  else definitions.push(normalized)
  for (const [alias, target] of aliases) {
    if (target === id) aliases.delete(alias)
  }
  aliases.set(id, id)
  for (const alias of normalized.aliases) aliases.set(alias, id)
  if (normalized.onebots?.platform) aliases.set(normalizeId(normalized.onebots.platform), id)
  return normalized
}

registerChannelAdapter(weixinIlinkAdapter)

export function getChannelAdapterDefinition(value) {
  const key = normalizeId(value)
  const id = aliases.get(key) ?? key
  return definitions.find(item => item.id === id) ?? null
}

export function resolveChannelAdapter(channel = {}) {
  for (const candidate of [channel.adapterId, channel.adapter]) {
    const definition = getChannelAdapterDefinition(candidate)
    if (definition) return definition
  }
  const platform = normalizeId(channel.platform)
  if (platform && platform !== 'onebots') return getChannelAdapterDefinition(platform)
  return getChannelAdapterDefinition(channel.type)
}

export function isOneBotsChannel(channel) {
  if (!channel) return false
  const definition = resolveChannelAdapter(channel)
  if (definition) return definition.runtime === 'onebots'
  const driver = normalizeId(channel.driver)
  const type = normalizeId(channel.type)
  return driver === 'onebots' || driver === 'onebot' || type === 'onebots' ||
    type === 'onebot' || /^onebots?[:/-]/.test(type)
}

export function resolveOneBotsPlatform(channel = {}) {
  const explicit = normalizeId(channel.platform)
  if (explicit && explicit !== 'onebots') return explicit
  const definition = resolveChannelAdapter(channel)
  if (definition?.onebots?.platform) return definition.onebots.platform
  return normalizeId(channel.type).match(/^onebots?[:/-](.+)$/)?.[1] || ''
}

function publicDefinition(definition) {
  const {
    aliases: _aliases,
    createChannel: _createChannel,
    onebots: _onebots,
    ...result
  } = definition
  return structuredClone(result)
}

export function getChannelCatalog() {
  const adapters = definitions.map(publicDefinition)
  return {
    version: CATALOG_VERSION,
    runtimes: [{
      id: 'onebots',
      name: 'OneBots',
      description: '统一 OneBot 多平台底层运行时',
      protocols: ['onebot.v12'],
    }],
    adapters,
    // Compatibility alias for older frontends. New clients should consume
    // `adapters`: these entries describe MioChat adapters, not OneBots platforms.
    platforms: structuredClone(adapters),
  }
}

/** Normalize the versioned creation contract and former flat requests. */
export function normalizeChannelCreatePayload(body = {}) {
  if (body.version != null && body.version !== CATALOG_VERSION) {
    throw new TypeError(`Unsupported channel creation version: ${body.version}`)
  }
  const adapterRequest = body.adapter && typeof body.adapter === 'object' ? body.adapter : {}
  const profile = body.profile && typeof body.profile === 'object' ? body.profile : body
  const requestedId = adapterRequest.id || adapterRequest.platform || body.adapterId ||
    body.platform || body.type || 'weixin-ilink'
  const definition = getChannelAdapterDefinition(requestedId)
  if (!definition) throw new TypeError(`Unsupported channel adapter: ${normalizeId(requestedId) || '(empty)'}`)

  const runtime = normalizeId(adapterRequest.runtime || body.driver || definition.runtime)
  const protocol = normalizeId(adapterRequest.protocol || body.protocol || definition.protocol)
  if (runtime !== definition.runtime) {
    throw new TypeError(`Unsupported runtime for ${definition.id}: ${runtime || '(empty)'}`)
  }
  if (protocol !== definition.protocol) {
    throw new TypeError(`Unsupported protocol for ${definition.id}: ${protocol || '(empty)'}`)
  }
  if (body.config != null && (typeof body.config !== 'object' || Array.isArray(body.config))) {
    throw new TypeError('Channel config must be an object')
  }

  return {
    type: definition.id,
    adapterId: definition.id,
    driver: definition.runtime,
    platform: definition.onebots?.platform || definition.id,
    protocol,
    name: profile.name || definition.defaults.name || definition.name,
    agentId: profile.agentId || definition.defaults.agentId || 'channel-master',
    provider: profile.provider || '',
    model: profile.model || '',
    config: {
      ...Object.fromEntries(
        definition.configSchema
          .filter(field => field.default !== undefined)
          .map(field => [field.key, field.default]),
      ),
      ...body.config,
    },
  }
}

export default {
  getChannelAdapterDefinition,
  getChannelCatalog,
  isOneBotsChannel,
  normalizeChannelCreatePayload,
  registerChannelAdapter,
  resolveChannelAdapter,
  resolveOneBotsPlatform,
}
