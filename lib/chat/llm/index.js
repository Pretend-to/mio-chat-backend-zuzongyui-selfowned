import config from '../../config.js'
import skillService from './services/SkillService.js'
import SystemSettingsService from '../../database/services/SystemSettingsService.js'
import hookManager from '../../hooks/index.js'
import { HOOK_POINTS } from '../../hooks/types.js'
import { modelRegistryService } from './adapters/registry.js'
import { parseConcatenatedJson } from '../../../utils/jsonParser.js'


/**
 * 判断请求事件是否来源于渠道端（微信等），用于 channelOnly 工具的可见性与装配过滤。
 * 与 lib/plugins/channel-manager-plugin/hooks/ChannelToolsInjectorHook.js 的判定保持一致。
 */
function isChannelEvent(context) {
  if (!context) return false
  return Boolean(
    context.channel ||
    context.user?.channel ||
    context.body?.channel ||
    context.user?.channelType ||
    context.user?.role === 'channel_master' ||
    (typeof context.requestId === 'string' &&
      (context.requestId.startsWith('wechat_') || context.requestId.startsWith('channel_')))
  )
}

/**
 * 判断请求事件是否来源于群聊多 Agent 场景（Web 多 Agent 群聊或渠道群聊），
 * 用于 groupOnly 工具的可见性与装配过滤。
 */
function isGroupEvent(context) {
  if (!context) return false
  return Boolean(
    context.isGroup ||
    context.platform === 'group' ||
    context.metaData?.memberId ||
    context.event?.metaData?.memberId ||
    context.body?.metaData?.memberId ||
    context.body?.memberId ||
    context.channel?.isGroup ||
    context.user?.isGroup
  )
}
class LLMChatService {
  constructor() {
    this.llms = {} // Key: instanceId, value: adapter instance
    this.instanceMetadata = {} // Key: instanceId, value: { adapterType, displayName }
    this.presets = null
    this.plugins = []
    
    // Initialize skills
    skillService.initialize().catch(error => {
        logger.error('Failed to initialize SkillService:', error)
    })
  }

  /**
   * 清空所有适配器实例（用于热重载）
   */
  clearAll() {
    logger.info('清空所有LLM适配器实例...')
    this.llms = {}
    this.instanceMetadata = {}
  }

  /**
   * 删除单个适配器实例
   */
  removeInstance(instanceId) {
    if (this.llms[instanceId]) {
      logger.info(`删除适配器实例: ${instanceId}`)
      delete this.llms[instanceId]
      delete this.instanceMetadata[instanceId]
      return true
    }
    return false
  }

  /**
   * 更新单个适配器实例
   */
  async updateInstance(instanceId, adapterType, displayName, instanceConfig) {
    logger.info(`更新适配器实例: ${instanceId}`)
    
    // 先删除旧实例
    this.removeInstance(instanceId)
    
    // 重新初始化
    return new Promise((resolve) => {
      this.initServer(instanceId, adapterType, displayName, instanceConfig, (error) => {
        if (error) {
          logger.error(`实例 ${instanceId} 更新失败:`, error)
          resolve({ error: error.message, success: false })
        } else {
          logger.info(`实例 ${instanceId} 更新成功`)
          resolve({ success: true })
        }
      })
    })
  }

  /**
   * 添加单个适配器实例
   */
  async addInstance(instanceId, adapterType, displayName, instanceConfig) {
    logger.info(`添加适配器实例: ${instanceId}`)
    
    return new Promise((resolve) => {
      this.initServer(instanceId, adapterType, displayName, instanceConfig, (error) => {
        if (error) {
          logger.error(`实例 ${instanceId} 添加失败:`, error)
          resolve({ error: error.message, success: false })
        } else {
          logger.info(`实例 ${instanceId} 添加成功`)
          resolve({ success: true })
        }
      })
    })
  }

  /**
   * 刷新单个实例的模型列表
   */
  async refreshInstanceModels(instanceId) {
    const llm = this.llms[instanceId]
    if (!llm) {
      logger.warn(`实例 ${instanceId} 不存在`)
      return { error: '实例不存在', success: false }
    }

    // 获取实例的显示名称
    const displayName = this.instanceMetadata[instanceId]?.displayName || instanceId

    try {
      logger.info(`刷新实例 ${displayName} 的模型列表`)
      // 使用 refreshModels 而不是 loadModels
      if (typeof llm.refreshModels === 'function') {
        const result = await llm.refreshModels()
        if (result && result.success && this.instanceMetadata[instanceId]) {
           this.instanceMetadata[instanceId].status = 'connected'
           this.instanceMetadata[instanceId].errorMsg = null
        }
      } else {
        // 如果适配器没有实现 refreshModels，则使用 loadModels
        const result = await llm.loadModels()
        if (result && this.instanceMetadata[instanceId]) {
          this.instanceMetadata[instanceId].status = result.success ? 'connected' : 'error'
          this.instanceMetadata[instanceId].errorMsg = result.success ? null : result.error
        }
      }
      logger.info(`实例 ${displayName} 模型列表刷新成功`)
      return { displayName, success: true }
    } catch (error) {
      if (this.instanceMetadata[instanceId]) {
        this.instanceMetadata[instanceId].status = 'error'
        this.instanceMetadata[instanceId].errorMsg = error.message
      }
      logger.error(`实例 ${displayName} 模型列表刷新失败:`, error)
      return { displayName, error: error.message, success: false }
    }
  }

  /**
   * 刷新所有实例的模型列表
   */
  async refreshAllModels() {
    logger.info('刷新所有实例的模型列表')
    const results = []
    
    for (const instanceId of Object.keys(this.llms)) {
      const result = await this.refreshInstanceModels(instanceId)
      results.push({
        displayName: this.instanceMetadata[instanceId]?.displayName,
        instanceId,
        ...result
      })
    }
    
    const successCount = results.filter(r => r.success).length
    logger.info(`模型列表刷新完成: ${successCount}/${results.length} 成功`)
    
    return results
  }

  async initServer(instanceId, adapterType, displayName, instanceConfig, finalCallback) {
    try {
      // 动态导入适配器 - 不再硬编码
      const adapterPath = `./adapters/implementations/${adapterType}.js`
      let AdapterClass
      
      try {
        const module = await import(adapterPath)
        AdapterClass = module.default
      } catch (importError) {
        const errorMessage = `Failed to import adapter: ${adapterType} (${adapterPath})`
        logger.error(errorMessage, importError)
        throw new Error(errorMessage, { cause: importError })
      }
      
      if (!AdapterClass) {
        const errorMessage = `Adapter class not found for type: ${adapterType}`
        logger.error(errorMessage)
        throw new Error(errorMessage)
      }
      
      // 预处理配置（特别是 Vertex AI 的认证配置）
      const preparedConfig = { ...instanceConfig }
      
      if (adapterType === 'vertex') {
        // 处理 Vertex 认证配置
        if (instanceConfig.service_account_json && instanceConfig.service_account_json.trim()) {
          try {
            preparedConfig.authConfig = JSON.parse(instanceConfig.service_account_json)
          } catch (error) {
            logger.error(`[${displayName}] Vertex service_account_json 解析失败:`, error.message)
          }
        }
      }

      // 为 geminiOauth 适配器注入 onConfigUpdate 回调，将认证凭证持久化回数据库
      if (adapterType === 'geminiOauth' && !preparedConfig.onConfigUpdate) {
        preparedConfig.onConfigUpdate = async (updates) => {
          try {
            const { updateConfigSection } = await import('../../server/http/services/configService.js')
            const llmAdaptersSetting = await SystemSettingsService.get('llm_adapters')
            if (!llmAdaptersSetting || !llmAdaptersSetting.value) {return}

            const allAdapters = llmAdaptersSetting.value
            const instances = allAdapters['geminiOauth']
            if (!Array.isArray(instances)) {return}

            // 找到对应实例的索引（按 instanceId / displayName 匹配，计算已启用实例的 displayName，与 getLLMEnabled 逻辑保持一致）
            let enabledCounter = 0
            let targetIndex = -1
            
            for (let i = 0; i < instances.length; i++) {
              const inst = instances[i]
              if (inst.enable) {
                enabledCounter++
              }
              
              // 1. 如果有自定义 name，直接精确匹配
              if (inst.name && inst.name === instanceId) {
                targetIndex = i
                break
              }
              
              // 2. 如果是自动生成的名称，且 inst.enable 并且自动生成的名称匹配 instanceId
              if (inst.enable) {
                const generatedName = `${adapterType}-${enabledCounter}`
                if (generatedName === instanceId) {
                  targetIndex = i
                  break
                }
              }
            }

            // 3. Fallback 兜底逻辑：如果前面的策略全都没找到（例如是 disabled 实例被更新，或者临时测试），
            // 且 instanceId 符合 'geminiOauth-N' 格式，我们退化为匹配数组的第 N 个实例（不管是否启用）
            if (targetIndex === -1) {
              const numMatch = instanceId.match(/geminiOauth-(\d+)/)
              if (numMatch) {
                const idx = parseInt(numMatch[1], 10) - 1
                if (idx >= 0 && idx < instances.length) {
                  targetIndex = idx
                }
              }
            }

            if (targetIndex === -1) {
              logger.warn(`[Gemini OAuth][onConfigUpdate] 无法在数据库中定位实例 ${instanceId}，跳过持久化`)
              return
            }

            // 合并更新字段（只写非 undefined 的字段）
            const existingInst = instances[targetIndex]
            const mergedInst = { ...existingInst }
            for (const [k, v] of Object.entries(updates)) {
              if (v !== undefined) {mergedInst[k] = v}
            }
            allAdapters['geminiOauth'][targetIndex] = mergedInst

            await updateConfigSection('llm_adapters', allAdapters, { skipReload: true })
            logger.info(`[Gemini OAuth][onConfigUpdate] 持久化凭证成功: instanceId=${instanceId}, keys=${Object.keys(updates).join(',')}`)
          } catch (error) {
            logger.error(`[Gemini OAuth][onConfigUpdate] 持久化凭证失败: ${error.message}`)
          }
        }
      }
      
      // 实例化适配器
      const llm = new AdapterClass(preparedConfig)

      if (!llm) {
        const errorMessage = `Failed to initialize LLM of type: ${adapterType}`
        logger.error(errorMessage)
        throw new Error(errorMessage)
      }

      // 先创建实例，再尝试加载模型
      this.llms[instanceId] = llm
      this.instanceMetadata[instanceId] = { 
        adapterType, 
        displayName, 
        errorMsg: null, 
        status: 'connecting'
      }

      // 尝试加载模型（失败不影响实例创建）
      const modelLoadResult = await llm.loadModels()
      if (this.instanceMetadata[instanceId]) {
        if (modelLoadResult.success) {
          this.instanceMetadata[instanceId].status = 'connected'
          this.instanceMetadata[instanceId].errorMsg = null
          logger.debug(`[${displayName}] 模型加载成功`)
        } else {
          this.instanceMetadata[instanceId].status = 'error'
          this.instanceMetadata[instanceId].errorMsg = modelLoadResult.error || '模型加载失败'
          logger.warn(`[${displayName}] 模型加载失败: ${modelLoadResult.error || '未知错误'}`)
        }
      } else {
        logger.warn(`[${displayName}] 实例元数据已被清除或重置，跳过状态更新`)
      }

      finalCallback()
      return llm
    } catch (error) {
      finalCallback(error)
    }
  }

  async handleMessage(e) {
    try {
      const { settings } = e.body
      const providerName = settings?.provider || this._getDefaultProvider()

      // 通过 displayName 查找 instanceId
      const instanceId = this._findInstanceIdByDisplayName(providerName)
      const llm = this.llms[instanceId]
      const adapterType = this.instanceMetadata[instanceId]?.adapterType

      logger.info(`[LLMChatService] Handling message for provider: ${providerName}, instanceId: ${instanceId}, adapterType: ${adapterType}`)

      if (!llm) {
        // 发送错误消息给用户
        const errorMessage = `您选择的模型或渠道 "${providerName}" 已失效，请重新选择模型。`
        e.error(new Error(errorMessage))

        // 推送最新的模型列表给所有客户端
        this._broadcastModelsUpdate()

        return
      }

      // 3. 执行 LLM 前置钩子 (允许插件拦截或修改消息)
      const ctx = {
        adapterType,
        event: e,
        instanceId,
        llm,
        llmService: this, // 注入 service 供钩子调用内部校验逻辑
        providerName
      }

      const allowed = await hookManager.execute(HOOK_POINTS.LLM_BEFORE_CHAT, ctx)
      if (!allowed) {
        if (ctx.consumed) {return} // 钩子已处理
        throw new Error(ctx.error || '请求被系统策略拦截')
      }

      llm.handleChatRequest(e)
    } catch (error) {
      logger.error(error)
      e.error(error)
    }
  }

  /**
   * 自动总结对话标题
   * @param {Array} messages 对话历史
   * @returns {Promise<string|null>} 总结出的标题
   */
  /**
   * 为对话生成一个简短的标题
   * @param {Array} messages - 消息历史
   * @returns {Promise<string|null>} 生成的标题
   */
  async generateChatTitle(messages) {
    try {
      const channelSetting = await SystemSettingsService.get('system_llm_channel')
      const channelId = channelSetting?.value
      
      const promptSetting = await SystemSettingsService.get('system_llm_title_prompt')
      const prompt = promptSetting?.value || '请根据这段对话内容，为这个会话起一个极其简短、精准的标题（不超过 6 个字）。注意：你的回答只能包含标题本身，不要包含任何标点符号、解释或引用。'

      const llm = this.llms[channelId] || Object.values(this.llms)[0]
      if (!llm) {return null}

      // 仅保留用户与助手的实际文本对话，排除推理链、系统消息、工具调用及庞大的工具执行结果
      const filteredMessages = messages.filter(m => 
        (m.role === 'user' || m.role === 'assistant') && 
        m.content !== undefined && 
        m.content !== null
      )

      // 仅取极少量的关键消息（至至多 3 条：第一条定调消息 + 最近 2 条最新对话），以极大地减少 token 消耗
      let selectedMessages = filteredMessages
      if (filteredMessages.length > 3) {
        selectedMessages = [filteredMessages[0], ...filteredMessages.slice(-2)]
      }

      const cleanContext = selectedMessages.map(m => {
        let textContent = ''
        if (typeof m.content === 'string') {
          textContent = m.content
        } else if (Array.isArray(m.content)) {
          // 仅提取纯文本部分，过滤掉庞大的 base64 图片数据或媒体对象
          textContent = m.content
            .filter(part => part && part.type === 'text')
            .map(part => part.text)
            .join('\n')
        } else if (m.content) {
          textContent = JSON.stringify(m.content)
        }

        // 单条消息截断长度从 1000 压缩至 300 字符，大意已足够生成标题
        if (textContent.length > 300) {
          textContent = `${textContent.substring(0, 300)  }...`
        }

        return {
          content: textContent,
          role: m.role
        }
      })

      const { InternalEventFactory } = await import('./utils/InternalEventFactory.js')
      
      const targetModel = llm.models[0]?.models?.[0]
      logger.info(`[LLMChatService] Generating chat title. Model: ${targetModel} (provider: ${llm.provider}), Context Messages Count: ${cleanContext.length}`)

      let resultText = ''
      const event = InternalEventFactory.createSimpleEvent({
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: `对话内容：\n${JSON.stringify(cleanContext)}` }
        ],
        model: targetModel,
        onContent: (content) => { resultText += content },
        requestId: `system_title_${Date.now()}`
      })

      await llm.handleChatRequest(event)
      const generatedTitle = resultText.trim() || null
      logger.info(`[LLMChatService] Chat title generated: "${generatedTitle}"`)
      return generatedTitle
    } catch (error) {
      logger.error('[LLMChatService] Chat title generation failed:', error)
      return null
    }
  }

  /**
   * 通过 displayName 查找 instanceId
   * @private
   */
  _findInstanceIdByDisplayName(displayName) {
    for (const [instanceId, metadata] of Object.entries(this.instanceMetadata)) {
      if (metadata.displayName === displayName) {
        return instanceId
      }
    }
    // 如果找不到，尝试直接使用 displayName 作为 instanceId（兼容旧逻辑）
    return displayName
  }

  /**
   * 获取默认的 provider
   * @private
   */
  _getDefaultProvider() {
    // 返回第一个可用的实例的 displayName
    const firstInstanceId = Object.keys(this.llms)[0]
    if (firstInstanceId && this.instanceMetadata[firstInstanceId]) {
      return this.instanceMetadata[firstInstanceId].displayName
    }
    return 'openai' // 后备默认值
  }

  getModelList(isAdmin) {
    const models = {}
    for (const instanceId in this.llms) {
      const metadata = this.instanceMetadata[instanceId]
      const displayName = metadata?.displayName || instanceId

      models[displayName] = isAdmin
        ? [...this.llms[instanceId].models]
        : [...this.llms[instanceId].guestModels]
    }
    return models
  }

  /**
   * 获取模型规格元数据映射（与 getModelList 同构，按权限筛选）。
   * 叶子为 Registry 规格决策结果，供前端展示 ctx/watermark/vision 等。
   * 结果: { providerName: { modelName: { matchSource, maxInput, watermark, vision, fc, reasoning } } }
   */
  getModelMetaMap(isAdmin) {
    const result = {}
    for (const instanceId in this.llms) {
      const metadata = this.instanceMetadata[instanceId]
      const displayName = metadata?.displayName || instanceId
      // models 结构为按所有者分组的数组: [{ group, owner, models: [...] }]
      const groups = isAdmin
        ? [...this.llms[instanceId].models]
        : [...this.llms[instanceId].guestModels]

      const providerMeta = {}
      for (const group of groups) {
        if (!group || !Array.isArray(group.models)) continue
        for (const model of group.models) {
          if (typeof model !== 'string' || !model) continue
          const meta = modelRegistryService.getModelMetadata(model)
          providerMeta[model] = {
            matchSource: meta.matchSource,
            maxInput: meta.max_input_tokens,
            watermark: meta.crystallize_watermark,
            vision: meta.supports_vision,
            fc: meta.supports_function_calling,
            reasoning: meta.supports_reasoning,
          }
        }
      }
      if (Object.keys(providerMeta).length > 0) {
        result[displayName] = providerMeta
      }
    }
    return result
  }

  /**
   * 检查模型是否在游客可用列表中
   * @param {string} instanceId - 实例ID
   * @param {string} modelName - 模型名称
   * @returns {boolean} 是否允许游客使用
   * @private
   */
  _isGuestModelAllowed(instanceId, modelName) {
    try {
      const llm = this.llms[instanceId]
      if (!llm || !llm.guestModels) {
        return false
      }

      // 遍历游客模型列表，检查是否包含指定模型
      for (const owner of llm.guestModels) {
        if (owner.models && owner.models.includes(modelName)) {
          return true
        }
      }

      return false
    } catch (error) {
      logger.error(`检查游客模型权限失败: ${error.message}`)
      return false
    }
  }

  /**
   * 广播模型更新到所有客户端（根据权限筛选）
   * @private
   */
  async _broadcastModelsUpdate() {
    try {
      const providers = config.getProvidersAvailable()
      const default_model = await config.getDefaultModel()

      // 动态获取各适配器的元数据以注入描述，防止前端硬编码
      const metadataMap = {}
      try {
        const { getAdapterMetadataList } = await import('./adapters/registry.js')
        const metadataList = await getAdapterMetadataList()
        for (const meta of metadataList) {
          if (meta && meta.type) {
            metadataMap[meta.type.toLowerCase()] = meta
          }
        }
      } catch (error) {
        logger.warn('获取适配器元数据列表失败:', error.message)
      }

      if (global.middleware?.socketServer?.io) {
        // 异步获取所有连接的客户端
        global.middleware.socketServer.io.fetchSockets().then(sockets => {
          for (const socket of sockets) {
            const isAdmin = socket.userInfo?.isAdmin || false

            // 使用 getModelList 获取根据权限筛选的模型列表
            const filteredModels = this.getModelList(isAdmin)
            // 模型规格元数据（按权限筛选），供前端展示 ctx/watermark/vision
            const filteredModelsMeta = this.getModelMetaMap(isAdmin)

            // 根据可用模型过滤提供商
            const filteredProviders = providers.filter(provider => {
              const instanceId = provider.displayName
              const models = filteredModels[instanceId]
              return models && models.length > 0
            })

            // 将 default_model 和 description 集成到每个 provider 中
            const enrichedProviders = filteredProviders.map((provider) => {
              const meta = metadataMap[provider.adapterType?.toLowerCase()]
              return {
                ...provider,
                default_model: default_model[provider.displayName] || null,
                description: meta ? meta.description : '大语言模型适配器'
              }
            })

            const updateMessage = {
              data: {
                default_model,
                models: filteredModels,
                models_meta: filteredModelsMeta,
                providers: enrichedProviders,
                timestamp: new Date().toISOString()
              },
              protocol: 'system',
              type: 'models_updated'
            }

            socket.emit('message', JSON.stringify(updateMessage))
          }

          logger.info('[LLMChatService] 已向所有客户端推送模型更新（根据权限筛选）')
        }).catch(error => {
          logger.error('[LLMChatService] 获取客户端列表失败:', error)
        })
      }
    } catch (error) {
      logger.error('[LLMChatService] 推送模型更新失败:', error)
    }
  }

  
  getAllPresets() {
    return config.getAllPresets()
  }

  setPlugins(plugins) {
    this.plugins = plugins
  }

  serveToolsList() {
    const availableParams = ['name', 'description', 'parameters']
    const list = {}
    for (const plugin of this.plugins) {
      const pluginTools = plugin.getTools()
      for (const [pluginName, tools] of pluginTools) {
        const pluginList = {}
        for (const tool of tools) {
          if (tool.channelOnly) continue // channelOnly 工具对 web 端屏蔽
          const safeTool = {}
          for (const param of availableParams) {
            if (param === 'description') {
              safeTool.description = typeof tool.getDescription === 'function' ? tool.getDescription() : tool.description
            } else if (tool[param] !== undefined) {
              safeTool[param] = tool[param]
            }
          }
          pluginList[tool.name] = safeTool
        }
        list[pluginName] = pluginList
      }
    }
    return list
  }

  /**
   * Retrieves a list of LLM tools based on availability and provider.
   * @param {string[]} availableApps - An array of available application names.
   * @param {string} [provider='openai'] - The LLM provider ('openai' or 'gemini').
   * @returns {object[]} An array of LLM tool configurations.
   */
  getLLMTools(availableApps, provider, context = null) {
    const tools = []
    // 插件数组（this.plugins）reduce为Map，键为工具名，值为工具对象
    const allTools = this.getAllTools()
    // channelOnly 工具仅对渠道端请求装配，web 请求一律不可见
    const isChannel = isChannelEvent(context)
    // groupOnly 工具仅对群聊多 Agent 场景装配，单聊/私聊请求一律不可见
    const isGroup = isGroupEvent(context)
    // 遍历可用的应用名，检查是否有对应的工具
    for (const name of availableApps) {
      if (allTools.has(name)) {
        const tool = allTools.get(name)
        if (tool.channelOnly && !isChannel) continue
        if (tool.groupOnly && !isGroup) continue
        const toolConfig = tool.json(provider, context)
        tools.push(toolConfig)
      } else {
        // 兼容短名查找（例如 'draw', 'search', 'vision'）
        for (const [toolName, tool] of allTools.entries()) {
          if (toolName === name || toolName.startsWith(`${name}_mid_`)) {
            if (tool.channelOnly && !isChannel) continue
            if (tool.groupOnly && !isGroup) continue
            const toolConfig = tool.json(provider, context)
            tools.push(toolConfig)
            break
          }
        }
      }
    }
    return tools
  }

  /**
   * Execute a tool call with given user context and parameters.
   * Includes timeout control.
   * @param {object} toolCall - 工具调用对象，通常包含name和parameters字段
   * @param {object} user - 调用用户信息对象
   * @returns {Promise<object>} 调用结果，包含call和result字段
   */
  async runTool(toolCall, user, parentEvent = null) {
    try {
      const allTools = this.getAllTools()
      let app = allTools.get(toolCall.name)

      if (!app) {
        // 兼容短名查找（例如 'send_email', 'toolsmanager', 'bash', 'manage_email_templates'）
        for (const [toolFullName, toolObj] of allTools.entries()) {
          if (
            toolFullName === toolCall.name ||
            toolFullName.startsWith(`${toolCall.name}_mid_`) ||
            toolFullName.split('_mid_')[0] === toolCall.name
          ) {
            app = toolObj
            break
          }
        }
      }

      if (!app) {
        const ctx = {
          allTools,
          toolName: toolCall.name,
          user
        }
        
        // 触发 Hook 处理未找到的情况
        await hookManager.execute(HOOK_POINTS.TOOL_NOT_FOUND, ctx)
        
        const errorMsg = ctx.error || `未找到工具: ${toolCall.name}`
        logger.warn(`[runTool] ${errorMsg}`)

        // 返回一个虚拟的成功结果，内容是报错信息
        // 这样适配器会把这个字符串作为 tool result 发给 AI
        return {
          call: toolCall,
          result: `[System Error] ${errorMsg}`
        }
      }
      // channelOnly 工具仅允许渠道端（微信等）调用，web 请求一律拒绝
      if (app.channelOnly && !isChannelEvent(parentEvent)) {
        logger.warn(`[runTool] 工具 ${toolCall.name} 仅限渠道端使用，已拒绝当前请求`)
        return {
          call: toolCall,
          result: `[System Error] 工具 ${toolCall.name} 仅限渠道端使用`
        }
      }
      // groupOnly 工具仅允许群聊多 Agent 场景调用，单聊/私聊请求一律拒绝
      if (app.groupOnly && !isGroupEvent(parentEvent)) {
        logger.warn(`[runTool] 工具 ${toolCall.name} 仅限群聊多 Agent 场景使用，已拒绝当前请求`)
        return {
          call: toolCall,
          result: `[System Error] 工具 ${toolCall.name} 仅限群聊多 Agent 场景使用`
        }
      }
      let params = toolCall.parameters ?? '{}'
      try {
        params = typeof params === 'string' ? parseConcatenatedJson(params) : params
      } catch (error) {
        logger.warn('解析工具参数失败，使用默认空对象', error)
        params = {}
      }

      // 根据参数，动态生成高可读性的工具自定义显示名称并发射给前端
      if (app && typeof app.getDisplayName === 'function') {
        try {
          const displayName = app.getDisplayName(params)
          if (displayName) {
            toolCall.displayName = displayName
            // 实时推送带 displayName 的最新 toolCall 状态给前端
            if (parentEvent) {
              parentEvent.update({
                content: toolCall,
                type: 'toolCall'
              })
            }
          }
        } catch (error) {
          logger.warn('获取工具自定义显示名称失败', error)
        }
      }

      let timeoutTimer = null
      let isTimeoutCleared = false

      const e = {
        body: parentEvent?.body || {},
        channel: parentEvent?.channel,
        client: parentEvent?.client,
        memory: parentEvent?.memory,
        metaData: parentEvent?.metaData || {},
        params,
        parentEvent,
        sessionId: parentEvent?.sessionId || parentEvent?.body?.sessionId || null,
        user,
        // 传递终止状态
        get aborted() { return parentEvent?.aborted || false },
        onAbort: (cb) => parentEvent?.onAbort(cb),
        // 桥接交互式指令的底层支持，通过代理 parentEvent 使得 MioFunction 可直接挂起/唤醒并与 Socket 联调
        update: (chunk) => parentEvent?.update(chunk),
        setExtraRender: (renders) => {
          const processed = (renders || []).map(r => ({
            placement: 'inner',
            ...r
          }))
          const existingOuter = (toolCall.extraRender || []).filter(r => r.placement === 'outer')
          toolCall.extraRender = [...processed, ...existingOuter]
          if (parentEvent) {
            parentEvent.update({
              content: toolCall,
              type: 'toolCall'
            })
          }
        },
        setOuterRender: (renders) => {
          const processed = (renders || []).map(r => ({
            placement: 'outer',
            ...r
          }))
          const existingInner = (toolCall.extraRender || []).filter(r => r.placement !== 'outer')
          toolCall.extraRender = [...existingInner, ...processed]
          if (parentEvent) {
            parentEvent.update({
              content: toolCall,
              type: 'toolCall'
            })
          }
        },
        registerInteraction: (interactionId, callback) => {
          isTimeoutCleared = true
          if (timeoutTimer) {
            clearTimeout(timeoutTimer)
            timeoutTimer = null
          }
          parentEvent?.registerInteraction(interactionId, callback)
        },
        unregisterInteraction: (interactionId) => parentEvent?.unregisterInteraction(interactionId) || false,
        emitInteraction: (interactionId, data) => parentEvent?.emitInteraction(interactionId, data) || false
      }

      const timeoutSeconds =
        typeof app.timeout === 'number' && app.timeout > 0 ? app.timeout : 30

      // 1. 超时 Promise
      const timeoutPromise = new Promise((_, reject) => {
        if (isTimeoutCleared) {return}
        timeoutTimer = setTimeout(
          () => {
            if (!isTimeoutCleared) {
              reject(new Error(`执行超时，超过 ${timeoutSeconds} 秒`))
            }
          },
          timeoutSeconds * 1000,
        )
      })

      // 2. 终止 Promise (如果用户中途取消)
      const abortPromise = new Promise((_, reject) => {
        if (parentEvent?.aborted) {return reject(new Error('USER_ABORT'))}
        if (typeof parentEvent?.onAbort === 'function') {
          parentEvent.onAbort(() => reject(new Error('USER_ABORT')))
        }
      })

      try {
        // 执行插件run，和超时、终止竞争
        const result = await Promise.race([
          app.run(e), 
          timeoutPromise,
          abortPromise
        ])

        return {
          call: toolCall,
          result,
        }
      } finally {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer)
          timeoutTimer = null
        }
      }
    } catch (error) {
      logger.error(error)
      return {
        call: toolCall,
        result: { error: error.message || error.toString() },
      }
    }
  }

  /**
   * 假设此方法返回所有插件工具的Map集合，键是工具名，值是工具对象
   */
  getAllTools() {
    const allTools = this.plugins.reduce((acc, plugin) => {
      // Plugin.getTools() 返回的是一个二维结构数组，形如 [[pluginName, toolsArray], ...]
      const toolsList = plugin.getTools()
      for (const [_pluginName, toolsArray] of toolsList) {
        for (const tool of toolsArray) {
          acc.set(tool.name, tool)
        }
      }
      return acc // Reduce 必须返回acc累积器
    }, new Map())
    return allTools
  }

  /**
   * Inject Skill Catalog into the system prompt of the message history
   * @private
   */
  _injectSkillCatalog(e) {
    try {
      // Check if 'Skill' tool is available for this agent/request
      const availableTools = e.body.settings?.toolCallSettings?.tools || []
      const hasSkillTool = availableTools.some(t => t === 'Skill' || t.startsWith('Skill_'))
      
      if (!hasSkillTool) {
        return
      }

      const skillsBlock = skillService.buildSystemPromptBlock()
      if (!skillsBlock) {return}

      if (!e.body.messages) {e.body.messages = []}
      
      // Find the first system message or create one
      const systemMessage = e.body.messages.find(m => m.role === 'system')
      if (systemMessage) {
        // Prepend if not already present
        if (!systemMessage.content.includes('<skill_registry>')) {
          systemMessage.content = skillsBlock + systemMessage.content
        }
      } else {
        // Prepend a new system message
        e.body.messages.unshift({
          content: skillsBlock,
          role: 'system'
        })
      }
    } catch (error) {
      logger.error('Error injecting skill catalog:', error)
    }
  }

  _mergePresetHistory(e) {
    try {
      const history = e.body.settings?.presetSettings?.history
      if (!history || !Array.isArray(history) || history.length === 0) {return}

      if (!e.body.messages) {e.body.messages = []}

      // 提取预设中的 System 指令
      const presetSystemMsgs = history.filter(m => m.role === 'system')
      const presetOtherMsgs = history.filter(m => m.role !== 'system')

      if (presetSystemMsgs.length > 0) {
        // 找到当前消息链中的首条 System 消息
        const existingSystem = e.body.messages.find(m => m.role === 'system')
        const combinedContent = presetSystemMsgs.map(m => m.content).join('\n\n')

        if (existingSystem) {
          // 合并到首部，确保系统原始指令在 Skill Catalog 之后（如果已注入）
          if (!existingSystem.content.includes(presetSystemMsgs[0].content)) {
            existingSystem.content = `${existingSystem.content  }\n\n${  combinedContent}`
          }
        } else {
          // 如果没有，直接放入一条
          e.body.messages.unshift({ content: combinedContent, role: 'system' })
        }
      }

      // 将非 System 消息（对话历史）插入到所有 System 消息之后
      let lastSystemIndex = -1
      for (let i = 0; i < e.body.messages.length; i++) {
        if (e.body.messages[i].role === 'system') {lastSystemIndex = i}
        else {break}
      }
      
      e.body.messages.splice(lastSystemIndex + 1, 0, ...presetOtherMsgs)
    } catch (error) {
      logger.error('Error merging preset history:', error)
    }
  }
}

export default new LLMChatService()
