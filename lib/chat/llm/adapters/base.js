import crypto from 'crypto'
import config from '../../../config.js'
import hookManager from '../../../hooks/index.js'
import { HOOK_POINTS } from '../../../hooks/types.js'

import CrystallizationService from '../services/CrystallizationService.js'
import modelRegistryService from '../services/ModelRegistryService.js'
import { MioFunction } from '../../../function.js'
import { parseConcatenatedJson } from '../../../../utils/jsonParser.js'
import { normalizeUsage } from '../utils/usageHelper.js'

class CustomMioFunction extends MioFunction {
  constructor({ name, description, parameters }) {
    super({ description, name, parameters })
    this.name = name
  }
}
/**
 * @class OpenAI Bot 实现
 */
export default class BaseLLMAdapter {
  /**
   * 获取适配器元数据(子类应该覆盖此方法)
   * @returns {object} { type: string, requiresSpecialAuth: boolean }
   */
  static getAdapterMetadata() {
    throw new Error('子类必须实现 getAdapterMetadata 静态方法')
  }

  /**
   * 构造函数
   * @param {string} baseUrl - OpenAI API 的基础 URL
   * @param {string} apiKey - OpenAI API 的密钥
   * @throws {Error} 如果 baseUrl 或 apiKey 缺失,则抛出错误
   */
  constructor(adapterConfig) {
    this.config = adapterConfig
    this.models = [] // 可用模型列表
    this.guestModels = [] // 访客可用的模型列表
    this.shieldConfig = {
      enabled: false,
      message: '',
    }

    // 实例化时检测子类是否实现了必要的方法
    if (typeof this.loadModels !== 'function') {
      throw new Error('子类必须实现 initModels 方法')
    }

    if (typeof this.handleChatRequest !== 'function') {
      throw new Error('子类必须实现 handleChatRequest 方法')
    }
  }

  /**
   * 初始化模型列表
   * @returns {Promise<object>} 包含模型和所有者数量的对象
   */
  async loadModels() {
    try {
      if (this.shieldConfig?.enabled) {
        this.models = []
        this.guestModels = []
        return {
          guestModelsCount: 0,
          guestOwnerCount: 0,
          isShielded: true,
          modelsCount: 0,
          ownerCount: 0,
          shieldMessage: this.shieldConfig.message,
          success: true,
        }
      }
      this.models = await this._getModels()
      this.guestModels = this._filterGuestModels()

      return {
        guestModelsCount: this._calculateTotalModels(this.guestModels),
        guestOwnerCount: this.guestModels.length,
        modelsCount: this._calculateTotalModels(this.models),
        ownerCount: this.models.length,
        success: true,
      }
    } catch (error) {
      logger.error(
        `[BaseLLMAdapter] 模型列表加载失败: ${error.message || error}`,
      )
      // 不再抛出错误，而是返回空模型列表
      this.models = []
      this.guestModels = []

      return {
        error: error.message,
        guestModelsCount: 0,
        guestOwnerCount: 0,
        modelsCount: 0,
        ownerCount: 0,
        success: false,
      }
    }
  }

  /**
   * 手动刷新模型列表（用于用户点击刷新按钮）
   * @returns {Promise<object>} 包含模型和所有者数量的对象
   * @throws {Error} 如果获取模型列表失败，则抛出错误（让用户知道失败）
   */
  async refreshModels() {
    try {
      if (this.shieldConfig?.enabled) {
        throw new Error(this.shieldConfig.message || '该适配器已暂时屏蔽')
      }
      this.models = await this._getModels()
      this.guestModels = this._filterGuestModels()

      return {
        guestModelsCount: this._calculateTotalModels(this.guestModels),
        guestOwnerCount: this.guestModels.length,
        modelsCount: this._calculateTotalModels(this.models),
        ownerCount: this.models.length,
        success: true,
      }
    } catch (error) {
      logger.error('[BaseLLMAdapter] 模型列表刷新失败:', error)
      throw error // 刷新时抛出错误，让前端知道失败
    }
  }

  /**
   * 处理聊天请求
   * @param {object} e - 事件对象，包含聊天请求的详细信息
   * @param {boolean} [firstCall=true] - 是否是第一次调用（用于递归调用）
   */
  async handleChatRequest(e, firstCall = true) {
    try {
      if (firstCall) {
        e.client.pushEvent(e.requestId, e)
        e._totalStartTime = e.requestStartTime || Date.now()
        e._cumulativeUsage = {
          completion_tokens: 0,
          reasoning_tokens: 0,
          total_tokens: 0,
        }
      }

      if (e.aborted) {
        return
      }

      // 提前初始化 e._startTime 和 e._timeMetrics，以应对任何地方触发的异常
      // 递归轮次计数器：第一次调用 = 1，每一次工具递归自增
      e._recursionRound = (e._recursionRound || 0) + 1
      // 每次递归前触发 LLM_BEFORE_RECURSION 钩子（每轮都会执行，允许动态调整工具列表）
      try {
        await hookManager.execute(HOOK_POINTS.LLM_BEFORE_RECURSION, {
          body: e.body,
          event: e,
          firstCall,
          llmService: middleware.llm,
          round: e._recursionRound,
          tools: e.body.settings?.toolCallSettings?.tools || [],
        })
      } catch (hookError) {
        // 钩子失败不应中断主流程
        logger.error(`[LLM_BEFORE_RECURSION] Hook 执行失败:`, hookError)
      }
      e._startTime = Date.now()
      if (!e._timeMetrics) {
        e._timeMetrics = {
          contactorId: e.body?.contactorId,
          e: e,
          firstTokenTime: null,
          isStream: e.body?.settings?.base?.stream ?? true,
          model:
            e.body?.settings?.base?.model || this.config?.model || 'unknown',
          presetName: e.body?.settings?.presetSettings?.name,
          requestId: e.requestId,
          startTime: e._startTime,
          userId: e.user?.id,
          userIp: e.user?.ip,
        }
      }

      // 检查屏蔽状态
      if (this.shieldConfig?.enabled) {
        const tip = this.shieldConfig.message || '该适配器暂时不可用。'
        e.update({
          content: `\n\n> [!IMPORTANT]\n> **服务提示**\n> ${tip}\n\n`,
          type: 'content',
        })
        if (firstCall) {
          e.complete()
        }
        return
      }

      const processedBody = await this._prepareChatBody(e.body, e)
      // Logger.json(processedBody)
      const response = await this._executeChatRequest(processedBody, e)

      if (e.aborted) {
        return
      }

      if (response.toolCalls) {
        // 重置工具模式，防止无限调用
        e.body.settings.toolCallSettings.mode = 'AUTO'

        await this._handleToolCalls(response.toolCalls, e, response.stepId)
      }

      if (firstCall) {
        e.complete()
      }
    } catch (error) {
      if (e.aborted) {
        logger.info(
          `Request ${e.requestId} caught error after abort, ignoring.`,
        )
        const metrics = e._timeMetrics || {
          contactorId: e.body?.contactorId,
          e,
          model:
            e.body?.settings?.base?.model || this.config?.model || 'unknown',
          presetName: e.body?.settings?.presetSettings?.name,
          requestId: e.requestId,
          startTime: e._startTime || Date.now(),
          userId: e.user?.id,
          userIp: e.user?.ip,
        }
        metrics.status = 'ABORTED'
        metrics.errorMessage = error.message || error.toString()
        this.logUsage(this.provider, null, metrics)
        return
      }

      const metrics = e._timeMetrics || {
        contactorId: e.body?.contactorId,
        e,
        model: e.body?.settings?.base?.model || this.config?.model || 'unknown',
        presetName: e.body?.settings?.presetSettings?.name,
        requestId: e.requestId,
        startTime: e._startTime || Date.now(),
        userId: e.user?.id,
        userIp: e.user?.ip,
      }
      metrics.status = 'FAILED'
      metrics.errorMessage =
        error.message ||
        (error.stack ? error.stack.split('\n')[0] : error.toString())
      metrics.errorStack = error.stack
      this.logUsage(this.provider, null, metrics)

      e.error(error) //直接抛出，让调用方处理
    } finally {
      if (firstCall) {
        e.client.popEvent(e.requestId)
        e.client.popConnection(e.requestId)
      }
    }
  }

  /**
   * 获取格式化后的工具配置
   * @private
   * @param {string[]} tools - 可用工具名称列表
   * @returns {object[]|{}} 格式化后的工具配置数组，如果没有工具则返回空对象
   */
  /**
   * 获取用于 tool.json() 的 format type。
   * 子类应覆盖此 getter 以返回正确的类型。
   * 默认返回 'openai'，因为大多数 adapter 兼容 OpenAI 协议。
   */
  get toolJsonType() {
    return 'openai'
  }

  _getFormattedTools(tools, passthrough = false, context = null) {
    if (tools?.length > 0) {
      if (passthrough) {
        return tools.map((t) => {
          const funcObj = t.function || t
          const dummy = new CustomMioFunction({
            description: funcObj.description,
            name: funcObj.name,
            parameters: funcObj.parameters,
          })
          return dummy.json(this.toolJsonType, context)
        })
      }
      return middleware.llm.getLLMTools(tools, this.toolJsonType, context)
    }
    return []
  }

  /**
   * 判断指定模型是否支持多模态视觉输入
   *
   * 决策链：
   *   1) 显式覆写（最高优先级：请求/会话/联系人配置强行开启或关闭）
   *   2) 默认走模型规格注册表动态查表 (ModelRegistryService)
   *   3) 无法判断时默认放行，避免阻塞正常对话
   *
   * 子类若需完全自定义逻辑，可直接重写 (override) 此方法。
   *
   * @param {string} [modelName] - 目标模型名称
   * @param {boolean|string} [visionOverride] - 显式覆写参数
   * @returns {boolean} true 表示支持视觉输入，false 表示不支持
   */
  supportsVision(modelName, visionOverride = undefined) {
    // 1) 显式覆写最高优先（true: 强行放行; false: 强行过滤）
    if (visionOverride === true || visionOverride === 'true') {
      return true
    }
    if (visionOverride === false || visionOverride === 'false') {
      return false
    }

    // 2) 基于模型规格注册中心细粒度查表
    if (modelName) {
      try {
        return Boolean(modelRegistryService.supportsVision(modelName))
      } catch {
        // 注册表异常时按放行处理，避免阻塞对话
      }
    }

    // 3) 兜底：无法确定模型时默认支持
    return true
  }

  /**
   * 判断当前请求是否需要过滤图片消息（多模态内容）
   * @param {string} [modelName] - 当前请求的模型名
   * @param {boolean|string} [visionOverride] - 显式覆写参数
   * @returns {boolean} true=过滤图片，false=放行
   */
  _shouldFilterVision(modelName, visionOverride = undefined) {
    return !this.supportsVision(modelName, visionOverride)
  }

  /**
   * 生成随机的调用 ID
   * @private
   * @returns {string} 随机的调用 ID
   */
  _getRandomCallId() {
    return (
      Math.random().toString(36).substring(2, 15) +
      Math.random().toString(36).substring(2, 15)
    )
  }

  /**
   * 根据配置过滤访客可用的模型
   * @private
   * @returns {Array<object>} 过滤后的访客模型列表
   */
  _filterGuestModels() {
    const guestConfig = this.config.guest_models || {}
    return this.models.reduce((acc, item) => {
      const allowedModels = this._filterAllowedModels(item.models, guestConfig)
      if (allowedModels.length > 0) {
        acc.push({ models: allowedModels, owner: item.owner })
      }
      return acc
    }, [])
  }

  /**
   * 过滤允许的模型列表
   * @private
   * @param {Array<string>} models - 要过滤的模型名称列表
   * @param {object} guestConfig - 访客模型的配置
   * @returns {Array<string>} 允许的模型名称列表
   */
  _filterAllowedModels(models, guestConfig) {
    return models.filter((modelName) =>
      this._isModelAllowed(modelName, guestConfig),
    )
  }

  /**
   * 检查模型是否被允许
   * @private
   * @param {string} modelName - 要检查的模型名称
   * @param {object} guestConfig - 访客模型的配置
   * @returns {boolean} 如果模型被允许，则返回 true，否则返回 false
   */
  _isModelAllowed(modelName, guestConfig) {
    const { keywords = [], full_name = [] } = guestConfig
    return (
      keywords.some((keyword) => modelName.includes(keyword)) ||
      full_name.some((name) => modelName === name)
    )
  }

  /**
   * 计算模型列表中的模型总数
   * @private
   * @param {Array<object>} modelList - 模型列表
   * @returns {number} 模型总数
   */
  _calculateTotalModels(modelList) {
    return modelList.reduce((acc, cur) => acc + cur.models.length, 0)
  }

  /**
   * 根据所有者对模型进行分组
   * @private
   * @param {Array<object>} models - 从 API 获取的模型数据
   * @param {Array<object>} ownerList - 所有者列表
   * @returns {Array<object>} 按所有者分组的模型列表
   */
  _groupModelsByOwner(models, ownerList = null) {
    // 如果没有传入 ownerList，动态获取
    if (!ownerList) {
      ownerList = config.getModelsOwners() || []
    }

    return models.reduce((acc, model) => {
      const owner = this._determineModelOwner(model.id, ownerList)
      const existingOwner = acc.find((item) => item.owner === owner)

      if (existingOwner) {
        existingOwner.models.push(model.id)
      } else {
        acc.push({ models: [model.id], owner })
      }
      return acc
    }, [])
  }

  /**
   * 确定模型的所有者
   * @private
   * @param {string} modelId - 模型 ID
   * @param {Array<object>} ownerList - 所有者列表
   * @returns {string} 模型的所有者
   */
  _determineModelOwner(modelId, ownerList) {
    const modelIdLower = modelId.toLowerCase()
    const matchedOwner = ownerList.find(({ keywords }) =>
      keywords.some((keyword) => modelIdLower.includes(keyword)),
    )
    return matchedOwner?.owner || 'Custom'
  }

  /**
   * 对模型列表进行排序（字母表降序，"Custom" 最后）
   * @private
   * @param {Array<object>} modelList - 模型列表
   * @returns {Array<object>} 排序后的模型列表
   */
  _sortModelList(modelList) {
    return modelList.toSorted((a, b) => {
      if (a.owner === 'Custom') {
        return 1
      }
      if (b.owner === 'Custom') {
        return -1
      }
      return b.owner.localeCompare(a.owner)
    })
  }

  /**
   * 统一用量审计入口 (面向所有 LLM 适配器)
   * 仅负责触发 Hook，具体的统计和持久化由系统钩子接管
   */
  logUsage(providerName, usage, timeMetrics) {
    if (!usage && !timeMetrics) {
      return
    }

    // 状态维护 (保持向下兼容，某些流式逻辑仍需要 e.lastUsage)
    if (timeMetrics && timeMetrics.e) {
      timeMetrics.logged = true
      if (usage) {
        timeMetrics.e.lastUsage = usage
      }
      // 关键关联：让 e 永远能拿到最新的 metrics 细节，以便在抛错捕获处取到最真实的 latency/model/stepId 等
      timeMetrics.e._timeMetrics = timeMetrics
    }

    const finalTimeMetrics =
      timeMetrics || usage?.e?._timeMetrics || usage?.timeMetrics
    const normalizedUsage = normalizeUsage(usage)

    const event = finalTimeMetrics?.e
    if (event) {
      if (!event._cumulativeUsage) {
        event._cumulativeUsage = {
          completion_tokens: 0,
          reasoning_tokens: 0,
          total_tokens: 0,
        }
      }
      event._cumulativeUsage.completion_tokens +=
        normalizedUsage.completion_tokens || 0
      event._cumulativeUsage.reasoning_tokens +=
        normalizedUsage.reasoning_tokens || 0
      event._cumulativeUsage.total_tokens += normalizedUsage.total_tokens || 0
    }

    // 推送用量信息给客户端（纯前端存储与展示）
    if (event && typeof event.update === 'function' && usage) {
      const overallDurationMs =
        Date.now() -
        (event._totalStartTime ||
          event.requestStartTime ||
          finalTimeMetrics?.startTime ||
          Date.now())
      const lastRoundDurationMs =
        finalTimeMetrics.elapsedTime ||
        (finalTimeMetrics.startTime
          ? Date.now() - finalTimeMetrics.startTime
          : Date.now() - (finalTimeMetrics.e.requestStartTime || Date.now()))
      const ttftMs =
        finalTimeMetrics?.firstTokenTime && finalTimeMetrics?.startTime
          ? Math.max(
              0,
              finalTimeMetrics.firstTokenTime - finalTimeMetrics.startTime,
            )
          : null

      const cumCompletion =
        event._cumulativeUsage?.completion_tokens ||
        normalizedUsage.completion_tokens
      const cumReasoning =
        event._cumulativeUsage?.reasoning_tokens ||
        normalizedUsage.reasoning_tokens
      const prompt = normalizedUsage.prompt_tokens || 0
      const total = prompt + cumCompletion

      event.update({
        content: {
          ...normalizedUsage,
          prompt_tokens: prompt,
          completion_tokens: cumCompletion,
          reasoning_tokens: cumReasoning,
          total_tokens: total,
          rounds: event._recursionRound || 1,
          duration: overallDurationMs,
          ttft: ttftMs,
          model: finalTimeMetrics.model || this.config?.model,
          provider: providerName,
          timestamp: Date.now(),
          last_round: {
            ...normalizedUsage,
            duration: lastRoundDurationMs,
            ttft: ttftMs,
          },
        },
        type: 'usage',
      })
    }

    // 触发系统钩子：让 AuditHook (打印/内存统计) 和 DatabaseAuditHook (存库) 自行处理
    hookManager
      .execute(HOOK_POINTS.LLM_AFTER_CHAT, {
        adapter: this,
        model: finalTimeMetrics?.model || this.config?.model,
        providerName,
        timeMetrics: finalTimeMetrics,
        usage: normalizedUsage,
        user: finalTimeMetrics?.e?.user,
      })
      .catch((error) =>
        logger.error('[审计系统] LLM_AFTER_CHAT 钩子执行失败:', error),
      )
  }

  /**
   * 检查 token 水位线，若超限则触发无状态记忆结晶压缩
   * @private
   */
  async _checkAndCrystallize(e) {
    const crystallizationSetting = e.body?.settings?.crystallization
    if (crystallizationSetting?.enabled === false) {
      return
    }

    let watermark = e.body?.settings?.crystallization_token_watermark
    if (watermark === -1 || watermark === 0) {
      return // 显式关闭结晶功能
    }

    // 若未显式指定数字水位线或指定为 auto，自动根据当前模型计算 80% 安全水位线
    if (!watermark || watermark === 'auto' || typeof watermark !== 'number') {
      const currentModel =
        e.body?.model || e.body?.settings?.base?.model || this.model
      watermark = modelRegistryService.getWatermark(currentModel)
    }

    // 限制单次请求只能触发一次压缩，避免极端情况下无限循环压缩
    if (e._crystallized) {
      logger.debug(
        '[Crystallization] 该请求已执行过记忆结晶压缩，跳过本次判定以避免循环压缩',
      )
      return
    }

    const promptTokens =
      e.lastUsage?.prompt_tokens ||
      e.lastUsage?.input_tokens ||
      e.lastUsage?.promptTokenCount ||
      0

    if (promptTokens < watermark) {
      return
    } // 未超过水位线

    const messages = e.body.messages || []
    const keepTurns = e.body.settings?.crystallization_keep_turns ?? 1

    // 1. 预先校验：确定要保留的最近 N 个前端轮次的起始位置
    const boundaryIndex = CrystallizationService.scanFrontendTurns(
      messages,
      keepTurns,
    )

    // 如果边界是 0，说明没有可压缩的内容，直接返回（不发送 running 状态条，也不做任何压缩）
    if (boundaryIndex <= 0) {
      logger.debug(
        '[Crystallization] 消息链过短，不满足保留轮次要求，跳过结晶判定',
      )
      return
    }

    // 标记已执行压缩，防止递归循环
    e._crystallized = true

    logger.info(
      `[Crystallization] prompt_tokens=${promptTokens} 超过水位线 ${watermark}，触发记忆结晶压缩`,
    )

    // 推送"结晶开始"事件到前端（用于 UI 显示事件条）
    e.update({
      content: { prompt_tokens: promptTokens, status: 'running' },
      type: 'crystallize',
    })

    try {
      const result = await CrystallizationService.compress(
        e,
        this,
        boundaryIndex,
      )

      if (result) {
        // 覆盖当前 event 的消息链
        e.body.messages = result.messages

        logger.info(
          `[Crystallization] 压缩完成，新消息链长度: ${result.messages.length}，结晶 ${result.summary.length} 字符`,
        )

        // 推送"结晶完成"事件到前端（包含新的 XML summary）
        e.update({
          content: { status: 'finished', summary: result.summary },
          type: 'crystallize',
        })
      } else {
        logger.debug('[Crystallization] 压缩服务返回 null，通知前端关闭状态条')
        e.update({
          content: {
            status: 'finished',
            summary: e.body.settings?.previous_summary || '',
          },
          type: 'crystallize',
        })
      }
    } catch (error) {
      logger.error(
        '[Crystallization] 压缩过程发生异常，通知前端关闭状态条:',
        error.message,
      )
      e.update({
        content: {
          status: 'finished',
          summary: e.body.settings?.previous_summary || '',
        },
        type: 'crystallize',
      })
    }
  }

  /**
   * 规整化历史消息中的 tool call ID。
   * Gemini 的 tool call ID 可能包含很长的 base64 thought_signature (长度超过 64 字节)，
   * 当切换到 OpenAI/DeepSeek 等对 ID 长度有严格上限（最大 64 字节）的适配器时，会导致 400 报错。
   * 本方法会深拷贝消息列表，将长度 > 64 字节的 ID 映射并截短为符合标准的随机安全 ID，
   * 同时对对应的 tool 角色消息的 tool_call_id 进行同步映射更新，确保匹配完整。
   */
  _normalizeToolCallIds(messages) {
    if (!Array.isArray(messages)) {
      return messages
    }

    const toolCallIdMap = new Map()
    // 使用浅拷贝 + 按需深拷贝代替 JSON.parse(JSON.stringify(...))，
    // 避免对含大字符串的消息历史做全量深拷贝导致瞬时内存翻倍。
    const result = Array.from({ length: messages.length })

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]
      if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
        let modified = false
        const newToolCalls = message.tool_calls.map((toolCall) => {
          const idStr = String(toolCall.id || '')
          if (idStr.length > 64) {
            const md5 = crypto.createHash('md5').update(idStr).digest('hex')
            const shortId = `mc_${md5}`
            toolCallIdMap.set(idStr, shortId)
            modified = true
            return { ...toolCall, id: shortId }
          }
          return toolCall
        })
        result[i] = modified
          ? { ...message, tool_calls: newToolCalls }
          : message
      } else if (message.role === 'tool' && message.tool_call_id) {
        const idStr = String(message.tool_call_id)
        if (toolCallIdMap.has(idStr)) {
          result[i] = { ...message, tool_call_id: toolCallIdMap.get(idStr) }
        } else if (idStr.length > 64) {
          // Tool 消息与 assistant 消息的 hash 计算完全相同（md5(idStr) → 'mc_' + hex），
          // 相同的原始 ID 必然得到相同的 shortId，保证 assistant ↔ tool 的 ID 映射一致。
          // 走到此分支说明对应的 assistant 消息不在本次消息链中（历史截断），仍可安全截短。
          const md5 = crypto.createHash('md5').update(idStr).digest('hex')
          const shortId = `mc_${md5}`
          toolCallIdMap.set(idStr, shortId)
          result[i] = { ...message, tool_call_id: shortId }
        } else {
          result[i] = message
        }
      } else {
        result[i] = message
      }
    }

    return result
  }

  /**
   * 处理工具调用 (基类统一实现)
   * @param {object[]} toolCalls - 工具调用数组
   * @param {object} e - 事件对象
   * @param {string} stepId - 步骤 ID
   */
  async _handleToolCalls(toolCalls, e, _stepId) {
    if (!e.body.messages) {
      e.body.messages = [] // 确保 e.body.messages 存在
    }

    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      return
    }

    // 1. 规范化与解包工具调用：
    // 如果某些大模型在单个 tool_call.function.arguments 中输出紧密拼接的多个 JSON（例如 {...}{...}），
    // 自动将其裂变为多个并行的独立工具调用，等价于连续/并行调用多次该工具
    const expandedToolCalls = []
    for (const call of toolCalls) {
      const rawArgs = call.function?.arguments
      if (typeof rawArgs === 'string') {
        const parsed = parseConcatenatedJson(rawArgs)
        if (Array.isArray(parsed) && parsed.length > 1) {
          logger.info(
            `[handleToolCalls] 检测到单个工具调用 ${call.function?.name} 包含 ${parsed.length} 个紧密拼接的 JSON 参数，自动裂变为 ${parsed.length} 个独立并行工具调用`,
          )
          parsed.forEach((singleParam, idx) => {
            const subId =
              idx === 0
                ? call.id || this._getRandomCallId()
                : `${call.id || this._getRandomCallId()}_${idx}`
            expandedToolCalls.push({
              ...call,
              id: subId,
              function: {
                ...call.function,
                arguments:
                  typeof singleParam === 'object'
                    ? JSON.stringify(singleParam)
                    : String(singleParam),
              },
            })
          })
          continue
        }
      }
      expandedToolCalls.push(call)
    }
    toolCalls = expandedToolCalls

    const callMessage = { role: 'assistant', tool_calls: toolCalls }

    callMessage.tool_calls.forEach((item) => {
      item.id = item.id || this._getRandomCallId()
    })

    if (e.body.extraCachedContent) {
      callMessage.content = e.body.extraCachedContent
      delete e.body.extraCachedContent
    }

    // 子类可选扩展点：例如 OpenAIBot 可以用来注入 reasoning_content 等
    if (typeof this._extendAssistantMessage === 'function') {
      this._extendAssistantMessage(callMessage, e)
    }

    e.body.messages.push(callMessage)

    const tasks = []
    const allPostMessages = [] // 用于收集所有工具产生的后置消息
    const executedTools = []

    // 工具结果按「调用顺序」回填（并行执行时完成顺序 ≠ 调用顺序，
    // DeepSeek 等严格按数组顺序配对的 Responses 实现会因乱序报 No tool output found）
    const toolResults = Array.from({ length: toolCalls.length }).fill(null)

    for (let ci = 0; ci < toolCalls.length; ci++) {
      const call = toolCalls[ci]
      if (e.aborted) {
        break
      }
      const toolCall = call.function
      const toolCallId = call.id || call.call_id || this._getRandomCallId()
      const toolStartTime = Date.now()
      const toolCallData = {
        action: 'running',
        id: toolCallId,
        name: toolCall.name,
        parameters: toolCall.arguments,
        result: '',
        startTime: toolStartTime,
      }
      e.update({
        content: toolCallData,
        type: 'toolCall',
      })
      logger.info(`执行工具：${toolCall.name}，参数：${toolCall.arguments}`)

      const runTask = async () => {
        try {
          e._activeToolCallData = toolCallData
          const toolResult = await middleware.llm.runTool(
            toolCallData,
            e.user,
            e,
          )
          let { result } = toolResult

          // 提前提取 _postMessages（如图片载体），在 result 被展平为字符串之前
          const postMessages =
            result && typeof result === 'object' ? result._postMessages : null

          // Extract extraRender to keep it separate from LLM messages
          let extraRender = toolCallData.extraRender || []

          if (result && typeof result === 'object') {
            if (result.extraRender) {
              const incomingExtra = Array.isArray(result.extraRender)
                ? result.extraRender
                : [result.extraRender]
              extraRender = [
                ...extraRender,
                ...incomingExtra.map((item) => ({
                  placement: 'inner',
                  ...item,
                })),
              ]
            }
            if ('result' in result) {
              result = result.result
            } else if (result.extraRender) {
              const resultCopy = { ...result }
              delete resultCopy.extraRender
              result = resultCopy
            }
          }

          // 处理特殊的返回格式，该格式包含工具执行后的后置消息（例如视觉多模态注入）
          if (postMessages) {
            allPostMessages.push(...postMessages)
          }

          logger.info(`运行结果：${JSON.stringify(result)}`)

          executedTools.push({
            arguments:
              typeof toolCall.arguments === 'string'
                ? toolCall.arguments
                : JSON.stringify(toolCall.arguments),
            name: toolCall.name,
            output:
              typeof result === 'string' ? result : JSON.stringify(result),
          })

          // 暂存结果，全部完成后按调用顺序统一回填（见下方循环）
          toolResults[ci] = {
            content:
              typeof result === 'string' ? result : JSON.stringify(result),
            name: toolCall.name,
            tool_call_id: toolCallId,
          }

          const toolEndTime = Date.now()
          const effectiveStartTime = toolCallData.startTime || toolStartTime
          toolCallData.startTime = effectiveStartTime
          toolCallData.endTime = toolEndTime
          toolCallData.duration = toolEndTime - effectiveStartTime
          toolCallData.result = result
          toolCallData.action = 'finished'
          toolCallData.extraRender = extraRender
          e.update({
            content: toolCallData,
            type: 'toolCall',
          })
        } catch (error) {
          const toolEndTime = Date.now()
          const effectiveStartTime = toolCallData.startTime || toolStartTime
          toolCallData.startTime = effectiveStartTime
          toolCallData.endTime = toolEndTime
          toolCallData.duration = toolEndTime - effectiveStartTime
          if (error.message === 'USER_ABORT' || e.aborted) {
            logger.info(
              `Tool execution ${toolCall.name} aborted for request ${e.requestId}`,
            )
            toolCallData.action = 'finished'
            toolCallData.status = 'aborted'
            toolCallData.result = 'User aborted.'
            toolResults[ci] = {
              content: 'User aborted.',
              name: toolCall.name,
              tool_call_id: toolCallId,
            }
            e.update({
              content: toolCallData,
              type: 'toolCall',
            })
            return
          }
          throw error
        } finally {
          if (e._activeToolCallData === toolCallData) {
            e._activeToolCallData = null
          }
        }
      }

      tasks.push(runTask())
    }

    await Promise.allSettled(tasks)

    // 按调用顺序统一回填工具结果；未完成/中止的调用补齐 User aborted 或错误提示，绝不遗留孤儿 function_call
    for (let ci = 0; ci < toolCalls.length; ci++) {
      const call = toolCalls[ci]
      const toolCallId = call.id || call.call_id || this._getRandomCallId()
      const toolName = call.function?.name || ''
      let tr = toolResults[ci]
      if (!tr) {
        const abortedMsg = e.aborted
          ? 'User aborted.'
          : '[System Error] 工具执行失败或未返回结果'
        tr = {
          content: abortedMsg,
          name: toolName,
          tool_call_id: toolCallId,
        }
        toolResults[ci] = tr
        e.update({
          content: {
            action: 'finished',
            duration: 0,
            endTime: Date.now(),
            id: toolCallId,
            name: toolName,
            parameters: call.function?.arguments || '',
            result: abortedMsg,
            startTime: Date.now(),
            status: e.aborted ? 'aborted' : 'failed',
          },
          type: 'toolCall',
        })
      }
      e.body.messages.push({
        content: tr.content,
        name: tr.name,
        role: 'tool',
        tool_call_id: tr.tool_call_id,
      })
    }

    if (e.aborted) {
      return
    }

    // 触发工具执行详情审计钩子
    hookManager
      .execute(HOOK_POINTS.LLM_TOOL_RESULTS, {
        executedTools,
        requestId: e.requestId,
      })
      .catch((error) =>
        logger.error('[审计系统] LLM_TOOL_RESULTS 钩子执行失败:', error),
      )

    // 所有 tool 结果注入完成后，合并并统一注入后置消息（如图片），避免角色交替错误
    if (allPostMessages.length > 0) {
      logger.info(`合并并注入后置消息：${allPostMessages.length} 个片段`)
      const mergedContent = []
      allPostMessages.forEach((msg) => {
        if (Array.isArray(msg.content)) {
          mergedContent.push(...msg.content)
        } else if (msg.content) {
          mergedContent.push({
            text:
              typeof msg.content === 'string'
                ? msg.content
                : JSON.stringify(msg.content),
            type: 'text',
          })
        }
      })
      // This is an internal continuation of the current frontend turn, not
      // a new user turn.  Keep the marker non-enumerable so it guides local
      // crystallization/round-trip logic without leaking an unknown field to
      // provider request payloads.
      const recursiveContextMessage = { content: mergedContent, role: 'user' }
      Object.defineProperty(recursiveContextMessage, '_is_recursive_context', {
        configurable: false,
        enumerable: false,
        value: true,
        writable: false,
      })
      e.body.messages.push(recursiveContextMessage)
    }

    // 在递归之前，检查是否需要触发记忆结晶压缩
    await this._checkAndCrystallize(e)

    // 递归调用 handleChatRequest 方法来处理工具调用的结果
    await this.handleChatRequest(e, false)
  }

  /**
   * 浅层清洗对象，剔除值为 undefined 的顶层字段（O(1) 开销，避免对 messages 进行全量 JSON 序列化）
   * @param {object} obj
   * @returns {object}
   */
  cleanUndefined(obj) {
    if (!obj || typeof obj !== 'object') return obj
    const cleaned = {}
    for (const key of Object.keys(obj)) {
      if (obj[key] !== undefined) {
        cleaned[key] = obj[key]
      }
    }
    return cleaned
  }
}
