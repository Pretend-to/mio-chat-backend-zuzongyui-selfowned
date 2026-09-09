import fs from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getChannelCatalog,
  resolveChannelAdapter,
} from '../../channels/ChannelAdapterRegistry.js'
import { OneBotChannel } from '../../channels/onebots/OneBotChannel.js'
import { WeixinIlinkChannel } from '../../channels/weixin-ilink/WeixinIlinkChannel.js'

test('legacy and current Weixin identifiers resolve to the MioChat adapter boundary', () => {
  for (const channel of [
    { type: 'wechat' },
    { type: 'onebots', platform: 'wechat-clawbot' },
    { type: 'weixin-ilink', driver: 'onebots' },
  ]) {
    assert.equal(resolveChannelAdapter(channel)?.id, 'weixin-ilink')
  }
  assert.deepEqual(getChannelCatalog().adapters.map(item => item.id), ['weixin-ilink'])
  assert.equal(resolveChannelAdapter({ type: 'onebots', platform: 'qq' }), null)
})

test('Weixin iLink owns platform behavior while extending the generic OneBot channel', () => {
  const adapter = resolveChannelAdapter({ type: 'weixin-ilink' })
  const channel = adapter.createChannel({
    client: {},
    memory: {},
    masterId: 'owner',
    llm: {},
  })
  assert.equal(channel instanceof WeixinIlinkChannel, true)
  assert.equal(channel instanceof OneBotChannel, true)
  assert.equal(adapter.onebots.platform, 'wechat-clawbot')
})

test('OneBots foundation contains no Weixin or iLink implementation details', () => {
  const files = [
    new URL('../../channels/onebots/OneBotChannel.js', import.meta.url),
    new URL('../../channels/onebots/OneBotsGateway.js', import.meta.url),
    new URL('../../channels/onebots/config.js', import.meta.url),
  ]
  for (const file of files) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /wechat|weixin|ilink|clawbot/i)
  }
})
