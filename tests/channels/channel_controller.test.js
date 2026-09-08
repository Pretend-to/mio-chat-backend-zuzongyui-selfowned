import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ChannelRuntime, ChannelStore } from '../../channels/index.js'
import * as controller from '../../lib/server/http/controllers/channelController.js'

function response() {
  const res = { body: null, statusCode: 200 }
  res.json = value => { res.body = value; return value }
  res.status = statusCode => {
    res.statusCode = statusCode
    return { json: value => { res.body = value; return value } }
  }
  return res
}

const request = (params = {}, body = {}) => ({ body, params })

test('Channel 管理 API 统一通过 OneBots，并兼容旧 wechat 记录', async t => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'channel-controller-onebots-'))
  t.after(() => fs.promises.rm(tempDir, { force: true, recursive: true }))
  const store = new ChannelStore({ file: path.join(tempDir, 'channels.json') })
  const accountStates = new Map()
  const qrCalls = []
  const gateway = {
    async init() {},
    async requestQrLogin(channel, platform, options) {
      qrCalls.push({ channel, platform, options })
      accountStates.set(channel.id, {
        botId: 'bot-9',
        status: 'online',
        token: 'token-9',
        userId: 'master@im.wechat',
      })
      return { qrcode: 'qr-1', qrCodeUrl: 'https://example.com/qr.png' }
    },
    getAccountState(id) { return accountStates.get(String(id)) || { status: 'wait' } },
    async startAccount(channel) {
      if (!accountStates.has(channel.id)) {
        accountStates.set(channel.id, {
          botId: channel.botId,
          status: 'online',
          token: channel.token,
          userId: channel.userId,
        })
      }
    },
    async createClient() { return { start() {}, stop() {} } },
    async stopAccount() {},
    async dispose() {},
  }
  const runtime = new ChannelRuntime({
    channelStore: store,
    memoryBase: path.join(tempDir, 'memory'),
    onebotsGateway: gateway,
    onebotChannelFactory: () => ({
      connected: true,
      async start() {},
      async stop() {},
    }),
    llm: { process: async () => ({ text: 'ok' }) },
  })
  t.after(() => runtime.dispose())
  controller.initChannelController({ channelStore: store, runtime, onebotsGateway: gateway })

  const catalogResponse = response()
  controller.getChannelPlatformCatalog(request(), catalogResponse)
  assert.equal(catalogResponse.body.data.version, 1)
  assert.deepEqual(
    catalogResponse.body.data.platforms.map(platform => platform.id),
    ['wechat-clawbot'],
  )
  assert.equal(catalogResponse.body.data.platforms[0].auth.type, 'qrcode')

  const invalidCreateResponse = response()
  await controller.createChannel(request({}, { version: 2 }), invalidCreateResponse)
  assert.equal(invalidCreateResponse.statusCode, 400)

  const createResponse = response()
  await controller.createChannel(request({}, {
    adapter: {
      runtime: 'onebots',
      platform: 'wechat-clawbot',
      protocol: 'onebot.v12',
    },
    profile: { name: '结构化创建', agentId: 'wechat-master' },
    config: { receive_mode: 'manual' },
  }), createResponse)
  const generic = await store.get(createResponse.body.data.id)
  assert.equal(generic.type, 'onebots')
  assert.equal(generic.platform, 'wechat-clawbot')
  assert.equal(generic.protocol, 'onebot.v12')
  assert.deepEqual(generic.config, {
    outbound_text_format: 'markdown',
    receive_mode: 'manual',
  })
  await store.remove(generic.id)

  const created = await store.create({ name: '绑定测试', type: 'wechat' })
  const qrResponse = response()
  await controller.getChannelQrcode(request({ id: created.id }, { force: true }), qrResponse)
  assert.equal(qrResponse.body.data.qrcode, 'qr-1')
  assert.equal(qrResponse.body.data.img, 'https://example.com/qr.png')
  assert.equal(qrCalls[0].options.force, true)

  const pollResponse = response()
  await controller.pollChannelQr(request({ id: created.id }, { qrcode: 'qr-1' }), pollResponse)
  assert.equal(pollResponse.body.data.status, 'confirmed')
  const bound = await store.get(created.id)
  assert.equal(bound.token, 'token-9')
  assert.equal(bound.botId, 'bot-9')
  assert.equal(bound.userId, 'master@im.wechat')
  assert.equal(bound.status, 'running')
  assert.equal(runtime.isRunning(created.id), true)

  const publicChannel = await store.getPublic(created.id)
  assert.equal('token' in publicChannel, false)
  const detailResponse = response()
  await controller.getChannel(request({ id: created.id }), detailResponse)
  assert.equal('token' in detailResponse.body.data, false)
  assert.equal(detailResponse.body.data.hasToken, true)

  await controller.updateChannel(request({ id: created.id }, { name: '改名' }), response())
  assert.equal((await store.get(created.id)).name, '改名')

  await controller.stopChannel(request({ id: created.id }), response())
  assert.equal(runtime.isRunning(created.id), false)

  const startResponse = response()
  await controller.startChannel(request({ id: created.id }), startResponse)
  assert.equal(startResponse.body.data.started, true)

  await controller.deleteChannel(request({ id: created.id }), response())
  assert.equal(await store.get(created.id), null)
})
