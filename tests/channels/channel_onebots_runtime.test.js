import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as controller from '../../lib/server/http/controllers/channelController.js'
import { ChannelRuntime } from '../../channels/ChannelRuntime.js'

function makeStore(channel) {
  let current = { ...channel }
  return {
    async get() { return { ...current } },
    async listInternal() { return [{ ...current }] },
    async update(_id, patch) { current = { ...current, ...patch }; return { ...current } },
    snapshot() { return { ...current } },
  }
}

function makeMemory() {
  return {
    async ensure() {},
    async recoverInterruptedMessages() { return 0 },
    async getAgentMeta(_key, fallback) { return fallback },
  }
}

function makeResponse() {
  const response = { statusCode: 200, body: null }
  response.json = value => { response.body = value }
  response.status = code => ({ json(value) { response.statusCode = code; response.body = value } })
  return response
}

test('ChannelRuntime uses injected OneBots gateway/factory and stops account', async () => {
  const store = makeStore({
    id: 'onebot-1', type: 'onebots', platform: 'wechat-clawbot',
    agentId: 'agent', userId: 'user-1', botId: 'bot-1', status: 'bound', token: '',
  })
  const calls = []
  const gateway = {
    async init() { calls.push('init') },
    async startAccount(channel) { calls.push(['startAccount', channel.id]) },
    async stopAccount(id) { calls.push(['stopAccount', id]) },
    async createClient(channel) { calls.push(['createClient', channel.id]); return { start() {}, stop() {} } },
  }
  const fakeChannel = {
    connected: true,
    async start() { calls.push('channel.start') },
    async stop() { calls.push('channel.stop') },
  }
  const runtime = new ChannelRuntime({
    channelStore: store,
    onebotsGateway: gateway,
    onebotChannelFactory: options => {
      assert.equal(options.gateway, gateway)
      assert.equal(options.channel.id, 'onebot-1')
      return fakeChannel
    },
    persistenceFactory: async () => makeMemory(),
    llm: { process: async () => ({ text: 'ok' }) },
  })

  await runtime.start('onebot-1')
  assert.deepEqual(calls, ['init', ['startAccount', 'onebot-1'], ['createClient', 'onebot-1'], 'channel.start'])
  assert.equal(store.snapshot().status, 'running')
  await runtime.stop('onebot-1')
  assert.deepEqual(calls.slice(-2), ['channel.stop', ['stopAccount', 'onebot-1']])
  assert.equal(store.snapshot().status, 'stopped')
  await runtime.dispose()
})

test('ChannelRuntime rolls back a OneBots account when Channel startup fails', async () => {
  const store = makeStore({
    id: 'onebot-fail', type: 'onebots', platform: 'wechat-clawbot',
    agentId: 'agent', userId: 'user-1', botId: 'bot-1', status: 'bound', token: '',
  })
  const calls = []
  const gateway = {
    async init() {},
    async startAccount() { calls.push('account.start') },
    async createClient() { return {} },
    async stopAccount() { calls.push('account.stop') },
  }
  const runtime = new ChannelRuntime({
    channelStore: store,
    onebotsGateway: gateway,
    onebotChannelFactory: () => ({
      async start() { throw new Error('channel start failed') },
    }),
    persistenceFactory: async () => makeMemory(),
  })

  await assert.rejects(runtime.start('onebot-fail'), /channel start failed/)
  assert.deepEqual(calls, ['account.start', 'account.stop'])
  assert.equal(runtime.isRunning('onebot-fail'), false)
})

test('OneBots QR controller delegates QR and confirmed state to gateway', async () => {
  const store = makeStore({
    id: 'onebot-qr', type: 'onebots', platform: 'wechat-clawbot',
    agentId: 'agent', userId: '', botId: '', status: 'unbound', token: '',
  })
  const calls = []
  const gateway = {
    async requestQrLogin(channel) { calls.push(['qr', channel.id]); return { qrCodeUrl: 'url', qrcode: 'code' } },
    getAccountState(id) { calls.push(['state', id]); return { status: 'confirmed', userId: 'user', botId: 'bot' } },
  }
  const runtime = {
    onebotsGateway: gateway,
    isRunning: () => false,
    async start() { calls.push('runtime.start') },
    async stop() { calls.push('runtime.stop') },
    createMemory: async () => makeMemory(),
  }
  controller.initChannelController({ channelStore: store, runtime, onebotsGateway: gateway, startTriggers: false })

  const qrResponse = makeResponse()
  await controller.getChannelQrcode({ params: { id: 'onebot-qr' } }, qrResponse)
  assert.equal(qrResponse.body.data.img, 'url')
  assert.deepEqual(calls[0], ['qr', 'onebot-qr'])

  const pollResponse = makeResponse()
  await controller.pollChannelQr({ params: { id: 'onebot-qr' }, body: {} }, pollResponse)
  assert.equal(pollResponse.body.data.status, 'confirmed')
  assert.equal(store.snapshot().userId, 'user')
  assert.equal(store.snapshot().botId, 'bot')
  assert.ok(calls.includes('runtime.start'))
})
