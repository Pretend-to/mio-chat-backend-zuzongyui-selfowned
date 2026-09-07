import logger from './utils/logger.js'
// Import taskScheduler from './lib/corn.js'

// 全局变量存储服务器实例
let httpServer = null
let isShuttingDown = false

/**
 * 检查并执行自动迁移（包括 OneBot 配置迁移）
 */
async function checkAndPerformAutoMigration(AutoMigrationDetector) {
  try {
    const detector = new AutoMigrationDetector()
    
    // 执行完整的迁移检查和处理
    const result = await detector.checkAndMigrate()
    
    if (!result.success && !result.noMigrationNeeded) {
      logger.error('自动迁移失败，请手动执行迁移')
      logger.error('错误信息:', result.error)
      process.exit(1)
    }
    
    if (result.noMigrationNeeded) {
      logger.debug('无需执行配置迁移，继续正常启动')
    }
  } catch (error) {
    logger.error('自动迁移检测失败:', error)
    // 不退出程序，继续正常启动流程
  }
}

/**
 * 动态导入所有依赖模块
 */
async function importDependencies() {
  const { statusCheck } = await import('./lib/check.js')
  const { startServer } = await import('./lib/server/http/index.js')
  const prismaManager = (await import('./lib/database/prisma.js')).default
  const PresetService = (await import('./lib/database/services/PresetService.js')).default
  const SystemSettingsService = (await import('./lib/database/services/SystemSettingsService.js')).default
  const PluginConfigService = (await import('./lib/database/services/PluginConfigService.js')).default
  const initializeDefaults = (await import('./scripts/initialize-defaults.js')).default
  const AutoMigrationDetector = (await import('./lib/migration/autoMigrationDetector.js')).default
  const TaskService = (await import('./lib/database/services/TaskService.js')).default
  
  return {
    AutoMigrationDetector,
    PluginConfigService,
    PresetService,
    SystemSettingsService,
    TaskService,
    initializeDefaults,
    prismaManager,
    startServer,
    statusCheck
  }
}

/**
 * 初始化数据库和服务
 */
async function initializeDatabase(dependencies) {
  const { 
    prismaManager, 
    PresetService, 
    SystemSettingsService, 
    PluginConfigService, 
    initializeDefaults,
    AutoMigrationDetector,
    TaskService
  } = dependencies
  
  try {
    // 1. 执行完整初始化流程（包含环境检查和数据库自愈）
    // 必须最先执行，以确保 .env 存在、数据库目录存在且 Schema 已同步
    const { performFullInitialization } = await import('./lib/initialization/index.js')
    await performFullInitialization()

    logger.debug('初始化数据库连接...')
    
    // 2. 初始化 Prisma 管理器
    await prismaManager.initialize()
    
    // 3. 初始化所有服务
    await PresetService.initialize()
    await SystemSettingsService.initialize()
    await PluginConfigService.initialize()
    await TaskService.initialize()

    // 初始化生图、搜索、识图调度服务
    try {
      const { imageService } = await import('./lib/chat/image/ImageService.js')
      const { searchService } = await import('./lib/chat/search/SearchService.js')
      const { visionService } = await import('./lib/chat/vision/VisionService.js')
      await imageService.initialize()
      await searchService.initialize()
      await visionService.initialize()
      logger.debug('生图、搜索与识图服务初始化完成')
    } catch (err) {
      logger.warn('调度服务初始化失败:', err.message)
    }
    
    // 4. 初始化默认配置（如果数据库中没有）
    logger.debug('初始化默认配置...')
    await initializeDefaults()
    
    // 检查并执行自动迁移
    await checkAndPerformAutoMigration(AutoMigrationDetector)
    
    // 重新加载内存中的配置以同步刚刚写入数据库的默认值，
    // 避免后续的状态检查重复生成访问码
    try {
      const config = (await import('./lib/config.js')).default
      await config.reload()
      logger.debug('配置已从数据库重新加载以应用默认值')
    } catch (error) {
      logger.warn('重新加载配置时发生问题，可能导致配置不同步:', error.message)
    }
    
    logger.debug('数据库和服务初始化完成')
  } catch (error) {
    logger.error('数据库初始化失败:', error)
    process.exit(1)
  }
}


/**
 * 优雅关闭时：把 streamCache 中仍在执行中的工具调用以 failed 终态广播给对应客户端。
 * 防止前端 UI 上最后一个 bash tool 永远显示"执行中"。
 */
async function notifyInFlightInterrupted(sessions, streamCache) {
  // UserId -> 在线 client 列表（多端复用同一 userId 的池）
  const clientsByUser = new Map()
  for (const client of sessions.getAllClients()) {
    if (!clientsByUser.has(client.id)) {clientsByUser.set(client.id, [])}
    clientsByUser.get(client.id).push(client)
  }
  if (clientsByUser.size === 0) {
    logger.debug('无可通知的在线客户端，跳过中断广播')
    return
  }

  let broadcastCount = 0
  for (const [key, messages] of streamCache.cache.entries()) {
    const separator = key.indexOf(':')
    if (separator === -1) {continue}
    const userId = key.slice(0, separator)
    const contactorId = key.slice(separator + 1)
    const clients = clientsByUser.get(userId)
    if (!clients || clients.length === 0) {continue}

    for (const item of messages) {
      if (!item || !item.messageId) {continue}

      // 找出仍处于"执行中"且没有结果的 toolCall
      const runningTools = (item.chunks || []).filter(
        (c) =>
          c.type === 'toolCall' &&
          c.content &&
          ['running', 'pending', 'started'].includes(c.content.action) &&
          !c.content.result
      )
      if (runningTools.length === 0) {continue}

      const {messageId} = item
      for (const client of clients) {
        // 1) 每个还在执行中的 toolCall 置为 failed 终态
        for (const toolChunk of runningTools) {
          client.sendOpenaiMessage(
            'update',
            {
              content: {
                ...toolChunk.content,
                action: 'failed',
                result: { error: '服务器重启，工具执行被打断' },
                status: 'failed',
              },
              metaData: { contactorId, messageId },
              type: 'toolCall',
            },
            messageId
          )
        }
        // 2) 消息整体标记为 failed（附带 metaData 供前端路由到对应联系人）
        client.sendOpenaiMessage(
          'failed',
          {
            code: 'SERVER_SHUTDOWN',
            message: '服务器正在关闭，请求已中断',
            metaData: { contactorId, messageId },
          },
          messageId
        )
        broadcastCount++
      }
    }
  }

  if (broadcastCount > 0) {
    logger.info(`已向客户端广播 ${broadcastCount} 条进行中请求的中断状态`)
  }
}

/**
 * 优雅关闭应用程序
 */
async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    logger.warn('已在关闭过程中，忽略重复信号')
    return
  }
  
  isShuttingDown = true
  logger.info(`收到 ${signal} 信号，开始优雅关闭...`)
  
  // 设置强制关闭超时（10秒）
  const forceExitTimer = setTimeout(() => {
    logger.warn('优雅关闭超时，强制退出应用程序')
    process.exit(1)
  }, 10_000)
  
  try {
    // 0. 广播中断：把仍处于执行中的 tool_call 标记为 failed 终态，避免前端 UI 永远显示"执行中"
    try {
      const { default: shutdownSessions } = await import('./lib/server/socket.io/services/sessions.js')
      const { default: shutdownStreamCache } = await import('./lib/server/socket.io/services/streamCache.js')
      await notifyInFlightInterrupted(shutdownSessions, shutdownStreamCache)
    } catch (error) {
      logger.warn('广播进行中请求中断状态时出现警告:', error.message)
    }

    // 1. 关闭 Socket.IO 服务器
    try {
      if (global.middleware && global.middleware.socketServer) {
        logger.info('正在关闭 Socket.IO 服务器...')
        await global.middleware.socketServer.close()
        logger.info('Socket.IO 服务器已关闭')
      }
    } catch (error) {
      logger.warn('Socket.IO 服务器关闭时出现警告:', error.message)
    }

    // 1.5. 停止渠道轮询、OneBots 账号与进程内协议资源
    try {
      const { getChannelRuntime } = await import('./lib/server/http/controllers/channelController.js')
      const channelRuntime = getChannelRuntime()
      if (typeof channelRuntime?.dispose === 'function') {
        logger.info('正在关闭渠道运行时...')
        await channelRuntime.dispose()
        logger.info('渠道运行时已关闭')
      }
    } catch (error) {
      logger.warn('渠道运行时关闭时出现警告:', error.message)
    }
    
    // 2. 停止接受新连接并强制关闭现有连接
    try {
      if (httpServer && httpServer.listening) {
        logger.info('正在关闭 HTTP 服务器...')
        
        // 强制关闭所有连接
        const connections = new Set()
        
        httpServer.on('connection', (connection) => {
          connections.add(connection)
          connection.on('close', () => {
            connections.delete(connection)
          })
        })
        
        // 先尝试优雅关闭
        const closePromise = new Promise((resolve) => {
          const timeout = setTimeout(() => {
            logger.warn('HTTP 服务器关闭超时，强制断开所有连接')
            // 强制断开所有连接
            for (const connection of connections) {
              try {
                connection.destroy()
              } catch {
                // 忽略连接销毁错误
              }
            }
            resolve()
          }, 3000) // 3秒超时
          
          httpServer.close((err) => {
            clearTimeout(timeout)
            if (err) {
              // 如果服务器已经关闭，不视为错误
              if (err.code === 'ERR_SERVER_NOT_RUNNING') {
                logger.info('HTTP 服务器已经关闭')
              } else {
                logger.warn('HTTP 服务器关闭时出现警告:', err.message)
              }
            } else {
              logger.info('HTTP 服务器已关闭')
            }
            resolve()
          })
        })
        
        await closePromise
      } else if (httpServer) {
        logger.info('HTTP 服务器已经关闭')
      }
    } catch (error) {
      logger.warn('HTTP 服务器关闭时出现警告:', error.message)
    }
    
    // 3. 关闭数据库连接
    try {
      logger.info('正在关闭数据库连接...')
      await prismaManager.disconnect()
      logger.info('数据库连接已关闭')
    } catch (error) {
      logger.warn('数据库关闭时出现警告:', error.message)
    }
    
    // 清除强制退出定时器
    clearTimeout(forceExitTimer)
    
    logger.info('应用程序已优雅关闭')
    process.exit(0)
  } catch (error) {
    logger.error('优雅关闭过程中发生错误:', error)
    clearTimeout(forceExitTimer)
    process.exit(1)
  }
}

// 应用启动流程
async function startApp() {
  try {
    // 自动初始化：从 lib/initialization 导入并执行
    const { performFullInitialization } = await import('./lib/initialization/index.js')
    await performFullInitialization()
    
    // 动态导入所有依赖
    const dependencies = await importDependencies()
    
    // 初始化数据库
    await initializeDatabase(dependencies)
    
    // 等待配置初始化完成
    const config = (await import('./lib/config.js')).default
    await config._waitForInit()
    
    // 系统状态检查
    await dependencies.statusCheck()
    
    // 初始化定时任务调度器
    const taskScheduler = (await import('./lib/cron.js')).default
    const { initChannelController, getChannelRuntime } = await import('./lib/server/http/controllers/channelController.js')
    initChannelController({ startTriggers: false }) // 确保 deps 已初始化（幂等）

    // 自动恢复上次 running 状态的渠道（持久化开关）
    const channelRuntime = getChannelRuntime()
    try {
      // OneBots 通道需先恢复进程内网关与账号；旧 iLink 通道继续
      // 由 restoreRunningChannels 处理，两条路径互不重复。
      if (typeof channelRuntime.init === 'function') await channelRuntime.init()
      const { restoreRunningChannels } = await import('./channels/restoreRunningChannels.js')
      await restoreRunningChannels(channelRuntime, logger)
    } catch (e) {
      logger.warn('[ChannelRuntime] 自动恢复渠道时出错:', e.message)
    }

    // 渠道恢复完成后再启动哨兵，避免启动窗口把目标 Channel 误判为不可用。
    const { getTriggerService } = await import('./lib/triggers/index.js')
    await getTriggerService().startScheduler()

    await taskScheduler.initialize(global.middleware.llm, channelRuntime)
    
    // 启动服务器并保存实例
    httpServer = await dependencies.startServer()

    
    logger.info('应用启动完成')
  } catch (error) {
    logger.error('应用启动失败:', error)
    process.exit(1)
  }
}

// 设置信号处理器
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))

// 处理未捕获的异常
process.on('uncaughtException', (error) => {
  logger.error('未捕获的异常:', error)
  gracefulShutdown('uncaughtException')
})

process.on('unhandledRejection', (reason, promise) => {
  logger.error('未处理的 Promise 拒绝:', reason, 'at:', promise)
  gracefulShutdown('unhandledRejection')
})

// 启动应用
startApp()

// Const scheduler = new taskScheduler()
// Scheduler.init()
