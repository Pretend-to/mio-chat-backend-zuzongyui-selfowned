import { ONEBOTS_PLATFORM, ONEBOTS_PROTOCOL } from './config.js'

const CATALOG_VERSION = 1

const PLATFORM_DEFINITIONS = [
  {
    id: ONEBOTS_PLATFORM,
    runtime: 'onebots',
    protocol: ONEBOTS_PROTOCOL,
    name: '微信 ClawBot',
    description: '通过微信 iLink 协议接入私聊、图片和文件消息。',
    icon: '💚',
    package: '@onebots/adapter-wechat-clawbot',
    auth: { type: 'qrcode', label: '微信扫码绑定' },
    capabilities: {
      detailTypes: ['private'],
      media: ['image', 'file'],
      markdown: true,
    },
    defaults: {
      agentId: 'wechat-master',
      name: '微信助手',
    },
    configSchema: [
      {
        key: 'outbound_text_format',
        label: '文本格式',
        type: 'select',
        default: 'markdown',
        options: [
          { label: 'Markdown', value: 'markdown' },
          { label: '纯文本', value: 'plain' },
        ],
      },
    ],
  },
]

const platforms = new Map(PLATFORM_DEFINITIONS.map(platform => [platform.id, platform]))

export function registerChannelPlatform(definition) {
  const id = String(definition?.id || '').trim().toLowerCase()
  if (!id) throw new TypeError('Channel platform requires a non-empty id')
  if (!definition?.name || !definition?.protocol || !definition?.runtime) {
    throw new TypeError(`Channel platform ${id} requires name, runtime, and protocol`)
  }
  const runtime = String(definition.runtime).trim().toLowerCase()
  const protocol = String(definition.protocol).trim().toLowerCase()
  if (runtime !== 'onebots') {
    throw new TypeError(`Unsupported channel runtime: ${runtime}`)
  }
  if (protocol !== ONEBOTS_PROTOCOL) {
    throw new TypeError(`Unsupported protocol for ${id}: ${protocol}`)
  }
  const normalized = {
    ...definition,
    id,
    runtime,
    protocol,
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
  }
  platforms.set(id, normalized)
  const index = PLATFORM_DEFINITIONS.findIndex(item => item.id === id)
  if (index >= 0) PLATFORM_DEFINITIONS[index] = normalized
  else PLATFORM_DEFINITIONS.push(normalized)
  return normalized
}

function publicPlatform(platform) {
  const { package: _package, ...result } = platform
  return structuredClone(result)
}

export function getChannelCatalog() {
  return {
    version: CATALOG_VERSION,
    runtimes: [{
      id: 'onebots',
      name: 'OneBots',
      description: '统一 OneBot 多平台运行时',
      protocols: [ONEBOTS_PROTOCOL],
    }],
    platforms: PLATFORM_DEFINITIONS.map(publicPlatform),
  }
}

export function getPlatformDefinition(platformId) {
  return platforms.get(String(platformId || '').trim().toLowerCase()) ?? null
}

/** Normalize the versioned creation contract and the former flat request. */
export function normalizeChannelCreatePayload(body = {}) {
  if (body.version != null && body.version !== CATALOG_VERSION) {
    throw new TypeError(`Unsupported channel creation version: ${body.version}`)
  }
  const adapter = body.adapter && typeof body.adapter === 'object' ? body.adapter : {}
  const profile = body.profile && typeof body.profile === 'object' ? body.profile : body
  const legacyType = String(body.type || '').trim().toLowerCase()
  const legacyWechat = legacyType === 'wechat'
  const compactPlatform = legacyType.match(/^onebots?[:/-](.+)$/)?.[1]
  const requestedRuntime = String(adapter.runtime || legacyType || 'onebots').trim().toLowerCase()
  const runtime = requestedRuntime === 'onebot' || requestedRuntime === 'onebots' || compactPlatform
    ? 'onebots'
    : requestedRuntime
  const platform = String(
    adapter.platform || body.platform || compactPlatform || ONEBOTS_PLATFORM,
  ).trim().toLowerCase()
  const protocol = String(adapter.protocol || body.protocol || ONEBOTS_PROTOCOL).trim().toLowerCase()

  if (runtime !== 'onebots' && !legacyWechat) {
    throw new TypeError(`Unsupported channel runtime: ${runtime || '(empty)'}`)
  }
  const definition = getPlatformDefinition(platform)
  if (!definition) throw new TypeError(`Unsupported channel platform: ${platform || '(empty)'}`)
  if (protocol !== definition.protocol) {
    throw new TypeError(`Unsupported protocol for ${platform}: ${protocol || '(empty)'}`)
  }
  if (body.config != null && (typeof body.config !== 'object' || Array.isArray(body.config))) {
    throw new TypeError('Channel config must be an object')
  }

  return {
    type: legacyWechat ? 'wechat' : 'onebots',
    platform,
    protocol,
    name: profile.name || definition.defaults?.name || definition.name,
    agentId: profile.agentId || definition.defaults?.agentId || 'channel-master',
    provider: profile.provider || '',
    model: profile.model || '',
    config: {
      ...Object.fromEntries(
        (definition.configSchema || [])
          .filter(field => field.default !== undefined)
          .map(field => [field.key, field.default]),
      ),
      ...body.config,
    },
  }
}

export default {
  getChannelCatalog,
  getPlatformDefinition,
  registerChannelPlatform,
  normalizeChannelCreatePayload,
}
