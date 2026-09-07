import path from 'path'
import { MioFunction } from '../../../function.js'
import { parseFileWithUrl } from '../../../../utils/parseFile.js'
import { visionService } from '../../../chat/vision/VisionService.js'
import modelRegistryService from '../../../chat/llm/services/ModelRegistryService.js'
import logger from '../../../../utils/logger.js'

const DOC_EXTS = new Set(
  '.pdf,.docx,.xlsx,.pptx,.doc,.xls,.ppt,.odt,.ods,.odp,.csv,.tsv,.json,.xml,.yaml,.yml,.txt,.log,.md,.markdown'.split(
    ',',
  ),
)
const IMG_EXTS = new Set('.png,.jpg,.jpeg,.webp,.gif,.bmp,.svg'.split(','))

const getExt = (urlStr) => {
  try {
    return path.extname(new URL(urlStr).pathname).toLowerCase()
  } catch {
    return path.extname(urlStr || '').toLowerCase()
  }
}

const urlParam = {
  description:
    'URLs (pages, documents, images) or file paths to parse. Can be a string or string array.',
  oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
}

export default class parse extends MioFunction {
  constructor() {
    super({
      adminOnly: false,
      description:
        'Extract text and structured content from files (PDF, Word, Excel, Markdown, TXT, Images) or web URLs. Supports parsing documents, tables, and web pages, as well as multimodal image analysis for external image links. Note: If an image is already attached in chat context, multimodal vision models can directly see it without calling this tool.',
      name: 'parse',
      parameters: {
        properties: {
          fileUrls: urlParam,
          urls: urlParam,
          prompt: {
            default: '',
            description:
              'Optional: When parsing images or documents, specify what to focus on or extract.',
            type: 'string',
          },
          engine: {
            default: 'auto',
            description:
              'Parsing engine: "auto" (default), "jina", "exact" (browser DOM), or "file".',
            enum: ['auto', 'jina', 'exact', 'file'],
            type: 'string',
          },
          maxChars: {
            default: 20000,
            description:
              'Maximum characters of text to return per target (default: 20000).',
            type: 'integer',
          },
        },
        type: 'object',
      },
    })
    this.func = this.parseContent
  }

  async parseContent(e) {
    const {
      fileUrls,
      urls,
      engine = 'auto',
      maxChars = 20000,
      prompt = '',
    } = e.params || {}
    const rawTarget = urls || fileUrls
    if (!rawTarget) {
      return { error: '请提供需要解析的文件、图片或网页 URL (fileUrls / urls)' }
    }

    const targetList = Array.isArray(rawTarget) ? rawTarget : [rawTarget]
    const result = []
    const allPostMessages = []

    const currentModel =
      e.body?.settings?.base?.model ||
      e.parentEvent?.body?.settings?.base?.model ||
      ''
    const isNativeVision = currentModel
      ? Boolean(modelRegistryService.supportsVision(currentModel))
      : false
    const attachedImages = this._getAttachedImagesFromContext(e)

    const promises = targetList.map(async (urlItem) => {
      if (!urlItem || typeof urlItem !== 'string') return
      const targetUrl = urlItem.trim()
      try {
        const dispatchRes = await this._dispatchParse(
          targetUrl,
          engine,
          maxChars,
          prompt,
          {
            attachedImages,
            isNativeVision,
          },
        )
        if (dispatchRes?.postMessage) {
          allPostMessages.push(dispatchRes.postMessage)
        }
        result.push({
          content:
            dispatchRes?.content != null ? dispatchRes.content : dispatchRes,
          url: targetUrl,
          fileUrl: targetUrl,
          success: true,
        })
      } catch (error) {
        result.push({
          error: error.message,
          url: targetUrl,
          fileUrl: targetUrl,
          success: false,
        })
      }
    })

    await Promise.allSettled(promises)
    const res = { result, status: 'success' }
    if (allPostMessages.length > 0) res._postMessages = allPostMessages
    return res
  }

  async _dispatchParse(
    targetUrl,
    engine,
    maxChars,
    prompt = '',
    contextMeta = {},
  ) {
    if (this._isImage(targetUrl)) {
      return await this._parseImage(targetUrl, prompt, contextMeta)
    }

    let content
    if (
      engine === 'file' ||
      this._isDocument(targetUrl) ||
      targetUrl.startsWith('file://')
    ) {
      const { content: fileContent, error } = await parseFileWithUrl(targetUrl)
      if (error) throw new Error(error)
      content = fileContent
    } else if (engine === 'exact') {
      content = await this._parseWithExact(targetUrl, maxChars)
    } else {
      try {
        content = await this._parseWithJina(targetUrl, maxChars)
      } catch (jinaErr) {
        if (engine === 'jina') throw jinaErr
        logger.warn(
          `[ParseTool] Jina parse failed for ${targetUrl} (${jinaErr.message}), falling back to exact...`,
        )
        content = await this._parseWithExact(targetUrl, maxChars)
      }
    }

    return { content: this._truncate(content, maxChars) }
  }

  async _parseImage(
    targetUrl,
    prompt,
    { attachedImages = new Set(), isNativeVision = false },
  ) {
    // 1. 防重熔断：图片已是本轮用户消息附件
    if (isNativeVision && attachedImages.has(targetUrl)) {
      logger.warn(`[ParseTool] 🛡️ 拦截已存在的附件图片重复解析: ${targetUrl}`)
      return {
        content:
          '【系统提示】：该图片已在当前对话消息上下文中直接呈现给你的原生视觉能力。你已可以直接查看并理解该图片，请直接根据你看到的图片回答用户，无需重复解析。',
      }
    }

    // 2. 原生视觉直通 (_postMessages 模式)
    if (isNativeVision) {
      try {
        const { imageData } = await visionService._prepareImageData(targetUrl)
        logger.info(
          `[ParseTool] 原生视觉直通: 图片已就位 (${targetUrl})，作为 _postMessages 注入`,
        )
        return {
          content: `[图片已就位] 外部图片 (${targetUrl}) 已成功拉取并作为附件附加在当前对话中，请直接阅读并作答。`,
          postMessage: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: prompt
                  ? `[外部图片解析载体: ${targetUrl}] ${prompt}`
                  : `[外部图片解析载体: ${targetUrl}]`,
              },
              { type: 'image_url', image_url: { url: imageData } },
            ],
          },
        }
      } catch (err) {
        logger.warn(
          `[ParseTool] 原生图片预处理失败 (${err.message})，降级到 VisionService`,
        )
      }
    }

    // 3. 纯文本模型或降级转录
    const res = await visionService.analyze({
      image: targetUrl,
      prompt: prompt || undefined,
    })
    return {
      content: `### 图像内容识别结果 (${targetUrl}):\n${res.description}`,
    }
  }

  _getAttachedImagesFromContext(e) {
    const messages = e?.body?.messages || e?.parentEvent?.body?.messages || []
    const lastUserMsg = messages.filter((m) => m.role === 'user').pop()
    const attached = new Set()
    if (Array.isArray(lastUserMsg?.content)) {
      for (const part of lastUserMsg.content) {
        if (part.type === 'image_url' && part.image_url?.url) {
          attached.add(part.image_url.url)
        } else if (part.type === 'image' && (part.data?.file || part.url)) {
          attached.add(part.data?.file || part.url)
        }
      }
    }
    return attached
  }

  _isImage(urlStr) {
    return (
      typeof urlStr === 'string' &&
      (urlStr.startsWith('data:image/') || IMG_EXTS.has(getExt(urlStr)))
    )
  }

  _isDocument(urlStr) {
    return DOC_EXTS.has(getExt(urlStr))
  }

  async _parseWithJina(targetUrl, maxChars) {
    const res = await fetch(`https://r.jina.ai/${targetUrl}`, {
      headers: {
        Accept: 'text/markdown',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok)
      throw new Error(`r.jina.ai HTTP ${res.status}: ${res.statusText}`)
    const text = await res.text()
    if (!text || text.trim().length === 0)
      throw new Error('r.jina.ai 返回空内容')
    return this._truncate(text, maxChars)
  }

  async _parseWithExact(targetUrl, maxChars) {
    try {
      const { default: puppPaser } =
        await import('../../web-plugin/lib/puppPaser.js')
      const parser = new puppPaser(targetUrl)
      const parseResult = await parser.parse()
      if (parseResult.success) {
        const title = parseResult.title ? `# ${parseResult.title}\n\n` : ''
        return this._truncate(`${title}${parseResult.pureText || ''}`, maxChars)
      }
      throw new Error(
        parseResult.error?.message || 'Puppeteer 提取页面内容失败',
      )
    } catch {
      const res = await fetch(targetUrl, { signal: AbortSignal.timeout(15000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
      const html = await res.text()
      const textOnly = html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      return this._truncate(textOnly, maxChars)
    }
  }

  _truncate(str, maxChars) {
    if (!str) return ''
    if (str.length <= maxChars) return str
    return `${str.substring(0, maxChars)}\n\n... (内容已截断，达到最大字符数限制 ${maxChars})`
  }
}
