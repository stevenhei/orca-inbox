import { assert, hostError, mockHost, mount, test } from 'orca/testing'
import type { MockRequests, TestPanel } from 'orca/testing'
import * as panel from './panel'
import { decisions, historyExample, clock as fixtureClock, origins } from '../fixtures/decisions'
import { dayKey, group, order, receiptMatches, shownState, visible, workspaceKey } from './model'
import { clock, reconcile } from './client'
import type { Decision, ListDecisions } from './contract'

// Fixtures, the fixed clock and UTC are injected here only; production reads the live clock and
// the desktop zone (see the last test).
const NOW = Date.parse(fixtureClock)
const live = { now: clock.now, zone: clock.zone }
clock.now = () => NOW
clock.zone = () => 'UTC'

const studio = { hostId: 'local', workspaceId: 'studio' }
const base = { scope: 'all' as const, current: studio, term: '', history: false, now: NOW, zone: 'UTC' }
const ids = (list: { questionId: string }[]) => list.map((d) => d.questionId)

// ---- view-model ---------------------------------------------------------------------------------
test('sort: P0 oldest first, then due-today and overdue by priority, then the rest', () => {
  assert.deepEqual(ids(order(decisions, NOW, 'UTC')), ['room-route', 'room-reset', 'stage', 'layout', 'image-review', 'schedule'])
})

test('This workspace is host + workspace: paired studio is not local studio', () => {
  assert.deepEqual(ids(visible(decisions, { ...base, scope: 'workspace' })), ['image-review', 'schedule'])
  assert.notEqual(workspaceKey({ hostId: 'paired', workspaceId: 'studio' }), workspaceKey(studio))
})

test('search: identifier, background, option, recommendation (CJK), and history-only reply text', () => {
  assert.equal(ids(visible(decisions, { ...base, term: 'layout' })).includes('layout'), true)
  assert.deepEqual(ids(visible(decisions, { ...base, term: 'contrast' })), ['layout'])
  assert.deepEqual(ids(visible(decisions, { ...base, term: 'Fold-out' })), ['layout'])
  assert.deepEqual(ids(visible(decisions, { ...base, term: '錄音' })), ['schedule'])
  const withHistory = decisions.map((d) => (d.questionId === 'layout' ? historyExample : d))
  assert.deepEqual(ids(visible(withHistory, { ...base, term: 'matte sample' })), [])
  assert.deepEqual(ids(visible(withHistory, { ...base, term: 'matte sample', history: true })), ['layout'])
})

test('history example is Agent received and hidden by default', () => {
  assert.equal(shownState(historyExample), 'agent-received')
  assert.equal(ids(visible([historyExample], base)).length, 0)
})

test('a receipt counts only for its own reply, question and exact origin', () => {
  const s = historyExample.answerState
  assert.ok(s.state === 'answered')
  assert.equal(receiptMatches(s.initial, historyExample), true)
  if (s.state !== 'answered' || s.initial.delivery.state !== 'agent-received') return
  const receipt = s.initial.delivery.receipt
  const variant = (r: typeof receipt): Decision => ({ ...historyExample, answerState: { ...s, initial: { ...s.initial, delivery: { state: 'agent-received', receipt: r } } } })
  assert.equal(shownState(variant({ ...receipt, origin: { ...receipt.origin, sessionId: 'other' } })), 'submitted')
  assert.equal(shownState(variant({ ...receipt, origin: origins.remote })), 'submitted')
  assert.equal(shownState(variant({ ...receipt, replyId: 'another-reply' })), 'submitted')
})

test('drafts reconcile with the recorded answer', () => {
  const s = historyExample.answerState
  assert.ok(s.state === 'answered')
  if (s.state !== 'answered') return
  assert.deepEqual(reconcile({ text: 'x', replyId: s.initial.replyId, kind: 'initial', annotations: [] }, historyExample), { kind: 'sent', draft: null })
  const lost = reconcile({ text: 'mine', optionId: 'list', replyId: 'reply-mine', kind: 'initial', annotations: [] }, historyExample)
  assert.deepEqual(lost, { kind: 'superseded', draft: { text: 'mine', kind: 'follow-up', annotations: [] } })
  const awaiting = decisions.find((d) => d.questionId === 'schedule')!
  assert.equal(reconcile({ text: 'mine', replyId: 'reply-mine', kind: 'initial', annotations: [] }, awaiting).kind, 'keep')
})

test('due today follows the reviewing desktop time zone', () => {
  const stage = decisions.find((d) => d.questionId === 'stage')! // deadline 2030-06-14T15:00Z, P1
  const later = { ...stage, deadline: '2030-06-14T17:00:00Z' } // 01:00 on 15 June in Hong Kong
  assert.equal(group(stage, NOW, 'UTC'), 1)
  assert.equal(group(later, NOW, 'UTC'), 1, 'same UTC day')
  assert.equal(group(later, NOW, 'Asia/Hong_Kong'), 2, 'next local day in Hong Kong: not due today')
  assert.equal(dayKey(NOW, 'Asia/Hong_Kong'), '2030-06-14')
  assert.equal(group({ ...stage, deadline: '2030-06-13T20:00:00Z' }, NOW, 'Asia/Hong_Kong'), 1, 'overdue in any zone')
})

// ---- panel against a controlled worker ----------------------------------------------------------
const workspaces: Record<string, { hostId: string; workspaceId: string }> = {
  'studio-local': { hostId: 'local', workspaceId: 'studio' },
  'library-local': { hostId: 'local', workspaceId: 'library' }
}
const ctx = (workspaceId?: string) => ({ context: workspaceId === undefined ? null : { workspaceId, branch: 'main', displayName: workspaceId, terminals: [] } })
const ok = <T,>(value: T) => ({ ok: true as const, value })

/** A worker that authorizes everything in the fixtures and filters by the requested scope. */
function worker(list: Decision[] = decisions, extra: MockRequests = {}): MockRequests {
  return {
    'workspace.resolve': ({ workspaceId }: { workspaceId: string }) =>
      workspaces[workspaceId] ? ok(workspaces[workspaceId]) : { ok: false, code: 'not-found', message: 'Unknown workspace.' },
    listDecisions: ({ scope }: ListDecisions) => ok(list.filter((d) => scope.kind === 'all' ||
      (d.origin.hostId === scope.workspace.hostId && d.origin.workspaceId === scope.workspace.workspaceId))),
    'review.open': () => ok(null),
    'settings.open': () => ok(null),
    ...extra
  }
}
const requestsOf = (view: TestPanel, name: string) =>
  view.host.callsOf('plugin.request').filter((c) => (c as { name: string }).name === name).map((c) => (c as { input: unknown }).input)
const titles = (view: TestPanel) => view.findAll({ type: 'ListItem' }).map((e) => e.label)

async function withPanel(requests: MockRequests, fn: (view: TestPanel) => Promise<void>) {
  const view = await mount(panel, { host: mockHost({ requests, capabilities: ['workspace:read', 'storage:own'] }) })
  try { await fn(view); assert.deepEqual(view.errors, []) } finally { await view.unmount() }
}

test('panel: This workspace resolves host + workspace through the worker and lists only it', () => withPanel(worker(), async (view) => {
  assert.ok(view.find({ label: 'Finding the focused workspace' }), 'waits for the focused workspace, no guess')
  assert.equal(requestsOf(view, 'listDecisions').length, 0)
  await view.emit('workspace.changed', ctx('studio-local'))
  assert.deepEqual(requestsOf(view, 'workspace.resolve'), [{ workspaceId: 'studio-local' }])
  assert.deepEqual(requestsOf(view, 'listDecisions').at(-1), { scope: { kind: 'workspace', workspace: studio }, includeHistory: true })
  assert.deepEqual(titles(view), ['Compare seven paper model views', 'Pick a rehearsal slot'])
  assert.ok(!view.find({ label: 'Approve the first lantern trial' }), 'paired studio with the same workspace ID is excluded')
  assert.ok(view.find({ text: '2 need you' }))
}))

test('panel: All workspaces survives focus changes; This workspace follows focus', () => withPanel(worker(), async (view) => {
  await view.emit('workspace.changed', ctx('studio-local'))
  await view.press({ text: 'All workspaces' })
  assert.deepEqual(requestsOf(view, 'listDecisions').at(-1), { scope: { kind: 'all' }, includeHistory: true })
  assert.deepEqual(titles(view), ['Approve the reading room route', 'Approve the reading room reset window', 'Approve the first lantern trial',
    'Choose the catalogue layout', 'Compare seven paper model views', 'Pick a rehearsal slot'])
  await view.emit('workspace.changed', ctx('library-local'))
  assert.equal(titles(view).length, 6, 'All workspaces stays selected after a focus change')
  await view.press({ text: 'This workspace' })
  assert.deepEqual(titles(view), ['Approve the reading room route', 'Approve the reading room reset window', 'Choose the catalogue layout'])
  assert.ok(view.find({ text: /Overdue 25h/ }), 'relative deadline from the injected clock')
  assert.ok(view.findAll({ text: 'Package · 2 questions' }).length === 2, 'package badge on each question of the package')
}))

test('panel: search and history filter within the selected scope', () => withPanel(worker(decisions.map((d) => d.questionId === 'layout' ? historyExample : d)), async (view) => {
  await view.emit('workspace.changed', ctx('library-local'))
  await view.type({ label: 'Search' }, 'matte sample')
  assert.ok(view.find({ label: 'No matches' }))
  await view.toggle({ label: 'Include history' })
  assert.deepEqual(titles(view), ['Choose the catalogue layout'])
  assert.ok(view.find({ text: 'Agent received' }))
}))

test('panel: no focused workspace or an unresolvable host shows a state, never a guessed scope', () => withPanel(worker(), async (view) => {
  await view.emit('workspace.changed', ctx(undefined))
  assert.ok(view.find({ label: 'No workspace is focused' }))
  await view.emit('workspace.changed', ctx('ambiguous'))
  assert.ok(view.find({ label: 'Could not identify this workspace' }))
  assert.equal(requestsOf(view, 'listDecisions').length, 0, 'nothing listed for an unresolved workspace')
  await view.press({ text: 'Show all workspaces' })
  assert.equal(titles(view).length, 6)
}))

test('panel: worker failures show truthfully, with no fixture fallback', async () => {
  await withPanel({ 'workspace.resolve': ok(studio), listDecisions: () => { throw hostError('unavailable', 'Worker stopped.') } }, async (view) => {
    await view.emit('workspace.changed', ctx('studio-local'))
    assert.ok(view.find({ text: /The Decision Inbox is unavailable\. Worker stopped\./ }))
    assert.equal(titles(view).length, 0, 'no rows without worker data')
  })
  await withPanel({ 'workspace.resolve': ok(studio), listDecisions: { ok: false, code: 'forbidden', message: 'Owner only.' } }, async (view) => {
    await view.emit('workspace.changed', ctx('studio-local'))
    assert.ok(view.find({ text: /You do not have access\. Owner only\./ }))
  })
  await withPanel({}, async (view) => {
    await view.press({ text: 'All workspaces' })
    assert.ok(view.find({ text: /does not provide “listDecisions”/ }), 'missing handler reported')
    assert.equal(titles(view).length, 0)
  })
})

test('panel: a failed refresh keeps and labels the last loaded list', async () => {
  let up = true
  await withPanel(worker(decisions, { listDecisions: ({ scope }: ListDecisions) => up ? ok(decisions.filter((d) => scope.kind === 'all')) : { ok: false, code: 'unavailable', message: 'Disconnected.' } }), async (view) => {
    await view.press({ text: 'All workspaces' })
    up = false
    await view.post('inbox.changed', {})
    assert.equal(titles(view).length, 6)
    assert.ok(view.find({ label: 'Showing the last loaded list' }))
    up = true
    await view.press({ text: 'Retry loading' })
    assert.ok(!view.find({ label: 'Showing the last loaded list' }))
  })
})

test('panel: inbox.changed refetches through the worker', async () => {
  const list = decisions.filter((d) => d.questionId !== 'schedule')
  await withPanel(worker(list), async (view) => {
    await view.emit('workspace.changed', ctx('studio-local'))
    assert.deepEqual(titles(view), ['Compare seven paper model views'])
    list.push(decisions.find((d) => d.questionId === 'schedule')!)
    await view.post('inbox.changed', {})
    assert.deepEqual(titles(view), ['Compare seven paper model views', 'Pick a rehearsal slot'])
  })
})

test('panel: a row opens its review by question ID; failures do not mark it open', async () => {
  let fail = true
  await withPanel(worker(decisions, { 'review.open': () => fail ? { ok: false, code: 'unavailable', message: 'No supported editor seam.' } : ok(null) }), async (view) => {
    await view.emit('workspace.changed', ctx('studio-local'))
    await view.press({ label: 'Pick a rehearsal slot' })
    assert.deepEqual(requestsOf(view, 'review.open'), [{ questionId: 'schedule' }])
    assert.ok(view.find({ label: 'Could not open the review tab' }))
    assert.equal(view.find({ label: 'Pick a rehearsal slot' })?.props.current, false, 'not marked open on failure')
    fail = false
    await view.press({ label: 'Pick a rehearsal slot' })
    assert.ok(!view.find({ label: 'Could not open the review tab' }))
    assert.equal(view.find({ label: 'Pick a rehearsal slot' })?.props.current, true)
  })
})

test('panel: settings open through the worker and report failure', () => withPanel(worker(decisions, { 'settings.open': { ok: false, code: 'unavailable', message: 'Not supported.' } }), async (view) => {
  await view.press({ label: 'Inbox settings' })
  assert.equal(requestsOf(view, 'settings.open').length, 1)
  assert.ok(view.find({ label: 'Could not open Inbox settings' }))
}))

test('production clock is the live clock and the desktop zone', () => {
  const t = live.now()
  assert.ok(Math.abs(t - Date.now()) < 5_000, 'live clock, not the fixture clock')
  assert.notEqual(t, NOW)
  assert.equal(live.zone(), Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
})
