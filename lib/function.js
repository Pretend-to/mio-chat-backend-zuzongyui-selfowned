import path from 'path'
import hookManager from './hooks/index.js'
import { HOOK_POINTS } from './hooks/types.js'
import { generateHash } from '../utils/hash.js'
import storageService from './storage/StorageService.js'
import { shellPolicyService } from './database/services/ShellPolicyService.js'

class MioFunction {
  constructor({
    name,
    func,
    description,
    parameters,
    timeout,
    adminOnly = false,
    channelOnly = false,
    groupOnly = false,
  }) {
    this.func = func
    this.description = description
    this.parameters = parameters
    this.timeout = timeout || 300
    this.adminOnly = adminOnly // 是否仅限管理员执行
    this.channelOnly = channelOnly // 是否仅限渠道端（微信等）使用，对 web 端屏蔽
    this.groupOnly = groupOnly // 是否仅限群聊多 Agent 场景使用，对单聊场景屏蔽
    this.hash = generateHash(JSON.stringify({ description, name, parameters }))
    this.name = `${name  }_mid_${  this.hash}` // 生成唯一的函数名称
    this.parentPlugin = null

    // 强制禁止覆盖 run() 方法以确保权限校验不会被跳过
    if (this.run !== MioFunction.prototype.run) {
      throw new Error(`[Security Error] Class "${this.constructor.name}" attempts to override final method "run()". Please use "func" property or another method name instead to ensure security checks are preserved.`)
    }
  }
  getDisplayName(_params) {
    return null
  }
  async run(e) {
    // 1. 构建执行上下文
    const ctx = {
      config: this.getPluginConfig(), // 获取当前插件配置供 Hook 使用
      event: e,
      params: e.params,
      plugin: this.parentPlugin,
      startTime: Date.now(),
      tool: this,
      user: e.user, // 显式提取用户信息
    }

    // 2. 执行全局钩子 (Builtins + Propagated Hooks)
    const globalAllowed = await hookManager.execute(HOOK_POINTS.TOOL_BEFORE_EXECUTE, ctx)
    if (!globalAllowed) {
      if (ctx.consumed) {return ctx.result}
      throw new Error(ctx.error || 'Blocked by system policy')
    }

    // 3. 执行插件私有钩子 (不影响其他插件工具)
    if (this.parentPlugin?.hooks) {
      const pluginAllowed = await this.parentPlugin.hooks.execute(
        HOOK_POINTS.TOOL_BEFORE_EXECUTE,
        ctx,
      )
      if (!pluginAllowed) {
        if (ctx.consumed) {return ctx.result}
        throw new Error(ctx.error || 'Blocked by plugin policy')
      }
    }

    // 4. 业务逻辑执行
    let result
    try {
      result = await this.func(e)
      ctx.result = result
    } catch (error) {
      ctx.error = error
      await hookManager.execute(HOOK_POINTS.TOOL_ON_ERROR, ctx)
      if (this.parentPlugin?.hooks) {
        await this.parentPlugin.hooks.execute(HOOK_POINTS.TOOL_ON_ERROR, ctx)
      }

      return ctx.consumed
        ? ctx.result
        : { error: error.message, success: false }
    }

    // 5. 执行后处理钩子
    await hookManager.execute(HOOK_POINTS.TOOL_AFTER_EXECUTE, ctx)
    if (this.parentPlugin?.hooks) {
      await this.parentPlugin.hooks.execute(HOOK_POINTS.TOOL_AFTER_EXECUTE, ctx)
    }

    return ctx.result
  }
  getDescription(_context = null) {
    return this.description
  }

  getParameters(_type = null, _context = null) {
    return this.parameters
  }

  json(type, context = null) {
    const classicTypes = ['openai', 'deepseek']
    const unsupportedOneOfTypes = ['gemini', 'vertex', 'vertexExpress', 'agentPlatform']
    const extraInputSchemaTypes = ['claude']
    const flatTypes = ['openai-responses', 'xai'] // 扁平化结构，name/description 在 type 下一级而不在 function 下一级

    const currentDescription = typeof this.getDescription === 'function' ? this.getDescription(context) : this.description
    const currentParameters = typeof this.getParameters === 'function' ? this.getParameters(type, context) : this.parameters

    let data
    if (classicTypes.includes(type)) {
      data = {
        function: {
          description: currentDescription,
          name: this.name,
          parameters: currentParameters,
        },
        type: 'function',
      }
    } else if (unsupportedOneOfTypes.includes(type)) {
      const baseSechma = {
        description: currentDescription,
        name: this.name,
        parameters: currentParameters,
      }
      data = this.adaptUnsupportedOneOf(baseSechma)
    } else if (flatTypes.includes(type)) {
      data = {
        description: currentDescription,
        name: this.name,
        parameters: currentParameters,
        type: 'function',
      }
    } else if (extraInputSchemaTypes.includes(type)) {
      data = {
        description: currentDescription,
        input_schema: currentParameters,
        name: this.name,
      }
    } else {
      // 默认按照 classic 处理
      data = {
        function: {
          description: currentDescription,
          name: this.name,
          parameters: currentParameters,
        },
        type: 'function',
      }
    }

    return data
  }

  setPlugin(plugin) {
    this.parentPlugin = plugin
  }

  adaptUnsupportedOneOf(baseSechma) {
    const { parameters } = baseSechma
    if (parameters.type === 'object') {
      for (const key in parameters.properties) {
        if (parameters.properties[key].oneOf) {
          // 随机获取里面的一个对象拿出来 (6)
          const randomIndex = Math.floor(
            Math.random() * parameters.properties[key].oneOf.length,
          )
          parameters.properties[key] =
            parameters.properties[key].oneOf[randomIndex]
        }
      }
    }
    return baseSechma
  }

  async getImgUrlFromBuffer(baseUrl, data) {
    try {
      const { bufferToImageUrl } = await import('../utils/imgTools.js')
      return await bufferToImageUrl(baseUrl, data)
    } catch (error) {
      console.error('Error processing image data:', error)
      throw new Error(`Failed to save image: ${  error.message}`, { cause: error })
    }
  }

  async saveTextFile(baseUrl, data, name) {
    try {
      // 根据扩展名自动识别 Content-Type，防止 S3 默认视为下载
      const ext = path.extname(name).toLowerCase()
      const mimeMap = {
        '.css': 'text/css',
        '.htm': 'text/html',
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.json': 'application/json',
        '.md': 'text/markdown',
        '.txt': 'text/plain',
      }
      const contentType = mimeMap[ext] || 'application/octet-stream'

      const result = await storageService.upload(Buffer.from(data), name, 'file', {
        contentType,
      })
      // 如果返回的是相对路径，补全 baseUrl
      return result.url.startsWith('http') ? result.url : `${baseUrl}${result.url}`
    } catch (error) {
      console.error('Error saving text file:', error)
      throw new Error(`Failed to save file: ${  error.message}`, { cause: error })
    }
  }

  async saveBinaryFile(baseUrl, data, name, type = 'file') {
    try {
      const ext = path.extname(name).toLowerCase()
      const mimeMap = {
        '.gif': 'image/gif',
        '.jpeg': 'image/jpeg',
        '.jpg': 'image/jpeg',
        '.m4a': 'audio/mp4',
        '.mp3': 'audio/mpeg',
        '.ogg': 'audio/ogg',
        '.pdf': 'application/pdf',
        '.png': 'image/png',
        '.wav': 'audio/wav',
        '.webp': 'image/webp',
      }
      const contentType = mimeMap[ext] || 'application/octet-stream'

      const result = await storageService.upload(Buffer.from(data), name, type, {
        contentType,
      })
      // If result.url is already a full URL, return it, otherwise prepend baseUrl
      return result.url.startsWith('http') ? result.url : `${baseUrl}${result.url}`
    } catch (error) {
      console.error('Error saving binary file:', error)
      throw new Error(`Failed to save binary file: ${  error.message}`, { cause: error })
    }
  }

  getPluginConfig() {
    if (this.parentPlugin) {
      // 返回缓存的配置，而不是异步加载
      return this.parentPlugin.config || {}
    } else {
      return {}
    }
  }

  /**
   * 在前端展示就地选择浮层，阻塞挂起工具 Promise 进程直到用户操作或超时
   * @param {object} e 事件上下文 RequestEvent (LLMMessageEvent)
   * @param {object} options 选择项配置
   * @returns {Promise<object>} 用户选择的载荷
   */
  async showSelectOverlay(e, options) {
    const interactionId = `interact_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
    
    // 推送 action 类型的流式更新，提示前端拉起面板
    e.update({
      content: {
        actionType: 'SHOW_SELECT_OVERLAY',
        interactionId,
        options: options.options || options,
        prompt: options.prompt || '请选择一个选项：'
      },
      type: 'action'
    })

    return new Promise((resolve, reject) => {
      e.registerInteraction(interactionId, (data) => {
        if (e._activeToolCallData) {
          e._activeToolCallData.startTime = Date.now()
          e.update({
            content: {
              ...e._activeToolCallData,
              action: 'running',
              startTime: e._activeToolCallData.startTime,
            },
            type: 'toolCall'
          })
        }
        resolve(data) // 唤醒并返回
      })

      // 60秒超时防护，注销交互并抛错
      setTimeout(() => {
        if (e.unregisterInteraction(interactionId)) {
          reject(new Error('交互选择超时，用户未在规定时间内进行操作。'))
        }
      }, 60_000)
    })
  }

  /**
   * 请求用户对高危指令的二次授权确认
   * @param {object} e 事件上下文 RequestEvent (LLMMessageEvent)
   * @param {string} prompt 授权提示文字
   * @returns {Promise<boolean>} 是否授权
   */
  async requestUserApproval(e, prompt, meta = {}) {
    const interactionId = `interact_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`

    // Shell 命令的展示/白名单候选只保留前两个词；原始命令仍由调用方闭包保存并执行，
    // 不把动态参数展示或持久化到用户白名单中。
    const { prefix1: commandPrefix1, prefix2: commandPrefix2 } = shellPolicyService.getCommandPrefixes(meta.command)
    
    // —— 展示层瘦身（移动端聊天窗口友好）：二次确认内容按类型截断，仅影响前端展示，
    //    不影响授权后的实际执行（执行逻辑使用调用方闭包中的原始参数） ——
    const APPROVAL_PROMPT_LIMIT = 600
    const APPROVAL_META_LIMITS = { command: 600, content: 500, html: 400, code: 400, diff: 600 }
    const APPROVAL_META_DEFAULT = 300
    const truncateForApproval = (text, limit) => {
      if (typeof text !== 'string' || text.length <= limit) return text
      const head = text.slice(0, limit)
      return `${head}\n…（展示已截断：原文共 ${text.length} 字符，完整内容将在授权后正常执行）`
    }
    const displayPrompt = truncateForApproval(prompt, APPROVAL_PROMPT_LIMIT)
    const displayMeta = {}
    for (const [k, v] of Object.entries(meta || {})) {
      if (typeof v === 'string') {
        displayMeta[k] = truncateForApproval(v, APPROVAL_META_LIMITS[k] ?? APPROVAL_META_DEFAULT)
      } else if (v !== null && typeof v === 'object') {
        let str
        try { str = JSON.stringify(v) } catch { str = String(v) }
        displayMeta[k] = truncateForApproval(str, APPROVAL_META_LIMITS[k] ?? APPROVAL_META_DEFAULT)
      } else {
        displayMeta[k] = v
      }
    }
    if (commandPrefix1) {
      if (meta.rememberable === false) {
        // 不可记住的危险/不安全命令必须展示完整 payload，避免用户只看到前缀却批准了隐藏后缀。
        displayMeta.command = meta.command
        displayMeta.commandPreview = meta.command
      } else {
        displayMeta.command = commandPrefix2
        displayMeta.commandPreview = commandPrefix2 || commandPrefix1
        displayMeta.commandPrefix1 = commandPrefix1
        displayMeta.commandPrefix2 = commandPrefix2 || commandPrefix1
      }
    }
    e.update({
      content: {
        actionType: 'REQUEST_APPROVAL',
        interactionId,
        meta: displayMeta,
        prompt: displayPrompt
      },
      type: 'action'
    })

    return new Promise((resolve) => {
      e.registerInteraction(interactionId, (data) => {
        if (e._activeToolCallData) {
          e._activeToolCallData.startTime = Date.now()
          e.update({
            content: {
              ...e._activeToolCallData,
              action: 'running',
              startTime: e._activeToolCallData.startTime,
            },
            type: 'toolCall'
          })
        }
        resolve({
          approved: Boolean(data.approved),
          reason: data.reason || null,
          // 前端“授权并记住”的标记：prefix2/prefix1，无则 null
          rememberType: data.rememberType || null
        })
      })
    })
  }

  /**
   * 向前端推送预设的 UI 渲染配置
   * @param {object} e 事件上下文 RequestEvent (LLMMessageEvent)
   * @param {Array<object>} renders 渲染项列表，如 [{ type: 'image', url: '...' }]
   */
  setExtraRender(e, renders) {
    if (e && typeof e.setExtraRender === 'function') {
      e.setExtraRender(renders)
    }
  }

  setOuterRender(e, renders) {
    if (e && typeof e.setOuterRender === 'function') {
      e.setOuterRender(renders)
    }
  }
}

export { MioFunction }
