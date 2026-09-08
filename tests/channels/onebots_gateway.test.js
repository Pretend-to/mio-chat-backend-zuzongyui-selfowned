import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BaseApp } from 'onebots'
import '@onebots/adapter-wechat-clawbot'
import {
  OneBotsGateway,
  normalizeIlinkInboundPacket,
} from '../../channels/onebots/OneBotsGateway.js'
import { isOneBotsChannel } from '../../channels/onebots/config.js'

class FakeProtocol extends EventEmitter {
  async apply(action, params) {
    return { action, params }
  }
}

class FakeClient extends EventEmitter {
  ingest(event) {
    this.events ??= []
    this.events.push(event)
  }
}

class FakeAccount extends EventEmitter {
  constructor(id) {
    super()
    this.account_id = id
    this.status = 'pending'
    this.client = new EventEmitter()
    this.client.ingest = packet => { this.ingested = packet }
    this.protocols = [new FakeProtocol()]
    this.starts = 0
    this.stops = 0
  }

  async start() {
    this.starts += 1
    this.client.emit('qr', { qrCodeUrl: 'https://example.test/qr', qrcode: 'bitmap' })
    this.client.emit('login', { accountId: 'wx-user' })
    this.status = 'online'
    this.client.emit('ready')
  }

  async stop() {
    this.stops += 1
    this.status = 'offline'
    this.removeAllListeners()
  }
}

function makeApp() {
  const accounts = new Map()
  const adapter = {
    accounts,
    createAccount(config) {
      const account = new FakeAccount(config.account_id)
      accounts.set(config.account_id, account)
      return account
    },
  }
  return {
    adapters: new Map([['wechat-clawbot', adapter]]),
    async addAccount(config) {
      adapter.createAccount(config)
    },
    getLogger() {
      return console
    },
    async stop() {},
  }
}

test('OneBots treats legacy wechat records as a permanent compatibility alias', () => {
  assert.equal(isOneBotsChannel({ type: 'wechat' }, {}), true)
  assert.equal(isOneBotsChannel({ type: 'onebots' }, {}), true)
  assert.equal(isOneBotsChannel({ type: 'wechat' }, { MIO_WECHAT_DRIVER: 'onebots' }), true)
})

test('blank iLink group_id is normalized as a private event', () => {
  const withNull = { message_type: 1, from_user_id: 'user', group_id: null }
  const withBlank = { message_type: 1, from_user_id: 'user', group_id: '  ' }
  const withGroup = { message_type: 1, from_user_id: 'user', group_id: 'group-1' }
  const withInvalidType = { message_type: 1, from_user_id: 'user', group_id: 42 }

  assert.equal(Object.hasOwn(normalizeIlinkInboundPacket(withNull), 'group_id'), false)
  assert.equal(Object.hasOwn(normalizeIlinkInboundPacket(withBlank), 'group_id'), false)
  assert.equal(normalizeIlinkInboundPacket(withGroup), withGroup)
  assert.equal(normalizeIlinkInboundPacket(withInvalidType), withInvalidType)
})

test('WeChat ClawBot accounts preserve Markdown by default and allow an explicit override', () => {
  const gateway = new OneBotsGateway({ app: makeApp(), skipRegistration: true })
  const defaults = gateway.normalizeChannelConfig({ id: 'markdown-default' })
  const explicitPlain = gateway.normalizeChannelConfig({
    id: 'plain-override',
    config: { outbound_text_format: 'plain' },
  })

  assert.equal(defaults.outbound_text_format, 'markdown')
  assert.equal(explicitPlain.outbound_text_format, 'plain')
})

test('patched iLink sender passes Markdown through without collapsing line breaks', async () => {
  const app = new BaseApp({
    port: 6727,
    host: '127.0.0.1',
    log_level: 'warn',
    general: {},
  })
  const adapter = app.findOrCreateAdapter('wechat-clawbot')
  const account = adapter.createAccount({
    platform: 'wechat-clawbot',
    account_id: 'markdown-runtime',
    receive_mode: 'manual',
    outbound_text_format: 'markdown',
  })
  const client = account.client
  let envelope
  client.transport.dispatchOutboundEnvelope = async value => { envelope = value }
  const markdown = '\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```js\nconst x = 1\n```\n'

  assert.equal(client.getConfig().outbound_text_format, 'markdown')
  await client.outbound.postText('peer', 'reply-context', markdown)

  assert.equal(envelope.msg.item_list[0].text_item.text, markdown)
  await app.stop()
})

test('OneBotsGateway mounts an account, bridges QR/ready state, and is idempotent', async () => {
  const app = makeApp()
  const gateway = new OneBotsGateway({
    app,
    skipRegistration: true,
    clientFactory: async () => new FakeClient(),
  })

  await gateway.init()
  const first = await gateway.startAccount({ id: 'channel-1', platform: 'wechat-clawbot' })
  const second = await gateway.startAccount({ id: 'channel-1', platform: 'wechat-clawbot' })
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(first, second)
  const account = app.adapters.get('wechat-clawbot').accounts.get('channel-1')
  assert.equal(account.starts, 1)
  await account.client.ingest({ message_type: 1, from_user_id: 'user', group_id: null })
  assert.equal(Object.hasOwn(account.ingested, 'group_id'), false)
  assert.equal(gateway.getAccountState('channel-1').status, 'online')
  assert.equal(gateway.getAccountState('channel-1').ready, true)
  // A QR is no longer active after login.
  assert.equal(gateway.qrSessions.has('channel-1'), false)
  assert.equal(gateway.getQrCode('channel-1'), null)

  await gateway.dispose()
  assert.equal(gateway.disposed, true)
  assert.equal(app.adapters.get('wechat-clawbot').accounts.has('channel-1'), false)
})

test('OneBotsGateway creates a manual in-process client and routes actions/events', async () => {
  const app = makeApp()
  const gateway = new OneBotsGateway({
    app,
    skipRegistration: true,
    clientFactory: async config => {
      const client = new FakeClient()
      client.config = config
      return client
    },
  })
  await gateway.startAccount({ id: 'channel-2', platform: 'wechat-clawbot' })
  const client = await gateway.createClient('channel-2')
  const response = await client.config.call('ping', { value: 1 })
  assert.deepEqual(response, { action: 'ping', params: { value: 1 } })

  const account = app.adapters.get('wechat-clawbot').accounts.get('channel-2')
  account.protocols[0].emit('dispatch', JSON.stringify({ type: 'meta', detail_type: 'heartbeat' }))
  assert.deepEqual(client.events, [{ type: 'meta', detail_type: 'heartbeat' }])
  const rawEvent = { message_id: 42, item_list: [{ type: 2 }] }
  account.protocols[0].emit('dispatch', JSON.stringify({
    type: 'message',
    detail_type: 'private',
    message_id: '42',
    raw_event: rawEvent,
    extensions: { wechat_clawbot: { context_token: 'ctx-42' } },
  }))
  assert.deepEqual(gateway.getInboundMetadata('channel-2', '42'), {
    extensions: { wechat_clawbot: { context_token: 'ctx-42' } },
    platform: undefined,
    raw_event: rawEvent,
  })
  assert.equal(client.config.receiveMode, 'manual')
  assert.match(client.config.baseUrl, /^http:\/\/127\.0\.0\.1:/)
  await gateway.stopAccount('channel-2')
  assert.equal(gateway.getAccountState('channel-2').status, 'offline')
  await gateway.dispose()
})

test('background login failures are captured without unhandled rejection', async () => {
  const app = makeApp()
  app.adapters.get('wechat-clawbot').createAccount = config => {
    const result = new FakeAccount(config.account_id)
    result.start = async () => { throw new Error('login failed') }
    app.adapters.get('wechat-clawbot').accounts.set(config.account_id, result)
    return result
  }
  const gateway = new OneBotsGateway({ app, skipRegistration: true })
  await gateway.startAccount({ id: 'channel-3', platform: 'wechat-clawbot' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(gateway.getAccountState('channel-3').status, 'error')
  assert.equal(gateway.getAccountState('channel-3').error, 'login failed')
  await gateway.dispose()
})

test('OneBotsGateway seeds a legacy credential session without overwriting it', async t => {
  const sessionDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'onebots-session-'))
  t.after(() => fs.promises.rm(sessionDataDir, { force: true, recursive: true }))
  const gateway = new OneBotsGateway({ app: makeApp(), skipRegistration: true, sessionDataDir })

  await gateway.startAccount({
    id: 'legacy/channel',
    platform: 'wechat-clawbot',
    token: 'legacy-token',
    botId: 'legacy-bot',
    userId: 'legacy-user',
    contextTokens: { 'legacy-user': 'legacy-context' },
  })
  const filePath = path.join(sessionDataDir, `${encodeURIComponent('legacy/channel')}.json`)
  assert.deepEqual(JSON.parse(await fs.promises.readFile(filePath, 'utf8')), {
    token: 'legacy-token',
    accountId: 'legacy-bot',
    userId: 'legacy-user',
    contextTokens: { 'legacy-user': 'legacy-context' },
  })

  await fs.promises.writeFile(filePath, JSON.stringify({ token: 'new-token' }))
  await gateway.startAccount({
    id: 'legacy/channel',
    platform: 'wechat-clawbot',
    token: 'stale-token',
    botId: 'stale-bot',
    userId: 'stale-user',
  })
  assert.deepEqual(JSON.parse(await fs.promises.readFile(filePath, 'utf8')), { token: 'new-token' })
  await gateway.deleteAccount('legacy/channel')
  assert.equal(fs.existsSync(filePath), false)
  await gateway.dispose()
})

test('OneBotsGateway does not create a legacy session when credentials are incomplete', async t => {
  const sessionDataDir = path.join(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'onebots-session-')), 'nested')
  t.after(() => fs.promises.rm(path.dirname(sessionDataDir), { force: true, recursive: true }))
  const gateway = new OneBotsGateway({ app: makeApp(), skipRegistration: true, sessionDataDir })

  await gateway.startAccount({ id: 'missing-token', platform: 'wechat-clawbot', botId: 'bot' })
  await gateway.startAccount({ id: 'missing-bot', platform: 'wechat-clawbot', token: 'token' })
  assert.equal(fs.existsSync(sessionDataDir), false)
  await gateway.dispose()
})
