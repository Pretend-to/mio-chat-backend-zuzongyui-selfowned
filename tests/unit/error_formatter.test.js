import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatChannelErrorMessage,
  formatWebErrorMessage,
  parseErrorDetails,
} from '../../utils/errorFormatter.js'

test('parseErrorDetails handles OpenAI APIError with status prefix and request id', () => {
  const raw =
    '500 400 credit insufficient balance: balance=0 required=2072 (request id: 20260907132209787259049c955d568fNCxOw6a)'
  const details = parseErrorDetails(raw)

  assert.equal(details.status, '500')
  assert.equal(
    details.message,
    'credit insufficient balance: balance=0 required=2072',
  )
  assert.equal(details.requestId, '20260907132209787259049c955d568fNCxOw6a')

  const web = formatWebErrorMessage(raw)
  assert.ok(web.includes('⚠️ **请求失败** (HTTP 500)'))
  assert.ok(
    web.includes('> credit insufficient balance: balance=0 required=2072'),
  )
  assert.ok(
    web.includes('`request id: 20260907132209787259049c955d568fNCxOw6a`'),
  )

  const channel = formatChannelErrorMessage(raw)
  assert.ok(channel.includes('⚠️ 请求处理失败 (HTTP 500)'))
  assert.ok(
    channel.includes(
      '原因: credit insufficient balance: balance=0 required=2072',
    ),
  )
  assert.ok(
    channel.includes('Request ID: 20260907132209787259049c955d568fNCxOw6a'),
  )
})

test('parseErrorDetails handles nested Error object with status and code', () => {
  const errObj = {
    code: 'invalid_api_key',
    error: {
      message: 'Incorrect API key provided',
      requestId: 'req_123456',
    },
    status: 401,
  }

  const details = parseErrorDetails(errObj)
  assert.equal(details.status, 401)
  assert.equal(details.code, 'invalid_api_key')
  assert.equal(details.message, 'Incorrect API key provided')
  assert.equal(details.requestId, 'req_123456')

  const web = formatWebErrorMessage(errObj)
  assert.ok(web.includes('HTTP 401'))
  assert.ok(web.includes('invalid_api_key'))
  assert.ok(web.includes('> Incorrect API key provided'))
  assert.ok(web.includes('`request id: req_123456`'))
})

test('parseErrorDetails handles raw JSON string', () => {
  const jsonStr = JSON.stringify({
    details: 'Something went wrong',
    upstreamCode: 'UPSTREAM_FAIL',
  })

  const details = parseErrorDetails(jsonStr)
  assert.equal(details.isJson, true)

  const web = formatWebErrorMessage(jsonStr)
  assert.ok(web.includes('```json'))
  assert.ok(web.includes('UPSTREAM_FAIL'))

  const channel = formatChannelErrorMessage(jsonStr)
  assert.ok(channel.includes('UPSTREAM_FAIL'))
})

test('parseErrorDetails handles standard JS Error instance', () => {
  const err = new Error('Network timeout after 30000ms')
  err.code = 'ETIMEDOUT'

  const details = parseErrorDetails(err)
  assert.equal(details.message, 'Network timeout after 30000ms')
  assert.equal(details.code, 'ETIMEDOUT')

  const web = formatWebErrorMessage(err)
  assert.ok(web.includes('ETIMEDOUT'))
  assert.ok(web.includes('> Network timeout after 30000ms'))
})
