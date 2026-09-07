import { test } from 'node:test'
import assert from 'node:assert'
import './mock-env.js'

test('BaseLLMAdapter shielding mechanism', async (t) => {
  const { default: BaseLLMAdapter } =
    await import('../../lib/chat/llm/adapters/base.js')

  await t.test('should be disabled by default', () => {
    const adapter = new BaseLLMAdapter({ type: 'test' })
    assert.strictEqual(adapter.shieldConfig.enabled, false)
  })

  await t.test('should block handleChatRequest when enabled', async () => {
    const adapter = new BaseLLMAdapter({ type: 'test' })
    const message = 'Test shield message'
    adapter.shieldConfig = { enabled: true, message }

    let updateCalled = false
    let completeCalled = false

    const mockEvent = {
      body: {
        messages: [],
      },
      client: {
        popConnection: () => {},
        popEvent: () => {},
        pushConnection: () => {},
        pushEvent: () => {},
      },
      complete: () => {
        completeCalled = true
      },
      update: (data) => {
        if (data.type === 'content' && data.content.includes(message)) {
          updateCalled = true
        }
      },
    }

    await adapter.handleChatRequest(mockEvent)

    assert.strictEqual(
      updateCalled,
      true,
      'update should be called with shield message',
    )
    assert.strictEqual(completeCalled, true, 'complete should be called')
  })

  await t.test('should throw error in refreshModels when enabled', async () => {
    const adapter = new BaseLLMAdapter({ type: 'test' })
    const message = 'Test shield message'
    adapter.shieldConfig = { enabled: true, message }

    await assert.rejects(async () => await adapter.refreshModels(), { message })
  })

  await t.test(
    'should return tools directly if it is a list of custom tool objects',
    () => {
      const adapter = new BaseLLMAdapter({ type: 'test' })
      const customTools = [
        {
          function: {
            description: 'Get current weather',
            name: 'get_weather',
            parameters: {},
          },
          type: 'function',
        },
      ]
      const result = adapter._getFormattedTools(customTools, true)
      assert.deepStrictEqual(result, customTools)
    },
  )

  await t.test('supportsVision and _shouldFilterVision logic', async (st) => {
    const adapter = new BaseLLMAdapter({ type: 'test' })

    await st.test('should prioritize visionOverride when provided', () => {
      assert.strictEqual(adapter.supportsVision('deepseek-chat', true), true)
      assert.strictEqual(adapter.supportsVision('deepseek-chat', 'true'), true)
      assert.strictEqual(
        adapter._shouldFilterVision('deepseek-chat', true),
        false,
      )

      assert.strictEqual(adapter.supportsVision('gpt-4o', false), false)
      assert.strictEqual(adapter.supportsVision('gpt-4o', 'false'), false)
      assert.strictEqual(adapter._shouldFilterVision('gpt-4o', false), true)
    })

    await st.test('should delegate to ModelRegistryService by default', () => {
      assert.strictEqual(adapter.supportsVision('gpt-4o'), true)
      assert.strictEqual(adapter._shouldFilterVision('gpt-4o'), false)

      assert.strictEqual(adapter.supportsVision('gemini-2.5-flash'), true)
      assert.strictEqual(adapter._shouldFilterVision('gemini-2.5-flash'), false)

      assert.strictEqual(adapter.supportsVision('deepseek-chat'), false)
      assert.strictEqual(adapter._shouldFilterVision('deepseek-chat'), true)
    })

    await st.test(
      'should allow subclasses to override supportsVision cleanly',
      () => {
        class CustomTextOnlyAdapter extends BaseLLMAdapter {
          supportsVision(modelName, visionOverride = undefined) {
            if (visionOverride !== undefined) {
              return visionOverride === true || visionOverride === 'true'
            }
            return false
          }
        }

        const customAdapter = new CustomTextOnlyAdapter({ type: 'custom' })
        assert.strictEqual(customAdapter.supportsVision('gpt-4o'), false)
        assert.strictEqual(customAdapter._shouldFilterVision('gpt-4o'), true)
        assert.strictEqual(customAdapter.supportsVision('gpt-4o', true), true)
        assert.strictEqual(
          customAdapter._shouldFilterVision('gpt-4o', true),
          false,
        )
      },
    )
  })
})
