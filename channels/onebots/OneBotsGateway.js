import fs from 'node:fs'
import path from 'node:path'

import {
  ONEBOTS_PORT,
  ONEBOTS_RECEIVE_MODE,
  ONEBOTS_PROTOCOL,
  createLoopbackUrl,
  createProtocolConfig,
} from './config.js'
import defaultLogger from '../../utils/logger.js'

const asError = value => value instanceof Error ? value : new Error(String(value))
const INBOUND_METADATA_MAX_SIZE = 256

/**
 * Small, process-local facade around OneBots BaseApp.
 *
 * It intentionally uses BaseApp instead of onebots' full App: constructing
 * App installs the management UI and intercepts stdout.  No HTTP server is
 * started here either; OneBot V12 is connected to clients through the
 * protocol instance directly.
 */
export class OneBotsGateway {
  constructor(options = {}) {
    this.options = options
    this.app = options.app ?? null
    this.appFactory = options.appFactory ?? null
    this.clientFactory = options.clientFactory ?? null
    this.logger = options.logger ?? defaultLogger
    this.accounts = new Map()
    this.qrSessions = new Map()
    this.initialized = false
    this.disposed = false
    this.initPromise = null
    this.disposePromise = null
  }

  async init(options = {}) {
    if (this.disposed) throw new Error('OneBotsGateway has been disposed')
    if (this.initialized) return this.app
    if (this.initPromise) return this.initPromise

    this.initPromise = (async () => {
      if (!this.app) {
        const appConfig = {
          // BaseApp is never started by this facade. Keep the values explicit
          // so an injected host can inspect the intended loopback policy.
          port: options.port ?? ONEBOTS_PORT,
          host: '127.0.0.1',
          log_level: options.logLevel ?? (process.env.LOG_LEVEL || 'info').toLowerCase(),
          general: {},
        }
        if (this.appFactory) {
          this.app = await this.appFactory(appConfig)
        } else {
          const { BaseApp } = await import('onebots')
          const runtimeDir = path.resolve(
            options.dataDir ??
            this.options.dataDir ??
            process.env.ONEBOTS_DATA_DIR ??
            'channels-data/onebots',
          )
          await fs.promises.mkdir(runtimeDir, { recursive: true })
          BaseApp.configDir = runtimeDir
          BaseApp.configFileName = 'config.yaml'
          this.app = new BaseApp(appConfig)
        }
      }

      // The protocol is fixed at the MioChat boundary. Concrete platform
      // adapters are loaded lazily by ensurePlatformAdapter().
      if (!this.options.skipRegistration) {
        await import('@onebots/protocol-onebot-v12')
      }
      this.initialized = true
      return this.app
    })()

    try {
      return await this.initPromise
    } finally {
      this.initPromise = null
    }
  }

  normalizeChannelConfig(channelConfig = {}, adapterDefinition = null) {
    const id = String(channelConfig.id ?? channelConfig.account_id ?? '').trim()
    if (!id) throw new TypeError('OneBots account requires a non-empty id')
    const platform = String(
      adapterDefinition?.onebots?.platform ?? channelConfig.platform ?? '',
    ).trim()
    if (!platform) throw new TypeError('OneBots account requires a platform')
    const credentials = channelConfig.credentials && typeof channelConfig.credentials === 'object'
      ? channelConfig.credentials
      : {}
    const protocolName = typeof channelConfig.protocol === 'string'
      ? channelConfig.protocol.trim().toLowerCase()
      : ONEBOTS_PROTOCOL
    if (protocolName !== ONEBOTS_PROTOCOL) {
      throw new TypeError(`Unsupported embedded OneBots protocol: ${protocolName}`)
    }
    const protocol = channelConfig[protocolName] ?? channelConfig.protocolConfig ??
      (channelConfig.protocol && typeof channelConfig.protocol === 'object' ? channelConfig.protocol : {})
    const normalized = {
      ...credentials,
      ...channelConfig.config,
      platform,
      account_id: id,
      [protocolName]: createProtocolConfig(protocol),
    }
    return adapterDefinition?.onebots?.bridge?.configureAccount?.(channelConfig, normalized) ?? normalized
  }

  async ensurePlatformAdapter(platform, adapterDefinition = null) {
    if (this.app.adapters?.get?.(platform)) return
    if (!/^[a-z0-9][a-z0-9-]*$/.test(platform)) {
      throw new TypeError(`Invalid OneBots platform: ${platform}`)
    }
    const loader = this.options.adapterLoaders?.[platform]
    const packageName = adapterDefinition?.onebots?.package ?? `@onebots/adapter-${platform}`
    try {
      if (loader) await loader()
      else await import(packageName)
    } catch (error) {
      throw new Error(`OneBots adapter is not installed: ${packageName}`, { cause: error })
    }
  }

  findProtocol(account) {
    return account?.protocols?.find(protocol => `${protocol.name}.${protocol.version}` === ONEBOTS_PROTOCOL)
      ?? account?.protocols?.[0]
  }

  installPlatformCompatibility(state) {
    state.restorePlatformCompatibility?.()
    state.restorePlatformCompatibility = state.adapterDefinition?.onebots?.bridge
      ?.installCompatibility?.({ state, gateway: this }) ?? null
  }

  attachAccountEvents(state) {
    const { account, id } = state
    const client = account.client
    const onQr = payload => {
      const qrCodeUrl = payload?.qrCodeUrl ?? payload?.qr_code_url ?? payload?.url ?? ''
      const qrcode = payload?.qrcode ?? payload?.qrCode ?? ''
      state.status = 'qr'
      state.qr = { qrCodeUrl, qrcode, status: 'qr', refreshed: !!payload?.refreshed }
      state.error = null
      this.qrSessions.set(id, state.qr)
      this.logger.info?.(`[OneBots] 账号 ${id} 生成登录二维码: ${qrCodeUrl || qrcode}`)
    }
    const onLogin = session => {
      state.status = 'login'
      state.session = session ?? null
      state.error = null
      state.qr = state.qr ? { ...state.qr, status: 'login' } : null
      this.logger.info?.(`[OneBots] 账号 ${id} 扫码登录成功: botId=${session?.accountId}, userId=${session?.userId}`)
    }
    const onReady = async () => {
      state.status = 'online'
      state.error = null
      if (typeof client?.getSession === 'function') {
        const session = await client.getSession().catch(() => null)
        if (session) state.session = session
      }
      if (state.qr) state.qr = { ...state.qr, status: 'online' }
      this.qrSessions.delete(id)
      this.logger.info?.(`[OneBots] 账号 ${id} 已就绪并上线: botId=${state.session?.accountId}, userId=${state.session?.userId}`)
    }
    const onCredentialStale = error => {
      state.status = 'credential_stale'
      state.error = error ? asError(error).message : null
      // Keep the last QR available until the adapter emits a fresh one.
      if (state.qr) state.qr = { ...state.qr, status: 'credential_stale' }
      this.logger.warn?.(`[OneBots] 账号 ${id} 凭证在服务端失效: ${state.error}`)
    }
    const onError = error => {
      state.error = asError(error).message
      if (state.status !== 'credential_stale') state.status = 'error'
      this.logger.error?.(`[OneBots] 账号 ${id} 发生异常:`, error)
    }
    const onStop = () => {
      if (state.status !== 'disposed') state.status = 'offline'
      this.logger.info?.(`[OneBots] 账号 ${id} 已停止下线`)
    }

    // Adapters may emit lifecycle events on their client or account object.
    for (const target of [client, account]) {
      if (!target?.on) continue
      target.on('qr', onQr)
      target.on('login', onLogin)
      target.on('ready', onReady)
      target.on('credential_stale', onCredentialStale)
      target.on('error', onError)
      target.on('stop', onStop)
    }
    state.detachEvents = () => {
      for (const target of [client, account]) {
        if (!target?.off) continue
        target.off('qr', onQr)
        target.off('login', onLogin)
        target.off('ready', onReady)
        target.off('credential_stale', onCredentialStale)
        target.off('error', onError)
        target.off('stop', onStop)
      }
    }
  }

  async startAccount(channelConfig, adapterDefinition = null) {
    await this.init()
    if (this.disposed) throw new Error('OneBotsGateway has been disposed')
    const normalized = this.normalizeChannelConfig(channelConfig, adapterDefinition)
    const id = normalized.account_id
    await adapterDefinition?.onebots?.bridge?.beforeAccountStart?.({
      accountId: id,
      channelConfig,
      gateway: this,
    })
    const existing = this.accounts.get(id)
    if (existing) {
      if (existing.platform !== normalized.platform) {
        throw new Error(`账号 ${id} 已绑定平台 ${existing.platform}`)
      }
      if (existing.startPromise) return existing
      if (existing.status === 'online' || existing.status === 'qr' || existing.status === 'login' || existing.status === 'pending' || existing.status === 'credential_stale') {
        return existing
      }
    }

    await this.ensurePlatformAdapter(normalized.platform, adapterDefinition)
    const adapter = this.app.adapters?.get?.(normalized.platform)
      ?? this.app.findOrCreateAdapter?.(normalized.platform)
    if (!adapter) throw new Error(`OneBots adapter unavailable: ${normalized.platform}`)

    // BaseApp.addAccount is the canonical dynamic account transaction. It
    // creates the real adapter account and keeps its adapter registry in sync.
    if (existing && (existing.status === 'offline' || existing.status === 'error')) {
      // Account.stop() intentionally removes its lifecycle listeners. Remount
      // through BaseApp for a subsequent start instead of trying to revive a
      // stopped Account instance.
      existing.clientDetach?.()
      existing.detachEvents?.()
      adapter.accounts?.delete?.(id)
      existing.clientFacade = null
    }
    if (!existing || !adapter.accounts?.has?.(id)) {
      await this.app.addAccount(normalized)
    }
    const account = adapter.accounts?.get?.(id) ?? this.app.adapters?.get?.(normalized.platform)?.accounts?.get?.(id)
    if (!account) throw new Error(`OneBots failed to mount account: ${normalized.platform}.${id}`)
    const state = existing ?? {
      id,
      platform: normalized.platform,
      config: normalized,
      account,
      protocol: null,
      client: null,
      qr: null,
      session: null,
      error: null,
      status: 'pending',
    }
    state.adapterDefinition = adapterDefinition ?? state.adapterDefinition ?? null
    state.account = account
    state.client = account.client
    state.protocol = this.findProtocol(account)
    state.detachEvents?.()
    this.installPlatformCompatibility(state)
    this.attachAccountEvents(state)
    this.accounts.set(id, state)
    state.status = 'pending'
    if (!state.session && typeof state.client?.getSession === 'function') {
      state.client.getSession().then(s => {
        if (s) state.session = s
      }).catch(() => {})
    }

    // Login can wait for a QR scan for several minutes. Return the state now,
    // while retaining a handled promise for diagnostics and stop/dispose.
    let accountStart
    try {
      // Invoke immediately so QR/login events emitted before the first await
      // are visible to the caller that just awaited startAccount().
      accountStart = account.start?.()
    } catch (error) {
      accountStart = Promise.reject(error)
    }
    state.startPromise = Promise.resolve(accountStart).then(
      result => {
        if (state.status === 'pending') state.status = account.status === 'online' ? 'online' : 'ready'
        return result
      },
    ).catch(error => {
      // Account.stop() invalidates an in-flight QR/login generation. That is
      // an expected cancellation, not a startup fault worth surfacing.
      if (state.status === 'offline' || state.status === 'disposed') return undefined
      state.error = asError(error).message
      state.status = 'error'
      this.logger.warn?.(`[OneBots] account ${id} failed to start`, error)
      return undefined
    }).finally(() => {
      state.startPromise = null
    })
    // Promise has a rejection handler above; this explicit void documents that
    // the background login is intentionally not awaited by callers.
    void state.startPromise
    return state
  }

  async requestQrLogin(channelId, platform = '', options = {}) {
    let opts = options
    let plat = platform
    if (typeof platform === 'object' && platform !== null) {
      opts = platform
      plat = opts.platform ?? ''
    }
    const channel = typeof channelId === 'object' ? channelId : null
    const id = String(channel ? channel.id : channelId)
    const adapterDefinition = opts.adapterDefinition ?? null
    plat = adapterDefinition?.onebots?.platform ?? channel?.platform ?? plat
    const force = opts.force === true

    let state = this.accounts.get(id)
    if (!state) state = await this.startAccount({ id, platform: plat, ...channel }, adapterDefinition)

    // If an existing valid QR is already active and not forced, return it immediately.
    if (!force && state.qr?.status === 'qr' && (state.qr.qrCodeUrl || state.qr.qrcode)) {
      return { ...state.qr }
    }

    // Account is mounted. If interactive QR login can be triggered on the client:
    const client = state.client ?? state.account?.client
    if (typeof client?.runInteractiveQrLogin === 'function') {
      state.interactiveLoginAbort?.abort(new DOMException('New QR login requested', 'AbortError'))
      const controller = new AbortController()
      state.interactiveLoginAbort = controller
      let loginPromise
      try {
        loginPromise = client.runInteractiveQrLogin(controller.signal)
      } catch (err) {
        loginPromise = Promise.reject(err)
      }
      Promise.resolve(loginPromise).catch(error => {
        if (controller.signal.aborted) return
        this.logger.warn?.(`[OneBots] account ${id} QR login failed:`, error)
        if (state.status === 'qr') {
          state.status = (state.session || state.account?.status === 'online') ? 'online' : 'error'
          state.error = asError(error).message
        }
      })

      // Wait for the 'qr' event to be emitted by runInteractiveQrLogin
      const waitMs = this.options.qrWaitTimeoutMs ?? 15_000
      await new Promise(resolve => {
        let timer
        const finish = () => {
          if (timer) clearTimeout(timer)
          client.off?.('qr', onQr)
          client.off?.('error', onError)
          resolve()
        }
        const onQr = () => finish()
        const onError = () => finish()
        client.on?.('qr', onQr)
        client.on?.('error', onError)
        Promise.resolve(loginPromise).then(finish, finish)
        timer = setTimeout(finish, waitMs)
        timer.unref?.()
      })

      if (state.qr?.status === 'qr' && (state.qr.qrCodeUrl || state.qr.qrcode)) {
        return { ...state.qr }
      }
    } else if (typeof client?.createLoginSession === 'function' || typeof state.account?.createLoginSession === 'function') {
      const fn = client?.createLoginSession ?? state.account?.createLoginSession
      const target = client?.createLoginSession ? client : state.account
      try {
        const botType = state.config?.bot_type ?? state.config?.botType
        const session = await fn.call(target, { botType })
        const qrCodeUrl = session.qrCodeUrl ?? session.qrcode_img_content ?? session.url ?? ''
        const qrcode = session.qrcode ?? ''
        state.status = 'qr'
        state.qr = { qrCodeUrl, qrcode, status: 'qr', sessionKey: session.sessionKey }
        this.qrSessions.set(id, state.qr)
        if (typeof client?.waitForLogin === 'function' && session.sessionKey) {
          client.waitForLogin(session.sessionKey).then(outcome => {
            if (outcome?.connected && outcome?.session) {
              state.status = 'login'
              state.session = outcome.session
            }
          }).catch(err => {
            this.logger.warn?.(`[OneBots] account ${id} waitForLogin error:`, err)
          })
        }
        return { ...state.qr }
      } catch (err) {
        this.logger.warn?.(`[OneBots] account ${id} createLoginSession failed:`, err)
      }
    }

    // Wait for in-flight startPromise if present
    const startPromise = state.startPromise
    if (startPromise) {
      const targets = [state.account?.client, state.account].filter(Boolean)
      const waitMs = this.options.qrWaitTimeoutMs ?? 15_000
      await new Promise(resolve => {
        let settled = false
        let timer
        const cleanup = () => {
          for (const target of targets) {
            target.off?.('qr', onQr)
            target.off?.('ready', onReady)
            target.off?.('login', onLogin)
            target.off?.('credential_stale', onStale)
            target.off?.('error', onError)
          }
          if (timer) clearTimeout(timer)
        }
        const finish = () => {
          if (settled) return
          settled = true
          cleanup()
          resolve()
        }
        const onQr = () => finish()
        const onReady = () => finish()
        const onLogin = () => finish()
        const onStale = () => finish()
        const onError = () => finish()
        for (const target of targets) {
          target.on?.('qr', onQr)
          target.on?.('ready', onReady)
          target.on?.('login', onLogin)
          target.on?.('credential_stale', onStale)
          target.on?.('error', onError)
        }
        timer = setTimeout(finish, waitMs)
        timer.unref?.()
        startPromise.then(finish, finish)
      })
    }
    return state.qr?.status === 'qr' ? { ...state.qr } : this.getAccountState(id)
  }

  async stopAccount(channelId) {
    const id = String(typeof channelId === 'object' ? channelId.id : channelId)
    const state = this.accounts.get(id)
    if (!state) return false
    state.interactiveLoginAbort?.abort(new DOMException('Account stopped', 'AbortError'))
    state.interactiveLoginAbort = null
    if (state.stopPromise) return state.stopPromise
    state.status = 'offline'
    state.stopPromise = Promise.resolve().then(() => state.account.stop?.()).catch(error => {
      state.error = asError(error).message
      this.logger.warn?.(`[OneBots] account ${id} failed to stop`, error)
    }).then(() => true).finally(() => {
      state.stopPromise = null
    })
    await state.stopPromise
    state.clientDetach?.()
    state.detachEvents?.()
    state.restorePlatformCompatibility?.()
    state.restorePlatformCompatibility = null
    state.clientDetach = null
    state.clientFacade = null
    const adapter = this.app.adapters?.get?.(state.platform)
    adapter?.accounts?.delete?.(id)
    return true
  }

  async deleteAccount(channelId, adapterDefinition = null) {
    const id = String(typeof channelId === 'object' ? channelId.id : channelId)
    const state = this.accounts.get(id)
    await this.stopAccount(id)
    const definition = state?.adapterDefinition ?? adapterDefinition
    await definition?.onebots?.bridge?.deleteAccountData?.({
      accountId: id,
      gateway: this,
    })
    this.accounts.delete(id)
    this.qrSessions.delete(id)
    return true
  }

  getQrCode(channelId) {
    const id = String(typeof channelId === 'object' ? channelId.id : channelId)
    const qr = this.qrSessions.get(id)
    return qr ? { ...qr } : null
  }

  getAccountState(channelId) {
    const id = String(typeof channelId === 'object' ? channelId.id : channelId)
    const state = this.accounts.get(id)
    if (!state) return null
    const session = state.session
    return {
      id: state.id,
      account_id: state.id,
      platform: state.platform,
      status: state.status,
      userId: session?.userId ?? null,
      botId: session?.accountId ?? state.account?.nickname ?? null,
      token: session?.token ?? null,
      qrCodeUrl: state.qr?.qrCodeUrl ?? null,
      qrcode: state.qr?.qrcode ?? null,
      error: state.error,
      accountStatus: state.account?.status ?? null,
      ready: state.status === 'online',
    }
  }

  async createClient(channelId, options = {}) {
    await this.init()
    const id = String(typeof channelId === 'object' ? channelId.id : channelId)
    const state = this.accounts.get(id)
    if (!state) throw new Error(`OneBots account not found: ${id}`)
    if (state.clientFacade) return state.clientFacade
    if (!state.protocol) throw new Error(`OneBots account has no ${ONEBOTS_PROTOCOL} protocol: ${id}`)
    const factory = this.clientFactory ?? (await import('@imhelper/onebot-v12')).createOnebot12Client
    const protocol = state.protocol
    const clientConfig = {
      baseUrl: createLoopbackUrl(options.port ?? ONEBOTS_PORT),
      selfId: id,
      platform: state.platform,
      receiveMode: ONEBOTS_RECEIVE_MODE,
      accessToken: options.accessToken,
      call: (action, params) => this.callAction(id, action, params),
    }
    const client = await factory(clientConfig, state)
    const onDispatch = payload => {
      try {
        const event = typeof payload === 'string' ? JSON.parse(payload) : payload
        const eventType = event?.detail_type || event?.message_type || event?.type || 'unknown'
        const senderId = event?.user_id || event?.sender?.id || 'unknown'
        const rawContent = event?.raw_message || event?.message?.[0]?.data?.text || ''
        const preview = rawContent ? ` "${rawContent.slice(0, 40)}${rawContent.length > 40 ? '...' : ''}"` : ''
        this.logger.info?.(`[OneBots] 📥 接收协议事件派发 [${id}] [${eventType}] from=${senderId}${preview}`)
        if (event?.type === 'message' && event.message_id != null) {
          state.inboundMetadata ??= new Map()
          state.inboundMetadata.set(String(event.message_id), {
            extensions: event.extensions,
            platform: event.platform,
            raw_event: event.raw_event,
          })
          if (state.inboundMetadata.size > INBOUND_METADATA_MAX_SIZE) {
            const oldest = state.inboundMetadata.keys().next().value
            if (oldest != null) state.inboundMetadata.delete(oldest)
          }
        }
        client.ingest(event)
      } catch (error) {
        this.logger.warn?.(`[OneBots] failed to ingest ${id} dispatch`, error)
      }
    }
    protocol.on?.('dispatch', onDispatch)
    state.clientFacade = client
    state.clientDetach = () => protocol.off?.('dispatch', onDispatch)
    return client
  }

  /** Recover adapter-specific fields discarded by the generic imhelper event projection. */
  getInboundMetadata(channelId, messageId) {
    if (messageId == null) return null
    const id = String(typeof channelId === 'object' ? channelId.id : channelId)
    return this.accounts.get(id)?.inboundMetadata?.get(String(messageId)) ?? null
  }

  async callAction(channelId, action, params = {}) {
    const id = String(typeof channelId === 'object' ? channelId.id : channelId)
    const state = this.accounts.get(id)
    if (!state) throw new Error(`OneBots account not found: ${id}`)
    if (!state.protocol?.apply) throw new Error(`OneBots account has no callable protocol: ${id}`)
    return state.protocol.apply(action, params)
  }

  async dispose() {
    if (this.disposePromise) return this.disposePromise
    this.disposePromise = (async () => {
      for (const state of this.accounts.values()) {
        state.clientDetach?.()
        state.detachEvents?.()
        await this.stopAccount(state.id)
        state.status = 'disposed'
      }
      if (this.app?.stop) await this.app.stop()
      this.accounts.clear()
      this.qrSessions.clear()
      this.disposed = true
      this.initialized = false
    })()
    try {
      await this.disposePromise
    } finally {
      this.disposePromise = null
    }
  }
}

export default OneBotsGateway
