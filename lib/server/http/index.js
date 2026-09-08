import express from 'express'
import path from 'path'
import crypto from 'crypto' // 引入 crypto 模块
import fs from 'fs'
import expressStaticGzip from 'express-static-gzip'
import { accessLogger } from './middleware/accessLog.js'
import { authConfigAPI } from './middleware/authConfig.js'
import { guestUploadAuth } from './middleware/guestUploadAuth.js'
import { upload } from './services/fileService.js'
import * as baseController from './controllers/baseController.js'
import * as openaiController from './controllers/openaiController.js'
import * as imageController from './controllers/imageController.js'
import * as fileController from './controllers/fileController.js'
import * as configController from './controllers/configController.js'
import * as pluginController from './controllers/pluginController.js'
import * as taskController from './controllers/TaskController.js'
import * as dashboardController from './controllers/dashboardController.js'
import skillController from './controllers/skillController.js'
import * as oaiProxyController from './controllers/oaiProxyController.js'
import * as webhookController from './controllers/webhookController.js'
import * as searchController from './controllers/searchController.js'
import * as shellPolicyController from './controllers/shellPolicyController.js'
import * as channelController from './controllers/channelController.js'
import * as visionController from './controllers/visionController.js'
import * as pushController from './controllers/pushController.js'


import config from '../../config.js'

export async function startServer() {
  const app = express()
  const currentDir = process.cwd()
  const distDir = path.join(currentDir, 'dist')
  const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }

  app.set('trust proxy', true)

  app.use(express.json({
    limit: '10mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf
    },
  }))
  app.use(express.urlencoded({ extended: true, limit: '10mb' }))

  // 访问日志中间件（排除健康检查端点）
  app.use((req, res, next) => {
    if (req.path === '/api/health') {
      return next()
    }
    accessLogger(req, res, next)
  })

  app.use('/p/ava', express.static(path.join(currentDir, 'presets', 'avatar')))

  // Use express-static-gzip to prefer pre-compressed files (.br/.gz)
  // OrderPreference prefers brotli first, then gzip
  app.use(
    expressStaticGzip(distDir, {
      enableBrotli: true,
      orderPreference: ['br', 'gz'],
      maxAge: '1h',
      // Don't override index handling elsewhere; we serve index via get('*') below
      index: false,
      setHeaders: (res, filePath) => {
        // 通用缓存头
        res.setHeader('Cache-Control', 'public, max-age=3600')
        // 强制变体缓存头，重要：告诉中间缓存/浏览器这是按 Accept-Encoding 不同的变体
        res.setHeader('Vary', 'Accept-Encoding')
        // 排除 API 路由
        if (res.req && res.req.path && res.req.path.startsWith('/api')) {
          return
        }
        try {
          const fileContent = fs.readFileSync(filePath)
          const hash = crypto
            .createHash('md5')
            .update(fileContent)
            .digest('hex')
          const lastModified = fs.statSync(filePath).mtime.toUTCString()
          res.setHeader('ETag', `"${hash}"`)
          res.setHeader('Last-Modified', lastModified)
        } catch (error) {
          console.error('Error reading file or setting headers:', error)
        }
      },
    }),
  )

  // 健康检查路由
  app.get('/api/health', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.status(200).json({
      service: 'mio-chat-backend',
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: process.env.npm_package_version || '1.0.0',
    })
  })
  // 基本网关路由
  app.get('/api/gateway', baseController.getGateway)
  // 基本信息路由
  app.get('/api/base_info', baseController.getBaseInfo)
  // Onebot插件路由
  app.get('/api/onebot/plugins', baseController.getOnebotPlugins)
  // Onebot连接状态路由（需要管理员验证）
  app.get('/api/onebot/status', authConfigAPI, asyncHandler(baseController.getOnebotStatus))
  // OpenAI预设和工具路由
  app.get(
    '/api/openai/:type',
    asyncHandler(openaiController.getOpenAIResources),
  )
  // 分享获取路由
  app.get('/api/share', asyncHandler(baseController.getShare))
  // 分享设置路由
  app.post('/api/share/set', asyncHandler(baseController.setShare))
  // 获取 Skill 列表 (公开访问)
  app.get('/api/skills', asyncHandler(skillController.getSkills.bind(skillController)))

  // 配置管理路由（需要管理员验证）
  app.get(
    '/api/config',
    authConfigAPI,
    asyncHandler(configController.getFullConfig),
  )

  // 预设管理路由（需要管理员验证）- 必须放在通用路由之前
  app.get(
    '/api/config/presets',
    authConfigAPI,
    asyncHandler(configController.getPresets),
  )
  app.get(
    '/api/config/presets/:name',
    authConfigAPI,
    asyncHandler(configController.getPreset),
  )
  app.post(
    '/api/config/presets',
    authConfigAPI,
    asyncHandler(configController.createPreset),
  )
  app.put(
    '/api/config/presets/:name',
    authConfigAPI,
    asyncHandler(configController.updatePreset),
  )
  app.delete(
    '/api/config/presets/:name',
    authConfigAPI,
    asyncHandler(configController.deletePreset),
  )
  app.post(
    '/api/config/presets/reload',
    authConfigAPI,
    asyncHandler(configController.reloadPresetsEndpoint),
  )
  app.post(
    '/api/config/presets/import',
    authConfigAPI,
    upload.single('file'),
    asyncHandler(configController.importPreset),
  )
  app.get(
    '/api/config/presets/:name/export',
    authConfigAPI,
    asyncHandler(configController.exportPreset),
  )
  app.post(
    '/api/config/presets/validate',
    authConfigAPI,
    asyncHandler(configController.validatePresetEndpoint),
  )
  app.post(
    '/api/config/presets/batch-delete',
    authConfigAPI,
    asyncHandler(configController.batchDeletePresetsEndpoint),
  )

  // LLM适配器管理路由（需要管理员验证）- 必须放在通用路由之前
  app.post(
    '/api/config/llm/:adapterType',
    authConfigAPI,
    asyncHandler(configController.addLLMInstance),
  )
  app.put(
    '/api/config/llm/:adapterType/:index',
    authConfigAPI,
    asyncHandler(configController.updateLLMInstance),
  )
  app.delete(
    '/api/config/llm/:adapterType/:index',
    authConfigAPI,
    asyncHandler(configController.deleteLLMInstance),
  )
  app.post(
    '/api/config/llm/:adapterType/:index/refresh-models',
    authConfigAPI,
    asyncHandler(configController.refreshModels),
  )
  app.post(
    '/api/config/llm/:adapterType/test-models',
    authConfigAPI,
    asyncHandler(configController.testLLMModels),
  )

  // 适配器类型管理路由（需要管理员验证）- 必须放在通用路由之前
  app.get(
    '/api/config/adapter-types',
    authConfigAPI,
    asyncHandler(configController.getAdapterTypes),
  )

  // 其他配置管理路由（需要管理员验证）
  app.post(
    '/api/config/reset',
    authConfigAPI,
    asyncHandler(configController.resetConfig),
  )
  app.post(
    '/api/config/validate',
    authConfigAPI,
    asyncHandler(configController.validateConfigEndpoint),
  )
  app.post(
    '/api/config/storage/test',
    authConfigAPI,
    asyncHandler(configController.testStorageConfigEndpoint),
  )
  // 刷新模型列表（支持刷新所有或单个实例）
  app.post(
    '/api/config/refresh-models',
    authConfigAPI,
    asyncHandler(configController.refreshModels),
  )

  // 模型元数据映射（Registry 规格决策结果）——必须注册在通用兜底路由之前
  app.get(
    '/api/config/models-meta',
    authConfigAPI,
    asyncHandler(configController.getModelMetadata),
  )

  // 通用配置节点路由（必须放在最后，作为兜底）
  app.get(
    '/api/config/:section',
    authConfigAPI,
    asyncHandler(configController.getConfigSection),
  )
  app.put(
    '/api/config',
    authConfigAPI,
    asyncHandler(configController.updateConfig),
  )
  app.put(
    '/api/config/:section',
    authConfigAPI,
    asyncHandler(configController.updateConfigSection),
  )

  // 任务管理路由
  app.get('/api/tasks', authConfigAPI, asyncHandler(taskController.getTasks))
  app.get('/api/tasks/:id', authConfigAPI, asyncHandler(taskController.getTaskDetail))
  app.get(
    '/api/tasks/:id/executions',
    authConfigAPI,
    asyncHandler(taskController.getTaskExecutions),
  )
  app.post('/api/tasks', authConfigAPI, asyncHandler(taskController.upsertTask))
  app.delete(
    '/api/tasks/:id',
    authConfigAPI,
    asyncHandler(taskController.deleteTask),
  )
  app.post(
    '/api/tasks/:id/toggle',
    authConfigAPI,
    asyncHandler(taskController.toggleTask),
  )

  // Web Push 离线推送路由
  app.get('/api/push/vapid-key', authConfigAPI, asyncHandler(pushController.getVapidPublicKey))
  app.get('/api/push/subscriptions', authConfigAPI, asyncHandler(pushController.getSubscriptions))
  app.post('/api/push/subscribe', authConfigAPI, asyncHandler(pushController.subscribe))
  app.post('/api/push/unsubscribe', authConfigAPI, asyncHandler(pushController.unsubscribe))
  app.post('/api/push/clear-all', authConfigAPI, asyncHandler(pushController.clearSubscriptions))
  app.post('/api/push/test', authConfigAPI, asyncHandler(pushController.testPush))

  // 看板与性能 SLA 审计路由 (需要管理员验证)
  app.get(
    '/api/admin/dashboard/realtime',
    authConfigAPI,
    asyncHandler(dashboardController.getRealtimeStats)
  )
  app.get(
    '/api/admin/dashboard/stats',
    authConfigAPI,
    asyncHandler(dashboardController.getHistoricalStats)
  )
  app.get(
    '/api/admin/dashboard/failures',
    authConfigAPI,
    asyncHandler(dashboardController.getFailureLogs)
  )
  app.get(
    '/api/admin/dashboard/turns',
    authConfigAPI,
    asyncHandler(dashboardController.getRecentTurns)
  )
  app.get(
    '/api/admin/dashboard/trace/:requestId',
    authConfigAPI,
    asyncHandler(dashboardController.getTurnTrace)
  )
  app.get(
    '/api/admin/dashboard/user/:userId',
    authConfigAPI,
    asyncHandler(dashboardController.getUserDetail)
  )

  // 插件管理路由（需要管理员验证）
  app.get(
    '/api/plugins',
    authConfigAPI,
    asyncHandler(pluginController.listPlugins),
  )
  app.get(
    '/api/plugins/:pluginName',
    authConfigAPI,
    asyncHandler(pluginController.getPlugin),
  )
  app.get(
    '/api/plugins/:pluginName/config',
    authConfigAPI,
    asyncHandler(pluginController.getPluginConfig),
  )
  app.post(
    '/api/skills/reload',
    authConfigAPI,
    asyncHandler(skillController.reloadSkills.bind(skillController)),
  )
  app.put(
    '/api/plugins/:pluginName/config',
    authConfigAPI,
    asyncHandler(pluginController.updatePluginConfig),
  )
  app.get(
    '/api/plugins/:pluginName/tools',
    authConfigAPI,
    asyncHandler(pluginController.getPluginTools),
  )
  app.post(
    '/api/plugins/:pluginName/tools/:toolName/debug',
    authConfigAPI,
    asyncHandler(pluginController.debugTool),
  )
  app.post(
    '/api/plugins/:pluginName/reload',
    authConfigAPI,
    asyncHandler(pluginController.reloadPlugin),
  )
  app.post(
    '/api/plugins/:pluginName/toggle',
    authConfigAPI,
    asyncHandler(pluginController.togglePlugin),
  )
  app.post(
    '/api/plugins/reload-all',
    authConfigAPI,
    asyncHandler(pluginController.reloadAllPlugins),
  )

  // 生图适配器 CRUD 与测试 API
  app.get('/api/images/adapters', authConfigAPI, asyncHandler(imageController.getImageAdapters))
  app.post('/api/images/adapters', authConfigAPI, asyncHandler(imageController.createImageAdapter))
  app.put('/api/images/adapters/:id', authConfigAPI, asyncHandler(imageController.updateImageAdapter))
  app.delete('/api/images/adapters/:id', authConfigAPI, asyncHandler(imageController.deleteImageAdapter))
  app.post('/api/images/test', authConfigAPI, asyncHandler(imageController.testImageGeneration))
  app.post('/api/images/models', authConfigAPI, asyncHandler(imageController.fetchImageModels))
  app.get('/api/images/tasks/:taskId', asyncHandler(imageController.getImageTask))

  // 搜索适配器 CRUD 与测试 API
  app.get('/api/search/adapters', authConfigAPI, asyncHandler(searchController.getSearchAdapters))
  app.post('/api/search/adapters', authConfigAPI, asyncHandler(searchController.createSearchAdapter))
  app.put('/api/search/adapters/:id', authConfigAPI, asyncHandler(searchController.updateSearchAdapter))
  app.delete('/api/search/adapters/:id', authConfigAPI, asyncHandler(searchController.deleteSearchAdapter))
  app.post('/api/search/test', authConfigAPI, asyncHandler(searchController.testSearch))
  // Shell 自动审批策略 API（后端权威名单管理）
  app.get('/api/shell/policy', authConfigAPI, asyncHandler(shellPolicyController.listShellRules))
  app.post('/api/shell/policy', authConfigAPI, asyncHandler(shellPolicyController.addShellRule))
  app.delete('/api/shell/policy/:id', authConfigAPI, asyncHandler(shellPolicyController.removeShellRule))
  // 渠道管理 API（微信等 channel 的添加/绑定/启停）
  app.get('/api/channels', authConfigAPI, asyncHandler(channelController.listChannels))
  app.get('/api/channels/catalog', authConfigAPI, asyncHandler(channelController.getChannelPlatformCatalog))
  app.get('/api/channels/:id', authConfigAPI, asyncHandler(channelController.getChannel))
  app.post('/api/channels', authConfigAPI, asyncHandler(channelController.createChannel))
  app.post('/api/channels/:id/qrcode', authConfigAPI, asyncHandler(channelController.getChannelQrcode))
  app.post('/api/channels/:id/poll', authConfigAPI, asyncHandler(channelController.pollChannelQr))
  app.put('/api/channels/:id', authConfigAPI, asyncHandler(channelController.updateChannel))
  app.post('/api/channels/:id/start', authConfigAPI, asyncHandler(channelController.startChannel))
  app.post('/api/channels/:id/stop', authConfigAPI, asyncHandler(channelController.stopChannel))
  app.delete('/api/channels/:id', authConfigAPI, asyncHandler(channelController.deleteChannel))

  // 识图服务配置与测试 API
  app.get('/api/vision/config', authConfigAPI, asyncHandler(visionController.getVisionConfig))
  app.put('/api/vision/config', authConfigAPI, asyncHandler(visionController.updateVisionConfig))
  app.post('/api/vision/test', authConfigAPI, asyncHandler(visionController.testVision))


  // 完成文件上传端点
  app.post('/api/upload/finalize', guestUploadAuth, fileController.finalizeUpload)
  // 图片上传端点
  app.post(
    '/api/upload/image',
    guestUploadAuth,
    upload.single('image'),
    imageController.uploadImage,
  )
  app.post(
    '/api/upload/chunk',
    guestUploadAuth,
    upload.single('file'),
    fileController.uploadChunk,
  )
  // QQ头像路由
  app.get('/p/qava', imageController.getQQAvatar)
  // 模型头像路由
  app.get('/p/mava', imageController.getModelAvatar)
  // 文件下载端点
  app.get('/f/gen/:type/:name', fileController.serveGeneratedFile)
  app.get('/f/up/:type/:name', fileController.serveUploadedFile)

  
  // Webhook 路由（GitHub 自动部署）
  app.post('/api/webhook', asyncHandler(webhookController.postWebhook))
  app.post('/api/webhook/demo', authConfigAPI, asyncHandler(webhookController.getDemo))

// OpenAI 聚合代理路由
  app.get('/oai-proxy/v1/models', asyncHandler(oaiProxyController.listModels))
  app.post(
    '/oai-proxy/v1/chat/completions',
    asyncHandler(oaiProxyController.chatCompletions)
  )

  // API 404 兜底：所有 /api/* 未匹配到的请求返回 404 JSON，严禁被 SPA 通配符吞入返回 HTML
  app.use('/api', (req, res) => {
    res.status(404).json({
      code: 404,
      message: `API 接口未找到: ${req.method} ${req.originalUrl || req.url}`,
    })
  })

  // 通配符路由，返回前端页面, 放在最后
  app.get(/.*/, (req, res) => 
    // logger.info(`GET *: 提供前端页面 ${path.join(process.cwd(), '/dist/index.html')}`) // process.cwd() 和 currentDir 相同
    res.sendFile(path.join(distDir, 'index.html')) // 使用 distDir 更简洁
  )

  // 统一的错误处理中间件：/api 下所有错误一律返回 JSON，严禁返回 Express 默认 HTML
  app.use((err, req, res, next) => {
    if (!err) return next()
    const isBodyParseError =
      err.name === 'MulterError' ||
      err.name === 'LimitFileSizeError' ||
      /multipart|form|boundary|body|json/i.test(err.message || '')
    const status = err.status || err.statusCode || (isBodyParseError ? 400 : 500)
    const message = err.message || 'Internal Server Error'

    if (isBodyParseError) {
      logger.warn(`[HTTP] 请求体解析失败: ${message}`)
    } else {
      logger.error(`[HTTP] 路由处理异常 [${req.method} ${req.originalUrl || req.url}]:`, err)
    }

    if (req.originalUrl?.startsWith('/api') || req.path?.startsWith('/api') || req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(status).json({
        code: 1,
        data: null,
        message,
      })
    }
    next(err)
  })
  // 启动服务器
  // 环境变量优先级最高
  const port = process.env.PORT
    ? parseInt(process.env.PORT, 10)
    : (config.server.port ?? 3080)
  // 强制使用 IPv4 地址，避免 IPv6 引起的隐形双开
  const host = process.env.HOST || config.server.host || '0.0.0.0'
  const server = app.listen(port, host, () => {
    logger.info(
      `服务启动成功: http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port} (IPv4 Only)`,
    )
  })

  // 设置服务器超时时间（6分钟，给调试接口足够时间）
  server.timeout = 6 * 60 * 1000 // 6分钟
  server.keepAliveTimeout = 6 * 60 * 1000 // 6分钟

  // Socket.io处理
  // 使用全局中间件实例而不是创建新的实例
  if (!global.middleware) {
    const Middleware = (await import('../../middleware.js')).default
    global.middleware = new Middleware()
  }
  global.middleware.enableSocketServer(server)

  // 返回服务器实例以便在主应用中管理
  return server
}
