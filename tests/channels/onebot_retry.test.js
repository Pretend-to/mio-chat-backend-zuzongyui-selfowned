import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  OneBotChannel,
  isRetryableSendError,
} from '../../channels/onebots/OneBotChannel.js'

function makeMemory() {
  const values = new Map()
  return {
    agentId: 'retry-test',
    async getAgentMeta(key, fallback = null) {
      return values.has(key) ? values.get(key) : fallback
    },
    async setAgentMeta(key, value) {
      values.set(key, value)
    },
    async getActiveSession() {
      return 'session-1'
    },
  }
}

test('isRetryableSendError correctly distinguishes fatal vs retryable errors', () => {
  // 致命错误不可重试
  assert.equal(
    isRetryableSendError(new Error('微信会话已过期 (ret=-14)，需要重新扫码')),
    false,
  )
  assert.equal(
    isRetryableSendError(new Error('StaleCredentialFault: token expired')),
    false,
  )
  assert.equal(
    isRetryableSendError(new Error('get_updates_buf ret=-12 invalid param')),
    false,
  )
  assert.equal(isRetryableSendError(new Error('401 Unauthorized')), false)
  assert.equal(isRetryableSendError(new Error('User not_found')), false)

  // 暂态与频率错误可重试
  assert.equal(
    isRetryableSendError(new Error('frequency limit exceeded, too fast')),
    true,
  )
  assert.equal(
    isRetryableSendError(new Error('rate limit 429: Too Many Requests')),
    true,
  )
  assert.equal(isRetryableSendError(new Error('system busy, ret=-1')), true)
  assert.equal(isRetryableSendError(new Error('fetch failed: ETIMEDOUT')), true)
  assert.equal(isRetryableSendError(new Error('502 Bad Gateway')), true)
})

test('OneBotChannel retries transient failure with backoff and succeeds', async () => {
  const client = new EventEmitter()
  let attempts = 0
  client.sendPrivateMessage = async (_id, _message) => {
    attempts++
    if (attempts < 3) {
      throw new Error('sendMessage ret=-1 errmsg=frequency limit')
    }
    return { message_id: 'msg_ok' }
  }

  const channel = new OneBotChannel({
    client,
    memory: makeMemory(),
    masterId: 'master_user',
    minOutboundIntervalMs: 10,
    sendMaxRetries: 3,
    sendRetryDelayMs: 20, // 快速单测
  })

  const res = await channel.doSendMessage({
    scene_type: 'private',
    scene_id: 'master_user',
    message: [{ type: 'text', data: { text: 'hello' } }],
  })

  assert.equal(attempts, 3)
  assert.deepEqual(res, { message_id: 'msg_ok' })
})

test('OneBotChannel terminates immediately on non-retryable error', async () => {
  const client = new EventEmitter()
  let attempts = 0
  client.sendPrivateMessage = async () => {
    attempts++
    throw new Error('微信会话已过期 (ret=-14)，需要重新扫码')
  }

  const channel = new OneBotChannel({
    client,
    memory: makeMemory(),
    masterId: 'master_user',
    minOutboundIntervalMs: 10,
    sendMaxRetries: 3,
    sendRetryDelayMs: 20,
  })

  await assert.rejects(
    () =>
      channel.doSendMessage({
        scene_type: 'private',
        scene_id: 'master_user',
        message: [{ type: 'text', data: { text: 'test' } }],
      }),
    (err) => {
      assert.ok(err.message.includes('ret=-14'))
      return true
    },
  )

  // 致命错误立即抛出，不浪费重试次数
  assert.equal(attempts, 1)
})

test('OneBotChannel throws last error when max retries exceeded', async () => {
  const client = new EventEmitter()
  let attempts = 0
  client.sendPrivateMessage = async () => {
    attempts++
    throw new Error('429 Too Many Requests')
  }

  const channel = new OneBotChannel({
    client,
    memory: makeMemory(),
    masterId: 'master_user',
    minOutboundIntervalMs: 10,
    sendMaxRetries: 2, // 最多重试2次，共尝试3次
    sendRetryDelayMs: 10,
  })

  await assert.rejects(
    () =>
      channel.doSendMessage({
        scene_type: 'private',
        scene_id: 'master_user',
        message: [{ type: 'text', data: { text: 'test' } }],
      }),
    (err) => {
      assert.ok(err.message.includes('429'))
      return true
    },
  )

  assert.equal(attempts, 3)
})

test('OneBotChannel enforces pacing interval between consecutive sends', async () => {
  const client = new EventEmitter()
  const sendTimestamps = []
  client.sendPrivateMessage = async () => {
    sendTimestamps.push(Date.now())
    return { ok: true }
  }

  const channel = new OneBotChannel({
    client,
    memory: makeMemory(),
    masterId: 'master_user',
    minOutboundIntervalMs: 50, // 50ms 节流
    sendMaxRetries: 0,
  })

  // 并发触发两条消息发送
  await Promise.all([
    channel.doSendMessage({
      scene_type: 'private',
      scene_id: 'master_user',
      message: [],
    }),
    channel.doSendMessage({
      scene_type: 'private',
      scene_id: 'master_user',
      message: [],
    }),
  ])

  assert.equal(sendTimestamps.length, 2)
  const interval = sendTimestamps[1] - sendTimestamps[0]
  assert.ok(interval >= 45, `Expected interval >= 45ms, but got ${interval}ms`)
})
