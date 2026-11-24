import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import { decisions, reviewReply } from '../fixtures/decisions.ts'
import { InboxBackend } from './backend.ts'
import { orcaStorage } from './backend-storage.ts'
import type { JsonValue } from 'orca/worker'
import type { AgentCaller, DeliveryTarget, InboxBoundary, InboxStorage, SendOutcome } from './backend.ts'
import type { OwnerCaller } from './backend-protocol.ts'
import type { Decision, Result, SubmitDecision, SubmitReply } from './contract.ts'
import activate, { registerDesktopWorker, registerWorker } from './worker.ts'

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
  const revoked = new Set<string>()
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
    async canReadSnapshot(caller, { evidence }) { return !revoked.has(JSON.stringify([caller.id, evidence.attachmentId])) },
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
    revoke(id: string, attachmentId: string) { revoked.add(JSON.stringify([id, attachmentId])) },
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
  assert.equal(code(await h.backend.submitReply(secondOwner, reviewReply)), 'forbidden')
  const notes = reviewReply.annotations
  const selection = notes[1]
  if (selection.kind !== 'selection') throw new Error('Fixture needs a selection.')
  assert.equal(code(await h.backend.submitReply(owner, { ...reviewReply, annotations: [{ ...selection, quote: 'Wrong length' }] })), 'invalid')
  const draft = { text: 'Pending', replyId: reviewReply.replyId, kind: 'initial' as const, annotations: notes }
  value(await h.backend.saveDraft(owner, { questionId: d.questionId, draft, revision: 0 }))
  assert.deepEqual(value(await h.restart().getDraft(owner, file)), { draft, revision: 1 })
  assert.deepEqual(value(await h.restart().getDraft(secondOwner, file)), { draft: null, revision: 0 })
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

test('worker handlers persist through Orca storage and local desktop scoping', async () => {
  const workspaceId = 'workspace-'.repeat(100)
  const inventory = { id: workspaceId, name: 'Studio', kind: 'folder', path: '/studio', branch: null, hostId: null }
  const host = mockHost({ capabilities: ['storage:own', 'workspace:read'], results: {
    'workspace.readContext': { workspaceId, branch: '', displayName: 'Studio', terminals: [] },
    'workspace.list': { workspaces: [inventory], truncated: true }
  } })
  const prod = await mountWorker({ default: activate }, { host })
  assert.equal(code(await prod.request('listDecisions', { scope, includeHistory: false }, { panel: 'inbox' })), 'ok')
  assert.equal(code(await prod.request('listDecisions', { scope, includeHistory: false }, { panel: 'unrelated' })), 'forbidden')
  assert.deepEqual(value(await prod.request('workspace.resolve', { workspaceId })), { workspaceId, hostId: 'local' })
  assert.equal(code(await prod.request('workspace.resolve', { workspaceId: 'studio' })), 'unavailable')
  host.respond('workspace.list', { workspaces: [], truncated: true })
  assert.equal(code(await prod.request('workspace.resolve', { workspaceId })), 'unavailable')
  host.respond('workspace.list', { workspaces: [inventory, { ...inventory, hostId: 'runtime:other' }], truncated: true })
  assert.equal(code(await prod.request('workspace.resolve', { workspaceId })), 'unavailable')
  await prod.deactivate()

  const fixtureBoundary = harness().native
  const native: InboxBoundary = {
    ...fixtureBoundary,
    async grantSubmission(caller, input) {
      const grant = await fixtureBoundary.grantSubmission(caller, input)
      return { ...grant, snapshots: grant.snapshots.map(snapshot =>
        ({ ...snapshot, image: { ...image, base64: 'YWJj'.repeat(80_000) } })) }
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
  const packaged = packageInput([d])
  value(await backend!.submitDecision(agentFor(d), {
    ...packaged, summary: '紙'.repeat(33_000),
    questions: Array.from({ length: 11 }, (_, i) => ({ ...packaged.questions[0], questionId: i ? `extra-${i}` : d.questionId }))
  }))
  assert.equal(code(await worker.request('listDecisions', { scope, includeHistory: true })), 'unavailable')
  const page = value(await worker.request('listDecisionPage', { scope, includeHistory: true }))
  assert.equal(page.rows.length, 11)
  assert.ok(JSON.stringify(page).length < 1024 * 1024)
  assert.equal(value(await worker.request('getDecision', { questionId: d.questionId })).title, d.title)
  value(await worker.request('review.open', { questionId: d.questionId }))
  assert.deepEqual(opened, [{ questionId: d.questionId }])
  assert.ok(worker.posts.some(post => post.event === 'inbox.changed'))
  const withImage = question('image-review')
  value(await backend!.submitDecision(agentFor(withImage), packageInput([withImage])))
  const snapshot = withImage.evidence[0]
  if (snapshot.kind !== 'image-snapshot') throw new Error('Fixture needs an image.')
  const attachmentRequest = { questionId: withImage.questionId, attachmentId: snapshot.attachmentId }
  assert.equal(value(await worker.request('getSnapshot', attachmentRequest)).base64.length, 320_000)
  const persisted = host.data().storage
  const encoder = new TextEncoder()
  assert.equal(Object.keys(persisted).filter(key => key.startsWith('inbox.v1.snapshot.') && key.endsWith('.0')).length, 7)
  assert.ok(Object.values(persisted).every(value => encoder.encode(JSON.stringify(value)).length < 256 * 1024))
  assert.ok(encoder.encode(JSON.stringify(persisted, null, 2)).length < 5 * 1024 * 1024)
  const extra = packageInput([withImage])
  assert.equal(code(await backend!.submitDecision(agentFor(withImage), {
    ...extra, requestId: 'extra-image-r', packageId: 'extra-image-p',
    questions: [{ ...extra.questions[0], questionId: 'extra-image-q' }],
    evidence: [{ ...snapshot, attachmentId: 'extra-image' }]
  })), 'unavailable')
  assert.equal(code(await worker.request('getDecision', { questionId: 'extra-image-q' })), 'not-found')
  assert.equal(value(await worker.request('submitReply', initial(d.questionId, 'quota-safe'))).delivery.state, 'submitted')
  await worker.deactivate()
  const restarted = await mount()
  assert.equal(value(await restarted.request('getDecision', { questionId: d.questionId })).title, d.title)
  assert.equal(value(await restarted.request('getSnapshot', attachmentRequest)).base64.length, 320_000)
  await restarted.deactivate()
})

test('binds snapshots to exact Chat and immutable versions and rechecks revoked grants on retry', async () => {
  const h = harness()
  const payload = await h.submit('image-review')
  const d = question('image-review')
  const source = agentFor(d)
  const wrong = { ...source, origin: { ...source.origin, sessionId: 'unrelated-chat' } }
  const note = reviewReply.annotations[0]
  if (note.kind !== 'image') throw new Error('Fixture needs an image note.')
  const imageRef = d.evidence.find(e => e.evidenceId === note.evidence.evidenceId)!
  if (imageRef.kind !== 'image-snapshot') throw new Error('Fixture needs an image.')
  const request = { questionId: d.questionId, attachmentId: imageRef.attachmentId }
  assert.equal(code(await h.backend.getDecision(wrong, request)), 'not-found')
  assert.equal(code(await h.backend.getSnapshot(wrong, request)), 'not-found')
  assert.deepEqual(value(await h.backend.getSnapshot(source, request)), image)

  const versioned = { ...payload, requestId: 'versions-r', packageId: 'versions-p',
    questions: [{ ...payload.questions[0], questionId: 'versions-q' }],
    evidence: [{ ...imageRef, attachmentId: 'immutable-one' }, { ...imageRef, version: 2, attachmentId: 'immutable-one' }] }
  assert.equal(code(await h.backend.submitDecision(source, versioned)), 'invalid')
  versioned.evidence[1].attachmentId = 'immutable-two'
  value(await h.backend.submitDecision(source, versioned))
  h.revoke(owner.id, 'immutable-two')
  assert.deepEqual(value(await h.backend.getDecision(owner, { questionId: 'versions-q' })).evidence.map(e => e.version), [1])
  assert.equal(code(await h.backend.getSnapshot(owner, { questionId: 'versions-q', attachmentId: 'immutable-two' })), 'forbidden')
  assert.deepEqual(value(await h.backend.getSnapshot(owner, { questionId: 'versions-q', attachmentId: 'immutable-one' })), image)

  const draft = { text: 'Partial draft', annotations: [{ ...note, text: '' }] }
  const stored = value(await h.backend.saveDraft(owner, { questionId: d.questionId, revision: 0, draft }))
  assert.deepEqual(stored, { draft, revision: 1 })
  assert.equal(code(await h.backend.saveDraft(owner, { questionId: d.questionId, revision: 0, draft: null })), 'conflict')
  assert.equal(code(await h.backend.submitReply(owner, { ...reviewReply, annotations: draft.annotations })), 'invalid')
  h.sendOutcome('disconnected')
  assert.equal(value(await h.backend.submitReply(owner, reviewReply)).delivery.state, 'undelivered')
  h.revoke(source.id, imageRef.attachmentId)
  assert.equal(code(await h.backend.retryReply(owner, reviewReply)), 'forbidden')
  h.revoke(owner.id, imageRef.attachmentId)
  assert.equal(code(await h.backend.getSnapshot(owner, request)), 'forbidden')
  const redacted = value(await h.backend.getDraft(owner, request))
  assert.deepEqual(redacted, { draft: { text: 'Partial draft', annotations: [] }, revision: 1 })
  assert.ok(!value(await h.backend.getDecision(owner, request)).evidence.some(e => e.evidenceId === imageRef.evidenceId))
  assert.equal(h.sends.length, 1)
  assert.deepEqual(value(await h.backend.saveDraft(owner, { questionId: d.questionId, revision: 1, draft: null })),
    { draft: null, revision: 2 })
  assert.equal(code(await h.backend.saveDraft(owner, { questionId: d.questionId, revision: 1, draft })), 'conflict')
})

test('validates losing initial attempts before recording their ID and keeps failed follow-ups independently actionable', async () => {
  const h = harness()
  await h.submit('image-review')
  const d = question('image-review')
  const src = agentFor(d)
  const winner = initial(d.questionId, 'original')
  value(await h.backend.submitReply(owner, winner))
  const loser = initial(d.questionId, 'loser')
  assert.equal(code(await h.backend.submitReply(owner, { ...loser, answer: { kind: 'option', optionId: 'missing' } })), 'invalid')
  assert.equal(code(await h.backend.submitReply(secondOwner, { ...loser, annotations: reviewReply.annotations })), 'forbidden')
  assert.equal(value(await h.backend.submitReply(owner, loser)).replyId, winner.replyId)
  h.proof('original-proof')
  value(await h.backend.acknowledgeReply(src, { questionId: d.questionId, replyId: winner.replyId, receiptId: 'original-proof' }))
  h.sendOutcome('closed-origin')
  const follow = { ...initial(d.questionId, 'follow'), kind: 'follow-up' as const }
  assert.equal(value(await h.backend.submitReply(owner, follow)).delivery.state, 'undelivered')
  const restarted = h.restart()
  assert.equal(value(await restarted.submitReply(owner, follow)).replyId, follow.replyId)
  assert.equal(code(await restarted.submitReply(owner, { ...follow, answer: { kind: 'text', text: 'changed' } })), 'conflict')
  const active = value(await restarted.listDecisionPage(owner, { scope, includeHistory: false }))
  assert.equal(active.rows.length, 1)
  const state = active.rows[0].answerState
  assert.ok(state.state === 'answered' && state.initial.delivery.state === 'agent-received' &&
    state.followUps[0].delivery.state === 'undelivered')
  h.proof('follow-proof')
  value(await restarted.acknowledgeReply(src, { questionId: d.questionId, replyId: follow.replyId, receiptId: 'follow-proof' }))
  assert.equal(value(await restarted.listDecisionPage(owner, { scope, includeHistory: false })).rows.length, 0)
  assert.equal(h.sends.length, 2)
})

test('projects bounded pages, searches original data and scopes long workspace IDs', async () => {
  const h = harness()
  const d = question('schedule')
  const source = { ...agentFor(d), origin: { ...d.origin, workspaceId: 'workspace-'.repeat(100) } }
  const reviewer = { ...owner, workspaces: [source.origin] }
  const payload = packageInput([d])
  const base = payload.questions[0]
  const bundle = { ...payload, summary: '日'.repeat(33_000),
    questions: Array.from({ length: 61 }, (_, i) => ({ ...base, questionId: `page-${i}`, background: 'Hidden searchable 互動文字' })) }
  const filter = { kind: 'workspace' as const, workspace: source.origin }
  value(await h.backend.submitDecision(source, bundle))
  assert.equal(code(await h.backend.listDecisions(reviewer, { scope: filter, includeHistory: true })), 'unavailable')
  const request = { scope: filter, query: '互動文字', timeZone: 'Asia/Tokyo', includeHistory: true }
  const first = value(await h.backend.listDecisionPage(reviewer, request))
  const second = value(await h.backend.listDecisionPage(reviewer, { ...request, cursor: first.nextCursor }))
  assert.equal(new Set([...first.rows, ...second.rows].map(row => row.questionId)).size, 61)
  assert.equal(second.nextCursor, undefined)
  assert.ok([first, second].every(page => new TextEncoder().encode(JSON.stringify(page)).length < 1024 * 1024))
  assert.ok(first.rows.every(row => row.background === '' && row.evidence.length === 0 && !row.packageSummary))
  assert.equal(code(await h.backend.listDecisionPage(owner, { ...request, cursor: first.nextCursor })), 'conflict')
})

test('reserves initial answer, draft, retry and receipt capacity at the metadata admission limit', async () => {
  const d = question('schedule')
  const source = agentFor(d)
  const host = mockHost({ capabilities: ['storage:own'] })
  const h = harness()
  let backend!: InboxBackend
  let failSwitch = false
  const mount = () => mountWorker({ default(orca) {
    backend = new InboxBackend(orcaStorage({ ...orca.storage, async set(key, value) {
      if (failSwitch && key === 'inbox.v1.state') throw new Error('Interrupted index switch.')
      await orca.storage.set(key, value)
    } }), h.native)
  } }, { host })
  const base = packageInput([d])
  const submit = (i: number, size: number, count = 1) => backend.submitDecision(source, {
    ...base, requestId: 'quota-r-' + i, packageId: 'quota-p-' + i,
    questions: Array.from({ length: count }, (_, j) => ({ ...base.questions[0], questionId: `quota-q-${i}-${j}` })),
    summary: 'x'.repeat(size)
  })
  let worker = await mount()
  const first = value(await submit(0, 100_000, 3))
  const admitted = [...first]
  let i = 1
  for (; i < 12; i++) {
    const result = await submit(i, 100_000)
    if (!result.ok) break
    admitted.push(...result.value)
  }
  assert.ok(i > 4 && i < 12)
  // Fill the remaining space with the largest fitting package. The probe
  // restarts after every successful write because that write consumes capacity.
  let low = 0
  let high = 99_999
  while (low <= high) {
    const size = (low + high) >> 1
    const result = await submit(i, size)
    if (result.ok) {
      admitted.push(...result.value)
      i++
      low = 0
    } else {
      assert.equal(result.message, 'The Inbox has reached its Orca storage limit.')
      high = size - 1
    }
  }
  assert.equal(code(await submit(i, 0)), 'unavailable')
  assert.equal(code(await backend.getDecision(owner, { questionId: `quota-q-${i}-0` })), 'not-found')
  assert.equal(code(await backend.saveSettings(owner, {
    revision: 0, exceptions: [], defaultTemplate: 'x'.repeat(100_000)
  })), 'unavailable')

  const questionId = first[0].questionId
  const replyId = '\ud800'.repeat(256)
  const draft = { kind: 'initial', replyId, text: '準備'.repeat(200), annotations: [{
    kind: 'selection', anchor: { kind: 'question', revision: 1, field: 'background' },
    start: 0, end: 1, quote: first[0].background[0], text: ''
  }] }
  value(await backend.saveDraft(owner, { questionId, revision: 0, draft }))
  value(await backend.saveDraft(secondOwner, { questionId, revision: 0, draft }))
  assert.equal(code(await backend.submitReply(owner, initial(questionId, replyId, 'x'.repeat(100_001)))), 'invalid')
  assert.equal(h.sends.length, 0)
  await worker.deactivate()
  worker = await mount()
  assert.deepEqual(value(await backend.getDraft(owner, { questionId })), { revision: 1, draft })

  const nativeSend = h.native.send
  h.native.send = async target => {
    const outcome = await nativeSend(target)
    failSwitch = true
    return outcome
  }
  // Acceptance and the outbox commit before transport. Interrupt the write
  // that would clear the outbox so restart has to recover the persisted entry.
  assert.equal(code(await backend.submitReply(owner, initial(questionId, replyId, 'Yes'))), 'unavailable')
  failSwitch = false
  h.native.send = nativeSend
  await worker.deactivate()
  worker = await mount()
  value(await backend.recoverInterruptedDelivery())
  const accepted = value(await backend.getDecision(owner, { questionId })).answerState
  assert.equal(accepted.state, 'answered')
  if (accepted.state !== 'answered') throw new Error('Expected a durable answer.')
  assert.deepEqual(accepted.initial.delivery, { state: 'undelivered', reason: 'delivery-failed' })
  assert.equal(value(await backend.retryReply(owner, { questionId, replyId })).delivery.state, 'submitted')
  assert.deepEqual(h.sends.map(target => target.reply.replyId), [replyId, replyId])
  const receiptId = '\ud801'.repeat(256)
  h.proof(receiptId)
  assert.equal(value(await backend.acknowledgeReply(source, { questionId, replyId, receiptId })).delivery.state, 'agent-received')
  for (const row of admitted.slice(1)) {
    const id = `answer-${row.questionId}`
    assert.equal(value(await backend.submitReply(owner, initial(row.questionId, id, 'Yes'))).delivery.state, 'submitted')
    h.proof(id)
    assert.equal(value(await backend.acknowledgeReply(source, {
      questionId: row.questionId, replyId: id, receiptId: id
    })).delivery.state, 'agent-received')
  }
  assert.ok(h.sends.every(target => JSON.stringify(target.origin) === JSON.stringify(source.origin)))
  await worker.deactivate()
})

test('reads a full pre-reservation generation and uses migration headroom for existing decisions', async () => {
  const host = mockHost({ capabilities: ['storage:own'] })
  const h = harness()
  const row = question('schedule')
  const source = agentFor(row)
  const input = packageInput([row])
  const stored = {
    compact: true, version: 1,
    packages: [{ origin: source.origin, sourceId: source.id, input,
      grant: { participantIds: [source.id, owner.id], snapshots: [] } }],
    decisions: [{ ...input.questions[0], requestId: input.requestId, packageId: input.packageId,
      revision: 1, origin: row.origin, projectName: row.projectName, workspaceName: row.workspaceName,
      createdAt: row.createdAt, decisionLink: row.decisionLink, answerState: { state: 'awaiting-answer' } }],
    replies: [], outbox: [], drafts: [],
    settings: [{ ownerId: owner.id, value: { revision: 1, defaultTemplate: 'x'.repeat(100_000),
      exceptions: Array.from({ length: 10 }, (_, i) => ({ repo: `repo-${i}`, template: 'x'.repeat(94_000) })) } }]
  }
  const encoder = new TextEncoder()
  const legacyChunks = () => JSON.stringify(stored).match(/[\s\S]{1,60000}/g)!
  const size = () => legacyChunks().reduce((sum, chunk) => sum + encoder.encode(JSON.stringify(chunk)).length, 0)
  stored.settings[0].value.exceptions[0].template += 'x'.repeat(1024 * 1024 - size())
  assert.equal(size(), 1024 * 1024)
  const seed = await mountWorker({ async default(orca) {
    for (const [i, chunk] of legacyChunks().entries()) await orca.storage.set(`inbox.v1.a.${i}`, chunk)
    await orca.storage.set('inbox.v1.state', { slot: 'a', count: legacyChunks().length })
  } }, { host })
  await seed.deactivate()

  let backend!: InboxBackend
  const mount = () => mountWorker({ default(orca) {
    backend = new InboxBackend(orcaStorage(orca.storage), h.native)
  } }, { host })
  let worker = await mount()
  assert.equal(value(await backend.getDecision(owner, { questionId: row.questionId })).answerState.state, 'awaiting-answer')
  assert.equal(code(await backend.submitDecision(source, {
    ...input, packageId: 'legacy-extra-package', requestId: 'legacy-extra-request',
    questions: [{ ...input.questions[0], questionId: 'legacy-extra' }]
  })), 'unavailable')
  const replyId = 'legacy-answer'
  const draft = { text: '', replyId, annotations: [] }
  assert.equal(value(await backend.saveDraft(owner, { questionId: row.questionId, revision: 0, draft })).revision, 1)
  h.sendOutcome('disconnected')
  assert.equal(value(await backend.submitReply(owner, initial(row.questionId, replyId))).delivery.state, 'undelivered')
  await worker.deactivate()
  worker = await mount()
  assert.deepEqual(value(await backend.getDraft(owner, { questionId: row.questionId })), { draft, revision: 1 })
  h.sendOutcome('submitted')
  assert.equal(value(await backend.retryReply(owner, { questionId: row.questionId, replyId })).delivery.state, 'submitted')
  const receiptId = 'legacy-receipt'
  h.proof(receiptId)
  assert.equal(value(await backend.acknowledgeReply(source, { questionId: row.questionId, replyId, receiptId })).delivery.state, 'agent-received')
  await worker.deactivate()
})

test('admits an exact-boundary detail with long identifiers and delivers its full reserved initial answer', async () => {
  const row = question('schedule')
  const source = agentFor(row)
  source.origin = { ...source.origin, hostId: '源'.repeat(1024), workspaceId: '室'.repeat(1024) }
  const reviewer = { ...owner, workspaces: [source.origin] }
  const questionId = '問'.repeat(256)
  const replyId = '\ud800'.repeat(256)
  const receiptId = '\ud801'.repeat(256)
  const text = '😀'.repeat(1024)
  const initialAnswer = initial(questionId, replyId, text)
  const timestamp = '+275760-09-13T00:00:00.000Z'
  const now = () => Date.parse(timestamp)
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
  assert.equal(bytes(text) - 2, 4096)

  const h = harness()
  const host = mockHost({ capabilities: ['storage:own'] })
  let backend!: InboxBackend
  let store!: InboxStorage
  const mount = () => mountWorker({ default(orca) {
    store = orcaStorage(orca.storage)
    backend = new InboxBackend(store, h.native, { now })
  } }, { host })
  let worker = await mount()
  const base = packageInput([row])
  const links = Array.from({ length: 7 }, (_, i) => ({ label: 'x'.repeat(100_000), url: `https://example.com/${i}` }))
  const tail = { label: 'b', url: 'https://example.com/extra' }
  const input = { ...base, questions: [{ ...base.questions[0], questionId }], sourceLinks: [...links, tail] }
  const sample = value(await h.backend.submitDecision(source, input))[0]
  const full = { ...sample, createdAt: timestamp,
    access: { participantIds: [source.id, owner.id, secondOwner.id], attachmentReaderIds: {} },
    answerState: { state: 'answered', initial: { ...initialAnswer, acceptedAt: timestamp,
      delivery: { state: 'agent-received', receipt: { questionId, replyId, receiptId, origin: source.origin, receivedAt: timestamp } }
    }, followUps: [] }
  }
  const limit = 768 * 1024
  const padding = tail.label.length + limit - bytes(full)
  const withPadding = (length: number) => ({ ...input, sourceLinks: [...links, { ...tail, label: 'b'.repeat(length) }] })
  const rejected = await backend.submitDecision(source, withPadding(padding + 1))
  assert.deepEqual(rejected, { ok: false, code: 'invalid',
    message: 'Decision is too large to reserve space for an initial answer and receipt.' })
  assert.equal(code(await backend.getDecision(reviewer, { questionId })), 'not-found')
  value(await backend.submitDecision(source, withPadding(padding)))
  const draft = { text, replyId, annotations: [] }
  value(await backend.saveDraft(reviewer, { questionId, revision: 0, draft }))
  h.sendOutcome('delivery-failed')
  assert.equal(value(await backend.submitReply(reviewer, initialAnswer)).delivery.state, 'undelivered')
  await worker.deactivate()

  worker = await mount()
  assert.deepEqual(value(await backend.getDraft(reviewer, { questionId })), { revision: 1, draft })
  h.sendOutcome('submitted')
  assert.equal(value(await backend.retryReply(reviewer, { questionId, replyId })).delivery.state, 'submitted')
  h.proof(receiptId)
  assert.equal(value(await backend.acknowledgeReply(source, { questionId, replyId, receiptId })).delivery.state, 'agent-received')
  assert.deepEqual(h.sends.map(target => target.reply), [initialAnswer, initialAnswer])
  const stored = await store.read() as { decisions: Decision[] }
  assert.equal(bytes(stored.decisions[0]), limit)
  value(await backend.getDecision(reviewer, { questionId }))
  await worker.deactivate()
})

test('desktop ingress uses only one matching assistant record from a resolved local Chat and merges read-only Items', async () => {
  const workspaceId = 'local-workspace'
  const session = '91408397-3661-48c4-940f-7744deb0d07a'
  const request = packageInput([question('schedule')])
  const questionId = request.questions[0].questionId
  const host = mockHost({ capabilities: ['storage:own', 'workspace:read', 'workspace:write'], results: {
    'workspace.readContext': { workspaceId, branch: '', displayName: 'Studio', terminals: [] },
    'editor.open': { opened: true },
    'workspace.list': { workspaces: [{ id: workspaceId, name: 'Studio', kind: 'folder',
      path: '/studio', branch: null, hostId: 'local' }], truncated: false }
  } })
  const hint = 'submit.' + session + '.' + request.requestId
  const entries = [
    { kind: 'message', role: 'user', text: 'ORCA-INBOX-V1 ' + JSON.stringify({ op: 'submit', input: request }) },
    { kind: 'tool', role: 'assistant', text: 'ORCA-INBOX-V1 ' + JSON.stringify({ op: 'submit', input: request }) }
  ]
  const marker = (input = request) => 'ORCA-INBOX-V1 ' + JSON.stringify({ op: 'submit', input })
  const addResponse = (text: string) => entries.push({ kind: 'message', role: 'assistant', text })
  const synthetic = { uid: 'native-uid', number: 4, owner: { name: 'Lab' }, status: 'needs_you', title: 'Layout',
    description: 'Context\nORCA-DECISION-META {"priority":"P0","blockedWork":["Layout"]}', createdAt: 1,
    question: { eventId: 'e42', text: 'Please choose.', decisions: [
      { question: 'Which layout?', replies: [{ label: 'Stack', detail: 'One column', recommended: true }] }
    ] } }
  const plain = { uid: 'plain-uid', number: 5, owner: { name: 'Lab' }, title: 'Plain Item', status: 'in_progress', createdAt: 2 }
  const places = [{ orcaSessionId: session, kind: 'chat', agent: 'codex', hostId: 'local',
    worktreeId: workspaceId, workspace: 'Studio', repo: 'Studio' }]
  let removed = false
  let reads = 0
  let nativeAvailable = true
  let chatState = 'done'
  let historyLimited = false
  let hideUserBoundary = false
  const references: unknown[] = []
  const worker = await mountWorker({ default(orca) {
    registerDesktopWorker(orca, {
      hints: async () => removed ? [] : [hint],
      removeHint: async name => { assert.equal(name, hint); removed = true },
      async cli(args) {
        if (args[0] === 'agent' && args[1] === 'show') return { kind: 'chat', places, orcaSessionId: session }
        if (args[0] === 'agent' && args[1] === 'read') { reads++; return { kind: 'chat', source: 'chat', orcaSessionId: session, state: chatState, limited: historyLimited, entries: hideUserBoundary ? entries.slice(1) : entries } }
        if (!nativeAvailable) throw new Error('Unsupported Bot CLI')
        if (args.join(' ') === 'bot list') return { bots: [{ id: 'bot-1' }, { id: 'remote', server: { on: 'paired' } }] }
        if (args[2] === 'list') {
          assert.equal(args[4], 'bot-1')
          return { items: [synthetic, plain] }
        }
        if (args[2] === 'show') return { item: synthetic }
        throw new Error('Unexpected command.')
      }
    }, async (path, reference) => {
      assert.equal(path, '/studio')
      references.push(reference)
      return '.orca-decision-inbox/probe.orca-decision'
    })
  } }, { host })
  const panel = { panel: 'inbox' }
  const list = { scope, includeHistory: true }
  const readPage = async () => value(await worker.request('listDecisionPage', list, panel))
  const first = await readPage()
  assert.deepEqual(first.rows.map(row => row.title), ['Which layout?', 'Plain Item'])
  assert.equal(first.sources?.find(src => src.source === 'native-item')?.state, 'partial')
  assert.equal(first.sources?.find(src => src.source === 'plugin')?.state, 'partial')
  assert.equal(first.mail?.state, 'unavailable')
  assert.deepEqual(value(await worker.request('listDecisionPage', { ...list, includeHistory: false }, panel))
    .rows.map(row => row.title), ['Which layout?'])
  const native = first.rows[0]
  assert.equal(native.source?.kind === 'native-item' && native.source.itemStatus, 'needs-you')
  const plainSource = first.rows[1].source
  assert.equal(plainSource?.kind === 'native-item' && plainSource.itemStatus, 'in-progress')
  assert.deepEqual(native.actions, [])
  value(await worker.request('review.open', { questionId: native.questionId }, panel))
  assert.deepEqual(host.callsOf('editor.open'), [{ workspaceId, path: '.orca-decision-inbox/probe.orca-decision' }])
  const nativeRef = references[0] as { questionId: string }
  const nativeDetail = value(await worker.request('getDecision', nativeRef, panel))
  assert.equal(nativeDetail.options[0].label, 'Stack')
  assert.deepEqual(nativeDetail.actions, [])
  assert.equal(code(await worker.request('review.open', { questionId: 'bot-item:unauthorized:e42:0' }, panel)), 'not-found')
  assert.equal(host.callsOf('editor.open').length, 1)
  assert.equal(code(await worker.request('submitReply', initial(native.questionId, 'native-answer'), panel)), 'not-found')
  assert.equal(code(await worker.request('listDecisionPage', list, { panel: 'unrelated' })), 'forbidden')

  addResponse(marker())
  chatState = 'working'
  assert.ok(!(await readPage()).rows.some(row => row.questionId === questionId))
  chatState = 'done'
  // A bounded suffix cannot authorize a marker whose user boundary was cut.
  historyLimited = true
  hideUserBoundary = true
  assert.ok(!(await readPage()).rows.some(row => row.questionId === questionId))
  hideUserBoundary = false
  // A new, unrelated exchange cannot select a marker from the earlier turn.
  entries.push({ kind: 'message', role: 'user', text: 'Unrelated work' })
  addResponse('No decision here.')
  assert.ok(!(await readPage()).rows.some(row => row.questionId === questionId))
  entries.pop()
  addResponse(marker() + '\n' + marker({ ...request, summary: 'Changed under the same ID' }))
  assert.ok(!(await readPage()).rows.some(row => row.questionId === questionId))
  entries.pop()
  places[0].hostId = 'paired'
  const priorReads = reads
  assert.ok(!(await readPage()).rows.some(row => row.questionId === questionId))
  assert.equal(reads, priorReads)
  places[0].hostId = 'local'
  // Only the latest assistant response is considered. Identical lines
  // in that response are one idempotent submission.
  addResponse(marker() + '\n' + marker())
  const imported = await readPage()
  assert.ok(imported.rows.some(row => row.questionId === questionId))
  assert.deepEqual(imported.sources?.find(src => src.source === 'plugin'), { source: 'plugin', state: 'available' })
  assert.equal(imported.mail?.state, 'unavailable')
  assert.ok(removed)
  const workspace = { hostId: 'local', workspaceId }
  assert.deepEqual(value(await worker.request('listDecisionPage', {
    scope: { kind: 'workspace', workspace }, includeHistory: true
  }, panel)).rows.map(row => row.questionId), [questionId])
  value(await worker.request('review.open', { questionId }, panel))
  value(await worker.request('settings.open', undefined, panel))
  assert.deepEqual(references, [{ questionId: native.questionId }, { questionId }, { view: 'settings' }])
  const answer = value(await worker.request('submitReply', initial(questionId, 'saved-locally'), panel))
  assert.equal(answer.delivery.state, 'undelivered')
  value(await worker.request('review.open', { questionId }, panel))
  const saved = value(await worker.request('getDecision', { questionId }, panel))
  assert.deepEqual(saved.actions, ['follow-up'])
  assert.equal(saved.answerState.state === 'answered' && saved.answerState.initial.delivery.state, 'undelivered')
  assert.equal(code(await worker.request('retryReply', { questionId, replyId: answer.replyId }, panel)), 'unavailable')
  nativeAvailable = false
  const available = await readPage()
  assert.deepEqual(available.rows.map(row => row.questionId), [questionId])
  assert.equal(available.sources?.find(src => src.source === 'native-item')?.state, 'unavailable')
  await worker.deactivate()
})

test('transport acceptance persists mail identity and requires explicit verified receipt', async () => {
  const h = harness()
  await h.submit('schedule')
  h.sendOutcome({ messageId: 'msg_synthetic' })
  const input = initial('schedule', 'mail-answer')
  const accepted = value(await h.backend.submitReply(owner, input))
  assert.deepEqual(accepted.delivery, { state: 'submitted', transport: {
    messageId: 'msg_synthetic', acceptedAt: '2030-06-14T12:00:00.000Z'
  } })
  const source = agentFor(question('schedule'))
  const proof = { questionId: input.questionId, replyId: input.replyId, receiptId: 'explicit-ack' }
  assert.equal(code(await h.restart().acknowledgeReply(source, proof)), 'forbidden')
  h.proof(proof.receiptId)
  assert.equal(value(await h.restart().acknowledgeReply(source, proof)).delivery.state, 'agent-received')
})

test('wide navigation reports a sanitized failure stage and preserves independent reads', async () => {
  const workspaceId = 'identity:local-test'
  const nativeId = 'bot-item:native-uid:e42:0'
  const secret = '/private/owner/repo'
  const context = (id: string) => ({ workspaceId: id, displayName: 'Studio', branch: '', terminals: [] })
  const row = { id: workspaceId, name: 'Studio', kind: 'worktree', path: secret, branch: null, hostId: 'local' }
  const inventory = (...workspaces: unknown[]) => ({ workspaces, truncated: false })
  const host = mockHost({ capabilities: ['workspace:read', 'workspace:write', 'storage:own'], results: {
    'workspace.readContext': context(workspaceId), 'workspace.list': inventory(row), 'editor.open': { opened: true }
  } })
  const item = { uid: 'native-uid', number: 7, owner: { name: 'Test Bot' }, status: 'needs_you', title: 'Synthetic native item',
    createdAt: 1, question: { eventId: 'e42', decisions: [{ question: 'Which layout?', replies: [{ label: 'Stack' }] }] } }
  const references: string[] = []
  let returnNotOpened = true
  let writeFailure = false
  let referencePath = '.orca-decision-inbox/wide.orca-decision'
  const worker = await mountWorker({ default(orca) {
    // The SDK mock validates opened:true. Inject a raw false after the
    // mock host records the request to cover a nonconforming response.
    const call = (async (method: string, ...args: unknown[]) => {
      const response = await Reflect.apply(orca.host.call, orca.host, [method, ...args])
      return method === 'editor.open' && returnNotOpened ? { opened: false } : response
    }) as typeof orca.host.call
    registerDesktopWorker({ ...orca, host: { ...orca.host, call } }, {
      hints: async () => [], removeHint: async () => {},
      async cli(args) {
        if (args.join(' ') === 'bot list') return { bots: [{ id: 'test-bot' }] }
        if (args[2] === 'list') return { items: [item] }
        if (args[2] === 'show') return { item }
        throw new Error('Unexpected command.')
      }
    }, async path => {
      references.push(path)
      if (writeFailure) throw Object.assign(new Error('Cannot write ' + secret), { code: 'EACCES' })
      return referencePath
    })
  } }, { host })
  const panel = { panel: 'inbox' }
  const review = () => worker.request('review.open', { questionId: nativeId }, panel)
  const settings = () => worker.request('settings.open', undefined, panel)
  const expectFailure = (answer: Result<unknown>, stage: string) => assert.deepEqual(answer, {
    ok: false, code: 'unavailable', message: `Could not open the wide tab (${stage}).`
  })
  expectFailure(await review(), 'editor.open: not_opened')
  returnNotOpened = false
  assert.deepEqual(host.callsOf('editor.open'), [{ workspaceId, path: referencePath }])
  host.respond('editor.open', () => { throw hostError('not_permitted', 'Refused ' + secret) })
  expectFailure(await settings(), 'editor.open: not_permitted')
  assert.deepEqual(worker.logs.slice(-2), [
    '[wide-tab] review: editor.open: not_opened', '[wide-tab] settings: editor.open: not_permitted'
  ])
  assert.equal(value(await worker.request('getDecision', { questionId: nativeId }, panel)).options[0].label, 'Stack')
  assert.equal(value(await worker.request('settings.get', undefined, panel)).revision, 0)
  host.respond('editor.open', () => { throw hostError('action_failed', 'This window does not list ' + secret + '.') })
  expectFailure(await review(), 'editor.open: workspace_not_found')

  writeFailure = true
  expectFailure(await settings(), 'file materialization: EACCES')
  writeFailure = false
  referencePath = '../outside.orca-decision'
  expectFailure(await settings(), 'file materialization: invalid_relative_path')
  const priorReferences = references.length
  host.respond('workspace.list', inventory({ ...row, hostId: 'runtime:paired' }))
  expectFailure(await review(), 'workspace selection: local_workspace_required')
  host.respond('workspace.list', inventory(row, { ...row, hostId: 'runtime:paired' }))
  expectFailure(await settings(), 'workspace selection: ambiguous_workspace')
  host.respond('workspace.list', () => { throw hostError('timeout', 'Inventory private detail ' + secret) })
  expectFailure(await settings(), 'workspace selection: timeout')
  assert.equal(references.length, priorReferences)
  assert.equal(host.callsOf('editor.open').length, 3)

  const folderId = 'folder:local-test'
  host.respond('workspace.list', inventory({ ...row, id: folderId, kind: 'folder', hostId: null }))
  host.respond('workspace.readContext', context(folderId))
  host.respond('editor.open', { opened: true })
  referencePath = '.orca-decision-inbox/wide.orca-decision'
  value(await settings())
  assert.deepEqual(host.callsOf('editor.open').at(-1), { workspaceId: folderId, path: referencePath })
  assert.equal(host.callsOf('workspace.open').length, 0)
  assert.ok(worker.logs.every(line => !line.includes(secret)))
  await worker.deactivate()
})
