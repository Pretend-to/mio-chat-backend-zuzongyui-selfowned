import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { PrismaClient } from '@prisma/client'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { BaseChannel } from '../../channels/common/BaseChannel.js'
import { ChannelStore } from '../../channels/ChannelStore.js'
import { MemoryStore } from '../../channels/memory/MemoryStore.js'
import { restoreRunningChannels } from '../../channels/restoreRunningChannels.js'
import { TriggerRegistry } from '../../lib/triggers/TriggerRegistry.js'
import {
  DatabaseMemoryStore,
  PersistenceMirrorError,
  SessionPersistence,
} from '../../lib/chat/persistence/index.js'

async function createFixture(t) {
  const root = await fs.promises.mkdtemp('/tmp/mio-session-persistence-')
  const databasePath = `/tmp/${path.basename(root)}.db`
  execFileSync(path.join(process.cwd(), 'node_modules/.bin/prisma'), [
    'db',
    'push',
    '--schema',
    path.join(process.cwd(), 'prisma/schema.prisma'),
    '--url',
    `file:${databasePath}`,
  ], {
    env: { ...process.env, RUST_LOG: 'debug' },
    stdio: 'ignore',
  })
  const prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: `file:${databasePath}` }),
  })
  await prisma.$connect()
  t.after(async () => {
    await prisma.$disconnect()
    await fs.promises.rm(databasePath, { force: true })
    await fs.promises.rm(root, { force: true, recursive: true })
  })
  return { prisma, root }
}

function user(text, time) {
  return {
    content: [{ data: { text }, type: 'text' }],
    from_user_id: 'u1',
    role: 'user',
    text,
    time,
  }
}

function assistant(text, time) {
  return {
    content: [{ data: { text }, type: 'text' }],
    role: 'assistant',
    text,
    time,
  }
}

test('DatabaseMemoryStore preserves the MemoryStore contract and archive semantics', async t => {
  const { prisma } = await createFixture(t)
  const memory = new DatabaseMemoryStore({ agentId: 'agent-db', prisma })

  await memory.ensure()
  await memory.writeSoul('database soul')
  await memory.writeGlobal('profile', 'first\n')
  await memory.addGlobal('profile', 'second')
  await memory.updateGlobal('profile', 'first', 'changed')
  await memory.setAgentMeta('tools', ['search'])
  const session = await memory.createSession({ createdAt: 1000, id: 'session-db', title: 'DB' })
  await memory.setActiveSession(session.id)

  await Promise.all([
    memory.appendToChat(session.id, user('one', 2000)),
    memory.appendToChat(session.id, assistant('one answer', 3000)),
    memory.appendToChat(session.id, user('two', 4000)),
    memory.appendToChat(session.id, assistant('two answer', 5000)),
  ])
  const canonicalRow = await prisma.message.findFirst({ orderBy: { seq: 'asc' }, where: { sessionId: session.id } })
  await prisma.message.update({
    data: {
      legacyJson: JSON.stringify({
        content: [{ data: { text: 'stale legacy' }, type: 'text' }],
        role: 'assistant',
        text: 'stale legacy',
      }),
    },
    where: { id: canonicalRow.id },
  })
  assert.equal((await memory.getChat(session.id))[0].text, 'one')

  await memory.setCrystal(session.id, '<memory_crystal>db</memory_crystal>')
  await memory.appendPendingMemory(session.id, { kind: 'fact' })

  assert.equal(await memory.readSoul(), 'database soul')
  assert.equal(await memory.readGlobal('profile'), 'changed\nsecond\n')
  assert.deepEqual(await memory.getAgentMeta('tools'), ['search'])
  assert.equal(await memory.getActiveSession(), session.id)
  assert.equal((await memory.getSession(session.id)).created_at, 1000)
  assert.equal((await memory.getChat(session.id)).length, 4)
  assert.equal((await memory.getPendingMemories(session.id))[0].kind, 'fact')

  const rotation = await memory.rotateChat(session.id, 1)
  assert.equal(rotation.rotated, true)
  assert.equal(rotation.removedCount, 2)
  assert.equal((await memory.getChat(session.id)).length, 2)
  assert.equal(await prisma.message.count({ where: { archiveId: { not: null } } }), 2)

  await memory.createSession({ id: 'session-concurrent' })
  await Promise.all(Array.from({ length: 100 }, (_, index) => memory.appendToChat(
    'session-concurrent',
    { role: 'system', text: `message-${index}`, time: 10_000 + index },
  )))
  const concurrentRows = await prisma.message.findMany({
    orderBy: { seq: 'asc' },
    where: { sessionId: 'session-concurrent' },
  })
  assert.deepEqual(concurrentRows.map(row => row.seq), Array.from({ length: 100 }, (_, index) => index))
})

test('streaming lifecycle finalizes tool projections and recovers interrupted messages', async t => {
  const { prisma } = await createFixture(t)
  const memory = new DatabaseMemoryStore({ agentId: 'agent-stream', prisma })
  await memory.createSession({ id: 'session-stream' })

  const finalizedId = await memory.beginAssistantMessage('session-stream')
  await memory.appendAssistantChunk(finalizedId, 'text', { text: 'done' })
  await memory.finalizeAssistantMessage(finalizedId, {
    content: [{
      data: { arguments: { q: 'one' }, name: 'search', result: { ok: true }, status: 'success' },
      type: 'tool_call',
    }],
    role: 'assistant',
    text: 'done',
    time: 3000,
  })
  const interruptedId = await memory.beginAssistantMessage('session-stream', { text: 'partial' })
  await memory.appendAssistantChunk(interruptedId, 'semantic_block', { text: 'partial answer' })

  assert.equal(await memory.recoverInterruptedMessages(), 1)
  assert.equal((await prisma.message.findUnique({ where: { id: finalizedId } })).status, 'final')
  assert.equal((await prisma.message.findUnique({ where: { id: interruptedId } })).status, 'aborted_by_restart')
  assert.equal(await prisma.messageChunk.count({ where: { messageId: finalizedId } }), 1)
  assert.equal(await prisma.toolCall.count({ where: { messageId: finalizedId } }), 1)
  const recovered = (await memory.getChat('session-stream')).at(-1)
  assert.equal(recovered.persistence_status, 'aborted_by_restart')
  assert.equal(recovered.text, 'partial answer')
})

test('shadow and database-shadow keep legacy and database representations aligned', async t => {
  const { prisma, root } = await createFixture(t)
  const legacy = new MemoryStore({ agentId: 'agent-shadow', baseDir: path.join(root, 'memory') })
  const shadow = new SessionPersistence({
    agentId: 'agent-shadow',
    legacyStore: legacy,
    mode: 'shadow',
    prisma,
  })

  await shadow.ensure()
  await shadow.writeSoul('shadow soul')
  await shadow.writeGlobal('general', 'shadow global\n')
  await shadow.createSession({ createdAt: 1000, id: 'session-shadow', title: 'Shadow' })
  await shadow.setActiveSession('session-shadow')
  await shadow.appendToChat('session-shadow', user('hello', 2000))
  const messageId = await shadow.beginAssistantMessage('session-shadow')
  await shadow.finalizeAssistantMessage(messageId, assistant('world', 3000))

  const database = new DatabaseMemoryStore({ agentId: 'agent-shadow', prisma })
  assert.deepEqual(await database.getSession('session-shadow'), await legacy.getSession('session-shadow'))
  assert.equal(await database.readSoul(), await legacy.readSoul())
  assert.equal(await database.readGlobal('general'), await legacy.readGlobal('general'))

  const dbPrimary = new SessionPersistence({
    agentId: 'agent-shadow',
    legacyStore: legacy,
    mode: 'database-shadow',
    prisma,
  })
  await dbPrimary.appendToChat('session-shadow', user('again', 4000))
  assert.deepEqual(await database.getSession('session-shadow'), await legacy.getSession('session-shadow'))
})

test('BaseChannel persists user and assistant placeholder before invoking the LLM', async t => {
  const { prisma } = await createFixture(t)
  const memory = new SessionPersistence({ agentId: 'agent-channel', mode: 'database', prisma })
  await memory.ensure()
  await memory.createSession({ id: 'session-channel' })

  const observed = []
  const observedMessageTimes = []
  const channel = new BaseChannel({
    client: { botId: 'bot' },
    llm: {
      process: async context => {
        observedMessageTimes.push(context.messageTime)
        const rows = await prisma.message.findMany({ orderBy: { seq: 'asc' } })
        observed.push(rows.map(row => `${row.role}:${row.status}`))
        await context.onEmitTextBlock('semantic answer')
        return {
          content: [{ data: { text: 'semantic answer' }, type: 'text' }],
          text: 'semantic answer',
        }
      },
    },
    masterId: 'master',
    memory,
  })

  await channel._processChat('persist first', {
    channelId: 'channel-db',
    from: 'user-db',
    isWeb: true,
    messageId: 'assistant-db',
    messageTime: 123_456,
    sid: 'session-channel',
  })

  assert.deepEqual(observed, [['user:final', 'assistant:streaming']])
  assert.deepEqual(observedMessageTimes, [123_456])
  const rows = await prisma.message.findMany({ orderBy: { seq: 'asc' } })
  assert.deepEqual(rows.map(row => `${row.role}:${row.status}`), ['user:final', 'assistant:final'])
  assert.equal(rows[0].businessTime.getTime(), 123_456)
  assert.equal(rows[0].legacyJson, null)
  assert.equal(rows[1].legacyJson, null)
  assert.equal(await prisma.messageChunk.count({ where: { messageId: 'assistant-db' } }), 1)
})

test('mirror failure policy preserves legacy availability and stops database-shadow silently diverging', async () => {
  const logger = { error() {} }
  const legacyMessages = []
  const legacyPrimary = {
    agentId: 'agent-policy',
    appendToChat: async (sessionId, message) => { legacyMessages.push({ message, sessionId }) },
    readSoul: async () => 'legacy',
    writeSoul: async () => true,
  }
  const brokenDatabaseMirror = {
    writeSoul: async () => { throw new Error('database unavailable') },
  }
  const shadow = new SessionPersistence({
    agentId: 'agent-policy',
    databaseStore: brokenDatabaseMirror,
    legacyStore: legacyPrimary,
    logger,
    mode: 'shadow',
  })
  assert.equal(await shadow.writeSoul('still available'), true)
  const draftId = await shadow.beginAssistantMessage('session-policy')
  await shadow.finalizeAssistantMessage(draftId, assistant('legacy final', 1000))
  assert.equal(legacyMessages.length, 1)

  const finalizationFailure = new SessionPersistence({
    agentId: 'agent-policy',
    databaseStore: {
      beginAssistantMessage: async () => 'database-draft',
      finalizeAssistantMessage: async () => { throw new Error('finalize unavailable') },
    },
    legacyStore: legacyPrimary,
    logger,
    mode: 'shadow',
  })
  const databaseDraft = await finalizationFailure.beginAssistantMessage('session-policy')
  await finalizationFailure.finalizeAssistantMessage(databaseDraft, assistant('legacy survives', 2000))
  assert.equal(legacyMessages.length, 2)

  const databasePrimary = { writeSoul: async () => true }
  const brokenLegacyMirror = {
    agentId: 'agent-policy',
    writeSoul: async () => { throw new Error('filesystem unavailable') },
  }
  const databaseShadow = new SessionPersistence({
    agentId: 'agent-policy',
    databaseStore: databasePrimary,
    legacyStore: brokenLegacyMirror,
    logger,
    mode: 'database-shadow',
  })
  await assert.rejects(
    databaseShadow.writeSoul('must alert'),
    error => error instanceof PersistenceMirrorError && error.method === 'writeSoul',
  )
})

test('ChannelStore mirrors configuration without retaining plaintext tokens in database legacy JSON', async t => {
  const { prisma, root } = await createFixture(t)
  const file = path.join(root, 'channels.json')
  const encryptionKey = '44'.repeat(32)
  const shadow = new ChannelStore({ encryptionKey, file, mode: 'shadow', prisma })

  const created = await shadow.create({
    agentId: 'agent-channel-store',
    config: { receive_mode: 'manual' },
    name: 'Mirror',
    platform: 'qq',
    protocol: 'onebot.v12',
    token: 'secret',
  })
  await shadow.update(created.id, { status: 'running' })
  const row = await prisma.channel.findUnique({ where: { id: created.id } })
  assert.equal(JSON.parse(row.legacyJson).token, undefined)
  assert.equal(row.status, 'running')

  const database = new ChannelStore({ encryptionKey, file, mode: 'database', prisma })
  const restored = await database.get(created.id)
  assert.equal(restored.token, 'secret')
  assert.equal(restored.platform, 'qq')
  assert.equal(restored.protocol, 'onebot.v12')
  assert.deepEqual(restored.config, { receive_mode: 'manual' })

  const databaseShadow = new ChannelStore({ encryptionKey, file, mode: 'database-shadow', prisma })
  await databaseShadow.update(created.id, { model: 'new-model' })
  const legacy = JSON.parse(await fs.promises.readFile(file, 'utf8'))
  assert.equal(legacy[0].model, 'new-model')
})

test('database startup restores running channels from the database rather than stale legacy JSON', async t => {
  const { prisma, root } = await createFixture(t)
  const file = path.join(root, 'channels-data/channels.json')
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  await fs.promises.writeFile(file, JSON.stringify([{
    agentId: 'agent-restore',
    id: 'stale-json-channel',
    status: 'running',
    token: 'stale',
    userId: 'stale-user',
  }]))

  const store = new ChannelStore({ encryptionKey: '55'.repeat(32), file, mode: 'database', prisma })
  const created = await store.create({
    agentId: 'agent-restore',
    name: 'Database channel',
    status: 'running',
    token: 'database-token',
    userId: 'database-user',
  })
  const started = []
  const result = await restoreRunningChannels({
    channelStore: store,
    start: async id => started.push(id),
  }, { info() {}, warn() {} })

  assert.deepEqual(started, [created.id])
  assert.equal(result.discovered, 1)
  assert.equal(result.restored, 1)
})

test('database TriggerRegistry keeps metadata and execution audit in Prisma while scripts stay as files', async t => {
  const { prisma, root } = await createFixture(t)
  await prisma.agent.create({ data: { id: 'agent-trigger-db' } })
  await prisma.session.create({ data: { agentId: 'agent-trigger-db', id: 'session-trigger-db' } })
  const dataDir = path.join(root, 'channels-data/triggers')
  const registry = new TriggerRegistry({ dataDir, mode: 'database', prisma })

  const created = await registry.create({
    agentId: 'agent-trigger-db',
    id: 'trigger-db',
    scriptCode: 'console.log("@WAKE@ {}")\n',
    sessionId: 'session-trigger-db',
    type: 'script',
  })
  assert.equal((await registry.list()).length, 1)
  assert.equal(await prisma.trigger.count(), 1)
  assert.equal(fs.existsSync(path.join(dataDir, 'triggers.json')), false)
  assert.equal(fs.existsSync(created.scriptPath), true)

  await registry.update(created.id, { fireCount: 2, lastFiredAt: 1234, wakeCount: 1 })
  const updated = await registry.get(created.id)
  assert.equal(updated.fireCount, 2)
  assert.equal(updated.lastFiredAt, 1234)
  await registry.recordExecution({ data: { ok: true }, triggerId: created.id, wake: true })
  assert.deepEqual((await registry.listExecutions(created.id))[0].data, { ok: true })

  assert.equal(await registry.remove(created.id), true)
  assert.equal(await registry.get(created.id), null)
  assert.equal(await prisma.triggerExecution.count(), 1)
  assert.equal(fs.existsSync(created.scriptPath), false)
})
