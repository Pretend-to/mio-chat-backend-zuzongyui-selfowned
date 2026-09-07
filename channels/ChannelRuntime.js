import { IlinkClient } from './wechat/IlinkClient.js'
import { createSessionPersistence } from '../lib/chat/persistence/createSessionPersistence.js'
import { WechatChannel } from './wechat/WechatChannel.js'
import { createBackendLlm } from './wechat/llm.js'
import { isOneBotsChannel } from './onebots/config.js'

/**
 * ChannelRuntime — 渠道运行时管理器（M6 后端）
 *
 * 职责：把「已绑定的渠道配置」拉起为真实运行的 WechatChannel（长轮询），
 *       并统一管理启/停 / 运行态。
 * 解耦：llm 可注入（默认 createBackendLlm）；client 可注入（测试用 mock）。
 */
export class ChannelRuntime {
  /**
   * @param {object} opts
   * @param {import('./ChannelStore.js').ChannelStore} opts.channelStore 渠道配置存储
   * @param {object} [opts.llm]  llmProcessor（默认 createBackendLlm）
   * @param {string} [opts.memoryBase] memory 根目录（默认 'memory'）
   * @param {(channel)=>object} [opts.clientFactory] 自定义 client 工厂（测试注入 mock）
   * @param {object} [opts.onebotsGateway] OneBots 网关（可注入，默认按需加载）
   * @param {(options)=>object|Promise<object>} [opts.onebotChannelFactory] OneBotChannel 工厂
   */
  constructor({
    channelStore,
    clientFactory,
    onebotsGateway = null,
    onebotChannelFactory = null,
    llm,
    memoryBase = 'memory',
    persistenceFactory = createSessionPersistence,
    persistenceMode = process.env.MIO_CHANNEL_PERSISTENCE_MODE || 'legacy',
    prisma = null,
  } = {}) {
    if (!channelStore) throw new Error('ChannelRuntime requires channelStore')
    this.channelStore = channelStore
    this.llm = llm || createBackendLlm()
    this.memoryBase = memoryBase
    this.clientFactory = clientFactory
    this.onebotsGateway = onebotsGateway
    this.onebotChannelFactory = onebotChannelFactory
    this._onebotsInitialized = false
    this.persistenceFactory = persistenceFactory
    this.persistenceMode = persistenceMode
    this.prisma = prisma
    this.running = new Map() // channelId -> { channel, chn, memory }
  }

  /** OneBots 渠道判定。没有显式 driver 的旧微信配置始终走 iLink。 */
  static isOneBotsChannel(channel) {
    return isOneBotsChannel(channel)
  }

  isOneBotsChannel(channel) {
    return ChannelRuntime.isOneBotsChannel(channel)
  }

  /**
   * Resolve the optional gateway only when a OneBots channel is actually used.
   * This keeps installations without OneBots (and the legacy iLink path) lazy.
   */
  async getOnebotsGateway({ initialize = false } = {}) {
    if (!this.onebotsGateway) {
      const mod = await import('./onebots/OneBotsGateway.js')
      const Gateway = mod.OneBotsGateway || mod.default
      if (typeof Gateway === 'function') this.onebotsGateway = new Gateway()
      else if (Gateway) this.onebotsGateway = Gateway
    }
    if (!this.onebotsGateway) {
      throw new Error('OneBots gateway is not available')
    }
    if (initialize && !this._onebotsInitialized) {
      if (typeof this.onebotsGateway.init === 'function') {
        await this.onebotsGateway.init()
      }
      this._onebotsInitialized = true
    }
    return this.onebotsGateway
  }

  async getOnebotChannelFactory() {
    if (this.onebotChannelFactory) return this.onebotChannelFactory
    const mod = await import('./onebots/OneBotChannel.js')
    const OneBotChannel = mod.OneBotChannel || mod.default
    if (typeof OneBotChannel !== 'function') {
      throw new Error('OneBotChannel is not available')
    }
    this.onebotChannelFactory = (options) => new OneBotChannel(options)
    return this.onebotChannelFactory
  }

  /** Initialize the optional OneBots gateway. Legacy restoreRunningChannels remains supported. */
  async init() {
    const channels = typeof this.channelStore.listInternal === 'function'
      ? await this.channelStore.listInternal()
      : []
    const onebots = channels.filter((channel) => this.isOneBotsChannel(channel))
    if (onebots.length > 0) await this.getOnebotsGateway({ initialize: true })

    // Restore OneBots entries here because the legacy restore helper requires an iLink token.
    // Existing callers may still invoke restoreRunningChannels for iLink channels.
    for (const channel of onebots) {
      if (channel.status !== 'running' || (!channel.userId && !channel.botId)) continue
      try { await this.start(channel.id) } catch (error) {
        console.warn(`[ChannelRuntime] OneBots 渠道 "${channel.id}" 恢复失败: ${error.message}`)
        await this.channelStore.update(channel.id, { status: 'stopped' })
      }
    }
    return this
  }

  async dispose() {
    await this.stopAll()
    if (this.onebotsGateway && typeof this.onebotsGateway.dispose === 'function') {
      await this.onebotsGateway.dispose()
    }
    this._onebotsInitialized = false
  }

  async createMemory(agentId, { recover = false } = {}) {
    const memory = await this.persistenceFactory({
      agentId,
      baseDir: this.memoryBase,
      mode: this.persistenceMode,
      prisma: this.prisma,
    })
    await memory.ensure()
    if (recover) {
      const recovered = await memory.recoverInterruptedMessages()
      if (recovered > 0) {
        console.warn(`[ChannelRuntime] recovered ${recovered} interrupted message(s) for ${agentId}`)
      }
    }
    return memory
  }

  /** 启动一个已绑定渠道 */
  async start(channelId) {
    const channel = await this.channelStore.get(channelId)
    if (!channel) throw new Error(`channel ${channelId} not found`)
    const onebots = this.isOneBotsChannel(channel)
    if (onebots ? (!channel.userId && !channel.botId) : (!channel.token || !channel.userId)) {
      throw new Error(`channel ${channelId} not bound`)
    }
    if (this.running.has(channelId)) return this.running.get(channelId).chn

    const agentId = channel.agentId || 'wechat-master'
    const memory = await this.createMemory(agentId, { recover: true })
    let client
    let gateway = null
    try {
      if (onebots) {
        gateway = await this.getOnebotsGateway({ initialize: true })
        await gateway.startAccount(channel)
        if (typeof gateway.createClient !== 'function') {
          throw new Error('OneBots gateway does not provide createClient(channel)')
        }
        client = await gateway.createClient(channel)
      } else {
        client = this.clientFactory
          ? await this.clientFactory(channel)
          : (() => {
            const c = new IlinkClient()
            c.setAuth({ token: channel.token, botId: channel.botId, userId: channel.userId })
            return c
          })()
      }
      const savedProvider = await memory.getAgentMeta('provider', channel.provider || null)
      const savedModel = await memory.getAgentMeta('model', channel.model || null)

      const commonOptions = {
        channelId,
        id: channelId,
        client,
        memory,
        masterId: channel.userId || channel.botId || channelId,
        llm: this.llm,
        provider: savedProvider,
        model: savedModel,
        logger: console,
        onActivity: () => {
          this.channelStore.update(channelId, { lastActive: Date.now() }).catch(() => {})
        },
      }
      let chn
      if (onebots) {
        const factory = await this.getOnebotChannelFactory()
        chn = await factory({ ...commonOptions, channel, gateway })
      } else {
        chn = new WechatChannel(commonOptions)
      }
      await chn.start()
      this.running.set(channelId, { channel, chn, memory, gateway, onebots })
      await this.channelStore.update(channelId, { status: 'running' })
      return chn
    } catch (error) {
      // A partially started embedded account otherwise keeps polling even
      // though no Channel instance owns it.
      if (onebots && gateway?.stopAccount) {
        await gateway.stopAccount(channelId).catch(() => {})
      }
      throw error
    }
  }

  /** 停止渠道（停止长轮询 + notifyStop + 状态落 stopped） */
  async stop(channelId) {
    const entry = this.running.get(channelId)
    let channel = entry?.channel
    if (!channel) channel = await this.channelStore.get(channelId)
    let firstError = null
    if (entry) {
      try { await entry.chn.stop() } catch (error) { firstError = error }
      this.running.delete(channelId)
    }
    if (entry?.onebots || this.isOneBotsChannel(channel)) {
      try {
        // A never-started account has no gateway lifecycle to tear down. Avoid
        // loading the optional dependency merely to mark such a channel stopped.
        const gateway = entry?.gateway || this.onebotsGateway
        if (gateway && typeof gateway.stopAccount === 'function') await gateway.stopAccount(channelId)
      } catch (error) { if (!firstError) firstError = error }
    }
    await this.channelStore.update(channelId, { status: 'stopped' })
    if (firstError) throw firstError
  }

  async stopAll() {
    for (const id of this.running.keys()) await this.stop(id)
  }

  isRunning(channelId) {
    return this.running.has(channelId)
  }
  runningIds() {
    return [...this.running.keys()]
  }
}

export default ChannelRuntime
