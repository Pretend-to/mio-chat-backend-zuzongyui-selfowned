import { test } from 'node:test'
import assert from 'node:assert'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { ChannelStore } from '../../channels/index.js'

test('ChannelStore 渠道配置持久化', async () => {
  const file = path.join(os.tmpdir(), `channels-${Date.now()}.json`)
  const store = new ChannelStore({ file })

  await test('默认字段保持平台无关，token 不明文返回', async () => {
    const c = await store.create({ name: '我的微信' })
    assert.strictEqual(c.agentId, 'channel-master')
    assert.strictEqual(c.type, 'channel')
    assert.strictEqual(c.adapterId, '')
    assert.strictEqual(c.driver, '')
    assert.strictEqual(c.platform, '')
    assert.strictEqual(c.protocol, '')
    assert.strictEqual(c.status, 'unbound')
    assert.ok(c.hasToken === false, '无 token 时 hasToken=false')
    assert.ok(!('token' in c), '对外不返回 token 明文')
  })

  await test('绑定写入：update 落 token/botId/userId，list 脱敏', async () => {
    const c = await store.create({ name: '助手A' })
    await store.update(c.id, { token: 'secret-token', botId: 'bot-1', status: 'running', lastActive: Date.now() })
    const raw = await store.get(c.id)
    assert.strictEqual(raw.token, 'secret-token', '内部持有明文 token')
    const pub = await store.getPublic(c.id)
    assert.ok(!('token' in pub) && pub.hasToken === true, '对外脱敏 + hasToken=true')
    const list = await store.list()
    assert.ok(list.every((x) => !('token' in x)), 'list 全部脱敏')
  })

  await test('旧式直接创建的已绑定微信记录补齐适配器身份', async () => {
    const c = await store.create({
      name: '旧微信',
      token: 'legacy-token',
      userId: 'legacy-user',
    })
    assert.strictEqual(c.type, 'weixin-ilink')
    assert.strictEqual(c.adapterId, 'weixin-ilink')
    assert.strictEqual(c.driver, 'onebots')
    assert.strictEqual(c.platform, 'wechat-clawbot')
    assert.strictEqual(c.protocol, 'onebot.v12')
  })

  await test('remove 删除', async () => {
    const c = await store.create()
    assert.ok(await store.remove(c.id))
    assert.strictEqual(await store.get(c.id), null)
    assert.strictEqual(await store.remove(c.id), false, '删不存在的返回 false')
  })

  fs.rmSync(file, { force: true })
})
