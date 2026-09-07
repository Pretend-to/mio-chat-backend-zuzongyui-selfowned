import fs from 'node:fs'
import path from 'node:path'

import {
  ONEBOTS_PLATFORM,
  ONEBOTS_PORT,
  ONEBOTS_RECEIVE_MODE,
  ONEBOTS_PROTOCOL,
  createLoopbackUrl,
  createProtocolConfig,
} from './config.js'

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

const asError = value => value instanceof Error ? value : new Error(String(value))

/**
 * OneBots 3.0.12 rejects `group_id: null`/`""` before its mapper can apply
 * the documented private-message fallback. Real iLink private events use
 * both shapes, so treat only blank group ids as absent at the adapter edge.
 */
export function normalizeIlinkInboundPacket(packet) {
  if (!packet || typeof packet !== 'object' || !Object.hasOwn(packet, 'group_id')) {
    return packet
  }
  if (packet.group_id !== null && !(typeof packet.group_id === 'string' && !packet.group_id.trim())) {
    return packet
  }
  const normalized = { ...packet }
  delete normalized.group_id
  return normalized
}

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
    this.logger = options.logger ?? noopLogger
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
          log_level: options.logLevel ?? 'warn',
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

      // Importing these packages registers their factories in the real
      // OneBots registries. Imports are lazy so tests can inject a tiny app.
      if (!this.options.skipRegistration) {
        await import('@onebots/adapter-wechat-clawbot')
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

  normalizeChannelConfig(channelConfig = {}) {
    const id = String(channelConfig.id ?? channelConfig.account_id ?? '').trim()
    if (!id) throw new TypeError('OneBots account requires a non-empty id')
    const platform = String(channelConfig.platform ?? ONEBOTS_PLATFORM).trim()
    if (!platform) throw new TypeError('OneBots account requires a platform')
    const credentials = channelConfig.credentials && typeof channelConfig.credentials === 'object'
      ? channelConfig.credentials
      : {}
    const protocol = channelConfig[ONEBOTS_PROTOCOL] ?? channelConfig.protocol ?? {}
    return {
      ...credentials,
      ...channelConfig.config,
      platform,
      account_id: id,
      ...(platform === 'wechat-clawbot' && {
        outbound_text_format: channelConfig.config?.outbound_text_format
          ?? credentials.outbound_text_format
          ?? 'markdown',
      }),
      [ONEBOTS_PROTOCOL]: createProtocolConfig(protocol),
    }
  }

  findProtocol(account) {
    return account?.protocols?.find(protocol => `${protocol.name}.${protocol.version}` === ONEBOTS_PROTOCOL)
      ?? account?.protocols?.[0]
  }

  installInboundCompatibility(state) {
    const client = state.account?.client
    if (state.platform !== 'wechat-clawbot' || typeof client?.ingest !== 'function') return
    state.restoreInboundCompatibility?.()
    const original = client.ingest
    const wrapped = function (packet, ...args) {
      return Reflect.apply(original, this, [normalizeIlinkInboundPacket(packet), ...args])
    }
    client.ingest = wrapped
    state.restoreInboundCompatibility = () => {
      if (client.ingest === wrapped) client.ingest = original
      state.restoreInboundCompatibility = null
    }
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
    }
    const onLogin = session => {
      state.status = 'login'
      state.session = session ?? null
      state.error = null
      state.qr = state.qr ? { ...state.qr, status: 'login' } : null
    }
    const onReady = () => {
      state.status = 'online'
      state.error = null
      if (state.qr) state.qr = { ...state.qr, status: 'online' }
      this.qrSessions.delete(id)
    }
    const onCredentialStale = error => {
      state.status = 'credential_stale'
      state.error = error ? asError(error).message : null
      // Keep the last QR available until the adapter emits a fresh one.
      if (state.qr) state.qr = { ...state.qr, status: 'credential_stale' }
    }
    const onError = error => {
      state.error = asError(error).message
      if (state.status !== 'credential_stale') state.status = 'error'
    }
    const onStop = () => {
      if (state.status !== 'disposed') state.status = 'offline'
    }

    // The real adapter emits these on its iLink client. Supporting account
    // events too keeps the facade usable with alternative adapters and mocks.
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

  async startAccount(channelConfig) {
    await this.init()
    if (this.disposed) throw new Error('OneBotsGateway has been disposed')
    const normalized = this.normalizeChannelConfig(channelConfig)
    const id = normalized.account_id
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
    state.account = account
    state.client = account.client
    state.protocol = this.findProtocol(account)
    state.detachEvents?.()
    this.installInboundCompatibility(state)
    this.attachAccountEvents(state)
    this.accounts.set(id, state)
    state.status = 'pending'

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

  async requestQrLogin(channelId, platform = ONEBOTS_PLATFORM) {
    const channel = typeof channelId === 'object' ? channelId : null
    const id = channel ? channel.id : channelId
    let state = this.accounts.get(String(id))
    if (!state) state = await this.startAccount({ id, platform: channel?.platform ?? platform, ...channel })
    if (state.qr?.status === 'qr') return { ...state.qr }
    if (state.status === 'online') return this.getAccountState(id)
    // Wait for the first useful login event. A real iLink request may need a
    // few seconds before it emits qr; a short 0ms race made the HTTP caller
    // observe an empty result even though login was progressing normally.
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
        // A failed/synchronous mock start should release the request without
        // waiting for the full QR timeout.
        startPromise.then(finish, finish)
      })
    }
    return state.qr?.status === 'qr' ? { ...state.qr } : this.getAccountState(id)
  }

  async stopAccount(channelId) {
    const id = String(typeof channelId === 'object' ? channelId.id : channelId)
    const state = this.accounts.get(id)
    if (!state) return false
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
    state.restoreInboundCompatibility?.()
    state.clientDetach = null
    state.clientFacade = null
    const adapter = this.app.adapters?.get?.(state.platform)
    adapter?.accounts?.delete?.(id)
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
    return {
      id: state.id,
      account_id: state.id,
      platform: state.platform,
      status: state.status,
      userId: state.session?.userId ?? state.account?.nickname ?? null,
      botId: state.session?.accountId ?? null,
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
        client.ingest(typeof payload === 'string' ? JSON.parse(payload) : payload)
      } catch (error) {
        this.logger.warn?.(`[OneBots] failed to ingest ${id} dispatch`, error)
      }
    }
    protocol.on?.('dispatch', onDispatch)
    state.clientFacade = client
    state.clientDetach = () => protocol.off?.('dispatch', onDispatch)
    return client
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
