import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  postFileBundle,
  postPhotoBundle,
  postVideoBundle,
} from '@onebots/adapter-wechat-clawbot/lib/sdk/outbound/assembler.js'

const staged = {
  aesKeyHex: '00112233445566778899aabbccddeeff',
  cipherBudget: 16,
  mime: 'text/plain',
  originalName: 'hello.txt',
  plainBytes: 5,
  plainMd5Hex: '5d41402abc4b2a76b9719d911017c592',
  remoteHandle: 'remote-handle',
  slotKey: 'slot',
}

function captureTransport() {
  const envelopes = []
  return {
    envelopes,
    transport: {
      async dispatchOutboundEnvelope(envelope) {
        envelopes.push(envelope)
        return {}
      },
    },
  }
}

function firstItem(envelopes) {
  return envelopes[0]?.msg?.item_list?.[0]
}

test('微信 OneBots patch 使用 Base64(hex) 发送图片媒体密钥', async () => {
  const { envelopes, transport } = captureTransport()
  await postPhotoBundle(transport, 'peer', 'context', staged)

  const image = firstItem(envelopes)?.image_item
  assert.equal(
    Buffer.from(image?.media?.aes_key || '', 'base64').toString('ascii'),
    staged.aesKeyHex,
  )
  assert.deepEqual(
    { hd_size: image?.hd_size, mid_size: image?.mid_size },
    { hd_size: staged.cipherBudget, mid_size: staged.cipherBudget },
  )
})

test('微信 OneBots patch 补齐视频明文大小与文件 MD5', async () => {
  const videoCapture = captureTransport()
  await postVideoBundle(videoCapture.transport, 'peer', 'context', staged)
  assert.equal(firstItem(videoCapture.envelopes)?.video_item?.video_size, staged.plainBytes)

  const fileCapture = captureTransport()
  await postFileBundle(fileCapture.transport, 'peer', 'context', staged)
  const file = firstItem(fileCapture.envelopes)?.file_item
  assert.equal(file?.len, String(staged.plainBytes))
  assert.equal(file?.md5, staged.plainMd5Hex)
  assert.equal(
    Buffer.from(file?.media?.aes_key || '', 'base64').toString('ascii'),
    staged.aesKeyHex,
  )
})
