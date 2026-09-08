/**
 * channels/llm.js — 渠道跨平台 LLM 统一对话桥接层
 *
 * 职责：
 * 1. 统一为所有渠道（微信、飞书、钉钉、Telegram 等）构造标准化内部请求事件 (Internal Event)
 * 2. 默认装配注入全量核心工具集（ai-plugin, skill-plugin, terminal-pty, channel-manager-plugin）
 * 3. 自动将 SkillService 中的技能目录注册注入到 System Prompt (<skill_registry>)
 * 4. 监听底层流式输出并利用状态机将完成的文本块和原生媒体 (图片等) 实时推送给渠道
 * 5. 精密装配并还原历史消息中的 Tool Calls（ID、入参、运行结果）及思考链，防止多轮对话工具依赖断裂
 */

import skillService from '../lib/chat/llm/services/SkillService.js'
import { wrapUserMessageWithTimestamp } from '../lib/chat/messageTimestamp.js'
import sessions from '../lib/server/socket.io/services/sessions.js'
import streamCache from '../lib/server/socket.io/services/streamCache.js'

/**
 * 动态获取当前系统已加载的所有可用工具完整名称（带 _mid_ 实例哈希）
 * 与前端及系统全局 Preset 规范保持 100% 一致，杜绝硬编码
 */
export function getRegisteredSystemToolNames() {
  const plugins = global.middleware?.plugins || []
  const toolNames = []
  for (const plugin of plugins) {
    if (typeof plugin.getTools !== 'function') continue
    const toolsMap = plugin.getTools()
    if (toolsMap && typeof toolsMap.values === 'function') {
      for (const toolsArray of toolsMap.values()) {
        if (Array.isArray(toolsArray)) {
          for (const t of toolsArray) {
            if (t.name && !toolNames.includes(t.name)) {
              toolNames.push(t.name)
            }
          }
        }
      }
    }
  }
  return toolNames
}

/**
 * 自动识别并补全存量 meta.json 中没有哈希的短工具名（如 'search', 'memory' -> 'search_mid_xxx'）
 * @param {Array<string>} tools
 * @param {Array<string>} [allSystemTools]
 * @returns {{ migrated: boolean, tools: Array<string> }}
 */
export function completeToolHashes(tools, allSystemTools = []) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return { migrated: false, tools: tools || [] }
  }
  const systemTools =
    Array.isArray(allSystemTools) && allSystemTools.length > 0
      ? allSystemTools
      : getRegisteredSystemToolNames()

  let migrated = false
  const completed = tools.map((t) => {
    if (typeof t !== 'string') return t
    if (t.includes('_mid_')) {
      return t
    }
    const matched = systemTools.find(
      (st) =>
        st === t || st.split('_mid_')[0] === t || st.startsWith(`${t}_mid_`),
    )
    if (matched) {
      migrated = true
      return matched
    }
    return t
  })

  return { migrated, tools: completed }
}

export function createEchoLlm({ prefix = '' } = {}) {
  return {
    getModels: () => ({ default: 'echo', models: { echo: ['echo-default'] } }),
    process: async (ctx) => ({ text: `${prefix}${ctx.text}` }),
  }
}

function parseMultimodalContent(text) {
  if (typeof text !== 'string') return text
  const regex =
    /!\[.*?\]\(((?:https?|data|file):\/\/.*?|\/f\/up\/.*?|\/f\/gen\/.*?)\)/g
  const parts = []
  let lastIndex = 0
  let match
  while ((match = regex.exec(text)) !== null) {
    const textPart = text.slice(lastIndex, match.index).trim()
    if (textPart) {
      parts.push({ type: 'text', text: textPart })
    }
    parts.push({ type: 'image_url', image_url: { url: match[1] } })
    lastIndex = regex.lastIndex
  }
  const rest = text.slice(lastIndex).trim()
  if (rest) {
    parts.push({ type: 'text', text: rest })
  }
  return parts.length > 0 ? parts : text
}

/**
 * Build the canonical channel user input once and reuse it for both the
 * current LLM request and session persistence.
 *
 * The request-side representation intentionally puts explicit images before
 * the text part.  Persisted channel messages use the equivalent frontend
 * image/text nodes, so converting the message back on the next turn produces
 * the exact same message prefix.  Keeping these two representations in sync
 * is important for provider-side input/prompt caching.
 */
export function prepareChannelUserInput(
  text = '',
  images = [],
  messageTime = null,
) {
  const originalText = typeof text === 'string' ? text : String(text ?? '')
  const imageList = []
  const addImage = (url) => {
    if (typeof url === 'string' && url && !imageList.includes(url)) {
      imageList.push(url)
    }
  }

  if (Array.isArray(images)) {
    images.forEach(addImage)
  }

  // Markdown images embedded in the text are also explicit multimodal input.
  // Extract them before adding the stable timestamp envelope, otherwise the
  // envelope itself can interfere with parsing.
  const parsedInput = parseMultimodalContent(originalText)
  if (Array.isArray(parsedInput)) {
    for (const part of parsedInput) {
      if (part.type === 'image_url') {
        addImage(part.image_url?.url || part.image_url)
      }
    }
  }

  let sourceText = originalText
  if (imageList.length > 0) {
    const imagePrompt = `\n\n以下是用户所上传的图片链接：\n${imageList.join('\n')}`
    if (
      !sourceText.includes('以下是用户所上传的图片链接：') &&
      !sourceText.includes(imageList[0])
    ) {
      sourceText = (sourceText ? sourceText + imagePrompt : imagePrompt).trim()
    }
  }

  const timestampedText = wrapUserMessageWithTimestamp(sourceText, messageTime)
  const latestContent =
    imageList.length > 0
      ? [
          ...imageList.map((url) => ({
            image_url: { url },
            type: 'image_url',
          })),
          { text: timestampedText || '[图片]', type: 'text' },
        ]
      : parseMultimodalContent(timestampedText)

  // This is the lossless frontend/session representation of the same input.
  // Do not put the timestamp envelope or duplicated markdown links in storage;
  // the next request derives the envelope deterministically from message.time.
  const persistedContent =
    imageList.length > 0
      ? [
          ...imageList.map((url) => ({ data: { file: url }, type: 'image' })),
          { data: { text: sourceText || '[图片]' }, type: 'text' },
        ]
      : [{ data: { text: sourceText }, type: 'text' }]

  return {
    imageList,
    latestContent,
    persistedContent,
    sourceText,
  }
}

/**
 * Find user messages injected after the current channel input during tool
 * recursion.  They are not ordinary chat input, but they are part of the
 * previous recursive context and must survive the frontend-format roundtrip.
 */
export function collectRecursiveUserMessages(messages, currentUserMessage) {
  if (!Array.isArray(messages)) return []

  const currentIndex = messages.indexOf(currentUserMessage)
  if (currentIndex < 0) return []

  const entries = []
  let lastToolCallId = null
  let toolCallOrdinal = -1

  for (let i = currentIndex + 1; i < messages.length; i++) {
    const message = messages[i]
    if (!message) continue

    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        lastToolCallId = call?.id || call?.call_id || null
        toolCallOrdinal++
      }
      continue
    }

    if (message.role === 'user') {
      entries.push({
        afterToolCallId: lastToolCallId,
        afterToolCallOrdinal: toolCallOrdinal,
        message,
      })
    }
  }

  return entries
}

/**
 * Preserve recursive user context inside the single visible assistant
 * MessageChain node.  `convertChatHistoryToLLMMessages` expands these hidden
 * markers back into real user messages at the original tool-call boundary.
 */
export function appendRecursiveContextMessages(content, entries) {
  if (
    !Array.isArray(content) ||
    !Array.isArray(entries) ||
    entries.length === 0
  ) {
    return Array.isArray(content) ? content : []
  }

  const byId = new Map()
  const byOrdinal = new Map()
  const markerEntries = entries.map((entry) => {
    const marker = {
      data: {
        content: entry.message?.content,
        role: 'user',
      },
      type: 'context_message',
    }
    return { entry, marker }
  })
  const addMarker = ({ entry, marker }) => {
    const ordinalList = byOrdinal.get(entry.afterToolCallOrdinal) || []
    ordinalList.push(marker)
    byOrdinal.set(entry.afterToolCallOrdinal, ordinalList)

    if (entry.afterToolCallId) {
      const list = byId.get(entry.afterToolCallId) || []
      list.push(marker)
      byId.set(entry.afterToolCallId, list)
    }
  }
  markerEntries.forEach(addMarker)

  const result = []
  let toolCallOrdinal = -1
  const inserted = new Set()
  for (const node of content) {
    result.push(node)
    if (node?.type !== 'tool_call') continue

    toolCallOrdinal++
    const id = node.data?.id || null
    const markers = [
      ...(id ? byId.get(id) || [] : []),
      ...(byOrdinal.get(toolCallOrdinal) || []),
    ]
    for (const marker of markers) {
      if (inserted.has(marker)) continue
      inserted.add(marker)
      result.push(marker)
    }
  }

  // A provider may omit a tool id in its stream.  Keep such context rather
  // than silently dropping it; ordinal matching above handles the normal
  // case, while this fallback preserves the complete chain for recovery.
  for (const { marker } of markerEntries) {
    if (!inserted.has(marker)) {
      inserted.add(marker)
      result.push(marker)
    }
  }

  return result
}

/**
 * 渠道历史消息 (ctx.chat) 精密转换为大模型标准 messages 数组（支持 Tool Calls, Reasoning, Tool Results）
 */
export function convertChatHistoryToLLMMessages(chatHistory) {
  const msgs = []
  if (!Array.isArray(chatHistory)) return msgs

  const convertStoredUserContent = (content, time) => {
    if (!Array.isArray(content)) {
      const textContent = typeof content === 'string' ? content : ''
      return parseMultimodalContent(
        wrapUserMessageWithTimestamp(textContent, time),
      )
    }

    const explicitImages = []
    let textContent = ''
    let hasExplicitImage = false
    for (const part of content) {
      if (part?.type === 'image') {
        const url = part.data?.file || part.data?.url || part.url
        if (
          url &&
          !explicitImages.some((image) => image.image_url?.url === url)
        ) {
          explicitImages.push({ image_url: { url }, type: 'image_url' })
        }
        hasExplicitImage = true
      } else if (part?.type === 'image_url' || part?.type === 'input_image') {
        const url =
          part.image_url?.url || part.image_url || part.image || part.data?.file
        if (
          url &&
          !explicitImages.some((image) => image.image_url?.url === url)
        ) {
          explicitImages.push({ image_url: { url }, type: 'image_url' })
        }
        hasExplicitImage = true
      } else if (part?.type === 'text' || part?.type === 'input_text') {
        textContent += part.data?.text ?? part.text ?? ''
      }
    }

    const timestampedText = wrapUserMessageWithTimestamp(textContent, time)
    if (hasExplicitImage) {
      return [
        ...explicitImages,
        { text: timestampedText || '[图片]', type: 'text' },
      ]
    }
    return parseMultimodalContent(timestampedText)
  }

  for (const item of chatHistory) {
    if (!item) continue

    // 1. 如果包含结构化 content 数组（与 TaskRunner/前端格式一致）
    if (Array.isArray(item.content)) {
      if (item.role === 'system') {
        const textContent = item.content
          .filter((c) => c.type === 'text')
          .map((c) => c.data?.text || '')
          .join('')
        if (textContent.trim()) {
          msgs.push({
            content: `[系统通知]: ${textContent.trim()}`,
            role: 'user',
          })
        }
      } else if (item.role === 'user') {
        msgs.push({
          content: convertStoredUserContent(item.content, item.time),
          role: 'user',
        })
      } else if (item.role === 'assistant' || item.role === 'other') {
        let currentAssistant = null
        let pendingReasoning = ''
        let pendingToolMessages = []

        const flushAssistant = () => {
          if (currentAssistant) {
            if (pendingReasoning) {
              currentAssistant.reasoning_content = pendingReasoning
              pendingReasoning = ''
            }
            if (
              !currentAssistant.content &&
              (!currentAssistant.tool_calls ||
                currentAssistant.tool_calls.length === 0)
            ) {
              currentAssistant.content = ''
            }
            msgs.push(currentAssistant)
            currentAssistant = null
          }
          if (pendingToolMessages.length > 0) {
            msgs.push(...pendingToolMessages)
            pendingToolMessages = []
          }
        }

        item.content.forEach((elm, elmIdx) => {
          if (elm.type === 'reason') {
            if (
              currentAssistant &&
              currentAssistant.tool_calls &&
              currentAssistant.tool_calls.length > 0
            ) {
              flushAssistant()
            }
            pendingReasoning += elm.data?.text || ''
          } else if (elm.type === 'text') {
            if (
              currentAssistant &&
              currentAssistant.tool_calls &&
              currentAssistant.tool_calls.length > 0
            ) {
              flushAssistant()
            }
            if (!currentAssistant) {
              currentAssistant = { content: '', role: 'assistant' }
            }
            currentAssistant.content =
              (currentAssistant.content || '') + (elm.data?.text || '')
          } else if (elm.type === 'tool_call') {
            if (!currentAssistant) {
              currentAssistant = { role: 'assistant' }
            }
            if (!currentAssistant.tool_calls) {
              currentAssistant.tool_calls = []
            }
            const args = elm.data.arguments || elm.data.parameters || ''
            const callId =
              elm.data.id || `call_${elm.data.name || 'tool'}_${elmIdx}`
            currentAssistant.tool_calls.push({
              function: {
                arguments:
                  typeof args === 'string' ? args : JSON.stringify(args || {}),
                name: elm.data.name,
              },
              id: callId,
              type: 'function',
            })

            pendingToolMessages.push({
              content:
                typeof elm.data.result === 'string'
                  ? elm.data.result
                  : JSON.stringify(elm.data.result || 'Success'),
              name: elm.data.name,
              role: 'tool',
              tool_call_id: callId,
            })
          } else if (elm.type === 'context_message') {
            // A tool may inject a user message into the recursive request
            // (for example a direct multimodal pass-through).  Flush the
            // preceding assistant/tool segment first, then restore the user
            // node exactly at that boundary.
            flushAssistant()
            msgs.push({
              content: convertStoredUserContent(elm.data?.content, null),
              role: 'user',
            })
          }
        })

        flushAssistant()

        if (pendingReasoning) {
          msgs.push({
            content: '',
            reasoning_content: pendingReasoning,
            role: 'assistant',
          })
        }
      } else if (item.role === 'tool') {
        msgs.push(item)
      }
    } else if (item.tool_calls || item.role === 'tool') {
      // 2. 如果本身已经是标准的 OpenAI 格式消息节点
      msgs.push(item)
    }
  }
  return msgs
}

/**
 * 将本轮运行接收到的所有流式 chunks 转为结构化 content 节点数组（合并连续文本与思考块，tool_call 按 ID 原地更新，绝不重复碎片化落盘）
 */
function assembleStructuredContent(chunks) {
  const content = []
  if (!Array.isArray(chunks) || chunks.length === 0) return content

  let currentText = ''
  let currentReason = ''
  let reasonData = null

  // 用于 tool_call 按 id 去重与状态合并：callId -> content array index
  const toolCallIndexMap = new Map()

  const flushText = () => {
    const trimmed = currentText.trim()
    if (trimmed) {
      content.push({
        data: { text: currentText },
        type: 'text',
      })
    }
    currentText = ''
  }

  const flushReason = () => {
    if (currentReason && currentReason.trim()) {
      const now = Date.now()
      const start = reasonData?.startTime || now - 1000
      const duration =
        reasonData?.duration || (now > start ? now - start : 1000)
      const safeDuration = duration > 0 ? duration : 1000
      content.push({
        data: {
          duration: safeDuration,
          endTime: start + safeDuration,
          startTime: start,
          text: currentReason,
        },
        type: 'reason',
      })
    }
    currentReason = ''
    reasonData = null
  }

  for (const chunk of chunks) {
    if (!chunk) continue

    if (chunk.type === 'reason' || chunk.type === 'reasoningContent') {
      flushText()
      currentReason +=
        chunk.data?.text ||
        (typeof chunk.content === 'string' ? chunk.content : '')
      if (!reasonData && chunk.data) {
        reasonData = chunk.data
      }
    } else if (chunk.type === 'content') {
      flushReason()
      if (typeof chunk.content === 'string') {
        currentText += chunk.content
      } else if (typeof chunk.data?.text === 'string') {
        currentText += chunk.data.text
      }
    } else if (chunk.type === 'toolCall') {
      flushText()
      flushReason()

      const toolPayload = chunk.content || chunk
      const callId = toolPayload.id || `call_${Date.now()}`
      const isFinished =
        toolPayload.action === 'finished' || !!toolPayload.result
      const callStatus = isFinished
        ? 'done'
        : toolPayload.action === 'started'
          ? 'waiting'
          : 'running'

      const rawArgs = toolPayload.arguments || toolPayload.parameters || ''
      const toolCallData = {
        ...toolPayload,
        action: toolPayload.action || (isFinished ? 'finished' : 'running'),
        arguments:
          typeof rawArgs === 'object' ? JSON.stringify(rawArgs) : rawArgs,
        id: callId,
        name: toolPayload.name || '',
        parameters:
          typeof rawArgs === 'object' ? JSON.stringify(rawArgs) : rawArgs,
        result: toolPayload.result || '',
        status: callStatus,
      }

      if (toolCallIndexMap.has(callId)) {
        // 已有该 tool_call，原地合并更新为最新状态（避免 started/pending/finished 重复创建节点）
        const idx = toolCallIndexMap.get(callId)
        const existing = content[idx]
        existing.data = {
          ...existing.data,
          ...toolCallData,
          result: toolCallData.result || existing.data.result || '',
          extraRender: toolCallData.extraRender || existing.data.extraRender,
        }
      } else {
        // 新 tool_call 节点
        const node = {
          data: toolCallData,
          type: 'tool_call',
        }
        content.push(node)
        toolCallIndexMap.set(callId, content.length - 1)
      }
    } else if (chunk.type === 'crystallize') {
      flushText()
      flushReason()
      content.push({
        data: {
          status: chunk.content?.status || 'finished',
          summary: chunk.content?.summary || '',
        },
        type: 'crystallize_event',
      })
    }
  }

  flushReason()
  flushText()

  // 兜底保障：扫描所有 tool_call 节点，若存在未完成 (action !== 'finished' 或 result 为空) 的节点，自动补全 User aborted
  for (const node of content) {
    if (node.type === 'tool_call') {
      if (
        node.data.action !== 'finished' ||
        !node.data.result ||
        node.data.status === 'running'
      ) {
        node.data.action = 'finished'
        node.data.status = 'aborted'
        node.data.result = node.data.result || 'User aborted.'
      }
    }
  }

  return content
}

/**
 * 动态解析当前需要接收流式更新与完成状态的在线 Web 客户端。
 * 无论是 Channel 侧原生入站还是 Web 侧发送，均采用动态连接池查询，
 * 避免因单次网络波动/Socket实例重建导致的静态闭包失活与丢帧。
 */
export function resolveWebClients(ctx, isChannelApproval = false) {
  if (isChannelApproval) return []

  const clients = new Set()

  // 1. 获取所有在线管理员客户端（动态连接池最新活跃对象）
  const adminClients = sessions.getAllAdminClients() || []
  for (const client of adminClients) {
    if (client && client.socket) {
      clients.add(client)
    }
  }

  // 2. 若当前上下文持有发起端特定的 userId，动态获取该用户所有的活跃连接（支持多端及重连后实例）
  const userId = ctx.webClient?.id || (ctx.isWeb ? ctx.from : null)
  if (userId) {
    const userClients = sessions.getClientsByUserId(userId, true) || []
    for (const client of userClients) {
      if (client && client.socket) {
        clients.add(client)
      }
    }
  }

  // 3. 兜底保障：若初始捕获的 ctx.webClient 依然活跃，确保包含
  if (ctx.webClient && ctx.webClient.socket) {
    clients.add(ctx.webClient)
  }

  return Array.from(clients)
}

export function createBackendLlm(opts = {}) {
  const customService = opts.llmService || null

  return {
    getModels: (isAdmin = true) => {
      const svc =
        customService ||
        (typeof global !== 'undefined' && global.middleware?.llm)
      if (!svc || typeof svc.getModelList !== 'function') {
        return { default: 'echo', models: {} }
      }
      return {
        defaultProvider:
          typeof svc._getDefaultProvider === 'function'
            ? svc._getDefaultProvider()
            : 'openai',
        models: svc.getModelList(isAdmin) || {},
      }
    },

    process: async (ctx) => {
      const svc =
        customService ||
        (typeof global !== 'undefined' && global.middleware?.llm)
      if (!svc) {
        return { text: `[Echo] ${ctx.text}` }
      }

      const messages = []

      // 1. 组装 System Prompt（包含灵魂设定、全局长期记忆、会话结晶、技能目录）
      // 1. 组装 System Prompt（静态前缀优先排列，确保 Prompt Caching inputcache 100% 命中）
      const systemSections = []

      // 静态前缀：Skill 注册表 (与 Web UI 保持一致置顶)
      const skillsBlock = skillService?.buildSystemPromptBlock
        ? skillService.buildSystemPromptBlock()
        : ''
      if (skillsBlock) {
        systemSections.push(skillsBlock)
      }

      // 静态前缀：自治与工具说明
      systemSections.push(
        [
          '【工具使用与自治能力】',
          '你可以使用 `channel_profile` 自主管理自身灵魂，使用 `channel_session` 管理会话历史，使用 `channel_model` 切换底层模型，使用 `toolsmanager` 管理所有工具开闭，使用 `memory` 记录用户事实，使用 `bash` 执行终端命令，使用 `Skill` 加载专家能力。',
        ].join('\n'),
      )

      // 静态前缀：渠道交互风格 Prompt
      if (ctx.channel && typeof ctx.channel.getChannelPrompt === 'function') {
        const channelPrompt = ctx.channel.getChannelPrompt()
        if (channelPrompt?.trim()) {
          systemSections.push(channelPrompt.trim())
        }
      }

      // 稳定前缀：灵魂人设
      if (ctx.soul?.trim()) {
        systemSections.push(`【你的灵魂设定与行为准则】\n${ctx.soul.trim()}`)
      } else {
        systemSections.push(
          [
            '【灵魂设定】',
            '你当前尚未设定专属灵魂人格 (Soul)。你是一个温暖、聪明、善解人意的全能 AI 助手。',
            '💡【引导提示】：由于你还没有专属人设，请在适当时机（例如初次认识、开启新对话或交流顺畅时），自然友好地向用户自我介绍，并主动建议用户为你设定专属人格、语气或名字（例如：“你希望我怎样陪伴你呢？可以随时给我取个专属名字或者设定喜欢的性格哦～”）。',
            '一旦用户明确表达了对你的名字、性格、语气或角色期待，你可以直接调用 `channel_profile(action="update", soul="...")` 工具自主将这份灵魂固化保存，永久成为用户的专属陪伴。',
          ].join('\n'),
        )
      }

      // 稳定前缀：全局长期记忆
      if (ctx.globalMem?.trim()) {
        systemSections.push(
          `【关于用户的全局长期记忆与稳定事实】\n${ctx.globalMem.trim()}`,
        )
      }

      // 会话结晶 (memory_crystal)
      if (ctx.crystal?.trim()) {
        systemSections.push(
          `【会话历史事实结晶】\n<memory_crystal>\n${ctx.crystal.trim()}\n</memory_crystal>`,
        )
      }

      messages.push({
        content: systemSections.join('\n\n'),
        role: 'system',
      })

      // 2. 带入多轮会话历史 (精准支持 Tool Calls / Tool Results / Reasoning 消息还原)
      const chatHistoryCount = Array.isArray(ctx.chat) ? ctx.chat.length : 0
      if (Array.isArray(ctx.chat) && ctx.chat.length > 0) {
        const convertedLLMMessages = convertChatHistoryToLLMMessages(ctx.chat)
        messages.push(...convertedLLMMessages)
      }

      // 3. 当前最新用户输入。请求态与持久化态必须由同一份 canonical
      // 结构派生，保证下一轮重建出的历史是上一轮递归上下文的稳定前缀。
      const preparedInput = prepareChannelUserInput(
        ctx.text,
        ctx.images,
        ctx.messageTime,
      )
      const currentUserMessage = {
        content: preparedInput.latestContent,
        role: 'user',
      }
      messages.push(currentUserMessage)

      // 4. 确定使用的 provider 与 model
      const targetProvider =
        ctx.provider ||
        (typeof svc._getDefaultProvider === 'function'
          ? svc._getDefaultProvider()
          : undefined)
      let targetModel = ctx.model || null

      if (!targetModel && targetProvider && svc.llms) {
        const instanceId = Array.isArray(targetProvider)
          ? targetProvider[0]
          : targetProvider
        const inst = svc.llms[instanceId]
        if (inst?.models?.[0]?.models?.[0]) {
          targetModel = inst.models[0].models[0]
        }
      }

      const emittedRenders = new Set()
      const collectedChunks = []

      // 5. 构造虚拟 Event
      let currentTextBlock = ''
      let currentBlockType = 'idle'
      let streamError = null
      // Crystallization is triggered from adapter recursion through a
      // fire-and-forget update callback.  Serialize its storage side effects
      // and make completion wait for them, otherwise the next queued Channel
      // user message can read the old crystal/chat window.
      let contextPersistenceQueue = Promise.resolve()
      let crystalPersistenceSucceeded = false

      /**
       * 将累积的完整文本块原样交给渠道，由渠道适配器负责最终发送。
       * 按自身协议（<msg>/<break/>）统一切分，再经伪队列逐条发送。
       */
      const flushTextBlock = async () => {
        let textToSend = currentTextBlock.trim()
        currentTextBlock = '' // ← 先清空，防止 re-entrant 重复 emit
        if (!textToSend) {
          return
        }
        if (typeof ctx.onEmitTextBlock === 'function') {
          await ctx.onEmitTextBlock(textToSend)
        }
      }

      const defaultChannelTools = getRegisteredSystemToolNames()
      let savedTools = ctx.memory
        ? await ctx.memory.getAgentMeta('tools', null)
        : null
      if (Array.isArray(savedTools)) {
        const { migrated, tools: completedTools } = completeToolHashes(
          savedTools,
          defaultChannelTools,
        )
        if (migrated) {
          savedTools = completedTools
          ctx.memory.setAgentMeta('tools', completedTools).catch(() => {})
        }
      }
      const finalTools =
        Array.isArray(savedTools) && savedTools.length > 0
          ? savedTools
          : defaultChannelTools.length > 0
            ? defaultChannelTools
            : []
      const savedEffort = ctx.memory
        ? await ctx.memory.getAgentMeta('reasoning_effort', 0)
        : 0
      const chatParams =
        typeof savedEffort === 'number' && savedEffort > 0
          ? { reasoning_effort: savedEffort }
          : {}

      // 详细打印消息组装诊断日志（包含工具数、思考强度等关键信息）
      const log = ctx.channel?.log || console
      log.info?.(
        `[${ctx.channel?.channelType || 'channel'}] 🧩 消息链拼装完成: 总消息数=${messages.length} (System段数=${systemSections.length}, 历史轮数=${chatHistoryCount}, 注入工具数=${finalTools.length}, 思考强度=${savedEffort}, 当前输入="${ctx.text.slice(0, 30)}")`,
      )
      log.info?.(
        `[${ctx.channel?.channelType || 'channel'}] 🧠 记忆载入详情: Soul=${ctx.soul ? '已设定' : '无'}, GlobalMem=${ctx.globalMem ? `${ctx.globalMem.length}字` : '无'}, Crystal=${ctx.crystal ? `${ctx.crystal.length}字` : '无'}`,
      )

      let lastActionData = null
      let latestCrystal = null
      let currentReasoningStartTime = null
      const abortCallbacks = []
      let sessionYolo = false
      try {
        sessionYolo = ctx.channel?.isSessionYoloEnabled
          ? await ctx.channel.isSessionYoloEnabled(ctx.sessionId)
          : false
      } catch {
        // A metadata read failure must not break an otherwise valid chat; the
        // shell hook independently fails closed when it cannot read YOLO.
        sessionYolo = false
      }
      const event = {
        body: {
          channel: ctx.channel?.channelType || 'channel',
          messages,
          sessionId: ctx.sessionId || null,
          settings: {
            base: {
              model: targetModel,
              stream: true,
            },
            chatParams,
            crystallization: { enabled: true },
            crystallization_token_watermark: 'auto',
            pending_memory_events: ctx.pendingMemories || [],
            previous_summary: ctx.crystal || '',
            provider: targetProvider,
            yolo: sessionYolo,
            toolCallSettings: {
              mode: 'AUTO',
              tools: finalTools,
            },
          },
        },
        sessionId: ctx.sessionId || null,
        channel: ctx.channel || {
          agentId: ctx.agentId || 'channel-master',
          memory: ctx.memory,
          model: ctx.model,
          provider: ctx.provider,
          type: 'channel',
        },
        memory: ctx.memory,
        client: {
          emit: () => {},
          on: () => {},
          popConnection: () => {},
          popEvent: () => {},
          pushConnection: () => {},
          pushEvent: () => {},
          removeListener: () => {},
          sendOpenaiMessage: () => {},
        },
        interactions: new Map(),
        emitInteraction: (interactionId, data) => {
          const cb = event.interactions.get(interactionId)
          if (cb) {
            event.interactions.delete(interactionId)
            cb(data)
            return true
          }
          return false
        },
        error: (err) => {
          streamError = err
        },
        aborted: false,
        abort: () => {
          if (event.aborted) return
          event.aborted = true
          abortCallbacks.forEach((cb) => {
            try {
              cb()
            } catch {}
          })
          if (typeof event.complete === 'function') {
            event.complete()
          }
        },
        onAbort: (cb) => {
          if (event.aborted) {
            try {
              cb()
            } catch {}
          } else {
            abortCallbacks.push(cb)
          }
        },
        pending: () => {},
        registerInteraction: async (interactionId, callback) => {
          event.interactions.set(interactionId, callback)

          if (ctx.isWeb && ctx.webClient && ctx.messageId) {
            // 1. 来自 Web 客户端：注册到 webClient 活跃事件集，由前端通过 Socket.IO 就地弹窗与 tool:interact 交互
            ctx.webClient.pushEvent(ctx.messageId, event)
          } else {
            // 2. 来自渠道端（微信长轮询等）：向第三方渠道推送文本确认卡片并通过消息回复进行交互
            const reqFn =
              ctx.channel?.requestConfirmation ||
              ctx.channel?.requestUserConfirmation
            if (ctx.channel && typeof reqFn === 'function') {
              try {
                const meta = lastActionData?.meta || {}
                const prompt =
                  lastActionData?.prompt ||
                  'LLM 正在申请执行敏感操作，是否授权？'
                let title = '安全操作二次确认'
                const details = []

                if (
                  meta.type === 'global_memory' ||
                  meta.fact ||
                  meta.content
                ) {
                  title = '全局长期记忆更新审批'
                  const contentText = meta.content || meta.fact || ''
                  if (contentText) details.push(`📝 记忆内容：${contentText}`)
                  if (meta.category)
                    details.push(`📁 记忆分类：${meta.category}`)
                  if (meta.action)
                    details.push(
                      `⚙️ 操作类型：${meta.action === 'add' ? '新增' : meta.action === 'update' ? '更新' : meta.action === 'delete' ? '删除' : meta.action}`,
                    )
                  if (meta.target) details.push(`🎯 记忆目标：${meta.target}`)
                } else if (meta.command) {
                  title = meta.highRisk
                    ? '⚠️ 高危 Shell 命令授权'
                    : '💻 Shell 命令授权'
                  const commandPreview = meta.commandPreview || meta.command
                  details.push(
                    meta.rememberable === false
                      ? `💻 待执行命令：\n${commandPreview}`
                      : `💻 待执行命令：\`${commandPreview}\``,
                  )
                  if (meta.cwd) details.push(`📂 工作目录：${meta.cwd}`)
                } else if (meta.params) {
                  title = '⚙️ 系统配置修改审批'
                  const paramsStr =
                    typeof meta.params === 'object'
                      ? JSON.stringify(meta.params, null, 2)
                      : String(meta.params)
                  details.push(`⚙️ 修改内容：\n${paramsStr}`)
                } else if (meta.key && meta.value !== undefined) {
                  title = '⚙️ 配置修改审批'
                  details.push(
                    `⚙️ 修改项：${meta.key} -> ${JSON.stringify(meta.value)}`,
                  )
                }

                const description =
                  details.length > 0
                    ? `${prompt}\n\n${details.join('\n')}`
                    : prompt

                const res = await reqFn.call(
                  ctx.channel,
                  {
                    contextToken: ctx.contextToken,
                    command: meta.command,
                    commandPrefix1: meta.commandPrefix1,
                    commandPrefix2: meta.commandPrefix2,
                    description,
                    from: ctx.from,
                    rememberable: meta.rememberable === true,
                    title,
                  },
                  ctx,
                )
                event.emitInteraction(
                  interactionId,
                  typeof res === 'object' ? res : { approved: Boolean(res) },
                )
              } catch (err) {
                event.emitInteraction(interactionId, {
                  approved: false,
                  reason: err.message,
                })
              }
            } else {
              event.emitInteraction(interactionId, { approved: true })
            }
          }
        },
        reply: () => {},
        requestId: `${ctx.channel?.channelType || 'channel'}_${ctx.sessionId || Date.now()}_${Date.now()}`,
        unregisterInteraction: (interactionId) => {
          return event.interactions.delete(interactionId)
        },
        update: async (data) => {
          if (!data) return
          // 收集全量流式 chunk 用于完美组装结构化落盘数据
          collectedChunks.push(data)
          if (data.type === 'action' && data.content) {
            lastActionData = data.content
          }

          // 无论 Web 客户端是否在线，流式 Chunks 异步沉淀至 streamCache（完全不阻塞微信下发）
          const resolvedContactorId =
            ctx.channelId ||
            ctx.agentId ||
            ctx.channel?.id ||
            ctx.channel?.channelId ||
            ctx.memory?.agentId ||
            null
          if (resolvedContactorId && ctx.messageId) {
            let finalData = data
            if (data.type === 'reasoningContent') {
              if (!currentReasoningStartTime) {
                currentReasoningStartTime = Date.now()
              }
              finalData = {
                data: {
                  duration: 0,
                  startTime: currentReasoningStartTime,
                  text: data.content || data.data?.text || '',
                },
                type: 'reason',
              }
            } else if (data.type === 'reason') {
              if (!data.data && typeof data.content === 'string') {
                if (!currentReasoningStartTime) {
                  currentReasoningStartTime = Date.now()
                }
                finalData = {
                  data: {
                    duration: data.duration || 0,
                    startTime: data.startTime || currentReasoningStartTime,
                    text: data.content,
                  },
                  type: 'reason',
                }
              }
            } else if (data.type === 'content' || data.type === 'toolCall') {
              currentReasoningStartTime = null
            }

            const isChannelApproval =
              !ctx.isWeb &&
              data.type === 'action' &&
              data.content?.actionType === 'REQUEST_APPROVAL'
            const dataWithMeta = {
              ...finalData,
              metaData: {
                contactorId: resolvedContactorId,
                isTask: Boolean(ctx.isTask),
                messageId: ctx.messageId,
                triggerType: ctx.isTask ? 'task' : 'chat',
                ...data.metaData,
              },
            }

            // 渠道侧的审批卡片只能由渠道文本确认，不能写入/广播为 Web 可交互 action，
            // 否则 Web 会出现看得见但找不到 activeEvent 的“幽灵”确认框。
            if (!isChannelApproval) {
              // 1. 并发写入 streamCache，支撑离线回放（admin 与发起者双写）
              try {
                streamCache.push(
                  'admin',
                  resolvedContactorId,
                  ctx.messageId,
                  finalData,
                  dataWithMeta.metaData,
                )
                if (ctx.webClient?.id && ctx.webClient.id !== 'admin') {
                  streamCache.push(
                    ctx.webClient.id,
                    resolvedContactorId,
                    ctx.messageId,
                    finalData,
                    dataWithMeta.metaData,
                  )
                }
              } catch {}
            }

            // 2. 若存在在线 Web 客户端，动态推送镜像流
            const targetWebClients = resolveWebClients(ctx, isChannelApproval)
            if (targetWebClients.length > 0) {
              for (const client of targetWebClients) {
                client.sendOpenaiMessage('update', dataWithMeta, ctx.messageId)
              }
            }
          }

          if (data.type === 'crystallize') {
            if (data.content?.status === 'finished' && data.content?.summary) {
              const summaryXml = data.content.summary.trim()
              if (summaryXml) {
                latestCrystal = summaryXml
                if (ctx.memory && ctx.sessionId) {
                  contextPersistenceQueue = contextPersistenceQueue
                    .then(async () => {
                      await ctx.memory.setCrystal(ctx.sessionId, summaryXml)
                      if (
                        typeof ctx.memory.clearPendingMemories === 'function'
                      ) {
                        await ctx.memory.clearPendingMemories(ctx.sessionId)
                      }
                      // 上下文压缩闭环：归档 + 裁剪 + 读窗口更新必须在
                      // 下一条排队 user 进入前完成，否则会读到旧上下文。
                      if (typeof ctx.memory.rotateChat === 'function') {
                        const keepTurns =
                          Number(
                            event.body?.settings?.crystallization_keep_turns,
                          ) || 1
                        const rotateRes = await ctx.memory.rotateChat(
                          ctx.sessionId,
                          keepTurns,
                        )
                        if (rotateRes?.rotated) {
                          ctx.channel?.log?.info?.(
                            `[${ctx.channel?.channelType || 'channel'}] 🗜️ 会话历史已归档并裁剪 | 归档: ${rotateRes.archivePath} | 裁剪 ${rotateRes.removedCount} 条, 保留 ${rotateRes.keptCount} 条`,
                          )
                        }
                      }
                      crystalPersistenceSucceeded = true
                    })
                    .catch((err) => {
                      crystalPersistenceSucceeded = false
                      ctx.channel?.log?.error?.(
                        `[${ctx.channel?.channelType || 'channel'}] 记忆结晶/裁剪落盘失败:`,
                        err,
                      )
                    })
                }
              }
            }
          }

          if (data.type === 'content') {
            currentBlockType = 'text'
            if (typeof data.content === 'string') {
              currentTextBlock += data.content
            }
            // 同步阶段性输出到 activeJob
            if (
              ctx.channel?.activeJobs &&
              ctx.sessionId &&
              ctx.channel.activeJobs.has(ctx.sessionId)
            ) {
              const job = ctx.channel.activeJobs.get(ctx.sessionId)
              job.lastProgressText = currentTextBlock.slice(0, 100)
            }
          } else {
            if (currentBlockType === 'text') {
              await flushTextBlock()
            }
            // 同步正在执行的工具到 activeJob
            if (
              data.type === 'toolCall' &&
              ctx.channel?.activeJobs &&
              ctx.sessionId &&
              ctx.channel.activeJobs.has(ctx.sessionId)
            ) {
              const job = ctx.channel.activeJobs.get(ctx.sessionId)
              if (data.content?.action === 'running') {
                job.currentTool = data.content.name || '工具'
                job.toolCount = (job.toolCount || 0) + 1
              } else if (data.content?.action === 'finished') {
                job.currentTool = null
              }
            }
            // 严格以 extraRender（如 setOuterRender / setExtraRender）作为富媒体/状态渲染的契约
            if (data.type === 'toolCall' || data.type === 'extraRender') {
              const toolPayload = data.content || data
              const renders = [
                ...(Array.isArray(toolPayload?.extraRender)
                  ? toolPayload.extraRender
                  : toolPayload?.extraRender
                    ? [toolPayload.extraRender]
                    : []),
                ...(Array.isArray(data.extraRender)
                  ? data.extraRender
                  : data.extraRender
                    ? [data.extraRender]
                    : []),
              ]

              // 扫描 extraRender 中的规范渲染项并实时推送到渠道
              for (const r of renders) {
                if (!r) continue
                const renderKey =
                  r.url ||
                  r.text ||
                  (r.title ? `${r.title}:${r.description}` : JSON.stringify(r))
                if (emittedRenders.has(renderKey)) continue
                emittedRenders.add(renderKey)

                if (r.type === 'image' && (r.url || r.buffer || r.localPath)) {
                  if (typeof ctx.onEmitTextBlock === 'function') {
                    await ctx.onEmitTextBlock('', {
                      extraRender: r,
                      image: r.url,
                    })
                  }
                } else if (
                  (r.type === 'audio' || r.type === 'voice') &&
                  (r.url || r.buffer || r.localPath)
                ) {
                  if (typeof ctx.onEmitTextBlock === 'function') {
                    await ctx.onEmitTextBlock('', {
                      audio: r.url,
                      extraRender: r,
                    })
                  }
                } else if (
                  (r.type === 'file' || r.type === 'document') &&
                  (r.url || r.buffer || r.localPath)
                ) {
                  if (typeof ctx.onEmitTextBlock === 'function') {
                    await ctx.onEmitTextBlock('', {
                      extraRender: r,
                      file: r.url,
                    })
                  }
                } else if (
                  r.type === 'video' &&
                  (r.url || r.buffer || r.localPath)
                ) {
                  if (typeof ctx.onEmitTextBlock === 'function') {
                    await ctx.onEmitTextBlock('', {
                      extraRender: r,
                      video: r.url,
                    })
                  }
                } else if (
                  r.type === 'link' ||
                  (!r.type && (r.url || r.href))
                ) {
                  const linkUrl = r.url || r.href || ''
                  if (typeof ctx.onEmitTextBlock === 'function') {
                    await ctx.onEmitTextBlock('', {
                      extraRender: r,
                      link: linkUrl,
                    })
                  }
                } else if (r.type === 'card' || r.type === 'html') {
                  if (typeof ctx.onEmitTextBlock === 'function') {
                    await ctx.onEmitTextBlock('', {
                      card: r,
                      extraRender: r,
                    })
                  }
                } else if (
                  r.type === 'text' ||
                  r.type === 'notice' ||
                  r.type === 'alert'
                ) {
                  const notice =
                    r.text ||
                    (r.title
                      ? `[${r.title}] ${r.description || ''}`
                      : r.description)
                  if (notice && typeof ctx.onEmitTextBlock === 'function') {
                    await ctx.onEmitTextBlock(notice, {
                      extraRender: r,
                    })
                  }
                }
              }
            }
          }
        },
        user: {
          agentId: ctx.agentId || 'channel-master',
          channel: ctx.channel?.channelType || 'channel',
          channelType: ctx.channel?.channelType || 'channel',
          id: ctx.from || 'channel_master',
          isAdmin: true,
          role: 'admin',
          username: 'ChannelMaster',
        },
      }

      if (typeof ctx.onRegisterAbort === 'function') {
        ctx.onRegisterAbort(() => event.abort())
      }

      // 等待底层 LLM 完整运行完毕（包含所有递归工具轮次）
      await new Promise((resolve, reject) => {
        let isDone = false
        const rejectAfterContextPersistence = (error) => {
          contextPersistenceQueue.then(
            () => reject(error),
            () => reject(error),
          )
        }
        event.complete = async () => {
          if (isDone) return
          isDone = true
          try {
            if (currentBlockType === 'text' || currentTextBlock.trim()) {
              await flushTextBlock()
            }
            currentBlockType = 'idle'
            // Do not announce completion until the crystal and rotated chat
            // window are visible to the next FIFO Channel request.
            await contextPersistenceQueue
            const resolvedContactorId =
              ctx.channelId ||
              ctx.agentId ||
              ctx.channel?.id ||
              ctx.channel?.channelId ||
              ctx.memory?.agentId ||
              null
            if (resolvedContactorId && ctx.messageId) {
              try {
                streamCache.complete(
                  'admin',
                  resolvedContactorId,
                  ctx.messageId,
                )
                if (ctx.webClient?.id && ctx.webClient.id !== 'admin') {
                  streamCache.complete(
                    ctx.webClient.id,
                    resolvedContactorId,
                    ctx.messageId,
                  )
                }
              } catch {}
            }
            const targetWebClients = resolveWebClients(ctx)
            if (targetWebClients.length > 0 && ctx.messageId) {
              for (const client of targetWebClients) {
                client.popEvent?.(ctx.messageId)
                client.sendOpenaiMessage(
                  'complete',
                  {
                    metaData: {
                      contactorId: resolvedContactorId,
                      messageId: ctx.messageId,
                    },
                  },
                  ctx.messageId,
                )
              }
            }
            resolve()
          } catch (e) {
            rejectAfterContextPersistence(e)
          }
        }

        event.error = (err) => {
          if (isDone) return
          isDone = true
          streamError = err
          const resolvedContactorId =
            ctx.channelId ||
            ctx.agentId ||
            ctx.channel?.id ||
            ctx.channel?.channelId ||
            ctx.memory?.agentId ||
            null
          if (resolvedContactorId && ctx.messageId) {
            try {
              streamCache.fail(
                'admin',
                resolvedContactorId,
                ctx.messageId,
                err?.message || String(err),
              )
              if (ctx.webClient?.id && ctx.webClient.id !== 'admin') {
                streamCache.fail(
                  ctx.webClient.id,
                  resolvedContactorId,
                  ctx.messageId,
                  err?.message || String(err),
                )
              }
            } catch {}
          }
          const targetWebClients = resolveWebClients(ctx)
          if (targetWebClients.length > 0 && ctx.messageId) {
            for (const client of targetWebClients) {
              client.popEvent?.(ctx.messageId)
              client.sendOpenaiMessage(
                'failed',
                {
                  message: err?.message || String(err),
                  metaData: {
                    contactorId: resolvedContactorId,
                    messageId: ctx.messageId,
                  },
                },
                ctx.messageId,
              )
            }
          }
          rejectAfterContextPersistence(err)
        }

        svc.handleMessage(event).catch((err) => {
          if (isDone) return
          isDone = true
          rejectAfterContextPersistence(err)
        })
      })

      if (streamError && !event.aborted) {
        throw streamError
      }

      await flushTextBlock()

      // 组装完整的结构化 content 节点数组用于 session 持久化落盘
      const structuredContent = assembleStructuredContent(collectedChunks)

      return {
        aborted: !!event.aborted,
        completed: !event.aborted,
        content: structuredContent,
        crystal:
          latestCrystal || event.body?.settings?.previous_summary || null,
        crystalPersisted: Boolean(latestCrystal) && crystalPersistenceSucceeded,
        recursiveUserMessages: collectRecursiveUserMessages(
          event.body.messages,
          currentUserMessage,
        ),
        rawMessages: event.body.messages,
      }
    },
  }
}

export default { createBackendLlm, createEchoLlm }
