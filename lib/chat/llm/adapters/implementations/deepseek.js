import OpenAIBot from './openai.js'

/**
 * @class DeepSeek 适配器
 * 继承自 OpenAI，主要区别在于需要缓存 reasoning_content 并在 tool call 后发回
 */
export default class DeepSeekAdapter extends OpenAIBot {
  /**
   * 获取适配器元数据
   */
  static getAdapterMetadata() {
    return {
      avatarId: 'deepseek',
      description:
        'DeepSeek 官方 API 适配器。提供对 DeepSeek-V3, DeepSeek-R1 等高性能模型的访问，以极低成本提供媲美主流大模型的推理能力。原生兼容 OpenAI 接口规范，特别优化了思维链（Reasoning）渲染逻辑。\n\n**获取方式**：在 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys) 创建 API 密钥。',
      initialConfigSchema: {
        api_key: {
          default: '',
          description: 'DeepSeek API 密钥',
          label: 'API Key',
          placeholder: 'API Key',
          required: true,
          type: 'password',
        },
        base_url: {
          default: 'https://api.deepseek.com/v1',
          description: 'DeepSeek API 的基础 URL',
          label: 'Base URL',
          placeholder: 'https://api.deepseek.com/v1',
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
          placeholder: '例如：DeepSeek-主要',
          required: false,
          type: 'string',
        },
      },
      name: 'DeepSeek',
      supportedFeatures: ['chat', 'streaming', 'function_calling', 'reasoning'],
      type: 'deepseek',
    }
  }

  /**
   * 构造函数
   */
  constructor(deepseekConfig) {
    super(deepseekConfig)
    this.provider = 'deepseek'
    this.shouldPreserveReasoningContent = true
    // 视觉能力由基类 supportsVision() 委托 ModelRegistry 动态查表判断
  }

  async _prepareChatBody(body) {
    // 1. 优先提取原始的 reasoning_effort 参数，避免父类过滤剥离
    const originalEffort = body.settings?.chatParams?.reasoning_effort

    // 2. 调用父类的常规转换（如 tools、多模态消息处理）
    const preparedBody = await super._prepareChatBody(body)

    const deepseekReasoningEffortTable = {
      '-1': 'high', // 默认 high
      0: undefined, // Disabled
      1: undefined, // None → disabled
      2: 'high', // Low → high（官方兼容映射）
      3: 'high', // Medium → high（官方兼容映射）
      4: 'max', // High → max
      5: 'max', // Max → max
    }

    // 确定思考强度，默认设为 'high' 以规整多轮前缀缓存 key，防顶级参数不一致导致缓存失效
    const reasoningEffort = originalEffort !== undefined ? originalEffort : -1

    // 3. 调用父类通用方法应用 thinking/extra_body 逻辑
    this._applyExtraThinkingBody(
      preparedBody,
      reasoningEffort,
      deepseekReasoningEffortTable,
    )

    return preparedBody
  }
}
