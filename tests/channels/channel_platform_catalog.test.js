import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getChannelCatalog,
  normalizeChannelCreatePayload,
  registerChannelPlatform,
} from '../../channels/onebots/platformCatalog.js'

test('channel catalog exposes versioned platform metadata without package internals', () => {
  const catalog = getChannelCatalog()
  assert.equal(catalog.version, 1)
  assert.equal(catalog.runtimes[0].id, 'onebots')
  assert.equal(catalog.platforms[0].id, 'wechat-clawbot')
  assert.equal(catalog.platforms[0].auth.type, 'qrcode')
  assert.equal('package' in catalog.platforms[0], false)
})

test('registered OneBots platforms normalize optional metadata and remain creatable', () => {
  registerChannelPlatform({
    id: 'TEST-PLATFORM',
    name: '测试平台',
    runtime: 'OneBots',
    protocol: 'OneBot.V12',
  })
  const created = normalizeChannelCreatePayload({
    adapter: { runtime: 'onebots', platform: 'test-platform', protocol: 'onebot.v12' },
  })
  assert.equal(created.name, '测试平台')
  assert.equal(created.agentId, 'channel-master')
  const platform = getChannelCatalog().platforms.find(item => item.id === 'test-platform')
  assert.equal(platform.auth.type, 'none')
  assert.deepEqual(platform.configSchema, [])
})

test('structured channel creation resolves defaults and adapter config', () => {
  assert.deepEqual(normalizeChannelCreatePayload({
    adapter: {
      runtime: 'onebots',
      platform: 'wechat-clawbot',
      protocol: 'onebot.v12',
    },
    profile: { name: '研发微信', agentId: 'agent-dev', provider: 'Vertex' },
  }), {
    type: 'onebots',
    platform: 'wechat-clawbot',
    protocol: 'onebot.v12',
    name: '研发微信',
    agentId: 'agent-dev',
    provider: 'Vertex',
    model: '',
    config: { outbound_text_format: 'markdown' },
  })
})

test('flat legacy WeChat creation remains compatible and invalid platforms fail closed', () => {
  const legacy = normalizeChannelCreatePayload({ type: 'wechat', name: '旧微信' })
  assert.equal(legacy.type, 'wechat')
  assert.equal(legacy.platform, 'wechat-clawbot')
  const onebotAlias = normalizeChannelCreatePayload({ type: 'onebot' })
  assert.equal(onebotAlias.type, 'onebots')
  assert.equal(onebotAlias.platform, 'wechat-clawbot')
  assert.throws(
    () => normalizeChannelCreatePayload({
      adapter: { runtime: 'onebots', platform: 'missing', protocol: 'onebot.v12' },
    }),
    /Unsupported channel platform/,
  )
  assert.throws(
    () => normalizeChannelCreatePayload({ version: 2 }),
    /Unsupported channel creation version/,
  )
})
