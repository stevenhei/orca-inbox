// DOM tests for the wide review editor (src/review.ts), run in Node with linkedom.
//   npm run test:dom
//
// They drive the real editor against a controlled stand-in for the plugin worker (every
// `orca.plugin.request` is recorded and answered per scenario) and prove behavior: worker calls,
// reply IDs, drafts, delivery states, errors, notes, settings and ARIA values. They do NOT prove
// layout: CSS, the 800px sidebar-to-modal switch, real text selection and <dialog> need Orca.
//
// Nothing is installed or built inside the plugin folder: Orca refuses to install a plugin that
// contains symlinks (node_modules/.bin) and would ship dev packages. This script installs linkedom
// and compiles the sources into a temporary directory, runs each scenario in its own child process
// (review.ts runs once on import), then deletes the directory. Orca's own test runner cannot import
// npm packages, which is why this is not an `orca plugin test`.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const LINKEDOM = '0.18.5'
const TYPESCRIPT = '5.9.3'
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const SCENARIOS = ['review', 'quiet', 'ime', 'restart', 'ambiguous', 'inflight', 'durable', 'draftcas', 'winner', 'noreceipt', 'bind', 'followup', 'receipt', 'package', 'narrow', 'errors', 'offline', 'settings', 'settings2', 'native', 'mail', 'noactions', 'race', 'racebtn', 'localonly', 'reader', 'dashboard', 'dashnarrow', 'dashfocus', 'dashscope', 'rich', 'sections']
const scenario = process.argv[2]

if (!scenario) {
  const tmp = mkdtempSync(path.join(process.env.DOM_TMP_ROOT ?? os.tmpdir(), 'orca-inbox-dom-'))
  const run = (cmd, args, opts = {}) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: root, ...opts })
    if (r.status !== 0) { process.stderr.write(`${r.stdout ?? ''}${r.stderr ?? ''}`); throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed`) }
    return r
  }
  let failed = 0
  // Production never falls back to fixtures: no shipped UI module imports them.
  for (const f of ['src/panel.tsx', 'src/review.ts', 'src/client.ts', 'src/model.ts']) {
    assert.doesNotMatch(readFileSync(path.join(root, f), 'utf8'), /from ['"][^'"]*fixtures/, `${f} imports fixtures`)
  }
  console.log('  ok  [static] no UI module imports fixtures')
  try {
    writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
    // --no-bin-links: no .bin symlinks, even in the temp directory.
    run('npm', ['install', '--prefix', tmp, `linkedom@${LINKEDOM}`, '--no-bin-links', '--no-audit', '--no-fund', '--silent'])
    // Compile only the editor and what it imports, so unfinished backend files cannot break FE tests.
    writeFileSync(path.join(tmp, 'tsconfig.json'), JSON.stringify({
      extends: path.join(root, 'tsconfig.json'),
      compilerOptions: { noEmit: false, outDir: path.join(tmp, 'build'), rootDir: root, rewriteRelativeImportExtensions: true, allowImportingTsExtensions: false },
      // The fixtures compile for the tests only; the editor itself never imports them.
      files: [path.join(root, 'src/review.ts'), path.join(root, 'fixtures/decisions.ts'), path.join(root, 'fixtures/rich-context.ts')],
      include: []
    }))
    run('npm', ['exec', '--yes', '--package', `typescript@${TYPESCRIPT}`, '--', 'tsc', '-p', path.join(tmp, 'tsconfig.json')])
    for (const name of SCENARIOS) {
      // A scenario that hangs is a failure, not a stalled run.
      const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), name], { encoding: 'utf8', env: { ...process.env, DOM_TMP: tmp }, timeout: 60_000 })
      process.stdout.write(r.stdout ?? '')
      if (r.status !== 0) {
        failed++
        process.stderr.write(r.error?.code === 'ETIMEDOUT' ? `  FAIL [${name}] timed out after 60 s\n` : (r.stderr ?? ''))
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  console.log(failed ? `\n${failed} of ${SCENARIOS.length} scenarios FAILED` : `\nall ${SCENARIOS.length} scenarios passed`)
  process.exit(failed ? 1 : 0)
}

const tmp = process.env.DOM_TMP
const { parseHTML } = await import(pathToFileURL(path.join(tmp, 'node_modules/linkedom/esm/index.js')).href)
const { document, window } = parseHTML('<!doctype html><html><head></head><body></body></html>')
let activeEl = null
Object.defineProperty(document, 'activeElement', { get: () => (activeEl?.isConnected ? activeEl : document.body), configurable: true })
window.HTMLElement.prototype.focus = function () { activeEl = this }
let selection = { rangeCount: 0, isCollapsed: true }
// linkedom has no Range comparison: a selection range stand-in that knows where it starts and ends
// relative to one text node, which is all the editor asks.
const RANGE = { START_TO_START: 0, START_TO_END: 1, END_TO_END: 2, END_TO_START: 3 }
const range = (node, start, end, { startBefore = false, endAfter = false, startContainer = node, endContainer = node } = {}) => ({
  startContainer, endContainer, startOffset: start, endOffset: end,
  intersectsNode: (n) => n === node,
  compareBoundaryPoints: (how) => how === RANGE.START_TO_START ? (startBefore ? -1 : 0) : (endAfter ? 1 : 0),
  getBoundingClientRect: () => ({ left: 0, bottom: 0 })
})
const select = (r) => { selection = { rangeCount: 1, isCollapsed: false, getRangeAt: () => r }; document.dispatchEvent(new window.Event('selectionchange')) }
Object.assign(globalThis, {
  document, window,
  // The narrow scenario runs at the ≤800px layout (no sidebar; notes in a dialog).
  matchMedia: () => ({ matches: scenario === 'narrow' || scenario === 'dashnarrow', addEventListener() {} }),
  getSelection: () => selection,
  CSS: { escape: (s) => String(s).replace(/["\\]/g, '\\$&') },
  Range: RANGE
})
const copied = []
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t) => { copied.push(t) } } }, configurable: true })
// linkedom has no <dialog> behavior: stub only what the editor calls.
window.HTMLElement.prototype.showModal = function () { this.setAttribute('open', '') }
window.HTMLElement.prototype.close = function () { this.removeAttribute('open') }

// ---- deterministic fixtures and clock (tests only) ----------------------------------------------
const build = (f) => pathToFileURL(path.join(tmp, 'build', f)).href
const fx = await import(build('fixtures/decisions.js'))
const client = await import(build('src/client.js'))
client.clock.now = () => Date.parse(fx.clock)
client.clock.zone = () => 'UTC'

// ---- controlled stand-in for the plugin worker --------------------------------------------------
const okR = (value) => ({ ok: true, value })
const errR = (code, message = '') => ({ ok: false, code, message })
const hostError = (code, message = code) => Object.assign(new Error(message), { code, retryable: false })
const clone = (v) => (v === undefined ? v : structuredClone(v))
const db = new Map(fx.decisions.map((d) => [d.questionId, clone(d)]))
// The BE's shared rich-context sample as the worker would return it: one authorized placement as
// submitted, plus a denied one reduced to a position-only placeholder at the end.
if (scenario === 'sections') {
  // Authored headings that already match ours: no duplicate headings, raw background unchanged.
  db.set('sections', { ...clone(fx.decisions.find((d) => d.questionId === 'schedule')), questionId: 'sections', packageId: 'sections',
    description: '# Description\n\nApprove the **east entrance** route.', background: '## Background\n\nThe west aisle is narrow. The east entrance is quieter.', recommendation: 'Approve it.' })
}
if (scenario === 'rich') {
  const { richContext } = await import(build('fixtures/rich-context.js'))
  const q = richContext.questions[0]
  db.set(q.questionId, { ...clone(fx.decisions.find((d) => d.questionId === 'schedule')), ...clone(q), packageId: richContext.packageId, requestId: richContext.requestId,
    evidence: clone(richContext.evidence), sourceLinks: clone(richContext.sourceLinks), inlineImages: [...clone(q.inlineImages), { offset: q.background.length, unavailable: true }],
    answerState: { state: 'awaiting-answer' }, actions: ['reply'], recommendedOptionId: 'valley',
    workItemLinks: [{ kind: 'github-pr', label: 'example/paper#4', url: 'https://github.com/example/paper/pull/4' }, { kind: 'github-pr', label: 'dup', url: 'https://github.com/example/paper/pull/4' },
      { kind: 'linear-issue', label: 'PAP-1', url: 'http://linear.app/example/issue/PAP-1' }, { kind: 'github-pr', label: 'case', url: 'https://GitHub.com/example/paper/pull/4/#x' },
      { kind: 'github-issue', label: 'cred', url: 'https://u:p@github.com/example/paper/issues/9' }, { kind: 'github-issue', label: 'tree', url: 'https://github.com/example/paper/tree/main' },
      { kind: 'linear-issue', label: 'PAP-2', url: 'https://linear.app/example/issue/PAP-2/fold-depth' }],
    originalSessionId: 'orca_session_id:00000000-0000-4000-8000-000000000002' })
}
const drafts = new Map() // questionId -> { draft, revision }
const calls = []
const listeners = {}
const handlers = {}
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
const base = {
  getDecision: ({ questionId }) => (db.has(questionId) ? okR(clone(db.get(questionId))) : errR('not-found')),
  // Bounded page: the worker searches; this stand-in matches the query against IDs only.
  listDecisionPage: ({ scope, query }) => okR({ rows: [...db.values()].filter((d) => (scope.kind === 'all' ||
    (d.origin.hostId === scope.workspace.hostId && d.origin.workspaceId === scope.workspace.workspaceId)) &&
    (!query || d.packageId.includes(query) || d.questionId.includes(query))).map(clone) }),
  listDecisions: ({ scope }) => okR([...db.values()].filter((d) => scope.kind === 'all' ||
    (d.origin.hostId === scope.workspace.hostId && d.origin.workspaceId === scope.workspace.workspaceId)).map(clone)),
  'draft.get': ({ questionId }) => okR(clone(drafts.get(questionId) ?? { draft: null, revision: 0 })),
  // Like the real worker: a stored draft may not hold an empty note.
  // Like the real worker: compare-and-set on the stored revision, required even to clear; partial
  // (empty) notes are accepted in drafts.
  'draft.save': ({ questionId, draft, revision }) => {
    const cur = drafts.get(questionId) ?? { draft: null, revision: 0 }
    if (typeof revision !== 'number') return errR('invalid', 'Revision required.')
    if (revision !== cur.revision) return errR('conflict', 'Stale draft revision.')
    const next = { draft: clone(draft), revision: cur.revision + 1 }
    drafts.set(questionId, next)
    return okR(clone(next))
  },
  getSnapshot: () => okR({ mimeType: 'image/png', base64: PNG }),
  'review.open': () => okR(null),
  'workspace.resolve': ({ workspaceId }) => workspaceId === 'studio-local' ? okR({ hostId: 'local', workspaceId: 'studio' }) : errR('not-found', 'Unknown workspace.'),
  // Authorized inventory: "studio" on two hosts (same name), "library", and an empty "archive".
  'workspace.options': () => okR({ workspaces: [
    { hostId: 'local', workspaceId: 'studio', name: 'studio', hostLabel: 'Local Orca' },
    { hostId: 'local', workspaceId: 'library', name: 'library', hostLabel: 'Local Orca' },
    { hostId: 'paired', workspaceId: 'studio', name: 'studio' },
    { hostId: 'local', workspaceId: 'archive', name: 'archive', hostLabel: 'Local Orca' }] }),
  submitReply: (input) => {
    const d = db.get(input.questionId)
    const rec = { ...clone(input), acceptedAt: '2030-06-14T12:03:00Z', delivery: { state: 'submitted' } }
    d.answerState = d.answerState.state === 'answered'
      ? { ...d.answerState, followUps: [...d.answerState.followUps, rec] }
      : { state: 'answered', initial: rec, followUps: [] }
    return okR(clone(rec))
  }
}
const worker = {
  request: async (name, input) => {
    calls.push({ name, input: clone(input) })
    const h = handlers[name] ?? base[name]
    if (!h) throw hostError('unknown_method', `No handler ${name}`)
    return h(input)
  },
  on: (event, fn) => { (listeners[event] ??= []).push(fn); return { dispose() {} } }
}
let replace = () => {}
const files = {
  review: '{"questionId":"image-review"}', restart: '{"questionId":"schedule"}', winner: '{"questionId":"stage"}',
  bind: '{"questionId":"schedule"}', durable: '{"questionId":"schedule"}', draftcas: '{"questionId":"schedule"}', followup: '{"questionId":"layout"}', receipt: '{"questionId":"layout"}',
  package: '{"questionId":"room-route"}', errors: '{"questionId":"nope"}', offline: '{"questionId":"image-review"}',
  settings: '{"view":"settings"}', settings2: '{"view":"settings"}', quiet: '{"questionId":"image-review"}', ime: '{"questionId":"schedule"}',
  native: '{"questionId":"native-x"}', mail: '{"questionId":"layout"}', noactions: '{"questionId":"schedule"}',
  reader: '{"questionId":"pkg-a-1"}', dashboard: '{"view":"dashboard"}', dashnarrow: '{"view":"dashboard"}', dashfocus: '{"view":"dashboard"}', race: '{"questionId":"schedule"}', racebtn: '{"questionId":"schedule"}', localonly: '{"questionId":"schedule"}',
  dashscope: '{"view":"dashboard"}', rich: '{"questionId":"rich-context-question"}', sections: '{"questionId":"sections"}', ambiguous: '{"questionId":"schedule"}', inflight: '{"questionId":"schedule"}', noreceipt: '{"questionId":"schedule"}', narrow: '{"questionId":"image-review"}'
}
const opened = []
globalThis.orca = {
  document: { session: async () => ({ value: files[scenario], onReplace(fn) { replace = fn }, change() {} }) },
  shell: { openExternal: async (url) => { opened.push(url); return { opened: true } } },
  plugin: worker,
  // The focused workspace, as the editor frame's host API reports it.
  host: { call: async (method) => { calls.push({ name: `host:${method}` }); return method === 'workspace.readContext' ? { workspaceId: 'studio-local', branch: 'main', displayName: 'studio', terminals: [] } : null } },
  on: () => ({ dispose() {} })
}

// ---- helpers ------------------------------------------------------------------------------------
const all = (sel) => [...document.querySelectorAll(sel)]
const text = () => document.body.textContent.replace(/\s+/g, ' ')
const find = (sel, t) => all(sel).find((e) => e.textContent.trim() === t)
const findStart = (sel, t) => all(sel).find((e) => e.textContent.trim().startsWith(t))
const settle = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const click = async (e, init = {}) => {
  assert.ok(e, 'element to click exists')
  const ev = new window.Event('click', { bubbles: true }); Object.assign(ev, init)
  e.dispatchEvent(ev); await settle()
}
/** Writes a note in the open note composer and adds it. */
const draft0 = () => last('draft.save').draft.annotations
const addNote = async (t) => { await setValue(byLabel('New note'), t, 'input'); await click(document.querySelector('[data-k="nc-add"]')); await sleep(30); await settle() }
/** Chooses a Workspace in the dashboard's select (linkedom: by the selected attribute). */
const chooseWs = async (value) => {
  const sel = document.querySelector('[data-k="ws-select"]')
  for (const o of sel.querySelectorAll('option')) o.toggleAttribute('selected', o.getAttribute('value') === value)
  sel.dispatchEvent(new window.Event('change', { bubbles: true })); await settle()
}
const wsVal = (hostId, workspaceId) => `ws:${encodeURIComponent(hostId)}:${encodeURIComponent(workspaceId)}`
const key = async (init) => { const ev = new window.Event('keydown', { bubbles: true }); Object.assign(ev, init); document.dispatchEvent(ev); await settle() }
const byLabel = (l) => document.querySelector(`[aria-label="${l}"]`)
const step = () => document.querySelector('.step[aria-current="step"]')?.textContent.trim()
const callsOf = (name) => calls.filter((c) => c.name === name).map((c) => c.input)
const last = (name) => callsOf(name).at(-1)
// Like a browser: typing fires `input`; leaving the field fires `change`. `type: 'input'` means the
// owner is still in the field. Selects fire `change` only.
const setValue = async (e, v, type = 'blur') => {
  assert.ok(e, 'field exists')
  if (e.tagName === 'SELECT') {
    // linkedom's select.value is read-only: pick the option, as a user would.
    const opts = [...e.querySelectorAll('option')]
    assert.ok(opts.some((o) => o.getAttribute('value') === v), `option ${v} exists`)
    for (const o of opts) { if (o.getAttribute('value') === v) o.setAttribute('selected', ''); else o.removeAttribute('selected') }
    e.dispatchEvent(new window.Event('change', { bubbles: true })); await settle(); return
  }
  e.value = v; if (e.tagName === 'TEXTAREA') e.textContent = v
  e.dispatchEvent(new window.Event('input', { bubbles: true }))
  if (type !== 'input') e.dispatchEvent(new window.Event('change', { bubbles: true }))
  await settle()
}
// The editor coalesces invalidations for 150 ms before it refetches.
const changed = async () => { for (const fn of listeners['inbox.changed'] ?? []) fn({}); await sleep(200); await settle() }
const ok = (m) => console.log(`  ok  [${scenario}] ${m}`)
const FIXTURE_TITLES = fx.decisions.map((d) => d.title)

// ---- per-scenario worker answers, set before the editor loads -----------------------------------
if (scenario === 'review') {
  handlers.getSnapshot = ({ attachmentId }) =>
    attachmentId === 'placeholder-6' ? errR('not-found', 'Expired.')
      : attachmentId === 'placeholder-7' ? errR('forbidden')
      : attachmentId === 'placeholder-4' ? Promise.reject(hostError('timeout', 'Timed out.'))
      : okR({ mimeType: 'image/png', base64: PNG })
} else if (scenario === 'restart') {
  // A draft persisted by an earlier session, mid-attempt: its reply ID must be reused.
  drafts.set('schedule', { draft: { text: 'Tuesday works', optionId: 'tue', replyId: 'reply-persisted-1', kind: 'initial', annotations: [] }, revision: 7 })
  let first = true
  handlers.submitReply = (input) => {
    if (first) { first = false; return Promise.reject(hostError('timeout', 'The worker did not answer in time.')) }
    return base.submitReply(input)
  }
} else if (scenario === 'durable') {
  // Draft storage fails: the attempt must not be sent without a durable reply ID.
  let down = false
  handlers['draft.save'] = (input) => (down ? errR('unavailable', 'Storage is full.') : base['draft.save'](input))
  globalThis.__down = () => { down = true }
  globalThis.__up = () => { down = false }
} else if (scenario === 'draftcas') {
  globalThis.__otherTab = () => drafts.set('schedule', { draft: { text: 'Saved in another tab', annotations: [] }, revision: (drafts.get('schedule')?.revision ?? 0) + 1 })
} else if (scenario === 'durable') {
  await setValue(byLabel('Reply text'), 'Thursday instead', 'input')
  globalThis.__down()
  await click(find('button', 'Submit reply'))
  assert.equal(callsOf('submitReply').length, 0); ok('nothing is sent while the attempt cannot be saved')
  assert.match(text(), /Not sent\. This reply attempt could not be saved first, so a later retry could not reuse its reply ID\. The Decision Inbox is unavailable\. Storage is full\./); ok('save failure reported; no retry-safety claim')
  assert.match(text(), /Draft not saved/); assert.equal(step(), '● Awaiting answer')
  const id = (draft) => draft?.replyId
  const attempted = callsOf('draft.save').at(-1).draft.replyId
  globalThis.__up()
  await click(findStart('button', 'Retry (same reply ID'))
  assert.equal(last('submitReply').replyId, attempted); assert.equal(id(drafts.get('schedule').draft), undefined)
  const iSend = calls.findIndex((c) => c.name === 'submitReply')
  assert.equal(calls.slice(0, iSend).filter((c) => c.name === 'draft.save').at(-1).input.draft.replyId, attempted)
  assert.equal(callsOf('draft.save').filter((x) => x.draft?.replyId === attempted).length >= 2, true); ok('retry sends only after the same reply ID is durably saved')
  assert.equal(step(), '● Submitted / awaiting confirmation'); ok('recorded on retry')
} else if (scenario === 'draftcas') {
  await setValue(byLabel('Reply text'), 'First edit', 'input'); await sleep(450)
  assert.equal(drafts.get('schedule').draft.text, 'First edit'); ok('draft saved at revision 1')
  globalThis.__otherTab()
  await setValue(byLabel('Reply text'), 'Second edit', 'input'); await sleep(450)
  assert.equal(drafts.get('schedule').draft.text, 'Saved in another tab'); ok('a stale save does not overwrite another tab')
  assert.match(text(), /This draft was changed in another tab or window/); assert.equal(byLabel('Reply text').value, 'Saved in another tab'); ok('conflict loads and shows the stored draft')
  await setValue(byLabel('Reply text'), 'Third edit', 'input'); await sleep(450)
  assert.equal(drafts.get('schedule').draft.text, 'Third edit'); ok('saving resumes from the stored revision')
} else if (scenario === 'winner') {
  handlers.submitReply = (input) => {
    // Another owner surface (native Needs you) was accepted first; the worker returns that winner.
    const d = db.get('stage')
    const win = { questionId: 'stage', replyId: 'reply-other-surface', kind: 'initial', answer: { kind: 'option', optionId: 'phase-one' }, annotations: [],
      acceptedAt: '2030-06-14T11:59:00Z', delivery: { state: 'agent-received', receipt: { questionId: 'stage', replyId: 'reply-other-surface', receiptId: 'receipt-win', origin: fx.origins.remote, receivedAt: '2030-06-14T12:00:30Z' } } }
    d.answerState = { state: 'answered', initial: win, followUps: [] }
    handlers.submitReply = () => errR('conflict', 'Reply ID reused with different content.')
    return okR(clone(win))
  }
} else if (scenario === 'followup') {
  db.set('layout', clone(fx.historyExample))
  handlers.retryReply = ({ questionId, replyId }) => {
    const d = db.get(questionId); const r = d.answerState.followUps.find((x) => x.replyId === replyId)
    r.delivery = { state: 'submitted' }
    return okR(clone(r))
  }
} else if (scenario === 'receipt') {
  const h = clone(fx.historyExample)
  h.answerState.initial.delivery.receipt.origin = { ...fx.origins.library, sessionId: 'some-other-chat' }
  db.set('layout', h)
} else if (scenario === 'errors') {
  handlers.getDecision = ({ questionId }) => questionId === 'secret' ? errR('forbidden', 'Not a participant.')
    : questionId === 'down' ? Promise.reject(hostError('unavailable', 'Worker stopped.')) : base.getDecision({ questionId })
} else if (scenario === 'offline') {
  worker.request = async (name, input) => { calls.push({ name, input }); throw hostError('unknown_method', 'none') }
} else if (scenario === 'native') {
  // A read-only native Bot Item, using the documented source fields (test-only row).
  db.set('native-x', { ...clone(db.get('schedule')), questionId: 'native-x', title: 'Ship the lantern build?', packageId: 'native-x',
    background: 'Release bot asks whether build 42 can ship.', recommendation: '',
    options: [{ optionId: 'ship', label: 'Ship it' }, { optionId: 'hold', label: 'Hold', detail: 'Wait for the next build' }],
    source: { kind: 'native-item', workspaceAttributed: false, botName: 'Release bot', itemLabel: '#12', itemStatus: 'needs-you', observedAt: '2030-06-14T11:30:00Z' },
    origin: { hostId: 'local', workspaceId: '', sessionId: '' }, actions: [] })
} else if (scenario === 'mail') {
  // Initial answer acknowledged by the origin; a follow-up whose mail was submitted but not yet
  // acknowledged; a second follow-up undelivered while the worker does not offer retry.
  const h = clone(fx.historyExample)
  h.answerState.followUps = [
    { questionId: 'layout', replyId: 'fu-mail', kind: 'follow-up', answer: { kind: 'text', text: 'Check the list view too.' }, annotations: [], acceptedAt: '2030-06-14T12:04:00Z',
      delivery: { state: 'submitted', transport: { messageId: 'mail-77', acceptedAt: '2030-06-14T12:05:00Z' } } },
    { questionId: 'layout', replyId: 'fu-failed', kind: 'follow-up', answer: { kind: 'text', text: 'And the tiles.' }, annotations: [], acceptedAt: '2030-06-14T12:06:00Z',
      delivery: { state: 'undelivered', reason: 'closed-origin' } }
  ]
  h.source = { kind: 'plugin' }; h.actions = ['follow-up']
  db.set('layout', h)
} else if (scenario === 'noactions') {
  // The worker reports no supported owner action (for example no owner principal on this host).
  db.get('schedule').actions = []
} else if (scenario === 'dashboard') {
  globalThis.__holdImage = false
  const get = base.getDecision
  handlers.getDecision = (input) => input.questionId === 'image-review' && globalThis.__holdImage
    ? new Promise((r) => { globalThis.__releaseImage = () => r(get(input)) }) : get(input)
} else if (scenario === 'dashfocus') {
  handlers['workspace.resolve'] = () => errR('unavailable', 'Two workspaces on different hosts use this ID.')
  handlers.getDecision = ({ questionId }) => questionId === 'stage' ? errR('unavailable', 'Bot reads are unavailable for this bot.')
    : questionId === 'layout' ? errR('forbidden', 'Not a participant.') : questionId === 'schedule' ? errR('not-found', 'Missing.') : base.getDecision({ questionId })
} else if (scenario === 'reader') {
  // Two questions in one package, Markdown background and a long Chinese recommendation (synthetic).
  const md = '確認發佈流程。**請決定是否發佈第 42 版。** 參考 [執行紀錄](https://example.invalid/run/42)。另見 https://example.invalid/notes/7。\n\n- 測試全部通過\n- 文件已更新\n\n參考 https://a.invalid/1、https://b.invalid/2 與 [C 文件](https://en.wikipedia.org/wiki/A_(b))，另見 https://example.invalid/run/42。下一句不是連結。\n\nsee [https://example.invalid/x] here, [https://ok.invalid](javascript:alert(1)) and http://[::1]:8080/a.'
  const long = Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 段：很長的中文建議。`).join('\n\n')
  for (const [i, title] of [[1, '第一題：是否發佈？'], [2, '第二題：何時發佈？']]) {
    db.set(`pkg-a-${i}`, { ...clone(db.get('schedule')), questionId: `pkg-a-${i}`, packageId: 'pkg-a', title, background: md, recommendation: long, createdAt: `2030-06-1${i}T09:00:00Z` })
  }
} else if (scenario === 'localonly') {
  // This host: the worker saves the answer plugin-locally, Orca mail has no supported plugin sender,
  // so the recorded reply is undelivered and retry is not offered.
  db.get('schedule').source = { kind: 'plugin' }; db.get('schedule').actions = ['reply']
  handlers.submitReply = (input) => {
    const rec = { ...clone(input), acceptedAt: '2030-06-14T12:03:00Z', delivery: { state: 'undelivered', reason: 'delivery-failed' } }
    const d = db.get('schedule'); d.answerState = { state: 'answered', initial: rec, followUps: [] }; d.actions = ['follow-up']
    return okR(clone(rec))
  }
} else if (scenario === 'race' || scenario === 'racebtn') {
  // Another owner surface (native Needs you) records the initial answer while the owner writes.
  globalThis.__otherSurface = () => {
    db.get('schedule').answerState = { state: 'answered', followUps: [], initial: {
      questionId: 'schedule', replyId: 'reply-native', kind: 'initial', answer: { kind: 'option', optionId: 'thu' }, annotations: [],
      acceptedAt: '2030-06-14T12:01:00Z', delivery: { state: 'agent-received', receipt: { questionId: 'schedule', replyId: 'reply-native', receiptId: 'rcpt-native', origin: fx.origins.studio, receivedAt: '2030-06-14T12:02:00Z' } } } }
  }
} else if (scenario === 'ambiguous') {
  // The worker records the reply, but the bridge times out before the answer arrives.
  handlers.submitReply = (input) => { base.submitReply(input); return Promise.reject(hostError('timeout', 'The worker did not answer in time.')) }
} else if (scenario === 'inflight') {
  let release = () => {}
  globalThis.__release = () => release()
  handlers.submitReply = (input) => new Promise((r) => { release = () => r(base.submitReply(input)) })
} else if (scenario === 'noreceipt') {
  handlers.submitReply = () => {
    const win = { questionId: 'schedule', replyId: 'reply-native', kind: 'initial', answer: { kind: 'option', optionId: 'thu' }, annotations: [], acceptedAt: '2030-06-14T11:59:00Z', delivery: { state: 'submitted' } }
    db.get('schedule').answerState = { state: 'answered', initial: win, followUps: [] }
    return okR(clone(win))
  }
} else if (scenario === 'narrow') {
  // Stored notes that block sending: one empty, one anchored to an older revision.
  drafts.set('image-review', { revision: 1, draft: { text: 'Side view is the baseline.', annotations: [
    { kind: 'selection', anchor: { kind: 'question', field: 'background', revision: 1 }, start: 0, end: 12, quote: 'Paper models', text: '' },
    { kind: 'selection', anchor: { kind: 'question', field: 'background', revision: 0 }, start: 0, end: 5, quote: 'Paper', text: 'Old note' }
  ] } })
}
if (scenario === 'settings' || scenario === 'settings2') {
  let revision = 3
  globalThis.__bumpSettings = () => { revision++ }
  const saved = { defaultTemplate: 'Title, Background, Recommendation, Options, Impact.', exceptions: [{ repo: 'Seed Catalogue', template: 'Title, Background and Options only.' }] }
  handlers['settings.get'] = () => okR({ ...clone(saved), revision })
  handlers['settings.repos'] = () => okR(['Seed Catalogue', 'Paper Studio', 'Lantern Workshop'])
  handlers['settings.effective'] = ({ repo }) => {
    const hit = saved.exceptions.find((e) => e.repo === repo)
    return okR(hit ? { template: hit.template, source: 'exception' } : { template: saved.defaultTemplate, source: 'default' })
  }
  handlers['settings.save'] = (input) => {
    if (input.revision !== revision) return errR('conflict', 'Stale revision.')
    saved.defaultTemplate = input.defaultTemplate; saved.exceptions = clone(input.exceptions); revision++
    return okR({ ...clone(saved), revision })
  }
}

await import(build('src/review.js'))
await settle()

if (scenario === 'review') {
  assert.equal(document.querySelector('h1').textContent, 'Compare seven paper model views'); ok('title from getDecision')
  assert.deepEqual(callsOf('getDecision'), [{ questionId: 'image-review' }]); ok('decision loaded by question ID from the worker')
  assert.deepEqual(all('h2.d-sec-h').map((h) => h.textContent).filter((t) => /Description|Background/.test(t)), ['Background']); ok('legacy decision (no description): only Background, no empty Description heading')
  assert.equal(all('.film button').length, 7); ok('seven snapshot buttons')
  assert.equal(all('.view').length, 1); ok('single large viewer by default (provisional)')
  const img = document.querySelector('.view img')
  assert.equal(img.getAttribute('alt'), 'Synthetic front wide view'); assert.match(img.getAttribute('src'), /^data:image\/png;base64,/)
  assert.deepEqual(last('getSnapshot'), { questionId: 'image-review', attachmentId: 'placeholder-1' }); ok('snapshot bytes come from getSnapshot, with alt text')
  await click(find('button', 'Compare side by side'))
  assert.equal(all('.view').length, 2); ok('compare opens two viewers')
  assert.equal(findStart('.film button', '1 · Front wide').getAttribute('aria-pressed'), 'true'); ok('aria-pressed is "true", not an empty attribute')
  await click(find('button', 'Left'))
  await click(findStart('.film button', '3 · Side square'))
  assert.match(all('.view')[0].getAttribute('aria-label'), /^Left viewer: Side square/); ok('keyboard-reachable Left target fills the left pane')
  await click(find('button', 'Right'))
  await click(findStart('.film button', '6 · Panorama'))
  assert.match(text(), /Snapshot expired or missing/); ok('not-found snapshot shows expired or missing')
  await click(findStart('.film button', '7 · Tall detail'))
  assert.match(text(), /You do not have access to this snapshot/); ok('forbidden snapshot is not shown')
  await click(findStart('.film button', '4 · Side landscape'))
  assert.match(text(), /Could not load the snapshot/); assert.ok(find('button', 'Try again')); ok('unavailable snapshot offers Try again')
  assert.ok(!/re-attach/i.test(text())); ok('no unsupported re-attach action')
  await setValue(byLabel('Note for Side square'), 'Check the fold')
  assert.match(document.querySelector('.side').textContent, /Notes \(1\)/); ok('image note listed in the sidebar')
  await setValue(byLabel('Note for Side square'), 'Check the fold twice', 'input')
  await changed()
  assert.equal(byLabel('Note for Side square').value, 'Check the fold twice'); ok('typing survives a worker-driven re-render')
  await setValue(byLabel('Note for Side square'), 'Check the fold')
  // Select "Paper models" in Background: UTF-16 offsets [0, 12) at revision 1.
  const bg = document.querySelector('[data-field="background"] p').firstChild
  select(range(bg, 0, 12))
  await key({ altKey: true, key: 'n' })
  assert.match(document.querySelector('.d-nc').textContent, /Note on the selected text[^]*Paper models/); assert.equal(document.activeElement, byLabel('New note')); ok('Alt+N opens the note composer next to the selection, with the quote')
  await click(document.querySelector('[data-k="nc-add"]'))
  assert.ok(document.querySelector('.d-nc')); assert.match(document.querySelector('.d-nc').textContent, /Write the note first/); ok('an empty note keeps the composer open')
  await addNote('Same paper stock')
  assert.equal(document.querySelector('.d-nc'), null); assert.match(document.querySelector('.side').textContent, /Notes \(2\)/); assert.ok(document.querySelector('#notesPanel').hasAttribute('hidden'))
  assert.equal(document.activeElement, document.querySelector('mark.d-n')); assert.equal(document.activeElement.getAttribute('tabindex'), '0'); ok('Add saves the note, closes the composer and the Notes panel; focus returns to the highlighted text')
  assert.match(text(), /Note saved with your draft \(2\)\. Not sent yet/); assert.equal(document.querySelector('mark.d-n').textContent, 'Paper models'); ok('quiet saved confirmation; the note is highlighted at its anchor')
  assert.ok(!/Draft not saved/.test(text())); assert.equal(last('draft.save').draft.annotations.length, 2); ok('the note is saved with the draft')
  await click(document.querySelector('[data-k="notes-edit"]'))
  assert.ok(!document.querySelector('#notesPanel').hasAttribute('hidden')); ok('Edit notes reopens the panel')
  await setValue(byLabel('Note text 2'), '', 'input'); await sleep(450)
  assert.deepEqual(callsOf('draft.save').map((x) => x.revision), callsOf('draft.save').map((_, i) => i)); ok('every save carries the stored revision')
  await setValue(byLabel('Reply text'), 'draft', 'input')
  await click(find('button', 'Submit reply'))
  assert.equal(callsOf('submitReply').length, 0); assert.match(text(), /Some notes are empty or no longer match the decision/); assert.ok(find('button', 'Review notes')); ok('an empty note blocks sending, with a way to review notes')
  await setValue(byLabel('Reply text'), '', 'input')
  await setValue(byLabel('Note text 2'), 'Use the same paper stock.')
  await click(find('button', 'Submit reply'))
  assert.equal(callsOf('submitReply').length, 0); assert.equal(step(), '● Awaiting answer'); ok('an empty reply is refused without a worker call')
  await setValue(byLabel('Reply text'), 'Use the side view as the comparison baseline.', 'input')
  await sleep(450)
  assert.equal(last('draft.save').draft.text, 'Use the side view as the comparison baseline.'); ok('draft persists through draft.save')
  await click(find('button', 'Submit reply'))
  const sent = last('submitReply')
  assert.match(sent.replyId, /^reply-[0-9a-f-]{36}$/); ok('unique per-attempt reply ID')
  const idx = calls.findIndex((c) => c.name === 'submitReply')
  assert.equal(calls.slice(0, idx).filter((c) => c.name === 'draft.save').at(-1).input.draft.replyId, sent.replyId); ok('reply ID saved in the draft before the attempt')
  assert.deepEqual(sent.answer, { kind: 'text', text: 'Use the side view as the comparison baseline.' })
  assert.deepEqual(sent.annotations, [
    { kind: 'image', evidence: { evidenceId: 'model-3', version: 1 }, text: 'Check the fold' },
    { kind: 'selection', anchor: { kind: 'question', field: 'background', revision: 1 }, start: 0, end: 12, quote: 'Paper models', text: 'Use the same paper stock.' }
  ]); ok('answer and anchored notes sent in one operation')
  assert.equal(step(), '● Submitted / awaiting confirmation'); ok('recorded reply shows Submitted / awaiting confirmation')
  assert.match(text(), /Mail hand-off to the original chat is not reported yet; waiting for that chat to acknowledge it\./); ok('no mail hand-off or receipt is claimed')
  await sleep(10)
  assert.equal(last('draft.save').draft, null); ok('draft cleared after the reply is recorded')
  assert.deepEqual(all('.d-milestones li').map((e) => e.textContent.replace(/ · .*/, '')), ['Opened', 'Answer saved', 'Next: Agent received appears only when the chat confirms.'].map((t) => t.replace(/ · .*/, ''))); assert.doesNotMatch(document.querySelector('.d-milestones').textContent, /Agent received ·|Submitted to Orca mail/); ok('state card lists only recorded milestones and one next step')
} else if (scenario === 'restart') {
  assert.equal(document.querySelector('input[type=radio][checked]')?.getAttribute('data-k') ?? all('input[type=radio]').find((r) => r.checked)?.getAttribute('data-k'), 'opt-tue'); ok('persisted option restored')
  assert.equal(byLabel('Reply text').value, 'Tuesday works'); ok('persisted text restored')
  await click(find('button', 'Submit reply'))
  assert.match(text(), /Not confirmed\. The Decision Inbox is unavailable\. The worker did not answer in time\. The reply may or may not have been recorded\./); ok('timeout reported as unconfirmed, not as not sent')
  assert.equal(step(), '● Awaiting answer'); ok('no state change without a recorded reply')
  assert.ok(find('button', 'Retry (same reply ID reply-persisted-1)')); ok('retry names the same reply ID')
  await key({ ctrlKey: true, key: 'Enter' })
  assert.deepEqual(callsOf('submitReply').map((r) => r.replyId), ['reply-persisted-1', 'reply-persisted-1']); ok('Ctrl+Enter retry reuses the persisted reply ID')
  assert.deepEqual(last('submitReply').answer, { kind: 'option', optionId: 'tue', detail: 'Tuesday works' }); ok('option with detail')
  assert.equal(step(), '● Submitted / awaiting confirmation'); ok('accepted on retry')
} else if (scenario === 'winner') {
  assert.match(text(), /host: paired/); ok('paired host shown')
  await click(all('input[type=radio]').find((r) => r.getAttribute('data-k') === 'opt-hold'), {})
  all('input[type=radio]').find((r) => r.getAttribute('data-k') === 'opt-hold').dispatchEvent(new window.Event('change', { bubbles: true })); await settle()
  await setValue(byLabel('Reply text'), 'Hold until the space is confirmed.', 'input')
  await click(find('button', 'Submit reply'))
  assert.match(text(), /Another answer was recorded first, so yours was not sent/); ok('winner reported, own answer not claimed')
  assert.match(text(), /Approve phase one only/); assert.match(text(), /Receipt receipt-win/); ok('winning recorded answer and its receipt shown')
  assert.equal(step(), '● Agent received'); ok('state follows the recorded winner')
  await sleep(10)
  const kept = last('draft.save').draft
  assert.equal(kept.kind, 'initial'); assert.equal(kept.replyId, undefined); assert.equal(kept.optionId, 'hold')
  assert.equal(byLabel('Follow-up'), null); assert.match(text(), /Your unsent answer[^]*Option: Hold trial\s*Hold until the space is confirmed\./); ok('owner answer kept as written (option included), not converted')
  await click(find('button', 'Write a follow-up from this text'))
  assert.equal(byLabel('Follow-up').value, 'Hold until the space is confirmed.'); ok('follow-up composed only on the explicit choice')
  await click(find('button', 'Send follow-up'))
  const fu = last('submitReply')
  assert.equal(fu.kind, 'follow-up'); assert.notEqual(fu.replyId, callsOf('submitReply')[0].replyId); ok('follow-up is a new attempt with a new reply ID')
  assert.match(text(), /Reply ID reply-[0-9a-f-]+ could not be used because a different reply was already recorded\. The recorded answer is shown below\. Your text is kept as a new draft\./); ok('conflict says what was recorded, not "changed elsewhere"')
} else if (scenario === 'bind') {
  await setValue(byLabel('Reply text'), 'Draft for schedule', 'input')
  byLabel('Reply text').focus()
  await changed()
  assert.equal(document.activeElement.getAttribute('data-k'), 'reply'); ok('focus survives a worker-driven re-render')
  replace('{"questionId":"layout"}'); await settle()
  const iSave = calls.findIndex((c) => c.name === 'draft.save' && c.input.questionId === 'schedule')
  const iGet = calls.findIndex((c) => c.name === 'draft.get' && c.input.questionId === 'layout')
  assert.ok(iSave >= 0 && iSave < iGet); assert.equal(calls[iSave].input.draft.text, 'Draft for schedule'); ok('old draft saved under its own question ID before switching')
  assert.equal(document.querySelector('h1').textContent, 'Choose the catalogue layout')
  assert.equal(byLabel('Reply text').value, ''); ok('new question starts with its own draft')
  replace('{"questionId":"schedule"}'); await settle()
  assert.equal(byLabel('Reply text').value, 'Draft for schedule'); ok('draft restored when the question opens again')
} else if (scenario === 'quiet') {
  // M1: the owner's own draft saves (and unrelated invalidations) must not rebuild what they type in.
  const h1 = document.querySelector('h1')
  const note = byLabel('Note for Front wide')
  note.focus()
  await setValue(note, 'Check the ', 'input')
  await sleep(450)
  assert.equal(last('draft.save').draft.annotations[0].text, 'Check the '); ok('note text is stored as typed, trailing space kept')
  await changed()
  assert.equal(byLabel('Note for Front wide'), note); assert.equal(note.value, 'Check the '); ok('own draft save: the focused field is not rebuilt or trimmed')
  assert.equal(document.querySelector('h1'), h1); ok('unchanged decision: no re-render at all')
  db.get('image-review').title = 'Compare seven paper model views (revised)'
  await changed()
  assert.equal(document.querySelector('h1').textContent, 'Compare seven paper model views'); assert.equal(byLabel('Note for Front wide'), note); ok('a real change waits while the owner types')
  assert.match(document.querySelector('[aria-live="polite"][role="status"]').textContent, /changed elsewhere/); ok('the waiting change is announced')
  document.body.focus(); note.dispatchEvent(new window.Event('focusout', { bubbles: true })); await settle()
  assert.equal(document.querySelector('h1').textContent, 'Compare seven paper model views (revised)'); ok('the change applies when the owner leaves the field')
  assert.equal(byLabel('Note for Front wide').value, 'Check the '); ok('typed note survives the update')
} else if (scenario === 'ime') {
  const ta = byLabel('Reply text'); ta.focus()
  document.dispatchEvent(new window.Event('compositionstart'))
  await setValue(ta, '星期', 'input')
  db.get('schedule').title = 'Pick a rehearsal slot (moved)'
  await changed()
  document.body.focus(); ta.dispatchEvent(new window.Event('focusout', { bubbles: true })); await settle()
  assert.equal(byLabel('Reply text'), ta); assert.equal(document.querySelector('h1').textContent, 'Pick a rehearsal slot'); ok('no re-render during IME composition, even after focus moves')
  document.dispatchEvent(new window.Event('compositionend')); await settle()
  assert.equal(document.querySelector('h1').textContent, 'Pick a rehearsal slot (moved)'); assert.equal(byLabel('Reply text').value, '星期'); ok('composition end applies the change, text kept')
} else if (scenario === 'ambiguous') {
  await setValue(byLabel('Reply text'), 'Thursday please', 'input')
  await click(find('button', 'Submit reply'))
  const id = last('submitReply').replyId
  assert.match(text(), new RegExp(`Your answer was recorded \\(reply ID ${id}\\)\\. Submitted / awaiting confirmation\\.`)); ok('a timed-out submit that was recorded says recorded, with its actual state')
  assert.doesNotMatch(text(), /Not confirmed|Not sent/); assert.equal(findStart('button', 'Retry (same reply ID'), undefined); ok('no false "not sent" and no empty Retry')
  assert.equal(step(), '● Submitted / awaiting confirmation'); assert.doesNotMatch(text(), /Receipt /); ok('no receipt claimed')
  await sleep(10)
  assert.equal(drafts.get('schedule').draft, null); ok('recorded draft cleared')
} else if (scenario === 'inflight') {
  await setValue(byLabel('Reply text'), 'Tuesday', 'input')
  await click(find('button', 'Submit reply'))
  await click(find('button', 'Sending…'))
  await key({ ctrlKey: true, key: 'Enter' })
  assert.equal(callsOf('submitReply').length, 1); ok('one submit while one is in flight (button and Ctrl+Enter)')
  assert.ok(byLabel('Reply text').hasAttribute('readonly')); assert.ok(all('input[type=radio]').every((r) => r.hasAttribute('disabled'))); ok('compose fields locked while sending, so no typing is lost')
  globalThis.__release(); await settle()
  assert.equal(step(), '● Submitted / awaiting confirmation'); assert.ok(!byLabel('Follow-up').hasAttribute('readonly')); ok('unlocked after the worker answers')
} else if (scenario === 'noreceipt') {
  await setValue(byLabel('Reply text'), 'Tuesday', 'input')
  await click(find('button', 'Submit reply'))
  assert.match(text(), /Another answer was recorded first, so yours was not sent\. The recorded answer is shown below \(Submitted \/ awaiting confirmation, no receipt yet\)/); ok('winner notice names its actual state and claims no receipt')
} else if (scenario === 'followup') {
  assert.equal(document.querySelector('h1').textContent, 'Choose the catalogue layout'); ok('title')
  const overdue = () => all('.callout').find((e) => e.textContent === 'Overdue 25h.')
  assert.equal(overdue().getAttribute('role'), 'alert'); ok('overdue alert announced once')
  assert.match(text(), /Overdue 25h · 13 Jun 2030, 11:00 UTC/); ok('full deadline in the desktop zone')
  assert.match(text(), /Answer · accepted/); assert.match(text(), /Receipt layout-receipt/); ok('recorded answer with its receipt')
  assert.match(text(), /matte sample/); ok('long conditional answer intact')
  assert.equal(find('button', 'Submit reply'), undefined); assert.equal(all('input[type=radio]').length, 0); ok('no initial reply form once answered')
  assert.equal(find('button', 'Send follow-up').getAttribute('aria-disabled'), 'true'); ok('empty follow-up is aria-disabled')
  await setValue(byLabel('Follow-up'), 'Please also check the list view.', 'input')
  assert.equal(find('button', 'Send follow-up').getAttribute('aria-disabled'), 'false'); ok('send enabled once text is typed')
  await click(find('button', 'Send follow-up'))
  const fu = last('submitReply')
  assert.equal(fu.kind, 'follow-up'); assert.deepEqual(fu.answer, { kind: 'text', text: 'Please also check the list view.' })
  assert.equal(all('.reply').length, 2); assert.match(text(), /Follow-up 1/); ok('follow-up appended as a second reply')
  assert.match(text(), /matte sample/); assert.match(text(), /Receipt layout-receipt/); ok('original answer and receipt unchanged')
  db.get('layout').answerState.followUps[0].delivery = { state: 'undelivered', reason: 'closed-origin' }
  await changed()
  assert.match(text(), /Undelivered\. Saved in Decision Inbox, but not delivered to the original chat\. The original chat is closed\./); ok('inbox.changed refetch shows undelivered with its reason')
  await click(find('button', 'Copy reply'))
  assert.deepEqual(copied, ['Please also check the list view.']); ok('Copy reply copies the recorded text')
  await click(find('button', 'Retry (same reply ID, same destination)'))
  assert.deepEqual(last('retryReply'), { questionId: 'layout', replyId: fu.replyId }); ok('retry uses the original reply ID')
  assert.ok(!/Undelivered\. Saved in Decision Inbox/.test(text())); ok('retried reply is pending again, not received')
  assert.equal(overdue().getAttribute('role'), null); ok('re-renders do not re-announce the same alert')
} else if (scenario === 'receipt') {
  assert.equal(step(), '● Submitted / awaiting confirmation'); ok('receipt from another chat is not Agent received')
  assert.match(text(), /does not match this reply and origin/); ok('mismatch explained')
} else if (scenario === 'package') {
  assert.match(text(), /Approve the reading room reset window · Awaiting answer/); ok('same-package question with its own state')
  await click(byLabel('Open Approve the reading room reset window'))
  assert.deepEqual(last('review.open'), { questionId: 'room-reset' }); ok('opens the other question through review.open')
  handlers['review.open'] = () => errR('unavailable', 'No supported editor seam.')
  await click(byLabel('Open Approve the reading room reset window'))
  assert.match(text(), /Could not open that question\. The Decision Inbox is unavailable\. No supported editor seam\./); ok('open failure reported')
  await click(findStart('a', 'Reading room plan · v2'))
  assert.deepEqual(opened, ['https://example.invalid/evidence/floor-plan']); ok('linked evidence opens externally with its version')
  assert.equal(document.querySelector('[data-k="copy-link"]').getAttribute('aria-label'), 'Copy decision link')
  await click(document.querySelector('[data-k="copy-link"]'))
  assert.deepEqual(copied, ['https://example.invalid/inbox/room-route']); ok('decision link copied (labelled icon control)')
  // L7: a triple-click ends at the start of the next element; the quote is clipped to the field.
  const bgNode = document.querySelector('[data-field="background"] p').firstChild
  const full = fx.decisions.find((x) => x.questionId === 'room-route').background
  select(range(bgNode, 0, 0, { endAfter: true, endContainer: document.querySelector('[data-field="background"]').nextElementSibling }))
  // L6: macOS Option+N reports a dead key; the physical key code still matches.
  await key({ altKey: true, key: 'Dead', code: 'KeyN' })
  assert.ok(document.querySelector('.d-nc')); ok('Alt+N by key code (macOS dead key) opens the composer')
  await addNote('Whole paragraph'); await sleep(450)
  assert.match(document.querySelector('.side').textContent, /Notes \(1\)/)
  const n = last('draft.save').draft.annotations[0]
  assert.equal(n.quote, full); assert.deepEqual([n.start, n.end], [0, full.length]); ok('triple-click selection quotes the whole field with exact offsets')
  assert.ok(document.querySelector('.vp') === null || !document.querySelector('.vp').getAttribute('style')); ok('viewer layout uses classes, not an inline column count')
} else if (scenario === 'narrow') {
  assert.equal(find('button', 'Notes (2) · 2 need attention').getAttribute('data-k'), 'notes-open'); ok('narrow layout: the notes button says notes need attention')
  await click(find('button', 'Submit reply'))
  assert.equal(callsOf('submitReply').length, 0); assert.ok(find('button', 'Review notes')); ok('blocked send offers Review notes')
  await click(find('button', 'Review notes'))
  const dlg = document.querySelector('dialog')
  assert.ok(dlg.hasAttribute('open')); assert.equal(dlg.querySelectorAll('[data-dialog-note]').length, 2); ok('the dialog lists every note for review')
  assert.match(dlg.textContent, /This note is empty/); assert.match(dlg.textContent, /The text changed since this note was made/); ok('each blocking problem is shown')
  await setValue(dlg.querySelector('[data-dialog-note="0"]'), 'Same paper stock', 'input')
  await click(dlg.querySelector('[aria-label="Remove note 2"]'))
  assert.equal(dlg.querySelectorAll('[data-dialog-note]').length, 1); ok('notes can be edited and removed at narrow width')
  await click(find('button', 'Done'))
  assert.ok(!dlg.hasAttribute('open'))
  // Add a note from a selection at narrow width.
  // "Paper models" is already highlighted (a <mark>), so the plain text after it starts at raw offset 12.
  const bg = [...document.querySelector('[data-field="background"] p').childNodes].find((n) => n.nodeType === 3)
  select(range(bg, 1, 4))
  await key({ altKey: true, key: 'n', code: 'KeyN' })
  assert.ok(document.querySelector('.d-nc') && !dlg.hasAttribute('open')); await addNote('Check angles')
  selection = { rangeCount: 0, isCollapsed: true }; document.dispatchEvent(new window.Event('selectionchange')); await settle()
  await click(find('button', 'Submit reply'))
  assert.deepEqual(last('submitReply').annotations.map((x) => [x.quote, x.text]), [['Paper models', 'Same paper stock'], ['use', 'Check angles']]); ok('sent with the fixed and the new note')
} else if (scenario === 'settings2') {
  await setValue(byLabel('Preview repo'), '(any other repo)')
  await changed()
  assert.equal(byLabel('Preview repo').querySelector('option[selected]').getAttribute('value'), '(any other repo)'); ok('an unrelated invalidation keeps the chosen preview repo')
  const ta = byLabel('Default question template'); const save = find('button', 'Save'); ta.focus()
  await setValue(ta, 'Only titles.', 'input')
  assert.match(text(), /Unsaved changes/); assert.equal(save.getAttribute('aria-disabled'), 'false'); ok('typing updates Save and status in place')
  await changed()
  assert.doesNotMatch(text(), /changed elsewhere/); assert.equal(byLabel('Default question template'), ta); ok('no false "changed elsewhere" for unrelated invalidations')
  ta.dispatchEvent(new window.Event('change', { bubbles: true })); await settle()
  assert.equal(find('button', 'Save'), save); ok('leaving the field does not rebuild the Save button')
  globalThis.__bumpSettings()
  await changed()
  document.body.focus(); ta.dispatchEvent(new window.Event('focusout', { bubbles: true })); await settle()
  assert.match(text(), /Settings were changed elsewhere/); assert.equal(byLabel('Default question template').value, 'Only titles.'); ok('a real revision change is flagged and unsaved edits kept')
  await click(find('button', 'Save'))
  assert.equal(callsOf('settings.save').length, 1); assert.match(text(), /changed elsewhere since you opened them, so nothing was saved/); ok('first click saves (and the stale revision is refused truthfully)')
} else if (scenario === 'native') {
  assert.equal(document.querySelector('h1').textContent, 'Ship the lantern build?'); ok('native item title')
  assert.match(text(), /Bot Item · read-only/); assert.match(text(), /No workspace attribution/); ok('source and missing workspace attribution are labelled')
  const dock = document.querySelector('.dock')
  assert.match(dock.textContent, /Answer in Orca's Bot Items: bot “Release bot”, item #12/); assert.match(dock.textContent, /Read-only copy: Decision Inbox cannot answer, resolve or open this Item for you\./); ok('docked footer says where to answer, without a deep link or a write')
  assert.match(text(), /Status in OrcaNeeds you · as of 14 Jun 2030, 11:30 UTC/); ok('status as Orca reported it, with time (in Details)')
  assert.deepEqual(all('.dock li').map((e) => e.textContent), ['Ship it', 'Hold — Wait for the next build']); ok('options listed once, in the footer')
  assert.equal(text().split('Ship it').length - 1, 1); ok('no duplicated options')
  assert.ok(document.querySelector('.d-sheet-body').contains(document.querySelector('h1')) && !dock.closest('.d-sheet-body') && dock.parentElement === document.querySelector('.d-sheet')); ok('question in the scrolling body; read-only card below it')
  assert.ok(find('button', 'Copy location')); ok('Copy location offered (no deep link)')
  assert.equal(all('input, textarea, select').length, 0); assert.equal(find('button', 'Submit reply'), undefined); assert.equal(document.querySelector('[data-k="use-rec"]'), null); ok('no reply, note, option or Use-recommendation controls')
  assert.equal(document.querySelector('.strip'), null); assert.equal(document.querySelector('aside'), null); ok('no plugin delivery strip or notes sidebar')
  assert.equal(all('a').length, 1); assert.equal(all('a')[0].textContent.trim(), 'Synthetic project record ↗'); ok('no fabricated link to the item')
  await key({ ctrlKey: true, key: 'Enter' })
  assert.equal(document.querySelector('[data-field]'), null); ok('no selectable note fields')
  assert.deepEqual(calls.map((c) => c.name), ['getDecision', 'listDecisionPage']); ok('only reads (detail and its package page): no draft, snapshot or reply requests')
} else if (scenario === 'mail') {
  assert.match(text(), /Receipt layout-receipt/); ok('initial answer: origin acknowledgement shown')
  assert.match(text(), /Follow-up 1[^]*● Submitted \/ awaiting confirmationMail submitted to the original chat at 14 Jun 2030, 12:05 UTC \(message mail-77\); waiting for that chat to acknowledge it\./); ok('follow-up: mail submitted is not shown as received')
  assert.match(text(), /Undelivered\. Saved in Decision Inbox, but not delivered to the original chat\. The original chat is closed\. Retry is not available here; copy the reply and paste it into that chat if it is needed now\./); ok('undelivered without a supported retry says so')
  assert.equal(find('button', 'Retry (same reply ID, same destination)'), undefined); assert.ok(find('button', 'Copy reply')); ok('only supported actions: Copy, no Retry')
  assert.ok(find('button', 'Send follow-up')); ok('follow-up offered because the worker lists it')
} else if (scenario === 'noactions') {
  assert.equal(find('button', 'Submit reply'), undefined); assert.equal(byLabel('Reply text'), null); ok('no reply form when the worker offers no reply')
  assert.match(text(), /Replying here is not available for this decision right now\./); ok('plain explanation instead')
  await key({ ctrlKey: true, key: 'Enter' })
  assert.equal(callsOf('submitReply').length, 0); ok('Ctrl+Enter sends nothing')
} else if (scenario === 'dashboard') {
  // The newFiles template is the reference this editor opens.
  const tpl = readFileSync(path.join(root, 'templates/dashboard.orca-decision'), 'utf8')
  assert.equal(tpl.trim(), files.dashboard); ok('the newFiles template is the dashboard reference')
  const manifest = JSON.parse(readFileSync(path.join(root, 'orca-plugin.json'), 'utf8'))
  const nf = manifest.contributes.newFiles.find((x) => x.id === 'dashboard')
  assert.equal(nf.template, 'templates/dashboard.orca-decision'); assert.ok(manifest.contributes.customEditors.find((x) => x.id === 'review').extensions.includes(nf.extension)); ok('newFiles opens in the existing review editor')
  const rows = () => all('.qrow').map((b) => b.querySelector('.qt').textContent)
  assert.deepEqual(rows(), ['Compare seven paper model views', 'Pick a rehearsal slot']); ok('This workspace queue, most urgent first')
  assert.deepEqual(last('listDecisionPage').scope, { kind: 'workspace', workspace: { hostId: 'local', workspaceId: 'studio' } }); ok('scoped by host + workspace')
  assert.equal(document.querySelector('.d-sheet'), null); assert.deepEqual(all('[role=tab]').map((t) => [t.textContent, t.getAttribute('aria-selected')]), [['Pending2', 'true'], ['Answered0', 'false'], ['All2', 'false']]); ok('Pending / Answered / All tabs with counts; no sheet until a row is chosen')
  assert.ok(document.querySelector('.d-tabs-row [data-k="ws-select"]')); assert.equal(document.querySelector('.d-tabs-row').lastElementChild.querySelector('select').getAttribute('data-k'), 'ws-select'); ok('workspace selector is the last item of the tabs row')
  assert.ok(!all('tr.d-row').some((r) => /Question\s*\d+\s*(\/|of)\s*\d+/.test(r.textContent))); ok('no "Question x/N" in table rows')
  await click(find('.qrow .qt', 'Pick a rehearsal slot').parentElement)
  assert.equal(document.querySelector('.d-sheet h1').textContent, 'Pick a rehearsal slot'); assert.ok(document.querySelector('tr.d-row[data-sel]')); assert.equal(document.querySelector('.d-sheet').getAttribute('aria-modal'), 'false'); assert.equal(document.querySelector('.qrow[aria-current="true"] .qt').textContent, 'Pick a rehearsal slot'); ok('selecting a row opens it in this tab')
  await setValue(byLabel('Reply text'), 'Tuesday morning', 'input')
  await click(find('.qrow .qt', 'Compare seven paper model views').parentElement)
  const iSave = calls.findIndex((c) => c.name === 'draft.save' && c.input.questionId === 'schedule' && c.input.draft?.text === 'Tuesday morning')
  assert.ok(iSave >= 0); ok('the previous draft is saved under its own question when switching')
  await click(find('.qrow .qt', 'Pick a rehearsal slot').parentElement)
  assert.equal(byLabel('Reply text').value, 'Tuesday morning'); ok('and restored when returning')
  assert.equal(callsOf('review.open').length, 0); ok('no extra tabs opened')
  // Race: a slow decision must not replace the one selected after it.
  globalThis.__holdImage = true
  const slow = click(find('.qrow .qt', 'Compare seven paper model views').parentElement)
  await settle()
  await click(find('.qrow .qt', 'Pick a rehearsal slot').parentElement)
  globalThis.__releaseImage(); await slow; await settle()
  assert.equal(document.querySelector('.d-sheet h1').textContent, 'Pick a rehearsal slot'); ok('a late answer never replaces the selected decision')
  // Search keeps focus while the list repaints; scope changes.
  const search = byLabel('Search decisions'); search.focus()
  await setValue(search, 'layout', 'input'); await sleep(300); await settle()
  assert.equal(last('listDecisionPage').query, 'layout'); assert.equal(document.activeElement, search); ok('search runs on the worker and the field keeps focus')
  // A slow, older search answer never replaces the newer one.
  let releaseOld = () => {}
  handlers.listDecisionPage = (i) => i.query === 'zzz' ? new Promise((r) => { releaseOld = () => r(okR({ rows: [] })) }) : base.listDecisionPage(i)
  await setValue(search, 'zzz', 'input'); await sleep(300); await settle()
  await setValue(search, '', 'input'); await sleep(300); await settle()
  releaseOld(); await settle()
  assert.deepEqual(rows(), ['Compare seven paper model views', 'Pick a rehearsal slot']); ok('a stale search answer is dropped')
  delete handlers.listDecisionPage
  await chooseWs('all')
  assert.deepEqual(last('listDecisionPage').scope, { kind: 'all' }); assert.ok(rows().includes('Approve the first lantern trial')); ok('All workspaces scope')
  // Keyboard: arrow keys move between rows.
  const first = all('.qrow')[0]; first.focus()
  const ev = new window.Event('keydown', { bubbles: true }); Object.assign(ev, { key: 'ArrowDown' }); first.dispatchEvent(ev)
  assert.equal(document.activeElement, all('.qrow')[1]); ok('ArrowDown moves to the next row')
  // Source availability and mail, once each.
  handlers.listDecisionPage = (i) => ({ ...base.listDecisionPage(i), value: { ...base.listDecisionPage(i).value,
    sources: [{ source: 'plugin', state: 'available' }, { source: 'native-item', state: 'unavailable', message: 'No authorized Bot Items reader.' }],
    mail: { state: 'unavailable', message: 'Answers are saved in Decision Inbox. Orca mail from this plugin is unavailable on this host.' } } })
  await changed()
  assert.match(text(), /Bot Items are unavailable\. No authorized Bot Items reader\. Chat decisions below are not affected\./); ok('source availability shown')
  assert.equal(text().split('Answers are saved in Decision Inbox').length - 1, 1); ok('mail notice once')
  assert.match(document.head.textContent, /@media \(max-width: 899px\) \{\.d-app \.d-workspace\.d-has-sheet \{ grid-template-columns: minmax\(0, 1fr\); \} \.d-app \.d-sheet \{ position: fixed; inset: 0;/); ok('narrow sheet rule present')
  // Esc closes the sheet and focus returns to the row.
  await click(find('.qrow .qt', 'Pick a rehearsal slot').parentElement)
  await key({ key: 'Escape' })
  assert.equal(document.querySelector('.d-sheet'), null); ok('Esc closes the sheet')
  // Resize separator: Home = minimum, End = maximum (ARIA separator pattern); Shift+Arrow = 96px.
  await click(find('.qrow .qt', 'Pick a rehearsal slot').parentElement)
  const sep = document.querySelector('[data-k="divider"]')
  const kd = (init) => { const e = new window.Event('keydown', { bubbles: true, cancelable: true }); Object.assign(e, init); sep.dispatchEvent(e) }
  kd({ key: 'Home' }); assert.equal(sep.getAttribute('aria-valuenow'), sep.getAttribute('aria-valuemin')); assert.equal(sep.getAttribute('aria-valuenow'), '380')
  kd({ key: 'End' }); assert.equal(sep.getAttribute('aria-valuenow'), sep.getAttribute('aria-valuemax')); ok('Home sets the minimum and End the maximum width')
  kd({ key: 'Home' }); kd({ key: 'ArrowLeft', shiftKey: true }); assert.equal(sep.getAttribute('aria-valuenow'), '476'); ok('Shift+ArrowLeft widens by 96px')
  kd({ key: 'Enter' }); assert.match(sep.getAttribute('aria-valuetext'), /\(default\)$/); ok('Enter resets to the default width')
  // A typed but unsaved note is kept in its own question's draft when another question is opened.
  select(range([...document.querySelectorAll('[data-field="background"] p')][0].firstChild, 0, 4))
  await key({ altKey: true, key: 'n', code: 'KeyN' })
  await setValue(byLabel('New note'), 'keep me', 'input')
  await click(find('.qrow .qt', 'Compare seven paper model views').parentElement); await sleep(50)
  const keptSave = callsOf('draft.save').filter((c) => c.questionId === 'schedule').at(-1)
  assert.deepEqual(keptSave.draft.annotations.map((a) => a.text), ['keep me']); assert.equal(document.querySelector('.d-nc'), null)
  assert.match(text(), /Your unsaved note was kept with the draft of “Pick a rehearsal slot”\. Not sent\./)
  assert.ok(!callsOf('draft.save').some((c) => c.questionId === 'image-review' && c.draft?.annotations?.some((a) => a.text === 'keep me'))); ok('switching questions keeps the typed note in its own draft and says so')
  await click(find('.qrow .qt', 'Pick a rehearsal slot').parentElement)
  assert.match(document.querySelector('[data-k="notes-open"]').textContent, /Notes \(1\)/); ok('and it is there when the question is reopened')
} else if (scenario === 'dashnarrow') {
  assert.equal(document.querySelector('.d-sheet'), null); assert.equal(document.querySelector('.d-list-side').hasAttribute('inert'), false); ok('narrow: list first, nothing auto-opened')
  await click(find('.qrow .qt', 'Pick a rehearsal slot').parentElement)
  assert.equal(document.querySelector('.d-sheet h1').textContent, 'Pick a rehearsal slot'); assert.equal(document.querySelector('.d-sheet').getAttribute('role'), 'dialog'); assert.equal(document.querySelector('.d-sheet').getAttribute('aria-modal'), 'true')
  assert.ok(document.querySelector('.d-list-side').hasAttribute('inert')); ok('narrow: a modal sheet over an inert list')
  await setValue(byLabel('Reply text'), 'Thursday', 'input')
  assert.equal(document.querySelector('[data-k="sheet-back"]').getAttribute('aria-label'), 'Back to the decision list')
  await click(document.querySelector('[data-k="sheet-back"]'))
  assert.equal(document.querySelector('.d-sheet'), null); assert.equal(document.querySelector('.d-list-side').hasAttribute('inert'), false); ok('Back returns to the list')
  await sleep(10)
  assert.ok(calls.some((c) => c.name === 'draft.save' && c.input.draft?.text === 'Thursday')); ok('draft saved on Back')
  await click(find('.qrow .qt', 'Pick a rehearsal slot').parentElement)
  assert.equal(byLabel('Reply text').value, 'Thursday'); ok('draft still there when reopened')
} else if (scenario === 'dashfocus') {
  assert.match(text(), /Could not identify the focused workspace\. The Decision Inbox is unavailable\. Two workspaces on different hosts use this ID\./); ok('ambiguous focus is explained')
  assert.equal(callsOf('listDecisionPage').length, 0); assert.ok(!/Nothing needs you/.test(text())); ok('no list is read and no "nothing needs you" claim')
  assert.equal(document.querySelector('[data-k="ws-select"] option[selected]').getAttribute('value'), ''); assert.match(text(), /Choose a workspace or All workspaces/); ok('the Workspace list asks for a choice')
  await chooseWs('all')
  assert.equal(callsOf('listDecisionPage').filter((c) => !c.query).every((c) => c.scope.kind === 'all'), true)
  assert.ok(callsOf('listDecisionPage').some((c) => !c.query && c.scope.kind === 'all')); ok('All workspaces only on the explicit action')
  await click(find('.qrow .qt', 'Approve the first lantern trial').parentElement)
  assert.match(document.querySelector('.d-sheet-slot').textContent, /Could not load decision "stage"\. The Decision Inbox is unavailable\. Bot reads are unavailable for this bot\./); assert.ok(find('button', 'Try again')); ok('read failure: says so, with Try again')
  await click(find('.qrow .qt', 'Choose the catalogue layout').parentElement)
  assert.match(document.querySelector('.d-sheet-slot').textContent, /You do not have access to decision "layout"/); ok('no access is distinct')
  await click(find('.qrow .qt', 'Pick a rehearsal slot').parentElement)
  assert.match(document.querySelector('.d-sheet-slot').textContent, /Decision "schedule" was not found/); ok('missing record is distinct')
} else if (scenario === 'dashscope') {
  const sel = () => document.querySelector('[data-k="ws-select"]')
  const opts = () => [...sel().querySelectorAll('option')].filter((o) => !o.hasAttribute('disabled')).map((o) => o.textContent)
  const chosen = () => sel().querySelector('option[selected]')?.getAttribute('value')
  assert.ok(sel().closest('.d-tabs-row') && sel().closest('.d-tabs-row').querySelector('.d-tabs')); assert.equal(sel().getAttribute('aria-label'), 'Workspace'); ok('one labelled Workspace select in the tabs row')
  assert.deepEqual(opts(), ['All workspaces', 'studio · Local Orca', 'library', 'studio · paired', 'archive']); ok('All workspaces plus every authorized workspace, empty ones included; equal names show the host')
  assert.ok(!opts().some((t) => /This workspace/.test(t)) && !document.querySelector('[data-k="chip-workspace"]')); ok('no "This workspace" duplicate and no workspace chip')
  assert.equal(chosen(), wsVal('local', 'studio')); assert.deepEqual(last('listDecisionPage').scope, { kind: 'workspace', workspace: { hostId: 'local', workspaceId: 'studio' } }); ok('starts on the focused workspace, named; request is host-qualified')
  assert.ok(document.querySelector('[data-k="group-by"]').closest('.d-toolbar')); ok('Group by stays a separate control')
  // Empty authorized workspace.
  await chooseWs(wsVal('local', 'archive'))
  assert.deepEqual(last('listDecisionPage').scope, { kind: 'workspace', workspace: { hostId: 'local', workspaceId: 'archive' } }); assert.match(text(), /Nothing needs you in archive\./); assert.equal(all('tr.d-row').length, 0); ok('an empty workspace is an ordinary empty state')
  // Same name on another host.
  await chooseWs(wsVal('paired', 'studio'))
  assert.deepEqual(last('listDecisionPage').scope, { kind: 'workspace', workspace: { hostId: 'paired', workspaceId: 'studio' } })
  assert.deepEqual(all('.qrow .qt').map((e) => e.textContent), ['Approve the first lantern trial']); ok('paired studio lists only its own rows, not local studio')
  // A slow answer for the previous scope never lands; a new scope never reuses a cursor.
  let release = () => {}
  const paged = (i) => { const r = base.listDecisionPage(i); const start = i.cursor ? Number(i.cursor) : 0; const rows = r.value.rows.slice(start, start + 2); return okR({ rows, ...(start + 2 < r.value.rows.length ? { nextCursor: String(start + 2) } : {}) }) }
  handlers.listDecisionPage = (i) => i.scope.kind === 'all' && !i.cursor ? new Promise((r) => { release = () => r(paged(i)) }) : paged(i)
  const slow = chooseWs('all'); await settle()
  await chooseWs(wsVal('local', 'studio'))
  release(); await slow; await settle()
  assert.equal(chosen(), wsVal('local', 'studio')); assert.deepEqual(all('.qrow .qt').map((e) => e.textContent).sort(), ['Compare seven paper model views', 'Pick a rehearsal slot']); ok('a late answer for the previous scope is dropped')
  handlers.listDecisionPage = paged
  await chooseWs('all')
  assert.ok(find('button', 'Load more')); await click(find('button', 'Load more'))
  assert.deepEqual(last('listDecisionPage'), { scope: { kind: 'all' }, includeHistory: true, timeZone: 'UTC', cursor: '2' }); ok('Load more keeps the scope and uses the page cursor')
  await chooseWs(wsVal('local', 'library'))
  assert.deepEqual(last('listDecisionPage'), { scope: { kind: 'workspace', workspace: { hostId: 'local', workspaceId: 'library' } }, includeHistory: true, timeZone: 'UTC' }); ok('changing the scope starts a first page (stale cursor cleared)')
  delete handlers.listDecisionPage
  // Drafts stay bound to their question across workspace changes.
  await click(find('.qrow .qt', 'Approve the reading room route').parentElement)
  await setValue(byLabel('Reply text'), 'East entrance', 'input')
  await chooseWs(wsVal('local', 'studio'))
  assert.equal(document.querySelector('.d-sheet h1').textContent, 'Approve the reading room route'); assert.equal(byLabel('Reply text').value, 'East entrance'); ok('the open decision and its draft survive a workspace change')
  await sleep(450); assert.equal(drafts.get('room-route').draft.text, 'East entrance'); ok('the draft is saved under its own question')
  // A chosen workspace the worker refuses: ask; never widen.
  await chooseWs(wsVal('local', 'library'))
  handlers.listDecisionPage = (i) => i.scope.kind === 'workspace' ? errR('forbidden', 'Not authorized for that workspace.') : base.listDecisionPage(i)
  const before = callsOf('listDecisionPage').length
  await setValue(byLabel('Search decisions'), 'room', 'input'); await sleep(300); await settle()
  assert.match(text(), /library is no longer available\./); assert.equal(all('tr.d-row').length, 0)
  assert.ok(callsOf('listDecisionPage').slice(before).every((c) => c.scope.kind === 'workspace')); ok('a refused workspace asks for a choice and is never widened')
} else if (scenario === 'reader') {
  assert.equal(document.querySelector('h1').textContent, '第一題：是否發佈？'); ok('active question first')
  assert.equal(document.querySelector('.pager span').textContent, '1 / 2'); assert.equal(document.querySelector('.pager span').getAttribute('aria-label'), 'Question 1 of 2'); assert.ok(document.querySelector('.d-dock .pager')); ok('pager 1 / 2 in the reply card')
  assert.equal(all('[data-field="recommendation"]').length, 1); assert.ok(document.querySelector('.d-dock [data-field="recommendation"]')); ok('recommendation shown once, in the reply card')
  assert.ok(all('.pager button').every((b) => b.getAttribute('aria-label'))); ok('icon pager buttons are labelled')
  const bgField = document.querySelector('[data-field="background"]')
  assert.equal(bgField.querySelector('strong').textContent, '請決定是否發佈第 42 版。'); ok('bold rendered')
  assert.equal(bgField.querySelector('a').getAttribute('href'), 'https://example.invalid/run/42'); assert.equal(bgField.querySelector('a').textContent, '執行紀錄'); ok('link rendered, http(s) only')
  assert.deepEqual(all('[data-field="background"] li').map((e) => e.textContent), ['測試全部通過', '文件已更新']); ok('list breaks rendered')
  assert.ok(!/\*\*|\]\(https/.test(bgField.textContent)); ok('no literal Markdown')
  const bare = [...bgField.querySelectorAll('a')].find((a) => a.textContent.startsWith('https://example.invalid/notes'))
  assert.equal(bare.getAttribute('href'), 'https://example.invalid/notes/7'); assert.ok(bgField.textContent.includes('notes/7。')); ok('bare URL linked; trailing 。 stays text')
  // A multi-link CJK sentence: each anchor's href and text, and the text between them.
  const lastP = [...bgField.querySelectorAll('p')].at(-2)
  assert.deepEqual([...lastP.querySelectorAll('a')].map((a) => [a.getAttribute('href'), a.textContent]),
    [['https://a.invalid/1', 'https://a.invalid/1'], ['https://b.invalid/2', 'https://b.invalid/2'], ['https://en.wikipedia.org/wiki/A_(b)', 'C 文件'], ['https://example.invalid/run/42', 'https://example.invalid/run/42']])
  assert.deepEqual([...lastP.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent), ['參考 ', '、', ' 與 ', '，另見 ', '。下一句不是連結。']); ok('multi-link sentence: hrefs, link text and sibling text exact')
  const d1p = [...bgField.querySelectorAll('p')].at(-1)
  assert.deepEqual([...d1p.querySelectorAll('a')].map((a) => [a.getAttribute('href'), a.textContent]), [['https://example.invalid/x', 'https://example.invalid/x'], ['http://[::1]:8080/a', 'http://[::1]:8080/a']])
  assert.deepEqual([...d1p.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent), ['see [', '] here, ', 'https://ok.invalid', ' ', '(javascript:alert(1))', ' and ', '.']); ok('unmatched ], non-http label and IPv6: anchors and plain text exact')
  assert.equal(byLabel('Reply text').getAttribute('rows'), '3'); ok('reply box: three rows in the card')
  // A selection inside bold maps to the exact raw offsets.
  const raw = db.get('pkg-a-1').background
  const node = document.querySelector('[data-field="background"] strong').firstChild
  select(range(node, 0, 4))
  await key({ altKey: true, key: 'n', code: 'KeyN' })
  await addNote('check'); await sleep(450)
  const n = last('draft.save').draft.annotations[0]
  assert.equal(n.quote, raw.slice(n.start, n.end)); assert.equal(n.quote, '請決定是'); assert.equal(n.start, raw.indexOf('請決定')); ok('note anchors map through formatting to exact UTF-16 offsets')
  const dock = document.querySelector('.dock')
  assert.ok(dock && dock.querySelector('[aria-label="Reply text"]') && dock.querySelector('input[type=radio]')); ok('options and composer are in the docked reply area')
  assert.ok(!dock.closest('.d-sheet-body') && dock.parentElement === document.querySelector('.d-sheet')); ok('the reply card sits below the scrolling body')
  assert.match(document.head.textContent, /\.d-app \.d-sheet-body \{ flex: 1; min-height: 0; overflow-y: auto;/); ok('the body scrolls on its own above the card')
  await setValue(byLabel('Reply text'), '下週二發佈', 'input')
  await click(document.querySelector('[data-k="q-next"]')); await settle()
  assert.equal(document.querySelector('h1').textContent, '第二題：何時發佈？'); assert.equal(document.querySelector('.pager span').textContent, '2 / 2'); ok('Next pages to question 2')
  assert.equal(byLabel('Reply text').value, ''); ok('question 2 has its own draft')
  await click(document.querySelector('[data-k="q-prev"]')); await settle()
  assert.equal(byLabel('Reply text').value, '下週二發佈'); ok('paging back restores question 1 draft')
  assert.equal(drafts.get('pkg-a-1').draft.text, '下週二發佈'); ok('draft persisted under its own question ID')
  // Free-text recommendation (no recommended option ID): added below the owner's text, never replacing it, never sent.
  const rec = db.get('pkg-a-1').recommendation.trim()
  assert.ok(rec && !db.get('pkg-a-1').recommendedOptionId)
  await click(document.querySelector('[data-k="use-rec"]')); await click(document.querySelector('[data-k="rec-replace"]')); await sleep(450)
  assert.equal(byLabel('Reply text').value, rec); assert.equal(drafts.get('pkg-a-1').draft.optionId ?? null, null); assert.equal(callsOf('submitReply').length, 0); ok('free-text recommendation fills the reply after confirmation; no guessed option; nothing sent')
  await click(document.querySelector('[data-k="q-next"]')); await settle()
  assert.equal(document.querySelector('.d-proposed'), null); assert.equal(byLabel('Reply text').value, ''); ok('the proposal stays with its own question when paging')
} else if (scenario === 'rich') {
  const q = db.get('rich-context-question'); const raw = q.background
  const bg = document.querySelector('[data-field="background"]')
  assert.deepEqual(all('.rich-h').map((h) => [h.tagName, h.textContent]), [['H3', 'Paper model review'], ['H4', 'Example command']]); ok('agent headings rendered as headings')
  assert.equal(bg.querySelector('a').getAttribute('href'), 'https://example.test/sample'); ok('source link rendered')
  const figs = all('[data-field="background"] figure')
  assert.equal(figs.length, 2); ok('one placed image and one placeholder')
  assert.equal(figs[0].querySelector('img').getAttribute('alt'), 'Two paper folds side by side'); assert.match(figs[0].querySelector('img').getAttribute('src'), /^data:image\/png;base64,/)
  assert.equal(figs[0].querySelector('img').getAttribute('width'), '800'); assert.equal(figs[0].querySelector('figcaption span').textContent, 'Left: valley fold. Right: mountain fold.'); ok('image with alt, size and its plain-text caption')
  assert.deepEqual(callsOf('getSnapshot'), [{ questionId: 'rich-context-question', attachmentId: 'fixture-fold-v2' }]); ok('bytes only through the authorized getSnapshot for the exact version')
  assert.equal(figs[0].nextElementSibling.textContent, 'Example command'); assert.equal(raw.slice(q.inlineImages[0].offset).split('\n')[0], '## Example command'); ok('image placed at its raw UTF-16 offset')
  assert.ok(figs[1].classList.contains('unavailable')); assert.equal(figs[1].textContent, 'Image unavailable'); assert.equal(figs[1].querySelector('img'), null); ok('denied placement: placeholder only, no caption or metadata')
  const pre = document.querySelector('.codeblock pre')
  assert.equal(pre.textContent, 'printf "%s\\n" "paper sample"\n'); assert.equal(document.querySelectorAll('.codeblock script, .codeblock a').length, 0); ok('fenced command shown as inert text')
  await click(document.querySelector('.code-copy'))
  assert.deepEqual(copied, ['printf "%s\\n" "paper sample"']); assert.equal(callsOf('getDecision').length, 1); ok('Copy copies the exact command; nothing runs')
  const codeText = pre.querySelector('code').firstChild
  select(range(codeText, 0, 6))
  await key({ altKey: true, key: 'n', code: 'KeyN' })
  // A failed save keeps the composer open with the text.
  handlers['draft.save'] = () => errR('unavailable', 'Storage is offline.')
  await addNote('why printf?')
  assert.ok(document.querySelector('.d-nc')); assert.equal(byLabel('New note').value, 'why printf?'); assert.match(document.querySelector('.d-nc').textContent, /The note was not saved/); assert.equal(document.querySelectorAll('mark.d-n').length, 0); ok('a failed save keeps the composer open with the text')
  delete handlers['draft.save']
  await click(document.querySelector('[data-k="nc-add"]')); await sleep(30); await settle(); await sleep(450)
  assert.equal(document.querySelector('.d-nc'), null)
  const n = last('draft.save').draft.annotations[0]
  assert.equal(n.quote, 'printf'); assert.equal(raw.slice(n.start, n.end), 'printf'); ok('a note in the code block anchors to exact raw offsets')
  await click(document.querySelector('[data-k="fig-note-fold-sample"]'))
  assert.match(document.querySelector('.d-nc').textContent, /Note on Fold sample[^]*Left: valley fold/); ok('✎ on an image opens the composer with its caption')
  await addNote('compare depth'); await sleep(450)
  assert.equal(document.activeElement.getAttribute('data-k'), 'fig-note-fold-sample'); ok('focus returns to the image note control')
  assert.deepEqual(last('draft.save').draft.annotations.map((a) => a.kind), ['selection', 'image']); assert.deepEqual(last('draft.save').draft.annotations[1].evidence, { evidenceId: 'fold-sample', version: 2 }); ok('image note keyed to the evidence version')
  assert.equal(all('[data-field="recommendation"]').length, 1); assert.ok(document.querySelector('.d-dock [data-field="recommendation"]')); ok('recommendation once, in the reply card')
  // Owner annotation 6: source actions (https, deduplicated) and Copy session ID; no focus claim.
  const acts = all('.d-src-act')
  assert.deepEqual(acts.map((a) => a.getAttribute('aria-label')), ['Open GitHub pull request example/paper#4', 'Open Linear issue PAP-2', 'Copy session ID of the original chat']); ok('work-item links: allow-listed https GitHub/Linear only, deduplicated, labelled')
  assert.equal(acts[0].getAttribute('rel'), 'noopener noreferrer')
  await click(acts[0]); assert.deepEqual(opened, ['https://github.com/example/paper/pull/4']); ok('opens through the external-open API on click')
  copied.length = 0; await click(document.querySelector('[data-k="copy-session"]'))
  assert.deepEqual(copied, ['orca_session_id:00000000-0000-4000-8000-000000000002']); assert.doesNotMatch(text(), /Focus session|Open session/); ok('Copy session ID; no unverified focus action')
  // Owner annotation 3: progress always visible (no disclosure).
  const prog = document.querySelector('.d-progress')
  assert.ok(prog && !prog.closest('details')); assert.equal(step(), '● Awaiting answer'); assert.match(prog.textContent, /No answer saved yet\./); assert.match(prog.textContent, /Opened · 1\d Jun 2030/)
  assert.ok(prog.previousElementSibling.classList.contains('d-srcline') && prog.nextElementSibling.classList.contains('d-meta')); ok('progress card always visible with the current state and milestones')
  // Owner annotation 5: an existing draft is protected; Replace selects the exact recommended option; Undo restores.
  await setValue(byLabel('Reply text'), 'my own words', 'input')
  await click(document.querySelector('[data-k="use-rec"]'))
  assert.match(document.querySelector('.d-confirm').textContent, /Replace your draft/); assert.equal(document.activeElement?.getAttribute?.('data-k') ?? 'rec-keep', 'rec-keep')
  await click(document.querySelector('[data-k="rec-keep"]'))
  assert.equal(byLabel('Reply text').value, 'my own words'); assert.equal(document.querySelector('.d-confirm'), null); ok('Keep my draft leaves the draft untouched')
  await click(document.querySelector('[data-k="use-rec"]')); await click(document.querySelector('[data-k="rec-replace"]')); await sleep(450)
  assert.ok(document.querySelector('[data-k="opt-valley"]').hasAttribute('checked') || document.querySelector('[data-k="opt-valley"]').checked); assert.equal(byLabel('Reply text').value, ''); assert.equal(callsOf('submitReply').length, 0)
  assert.equal(last('draft.save').draft.optionId, 'valley'); assert.equal(last('draft.save').questionId, 'rich-context-question'); assert.match(document.querySelector('.d-proposed').textContent, /Proposed from the PM recommendation: Valley fold/); ok('Replace draft selects the recommended option by ID and sends nothing')
  await click(document.querySelector('[data-k="rec-undo"]')); await sleep(450)
  assert.equal(byLabel('Reply text').value, 'my own words'); assert.equal(last('draft.save').draft.optionId ?? null, null); ok('Undo restores the previous draft')
  // Owner annotation 2: Ctrl/Cmd+Enter in the composer adds the note only; IME and empty are safe; Esc cancels.
  const before = callsOf('submitReply').length, notesBefore = draft0().length
  select(range(document.querySelector('[data-field="background"] a').firstChild, 0, 6))
  await key({ altKey: true, key: 'n', code: 'KeyN' })
  const kd = async (init) => { const ev = new window.Event('keydown', { bubbles: true, cancelable: true }); Object.assign(ev, init); byLabel('New note').dispatchEvent(ev); await sleep(30); await settle() }
  await kd({ key: 'Enter', ctrlKey: true }); assert.ok(document.querySelector('.d-nc')); assert.match(document.querySelector('.d-nc').textContent, /Write the note first/)
  await setValue(byLabel('New note'), '來源', 'input')
  await kd({ key: 'Enter', metaKey: true, isComposing: true }); assert.ok(document.querySelector('.d-nc'))
  await kd({ key: 'Enter', ctrlKey: true }); await sleep(450)
  assert.equal(document.querySelector('.d-nc'), null); assert.equal(draft0().length, notesBefore + 1); assert.equal(callsOf('submitReply').length, before); ok('Ctrl/Cmd+Enter adds the note only (empty and IME composition ignored); the decision is not submitted')
  select(range(document.querySelector('[data-field="background"] a mark').firstChild, 0, 6)); await key({ altKey: true, key: 'n', code: 'KeyN' })
  await setValue(byLabel('New note'), 'discard me', 'input')
  await kd({ key: 'Escape' }); assert.equal(document.querySelector('.d-nc'), null); assert.equal(draft0().length, notesBefore + 1); assert.ok(document.querySelector('.d-sheet')); ok('Esc dismisses the composer and adds nothing')
  // Owner annotation 4: the image opens in a viewport-level viewer; Esc closes it and focus returns.
  await click(document.querySelector('[data-k="fig-open-fold-sample"]'))
  const z = document.querySelector('.d-zoom')
  assert.ok(z && z.parentElement === document.body && !z.closest('.d-sheet')); assert.equal(z.getAttribute('aria-modal'), 'true'); assert.ok(document.querySelector('.d-solo').hasAttribute('inert')); ok('image viewer is outside the sheet, modal, with the page inert')
  await click(z.querySelector('[data-zk="in"]')); assert.equal(z.querySelector('.d-zoom-level').textContent, '150%')
  await click(z.querySelector('[data-zk="fit"]')); assert.equal(z.querySelector('.d-zoom-level').textContent, 'Fit'); ok('zoom in and fit')
  const esc = new window.Event('keydown', { bubbles: true, cancelable: true }); Object.assign(esc, { key: 'Escape' }); document.dispatchEvent(esc); await settle()
  assert.equal(document.querySelector('.d-zoom'), null); assert.ok(!document.querySelector('.d-solo').hasAttribute('inert')); assert.ok(document.querySelector('.d-sheet')); ok('Esc closes only the viewer')
} else if (scenario === 'sections') {
  const body = document.querySelector('.d-sheet-body')
  const heads = all('.d-sheet-body h2, .d-sheet-body .rich-h').map((h) => h.textContent)
  assert.deepEqual(heads.filter((t) => /^(Description|Background)$/.test(t)), ['Background', 'Description']); ok('Background then Description, each once (authored headings kept, none duplicated)')
  assert.equal(all('.d-sheet-body h2.d-sec-h').filter((h) => /Description|Background/.test(h.textContent)).length, 0); ok('no extra section heading when the authored Markdown already has it')
  assert.equal(document.querySelector('.d-desc')?.getAttribute('data-field'), 'description'); ok('Description is a note anchor field of its own')
  assert.ok(body.querySelector('.d-progress').compareDocumentPosition !== undefined && body.querySelector('h1').nextElementSibling.classList.contains('d-srcline')); ok('title, source line and state card stay separate above the sections')
  const raw = db.get('sections').background
  const t = [...document.querySelectorAll('[data-field="background"] p')].at(-1).firstChild
  select(range(t, 4, 14)); await key({ altKey: true, key: 'n', code: 'KeyN' }); await addNote('narrow'); await sleep(450)
  const n = last('draft.save').draft.annotations[0]
  assert.equal(n.quote, 'west aisle'); assert.equal(raw.slice(n.start, n.end), 'west aisle'); assert.equal(n.start, raw.indexOf('west aisle')); ok('background note offsets are raw offsets into the unchanged background')
  assert.ok(document.querySelector('.d-note-saved')); document.activeElement?.blur?.(); await sleep(7300); await settle()
  assert.equal(document.querySelector('.d-note-saved'), null); assert.match(document.querySelector('[data-k="notes-open"]').textContent, /Notes \(1\)/); ok('the quiet saved confirmation clears itself after 7 s; the note stays')
  assert.equal(all('[data-field="recommendation"]').length, 1); assert.ok(document.querySelector('.d-dock [data-field="recommendation"]')); ok('recommendation stays in the reply card')
  // Description text: the same note flow, anchored to raw offsets in the unchanged description.
  const rawDesc = db.get('sections').description
  const dt = [...document.querySelectorAll('[data-field="description"] p')].map((p) => [...p.childNodes].find((c) => c.nodeType === 3 && c.data.trim().length > 6)).find(Boolean)
  select(range(dt, 0, 6)); assert.equal(document.querySelector('#pop').style.display, 'block'); ok('selecting Description text shows Add note')
  await key({ altKey: true, key: 'n', code: 'KeyN' }); await addNote('desc note'); await sleep(450)
  const dn = last('draft.save').draft.annotations.find((a) => a.text === 'desc note')
  assert.equal(dn.anchor.field, 'description'); assert.equal(rawDesc.slice(dn.start, dn.end), dn.quote); assert.equal(dn.quote, dt.data.slice(0, 6)); ok('a Description note stores raw description offsets and its quote')
  assert.ok(document.querySelector('[data-field="description"] mark.d-n')); assert.match(document.querySelector('[data-k="notes-open"]').textContent, /Notes \(2\)/); ok('the Description note is highlighted and counted')
  // A highlight re-opens its note: Enter edits it (Save note), Delete removes it; nothing is sent.
  const dm = document.querySelector('[data-field="description"] mark.d-n')
  const ent = new window.Event('keydown', { bubbles: true, cancelable: true }); Object.assign(ent, { key: 'Enter' }); dm.dispatchEvent(ent); await settle()
  assert.ok(document.querySelector('.d-nc')); assert.equal(byLabel('Edit note').value, 'desc note'); assert.match(document.querySelector('.d-nc').textContent, /Edit note on the selected text/); ok('Enter on a highlight re-opens that note for editing')
  await setValue(byLabel('Edit note'), 'desc note, edited', 'input'); await click(document.querySelector('[data-k="nc-add"]')); await sleep(450)
  assert.equal(document.querySelector('.d-nc'), null); assert.deepEqual(last('draft.save').draft.annotations.map((a) => a.text), ['narrow', 'desc note, edited']); ok('Save note updates the same note in place')
  await click(document.querySelector('[data-field="description"] mark.d-n')); await click(document.querySelector('[data-k="nc-delete"]')); await sleep(450)
  assert.deepEqual(last('draft.save').draft.annotations.map((a) => a.text), ['narrow']); assert.equal(document.querySelector('[data-field="description"] mark.d-n'), null); ok('a click re-opens it too, and Delete removes only that note')
  assert.equal(callsOf('submitReply').length, 0); ok('nothing is sent by notes')
} else if (scenario === 'localonly') {
  await setValue(byLabel('Reply text'), 'Tuesday', 'input')
  await click(find('button', 'Submit reply'))
  const id = last('submitReply').replyId
  assert.match(text(), new RegExp(`Your answer is saved in Decision Inbox \\(reply ID ${id}\\) but was not delivered to the original chat\\. Orca could not hand it to that chat\\.`)); ok('saved locally, mail unavailable: said plainly')
  assert.equal(step(), '● Undelivered'); assert.doesNotMatch(text(), /Mail submitted|Receipt /); ok('no mail or receipt claimed')
  assert.equal(find('button', 'Retry (same reply ID, same destination)'), undefined); assert.ok(find('button', 'Copy reply')); ok('no unsupported Retry; Copy offered')
  assert.match(text(), /Retry is not available here; copy the reply and paste it into that chat if it is needed now\./); ok('actionable next step')
} else if (scenario === 'race' || scenario === 'racebtn') {
  // H1: the owner's initial-answer intent survives a remote answer that lands while they type.
  const tue = all('input[type=radio]').find((r) => r.getAttribute('data-k') === 'opt-tue')
  tue.dispatchEvent(new window.Event('change', { bubbles: true })); await settle()
  const ta = byLabel('Reply text'); ta.focus()
  await setValue(ta, 'Tuesday, but only after 3pm', 'input')
  globalThis.__otherSurface()
  await changed()
  assert.ok(find('button', 'Submit reply'), 'page not yet redrawn while typing')
  if (scenario === 'race') await key({ ctrlKey: true, key: 'Enter' })
  else await click(find('button', 'Submit reply'))
  assert.equal(callsOf('submitReply').length, 0); ok(`${scenario === 'race' ? 'Ctrl+Enter' : 'Submit button'} sends nothing against a page the owner did not see`)
  assert.match(text(), /This decision changed while you were writing, so nothing was sent/); ok('the owner is told why')
  assert.match(text(), /Answer · accepted[^]*Thursday[^]*Receipt rcpt-native/); ok('the recorded answer and its receipt are shown')
  assert.match(text(), /Your unsent answer[^]*Option: Tuesday\s*Tuesday, but only after 3pm/); ok('the unsent answer is kept with its option')
  assert.equal(byLabel('Follow-up'), null); assert.equal(find('button', 'Send follow-up'), undefined); ok('no follow-up is composed automatically')
  await key({ ctrlKey: true, key: 'Enter' })
  assert.equal(callsOf('submitReply').length, 0); ok('a second attempt still sends nothing')
  await sleep(450)
  const stored = drafts.get('schedule').draft
  assert.equal(stored.kind ?? 'initial', 'initial'); assert.equal(stored.optionId, 'tue'); ok('stored draft unchanged: still the initial answer with its option')
  await click(find('button', 'Write a follow-up from this text'))
  assert.equal(byLabel('Follow-up').value, 'Tuesday, but only after 3pm'); ok('follow-up only after the explicit choice')
  await click(find('button', 'Send follow-up'))
  assert.deepEqual([last('submitReply').kind, last('submitReply').answer], ['follow-up', { kind: 'text', text: 'Tuesday, but only after 3pm' }]); ok('then sent as the follow-up the owner chose')
} else if (scenario === 'errors') {
  assert.match(text(), /Decision "nope" was not found/); assert.ok(document.querySelector('[role="alert"]')); ok('not found alert')
  replace('{"questionId":"secret"}'); await settle()
  assert.match(text(), /You do not have access to decision "secret"/); ok('forbidden alert')
  replace('{"questionId":"down"}'); await settle()
  assert.match(text(), /Could not load decision "down"\. The Decision Inbox is unavailable\. Worker stopped\./); assert.ok(find('button', 'Try again')); ok('unavailable alert with Try again')
  replace('{}'); await settle()
  assert.match(text(), /does not name a decision/); ok('invalid reference file')
  assert.ok(FIXTURE_TITLES.every((t) => !text().includes(t))); ok('no fixture content shown')
} else if (scenario === 'offline') {
  assert.match(text(), /This Orca build does not provide “getDecision”/); ok('missing worker reported')
  assert.ok(FIXTURE_TITLES.every((t) => !text().includes(t))); ok('no fixture fallback')
} else if (scenario === 'settings') {
  assert.equal(document.querySelector('h1').textContent, 'Inbox settings'); ok('heading')
  assert.deepEqual(last('settings.effective'), { repo: 'Seed Catalogue' })
  assert.match(text(), /Exception for Seed Catalogue/); ok('worker effective policy shown for the saved state')
  await setValue(byLabel('Default question template'), '')
  assert.match(text(), /default template cannot be empty/); ok('empty default is rejected')
  assert.equal(find('button', 'Save').getAttribute('aria-disabled'), 'true'); ok('Save is aria-disabled when invalid')
  await setValue(byLabel('Default question template'), 'Title and Options only.')
  assert.match(text(), /Unsaved changes/); assert.match(text(), /Preview of your unsaved changes/); ok('dirty state and local preview labelled')
  await click(find('button', 'Add exception'))
  assert.match(text(), /Repo exceptions \(2\)/); ok('exception added from settings.repos')
  await setValue(byLabel('Preview repo'), '(any other repo)')
  assert.match(text(), /Title and Options only/); ok('preview reflects the edited default')
  await click(find('button', 'Save'))
  assert.equal(last('settings.save').revision, 3); assert.match(text(), /Settings saved/); ok('save sends the revision it read')
  await click(find('button', 'Add exception'))
  assert.match(text(), /Every repo already has an exception/); ok('add is disabled when every repo has one')
  handlers['settings.save'] = () => errR('conflict', 'Stale revision.')
  await setValue(byLabel('Default question template'), 'Changed again.')
  await click(find('button', 'Save'))
  assert.match(text(), /changed elsewhere since you opened them, so nothing was saved/); assert.ok(find('button', 'Load latest settings')); ok('save conflict reported with a reload')
}
process.exit(0)
