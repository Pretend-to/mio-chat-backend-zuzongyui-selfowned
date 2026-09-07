import streamCache from '../services/streamCache.js'
import sessions from '../services/sessions.js'
import {
  formatWebErrorMessage,
  parseErrorDetails,
} from '../../../../utils/errorFormatter.js'

export default class LLMMessageEvent {
  constructor(req, client) {
    this.body = req.data

    this.metaData = { ...(req.metaData || req.data?.metaData) }
    if (!this.metaData.triggerType) {
      this.metaData.triggerType = this.metaData.isTask ? 'task' : 'chat'
    }

    this.requestId = req.request_id

    this._everUpdate = false

    const { id, ip, isAdmin, origin } = client

    this.user = { id, ip, isAdmin, origin }

    this.client = client
    this.aborted = false
    this.completed = false
    this._abortCallbacks = []
    this.requestStartTime = Date.now() // 后端发起请求的绝对时间戳
    this.currentReasoningStartTime = null // 当前推理段的开始时间
    this.lastChunkType = null // 上一个 chunk 的类型
    this._interactions = new Map() // 用于存放正在悬停挂起的交互 Promise 回调
  }

  abort() {
    if (this.aborted) {
      return
    }
    this.aborted = true
    this._abortCallbacks.forEach((cb) => cb())
    logger.info(`Request ${this.requestId} aborted by user`)

    // 中止时正常发送 complete 信号，避免前端一直处于 streaming 状态
    this.complete()
  }

  onAbort(callback) {
    if (this.aborted) {
      callback()
    } else {
      this._abortCallbacks.push(callback)
    }
  }

  pending() {
    logger.debug('LLM Message pending')
    this.res('pending', {})
  }

  update(chunk) {
    if (!this._everUpdate) {
      this._everUpdate = true
    }

    let finalChunk = chunk
    const currentType = chunk.type

    // 如果是瞬态交互指令（除二次确认 REQUEST_APPROVAL 之外），直接通过 socket 送达，不存入重连流缓存，防止重连无意义弹窗
    if (
      currentType === 'action' &&
      chunk.content?.actionType !== 'REQUEST_APPROVAL'
    ) {
      this.res('update', finalChunk)
      return
    }

    // 自动转换为 reason 类型并注入 startTime
    if (currentType === 'reasoningContent') {
      // 如果上一条不是 reasoning，或者是第一条 reasoning，则记录当前段的开始时间
      if (this.lastChunkType !== 'reasoningContent') {
        this.currentReasoningStartTime = Date.now()
      }

      finalChunk = {
        data: {
          duration: 0,
          startTime: this.currentReasoningStartTime,
          text: chunk.content,
        },
        type: 'reason',
      }
    }

    this.lastChunkType = currentType

    // 缓存到服务端，用于重连同步
    if (this.metaData.contactorId) {
      streamCache.push(
        this.user.id,
        this.metaData.contactorId,
        this.metaData.messageId || this.requestId,
        finalChunk,
        this.metaData,
      )

      // --- 核心修复：检查水位线 ---
      // 如果该 chunk 已经被包含在刚刚发送给客户端的 sync 快照中了，则不再重复发送 update
      if (
        streamCache.isAlreadySynced(this.user.id, this.metaData.contactorId)
      ) {
        // Logger.debug(`[Sync] 拦截重复 chunk 发送: ${this.requestId}`)
        return
      }
    }

    this.res('update', finalChunk)
  }
  complete() {
    if (this.completed) {
      return
    }
    this.completed = true
    if (this.metaData.contactorId) {
      streamCache.complete(
        this.user.id,
        this.metaData.contactorId,
        this.metaData.messageId || this.requestId,
      )
    }

    if (!this._everUpdate) {
      const Tip = '模型无响应，请检查输入是否合法！'
      this.update({
        content: Tip,
        type: 'content',
      })
    }
    logger.debug('LLM Message complete')
    this.res('complete', {})

    // 自动总结逻辑 (异步执行，不阻塞主流程)
    this._checkAndSummarize().catch((error) => {
      logger.error('[LLMMessageEvent] Auto-summarization error:', error)
    })

    this.client.popEvent(this.requestId) // 任务完成，清理注册
  }

  /**
   * 检查并执行自动总结
   * @private
   */
  async _checkAndSummarize() {
    // 仅针对对话请求 (包含 contactorId) 且不是内部标题生成任务本身
    if (
      !this.metaData.contactorId ||
      this.requestId.startsWith('system_title_')
    ) {
      return
    }

    const messages = this.body.messages || []
    const history = this.body.settings?.presetSettings?.history || []

    // 关键修复：排除系统消息，且扣除预设历史的消息条数，只计算“当下”的对话消息
    const totalNonSystem = messages.filter((m) => m.role !== 'system').length
    const historyNonSystem = history.filter((m) => m.role !== 'system').length
    const currentCount = totalNonSystem - historyNonSystem

    // 性能优化：检查联系人的名称策略。如果不是自动总结模式 (2)，则不进行任何操作。
    const { namePolicy } = this.metaData

    if (Number(namePolicy) !== 2) {
      logger.debug(
        `[AutoTitle] Skipping for ${this.metaData.contactorId} due to namePolicy: ${namePolicy} (type: ${typeof namePolicy})`,
      )
      return
    }

    // 触发阈值：第 1 次 AI 回复后 (messages.length 为 1, 即只有 1 条 User 消息)，
    // 以及之后的每 6 条 (7, 13, ...)
    if (
      currentCount === 1 ||
      (currentCount > 1 && (currentCount - 1) % 6 === 0)
    ) {
      const llmService = (await import('../../../chat/llm/index.js')).default

      // 获取当前刚刚完成的 AI 回复内容 (getMessageText 已自动过滤掉 reasoningContent)
      const aiResponse = streamCache.getMessageText(
        this.user.id,
        this.metaData.contactorId,
        this.metaData.messageId || this.requestId,
      )

      // 构造用于标题生成的完整上下文 (历史 + 当前回复)
      const titleContext = [...messages]
      if (aiResponse) {
        titleContext.push({ content: aiResponse, role: 'assistant' })
      }

      const newTitle = await llmService.generateChatTitle(titleContext)

      if (newTitle) {
        // 推送更新信号给所有端
        const allClients = sessions.getClientsByUserId(this.user.id, true)
        if (allClients) {
          allClients.forEach((c) => {
            c.sendSystemMessage('chat_title_updated', {
              contactorId: this.metaData.contactorId,
              title: newTitle,
            })
          })
        }
      }
    }
  }
  reply(chunk) {
    this.res('reply', chunk)
  }
  error(error) {
    if (this.completed) {
      return
    }
    this.completed = true
    logger.error(error) // 正常记录完整 error（包含 stack）

    const details = parseErrorDetails(error)
    const formattedWebMessage = formatWebErrorMessage(error)

    // 只拷贝前端需要的安全字段，避免污染/破坏原始 Error 对象的 stack 属性
    const errorObject = {
      code: details.code,
      message: formattedWebMessage,
      requestId: details.requestId,
      status: details.status,
    }

    if (this.metaData.contactorId) {
      streamCache.fail(
        this.user.id,
        this.metaData.contactorId,
        this.metaData.messageId || this.requestId,
        errorObject,
      )
    }

    this.res('failed', errorObject)
    this.client.popEvent(this.requestId) // 任务失败，清理注册
  }
  /**
   * 注册交互 Promise 的 resolve 回调
   * @param {string} interactionId 交互ID
   * @param {Function} callback 唤醒 Promise 的回调函数
   */
  registerInteraction(interactionId, callback) {
    this._interactions.set(interactionId, callback)
  }

  /**
   * 注销交互（多用于超时或被消费后清理）
   * @param {string} interactionId 交互ID
   * @returns {boolean} 是否注销成功
   */
  unregisterInteraction(interactionId) {
    return this._interactions.delete(interactionId)
  }

  /**
   * 唤醒挂起的 Promise，传入客户端回传的 payload 数据
   * @param {string} interactionId 交互ID
   * @param {object} data 反馈的数据载荷
   * @returns {boolean} 是否成功唤醒
   */
  emitInteraction(interactionId, data) {
    const callback = this._interactions.get(interactionId)
    if (callback) {
      callback(data) // 触发挂起的 Promise 的 resolve 流程
      this._interactions.delete(interactionId) // 消费成功，立即移除
      return true
    }
    return false
  }

  res(type, data) {
    let fullData = {
      metaData: this.metaData,
    }

    if (typeof data === 'string') {
      fullData.message = data
    } else if (typeof data === 'object' && data !== null) {
      fullData = { ...data, metaData: this.metaData }
    } else {
      console.warn('Unexpected data type:', typeof data, data) // 记录警告
    }

    this.client.sendOpenaiMessage(type, fullData, this.requestId)
  }
}
