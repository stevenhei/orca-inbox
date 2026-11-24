import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import { registerDesktopWorker } from './worker.ts'
import { InboxBackend } from './backend.ts'
import { localInboxBoundary } from './backend-orca.ts'
import { orcaStorage } from './backend-storage.ts'
import type { Annotation, Result, SubmitDecision } from './contract.ts'

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.message)
  return result.value
}

test('practice worker seeds exactly eight questions once and persists private drafts and local replies across restart', async () => {
  let sourceCalls = 0
  const host = mockHost({ capabilities: ['storage:own', 'workspace:read'], results: {
    'workspace.list': () => { throw hostError('not_permitted', 'Live workspaces unavailable') }
  } })
  const failSource = async (): Promise<never> => {
    sourceCalls++
    throw new Error('Practice must never call a live source.')
  }
  const mount = () => mountWorker({ default(orca) {
    registerDesktopWorker(orca, { cli: failSource, hints: failSource, removeHint: failSource }, failSource)
  } }, { host })
  const panel = { panel: 'inbox' }
  const unknownPanel = { panel: 'unrelated' }
  const query = { includeHistory: true }
  const worker = await mount()
  const denied = await worker.request('practice.listDecisionPage', query, unknownPanel)
  assert.ok(!denied.ok && denied.code === 'forbidden')
  assert.deepEqual(host.data().storage, {})
  const pages = await Promise.all(Array.from({ length: 4 }, () => worker.request('practice.listDecisionPage', query, panel)))
  const initial = value(pages[0])
  assert.equal(initial.rows.length, 8)
  assert.equal(new Set(initial.rows.map(row => row.questionId)).size, 8)
  for (const page of pages) assert.deepEqual(value(page), initial)
  assert.ok(initial.rows.every(row => row.source?.kind === 'practice' && row.questionId.startsWith('practice:')))
  assert.equal(initial.sources, undefined)
  assert.equal(initial.mail, undefined)
  const questionId = 'practice:poster-layout'
  const target = { questionId, mode: 'practice' as const }
  const detail = value(await worker.request('getDecision', target, panel))
  assert.deepEqual(detail.actions, ['reply'])
  assert.deepEqual(detail.package, { index: 0, size: 3 })
  assert.equal(detail.inlineImages?.length, 1)
  const ref = { ...target, attachmentId: 'practice:layout-v1' }
  const image = value(await worker.request('getSnapshot', ref, panel))
  assert.equal(image.mimeType, 'image/png')
  assert.ok(image.base64.startsWith('iVBORw0KGgo'))
  const badGrant = await worker.request('getSnapshot', ref, unknownPanel)
  assert.ok(!badGrant.ok && badGrant.code === 'forbidden')
  const note: Annotation = { kind: 'selection', text: '提醒',
    anchor: { kind: 'question', field: 'description', revision: 1 }, start: 0, end: 2, quote: '練習' }
  const draft = { optionId: 'text', text: '字較大', annotations: [note] }
  const save = { ...target, revision: 0, draft }
  assert.equal(value(await worker.request('draft.save', save, panel)).revision, 1)
  const stale = await worker.request('draft.save', save, panel)
  assert.ok(!stale.ok && stale.code === 'conflict')
  await worker.deactivate()

  const restarted = await mount()
  try {
    assert.deepEqual(value(await restarted.request('draft.get', target, panel)).draft, draft)
    assert.deepEqual(value(await restarted.request('getSnapshot', ref, panel)), image)
    const answer = { ...target, replyId: 'practice-answer', kind: 'initial' as const,
      answer: { kind: 'option' as const, optionId: 'text', detail: draft.text }, annotations: [note] }
    const saved = value(await restarted.request('submitReply', answer, panel))
    assert.deepEqual(saved.delivery, { state: 'local-only' })
    assert.deepEqual(value(await restarted.request('submitReply', answer, panel)), saved)
    assert.equal(value(await restarted.request('practice.listDecisionPage', query, panel)).rows.length, 8)
    assert.equal(value(await restarted.request('practice.listDecisionPage', { includeHistory: false }, panel)).rows.length, 7)
    const followup = value(await restarted.request('submitReply', { ...answer, replyId: 'practice-followup', kind: 'follow-up',
      answer: { kind: 'text', text: '補充：考慮閱讀距離。' } }, panel))
    assert.deepEqual(followup.delivery, { state: 'local-only' })
    const retry = await restarted.request('retryReply', answer, panel)
    assert.ok(!retry.ok && retry.code === 'unavailable')
    const wide = await restarted.request('review.open', target, panel)
    assert.ok(!wide.ok && wide.code === 'unavailable')
    assert.ok(restarted.posts.some(post => post.event === 'practice.changed'))
    assert.ok(restarted.posts.every(post => post.event !== 'inbox.changed'))
  } finally { await restarted.deactivate() }
  const reopened = await mount()
  try {
    const stored = value(await reopened.request('getDecision', target, panel))
    assert.ok(stored.answerState.state === 'answered')
    assert.deepEqual(stored.answerState.initial.delivery, { state: 'local-only' })
    assert.deepEqual(stored.answerState.initial.annotations, [note])
    assert.equal(stored.answerState.followUps.length, 1)
    assert.equal(host.callsOf('workspace.list').length, 0)
    assert.equal(sourceCalls, 0)
    assert.ok(Object.keys(host.data().storage).every(key => key.startsWith('practice.inbox.v1.')))
    assert.ok(Object.values(host.data().storage).some(item => typeof item === 'string' && item.includes('"outbox":[]')))
  } finally { await reopened.deactivate() }
})

test('bounded hint lookup and lookup directory failure are surfaced separately from mail', async () => {
  let scanFails = false
  const host = mockHost({ capabilities: ['storage:own', 'workspace:read'], results: {
    'workspace.list': { workspaces: [], truncated: false }
  } })
  const worker = await mountWorker({ default(orca) {
    registerDesktopWorker(orca, {
      async cli(args) {
        if (args[0] === 'environment') return { environments: [{ id: 'paired', name: 'Paired', runtimeId: 'remote' }] }
        return { bots: [] }
      },
      async hints() { throw new Error('Use the scanner reporting the limit.') },
      async scanHints() {
        if (scanFails) throw new Error('Cannot inspect directory')
        return { names: [], truncated: true }
      },
      async removeHint() {}
    })
  } }, { host })
  try {
    const page = async () => value(await worker.request('listDecisionPage', { scope: { kind: 'all' }, includeHistory: false }, { panel: 'inbox' }))
    const limited = await page()
    const coverage = limited.sources?.find(source => source.source === 'plugin')
    assert.equal(coverage?.state, 'partial')
    assert.deepEqual(coverage?.coverage?.map(notice => notice.kind), ['hint-scan-limited'])
    assert.match(coverage?.message ?? '', /scan limit/)
    assert.equal(limited.mail?.state, 'unavailable')
    scanFails = true
    const failure = (await page()).sources?.find(source => source.source === 'plugin')
    assert.deepEqual(failure?.coverage?.map(notice => notice.kind), ['hint-read-failed'])
    assert.match(failure?.message ?? '', /could not read the local Chat lookup directory/)
    assert.ok(!failure?.message?.includes('Paired Chat'))
  } finally { await worker.deactivate() }
})

test('a historical live and a practice question sharing the same literal ID remain separate', async () => {
  const workspace = { hostId: 'local', workspaceId: 'legacy-live-workspace' }
  const sessionId = '89626680-3dc3-4f2b-b4dc-c22909bd78ff'
  const questionId = 'practice:poster-layout'
  const live = { questionId }
  const practice = { questionId, mode: 'practice' as const }
  const agent = {
    kind: 'agent' as const, id: sessionId, origin: { ...workspace, sessionId },
    repo: 'legacy', projectName: 'Live project', workspaceName: 'Live workspace', policyOwnerId: 'decision-inbox-local-desktop'
  }
  const payload: SubmitDecision = {
    requestId: 'legacy-request', packageId: 'legacy-package', evidence: [], sourceLinks: [],
    questions: [{ questionId, title: 'Historical live question', background: 'Live background',
      priority: 'P3', blockedWork: [], recommendation: '', options: [] }]
  }
  const host = mockHost({ capabilities: ['storage:own', 'workspace:read', 'workspace:write'], results: {
    'workspace.list': { workspaces: [{ id: workspace.workspaceId, hostId: workspace.hostId, name: 'Live workspace',
      kind: 'worktree', path: '/fixture', branch: null }], truncated: false },
    'workspace.readContext': { workspaceId: workspace.workspaceId, displayName: 'Live workspace', branch: '', terminals: [] },
    'editor.open': { opened: true }
  } })
  let cliCalls = 0
  let hintCalls = 0
  const cli = async (args: string[]) => {
    cliCalls++
    if (args[0] === 'environment') return { environments: [] }
    if (args[0] === 'agent' && args[1] === 'show') return { kind: 'chat', orcaSessionId: sessionId, places: [] }
    return { bots: [] }
  }
  const seed = await mountWorker({ async default(orca) {
    // Emulate a pre-reservation installation by writing this ID to the live storage namespace.
    const prior = new InboxBackend(orcaStorage(orca.storage), localInboxBoundary(cli), { practice: true })
    value(await prior.submitDecision(agent, payload))
  } }, { host })
  await seed.deactivate()
  let backend!: InboxBackend
  const references: unknown[] = []
  const worker = await mountWorker({ default(orca) {
    backend = registerDesktopWorker(orca, {
      cli, async hints() { hintCalls++; return [] }, async removeHint() {}
    }, async (_root, reference) => {
      references.push(reference)
      return '.orca-decision-inbox/test.orca-decision'
    })
  } }, { host })
  const caller = { panel: 'inbox' }
  try {
    assert.equal(value(await backend.submitDecision(agent, payload))[0].questionId, questionId)
    const fresh = await backend.submitDecision(agent, {
      ...payload, requestId: 'new-id', packageId: 'new-package',
      questions: [{ ...payload.questions[0], questionId: 'practice:new-id' }]
    })
    assert.ok(!fresh.ok && fresh.code === 'invalid')
    const livePage = value(await worker.request('listDecisionPage', { includeHistory: true, scope: { kind: 'all' } }, caller))
    assert.deepEqual(livePage.rows.map(row => [row.questionId, row.source?.kind]), [[questionId, 'plugin']])
    assert.equal(value(await worker.request('getDecision', live, caller)).title, payload.questions[0].title)
    assert.deepEqual(value(await worker.request('getDecision', live, caller)).origin, agent.origin)
    value(await worker.request('review.open', live, caller))
    assert.deepEqual(references, [live])
    const draft = { revision: 0, draft: { text: 'Historical draft', annotations: [] } }
    value(await worker.request('draft.save', { ...live, ...draft }, caller))
    const answer = { replyId: 'same-reply-id', kind: 'initial' as const,
      answer: { kind: 'text' as const, text: 'Historical answer' }, annotations: [] }
    const liveReply = value(await worker.request('submitReply', { ...live, ...answer }, caller))
    assert.deepEqual(liveReply.delivery, { state: 'undelivered', reason: 'closed-origin' })

    const liveReadCounts = () => [cliCalls, hintCalls, host.callsOf('workspace.list').length]
    const beforePractice = liveReadCounts()
    const practicePage = value(await worker.request('practice.listDecisionPage', { includeHistory: true }, caller))
    assert.equal(practicePage.rows.find(row => row.questionId === questionId)?.source?.kind, 'practice')
    const practiceDetail = value(await worker.request('getDecision', practice, caller))
    assert.equal(practiceDetail.origin.hostId, 'practice:local')
    assert.notEqual(practiceDetail.title, payload.questions[0].title)
    const privateDraft = { text: '練習草稿', annotations: [] }
    value(await worker.request('draft.save', { ...practice, revision: 0, draft: privateDraft }, caller))
    assert.deepEqual(value(await worker.request('draft.get', practice, caller)).draft, privateDraft)
    const privateAnswer = { ...practice, ...answer, answer: { ...answer.answer, text: '練習答案' } }
    const saved = value(await worker.request('submitReply', privateAnswer, caller))
    assert.deepEqual(saved.delivery, { state: 'local-only' })
    assert.equal(Object.hasOwn(saved, 'mode'), false)
    assert.deepEqual(value(await worker.request('submitReply', privateAnswer, caller)), saved)
    assert.deepEqual(liveReadCounts(), beforePractice)
    assert.deepEqual(value(await worker.request('draft.get', live, caller)).draft, draft.draft)
    assert.deepEqual(value(await worker.request('submitReply', { ...live, ...answer }, caller)), liveReply)
  } finally { await worker.deactivate() }
})
