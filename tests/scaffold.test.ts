import { assert, mount, test } from 'orca/testing'
import * as panel from '../src/panel'
import { decisions, historyExample, reviewReply } from '../fixtures/decisions'

test('sidebar renders scaffold status', async () => {
  const view = await mount(panel)
  assert.equal(view.find({ role: 'heading' })?.text, 'Decision Inbox')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('fixtures maintain question, evidence, and receipt references', () => {
  const byId = new Map(decisions.map((decision) => [decision.questionId, decision]))
  assert.equal(byId.size, 6)
  assert.equal(new Set(decisions.map((decision) => decision.packageId)).size, 5)
  assert.deepEqual(byId.get('room-route')?.evidence, byId.get('room-reset')?.evidence)
  const review = byId.get(reviewReply.questionId)!
  assert.equal(review.evidence.length, 7)
  assert.equal(new Set(review.evidence.map(({ evidenceId }) => evidenceId)).size, 7)
  for (const item of review.evidence) {
    assert.equal(item.kind, 'image-snapshot')
    if (item.kind === 'image-snapshot') {
      assert.ok(item.width > 0 && item.height > 0)
      assert.ok(review.access.attachmentReaderIds[item.attachmentId].includes(review.origin.sessionId))
    }
  }
  const image = reviewReply.annotations[0]
  const selection = reviewReply.annotations[1]
  assert.ok(image.kind === 'image' && review.evidence.some((item) =>
    item.evidenceId === image.evidence.evidenceId && item.version === image.evidence.version))
  assert.ok(selection.kind === 'selection' &&
    review.background.slice(selection.start, selection.end) === selection.quote)
  const state = historyExample.answerState
  assert.ok(state.state === 'answered' && state.initial.delivery.state === 'agent-received')
  if (state.state === 'answered' && state.initial.delivery.state === 'agent-received') {
    assert.equal(state.initial.delivery.receipt.questionId, historyExample.questionId)
    assert.equal(state.initial.delivery.receipt.replyId, state.initial.replyId)
    assert.deepEqual(state.initial.delivery.receipt.origin, historyExample.origin)
  }
})
