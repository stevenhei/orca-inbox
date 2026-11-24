import { assert, hostError, mockHost, mount, test } from 'orca/testing'
import type { MockRequests, TestPanel } from 'orca/testing'
import * as panel from '../src/panel'
import { decisions, historyExample, clock as fixtureClock, origins } from '../fixtures/decisions'
import { actionsOf, dayKey, deadlineLabel, group, isActionable, nativeStatusLabel, order, receiptMatches, searchText, shownState, visible, workspaceKey } from '../src/model'
import { clock, reconcile } from '../src/client'
import { workspaceValue } from '../src/workspace-scope'
import type { Decision, ListDecisions, Result, SubmitReply, Workspace } from '../src/contract'
import type { DecisionPage, DraftRecord, InboxSettings, SourceAvailability, WorkspaceOptions } from '../src/backend-protocol'

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
test('sort: priority bands keep the shared fixture order', () => {
  assert.deepEqual(ids(order(decisions, NOW, 'UTC')), ['room-route', 'room-reset', 'stage', 'layout', 'image-review', 'schedule'])
})

test('sort: absolute deadlines precede undated rows within a priority, then age and stable ID', () => {
  const seed = decisions[0]
  const items: Decision[] = [
    { ...seed, questionId: 'p3-overdue', priority: 'P3', deadline: '2000-01-01T00:00:00Z' },
    { ...seed, questionId: 'p2-undated', priority: 'P2', deadline: undefined },
    { ...seed, questionId: 'p2-same-b', priority: 'P2', deadline: '2030-06-15T02:00:00Z', createdAt: '2030-06-10T00:00:00Z' },
    { ...seed, questionId: 'p2-newer', priority: 'P2', deadline: '2030-06-15T02:00:00Z', createdAt: '2030-06-11T00:00:00Z' },
    { ...seed, questionId: 'p2-same-a', priority: 'P2', deadline: '2030-06-14T22:00:00-04:00', createdAt: '2030-06-10T00:00:00Z' },
    { ...seed, questionId: 'p2-overdue', priority: 'P2', deadline: '2030-06-13T11:00:00Z' },
    { ...seed, questionId: 'p1-future', priority: 'P1', deadline: '2040-06-14T15:00:00Z' },
    { ...seed, questionId: 'p0-undated', priority: 'P0', deadline: undefined }
  ]
  const expected = ['p0-undated', 'p1-future', 'p2-overdue', 'p2-same-a', 'p2-same-b',
    'p2-newer', 'p2-undated', 'p3-overdue']
  assert.deepEqual(ids(order(items, NOW, 'UTC')), expected)
  assert.deepEqual(ids(order(items, NOW, 'America/Los_Angeles')), expected)
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
  const mine = { text: 'mine', optionId: 'list', replyId: 'reply-mine', kind: 'initial' as const, annotations: [] }
  const lost = reconcile(mine, historyExample)
  assert.deepEqual(lost, { kind: 'superseded', draft: mine }, 'kept as written: never converted to a follow-up automatically')
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
type PageInput = ListDecisions & { cursor?: string; timeZone?: string }

/**
 * A worker stand-in that authorizes everything in the fixtures and, like the real one, filters by
 * scope, history (shared `isActionable`) and query server-side, orders in the requested zone and
 * answers bounded pages of `size` rows with an opaque cursor.
 */
function worker(list: Decision[] = decisions, extra: MockRequests = {}, size = 50, sources?: SourceAvailability[], mail?: DecisionPage['mail']): MockRequests {
  return {
    'workspace.resolve': ({ workspaceId }: { workspaceId: string }) =>
      workspaces[workspaceId] ? ok(workspaces[workspaceId]) : { ok: false, code: 'not-found', message: 'Unknown workspace.' },
    // Authorized inventory: two "studio" workspaces on different hosts, and an empty "archive".
    'workspace.options': () => ok({ workspaces: [
      { hostId: 'local', workspaceId: 'studio', name: 'studio', hostLabel: 'Local Orca' },
      { hostId: 'local', workspaceId: 'library', name: 'library', hostLabel: 'Local Orca' },
      { hostId: 'paired', workspaceId: 'studio', name: 'studio' },
      { hostId: 'local', workspaceId: 'archive', name: 'archive', hostLabel: 'Local Orca' }] }),
    listDecisionPage: ({ scope, query, includeHistory, cursor, timeZone }: PageInput) => {
      const t = (query ?? '').toLocaleLowerCase()
      const all = order(list.filter((d) => (scope.kind === 'all' ||
        (d.origin.hostId === scope.workspace.hostId && d.origin.workspaceId === scope.workspace.workspaceId)) &&
        (includeHistory || isActionable(d)) && (!t || searchText(d).includes(t))), NOW, timeZone ?? 'UTC')
      const start = cursor ? Number(cursor.slice(2)) : 0
      const rows = all.slice(start, start + size)
      const page = start + size < all.length ? { rows, nextCursor: `c:${start + size}` } : { rows }
      return ok({ ...page, ...(sources ? { sources } : {}), ...(mail ? { mail } : {}) })
    },
    'review.open': () => ok(null),
    'settings.open': () => ok(null),
    getDecision: ({ questionId }: { questionId: string }) => {
      const d = list.find((x) => x.questionId === questionId)
      return d ? ok(d) : { ok: false, code: 'not-found', message: 'Decision is missing or inaccessible.' }
    },
    ...extra
  }
}
/** The stand-in inventory, without local library once it is gone. */
function withoutLibrary(w: MockRequests, gone: boolean) {
  const r = (w['workspace.options'] as () => Result<WorkspaceOptions>)()
  return gone && r.ok ? ok({ ...r.value, workspaces: r.value.workspaces.filter((x) => x.workspaceId !== 'library') }) : r
}
const requestsOf = (view: TestPanel, name: string) =>
  view.host.callsOf('plugin.request').filter((c) => (c as { name: string }).name === name).map((c) => (c as { input: unknown }).input)
const titles = (view: TestPanel) => view.findAll({ type: 'ListItem' }).map((e) => e.label)
const ALL_ORDER = ['Approve the reading room route', 'Approve the reading room reset window', 'Approve the first lantern trial',
  'Choose the catalogue layout', 'Compare seven paper model views', 'Pick a rehearsal slot']

async function withPanel(requests: MockRequests, fn: (view: TestPanel) => Promise<void>) {
  const view = await mount(panel, { host: mockHost({ requests, capabilities: ['workspace:read', 'storage:own'] }) })
  try { await fn(view); assert.deepEqual(view.errors, []) } finally { await view.unmount() }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('panel: This workspace resolves host + workspace through the worker and lists only it', () => withPanel(worker(), async (view) => {
  assert.ok(view.find({ label: 'Finding the focused workspace' }), 'waits for the focused workspace, no guess')
  assert.equal(requestsOf(view, 'listDecisionPage').length, 0)
  await view.emit('workspace.changed', ctx('studio-local'))
  assert.deepEqual(requestsOf(view, 'workspace.resolve'), [{ workspaceId: 'studio-local' }])
  assert.deepEqual(requestsOf(view, 'listDecisionPage').at(-1), { scope: { kind: 'workspace', workspace: studio }, includeHistory: false, timeZone: 'UTC' })
  assert.deepEqual(titles(view), ['Compare seven paper model views', 'Pick a rehearsal slot'])
  assert.ok(!view.find({ label: 'Approve the first lantern trial' }), 'paired studio with the same workspace ID is excluded')
  assert.ok(view.find({ text: '2 need you' }))
}))

test('panel: an explicit Workspace choice survives focus changes; choosing one workspace lists only it', () => withPanel(worker(), async (view) => {
  await view.emit('workspace.changed', ctx('studio-local'))
  await view.select({ label: 'Workspace' }, 'all')
  assert.deepEqual(requestsOf(view, 'listDecisionPage').at(-1), { scope: { kind: 'all' }, includeHistory: false, timeZone: 'UTC' })
  assert.deepEqual(titles(view), ALL_ORDER)
  await view.emit('workspace.changed', ctx('library-local'))
  assert.equal(titles(view).length, 6, 'All workspaces stays selected after a focus change')
  await view.select({ label: 'Workspace' }, workspaceValue(workspaces['library-local']))
  assert.deepEqual(requestsOf(view, 'listDecisionPage').at(-1), { scope: { kind: 'workspace', workspace: workspaces['library-local'] }, includeHistory: false, timeZone: 'UTC' })
  assert.deepEqual(titles(view), ['Approve the reading room route', 'Approve the reading room reset window', 'Choose the catalogue layout'])
  assert.ok(view.find({ text: /Overdue 25h/ }), 'relative deadline from the injected clock')
  assert.equal(view.findAll({ text: 'Package · 2 shown' }).length, 2, 'package badge says "shown" while history is filtered')
}))

test('panel: bounded pages load more in server order without duplicates', () => withPanel(worker(decisions, {}, 4), async (view) => {
  await view.select({ label: 'Workspace' }, 'all')
  assert.deepEqual(titles(view), ALL_ORDER.slice(0, 4))
  assert.ok(view.find({ text: '4+ need you' }), 'count marked partial while more pages exist')
  await view.press({ text: 'Load more' })
  assert.deepEqual(requestsOf(view, 'listDecisionPage').at(-1), { scope: { kind: 'all' }, includeHistory: false, timeZone: 'UTC', cursor: 'c:4' })
  assert.deepEqual(titles(view), ALL_ORDER)
  assert.ok(!view.find({ text: 'Load more' }))
  assert.ok(view.find({ text: '6 need you' }))
}))

test('panel: one Workspace select names the focused workspace; equal names show the host; empty workspaces are offered', () => withPanel(worker(), async (view) => {
  await view.emit('workspace.changed', ctx('studio-local'))
  const sel = view.find({ label: 'Workspace' }) as unknown as { type: string; props: { options: { value: string; label: string }[] } }
  assert.equal(sel?.type, 'Select')
  assert.equal(view.valueOf({ label: 'Workspace' }), workspaceValue(studio))
  assert.deepEqual(sel.props.options.map((o) => o.label), ['All workspaces', 'studio · Local Orca', 'library', 'studio · paired', 'archive'])
  assert.ok(!sel.props.options.some((o) => /This workspace/.test(o.label)), 'no separate "This workspace" choice')
  await view.select({ label: 'Workspace' }, workspaceValue({ hostId: 'local', workspaceId: 'archive' }))
  assert.deepEqual(requestsOf(view, 'listDecisionPage').at(-1), { scope: { kind: 'workspace', workspace: { hostId: 'local', workspaceId: 'archive' } }, includeHistory: false, timeZone: 'UTC' })
  assert.ok(view.find({ label: 'Nothing needs you in archive' }), 'an empty workspace is a normal empty state')
  await view.select({ label: 'Workspace' }, workspaceValue({ hostId: 'paired', workspaceId: 'studio' }))
  assert.deepEqual(requestsOf(view, 'listDecisionPage').at(-1), { scope: { kind: 'workspace', workspace: { hostId: 'paired', workspaceId: 'studio' } }, includeHistory: false, timeZone: 'UTC' })
  assert.deepEqual(titles(view), ['Approve the first lantern trial'], 'paired studio, not local studio')
  await view.select({ label: 'Workspace' }, 'all')
  assert.equal(view.valueOf({ label: 'Workspace' }), 'all')
}))

test('panel: a late answer for the previous workspace never replaces the new one, and its cursor is not reused', () => {
  let release: (() => void) | null = null
  const base = worker(decisions, {}, 4)
  type Page = (x: PageInput) => Result<DecisionPage>
  const page = base.listDecisionPage as Page
  const slow: MockRequests = { ...base, listDecisionPage: (i: PageInput) => i.scope.kind === 'all' && !i.cursor && release === null
    ? new Promise<Result<DecisionPage>>((r) => { release = () => r(page(i)) }) : page(i) }
  return withPanel(slow, async (view) => {
    await view.emit('workspace.changed', ctx('studio-local'))
    // Never await an action while a request is held: start both, then release the slow one.
    const first = view.select({ label: 'Workspace' }, 'all'); await wait(20)
    const second = view.select({ label: 'Workspace' }, workspaceValue(workspaces['library-local'])); await wait(20)
    release!(); await Promise.all([first, second]); await wait(20)
    assert.deepEqual(titles(view), ['Approve the reading room route', 'Approve the reading room reset window', 'Choose the catalogue layout'])
    assert.ok(!view.find({ text: 'Load more' }), 'no cursor carried over from the all-workspaces page')
    assert.ok(requestsOf(view, 'listDecisionPage').every((i) => !(i as PageInput).cursor), 'no request reused another query\'s cursor')
  })
})

test('panel: ambiguous focus or a chosen workspace that disappears asks; it never widens to All workspaces', async () => {
  await withPanel(worker(), async (view) => {
    await view.emit('workspace.changed', ctx('nowhere'))
    assert.equal(requestsOf(view, 'listDecisionPage').length, 0, 'nothing listed without a workspace')
    assert.equal(view.valueOf({ label: 'Workspace' }), '')
    assert.ok(view.find({ label: 'Could not identify the focused workspace' }))
    assert.ok(!view.findAll({ type: 'ListItem' }).length)
  })
  let gone = false
  const w = worker()
  // Like the real worker, refusal and inventory come from the same authorized set: library leaves both.
  await withPanel({ ...w, 'workspace.options': () => withoutLibrary(w, gone),
    listDecisionPage: (i: PageInput): Result<DecisionPage> => (gone && i.scope.kind === 'workspace' ? { ok: false, code: 'forbidden', message: 'Not authorized for that workspace.' } : (w.listDecisionPage as (x: PageInput) => Result<DecisionPage>)(i)) }, async (view) => {
    await view.emit('workspace.changed', ctx('studio-local'))
    await view.select({ label: 'Workspace' }, workspaceValue(workspaces['library-local']))
    gone = true
    await view.type({ label: 'Search' }, 'route'); await wait(400)
    // The worker refuses the chosen workspace; a focus change (studio) must not replace the choice.
    await view.emit('workspace.changed', ctx('studio-local')); await wait(50)
    assert.ok(view.find({ label: 'library is no longer available' }), 'asks; focus does not override the explicit choice')
    assert.ok(requestsOf(view, 'listDecisionPage').every((i) => (i as PageInput).scope.kind === 'workspace'), 'never widened to All workspaces')
    assert.ok(!view.findAll({ type: 'ListItem' }).length, 'no rows from the refused workspace')
    await view.select({ label: 'Workspace' }, 'all')
    assert.deepEqual(requestsOf(view, 'listDecisionPage').at(-1), { scope: { kind: 'all' }, query: 'route', includeHistory: false, timeZone: 'UTC' })
    assert.ok(titles(view).includes('Approve the reading room route'), 'a deliberate choice recovers')
  })
})

test('panel: workspace lifecycle: addition on focus, removal after page one, stale inventory, ambiguous focus, pinned choice', async () => {
  const w = worker(decisions, {}, 1)
  const baseInv = (w['workspace.options'] as () => Result<WorkspaceOptions>)()
  const listed = (drop: string[] = [], extra: WorkspaceOptions['workspaces'] = []) =>
    baseInv.ok ? ok({ workspaces: [...baseInv.value.workspaces.filter((x) => !drop.includes(x.workspaceId)), ...extra] }) : baseInv
  let inventory: () => Result<WorkspaceOptions> | Promise<Result<WorkspaceOptions>> = () => listed()
  let gone = false
  let ambiguous = false
  const requests: MockRequests = { ...w,
    'workspace.options': () => inventory(),
    'workspace.resolve': ({ workspaceId }: { workspaceId: string }) => ambiguous
      ? { ok: false, code: 'unavailable', message: 'Multiple hosts report the focused workspace ID. Switch to All workspaces.' }
      : workspaceId === 'kiln-local' ? ok({ hostId: 'local', workspaceId: 'kiln' }) : (w['workspace.resolve'] as (i: { workspaceId: string }) => Result<Workspace>)({ workspaceId }),
    listDecisionPage: (i: PageInput): Result<DecisionPage> => gone && i.scope.kind === 'workspace' && i.scope.workspace.workspaceId === 'studio' && i.scope.workspace.hostId === 'local'
      ? { ok: false, code: 'forbidden', message: 'Inbox workspace is missing or inaccessible.' }
      : (w.listDecisionPage as (x: PageInput) => Result<DecisionPage>)(i)
  }
  await withPanel(requests, async (view) => {
    await view.emit('workspace.changed', ctx('studio-local')); await view.settled()
    // Addition on focus: Orca creates and focuses a workspace the panel's last inventory lacked.
    inventory = () => listed([], [{ hostId: 'local', workspaceId: 'kiln', name: 'kiln', hostLabel: 'Local Orca' }])
    const before = requestsOf(view, 'workspace.options').length
    await view.emit('workspace.created', { workspaceId: 'kiln-local', kind: 'worktree', path: '/w/kiln', branch: 'kiln' }); await view.settled()
    assert.ok(requestsOf(view, 'workspace.options').length > before, 'workspace.created re-reads the inventory')
    await view.emit('workspace.changed', ctx('kiln-local')); await view.settled()
    assert.equal(view.valueOf({ label: 'Workspace' }), workspaceValue({ hostId: 'local', workspaceId: 'kiln' }), 'the new focused workspace is selected')
    assert.ok(view.find({ label: 'Nothing needs you in kiln' }), 'listed, not reported missing')
    // Removal after page one.
    await view.emit('workspace.changed', ctx('studio-local')); await view.settled()
    assert.equal(titles(view).length, 1, 'page one (one row per page)')
    gone = true; inventory = () => listed(['studio'])
    const lp = requestsOf(view, 'listDecisionPage').length
    await view.press({ text: 'Load more' }); await wait(20); await view.settled()
    assert.ok(view.find({ label: 'studio is no longer available' }), 'asks after the refused second page')
    assert.equal(titles(view).length, 0, 'no rows from the removed workspace')
    assert.ok(requestsOf(view, 'listDecisionPage').slice(lp).every((i) => (i as PageInput).scope.kind === 'workspace'), 'never widened')
    // Stale inventory: an older read answering last does not bring studio back.
    let releaseOld: () => void = () => {}
    inventory = () => new Promise((r) => { releaseOld = () => r(listed()) })
    const slow = view.emit('workspace.removed', { workspaceId: 'x', kind: 'worktree', path: '/w/x' })
    await wait(5)
    inventory = () => listed(['studio'])
    const fresh = view.emit('workspace.removed', { workspaceId: 'y', kind: 'worktree', path: '/w/y' })
    await wait(20) // the newer read answers first
    releaseOld(); await Promise.all([slow, fresh]); await wait(20); await view.settled()
    assert.ok(view.find({ label: 'studio is no longer available' }), 'a late inventory answer is dropped')
    // Ambiguous focus: ask, list nothing.
    ambiguous = true
    const lq = requestsOf(view, 'listDecisionPage').length
    await view.emit('workspace.changed', ctx('twin')); await view.settled()
    assert.ok(view.find({ label: 'Could not identify the focused workspace' }))
    assert.equal(requestsOf(view, 'listDecisionPage').length, lq, 'nothing listed for ambiguous focus')
    // An explicit choice is pinned across focus changes.
    ambiguous = false
    await view.select({ label: 'Workspace' }, workspaceValue(workspaces['library-local'])); await view.settled()
    await view.emit('workspace.changed', ctx('kiln-local')); await view.settled()
    assert.equal(view.valueOf({ label: 'Workspace' }), workspaceValue(workspaces['library-local']))
    assert.deepEqual((requestsOf(view, 'listDecisionPage').at(-1) as PageInput).scope, { kind: 'workspace', workspace: { hostId: 'local', workspaceId: 'library' } })
  })
})

test('panel: choosing the workspace that focus already shows pins it', () => withPanel(worker(), async (view) => {
  await view.emit('workspace.changed', ctx('studio-local')); await view.settled()
  const before = requestsOf(view, 'listDecisionPage').length
  await view.select({ label: 'Workspace' }, workspaceValue(workspaces['studio-local'])); await view.settled()
  assert.equal(requestsOf(view, 'listDecisionPage').length, before, 'the same scope is not read again')
  await view.emit('workspace.changed', ctx('library-local')); await view.settled()
  assert.equal(view.valueOf({ label: 'Workspace' }), workspaceValue(workspaces['studio-local']), 'focus does not move a deliberate choice')
}))

test('panel: invalidations keep pages loaded with Load more and leave unchanged rows alone', () => withPanel(worker(decisions, {}, 4), async (view) => {
  await view.select({ label: 'Workspace' }, 'all')
  await view.press({ text: 'Load more' })
  assert.equal(titles(view).length, 6)
  const before = requestsOf(view, 'listDecisionPage').length
  // A burst of invalidations (draft saves while typing in a review) coalesces into one refresh.
  await view.post('inbox.changed', {}); await view.post('inbox.changed', {}); await view.post('inbox.changed', {})
  await wait(200); await view.settled()
  assert.deepEqual(titles(view), ALL_ORDER, 'still every loaded row, in order')
  assert.equal(requestsOf(view, 'listDecisionPage').length - before, 2, 'one refresh re-reading both loaded pages')
  assert.ok(!view.find({ text: 'Load more' }))
}))

test('panel: while searching, the count says it covers matches only', () => withPanel(worker(), async (view) => {
  await view.select({ label: 'Workspace' }, 'all')
  await view.type({ label: 'Search' }, 'reading room')
  await wait(300); await view.settled()
  assert.ok(view.find({ text: '2 matching need you' }))
}))

test('deadline: minutes past is overdue, not "Due in 0h"', () => {
  const stage = decisions.find((d) => d.questionId === 'stage')!
  assert.deepEqual(deadlineLabel({ ...stage, deadline: '2030-06-14T11:50:00Z' }, NOW), { text: 'Overdue under 1h', overdue: true })
  assert.deepEqual(deadlineLabel({ ...stage, deadline: '2030-06-14T12:10:00Z' }, NOW), { text: 'Due in under 1h', overdue: false })
  assert.deepEqual(deadlineLabel({ ...stage, deadline: '2030-06-13T11:00:00Z' }, NOW), { text: 'Overdue 25h', overdue: true })
  assert.deepEqual(deadlineLabel({ ...stage, deadline: '2030-06-16T12:00:00Z' }, NOW), { text: 'Due in 2d', overdue: false })
})

test('panel: search and history are sent to the worker; rows are not re-searched locally', () => withPanel(worker(decisions.map((d) => d.questionId === 'layout' ? historyExample : d)), async (view) => {
  await view.emit('workspace.changed', ctx('library-local'))
  await view.type({ label: 'Search' }, 'matte sample')
  await wait(300)
  await view.settled()
  assert.deepEqual(requestsOf(view, 'listDecisionPage').at(-1), { scope: { kind: 'workspace', workspace: workspaces['library-local'] }, query: 'matte sample', includeHistory: false, timeZone: 'UTC' })
  assert.ok(view.find({ label: 'No matches' }))
  await view.toggle({ label: 'Include history' })
  assert.equal((requestsOf(view, 'listDecisionPage').at(-1) as PageInput).includeHistory, true)
  assert.deepEqual(titles(view), ['Choose the catalogue layout'])
  assert.ok(view.find({ text: 'Agent received' }))
}))

test('panel: rows from the worker are trusted, not re-filtered by search text', () => withPanel(worker(decisions, {
  // A projected row has no searchable body text; the worker says it matched.
  listDecisionPage: () => ok({ rows: [{ ...decisions[0], background: '', recommendation: '', options: [] }] })
}), async (view) => {
  await view.select({ label: 'Workspace' }, 'all')
  await view.type({ label: 'Search' }, 'Tuesday')
  await wait(300)
  await view.settled()
  assert.deepEqual(titles(view), ['Pick a rehearsal slot'])
}))

test('panel: a failed follow-up keeps its question in the default queue', () => {
  const s = historyExample.answerState
  assert.ok(s.state === 'answered')
  if (s.state !== 'answered') return
  const failed: Decision = { ...historyExample, answerState: { ...s, followUps: [{ ...s.initial, replyId: 'layout-follow-1', kind: 'follow-up', answer: { kind: 'text', text: 'Check the list view.' }, delivery: { state: 'undelivered', reason: 'closed-origin' } }] } }
  return withPanel(worker(decisions.map((d) => d.questionId === 'layout' ? failed : d)), async (view) => {
    await view.emit('workspace.changed', ctx('library-local'))
    assert.ok(titles(view).includes('Choose the catalogue layout'), 'shown with history off')
    assert.ok(view.find({ text: 'Agent received' }), 'canonical initial state unchanged')
    assert.ok(view.find({ text: 'Follow-up delivery failed' }), 'the failed follow-up is flagged without claiming a count')
    assert.ok(view.find({ text: '3 need you' }))
  })
})

test('panel: a late workspace.resolve answer cannot override a newer focus', async () => {
  let release: () => void = () => {}
  const slow = new Promise<void>((r) => { release = r })
  await withPanel(worker(decisions, {
    'workspace.resolve': async ({ workspaceId }: { workspaceId: string }) => {
      if (workspaceId === 'studio-local') await slow
      return ok(workspaces[workspaceId])
    }
  }), async (view) => {
    // The harness settles outstanding requests inside each emit, so start both focus changes
    // before releasing the slow (earlier) resolve; the timer is a backstop, never a deadlock.
    const backstop = setTimeout(() => release(), 50)
    const first = view.emit('workspace.changed', ctx('studio-local'))
    const second = view.emit('workspace.changed', ctx('library-local'))
    await wait(5)
    release(); clearTimeout(backstop)
    await Promise.all([first, second]); await view.settled()
    const resolved = requestsOf(view, 'workspace.resolve')
    assert.deepEqual(resolved, [{ workspaceId: 'studio-local' }, { workspaceId: 'library-local' }], 'the earlier focus answered last')
    assert.deepEqual(titles(view), ['Approve the reading room route', 'Approve the reading room reset window', 'Choose the catalogue layout'])
  })
})

test('panel: no focused workspace or an unresolvable host shows a state, never a guessed scope', () => withPanel(worker(), async (view) => {
  await view.emit('workspace.changed', ctx(undefined))
  assert.ok(view.find({ label: 'No workspace is focused' }))
  await view.emit('workspace.changed', ctx('ambiguous'))
  assert.ok(view.find({ label: 'Could not identify the focused workspace' }))
  assert.equal(requestsOf(view, 'listDecisionPage').length, 0, 'nothing listed for an unresolved workspace')
  await view.press({ text: 'Show all workspaces' })
  assert.equal(titles(view).length, 6)
}))

test('panel: worker failures show truthfully, with no fixture fallback', async () => {
  await withPanel({ 'workspace.resolve': ok(studio), listDecisionPage: () => { throw hostError('unavailable', 'Worker stopped.') } }, async (view) => {
    await view.emit('workspace.changed', ctx('studio-local'))
    assert.ok(view.find({ text: /The Decision Inbox is unavailable\. Worker stopped\./ }))
    assert.equal(titles(view).length, 0, 'no rows without worker data')
  })
  await withPanel({ 'workspace.resolve': ok(studio), listDecisionPage: { ok: false, code: 'forbidden', message: 'Owner only.' } }, async (view) => {
    await view.emit('workspace.changed', ctx('studio-local'))
    assert.ok(view.find({ text: /You do not have access\. Owner only\./ }))
  })
  await withPanel({}, async (view) => {
    await view.select({ label: 'Workspace' }, 'all')
    assert.ok(view.find({ text: /does not provide “listDecisionPage”/ }), 'missing handler reported')
    assert.equal(titles(view).length, 0)
  })
})

test('panel: a failed refresh keeps and labels the last loaded list', async () => {
  let up = true
  const w = worker()
  const page = w.listDecisionPage as (i: PageInput) => Result<DecisionPage>
  await withPanel({ ...w, listDecisionPage: (i: PageInput): Result<DecisionPage> => up ? page(i) : { ok: false, code: 'unavailable', message: 'Disconnected.' } }, async (view) => {
    await view.select({ label: 'Workspace' }, 'all')
    up = false
    await view.post('inbox.changed', {})
    await wait(200); await view.settled()
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
    await wait(200); await view.settled() // invalidations coalesce for 150 ms
    assert.deepEqual(titles(view), ['Compare seven paper model views', 'Pick a rehearsal slot'])
  })
})

// ---- in-panel detail and settings (0.1.1 blocker: the wide editor tab may not open) --------------
const masked = { ok: false as const, code: 'unavailable' as const, message: 'Inbox storage or host integration is unavailable.' }
/** Draft and settings stores that behave like the worker (compare-and-set revisions). */
function stores() {
  const drafts = new Map<string, { draft: unknown; revision: number }>()
  let settings = { defaultTemplate: 'Ask with options.', exceptions: [] as { repo: string; template: string }[], revision: 1 }
  const saved: unknown[] = []
  return {
    saved, drafts,
    requests: {
      'draft.get': ({ questionId }: { questionId: string }) => ok(drafts.get(questionId) ?? { draft: null, revision: 0 }),
      'draft.save': ({ questionId, draft, revision }: { questionId: string; draft: unknown; revision: number }) => {
        const cur = drafts.get(questionId) ?? { draft: null, revision: 0 }
        if (revision !== cur.revision) return { ok: false, code: 'conflict', message: 'Stale draft revision.' }
        const next = { draft, revision: cur.revision + 1 }; drafts.set(questionId, next); saved.push({ questionId, draft }); return ok(next)
      },
      'settings.get': () => ok(structuredClone(settings)),
      'settings.repos': () => ok(['Paper Studio', 'Seed Catalogue']),
      'settings.save': (input: typeof settings) => {
        if (input.revision !== settings.revision) return { ok: false, code: 'conflict', message: 'Stale revision.' }
        settings = { ...structuredClone(input), revision: settings.revision + 1 }; return ok(structuredClone(settings))
      }
    } as MockRequests
  }
}

test('panel: a Bot Item card shows its details and options in the panel; a failed wide tab is reported as wide-only', async () => {
  const item7 = nativeRow({ id: 'bot-item:u7:e20:0', title: 'Item #7 question', status: 'needs_you', attributed: false,
    options: [{ optionId: 'a', label: 'Ship it' }, { optionId: 'b', label: 'Hold', detail: 'Wait for the next build' }], background: 'Release bot asks whether build 42 can ship.' })
  const item2 = nativeRow({ id: 'bot-item:u2:e20:0', title: 'Item #2 question', status: 'needs-you', attributed: false })
  await withPanel(worker([item2, item7], { 'review.open': masked }, 50, allAvailable), async (view) => {
    await view.select({ label: 'Workspace' }, 'all')
    await view.press({ label: 'Item #7 question' })
    assert.ok(view.find({ role: 'heading', text: 'Item #7 question' }), 'detail heading')
    assert.ok(view.find({ text: /^Answer in Orca's Bot Items/ }), 'native footer says where to answer')
    assert.ok(view.find({ text: 'Ship it' }) && view.find({ text: 'Hold — Wait for the next build' }), 'options visible in the panel footer')
    assert.ok(view.find({ text: /Release bot asks whether build 42 can ship\./ }))
    assert.equal(requestsOf(view, 'review.open').length, 0, 'no wide tab needed to read it')
    assert.ok(!view.summary().some((x) => /danger/.test(x)), 'no error for a readable item')
    await view.press({ text: 'Open wide review' })
    assert.ok(view.find({ label: 'The wide tab did not open' }))
    assert.ok(view.find({ text: /Inbox storage or host integration is unavailable\. Only the wide tab failed; the decision below is read from Decision Inbox and works here\./ }))
    assert.ok(view.find({ text: 'Ship it' }), 'details stay after the wide-tab failure')
    await view.press({ text: '← Back to list' })
    assert.deepEqual(titles(view), ['Item #2 question', 'Item #7 question'])
    assert.ok(!view.find({ label: 'The wide tab did not open' }), 'wide failure does not follow to the list')
  })
})

test('panel: every wide-tab failure mode stays wide-only (workspace missing or remote, refused, timeout, no file)', async () => {
  const no = (code: 'unavailable' | 'forbidden' | 'not-found', message: string) => ({ ok: false as const, code, message })
  const failures: (Result<null> | (() => never))[] = [
    no('unavailable', 'No focused local workspace for the review.'),
    no('unavailable', 'The focused workspace is on a remote host.'),
    no('unavailable', 'Could not open the wide tab (editor.open: not_opened).'),
    no('forbidden', 'editor.open: not_permitted.'),
    () => { throw hostError('timeout', 'Timed out.') },
    no('not-found', 'The review reference file was not created.')
  ]
  for (const failure of failures) {
    await withPanel(worker(decisions, { 'review.open': failure, 'settings.open': failure, ...stores().requests }), async (view) => {
      await view.emit('workspace.changed', ctx('studio-local'))
      await view.press({ label: 'Pick a rehearsal slot' })
      await view.press({ text: 'Open wide review' })
      assert.ok(view.find({ label: 'The wide tab did not open' }))
      assert.ok(view.find({ label: 'Reply text' }), 'the reply form still works in the panel')
      await view.press({ text: '← Back to list' })
      await view.press({ label: 'Inbox settings' })
      await view.press({ text: 'Open in a wide tab' })
      assert.ok(view.find({ label: 'The wide tab did not open' }))
      assert.ok(view.find({ label: 'Default question template' }), 'settings controls still work in the panel')
    })
  }
})

test('panel: a Chat decision is answered in the panel with a durable reply ID and its draft survives Back', async () => {
  const st = stores()
  await withPanel(worker(decisions, { ...st.requests, 'review.open': masked,
    submitReply: (input: SubmitReply) => ok({ ...input, acceptedAt: '2030-06-14T12:03:00Z', delivery: { state: 'undelivered' as const, reason: 'delivery-failed' as const } }) }), async (view) => {
    await view.emit('workspace.changed', ctx('studio-local'))
    await view.press({ label: 'Pick a rehearsal slot' })
    await view.select({ label: 'Options' }, 'tue')
    await view.type({ label: 'Reply text' }, 'after 3pm')
    await wait(450); await view.settled()
    assert.deepEqual(st.drafts.get('schedule')?.draft, { text: 'after 3pm', annotations: [], optionId: 'tue', kind: 'initial' }, 'draft saved with its option')
    await view.press({ text: '← Back to list' })
    await view.press({ label: 'Pick a rehearsal slot' })
    assert.equal(view.valueOf({ label: 'Reply text' }), 'after 3pm', 'draft restored after Back')
    assert.equal(view.valueOf({ label: 'Options' }), 'tue')
    await view.press({ text: 'Submit reply' })
    const sent = requestsOf(view, 'submitReply').at(-1) as { replyId: string; kind: string; answer: unknown }
    assert.match(sent.replyId, /^reply-/); assert.equal(sent.kind, 'initial')
    assert.deepEqual(sent.answer, { kind: 'option', optionId: 'tue', detail: 'after 3pm' })
    const saves = st.saved as { draft: { replyId?: string } | null }[]
    assert.ok(saves.some((x) => x.draft?.replyId === sent.replyId), 'reply ID saved before the attempt')
    assert.ok(view.find({ text: /saved in Decision Inbox, but not delivered|Saved in Decision Inbox, but not delivered to the original chat\. Orca could not hand it to that chat\. Retry is not available here/ }))
  })
})

test('panel: a note is added in the panel with the wide tab refused; exact words, repeated words and image anchors; nothing is sent', async () => {
  const st = stores()
  const base = decisions.find((d) => d.questionId === 'schedule')!
  const sched = { ...base, description: 'Rooms A and B. Rooms A has light.', evidence: [{ evidenceId: 'plan', version: 2, label: 'Floor plan', kind: 'image-snapshot' as const, attachmentId: 'att-plan', width: 10, height: 10, alt: 'plan' }] }
  await withPanel(worker(decisions.map((d) => d.questionId === 'schedule' ? sched : d), { ...st.requests, 'review.open': masked, submitReply: () => { throw new Error('nothing may be sent') } }), async (view) => {
    await view.emit('workspace.changed', ctx('studio-local'))
    await view.press({ label: 'Pick a rehearsal slot' })
    await view.press({ text: 'Open wide review' })
    assert.ok(view.find({ label: 'The wide tab did not open' }), 'the wide tab is refused')
    await view.press({ text: 'Add note' })
    await view.press({ text: 'Add note' })
    assert.ok(view.find({ text: 'Choose what the note is about.' }), 'no target: refused, composer kept')
    await view.select({ label: 'Note on' }, `description:0:${sched.description.length}`)
    await view.type({ label: 'Exact words (optional)' }, 'Rooms A')
    await view.select({ label: 'Which occurrence' }, '1')
    await view.type({ label: 'Note' }, 'the second one')
    await view.press({ text: 'Add note' }); await view.settled()
    const n1 = (st.drafts.get('schedule')?.draft as { annotations: Record<string, unknown>[] }).annotations[0]
    const at = sched.description.indexOf('Rooms A', 1)
    assert.deepEqual(n1, { kind: 'selection', anchor: { kind: 'question', field: 'description', revision: sched.revision }, start: at, end: at + 7, quote: 'Rooms A', text: 'the second one' }, 'raw description offsets of the chosen occurrence')
    assert.ok(!view.find({ label: 'Note on' }), 'the composer closes after saving')
    assert.ok(view.find({ text: /^Note saved\.$/ }))
    assert.ok(!view.find({ text: /^1\. Description/ }), 'saved notes stay collapsed behind Notes (n)')
    await view.press({ text: 'Add note' })
    await view.select({ label: 'Note on' }, 'image:plan:2')
    await view.type({ label: 'Note' }, 'north door')
    await view.press({ text: 'Add note' }); await view.settled()
    const notes = (st.drafts.get('schedule')?.draft as { annotations: Record<string, unknown>[] }).annotations
    assert.deepEqual(notes[1], { kind: 'image', evidence: { evidenceId: 'plan', version: 2 }, text: 'north door' })
    await view.press({ text: '← Back to list' })
    await view.press({ label: 'Pick a rehearsal slot' })
    assert.ok(view.find({ text: 'Notes (2)' }) && !view.find({ text: /^1\. Description/ }), 'collapsed with a count after reopening')
    await view.press({ text: 'Notes (2)' })
    assert.ok(view.find({ text: /^1\. Description: “Rooms A” — the second one$/ }) && view.find({ text: /^2\. Image: Floor plan · v2 — north door$/ }), 'notes are there after reopening')
    assert.equal(requestsOf(view, 'submitReply').length, 0, 'nothing was sent')
  })
})

test('panel: a stored initial draft that lost to another answer is kept, never sent or converted automatically', async () => {
  const st = stores()
  st.drafts.set('layout', { draft: { text: 'Grid, but larger labels', optionId: 'grid', kind: 'initial', annotations: [] }, revision: 3 })
  await withPanel(worker(decisions.map((d) => d.questionId === 'layout' ? historyExample : d), st.requests), async (view) => {
    await view.emit('workspace.changed', ctx('library-local'))
    await view.toggle({ label: 'Include history' })
    await view.press({ label: 'Choose the catalogue layout' })
    assert.ok(view.find({ label: 'Your unsent answer' }))
    assert.ok(view.find({ text: /Option: Grid — Grid, but larger labels/ }))
    assert.ok(!view.find({ label: 'Follow-up' }), 'no follow-up box until the owner chooses')
    assert.ok(view.find({ text: /Agent received · receipt layout-receipt/ }), 'recorded answer and receipt shown')
    await view.press({ text: 'Write a follow-up from this text' })
    assert.equal(view.valueOf({ label: 'Follow-up' }), 'Grid, but larger labels')
    assert.equal(requestsOf(view, 'submitReply').length, 0, 'nothing sent automatically')
    await wait(450); await view.settled()
    assert.deepEqual(st.drafts.get('layout')?.draft, { text: 'Grid, but larger labels', kind: 'follow-up', annotations: [] }, 'the follow-up draft is saved (no undefined fields)')
    assert.ok(!view.find({ label: 'Draft not saved' }))
  })
})

test('panel: leaving the panel never overwrites a newer draft from the wide tab; the panel edit stays recoverable', async () => {
  // Controlled interleaving: save #1 commits but its answer is held; meanwhile the wide tab saves a
  // newer draft; then Back flushes the queued panel edit. Old code re-read the latest revision for
  // that queued save and wrote over the wide tab's draft.
  const st = stores()
  const save = st.requests['draft.save'] as (i: { questionId: string; draft: unknown; revision: number }) => Result<{ draft: unknown; revision: number }>
  let releaseFirst: () => void = () => {}
  let held = true
  await withPanel(worker(decisions, { ...st.requests,
    'draft.save': (i: { questionId: string; draft: unknown; revision: number }): Promise<Result<DraftRecord>> | Result<DraftRecord> => {
      const r = save(i) as Result<DraftRecord> // commits now
      if (held && i.questionId === 'schedule') { held = false; return new Promise<Result<DraftRecord>>((res) => { releaseFirst = () => res(r) }) }
      return r
    }
  }), async (view) => {
    await view.emit('workspace.changed', ctx('studio-local'))
    await view.press({ label: 'Pick a rehearsal slot' })
    const t1 = view.type({ label: 'Reply text' }, 'A')
    await wait(450) // save #1 (revision 0 -> 1) committed, answer held
    const t2 = view.type({ label: 'Reply text' }, 'B') // panel edit "AB", not yet saved
    await wait(10)
    st.drafts.set('schedule', { draft: { text: 'Written in the wide tab', annotations: [], kind: 'initial' }, revision: 2 }) // wide tab saves rev 2
    const back = view.press({ text: '← Back to list' }) // flushes "AB" behind save #1
    await wait(10)
    const other = view.press({ label: 'Compare seven paper model views' })
    await wait(10)
    releaseFirst()
    await Promise.all([t1, t2, back, other]); await wait(50); await view.settled()
    assert.deepEqual(st.drafts.get('schedule')?.draft, { text: 'Written in the wide tab', annotations: [], kind: 'initial' }, 'the newer wide-tab draft is intact')
    assert.equal(st.drafts.get('schedule')?.revision, 2)
    // Back on the question: the saved draft is shown and the panel edit can be recovered.
    await view.press({ text: '← Back to list' })
    await view.press({ label: 'Pick a rehearsal slot' })
    assert.equal(view.valueOf({ label: 'Reply text' }), 'Written in the wide tab')
    assert.ok(view.find({ label: 'A panel edit was not saved' }))
    assert.ok(view.find({ text: /Your edit: “AB”/ }))
    await view.press({ text: 'Use my panel edit' })
    assert.equal(view.valueOf({ label: 'Reply text' }), 'AB')
    await wait(450); await view.settled()
    assert.deepEqual((st.drafts.get('schedule')?.draft as { text: string }).text, 'AB', 'restored edit saved against the revision it was shown')
    assert.equal(st.drafts.get('schedule')?.revision, 3)
  })
})

test('panel: a reply saved while no mail sender exists says awaiting delivery; a real failure stays distinct', async () => {
  const s0 = historyExample.answerState
  assert.ok(s0.state === 'answered')
  if (s0.state !== 'answered') return
  const failedOnce = { ...s0.initial, delivery: { state: 'undelivered' as const, reason: 'delivery-failed' as const } }
  const saved: Decision = { ...historyExample, actions: ['follow-up'], answerState: { ...s0, initial: failedOnce } }
  const closed: Decision = { ...historyExample, questionId: 'layout-closed', title: 'Closed chat layout', actions: ['follow-up'],
    answerState: { ...s0, initial: { ...failedOnce, delivery: { state: 'undelivered', reason: 'closed-origin' } } } }
  const list = decisions.map((d) => (d.questionId === 'layout' ? saved : d)).concat(closed)
  // No sender on this host: never attempted.
  await withPanel(worker(list, stores().requests, 50, allAvailable, mailOff), async (view) => {
    await view.emit('workspace.changed', ctx('library-local'))
    await view.press({ label: 'Choose the catalogue layout' })
    assert.ok(view.find({ text: 'Saved · awaiting delivery' }), 'card badge matches the list')
    assert.ok(view.find({ text: /Saved in Decision Inbox and awaiting delivery\. Orca mail from this plugin is unavailable on this host, so it has not been sent to the original chat yet\./ }))
    assert.ok(!view.find({ text: /could not hand it/ }), 'does not imply a hand-off was attempted')
    await view.press({ text: '← Back to list' })
    await view.press({ label: 'Closed chat layout' })
    assert.ok(view.find({ text: 'Undelivered' }), 'a real failure keeps Undelivered')
    assert.ok(view.find({ text: /not delivered to the original chat\. The original chat is closed\./ }))
  })
  // A sender exists and the hand-off failed: real failure wording.
  await withPanel(worker(list, stores().requests, 50, allAvailable, { state: 'available' }), async (view) => {
    await view.emit('workspace.changed', ctx('library-local'))
    assert.ok(!view.find({ text: 'Saved · awaiting delivery' }))
    await view.press({ label: 'Choose the catalogue layout' })
    assert.ok(view.find({ text: /Saved in Decision Inbox, but not delivered to the original chat\. Orca could not hand it to that chat\./ }))
  })
})

test('panel: settings are read and saved in the panel when the wide tab cannot open', async () => {
  const st = stores()
  await withPanel(worker(decisions, { ...st.requests, 'settings.open': masked }), async (view) => {
    await view.press({ label: 'Inbox settings' })
    assert.equal(view.valueOf({ label: 'Default question template' }), 'Ask with options.')
    await view.type({ label: 'Default question template' }, 'Ask with two options.', { replace: true })
    assert.ok(view.find({ text: 'Unsaved changes' }))
    await view.press({ text: 'Add exception' })
    await view.press({ text: 'Save' })
    assert.ok(view.find({ label: 'Saved' }))
    assert.equal((requestsOf(view, 'settings.save').at(-1) as { revision: number }).revision, 1, 'saved against the revision it read')
    assert.ok(view.find({ label: 'Template for Paper Studio' }), 'exception controls')
    assert.equal(requestsOf(view, 'settings.open').length, 0, 'no wide tab needed')
  })
})

test('panel: stale answers from an earlier click never land on the current view', async () => {
  const item7 = nativeRow({ id: 'bot-item:u7:e20:0', title: 'Item #7 question', attributed: false })
  const item2 = nativeRow({ id: 'bot-item:u2:e20:0', title: 'Item #2 question', attributed: false })
  let release7: () => void = () => {}
  let releaseSettings: () => void = () => {}
  await withPanel(worker([item2, item7], {
    getDecision: ({ questionId }: { questionId: string }) => questionId === item7.questionId
      ? new Promise((r) => { release7 = () => r(ok(item7)) }) : ok(item2),
    'settings.get': () => new Promise((r) => { releaseSettings = () => r(masked) }),
    'settings.repos': ok([])
  }, 50, allAvailable), async (view) => {
    await view.select({ label: 'Workspace' }, 'all')
    const p7 = view.press({ label: 'Item #7 question' }) // slow
    await wait(10)
    const pBack = view.press({ text: '← Back to list' })
    await wait(10)
    const p2 = view.press({ label: 'Item #2 question' })
    await wait(10)
    release7()
    await Promise.all([p7, pBack, p2]); await view.settled()
    assert.ok(view.find({ role: 'heading', text: 'Item #2 question' }), 'the active card stays #2')
    assert.ok(!view.find({ role: 'heading', text: 'Item #7 question' }))
    // A settings read that fails late must not show on a card.
    const pBack2 = view.press({ text: '← Back to list' })
    await wait(10)
    const pGear = view.press({ label: 'Inbox settings' })
    await wait(10)
    const pBack3 = view.press({ text: '← Back to list' })
    await wait(10)
    const pCard = view.press({ label: 'Item #2 question' })
    await wait(10)
    releaseSettings()
    await Promise.all([pBack2, pGear, pBack3, pCard]); await view.settled()
    assert.ok(view.find({ role: 'heading', text: 'Item #2 question' }))
    assert.ok(!view.find({ label: 'Could not read Inbox settings' }), 'no settings error on a card')
  })
})

test('panel: a late settings failure from an earlier open never replaces the settings now shown', async () => {
  const st = stores()
  let calls = 0
  let releaseFirst: () => void = () => {}
  await withPanel(worker(decisions, { ...st.requests,
    'settings.get': (): Result<InboxSettings> | Promise<Result<InboxSettings>> => (++calls === 1
      ? new Promise<Result<InboxSettings>>((r) => { releaseFirst = () => r(masked) })
      : (st.requests['settings.get'] as () => Result<InboxSettings>)())
  }), async (view) => {
    const g1 = view.press({ label: 'Inbox settings' }) // first open: slow, will fail
    await wait(10)
    const b = view.press({ text: '← Back to list' })
    await wait(10)
    const g2 = view.press({ label: 'Inbox settings' }) // second open: answers at once
    await wait(10)
    releaseFirst()
    await Promise.all([g1, b, g2]); await view.settled()
    assert.ok(view.find({ label: 'Default question template' }), 'settings from the current open stay')
    assert.ok(!view.find({ label: 'Could not read Inbox settings' }), 'the stale failure is ignored')
  })
})

test('panel: a failed read is truthful and Try again recovers; not-found and forbidden are named', async () => {
  let fails = 1
  const item7 = nativeRow({ id: 'bot-item:u7:e20:0', title: 'Item #7 question', attributed: false })
  await withPanel(worker([item7], { getDecision: () => fails-- > 0 ? masked : ok(item7) }, 50, allAvailable), async (view) => {
    await view.select({ label: 'Workspace' }, 'all')
    await view.press({ label: 'Item #7 question' })
    assert.ok(view.find({ label: 'Could not read this decision' }), 'a read failure is a read failure, not a wide-tab one')
    await view.press({ text: 'Try again' })
    assert.ok(view.find({ text: /^Answer in Orca's Bot Items/ }))
  })
  for (const [code, title] of [['not-found', 'Decision not found'], ['forbidden', 'No access to this decision']] as const) {
    await withPanel(worker([item7], { getDecision: { ok: false, code, message: 'Decision is missing or inaccessible.' } }, 50, allAvailable), async (view) => {
      await view.select({ label: 'Workspace' }, 'all')
      await view.press({ label: 'Item #7 question' })
      assert.ok(view.find({ label: title }))
      assert.ok(!view.find({ text: 'Try again' }))
    })
  }
})

test('panel: unavailable mail is said once, at the reply, not as a list banner', () => withPanel(worker(decisions, {}, 50, allAvailable,
  { state: 'unavailable', message: 'Answers are saved in Decision Inbox. Orca mail from this plugin is unavailable on this host.' }), async (view) => {
  await view.emit('workspace.changed', ctx('studio-local'))
  assert.ok(!view.find({ text: /Orca mail from this plugin is unavailable/ }), 'no mail banner over the list')
  await view.press({ label: 'Pick a rehearsal slot' }); await view.settled()
  const n = view.findAll({ text: /Orca mail from this plugin is unavailable here, so the original chat is not notified/ })
  assert.equal(n.length, 1, 'one statement at the point of reply')
}))


// ---- sources: native Bot Items (read-only) and plugin-owned Chat decisions -------------------------
// Test-only native rows built from the shared fixtures, using the documented source fields.
const nativeRow = (over: Partial<Decision> & { status?: string; attributed?: boolean; id: string; title: string }): Decision => {
  const { status = 'needs-you', attributed = true, id, title, ...rest } = over
  return {
    ...decisions.find((d) => d.questionId === 'schedule')!, questionId: id, title, packageId: `native-${id}`,
    ...(attributed ? {} : { origin: { hostId: 'local', workspaceId: '', sessionId: '' }, projectName: '', workspaceName: '' }),
    source: { kind: 'native-item', workspaceAttributed: attributed, botName: 'Release bot', itemLabel: '#12', itemStatus: status, observedAt: '2030-06-14T11:30:00Z' },
    actions: [], ...rest
  }
}
const nativeHere = nativeRow({ id: 'native-here', title: 'Ship the lantern build?' })
const nativeNowhere = nativeRow({ id: 'native-nowhere', title: 'Rotate the signing key?', attributed: false })
const nativeDone = nativeRow({ id: 'native-done', title: 'Archive old builds?', status: 'done' })
const mixed = [...decisions, nativeHere, nativeNowhere, nativeDone]
const allAvailable: SourceAvailability[] = [{ source: 'plugin', state: 'available' }, { source: 'native-item', state: 'available' }]

test('model: native items are actionable only while Orca reports needs-you, and offer no actions', () => {
  assert.equal(isActionable(nativeHere), true)
  assert.equal(isActionable(nativeDone), false)
  assert.deepEqual(actionsOf(nativeHere), [])
  assert.deepEqual(actionsOf(decisions[0]), ['reply'], 'legacy plugin row without actions gets plugin defaults')
  assert.equal(nativeStatusLabel('in-progress'), 'In progress')
  assert.equal(nativeStatusLabel('blocked-on-ci'), 'blocked-on-ci', 'unrecognized status shown as reported')
  assert.equal(nativeStatusLabel(undefined), 'Status not reported')
  assert.deepEqual(ids(visible([nativeNowhere], { ...base, scope: 'workspace' })), [], 'no workspace attribution: never in a workspace scope')
  assert.deepEqual(ids(visible([nativeNowhere], base)), ['native-nowhere'])
})

test('panel: one queue labels each source; unattributed Bot Items appear only in All workspaces', () => withPanel(worker(mixed, {}, 50, allAvailable), async (view) => {
  await view.emit('workspace.changed', ctx('studio-local'))
  assert.deepEqual(titles(view), ['Compare seven paper model views', 'Ship the lantern build?', 'Pick a rehearsal slot'])
  assert.ok(view.find({ text: 'Bot Item · answer in Orca' }), 'native row says where it is answered')
  assert.ok(view.findAll({ text: 'Chat decision' }).length === 2, 'plugin rows labelled')
  assert.ok(view.find({ text: 'Needs you' }), 'native status from Orca')
  assert.ok(!titles(view).includes('Rotate the signing key?'), 'unattributed item not in This workspace')
  assert.ok(view.find({ text: '3 need you' }))
  await view.select({ label: 'Workspace' }, 'all')
  assert.ok(titles(view).includes('Rotate the signing key?'))
  assert.ok(view.find({ label: 'Rotate the signing key?' })?.props.description === 'Release bot · item #12 · No workspace attribution')
  assert.ok(!titles(view).includes('Archive old builds?'), 'done native item is history')
  assert.ok(!view.find({ label: /are unavailable|could not be read/ }), 'no notice when both sources are available')
}))

test('panel: Bot Items unavailable keeps Chat decisions and says what still works', () => withPanel(worker(decisions, {}, 50,
  [{ source: 'plugin', state: 'available' }, { source: 'native-item', state: 'unavailable', message: 'No authorized Bot Items reader on this host.' }]), async (view) => {
  await view.emit('workspace.changed', ctx('studio-local'))
  assert.deepEqual(titles(view), ['Compare seven paper model views', 'Pick a rehearsal slot'], 'Chat decisions are not blanked')
  assert.ok(view.find({ label: 'Needs attention: Bot Items could not be read' }), 'a failed read is named in the collapsed title')
  assert.ok(view.find({ text: /No authorized Bot Items reader on this host\. Bot Items may be missing here; check them in Orca\./ }))
  assert.ok(!view.find({ text: /Chat decisions (could not|cannot)/ }), 'the readable source is not blamed')
}))

test('panel: Chat decisions unavailable still shows read-only Bot Items', () => withPanel(worker([nativeHere], {}, 50,
  [{ source: 'plugin', state: 'unavailable', message: 'Authenticated owner access is unavailable on this Orca host.' }, { source: 'native-item', state: 'available' }]), async (view) => {
  await view.emit('workspace.changed', ctx('studio-local'))
  assert.deepEqual(titles(view), ['Ship the lantern build?'])
  assert.ok(view.find({ label: 'Needs attention: Chat decisions could not be read' }))
  assert.ok(view.find({ text: /New Chat decisions may be missing\. Decisions already shown, your drafts and saved answers still work\./ }), 'local saving stays independent of reads')
  assert.ok(!view.find({ text: /cannot be listed or answered/ }))
}))

test('panel: partial Bot Items and an empty list say only what could be checked', () => withPanel(worker([], {}, 50,
  [{ source: 'plugin', state: 'available' }, { source: 'native-item', state: 'partial', message: 'One bot could not be read.' }]), async (view) => {
  await view.select({ label: 'Workspace' }, 'all')
  assert.ok(view.find({ label: 'Needs attention: Some Bot Items not read' }))
  assert.ok(view.find({ label: 'Nothing found in all workspaces from the sources that could be read' }), 'no "all caught up" claim')
  assert.ok(!view.find({ label: /^Nothing needs you/ }), 'no "nothing needs you" title while a source is degraded')
}))

// ---- read coverage vs mail delivery; native status normalization; failed-reply queue -------------
const mailOff = { state: 'unavailable' as const, message: 'No supported plugin mail sender on Orca 1.4.271.' }

test('panel: all Chat decisions read but mail unavailable: a neutral saved-not-delivered notice, no read warning', () =>
  withPanel(worker(decisions, {}, 50, allAvailable, mailOff), async (view) => {
    await view.emit('workspace.changed', ctx('studio-local'))
    assert.deepEqual(titles(view), ['Compare seven paper model views', 'Pick a rehearsal slot'])
    assert.ok(!view.find({ label: /^Sources:|^Needs attention:/ }), 'no source status when every source was read; mail is not a read failure')
    await view.press({ label: 'Pick a rehearsal slot' }); await view.settled()
    assert.ok(view.find({ text: 'Saved in Decision Inbox only: Orca mail from this plugin is unavailable here, so the original chat is not notified.' }))
    assert.ok(!view.find({ text: /cannot be (listed or )?answered/ }), 'never claims loaded Chat decisions cannot be answered')
  }))

test('panel: mail unavailable does not make an empty list look degraded', () => withPanel(worker([], {}, 50, allAvailable, mailOff), async (view) => {
  await view.select({ label: 'Workspace' }, 'all')
  assert.ok(view.find({ label: 'Nothing needs you in all workspaces' }))
  assert.ok(!view.summary().some((line) => /sources that could be read/.test(line)), 'not shown as degraded')
}))

test('panel: genuinely partial Chat intake says some were not read and the shown ones can be answered', () =>
  withPanel(worker(decisions, {}, 50, [{ source: 'plugin', state: 'partial', message: 'Two Chat decisions are waiting for intake checks.' }, { source: 'native-item', state: 'available' }]), async (view) => {
    await view.emit('workspace.changed', ctx('studio-local'))
    assert.ok(view.find({ label: 'Needs attention: Some Chat decisions not read' }), 'an untyped partial report from an older worker is still flagged')
    assert.ok(view.find({ text: /Two Chat decisions are waiting for intake checks\./ }))
    assert.equal(titles(view).length, 2)
  }))

test('model: native statuses are normalized (needs_you, in_progress, Needs You)', () => {
  const n = (st: string) => nativeRow({ id: `n-${st}`, title: st, status: st })
  assert.equal(isActionable(n('needs_you')), true)
  assert.equal(isActionable(n('Needs You')), true)
  assert.equal(isActionable(n('in_progress')), false)
  assert.equal(nativeStatusLabel('needs_you'), 'Needs you')
  assert.equal(nativeStatusLabel('in_progress'), 'In progress')
})

test('panel: a needs_you Bot Item without workspace is visible by default in All workspaces and opens its review', async () => {
  const item = nativeRow({ id: 'bot-item:native-uid:e42:0', title: 'Approve release notes?', status: 'needs_you', attributed: false })
  const progress = nativeRow({ id: 'bot-item:native-uid:e43:0', title: 'Tag the release?', status: 'in_progress', attributed: false })
  await withPanel(worker([...decisions, item, progress], {}, 50, allAvailable), async (view) => {
    await view.select({ label: 'Workspace' }, 'all')
    assert.ok(titles(view).includes('Approve release notes?'), 'visible with history off')
    assert.ok(!titles(view).includes('Tag the release?'), 'in_progress is history')
    assert.ok(view.find({ text: 'Needs you' }))
    await view.press({ label: 'Approve release notes?' })
    assert.deepEqual(requestsOf(view, 'getDecision').at(-1), { questionId: 'bot-item:native-uid:e42:0' })
    assert.ok(view.find({ role: 'heading', text: 'Approve release notes?' }), 'opens in the panel')
    await view.press({ text: 'Open wide review' })
    assert.deepEqual(requestsOf(view, 'review.open').at(-1), { questionId: 'bot-item:native-uid:e42:0' })
    assert.ok(view.find({ text: 'Opened in a wide tab.' }))
    await view.press({ text: '← Back to list' })
    assert.equal(view.find({ label: 'Approve release notes?' })?.props.current, true)
  })
})

test('panel: a saved-but-undelivered answer stays in the default queue (owner-approved) and says it was saved', () => {
  const s = historyExample.answerState
  assert.ok(s.state === 'answered')
  if (s.state !== 'answered') return
  const saved: Decision = { ...historyExample, actions: ['follow-up'], answerState: { ...s, initial: { ...s.initial, delivery: { state: 'undelivered', reason: 'delivery-failed' } } } }
  const retryable: Decision = { ...saved, questionId: 'layout-2', title: 'Retryable layout', actions: ['follow-up', 'retry'] }
  return withPanel(worker(decisions.map((d) => (d.questionId === 'layout' ? saved : d)).concat(retryable), {}, 50, allAvailable, mailOff), async (view) => {
    await view.emit('workspace.changed', ctx('library-local'))
    assert.ok(titles(view).includes('Choose the catalogue layout'), 'still needs you with history off')
    assert.ok(view.find({ text: 'Saved · awaiting delivery' }), 'no sender, no retry: saved and awaiting delivery')
    assert.ok(view.find({ text: 'Undelivered' }), 'retry offered: plain Undelivered')
  })
})

// ---- readable reader: Markdown, single options, disclosure, paging, bottom reply area --------------
const md = '確認發佈流程。**請決定是否發佈第 42 版。** 參考 [執行紀錄](https://example.invalid/run/42)。\n\n- 測試全部通過\n- 文件已更新'
const nativeQ = (i: number, size: number | null, more = {}) => nativeRow({ id: `bot-item:u9:e20:${i}`, title: `第 ${i + 1} 題：是否發佈？`, attributed: false, packageId: 'bot-item:u9',
  background: md, recommendation: '發佈', options: [{ optionId: '0', label: '發佈' }, { optionId: '1', label: '暫緩', detail: '等下一版' }],
  context: 'Release bot: 第 42 版發佈', activity: [{ label: 'Original ask', at: '2030-06-14T11:00:00Z', text: '問題：是否發佈？\n選項：\n1. 發佈\n2. 暫緩' }],
  ...(size === undefined ? {} : { package: { index: i, size } }), ...more } as Partial<Decision> & { id: string; title: string })
/** Every Text node's string in the drawn tree (what reads as plain text, not Markdown). */
const plainTexts = (view: TestPanel) => {
  const out: string[] = []
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return
    const t = n as { type?: string; children?: unknown[] }
    if (t.type === 'Text') out.push((t.children ?? []).filter((c) => typeof c === 'string').join(''))
    for (const c of t.children ?? []) walk(c)
  }
  walk(view.tree()); return out
}

test('reader: a native Item reads as question, Markdown sections and one set of options, with details on demand', async () => {
  await withPanel(worker([nativeQ(0, 1)], {}, 50, allAvailable), async (view) => {
    await view.select({ label: 'Workspace' }, 'all')
    await view.press({ label: '第 1 題：是否發佈？' })
    assert.ok(view.find({ role: 'heading', text: '第 1 題：是否發佈？' }), 'the active question is the heading')
    assert.ok(view.find({ text: 'Release bot: 第 42 版發佈' }), 'item context above it')
    const markdown = view.findAll({ type: 'Markdown' }).map((m) => m.props.content)
    assert.ok(markdown.includes(md), 'background goes to the sanitized Markdown renderer, bold, links and lists intact')
    assert.ok(!plainTexts(view).some((t) => /\*\*|\]\(https?:/.test(t)), 'no literal Markdown in plain text')
    assert.equal(view.findAll({ text: '暫緩 — 等下一版' }).length, 1, 'options shown once (footer)')
    assert.ok(!view.findAll({ type: 'Markdown' }).some((m) => /選項：/.test(String(m.props.content))), 'the original ask is not drawn until opened')
    assert.ok(!view.find({ label: 'Status in Orca' }), 'secondary metadata starts collapsed')
    await view.toggle({ label: 'Details' })
    assert.ok(view.find({ type: 'KeyValue' }), 'details on demand')
    await view.toggle({ label: 'Original activity' })
    assert.ok(view.findAll({ type: 'Markdown' }).some((m) => /選項：/.test(String(m.props.content))), 'original activity verbatim on demand')
    assert.ok(view.find({ text: 'Question 1 / 1' }))
    assert.ok(!view.find({ text: 'Submit reply' }) && !view.find({ label: 'Reply text' }), 'no fake reply actions on a native Item')
  })
})

test('reader: bare URLs reach Orca\'s Markdown as <url> autolinks with CJK-safe boundaries', async () => {
  const item = nativeQ(0, 1, { background: '見 https://example.invalid/run/42。下一句，與 [維基](https://en.wikipedia.org/wiki/A_(b))。' })
  await withPanel(worker([item], {}, 50, allAvailable), async (view) => {
    await view.select({ label: 'Workspace' }, 'all')
    await view.press({ label: '第 1 題：是否發佈？' })
    const contents = view.findAll({ type: 'Markdown' }).map((m) => String(m.props.content))
    assert.ok(contents.includes('見 <https://example.invalid/run/42>。下一句，與 [維基](https://en.wikipedia.org/wiki/A_(b))。'), contents.join(' | '))
  })
  const d1 = nativeQ(0, 1, { background: 'see [https://example.invalid/x] here, [https://ok.invalid](javascript:alert(1)) and http://[::1]:8080/a.' })
  await withPanel(worker([d1], {}, 50, allAvailable), async (view) => {
    await view.select({ label: 'Workspace' }, 'all')
    await view.press({ label: '第 1 題：是否發佈？' })
    const contents = view.findAll({ type: 'Markdown' }).map((m) => String(m.props.content))
    assert.ok(contents.includes('see [<https://example.invalid/x>] here, `https://ok.invalid (javascript:alert(1))` and <http://[::1]:8080/a>.'), contents.join(' | '))
  })
})

test('reader: the reply area is the last, non-scrolling block; the question scrolls above it', async () => {
  const long = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 段：這是一段很長的中文背景說明，用來確認回覆區不會被推到看不見的位置。`).join('\n\n')
  const d = { ...decisions.find((x) => x.questionId === 'schedule')!, background: long }
  await withPanel(worker(decisions.map((x) => (x.questionId === 'schedule' ? d : x)), stores().requests), async (view) => {
    await view.emit('workspace.changed', ctx('studio-local'))
    await view.press({ label: 'Pick a rehearsal slot' })
    const root = view.tree() as { type: string; props: Record<string, unknown>; children: { type: string; props: Record<string, unknown>; children: unknown[] }[] }
    assert.equal(root.type, 'Box'); assert.equal(root.props.height, '100%')
    const [head, body, foot] = root.children
    assert.equal(head.props.shrink, false); assert.equal(body.props.scroll, 'y'); assert.equal(body.props.grow, true)
    assert.equal(foot.props.shrink, false, 'reply area keeps its size')
    const inFoot = JSON.stringify(foot)
    assert.ok(inFoot.includes('"Reply text"') && inFoot.includes('Submit reply') && inFoot.includes('"Options"'), 'composer and options live in the bottom area')
    assert.ok(!JSON.stringify(body).includes('"Reply text"'), 'not inside the scrolling question')
    assert.ok(JSON.stringify(body).includes('第 40 段'), 'the long question is in the scroll area')
  })
})

test('reader: Question i / N pages within the package, keeps each draft, and shows unknown totals', async () => {
  const st = stores()
  const base = decisions.find((x) => x.questionId === 'schedule')!
  const q = (i: number) => ({ ...base, questionId: `pkg-q${i}`, title: `Package question ${i + 1}`, packageId: 'pkg-1', createdAt: `2030-06-1${i}T09:00:00Z`, options: [] })
  await withPanel(worker([q(0), q(1), q(2)], st.requests), async (view) => {
    await view.emit('workspace.changed', ctx('studio-local'))
    await view.press({ label: 'Package question 1' })
    assert.ok(view.find({ text: 'Question 1 / 3' }))
    assert.equal(view.find({ text: '‹ Previous' })?.disabled, true)
    await view.type({ label: 'Reply text' }, 'first answer')
    await view.press({ text: 'Next ›' })
    assert.ok(view.find({ role: 'heading', text: 'Package question 2' })); assert.ok(view.find({ text: 'Question 2 / 3' }))
    assert.equal(view.valueOf({ label: 'Reply text' }), '', 'each question has its own draft')
    await view.type({ label: 'Reply text' }, 'second answer')
    await view.press({ text: '‹ Previous' })
    assert.equal(view.valueOf({ label: 'Reply text' }), 'first answer', 'paging back keeps the first draft')
    await view.press({ text: 'Next ›' })
    assert.equal(view.valueOf({ label: 'Reply text' }), 'second answer')
    assert.equal((st.drafts.get('pkg-q0')?.draft as { text: string }).text, 'first answer')
    assert.equal((st.drafts.get('pkg-q1')?.draft as { text: string }).text, 'second answer')
  })
  // Unknown total: the package page has more.
  await withPanel(worker([nativeQ(0, undefined as unknown as null), nativeQ(1, undefined as unknown as null)], {}, 1, allAvailable), async (view) => {
    await view.select({ label: 'Workspace' }, 'all')
    await view.press({ label: '第 1 題：是否發佈？' })
    assert.ok(view.find({ text: /^Question 1 \/ \d\+$/ }), 'unknown total marked with +')
  })
  // Declared size from the worker wins: 2 of 5.
  await withPanel(worker([nativeQ(1, 5)], {}, 50, allAvailable), async (view) => {
    await view.select({ label: 'Workspace' }, 'all')
    await view.press({ label: '第 2 題：是否發佈？' })
    assert.ok(view.find({ text: 'Question 2 / 5' }))
  })
})

test('reader: a seven-image Chat decision names its evidence and keeps the reply area usable', async () => {
  await withPanel(worker(decisions, stores().requests), async (view) => {
    await view.emit('workspace.changed', ctx('studio-local'))
    await view.press({ label: 'Compare seven paper model views' })
    assert.ok(view.find({ text: /^7 evidence items \(Front wide, Front portrait, .*Tall detail\): open the wide review to view them\.$/ }))
    assert.ok(view.find({ label: 'Reply text' }) && view.find({ text: 'Submit reply' }))
  })
})

// ---- N1: refresh racing Load more (deterministic orderings) -----------------------------------------
/** A paged worker whose next matching request is held until `release()`. */
function heldWorker(size = 4) {
  const w = worker(decisions, {}, size)
  const page = w.listDecisionPage as (i: PageInput) => Result<DecisionPage>
  let hold: ((i: PageInput) => boolean) | null = null
  let release: () => void = () => {}
  const requests: MockRequests = { ...w, listDecisionPage: (i: PageInput) => {
    if (hold && hold(i)) { hold = null; return new Promise<Result<DecisionPage>>((r) => { release = () => r(page(i)) }) }
    return page(i)
  } }
  return { requests, holdNext: (f: (i: PageInput) => boolean) => { hold = f }, release: () => release() }
}

test('panel: a refresh during Load more keeps the requested page and clears the loading state', async () => {
  const h = heldWorker(2) // three pages, so Load more stays available afterwards
  await withPanel(h.requests, async (view) => {
    await view.select({ label: 'Workspace' }, 'all')
    h.holdNext((i) => !!i.cursor)
    const more = view.press({ text: 'Load more' }) // in flight, held
    await wait(10)
    const inval = view.post('inbox.changed', {})
    await wait(250) // the refresh runs and reads page 1 plus the page Load more asked for
    h.release() // the superseded Load more answers last
    await Promise.all([more, inval]); await view.settled()
    assert.deepEqual(titles(view), ALL_ORDER.slice(0, 4), 'the requested page is not lost')
    assert.ok(!view.find({ text: 'Loading more…' }), 'loading state cleared')
    const btn = view.find({ text: 'Load more' })
    assert.ok(btn && !btn.disabled, 'Load more is usable again')
    await view.press({ text: 'Load more' })
    assert.deepEqual(titles(view), ALL_ORDER)
  })
})

test('panel: Load more during a refresh wins, then the refresh re-runs', async () => {
  const h = heldWorker()
  await withPanel(h.requests, async (view) => {
    await view.select({ label: 'Workspace' }, 'all')
    h.holdNext((i) => !i.cursor) // the refresh's first page is held
    const inval = view.post('inbox.changed', {})
    await wait(200)
    const more = view.press({ text: 'Load more' })
    await wait(10)
    h.release() // the superseded refresh answers last and must not overwrite
    await Promise.all([inval, more]); await wait(250); await view.settled()
    assert.deepEqual(titles(view), ALL_ORDER)
    assert.ok(!view.find({ text: 'Loading more…' }))
    const pages = requestsOf(view, 'listDecisionPage') as PageInput[]
    assert.equal(pages.at(-1)?.cursor, 'c:4', 'the re-run refresh re-read both pages')
  })
})

test('panel: a failing refresh that supersedes Retry loading leaves Retry available', async () => {
  let up = true
  const w = worker()
  const page = w.listDecisionPage as (i: PageInput) => Result<DecisionPage>
  let release: () => void = () => {}
  let holdRetry = false
  await withPanel({ ...w, listDecisionPage: (i: PageInput) => {
    if (holdRetry) { holdRetry = false; return new Promise<Result<DecisionPage>>((r) => { release = () => r(page(i)) }) }
    return up ? page(i) : { ok: false, code: 'unavailable', message: 'Disconnected.' }
  } }, async (view) => {
    await view.select({ label: 'Workspace' }, 'all')
    up = false
    await view.post('inbox.changed', {}); await wait(200); await view.settled()
    assert.ok(view.find({ text: 'Retry loading' }))
    holdRetry = true
    const retry = view.press({ text: 'Retry loading' })
    await wait(10)
    const inval = view.post('inbox.changed', {})
    await wait(250)
    release()
    await Promise.all([retry, inval]); await view.settled()
    assert.ok(view.find({ text: 'Retry loading' }), 'not stranded in a loading state')
    assert.equal(titles(view).length, 6, 'last loaded list still shown')
  })
})

test('production clock is the live clock and the desktop zone', () => {
  const t = live.now()
  assert.ok(Math.abs(t - Date.now()) < 5_000, 'live clock, not the fixture clock')
  assert.notEqual(t, NOW)
  assert.equal(live.zone(), Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
})

// ---- Practice Inbox and the one source status (FE task_60bd1a0c57b3) ------------------------------
// A stand-in for the worker's Practice Inbox: eight synthetic `practice:` decisions in their own
// store, answered locally (`local-only`), read only through `practice.listDecisionPage` and the
// detail/draft/reply requests that carry `mode: "practice"`.
const practiceRows: Decision[] = [...decisions, decisions[0], decisions[1]].slice(0, 8).map((d, i) => ({
  ...d, questionId: `practice:q${i + 1}`, packageId: `practice:pkg${i + 1}`, requestId: `practice:r${i + 1}`, title: `Practice ${i + 1}: ${d.title}`,
  origin: { hostId: 'practice:local', workspaceId: 'practice:inbox', sessionId: 'practice' }, projectName: 'Practice', workspaceName: 'Practice Inbox',
  source: { kind: 'practice' }, actions: ['reply'], answerState: { state: 'awaiting-answer' }
}))
function practiceWorker(live: MockRequests = worker(mixed, {}, 50, allAvailable)): MockRequests {
  const store = new Map(practiceRows.map((d) => [d.questionId, structuredClone(d)]))
  const drafts = new Map<string, DraftRecord>()
  const isP = (i: { mode?: string }) => i?.mode === 'practice'
  // Typed loosely: each handler answers in the shape of the request it stands in for.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const liveOr = (name: string, i: { mode?: string; questionId: string }, f: () => unknown): any => isP(i) ? f() : (live[name] as (x: unknown) => unknown)?.(i)
  return {
    ...live,
    'practice.listDecisionPage': ({ includeHistory, query }: { includeHistory: boolean; query?: string }) =>
      ok({ rows: [...store.values()].filter((d) => (includeHistory || isActionable(d)) && (!query || searchText(d).includes(query.toLowerCase()))) }),
    getDecision: (i: { mode?: string; questionId: string }) => liveOr('getDecision', i, () => {
      const d = store.get(i.questionId); return d ? ok(d) : { ok: false, code: 'not-found', message: 'Practice decision is missing.' }
    }),
    'draft.get': (i: { mode?: string; questionId: string }) => liveOr('draft.get', i, () => ok(drafts.get(i.questionId) ?? { draft: null, revision: 0 })),
    'draft.save': (i: { mode?: string; questionId: string; draft: DraftRecord['draft']; revision: number }) => liveOr('draft.save', i, () => {
      const cur = drafts.get(i.questionId) ?? { draft: null, revision: 0 }
      if (cur.revision !== i.revision) return { ok: false, code: 'conflict', message: 'Changed elsewhere.' }
      const next = { draft: i.draft, revision: cur.revision + 1 }; drafts.set(i.questionId, next); return ok(next)
    }),
    submitReply: (i: SubmitReply & { mode?: string }) => liveOr('submitReply', i, () => {
      const d = store.get(i.questionId)!
      const { mode: _m, ...reply } = i
      const recorded = { ...reply, acceptedAt: '2030-06-14T12:00:00Z', delivery: { state: 'local-only' as const } }
      if (d.answerState.state === 'awaiting-answer') d.answerState = { state: 'answered', initial: recorded, followUps: [] }
      d.actions = ['follow-up']
      return ok(recorded)
    })
  }
}
const LIVE = ['listDecisionPage', 'workspace.options', 'workspace.resolve', 'retryReply', 'review.open']
const liveCalls = (view: TestPanel) => LIVE.reduce((n, name) => n + requestsOf(view, name).length, 0)

test('source status: typed coverage is one line per kind, failed reads are named in the summary, nothing is promised', async () => {
  const { sourceStatus, replyReach } = await import('../src/source-status')
  assert.equal(sourceStatus(allAvailable), null, 'nothing to say when every source was read')
  const v = sourceStatus([
    { source: 'plugin', state: 'partial', coverage: [
      { kind: 'pending-verification', message: 'Two lookups are not verified.' }, { kind: 'pending-verification', message: 'Two lookups are not verified.' },
      { kind: 'hint-scan-limited', message: 'The lookup reached its scan limit.' }, { kind: 'paired-unreadable', message: 'Paired Chats cannot be read.' }] },
    { source: 'native-item', state: 'available', coverage: [{ kind: 'native-attribution', message: 'One Item has no workspace.' }] }
  ] as SourceAvailability[])!
  assert.equal(v.tone, 'info', 'verification, scan limits and attribution are information')
  assert.match(v.summary, /^Sources: Some Chat submissions not verified yet/)
  assert.equal(v.lines.filter((l) => l.label === 'Not verified yet').length, 1, 'repeats merged')
  assert.equal((v.lines[0].text.match(/Two lookups are not verified/g) ?? []).length, 1)
  assert.ok(!v.lines.some((l) => /nothing is lost|will appear|guarantee/i.test(l.text)), 'no promises')
  const bad = sourceStatus([{ source: 'plugin', state: 'partial', coverage: [{ kind: 'hint-read-failed', message: 'Inbox could not read the local Chat lookup directory.' }] },
    { source: 'native-item', state: 'unavailable', message: 'The Bot roster is offline.' }] as SourceAvailability[])!
  assert.equal(bad.tone, 'warn')
  assert.match(bad.summary, /^Needs attention: Chat lookup could not be read · Bot Items could not be read/, 'failed reads show while collapsed')
  assert.ok(bad.open, 'an unavailable source opens the details')
  assert.match(replyReach('practice'), /this device only\. Nothing is sent/)
  assert.ok(!/will notify|is notified|gets notified/i.test(replyReach('chat')), 'no notification is promised without a reported delivery')
})

test('panel: Practice is always one tab away; eight decisions; zero live requests while it is shown', () => withPanel(practiceWorker(), async (view) => {
  await view.emit('workspace.changed', ctx('studio-local')); await view.settled()
  assert.ok(view.find({ label: 'Which inbox' }), 'the Inbox / Practice switch is on the list')
  const before = liveCalls(view)
  await view.select({ label: 'Which inbox' }, 'practice'); await view.settled()
  assert.equal(titles(view).length, 8, 'all eight practice decisions')
  assert.ok(view.find({ label: 'Practice Inbox' }), 'says once what Practice is')
  assert.ok(view.find({ text: /saved in this Inbox on this device only; nothing is sent/ }))
  // Focus, workspace and live inbox news while Practice is shown are deferred, not read.
  await view.emit('workspace.changed', ctx('library-local'))
  await view.emit('workspace.created', { workspaceId: 'kiln-local', kind: 'worktree', path: '/w/kiln', branch: 'kiln' })
  await view.post('inbox.changed', {}); await wait(200); await view.settled()
  // Open, note-free answer, save: every request names Practice explicitly.
  await view.press({ label: practiceRows[1].title }); await view.settled()
  assert.ok(view.find({ text: 'Practice · saved on this device' }))
  assert.ok(view.find({ text: /^Practice: saved in this Inbox on this device only/ }), 'said at the point of reply')
  await view.type({ label: 'Reply text' }, 'Tuesday works.'); await wait(700); await view.settled()
  await view.press({ text: 'Save practice answer' }); await view.settled()
  assert.ok(view.find({ text: /Saved in the Practice Inbox on this device\. Nothing was sent/ }))
  assert.equal(liveCalls(view), before, 'no live list, inventory, focus, retry or wide request in Practice')
  for (const name of ['getDecision', 'draft.get', 'draft.save', 'submitReply'])
    assert.ok(requestsOf(view, name).length && requestsOf(view, name).every((i) => (i as { mode?: string }).mode === 'practice'), `${name} carries mode: practice`)
  // Back to the Inbox: the deferred focus applies; live requests carry no mode.
  await view.press({ text: '← Back to Practice' }); await view.select({ label: 'Which inbox' }, 'inbox'); await view.settled()
  assert.ok(liveCalls(view) > before, 'live reads resume in the Inbox')
  assert.ok(requestsOf(view, 'workspace.resolve').some((i) => (i as { workspaceId: string }).workspaceId === 'library-local'), 'the focus change made in Practice is applied')
}))

test('panel: a read-only Bot Item leads to Practice, and the Item itself stays unanswerable', () => withPanel(practiceWorker(), async (view) => {
  await view.emit('workspace.changed', ctx('studio-local')); await view.settled()
  await view.press({ label: 'Ship the lantern build?' }); await view.settled()
  assert.ok(view.find({ text: /^Answer in Orca's Bot Items/ }), 'where the actual Item is answered')
  assert.ok(!view.find({ text: 'Submit reply' }))
  await view.press({ text: 'Try answering in Practice' }); await view.settled()
  assert.equal(titles(view).length, 8)
  assert.ok(!requestsOf(view, 'submitReply').length, 'nothing was written for the Item')
}))
