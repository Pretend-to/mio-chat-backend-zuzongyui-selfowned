/**
 * 统一错误解析与格式化工具
 * 支持解析 OpenAI APIError、Axios、Fetch、网络异常、嵌套 JSON 对象等各种形态的错误，
 * 提取核心原因、HTTP 状态码及 Request ID，分别输出：
 * 1. formatWebErrorMessage(error): 适用于 Web 端的优雅 Markdown 文本
 * 2. formatChannelErrorMessage(error): 适用于微信等 IM 渠道的清晰纯文本
 */

export function parseErrorDetails(error) {
  if (!error) return { message: '未知错误' }

  let status = error?.status || error?.statusCode || null
  let code = error?.code || null
  let requestId = error?.requestId || error?.request_id || null
  let raw = error

  // 1. 解包对象层级
  if (typeof raw === 'object' && raw !== null) {
    if (raw instanceof Error) {
      status = status || raw.status
      code = code || raw.code
      raw = raw.message || raw.stack || String(raw)
    } else if (raw.message && typeof raw.message === 'object') {
      status = status || raw.message.status || raw.message.statusCode
      code = code || raw.message.code
      requestId = requestId || raw.message.requestId || raw.message.request_id
      raw = raw.message
    }
  }

  if (typeof raw === 'object' && raw !== null) {
    if (raw.error && typeof raw.error === 'object') {
      code = code || raw.error.code
      requestId = requestId || raw.error.request_id || raw.error.requestId
      raw = raw.error.message || raw.error
    } else if (raw.error && typeof raw.error === 'string') {
      raw = raw.error
    } else if (raw.message && typeof raw.message === 'string') {
      raw = raw.message
    } else if (raw.detail) {
      raw = raw.detail
    }
  }

  // 2. 尝试解析字符串内的 JSON
  let isJson = false
  let jsonString = ''
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed?.error?.message) {
          raw = parsed.error.message
          code = code || parsed.error.code
          requestId =
            requestId || parsed.error.request_id || parsed.error.requestId
        } else if (parsed?.message && typeof parsed.message === 'string') {
          raw = parsed.message
        } else {
          isJson = true
          jsonString = JSON.stringify(parsed, null, 2)
        }
      } catch {
        // 保留原字符串
      }
    }
  } else if (typeof raw === 'object' && raw !== null) {
    isJson = true
    try {
      jsonString = JSON.stringify(raw, null, 2)
    } catch {
      jsonString = String(raw)
    }
  }

  let text = isJson ? jsonString : String(raw || '').trim()

  // 3. 从文本提取 request id (若之前未提取到)
  if (!requestId) {
    const reqMatch =
      text.match(/\(request\s*id:\s*([^)]+)\)/i) ||
      text.match(/\brequest[-_ ]?id[:=]\s*([a-zA-Z0-9_-]+)/i)
    if (reqMatch) {
      requestId = reqMatch[1].trim()
      text = text.replace(/\(request\s*id:\s*[^)]+\)/gi, '').trim()
    }
  }

  // 4. 清理冗余的状态码前缀（如 "500 400 credit insufficient balance" 或 "InternalServerError: 500 400 ..."）
  const statusPrefixMatch = text.match(
    /^(?:[A-Za-z]+Error:\s*)?((?:[45]\d{2}\s+)+)(.*)$/s,
  )
  if (statusPrefixMatch) {
    const codes = statusPrefixMatch[1].trim().split(/\s+/)
    if (!status && codes.length > 0) {
      status = codes[0]
    }
    text = statusPrefixMatch[2].trim()
  } else {
    text = text.replace(/^[A-Za-z]+Error:\s*/, '').trim()
  }

  return { code, isJson, jsonString, message: text, requestId, status }
}

/**
 * 格式化为适合 Web 端渲染的 Markdown 错误消息
 */
export function formatWebErrorMessage(error) {
  const { message, status, code, requestId, isJson, jsonString } =
    parseErrorDetails(error)

  let header = '⚠️ **请求失败**'
  const badges = []
  if (status) badges.push(`HTTP ${status}`)
  if (code) badges.push(code)
  if (badges.length > 0) {
    header += ` (${badges.join(' · ')})`
  }

  if (isJson) {
    return `${header}\n\n\`\`\`json\n${jsonString}\n\`\`\``
  }

  const lines = [header]
  if (message) {
    lines.push(`\n> ${message}`)
  }
  if (requestId) {
    lines.push(`\n\`request id: ${requestId}\``)
  }
  return lines.join('\n')
}

/**
 * 格式化为适合微信等 IM 渠道下发的清晰纯文本错误消息
 */
export function formatChannelErrorMessage(error) {
  const { message, status, code, requestId, isJson, jsonString } =
    parseErrorDetails(error)

  let header = '⚠️ 请求处理失败'
  const badges = []
  if (status) badges.push(`HTTP ${status}`)
  if (code) badges.push(code)
  if (badges.length > 0) {
    header += ` (${badges.join(' · ')})`
  }

  if (isJson) {
    return `${header}\n${jsonString}`
  }

  const lines = [header]
  if (message) {
    lines.push(`原因: ${message}`)
  }
  if (requestId) {
    lines.push(`Request ID: ${requestId}`)
  }
  return lines.join('\n')
}
