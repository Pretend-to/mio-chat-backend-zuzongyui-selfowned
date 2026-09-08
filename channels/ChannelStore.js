import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import prismaManager from '../lib/database/prisma.js'
import {
  decryptToken,
  encryptToken,
  parseEncryptionKey,
} from '../lib/chat/persistence/TokenCipher.js'

/**
 * ChannelStore — 渠道配置持久化（管理面板后端的存储端）
 *
 * 数据文件：<file>（默认 channels-data/channels.json），JSON 数组。
 * 每个渠道：
 *   {
 *     id,            // 唯一 id（如 c_xxx）
 *     name,          // bot 显示名
 *     type,          // runtime，当前为 'onebots'；旧 'wechat' 自动兼容
 *     platform,      // OneBots adapter，如 'wechat-clawbot'
 *     protocol,      // 协议标识，如 'onebot.v12'
 *     config,        // adapter 扩展配置
 *     agentId,       // 归属 agent（决定 memory/agents/<id> 与预设）默认 'wechat-master'
 *     token,         // bot_token（敏感，落盘）
 *     botId, userId, // iLink 登录返回的 bot 账户 id / 绑定者微信 id
 *     avatar,        // 头像链接（可选）
 *     status,        // 'unbound' | 'running' | 'stopped' | 'expired'
 *     lastActive,    // 最近消息活跃时间戳
 *     createdAt, updatedAt
 *   }
 */
const UTF8 = 'utf-8'
const DEFAULT_FILE = 'channels-data/channels.json'

export class ChannelStore {
  constructor({
    encryptionKey = process.env.MIOCHAT_ENC_KEY,
    file = DEFAULT_FILE,
    logger = console,
    mode = process.env.MIO_CHANNEL_PERSISTENCE_MODE || 'legacy',
    prisma = null,
  } = {}) {
    if (!['legacy', 'shadow', 'database-shadow', 'database'].includes(mode)) {
      throw new Error(`invalid channel persistence mode ${mode}`)
    }
    this.file = file
    this.encryptionKey = encryptionKey
    this.logger = logger
    this.mode = mode
    this.prisma = prisma
    this._cache = null
  }

  async _database() {
    if (!this.prisma) this.prisma = await prismaManager.initialize()
    return this.prisma
  }

  _key(required = false) {
    if (!required && !this.encryptionKey) return null
    return Buffer.isBuffer(this.encryptionKey)
      ? this.encryptionKey
      : parseEncryptionKey(this.encryptionKey)
  }

  async _load() {
    if (this._cache) return this._cache
    try {
      const raw = await fs.promises.readFile(this.file, UTF8)
      this._cache = raw && raw.trim() ? JSON.parse(raw.trim()) : []
    } catch (e) {
      if (e.code === 'ENOENT') {
        this._cache = []
      } else if (e instanceof SyntaxError) {
        console.error(`[ChannelStore] JSON parse error in ${this.file}: ${e.message}. Fallback to [].`)
        this._cache = []
      } else {
        throw e
      }
    }
    return this._cache
  }
  async _save() {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true })
    const tmpFile = `${this.file}.${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`
    await fs.promises.writeFile(tmpFile, JSON.stringify(this._cache ?? [], null, 2), UTF8)
    await fs.promises.rename(tmpFile, this.file)
  }
  _public(c) {
    // 脱敏对外：token 不返回明文
    const { token, ...rest } = c
    return { ...rest, hasToken: !!token }
  }

  _fromDatabase(row) {
    let legacy = {}
    try {
      legacy = row.legacyJson ? JSON.parse(row.legacyJson) : {}
    } catch (error) {
      this.logger?.warn?.(`[ChannelStore] invalid legacy_json for ${row.id}: ${error.message}`)
    }
    return {
      ...legacy,
      agentId: row.agentId,
      avatar: row.avatar || '',
      botId: row.botId || '',
      createdAt: row.createdAt.getTime(),
      id: row.id,
      lastActive: row.lastActive?.getTime() || 0,
      model: row.model || '',
      name: row.name || '',
      provider: row.provider || '',
      status: row.status,
      token: row.tokenEnc ? decryptToken(row.tokenEnc, this._key(true)) : '',
      type: row.type,
      updatedAt: row.updatedAt.getTime(),
      userId: row.userId || '',
    }
  }

  async _listDatabase() {
    const prisma = await this._database()
    const rows = await prisma.channel.findMany({ orderBy: { createdAt: 'asc' } })
    return rows.map(row => this._fromDatabase(row))
  }

  async _getDatabase(id) {
    const prisma = await this._database()
    const row = await prisma.channel.findUnique({ where: { id } })
    return row ? this._fromDatabase(row) : null
  }

  async _writeDatabase(channel) {
    const prisma = await this._database()
    const tokenEnc = channel.token ? encryptToken(channel.token, this._key(true)) : null
    await prisma.agent.upsert({ create: { id: channel.agentId }, update: {}, where: { id: channel.agentId } })
    const legacyJson = { ...channel }
    delete legacyJson.token
    const data = {
      agentId: channel.agentId,
      avatar: channel.avatar || null,
      botId: channel.botId || null,
      lastActive: channel.lastActive ? new Date(channel.lastActive) : null,
      legacyJson: JSON.stringify(legacyJson),
      model: channel.model || null,
      name: channel.name || null,
      provider: channel.provider || null,
      status: channel.status || 'unbound',
      tokenEnc,
      type: channel.type || 'onebots',
      updatedAt: new Date(channel.updatedAt),
      userId: channel.userId || null,
    }
    await prisma.channel.upsert({
      create: { ...data, createdAt: new Date(channel.createdAt), id: channel.id },
      update: data,
      where: { id: channel.id },
    })
    return channel
  }

  async _removeDatabase(id) {
    const prisma = await this._database()
    return (await prisma.channel.deleteMany({ where: { id } })).count > 0
  }

  async _mirror(method, action) {
    try {
      return await action()
    } catch (error) {
      this.logger?.error?.(`[ChannelStore] ${this.mode} ${method} mirror failed: ${error.message}`)
      if (this.mode === 'database-shadow') throw error
      return null
    }
  }

  /** Internal, non-redacted list used by ChannelRuntime during startup. */
  async listInternal() {
    return this.mode === 'database' || this.mode === 'database-shadow'
      ? await this._listDatabase()
      : await this._load()
  }

  async list() {
    const list = await this.listInternal()
    return list.map((c) => this._public(c))
  }
  async get(id) {
    const found = this.mode === 'database' || this.mode === 'database-shadow'
      ? await this._getDatabase(id)
      : (await this._load()).find((c) => c.id === id)
    return found ? found : null
  }
  async getPublic(id) {
    const c = await this.get(id)
    return c ? this._public(c) : null
  }
  async create(data = {}) {
    const list = this.mode === 'database' || this.mode === 'database-shadow'
      ? await this._listDatabase()
      : await this._load()
    const now = Date.now()
    const channel = {
      agentId: 'wechat-master', // 默认归属
      avatar: '',
      botId: '',
      createdAt: now,
      id: `c_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`,
      name: data.name || '渠道助手',
      status: 'unbound',
      token: '',
      type: 'onebots',
      platform: 'wechat-clawbot',
      protocol: 'onebot.v12',
      provider: data.provider || '',
      model: data.model || '',
      updatedAt: now,
      userId: '',
      lastActive: 0,
      ...data,
    }
    list.push(channel)
    this._cache = list
    if (this.mode === 'database' || this.mode === 'database-shadow') {
      await this._writeDatabase(channel)
      if (this.mode === 'database-shadow') await this._mirror('create', () => this._save())
    } else {
      await this._save()
      if (this.mode === 'shadow') await this._mirror('create', () => this._writeDatabase(channel))
    }
    return this._public(channel)
  }
  async update(id, patch = {}) {
    const list = this.mode === 'database' || this.mode === 'database-shadow'
      ? await this._listDatabase()
      : await this._load()
    const ch = list.find((c) => c.id === id)
    if (!ch) return null
    Object.assign(ch, patch, { updatedAt: Date.now() })
    this._cache = list
    if (this.mode === 'database' || this.mode === 'database-shadow') {
      await this._writeDatabase(ch)
      if (this.mode === 'database-shadow') await this._mirror('update', () => this._save())
    } else {
      await this._save()
      if (this.mode === 'shadow') await this._mirror('update', () => this._writeDatabase(ch))
    }
    return this._public(ch)
  }
  async remove(id) {
    const list = this.mode === 'database' || this.mode === 'database-shadow'
      ? await this._listDatabase()
      : await this._load()
    const next = list.filter((c) => c.id !== id)
    if (next.length === list.length) return false
    this._cache = next
    if (this.mode === 'database' || this.mode === 'database-shadow') {
      await this._removeDatabase(id)
      if (this.mode === 'database-shadow') await this._mirror('remove', () => this._save())
    } else {
      await this._save()
      if (this.mode === 'shadow') await this._mirror('remove', () => this._removeDatabase(id))
    }
    return true
  }
}

export default ChannelStore
