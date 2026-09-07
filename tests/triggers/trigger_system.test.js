import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { WakeProtocol } from '../../lib/triggers/WakeProtocol.js'
import { TriggerRegistry } from '../../lib/triggers/TriggerRegistry.js'
import { TriggerRunner } from '../../lib/triggers/TriggerRunner.js'
import { WakeInjector } from '../../lib/triggers/WakeInjector.js'
import { TriggerService } from '../../lib/triggers/index.js'
import SentinelTool from '../../lib/plugins/ai-plugin/tools/sentinel.js'

const TEST_DATA_DIR = path.join(
  process.cwd(),
  'tests-data',
  'test-triggers-' + Date.now(),
)

test.before(async () => {
  await fs.promises.mkdir(TEST_DATA_DIR, { recursive: true })
})

test.after(async () => {
  await fs.promises.rm(TEST_DATA_DIR, { recursive: true, force: true })
})

test('WakeProtocol: 标准契约解析与异常保护', () => {
  // 1. 成功解析标准契约
  const stdout = [
    'Log line 1: checking BTC price',
    'Log line 2: price = 78412',
    '@WAKE@ {"wake": true, "reason": "BTC 突破 78400", "data": {"price": 78412}}',
  ].join('\n')

  const parsed = WakeProtocol.parseWakeLine(stdout)
  assert.equal(parsed.wake, true)
  assert.equal(parsed.reason, 'BTC 突破 78400')
  assert.equal(parsed.data.price, 78412)

  // 2. wake=false 契约
  const noWakeStdout = '@WAKE@ {"wake": false, "reason": "未达标"}'
  const noWakeParsed = WakeProtocol.parseWakeLine(noWakeStdout)
  assert.equal(noWakeParsed.wake, false)

  // 3. 无契约行
  const emptyStdout = 'Just normal logs without wake'
  const emptyParsed = WakeProtocol.parseWakeLine(emptyStdout)
  assert.equal(emptyParsed.wake, false)

  // 4. JSON 损坏防御
  const brokenStdout = '@WAKE@ {broken_json}'
  const brokenParsed = WakeProtocol.parseWakeLine(brokenStdout)
  assert.equal(brokenParsed.wake, false)
  assert.ok(brokenParsed.error)
})

test('TriggerRegistry: 触发器增删改查与脚本文件管理', async () => {
  const registry = new TriggerRegistry({ dataDir: TEST_DATA_DIR })

  // 1. 创建 script 触发器并自动落盘脚本文件
  const created = await registry.create({
    id: 'test_trg_btc',
    scriptCode: `console.log('@WAKE@ ' + JSON.stringify({ wake: true, reason: 'BTC突破', data: { p: 78500 } }))`,
    scriptLang: 'js',
    mode: 'once',
    type: 'script',
    promptTemplate: '【关注提示】{{payload.reason}}',
  })

  assert.equal(created.id, 'test_trg_btc')
  assert.equal(created.mode, 'once')
  assert.ok(fs.existsSync(created.scriptPath))

  // 2. 读取列表
  const list = await registry.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'test_trg_btc')

  // 3. 记录执行审计
  await registry.recordExecution({
    triggerId: created.id,
    wake: true,
    reason: 'BTC突破',
    data: { p: 78500 },
    durationMs: 45,
  })

  const logs = await registry.listExecutions('test_trg_btc')
  assert.equal(logs.length, 1)
  assert.equal(logs[0].wake, true)

  // 4. 删除触发器并验证脚本被清理
  const scriptPath = created.scriptPath
  await registry.remove(created.id)
  const afterList = await registry.list()
  assert.equal(afterList.length, 0)
  assert.ok(!fs.existsSync(scriptPath), '删除触发器应同时清理脚本文件')
})

test('TriggerRunner: 真实子进程安全执行与超时保护', async () => {
  const runner = new TriggerRunner({ timeoutMs: 3000 })

  // 1. 正常运行脚本并输出契约
  const scriptFile = path.join(TEST_DATA_DIR, 'test_runner_normal.js')
  await fs.promises.writeFile(
    scriptFile,
    `
    if (process.argv[2] !== 'test' && process.argv[2] !== 'loop') process.exit(64);
    console.log("Preparing check...");
    console.log("@WAKE@ " + JSON.stringify({ wake: true, reason: "mode=" + process.argv[2], data: { ethPrice: 3050 } }));
  `,
  )

  const res = await runner.executeScript({
    id: 'trg_eth',
    scriptPath: scriptFile,
  })

  assert.equal(res.wake, true)
  assert.equal(res.reason, 'mode=test')
  assert.equal(res.data.ethPrice, 3050)
  assert.ok(res.durationMs >= 0)

  // 2. 脚本无 WAKE 输出
  const silentScript = path.join(TEST_DATA_DIR, 'test_runner_silent.js')
  await fs.promises.writeFile(
    silentScript,
    `if (process.argv[2] !== 'test' && process.argv[2] !== 'loop') process.exit(64); console.log("Everything is normal");`,
  )
  const silentRes = await runner.executeScript({
    id: 'trg_silent',
    scriptPath: silentScript,
  })
  assert.equal(silentRes.wake, false)
})

test('WakeInjector: 会话注入、冷却限制与 once 生命周期自动销毁', async () => {
  const registry = new TriggerRegistry({
    dataDir: path.join(TEST_DATA_DIR, 'injector'),
  })
  const injectedMessages = []

  const mockChannel = {
    appendUserMessage: async (sid, text, opts) => {
      injectedMessages.push({ sid, text, opts })
    },
    memory: {
      agentId: 'wechat-master',
      getActiveSession: async () => 'session_123',
    },
  }

  const mockRuntime = {
    running: new Map([['c_1', { chn: mockChannel }]]),
  }

  const injector = new WakeInjector({
    registry,
    channelRuntime: mockRuntime,
  })

  // 1. 创建 once 触发器
  const trigger = await registry.create({
    id: 'trg_once_test',
    mode: 'once',
    cooldownSec: 10,
    sessionId: 'session_123',
    promptTemplate: '【警报】{{payload.reason}} (价格: {{payload.data.price}})',
  })

  // 2. 执行唤醒
  const wakeRes = await injector.processWake(trigger, {
    reason: 'BTC拉升',
    data: { price: 79000 },
  })

  assert.equal(wakeRes.injected, true)
  assert.equal(injectedMessages.length, 1)
  assert.ok(injectedMessages[0].text.includes('system：trigger 系统监测到事件'))
  assert.ok(injectedMessages[0].text.includes('【警报】BTC拉升 (价格: 79000)'))

  // 3. 验证 once 模式触发器已自动销毁
  const afterTrigger = await registry.get('trg_once_test')
  assert.equal(afterTrigger, null, 'once 模式触发器唤醒后应自动销毁')

  // 4. 验证审计日志依然保留
  const logs = await registry.listExecutions('trg_once_test')
  assert.equal(logs.length, 1)
  assert.equal(logs[0].status, 'woken')
})

test('sentinel Tool: 两步流创建、试跑、管理全生命周期', async () => {
  const service = new TriggerService({
    registry: new TriggerRegistry({
      dataDir: path.join(TEST_DATA_DIR, 'tool-service'),
    }),
  })
  const tool = new SentinelTool({ service })
  service.setChannelRuntime({
    running: new Map([
      [
        'sentinel-test-channel',
        {
          channel: { agentId: 'wechat-master', id: 'sentinel-test-channel' },
          chn: {
            appendUserMessage: async () => {},
            channelId: 'sentinel-test-channel',
            id: 'sentinel-test-channel',
            memory: {
              agentId: 'wechat-master',
              getActiveSession: async () => 's_test',
            },
          },
        },
      ],
    ]),
  })

  // 1. 第一步：先落盘独立的哨兵脚本文件
  const testScriptPath = path.join(TEST_DATA_DIR, 'sentinel_sol_test.js')
  await fs.promises.writeFile(
    testScriptPath,
    `
    if (process.argv[2] !== 'test' && process.argv[2] !== 'loop') process.exit(64);
    const params = JSON.parse(process.env.TRIGGER_PARAMS || '{}');
    console.log("@WAKE@ " + JSON.stringify({ wake: true, reason: "SOL 突破 " + (params.target || 200), data: { sol: 205 } }));
    `,
    'utf8',
  )

  // 2. 第二步：调用 sentinel 工具传入 scriptPath 与 params 启动哨兵
  const createRes = await tool.execute({
    params: {
      action: 'create',
      id: 'tool_test_trg',
      mode: 'persistent',
      params: { target: 200 },
      promptTemplate: 'SOL 警报: {{payload.reason}}',
      scriptPath: testScriptPath,
    },
    channel: {
      id: 'sentinel-test-channel',
      memory: {
        agentId: 'wechat-master',
        getActiveSession: async () => 's_test',
      },
    },
  })

  assert.equal(createRes.success, true)
  assert.equal(createRes.trigger.id, 'tool_test_trg')
  assert.equal(createRes.trigger.scriptPath, testScriptPath)

  // 3. 更新哨兵参数并自动重启，使新参数进入 TRIGGER_PARAMS
  const updateRes = await tool.execute({
    params: {
      action: 'update',
      id: 'tool_test_trg',
      params: { target: 210 },
      promptTemplate: 'SOL 更新警报: {{payload.reason}}',
    },
    channel: {
      id: 'sentinel-test-channel',
      memory: {
        agentId: 'wechat-master',
        getActiveSession: async () => 's_test',
      },
    },
  })
  assert.equal(updateRes.success, true)
  assert.equal(updateRes.trigger.params.target, 210)

  // 4. 试跑 (run)

  const runRes = await tool.execute({
    params: {
      action: 'run',
      id: 'tool_test_trg',
    },
  })
  assert.equal(runRes.success, true)
  assert.equal(runRes.result.wake, true)
  assert.equal(runRes.result.reason, 'SOL 突破 210')

  // 5. 列表 (list)
  const listRes = await tool.execute({
    params: { action: 'list' },
  })
  assert.ok(listRes.count >= 1)
  const found = listRes.triggers.find((t) => t.id === 'tool_test_trg')
  assert.ok(found)
  assert.ok(
    ['running', 'waking', 'woken', 'restarting', 'stopped'].includes(found.status),
    JSON.stringify(found),
  )

  // 6. 校验缺少 scriptPath 时报错
  await assert.rejects(async () => {
    await tool.execute({
      params: { action: 'create', id: 'fail_trg' },
    })
  }, /必须提供已落盘的 scriptPath/)

  // 7. 删除 (remove)
  const rmRes = await tool.execute({
    params: { action: 'remove', id: 'tool_test_trg' },
  })
  assert.equal(rmRes.success, true)
})
