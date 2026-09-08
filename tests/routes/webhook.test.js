import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  postWebhook,
  getCurrentLocalBranch,
} from '../../lib/server/http/controllers/webhookController.js'

function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(data) {
      this.body = data
      return this
    },
  }
  return res
}

test('Webhook - Branch Protection Gate', async (t) => {
  await t.test(
    'getCurrentLocalBranch correctly detects active branch',
    async () => {
      const branch = await getCurrentLocalBranch()
      assert.ok(typeof branch === 'string' && branch.length > 0)
    },
  )

  await t.test('postWebhook: rejects mismatch repository name', async () => {
    const req = {
      body: { repository: { name: 'some-other-repo' } },
      headers: {},
    }
    const res = mockRes()
    await postWebhook(req, res)
    assert.equal(res.statusCode, 404)
  })

  await t.test(
    'postWebhook: safely ignores when current branch is not master',
    async () => {
      const currentBranch = await getCurrentLocalBranch()
      const req = {
        body: {
          repository: { name: 'mio-chat-backend' },
          ref: 'refs/heads/master',
        },
        headers: {},
      }
      const res = mockRes()
      await postWebhook(req, res)

      if (currentBranch !== 'master') {
        assert.equal(res.statusCode, 200)
        assert.equal(res.body.skipped, true)
        assert.equal(res.body.currentBranch, currentBranch)
        assert.match(
          res.body.message,
          /only active when current branch is master/i,
        )
      }
    },
  )

  await t.test(
    'postWebhook: safely ignores when target branch is not master',
    async () => {
      const req = {
        body: {
          repository: { name: 'mio-chat-backend' },
          ref: 'refs/heads/feature-something',
        },
        headers: {},
      }
      const res = mockRes()
      await postWebhook(req, res)

      assert.equal(res.statusCode, 200)
      assert.equal(res.body.skipped, true)
    },
  )
})
