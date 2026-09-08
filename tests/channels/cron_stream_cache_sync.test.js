import { test } from 'node:test'
import assert from 'node:assert'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

global.logger = global.logger || console

import { MemoryStore } from '../../channels/memory/index.js'
import { OneBotChannel } from '../../channels/onebots/OneBotChannel.js'
import { createBackendLlm } from '../../channels/llm.js'
import streamCache from '../../lib/server/socket.io/services/streamCache.js'

const MASTER = 'master@im.wechat'

function createMockClient() {
  const sent = []
  return {
    botId: 'bot-1',
    downloadMedia: async () => Buffer.from('fake'),
    getUpdates: async () => ({ msgs: [], ret: 0 }),
    sendMessage: async (payload) => {
      sent.push(payload)
      return { ret: 0 }
    },
    sent,
  }
}

test('Channel 任务流式执行：微信下发与 StreamCache 异步沉淀完全并发且互不影响', async () => {
  const baseDir = path.join(os.tmpdir(), `mio-streamcache-test-${Date.now()}_${Math.random().toString(36).slice(2, 7)}`)
  const channelId = 'ch_cron_replay_1'
  const memory = new MemoryStore({ agentId: channelId, baseDir })
  await memory.writeSoul('你是定时任务执行者')

  const client = createMockClient()

  // 模拟一个发射完整思考链、工具调用和正文流的 LLM Service
  const mockLlmService = {
    getModelList: () => ({ openai: ['gpt-4o'] }),
    handleMessage: async (event) => {
      // 1. 发射思考链
      await event.update({
        data: { text: '正在拉取 3U Alpha Fund 链上与风控数据...' },
        type: 'reason',
      })
      // 2. 发射工具调用
      await event.update({
        content: {
          action: 'finished',
          id: 'tc_1',
          name: 'get_fund_analytics',
          result: { pnl: '+12.5%', riskScore: 'Low' },
        },
        type: 'toolCall',
      })
      // 3. 发射正文流
      await event.update({
        content: '【3U Alpha Fund 早报】老哥，今日资金曲线稳步上行，风控总监桐乃已完成全量指标巡检！',
        type: 'content',
      })
      // 4. 完成
      if (typeof event.complete === 'function') {
        await event.complete()
      }
    },
  }

  const chn = new OneBotChannel({
    channelId,
    client,
    id: channelId,
    llm: createBackendLlm({ llmService: mockLlmService }),
    masterId: MASTER,
    memory,
    typing: false,
  })

  try {
    const taskMessageId = `msg_task_${Date.now()}`
    const ctx = {
      channelId,
      contextToken: 'CTX_CRON',
      from: MASTER,
      isTask: true,
      messageId: taskMessageId,
      rawMsg: null,
    }

    // 微信端执行
    await chn._processChat('执行早报定时任务', ctx)

    // 验证 1：微信端收到回复
    assert.strictEqual(client.sent.length, 1, '微信端必须收到早报内容')
    assert.equal(client.sent[0].scene_type, 'private')
    assert.equal(client.sent[0].scene_id, MASTER)
    assert.match(client.sent[0].message[0].data.text, /3U Alpha Fund 早报/)

    // 验证 2：Web 离线情况下，streamCache 是否完整沉淀快照
    const adminSnapshot = streamCache.snapshot('random_admin_client_id', channelId)
    assert.ok(adminSnapshot && adminSnapshot.length > 0, '即便该 client 首次上线，也能从 admin 共享槽读到流快照')
    
    const cachedItem = adminSnapshot.find(m => m.messageId === taskMessageId)
    assert.ok(cachedItem, '快照中必须包含该定时任务的 messageId')
    assert.strictEqual(cachedItem.status, 'completed', '任务执行完毕后状态必须为 completed')

    // 验证 3：清理快照 ACK 机制
    streamCache.deleteMessage('random_admin_client_id', channelId, taskMessageId)
    const afterAck = streamCache.snapshot('random_admin_client_id', channelId)
    assert.strictEqual((afterAck || []).filter(m => m.messageId === taskMessageId).length, 0, '客户端 ACK 后缓存被安全清理')
  } finally {
    streamCache.delete('admin', channelId)
    fs.rmSync(baseDir, { force: true, recursive: true })
  }
})
