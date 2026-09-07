import BaseLLMAdapter from '../base.js'
import OpenAI from 'openai'
import {
  base64ToImageUrl,
  resolveImageAsBase64,
} from '../../../../../utils/imgTools.js'
import { parseConcatenatedJson } from '../../../../../utils/jsonParser.js'

/**
 * @class OpenAI Bot 实现
 */
export default class OpenAIBot extends BaseLLMAdapter {
  /**
   * 获取适配器元数据
   */
  static getAdapterMetadata() {
    return {
      avatarAliases: {
        claude: 'anthropic',
        doubao: 'doubao',
        kimi: 'moonshot',
        onebot: 'openai',
        qwen: 'qwen',
        sparkdesk: 'spark',
        zhipu: 'zhipu',
        智谱清言: 'zhipu',
        月之暗面: 'moonshot',
        '月之暗面 (kimi)': 'moonshot',
        混元: 'hunyuan',
        科大讯飞: 'spark',
        腾讯混元: 'hunyuan',
        讯飞: 'spark',
        豆包: 'doubao',
        通义: 'qwen',
        通义千问: 'qwen',
      },
      avatarId: 'openai',
      description:
        'OpenAI 标准 Chat Completions 适配器。支持 GPT-4o, GPT-3.5 Turbo 等全系列模型。该接口具备高度通用性，可兼容任何支持 OpenAI 格式的第三方大模型网关或私有化部署服务（如 OneAPI, NewAPI 等）。\n\n**获取方式**：在 [OpenAI Platform](https://platform.openai.com/api_keys) 创建 API 密钥。',
      initialConfigSchema: {
        api_key: {
          default: '',
          description: 'OpenAI API 密钥，支持多个密钥用逗号分隔',
          label: 'API Key',
          placeholder: 'API Key',
          required: true,
          type: 'password',
        },
        base_url: {
          default: 'https://api.openai.com/v1',
          description: 'OpenAI API 的基础 URL，可用于代理或第三方兼容服务',
          label: 'Base URL',
          placeholder: 'https://api.openai.com/v1',
          required: false,
          type: 'url',
        },
        enable: {
          default: true,
          description: '是否启用此适配器实例',
          label: '启用',
          required: true,
          type: 'boolean',
        },
        models: {
          default: [],
          description: '可用的模型列表，通常由系统自动获取',
          label: '模型列表',
          readonly: true,
          required: false,
          type: 'array',
        },
        name: {
          default: '',
          description: '适配器实例的自定义名称，用于区分多个实例',
          label: '实例名称',
          placeholder: '例如：OpenAI-主要',
          required: false,
          type: 'string',
        },
      },
      name: 'OpenAI',
      supportedFeatures: ['chat', 'streaming', 'function_calling', 'vision'],
      type: 'openai',
    }
  }

  /**
   * 构造函数
   * @param {string} baseUrl - OpenAI API 的基础 URL
   * @param {string} apiKey - OpenAI API 的密钥
   * @throws {Error} 如果 baseUrl 或 apiKey 缺失,则抛出错误
   */
  constructor(openaiConfig) {
    super(openaiConfig)
    this.provider = 'openai'
    this.shouldPreserveReasoningContent = false
    // 视觉能力由基类 supportsVision() 委托 ModelRegistry 动态查表判断
  }

  get openai() {
    const base_url = this.config.base_url || 'https://api.openai.com/v1'
    const { api_key } = this.config

    // 检查 api_key 是否存在
    if (!api_key) {
      throw new Error('OpenAI API Key 未配置')
    }

    // 以,为分隔符切割key列表
    const apiKeys = api_key.split(',')
    // 随机选择一个key
    const selectedKey = apiKeys[Math.floor(Math.random() * apiKeys.length)]
    // 日志用的哪个
    logger.info(
      `使用OpenAI API：${base_url} , key：${selectedKey.substring(0, 6)}...}`,
    )

    return new OpenAI({ apiKey: selectedKey, baseURL: base_url })
  }

  // ---------------------- 私有辅助方法 ----------------------

  async _prepareChatBody(body, context = null) {
    const { messages = [], settings = {} } = body || {}
    const { base = {}, chatParams = {}, toolCallSettings = {} } = settings || {}
    const model = base.model || ''
    // 通过模型名是否含 'gemini' 来判断是否为 Gemini 路由。
    // 局限性：如果用户将 Gemini 模型配置为自定义别名（如 'my-flash'），此判断会静默失效，
    // 导致 thought_signature 被截断后请求 Gemini 出错。当前假设模型名总含 'gemini' 字样。
    const isGeminiModel = model.toLowerCase().includes('gemini')

    const visionOverride = base.vision ?? settings.general?.vision
    // 如果目标模型是 Gemini，跳过 ID 截短以保留 thought_signature，否则正常进行截短
    const normalizedMessages = isGeminiModel
      ? messages
      : this._normalizeToolCallIds(messages)
    const processedMessages = await this._processMessages(
      normalizedMessages,
      model,
      visionOverride,
    )

    const { tools, mode } = toolCallSettings
    let parsedTools = undefined
    let { tool_choice } = chatParams
    if (mode !== 'NONE' && tools?.length > 0) {
      parsedTools = this._getFormattedTools(
        tools,
        toolCallSettings.passthrough,
        context || body,
      )
      if (tool_choice === undefined) {
        tool_choice = mode === 'ANY' ? 'required' : undefined
      }
    }

    const openaiReasoningEffortTable = {
      '-1': undefined,
      0: undefined,
      1: undefined,
      2: 'low',
      3: 'medium',
      4: 'high',
      5: 'high',
    }

    let mappedReasoningEffort = undefined
    if (
      chatParams.reasoning_effort !== undefined &&
      chatParams.reasoning_effort !== null
    ) {
      mappedReasoningEffort =
        openaiReasoningEffortTable[String(chatParams.reasoning_effort)] ??
        (typeof chatParams.reasoning_effort === 'string'
          ? chatParams.reasoning_effort
          : undefined)
    }

    const preparedBody = {
      ...chatParams,
      messages: processedMessages,
      model: base.model,
      stream: base.stream,
      tool_choice,
      tools: parsedTools,
    }

    if (mappedReasoningEffort !== undefined) {
      preparedBody.reasoning_effort = mappedReasoningEffort
    } else {
      delete preparedBody.reasoning_effort
    }

    return this.cleanUndefined(preparedBody)
  }

  /**
   * 从 OpenAI API 获取模型列表
   * @returns {Promise<Array<object>>} 格式化后的模型列表
   * @throws {Error} 如果获取模型列表失败，则抛出错误
   */
  async _getModels() {
    try {
      logger.info('Fetching models from OpenAI API...')
      const list = await this.openai.models.list()
      logger.info(`Retrieved ${list.data.length} models from OpenAI API`)
      const modelList = this._groupModelsByOwner(list.data)
      return this._sortModelList(modelList)
    } catch (error) {
      logger.error('Failed to get models:', error)
      throw error
    }
  }

  /**
   * 预处理消息（例如，将图片 URL 转换为 Base64）
   * @private
   * @param {Array<object>} messages - 消息数组
   * @returns {Promise<Array<object>>} 处理后的消息数组
   */
  async _processMessages(messages, modelName, visionOverride = undefined) {
    const processed = []
    const toolCallIdMap = new Map()
    for (const message of messages) {
      if (message.role === 'user' && Array.isArray(message.content)) {
        const processedContent = []
        for (const element of message.content) {
          if (element.type === 'image_url') {
            // 按模型细粒度判断：无视觉能力的模型跳过图片消息（支持联系人/请求级显式覆写）
            if (this._shouldFilterVision(modelName, visionOverride)) {
              continue
            }
            const url = element.image_url?.url || element.image_url
            const finalUrl = await resolveImageAsBase64(url)
            processedContent.push({
              image_url: { url: finalUrl },
              type: 'image_url',
            })
          } else {
            processedContent.push(element)
          }
        }
        processed.push({ ...message, content: processedContent })
      } else if (message.role === 'assistant') {
        const processedMsg = { ...message }
        if (message.tool_calls) {
          const processedToolCalls = []
          for (const toolCall of message.tool_calls) {
            if (toolCall.function.arguments) {
              const type = typeof toolCall.function.arguments
              // 如果是对象，序列化
              if (type === 'object') {
                toolCall.function.arguments = JSON.stringify(
                  toolCall.function.arguments,
                )
              } else if (type === 'string') {
                // 尝试反序列化（支持拼接多 JSON 的安全解析）
                try {
                  const obj = parseConcatenatedJson(toolCall.function.arguments)
                  toolCall.function.arguments = JSON.stringify(obj)
                } catch {
                  // Pass
                }
              }
            }
            processedToolCalls.push(toolCall)
          }
          processedMsg.tool_calls = processedToolCalls
        }
        const shouldPreserve = this._shouldPreserveReasoning(modelName, message)
        if (shouldPreserve) {
          processedMsg.reasoning_content = message.reasoning_content || ''
        } else {
          delete processedMsg.reasoning_content
        }
        processed.push(processedMsg)
      } else if (message.role === 'tool') {
        processed.push({
          ...message,
          tool_call_id:
            toolCallIdMap.get(message.tool_call_id) ?? message.tool_call_id,
        })
      } else {
        processed.push(message)
      }
    }
    return processed
  }

  /**
   * 执行聊天请求
   * @param {object} body
   * @param {object} e
   * @returns {object}
   */
  async _executeChatRequest(body, e) {
    const stepId = Math.random().toString(36).substring(2, 9)
    const enableStream = body.stream ?? true
    let callMessage = {}
    const cachedMessage = {
      role: 'assistant',
      content: '',
      reasoning_content: '',
    }

    if (enableStream) {
      if (!body.stream_options) {
        body.stream_options = { include_usage: true }
      }
      const controller = new AbortController()
      e.onAbort(() => controller.abort())

      const stream = await this.openai.chat.completions.create(body, {
        signal: controller.signal,
      })
      e.client.pushConnection(e.requestId, stream)
      e.pending()

      const timeMetrics = {
        contactorId: e?.body?.contactorId,
        e: e,
        firstTokenTime: null,
        isStream: true,
        model: body.model,
        presetName: e?.body?.settings?.presetSettings?.name,
        requestId: e?.requestId,
        startTime: Date.now(),
        stepId,
        userId: e?.user?.id,
        userIp: e?.user?.ip,
      }

      let lastUsage = null

      for await (const chunk of stream) {
        if (e.aborted) {
          break
        }

        const firstDelta = chunk.choices && chunk.choices[0]?.delta
        if (
          firstDelta &&
          (firstDelta.content ||
            firstDelta.reasoning_content ||
            firstDelta.tool_calls) &&
          !timeMetrics.firstTokenTime
        ) {
          timeMetrics.firstTokenTime = Date.now()
        }

        if (chunk.usage) {
          lastUsage = chunk.usage
          e.lastUsage = chunk.usage
        }

        if (
          !chunk.choices ||
          !Array.isArray(chunk.choices) ||
          !chunk.choices.length > 0
        ) {
          continue
        }
        const delta = chunk.choices[0]?.delta

        // 优先处理模型标准返回的 reasoning_content
        if (delta?.reasoning_content) {
          cachedMessage.reasoning_content += delta.reasoning_content
          e.update({
            content: delta.reasoning_content,
            type: 'reasoningContent',
          })
        } else if (delta?.content) {
          cachedMessage.content += delta.content
          e.update({
            content: delta.content,
            type: 'content',
          })
        } else if (delta?.tool_calls) {
          // Tool calls 逻辑
          if (Object.keys(callMessage).length === 0) {
            callMessage = { ...delta }
            if (!callMessage.tool_calls) {
              callMessage.tool_calls = []
            } else {
              // Clear it to rebuild accurately
              callMessage.tool_calls = []
            }
          }
          for (const functionCall of delta.tool_calls) {
            let call = callMessage.tool_calls.find(
              (c) => c.index === functionCall.index,
            )
            if (!call) {
              call = {
                ...functionCall,
                function: { ...functionCall.function, arguments: '' },
              }
              callMessage.tool_calls.push(call)

              const toolCallData = {
                action: 'started',
                id: call.id,
                name: call.function.name,
                parameters: '',
                result: '',
              }
              e.update({
                content: toolCallData,
                type: 'toolCall',
              })
            }
            if (functionCall?.function?.arguments) {
              // 确保arguments是字符串
              if (typeof call.function.arguments !== 'string') {
                call.function.arguments = ''
              }
              call.function.arguments += functionCall.function.arguments
              const toolCallData = {
                action: 'pending',
                id: call.id,
                name: call.function.name,
                parameters: functionCall.function.arguments || '',
                result: '',
              }
              e.update({
                content: toolCallData,
                type: 'toolCall',
              })
            }
          }
        } else if (delta?.images) {
          const urls = delta.images.map((image) => image.image_url.url)
          urls.forEach(async (url) => {
            const imageUrl = await base64ToImageUrl('', url)
            const mdWarpper = (url) => `![图片](${url})`
            e.update({
              content: mdWarpper(imageUrl),
              type: 'content',
            })
          })
        }
      }

      const finalUsage = lastUsage || {
        completion_tokens: 0,
        prompt_tokens: 0,
        total_tokens: 0,
      }
      const providerName =
        this.constructor.getAdapterMetadata()?.name || this.provider
      if (
        callMessage &&
        callMessage.tool_calls &&
        callMessage.tool_calls.length > 0
      ) {
        timeMetrics.toolsCalled = callMessage.tool_calls
          .map((tc) => tc.function?.name)
          .filter(Boolean)
      }
      this.logUsage(providerName, finalUsage, timeMetrics)

      // 在流式循环结束后，检查是否有工具需要调用
      if (
        callMessage &&
        callMessage.tool_calls &&
        callMessage.tool_calls.length > 0
      ) {
        if (cachedMessage.content) {
          e.body.extraCachedContent = cachedMessage.content
        }
        if (cachedMessage.reasoning_content) {
          e.body.extraCachedReasoningContent = cachedMessage.reasoning_content
        }
        return { stepId, toolCalls: callMessage.tool_calls }
      }
    } else {
      // 非流式处理
      const timeMetrics = {
        contactorId: e?.body?.contactorId,
        e: e,
        firstTokenTime: null,
        isStream: false,
        model: body.model,
        presetName: e?.body?.settings?.presetSettings?.name,
        requestId: e?.requestId,
        startTime: Date.now(),
        stepId,
        userId: e?.user?.id,
        userIp: e?.user?.ip,
      }
      const controller = new AbortController()
      e.onAbort(() => controller.abort())

      const completion = await this.openai.chat.completions.create(body, {
        signal: controller.signal,
      })

      if (completion.usage) {
        const providerName =
          this.constructor.getAdapterMetadata()?.name || this.provider
        const toolCalls = completion.choices?.[0]?.message?.tool_calls
        if (toolCalls && toolCalls.length > 0) {
          timeMetrics.toolsCalled = toolCalls
            .map((tc) => tc.function?.name)
            .filter(Boolean)
        }
        this.logUsage(providerName, completion.usage, timeMetrics)
        // 挂载本轮 usage 到事件对象，供结晶水位线检查使用
        e.lastUsage = completion.usage
      }
      const { message } = completion.choices[0]
      if (message?.tool_calls?.length > 0) {
        if (message.content) {
          e.body.extraCachedContent = message.content
          e.update({
            content: message.content,
            type: 'content',
          })
        }
        if (message.reasoning_content) {
          e.body.extraCachedReasoningContent = message.reasoning_content
          e.update({
            content: message.reasoning_content,
            type: 'reasoningContent',
          })
        }
        return { stepId, toolCalls: message.tool_calls }
      } else {
        // 处理模型标准返回的 reasoning_content（如果存在）
        if (message?.reasoning_content) {
          e.update({
            content: message.reasoning_content,
            type: 'reasoningContent',
          })
        }
        if (message?.content) {
          e.update({
            content: message.content,
            type: 'content',
          })
        }
        return {} // 返回一个空对象，避免后续处理出错
      }
    }
    return {}
  }

  /**
   * 扩展 assistant 消息的钩子方法。
   * 子类可覆盖此方法以在 callMessage 推入历史前注入额外字段。
   * @param {object} callMessage
   * @param {object} e
   */
  _extendAssistantMessage(callMessage, e) {
    if (e.body.extraCachedReasoningContent) {
      callMessage.reasoning_content = e.body.extraCachedReasoningContent
      delete e.body.extraCachedReasoningContent
    }
  }

  /**
   * 判断当前模型或消息是否需要保留/回传 reasoning_content（如 DeepSeek、R1、QwQ、thinking 等模型）
   * @param {string} [modelName]
   * @param {object} [message]
   * @returns {boolean}
   */
  _shouldPreserveReasoning(modelName = '', message = null) {
    if (this.shouldPreserveReasoningContent === true) {
      return true
    }
    const modelLower = String(modelName || '').toLowerCase()
    const isReasoningModel =
      modelLower.includes('deepseek') ||
      modelLower.includes('reasoner') ||
      modelLower.includes('r1') ||
      modelLower.includes('qwq') ||
      modelLower.includes('thinking') ||
      modelLower.includes('glm-zero') ||
      modelLower.includes('kimi-k1.5') ||
      modelLower.includes('minicpm') ||
      modelLower.includes('mimo')
    if (isReasoningModel) {
      return true
    }
    if (
      message &&
      typeof message.reasoning_content === 'string' &&
      message.reasoning_content.length > 0
    ) {
      return true
    }
    return false
  }

  /**
   * 辅助方法：处理第三方 OpenAI 兼容接口的 thinking/extra_body 逻辑
   * @param {object} preparedBody - 已初步构建的请求体
   * @param {number|string} reasoningEffort - 原始的 reasoning_effort 参数
   * @param {object} [reasoningEffortTable] - 可选的 reasoning_effort 转换表。如果不传，则不向顶级 preparedBody 注入 reasoning_effort 字段
   */
  _applyExtraThinkingBody(
    preparedBody,
    reasoningEffort,
    reasoningEffortTable = null,
  ) {
    // 1. 剥离可能存在的旧 thinking 属性，防止干扰
    if (preparedBody.thinking) {
      delete preparedBody.thinking
    }

    if (reasoningEffort !== undefined && reasoningEffort !== null) {
      if (reasoningEffort === 0 || reasoningEffort === '0') {
        preparedBody.extra_body = {
          thinking: {
            type: 'disabled',
          },
        }
        if ('reasoning_effort' in preparedBody) {
          delete preparedBody.reasoning_effort
        }
      } else {
        preparedBody.extra_body = {
          thinking: {
            type: 'enabled',
          },
        }
        if (reasoningEffortTable) {
          preparedBody.reasoning_effort =
            reasoningEffortTable[reasoningEffort] ||
            reasoningEffortTable['-1'] ||
            'high'
        } else {
          if ('reasoning_effort' in preparedBody) {
            delete preparedBody.reasoning_effort
          }
        }
      }
    } else {
      if ('reasoning_effort' in preparedBody) {
        delete preparedBody.reasoning_effort
      }
    }
  }
}
