import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getChannelCatalog,
  normalizeChannelCreatePayload,
  registerChannelAdapter,
} from '../../channels/ChannelAdapterRegistry.js'

test('channel catalog exposes adapter metadata and a legacy platforms alias', () => {
  const catalog = getChannelCatalog()
  assert.equal(catalog.version, 1)
  assert.equal(catalog.runtimes[0].id, 'onebots')
  assert.equal(catalog.adapters[0].id, 'weixin-ilink')
  assert.equal(catalog.adapters[0].auth.type, 'qrcode')
  assert.equal('package' in catalog.adapters[0], false)
  assert.deepEqual(catalog.platforms, catalog.adapters)
})

test('registered channel adapters normalize optional metadata and remain creatable', () => {
  registerChannelAdapter({
    id: 'TEST-PLATFORM',
    name: '测试平台',
    runtime: 'OneBots',
    protocol: 'OneBot.V12',
    onebots: { platform: 'test-platform' },
  })
  const created = normalizeChannelCreatePayload({
    adapter: { runtime: 'onebots', platform: 'test-platform', protocol: 'onebot.v12' },
  })
  assert.equal(created.name, '测试平台')
  assert.equal(created.agentId, 'channel-master')
  const adapter = getChannelCatalog().adapters.find(item => item.id === 'test-platform')
  assert.equal(adapter.auth.type, 'none')
  assert.deepEqual(adapter.configSchema, [])
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
    type: 'weixin-ilink',
    adapterId: 'weixin-ilink',
    driver: 'onebots',
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
  assert.equal(legacy.type, 'weixin-ilink')
  assert.equal(legacy.platform, 'wechat-clawbot')
  const onebotAlias = normalizeChannelCreatePayload({ type: 'onebot' })
  assert.equal(onebotAlias.type, 'weixin-ilink')
  assert.equal(onebotAlias.platform, 'wechat-clawbot')
  assert.throws(
    () => normalizeChannelCreatePayload({
      adapter: { runtime: 'onebots', platform: 'missing', protocol: 'onebot.v12' },
    }),
    /Unsupported channel adapter/,
  )
  assert.throws(
    () => normalizeChannelCreatePayload({ version: 2 }),
    /Unsupported channel creation version/,
  )
})
