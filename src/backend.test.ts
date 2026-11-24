import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { decisions, reviewReply } from '../fixtures/decisions.ts'
import { InboxBackend } from './backend.ts'
import { orcaStorage } from './backend-storage.ts'
import type { JsonValue } from 'orca/worker'
import type { AgentCaller, DeliveryTarget, InboxBoundary, InboxStorage, SendOutcome } from './backend.ts'
import type { OwnerCaller } from './backend-protocol.ts'
import type { Decision, Result, SubmitDecision, SubmitReply } from './contract.ts'
import activate, { registerWorker } from './worker.ts'

const owner: OwnerCaller = { kind: 'owner', id: 'owner', workspaces: decisions.map(d => d.origin), repos: ['library', 'studio'] }
const secondOwner: OwnerCaller = { ...owner, id: 'second-owner' }
const agentFor = (d: Decision): AgentCaller => ({
  kind: 'agent', id: d.origin.sessionId, origin: d.origin, repo: 'library', policyOwnerId: owner.id,
  projectName: d.projectName, workspaceName: d.workspaceName
})
const question = (id: string) => decisions.find(d => d.questionId === id)!
const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`)
  return result.value
}
const code = (result: Result<unknown>) => result.ok ? 'ok' : result.code

const image = { mimeType: 'image/png' as const, base64: 'aW1hZ2U=' }
const scope = { kind: 'all' as const }
const initial = (questionId: string, replyId: string, text = 'Matte sample'): SubmitReply => ({
  questionId, replyId, kind: 'initial', answer: { kind: 'text', text }, annotations: []
})

function packageInput(rows: Decision[]): SubmitDecision {
  const root = rows[0]
  return {
    requestId: root.requestId, packageId: root.packageId, evidence: root.evidence, sourceLinks: root.sourceLinks,
    questions: rows.map(({ questionId, title, background, recommendation, options, priority, deadline, blockedWork }) => ({
      questionId, title, background, recommendation, options, priority, deadline, blockedWork
    }))
  }
}

function harness() {
  let persisted: unknown
  let now = Date.parse('2030-06-14T12:00:00Z')
  let sendOutcome: SendOutcome = 'submitted'
  let failNextWrite = false
  let proof: string | undefined
  let interruptSend = false
  const sends: DeliveryTarget[] = []
  const store: InboxStorage = {
    read: async () => persisted,
    async write(state) {
      if (failNextWrite) {
        failNextWrite = false
        throw new Error('Simulated crash before storing transport outcome.')
      }
      persisted = structuredClone(state)
    }
  }
  const native: InboxBoundary = {
    async grantSubmission(agent, body) {
      return {
        participantIds: [agent.id, owner.id, secondOwner.id],
        snapshots: body.evidence.flatMap(e => e.kind === 'image-snapshot'
          ? [{ attachmentId: e.attachmentId, readerIds: [agent.id, owner.id], image }] : [])
      }
    },
    async send(target) {
      sends.push(target)
      failNextWrite = interruptSend
      interruptSend = false
      return sendOutcome
    },
    async verifyReceipt(_agent, input) { return input.receiptId === proof }
  }
  const restart = (timeZone = 'UTC') => new InboxBackend(store, native, { timeZone, now: () => now })
  const backend = restart()
  async function submit(id: string) {
    const d = question(id)
    const payload = packageInput(decisions.filter(row => row.packageId === d.packageId))
    now = Date.parse(d.createdAt)
    value(await backend.submitDecision(agentFor(d), payload))
    now = Date.parse('2030-06-14T12:00:00Z')
    return payload
  }
  return { backend, native, restart, submit, sends, interruptSend() { interruptSend = true },
    sendOutcome(next: SendOutcome) { sendOutcome = next },
    proof(receiptId: string) { proof = receiptId }
  }
}

test('scopes by host and authorized participant, searches bilingual fields and history, and orders per local day', async () => {
  const h = harness()
  for (const id of ['room-route', 'stage', 'layout', 'image-review', 'schedule']) await h.submit(id)
  const rows = async (query?: string, includeHistory = false) =>
    value(await h.backend.listDecisions(owner, { scope, query, includeHistory })).map(d => d.questionId)
  assert.deepEqual(await rows(), ['room-reset', 'room-route', 'stage', 'layout', 'image-review', 'schedule'])
  const studio = question('schedule').origin
  assert.deepEqual(value(await h.backend.listDecisions(owner, { scope: { kind: 'workspace', workspace: studio }, includeHistory: false }))
    .map(d => d.questionId), ['image-review', 'schedule'])
  assert.deepEqual(await rows('錄音'), ['schedule'])
  assert.deepEqual(await rows('fold-OUT'), ['layout'])
  const other = { ...owner, id: 'unrelated' }
  assert.deepEqual(value(await h.backend.listDecisions(other, { scope, includeHistory: true })), [])
  assert.equal(code(await h.backend.getDecision(other, { questionId: 'layout' })), 'not-found')
  value(await h.backend.submitReply(owner, initial('layout', 'layout-r')))
  assert.deepEqual(await rows('matte sample'), [])
  assert.deepEqual(await rows('matte sample', true), ['layout'])

  const payload = packageInput([question('schedule')])
  payload.requestId = 'zone-request'
  payload.packageId = 'zone-package'
  payload.questions = [
    { ...payload.questions[0], questionId: 'tomorrow-utc', deadline: '2030-06-15T02:00:00Z', priority: 'P3' },
    { ...payload.questions[0], questionId: 'priority', deadline: undefined, priority: 'P1' }
  ]
  value(await h.backend.submitDecision(agentFor(question('schedule')), payload))
  async function relativeOrder(zone: string) {
    return value(await h.restart(zone).listDecisions(owner, { scope, includeHistory: false }))
      .map(d => d.questionId).filter(id => id === 'tomorrow-utc' || id === 'priority')
  }
  assert.deepEqual(await relativeOrder('UTC'), ['priority', 'tomorrow-utc'])
  assert.deepEqual(await relativeOrder('America/Los_Angeles'), ['tomorrow-utc', 'priority'])
})

test('persists submission idempotency, atomic racing owner answers, retry binding, and per-reply receipts', async () => {
  const h = harness()
  const submitted = await h.submit('room-route')
  const source = agentFor(question('room-route'))
  const untouched = await h.backend.submitDecision(source, submitted)
  assert.deepEqual(value(untouched).map(d => d.questionId), ['room-route', 'room-reset'])
  assert.equal(code(await h.backend.submitDecision(source, { ...submitted, summary: 'changed' })), 'conflict')
  const wrongHost = { ...source, origin: { ...source.origin, hostId: 'paired' } }
  assert.equal(code(await h.backend.submitDecision(wrongHost, submitted)), 'conflict')
  assert.equal(code(await h.backend.submitDecision(owner, submitted)), 'forbidden')

  await h.submit('stage')
  value(await h.backend.submitReply(owner, initial('stage', 'paired-reply')))
  assert.deepEqual(h.sends.shift()?.origin, question('stage').origin)
  h.sendOutcome('disconnected')
  const a = initial('room-route', 'first')
  const b = initial('room-route', 'other', 'Different answer')
  const [one, two] = await Promise.all([h.backend.submitReply(owner, a), h.backend.submitReply(secondOwner, b)])
  assert.equal(value(one).replyId, value(two).replyId)
  assert.equal(h.sends.length, 1)
  assert.deepEqual(h.sends[0].origin, source.origin)
  const sibling = value(await h.backend.getDecision(owner, { questionId: 'room-reset' }))
  assert.equal(sibling.answerState.state, 'awaiting-answer')

  const restarted = h.restart()
  assert.equal(value(await restarted.submitReply(owner, a)).delivery.state, 'undelivered')
  assert.equal(value(await restarted.submitReply(secondOwner, b)).replyId, 'first')
  assert.equal(code(await restarted.submitReply(owner, { ...a, answer: b.answer })), 'conflict')
  assert.equal(h.sends.length, 1)
  h.sendOutcome('submitted')
  const retried = value(await restarted.retryReply(owner, a))
  assert.equal(retried.replyId, a.replyId)
  assert.equal(retried.delivery.state, 'submitted')
  assert.deepEqual(h.sends[1], h.sends[0])
  const receipt = { questionId: a.questionId, replyId: a.replyId, receiptId: 'chat-proof' }
  assert.equal(code(await restarted.acknowledgeReply(source, receipt)), 'forbidden')
  h.proof('chat-proof')
  assert.equal(code(await restarted.acknowledgeReply(wrongHost, receipt)), 'not-found')
  assert.equal(code(await restarted.acknowledgeReply(source, { ...receipt, replyId: 'other' })), 'not-found')
  assert.equal(value(await restarted.acknowledgeReply(source, receipt)).delivery.state, 'agent-received')
  const followUp = { ...b, replyId: 'follow-up', kind: 'follow-up' as const }
  assert.equal(value(await restarted.submitReply(owner, followUp)).delivery.state, 'submitted')
  assert.equal(code(await restarted.acknowledgeReply(source, { ...receipt, replyId: followUp.replyId })), 'conflict')
  assert.equal(value(await h.restart().retryReply(owner, a)).delivery.state, 'agent-received')
  assert.equal(h.sends.length, 3)
})

test('recovers an interrupted outbox entry without redriving submission', async () => {
  const h = harness()
  await h.submit('stage')
  const answer = initial('stage', 'interrupted')
  h.interruptSend()
  assert.equal(code(await h.backend.submitReply(owner, answer)), 'unavailable')
  const restarted = h.restart()
  value(await restarted.recoverInterruptedDelivery())
  assert.equal(value(await restarted.submitReply(owner, answer)).delivery.state, 'undelivered')
  assert.equal(h.sends.length, 1)
  assert.equal(value(await restarted.retryReply(owner, answer)).delivery.state, 'submitted')
  assert.deepEqual(h.sends[0], h.sends[1])
})

test('checks private snapshot grants and versioned annotations, and persists question-bound drafts and scoped policy', async () => {
  const h = harness()
  await h.submit('image-review')
  const d = question('image-review')
  const attachment = d.evidence.find(e => e.kind === 'image-snapshot')!
  if (attachment.kind !== 'image-snapshot') throw new Error('Fixture needs an image.')
  const file = { questionId: d.questionId, attachmentId: attachment.attachmentId }
  assert.deepEqual(value(await h.backend.getSnapshot(owner, file)), image)
  assert.equal(code(await h.backend.getSnapshot(secondOwner, file)), 'forbidden')
  assert.equal(value(await h.backend.getDecision(secondOwner, file)).evidence.length, 0)
  assert.equal(code(await h.backend.submitReply(secondOwner, reviewReply)), 'invalid')
  const notes = reviewReply.annotations
  const selection = notes[1]
  if (selection.kind !== 'selection') throw new Error('Fixture needs a selection.')
  assert.equal(code(await h.backend.submitReply(owner, { ...reviewReply, annotations: [{ ...selection, quote: 'Wrong length' }] })), 'invalid')
  const draft = { text: 'Pending', replyId: reviewReply.replyId, kind: 'initial' as const, annotations: notes }
  value(await h.backend.saveDraft(owner, { questionId: d.questionId, draft }))
  assert.deepEqual(value(await h.restart().getDraft(owner, file)), draft)
  assert.equal(value(await h.restart().getDraft(secondOwner, file)), null)
  assert.equal(value(await h.backend.submitReply(owner, reviewReply)).annotations.length, 2)
  const response = value(await h.backend.getDecision(secondOwner, file)).answerState
  assert.ok(response.state === 'answered' && response.initial.annotations.length === 1)
  const settings = { revision: 0, defaultTemplate: 'Default template', exceptions: [{ repo: 'library', template: 'Library policy' }] }
  assert.equal(value(await h.backend.saveSettings(owner, settings)).revision, 1)
  assert.equal(code(await h.restart().saveSettings(owner, settings)), 'conflict')
  assert.deepEqual(value(await h.restart().effectivePolicy(agentFor(d), { repo: 'library' })),
    { source: 'exception', template: 'Library policy' })
  assert.equal(code(await h.restart().effectivePolicy(agentFor(d), { repo: 'studio' })), 'forbidden')
})

test('a failed storage slot switch leaves the previous generation readable', async () => {
  const entries = new Map<string, JsonValue>()
  let failSwitch = false
  const store = orcaStorage({
    get: async key => entries.get(key) ?? null,
    async set(key, value) {
      if (failSwitch && key === 'inbox.v1.state') throw new Error('Interrupted index switch.')
      entries.set(key, value)
    },
    async delete(key) { entries.delete(key) },
    keys: async () => [...entries.keys()],
    onDidChange: () => ({ dispose() {} })
  })
  const native = harness().native
  const backend = new InboxBackend(store, native)
  const d = question('schedule')
  value(await backend.submitDecision(agentFor(d), packageInput([d])))
  const settings = { revision: 0, defaultTemplate: 'Edited policy', exceptions: [] }
  failSwitch = true
  assert.equal(code(await backend.saveSettings(owner, settings)), 'unavailable')
  const restarted = new InboxBackend(store, native)
  assert.equal(value(await restarted.getDecision(owner, { questionId: d.questionId })).title, d.title)
  assert.equal(value(await restarted.getSettings(owner)).revision, 0)
  failSwitch = false
  assert.equal(value(await restarted.saveSettings(owner, settings)).revision, 1)
})

test('actual worker handlers persist through Orca storage and shipping activation fails closed', async () => {
  const host = mockHost({ capabilities: ['storage:own', 'workspace:read'], results: {
    'workspace.list': { workspaces: [{ id: 'studio', name: 'Studio', kind: 'folder', path: '/studio', branch: null, hostId: null }], truncated: false }
  } })
  const prod = await mountWorker({ default: activate }, { host })
  assert.equal(code(await prod.request('listDecisions', { scope, includeHistory: false })), 'unavailable')
  assert.deepEqual(value(await prod.request('workspace.resolve', { workspaceId: 'studio' })), { workspaceId: 'studio', hostId: 'local' })
  await prod.deactivate()

  const fixtureBoundary = harness().native
  const native: InboxBoundary = {
    ...fixtureBoundary,
    async grantSubmission(caller, input) {
      const grant = await fixtureBoundary.grantSubmission(caller, input)
      return { ...grant, snapshots: grant.snapshots.map((snapshot, i) => i === 0
        ? { ...snapshot, image: { ...image, base64: 'YWJj'.repeat(75_000) } } : snapshot) }
    }
  }
  const opened: unknown[] = []
  let backend: InboxBackend | undefined
  const mount = () => mountWorker({ default(orca) {
    backend = registerWorker(orca, {
      native, async resolveOwner() { return owner }, async openReference(_caller, reference) { opened.push(reference) }
    })
  } }, { host })
  const worker = await mount()
  const d = question('schedule')
  value(await backend!.submitDecision(agentFor(d), packageInput([d])))
  assert.equal(value(await worker.request('getDecision', { questionId: d.questionId })).title, d.title)
  value(await worker.request('review.open', { questionId: d.questionId }))
  assert.deepEqual(opened, [{ questionId: d.questionId }])
  assert.ok(worker.posts.some(post => post.event === 'inbox.changed'))
  const withImage = question('image-review')
  value(await backend!.submitDecision(agentFor(withImage), packageInput([withImage])))
  const snapshot = withImage.evidence[0]
  if (snapshot.kind !== 'image-snapshot') throw new Error('Fixture needs an image.')
  const attachmentRequest = { questionId: withImage.questionId, attachmentId: snapshot.attachmentId }
  assert.equal(value(await worker.request('getSnapshot', attachmentRequest)).base64.length, 300_000)
  assert.ok(Object.keys(host.data().storage).filter(key => key.startsWith('inbox.v1.b.')).length > 1)
  await worker.deactivate()
  const restarted = await mount()
  assert.equal(value(await restarted.request('getDecision', { questionId: d.questionId })).title, d.title)
  assert.equal(value(await restarted.request('getSnapshot', attachmentRequest)).base64.length, 300_000)
  await restarted.deactivate()
})
