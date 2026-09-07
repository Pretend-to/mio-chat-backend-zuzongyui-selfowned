import { test } from 'node:test'
import assert from 'node:assert'
import ParseTool from '../../lib/plugins/ai-plugin/tools/parse.js'

test('ParseTool: 多模态图片与外部文档解析统一集成测试', async (t) => {
  const parseTool = new ParseTool()

  await t.test('文档与图片类型识别', () => {
    assert.strictEqual(
      parseTool._isDocument('http://example.com/doc.pdf'),
      true,
    )
    assert.strictEqual(parseTool._isDocument('/local/data.xlsx'), true)
    assert.strictEqual(
      parseTool._isDocument('https://example.com/page.html'),
      false,
    )

    assert.strictEqual(parseTool._isImage('http://example.com/pic.png'), true)
    assert.strictEqual(
      parseTool._isImage('https://example.com/photo.jpeg?w=800'),
      true,
    )
    assert.strictEqual(parseTool._isImage('data:image/png;base64,abc'), true)
    assert.strictEqual(parseTool._isImage('http://example.com/doc.pdf'), false)
  })

  await t.test(
    '防重熔断：若图片已是本轮用户消息中的附件，且当前模型具备原生视觉，则直接拦截',
    async () => {
      const existingImageUrl = 'https://example.com/already_attached.png'
      const mockEvent = {
        body: {
          settings: {
            base: { model: 'gemini-2.5-flash' }, // 原生视觉模型
          },
          messages: [
            { role: 'system', content: 'You are an AI assistant' },
            {
              role: 'user',
              content: [
                { type: 'text', text: '看下这张图' },
                { type: 'image_url', image_url: { url: existingImageUrl } },
              ],
            },
          ],
        },
        params: {
          urls: [existingImageUrl],
        },
      }

      const res = await parseTool.parseContent(mockEvent)
      assert.strictEqual(res.status, 'success')
      assert.strictEqual(res.result.length, 1)
      assert.match(
        res.result[0].content,
        /该图片已在当前对话消息上下文中直接呈现/,
      )
      // 拦截时不产生 _postMessages，也不调用后台子模型
      assert.strictEqual(res._postMessages, undefined)
    },
  )

  await t.test(
    '原生直通：外部图片在原生视觉模型下返回 _postMessages 直通载体',
    async () => {
      const externalImageUrl =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
      const mockEvent = {
        body: {
          settings: {
            base: { model: 'gpt-4o' }, // 原生视觉模型
          },
          messages: [{ role: 'user', content: '解析外部图片' }],
        },
        params: {
          fileUrls: externalImageUrl,
          prompt: '提取图中的红点',
        },
      }

      const res = await parseTool.parseContent(mockEvent)
      assert.strictEqual(res.status, 'success')
      assert.strictEqual(res.result.length, 1)
      assert.match(
        res.result[0].content,
        /外部图片 .* 已成功拉取并作为附件附加/,
      )
      // 应该成功产生 _postMessages 注入消息链
      assert.ok(Array.isArray(res._postMessages))
      assert.strictEqual(res._postMessages.length, 1)
      assert.strictEqual(res._postMessages[0].role, 'user')
      assert.strictEqual(res._postMessages[0].content[1].type, 'image_url')
    },
  )
})
