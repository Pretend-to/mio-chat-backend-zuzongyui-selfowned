import { EventEmitter } from 'node:events'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OneBotChannel, extractMedia, extractText } from '../../channels/onebots/OneBotChannel.js'

function makeMemory() {
  const values = new Map()
  return {
    agentId: 'onebot-test',
    async getAgentMeta(key, fallback = null) { return values.has(key) ? values.get(key) : fallback },
    async setAgentMeta(key, value) { values.set(key, value) },
    async getActiveSession() { return 'session-1' },
  }
}

function makeClient() {
  const client = new EventEmitter()
  client.private = []
  client.group = []
  client.typing = []
  client.started = 0
  client.stopped = 0
  client.start = async () => { client.started++ }
  client.stop = async () => { client.stopped++ }
  client.sendPrivateMessage = async (id, message) => { client.private.push({ id, message }); return 'private-ok' }
  client.sendGroupMessage = async (id, message) => { client.group.push({ id, message }); return 'group-ok' }
  client.call = async (action, params) => { client.typing.push({ action, params }); return 'typing-ok' }
  return client
}

function makeChannel(client = makeClient()) {
  const channel = new OneBotChannel({
    client,
    memory: makeMemory(),
    masterId: 'master',
    llm: { process: async () => ({ text: '' }) },
    debounceEnabled: false,
  })
  return { channel, client }
}

test('OneBot V12 extracts text and common media segments', () => {
  const msg = {
    content: [
      { type: 'text', data: { text: 'hello' } },
      { type: 'image', data: { url: 'https://example.test/a.png' } },
      { type: 'file', data: { file: '/tmp/a.pdf', name: 'a.pdf' } },
      { type: 'video', data: { file: 'base64://video' } },
      { type: 'audio', data: { url: 'https://example.test/a.mp3' } },
    ],
  }
  assert.equal(extractText(msg), 'hello')
  assert.deepEqual(extractMedia(msg), {
    images: ['https://example.test/a.png'],
    files: [
      { name: 'a.pdf', type: 'file', url: '/tmp/a.pdf' },
      { name: 'video', type: 'video', url: 'base64://video' },
      { name: 'a.mp3', type: 'audio', url: 'https://example.test/a.mp3' },
    ],
  })
})

test('OneBot subscriptions and lifecycle are idempotent', async () => {
  const { channel, client } = makeChannel()
  const packets = []
  channel.enqueueInboundDebounce = async (from, packet) => { packets.push({ from, packet }) }

  await Promise.all([channel.start(), channel.start()])
  assert.equal(client.started, 1)
  assert.equal(client.listenerCount('message.private'), 1)
  assert.equal(client.listenerCount('message.group'), 1)
  client.emit('message.private', { message_type: 'private', user_id: 'master', content: [{ type: 'text', data: { text: 'hi' } }] })
  client.emit('message.private', { message_type: 'private', user_id: 'other', content: [{ type: 'text', data: { text: 'ignore' } }] })
  client.emit('message.group', { message_type: 'group', user_id: 'member', group_id: '42', content: [{ type: 'text', data: { text: 'group hi' } }] })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(packets.length, 2)
  assert.equal(packets[0].from, 'master')
  assert.equal(packets[1].from, 'group:42')

  await Promise.all([channel.stop(), channel.stop()])
  assert.equal(client.stopped, 1)
  assert.equal(client.listenerCount('message.private'), 0)
  assert.equal(client.listenerCount('message.group'), 0)
})

test('OneBot drops concurrent redelivery of the same message id', async () => {
  const { channel } = makeChannel()
  const packets = []
  let release
  const firstPending = new Promise((resolve) => { release = resolve })
  channel.enqueueInboundDebounce = async (from, packet) => {
    packets.push({ from, packet })
    await firstPending
  }

  const event = {
    detail_type: 'private',
    message_id: 'msg-redelivered',
    user_id: 'master',
    message: [{ type: 'text', data: { text: '你好' } }],
  }
  const first = channel.handleIncomingMessage(event, 'private')
  const duplicate = channel.handleIncomingMessage({ ...event }, 'private')

  await duplicate
  assert.equal(packets.length, 1)
  assert.equal(packets[0].packet.text, '你好')
  release()
  await first
})

test('OneBot sends text/media through typed SDK methods and typing action', async () => {
  const { channel, client } = makeChannel()
  await channel.doSendMessage(channel.buildSendMsg({ to: 'master', text: 'hello' }))
  await channel.doSendMessage(channel.buildSendMsg({ to: 'group:42', text: 'hello group' }))
  await channel.doSendImage({ to: 'master', buffer: Buffer.from('image') })
  await channel.doSendFile({ to: 'group:42', fileName: 'a.txt', url: 'https://example.test/a.txt' })
  await channel.doSendVideo({ to: 'group:42', localPath: '/tmp/a.mp4' })
  await channel.doSendTyping({ from: 'master', contextToken: 'ctx' }, 1)
  await channel.doSendTyping({ from: 'master', contextToken: 'ctx' }, 2)

  assert.equal(client.private.length, 2)
  assert.equal(client.private[0].message[0].data.text, 'hello')
  assert.equal(client.private[1].message[0].data.file, 'base64://aW1hZ2U=')
  assert.equal(client.group.length, 3)
  assert.equal(client.group[0].id, '42')
  assert.deepEqual(client.typing.map((entry) => entry.params), [
    { user_id: 'master', context_token: 'ctx', status: 'active' },
    { user_id: 'master', context_token: 'ctx', status: 'idle' },
  ])
})
