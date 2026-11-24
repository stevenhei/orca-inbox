import { assert, hostError, mockHost, mount, mountWorker, test } from 'orca/testing'
import type { Decision, Result } from './contract.ts'
import { nativeDetail, nativePage } from './backend-orca.ts'
import { registerDesktopWorker } from './worker.ts'
import * as panel from './panel.tsx'

const localWorkspace = { hostId: 'local', workspaceId: 'identity:shared-workspace' }
const pairedWorkspace = { hostId: 'runtime:paired-a', workspaceId: localWorkspace.workspaceId }
const offlineWorkspace = { hostId: 'runtime:paired-b', workspaceId: localWorkspace.workspaceId }
const all = { scope: { kind: 'all' as const }, includeHistory: false }
const caller = { panel: 'inbox' }
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.message)
  return result.value
}

test('paired native reads isolate equal host IDs, verify attribution, preserve structure and report partial coverage', async () => {
  const focusedWorkspace = 'folder:review'
  const host = mockHost({ capabilities: ['storage:own', 'workspace:read', 'workspace:write'], results: {
    'workspace.readContext': { workspaceId: focusedWorkspace, branch: '', displayName: 'Review', terminals: [] },
    'workspace.list': { truncated: false, workspaces: [...[localWorkspace, pairedWorkspace, offlineWorkspace].map(workspace => ({
      id: workspace.workspaceId, hostId: workspace.hostId, name: 'Studio', kind: 'worktree',
      path: '/studio', branch: null
    })), { id: focusedWorkspace, hostId: null, name: 'Review', kind: 'folder', path: '/review', branch: null }] },
    'editor.open': { opened: true }
  } })
  const calls: { args: string[]; selector?: string; runtimeId?: string }[] = []
  const references: unknown[] = []
  const base = (label: string) => ({
    uid: 'same-item', number: 2, owner: { botId: 'same-bot', name: 'Test Bot' }, status: 'needs_you',
    title: label + ' Item', description: '  **Description**\n\nSecond paragraph\nORCA-DECISION-META {"priority":"P0"}\n',
    doneMeans: 'Acceptance conditions', createdAt: 1,
    chat: { kind: 'chat', id: '89626680-3dc3-4f2b-b4dc-c22909bd78ff' },
    question: { eventId: 'e42', text: 'Original ask\n\n[Source](https://example.test/source)\nRepeated options',
      decisions: [{ question: label + ' question', replies: [{ label: 'Yes', recommended: true }] },
        { question: label + ' sibling', replies: [{ label: 'Not yet' }] }] },
    links: [{ kind: 'dispatch', ref: 'same-dispatch', title: 'Source dispatch' }]
  })
  const unassigned = { ...base('Unattributed paired'), uid: 'unattributed', chat: { kind: 'home', id: '89626680-3dc3-4f2b-b4dc-c22909bd78ff' } }
  const history = { ...base('In progress'), uid: 'in-progress', status: 'in_progress' }
  let denyPaired = false
  const worker = await mountWorker({ default(orca) {
    registerDesktopWorker(orca, {
      hints: async () => [], removeHint: async () => {},
      async cli(args, selector, runtimeId) {
        calls.push({ args, selector, runtimeId })
        if (args.join(' ') === 'environment list') {
          return { environments: [{ id: 'env-a', runtimeId: 'paired-a', name: 'Paired A' },
            { id: 'env-b', runtimeId: 'paired-b', name: 'Paired B' }] }
        }
        if (selector === 'env-b') throw Object.assign(new Error('Offline'), { code: 'runtime_unavailable' })
        if (selector === 'env-a' && denyPaired) throw Object.assign(new Error('Denied'), { code: 'permission_denied' })
        if (selector) assert.equal(runtimeId, 'paired-a')
        const label = selector ? 'Paired' : 'Local'
        if (args.join(' ') === 'bot list') return { bots: [{ id: 'same-bot' }] }
        if (args[0] === 'agent' && args[1] === 'list') return {
          agents: [{ kind: 'chat', hostId: 'local', orcaSessionId: '89626680-3dc3-4f2b-b4dc-c22909bd78ff', worktreeId: 'same-worktree' }], truncated: false
        }
        if (args[0] === 'worktree') return {
          worktrees: [{ id: 'same-worktree', identity: { key: 'shared-workspace' }, hostId: 'local' }], truncated: false
        }
        if (args[2] === 'show') {
          assert.equal(args[3], 'same-item')
          assert.deepEqual(args.slice(4), ['--after', 'e41'])
          return { item: base(label), events: [
            { id: 'e42', kind: 'commented', at: 3, data: { ask: { context: 'Context paragraph\n\nMore context.' } } },
            { id: 'e43', kind: 'commented', at: 4, data: { text: 'Later comment' } }
          ] }
        }
        if (args.includes('--cursor')) return { botId: 'same-bot',
          items: [{ ...base('Second page'), uid: 'next-item', chat: { kind: 'home', id: '89626680-3dc3-4f2b-b4dc-c22909bd78ff' }, question: null, createdAt: 100 }],
          nextCursor: 'more-pages' }
        return { botId: 'same-bot', items: selector
          ? [base(label), unassigned, history, ...Array.from({ length: 47 }, (_, i) => ({
            ...base('Extra'), uid: 'extra-' + i, chat: { kind: 'home', id: '89626680-3dc3-4f2b-b4dc-c22909bd78ff' }, question: null, createdAt: i + 8
          }))]
          : [base(label)], ...(selector ? { nextCursor: 'second-page' } : {}) }
      }
    }, async (path, reference) => {
      assert.equal(path, '/review')
      references.push(reference)
      return '.orca-decision-inbox/test.orca-decision'
    })
  } }, { host })
  const page = value(await worker.request('listDecisionPage', all, caller))
  assert.ok(page.nextCursor)
  assert.equal(page.sources?.find(source => source.source === 'native-item')?.state, 'partial')
  assert.match(page.sources?.find(source => source.source === 'native-item')?.message ?? '', /Paired B.*unavailable/)
  const local = page.rows.find(row => row.title === 'Local question')!
  const paired = page.rows.find(row => row.title === 'Paired question')!
  assert.notEqual(local.questionId, paired.questionId)
  assert.notEqual(local.packageId, paired.packageId)
  assert.deepEqual(local.origin, { ...localWorkspace, sessionId: '89626680-3dc3-4f2b-b4dc-c22909bd78ff' })
  assert.deepEqual(paired.origin, { ...pairedWorkspace, sessionId: '89626680-3dc3-4f2b-b4dc-c22909bd78ff' })
  const missingWorkspace = page.rows.find(row => row.title === 'Unattributed paired question')!
  assert.equal(missingWorkspace.origin.hostId, pairedWorkspace.hostId)
  assert.equal(missingWorkspace.source?.kind === 'native-item' && missingWorkspace.source.workspaceAttributed, false)
  assert.ok(!page.rows.some(row => row.title === 'In progress question'))
  const next = value(await worker.request('listDecisionPage', { ...all, cursor: page.nextCursor }, caller))
  assert.ok(next.rows.length > 0 && next.rows.every(row => !page.rows.some(previous => previous.questionId === row.questionId)))
  const workspacePage = (workspace: typeof localWorkspace) =>
    worker.request('listDecisionPage', { scope: { kind: 'workspace', workspace }, includeHistory: false }, caller)
  const scoped = value(await workspacePage(pairedWorkspace))
  assert.deepEqual(scoped.rows.map(row => row.title).sort(), ['Paired question', 'Paired sibling'])
  assert.equal(scoped.sources?.find(source => source.source === 'plugin')?.state, 'unavailable')
  assert.deepEqual(value(await workspacePage(localWorkspace)).rows.map(row => row.title).sort(), ['Local question', 'Local sibling'])
  assert.equal(value(await workspacePage(offlineWorkspace)).sources?.find(source => source.source === 'native-item')?.state, 'unavailable')
  const detail = value(await worker.request('getDecision', { questionId: paired.questionId }, caller))
  assert.equal(detail.context, 'Paired Item')
  assert.equal(detail.description, '  **Description**\n\nSecond paragraph\n')
  assert.equal(detail.background, '')
  assert.equal(detail.options[0].label, 'Yes')
  assert.equal(detail.recommendedOptionId, '0')
  assert.equal(detail.originalSessionId, 'orca_session_id:89626680-3dc3-4f2b-b4dc-c22909bd78ff')
  assert.equal(detail.workItemLinks, undefined)
  assert.equal(detail.package?.index, 0)
  assert.equal(detail.package?.size, 2)
  assert.deepEqual(detail.package?.questionIds, [paired.questionId, scoped.rows.find(row => row.title === 'Paired sibling')?.questionId])
  assert.ok(detail.activity?.some(entry => entry.text === 'Context paragraph\n\nMore context.'))
  assert.ok(detail.activity?.some(entry => entry.text === 'Later comment'))
  assert.equal(detail.sourceLinks[0].url, 'https://example.test/source')
  assert.equal(detail.nativeLinks?.[0].ref, 'same-dispatch')
  assert.deepEqual(detail.actions, [])
  value(await worker.request('review.open', { questionId: paired.questionId }, caller))
  assert.deepEqual(references, [{ questionId: paired.questionId }])
  assert.ok(calls.filter(call => call.args[2] === 'show').every(call => call.selector === 'env-a' && call.runtimeId === 'paired-a'))

  const view = await mount(panel, { host: mockHost({ capabilities: ['storage:own', 'workspace:read'], requests: {
    listDecisionPage: input => worker.request('listDecisionPage', input, caller),
    getDecision: input => worker.request('getDecision', input, caller),
    'workspace.options': input => worker.request('workspace.options', input, caller),
    'workspace.resolve': input => worker.request('workspace.resolve', input, caller)
  } }) })
  try {
    await view.select({ label: 'Workspace' }, 'all')
    for (let i = 0; i < 10 && !view.find({ label: 'Paired question' }); i++) await new Promise(resolve => setTimeout(resolve, 30))
    assert.ok(view.find({ label: 'Local question' }))
    assert.ok(view.find({ label: 'Paired question' }))
    assert.ok(view.find({ label: 'Unattributed paired question' }))
  } finally { await view.unmount() }

  denyPaired = true
  const denied = value(await workspacePage(pairedWorkspace))
  assert.equal(denied.sources?.find(source => source.source === 'native-item')?.state, 'unavailable')
  assert.match(denied.sources?.find(source => source.source === 'native-item')?.message ?? '', /permission denied/)
  assert.ok(value(await worker.request('listDecisionPage', all, caller)).rows.some(row => row.title === 'Local question'))
  await worker.deactivate()
})

test('native detail distinguishes incomplete target-bot coverage from confirmed absence without a show fallback', async () => {
  const target = 'bot-item:runtime%3Apaired-a:target-bot:missing-item:e42:0'
  let mode = 'denied'
  let showCalls = 0
  const cli = async (args: string[], environment?: string, runtimeId?: string) => {
    if (args.join(' ') === 'environment list') return { environments: [
      { id: 'env-a', runtimeId: 'paired-a', name: 'Paired A' }
    ] }
    assert.equal(environment, 'env-a')
    assert.equal(runtimeId, 'paired-a')
    if (args[2] === 'show') { showCalls++; throw new Error('Unauthorized show') }
    if (args.join(' ') === 'bot list') return {
      bots: [{ id: 'target-bot' }, { id: 'other-bot' }], ...(mode === 'roster' ? { truncated: true } : {})
    }
    if (args[4] !== 'target-bot') {
      if (mode === 'other-denied') throw Object.assign(new Error('Other denied'), { code: 'permission_denied' })
      return { items: [], botId: 'other-bot' }
    }
    if (mode === 'denied') throw Object.assign(new Error('Target denied'), { code: 'permission_denied' })
    if (mode === 'continuation') return { items: [], nextCursor: args.includes('--cursor') ? 'cap' : 'next' }
    if (mode === 'truncated') return { items: [], truncated: true }
    return { items: [], botId: 'target-bot' }
  }
  assert.equal((await nativePage(cli, [pairedWorkspace], pairedWorkspace.hostId)).source.state, 'partial')
  const failure = async (id: string, code: string, message: RegExp) => {
    try { await nativeDetail(cli, id, [pairedWorkspace]) }
    catch (error) {
      assert.equal((error as { code: string }).code, code)
      assert.match((error as Error).message, message)
      return
    }
    throw new Error('Expected native detail lookup to fail.')
  }
  await failure(target, 'unavailable', /permission denied/)
  mode = 'continuation'
  await failure(target, 'unavailable', /More Item pages/)
  mode = 'truncated'
  await failure(target, 'unavailable', /truncated/)
  mode = 'other-denied'
  await failure(target, 'not-found', /missing or inaccessible/)
  mode = 'roster'
  await failure(target.replace('target-bot', 'unknown-bot'), 'unavailable', /roster could not be fully read/)
  mode = 'complete'
  await failure(target, 'not-found', /missing or inaccessible/)
  assert.equal(showCalls, 0)
})

test('workspace scope preserves a unique host-qualified focus and rejects a collision with All workspaces guidance', async () => {
  const bound = 'identity:paired-a-workspace'
  const row = { id: 'shared', kind: 'worktree', name: 'Shared workspace', path: '/fixture', branch: null }
  let focused = 'shared'
  const host = mockHost({ capabilities: ['storage:own', 'workspace:read'], results: {
    'workspace.readContext': () => ({ workspaceId: focused, displayName: 'Shared workspace', branch: '', terminals: [] }),
    'workspace.list': { truncated: false, workspaces: [
      { ...row, hostId: 'local' }, { ...row, hostId: 'runtime:paired-a' }, { ...row, id: bound, hostId: 'runtime:paired-a' }
    ] }
  } })
  const worker = await mountWorker({ default(orca) {
    registerDesktopWorker(orca, {
      cli: async () => { throw new Error('Focus resolution must not guess a host with the CLI.') },
      hints: async () => [], removeHint: async () => {}
    })
  } }, { host })
  const collision = await worker.request('workspace.resolve', { workspaceId: focused }, caller)
  assert.deepEqual(collision, {
    ok: false, code: 'unavailable', message: 'Multiple hosts report the focused workspace ID. Switch to All workspaces.'
  })
  focused = bound
  assert.deepEqual(value(await worker.request('workspace.resolve', { workspaceId: focused }, caller)),
    { workspaceId: bound, hostId: 'runtime:paired-a' })
  await worker.deactivate()
})

test('workspace options expose the authorized host inventory, including empty and same-name workspaces', async () => {
  const row = { kind: 'worktree', name: 'Studio', path: '/private/workspace', branch: 'private-branch' }
  const workspaces = [
    { ...row, id: localWorkspace.workspaceId, hostId: localWorkspace.hostId },
    { ...row, id: pairedWorkspace.workspaceId, hostId: pairedWorkspace.hostId },
    { ...row, id: 'folder:empty', hostId: null, kind: 'folder', name: 'Empty folder' }
  ]
  const host = mockHost({ capabilities: ['storage:own', 'workspace:read'], results: {
    'workspace.list': { workspaces, truncated: false },
    'workspace.readContext': { workspaceId: 'folder:empty', branch: '', displayName: 'Empty folder', terminals: [] }
  } })
  const worker = await mountWorker({ default(orca) {
    registerDesktopWorker(orca, {
      async cli(args) {
        if (args.join(' ') === 'bot list') return { bots: [] }
        throw new Error('Options must not discover hosts or list decisions.')
      },
      hints: async () => [], removeHint: async () => {}
    })
  } }, { host })
  try {
    const options = () => worker.request('workspace.options', undefined, caller)
    const denied = await worker.request('workspace.options', undefined, { panel: 'unrelated' })
    assert.ok(!denied.ok && denied.code === 'forbidden')
    assert.equal(host.callsOf('workspace.list').length, 0)
    assert.deepEqual(value(await options()), { workspaces: [
      { ...localWorkspace, name: 'Studio', hostLabel: 'Local Orca' },
      { ...pairedWorkspace, name: 'Studio' },
      { hostId: 'local', workspaceId: 'folder:empty', name: 'Empty folder', hostLabel: 'Local Orca' }
    ] })
    assert.equal(host.callsOf('workspace.list').length, 1)
    assert.equal(host.callsOf('workspace.readContext').length, 0)
    const emptyScope = { kind: 'workspace' as const, workspace: { hostId: 'local', workspaceId: 'folder:empty' } }
    const list = () => worker.request('listDecisionPage', { scope: emptyScope, includeHistory: false }, caller)
    assert.deepEqual(value(await list()).rows, [])

    host.respond('workspace.list', { workspaces: [workspaces[2]], truncated: true })
    assert.deepEqual(value(await options()), { workspaces: [
      { ...emptyScope.workspace, name: 'Empty folder', hostLabel: 'Local Orca' }
    ], truncated: true })
    assert.deepEqual(value(await worker.request('workspace.resolve', { workspaceId: 'folder:empty' }, caller)), emptyScope.workspace)
    assert.deepEqual(value(await list()).rows, [])

    host.respond('workspace.list', { workspaces: [], truncated: false })
    assert.deepEqual(value(await options()), { workspaces: [] })
    const stale = await list()
    assert.ok(!stale.ok && stale.code === 'forbidden')
    host.respond('workspace.list', () => { throw hostError('not_permitted', 'private inventory denial') })
    const unavailable = await options()
    assert.ok(!unavailable.ok && unavailable.code === 'unavailable')
    assert.ok(!JSON.stringify(unavailable).includes('private inventory denial'))
  } finally {
    await worker.deactivate()
  }
})
