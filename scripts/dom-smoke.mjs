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
const SCENARIOS = ['review', 'restart', 'winner', 'bind', 'followup', 'receipt', 'package', 'errors', 'offline', 'settings']
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
      files: [path.join(root, 'src/review.ts'), path.join(root, 'fixtures/decisions.ts')],
      include: []
    }))
    run('npm', ['exec', '--yes', '--package', `typescript@${TYPESCRIPT}`, '--', 'tsc', '-p', path.join(tmp, 'tsconfig.json')])
    for (const name of SCENARIOS) {
      const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), name], { encoding: 'utf8', env: { ...process.env, DOM_TMP: tmp } })
      process.stdout.write(r.stdout)
      if (r.status !== 0) { failed++; process.stderr.write(r.stderr) }
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
Object.assign(globalThis, {
  document, window,
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  getSelection: () => selection,
  CSS: { escape: (s) => String(s).replace(/["\\]/g, '\\$&') }
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
const drafts = new Map()
const calls = []
const listeners = {}
const handlers = {}
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
const base = {
  getDecision: ({ questionId }) => (db.has(questionId) ? okR(clone(db.get(questionId))) : errR('not-found')),
  listDecisions: ({ scope }) => okR([...db.values()].filter((d) => scope.kind === 'all' ||
    (d.origin.hostId === scope.workspace.hostId && d.origin.workspaceId === scope.workspace.workspaceId)).map(clone)),
  'draft.get': ({ questionId }) => okR(clone(drafts.get(questionId) ?? null)),
  // Like the real worker: a stored draft may not hold an empty note.
  'draft.save': ({ questionId, draft }) => { if (draft?.annotations.some((n) => !n.text.trim())) return errR('invalid', 'Invalid annotation text.'); if (draft) drafts.set(questionId, clone(draft)); else drafts.delete(questionId); return okR(draft) },
  getSnapshot: () => okR({ mimeType: 'image/png', base64: PNG }),
  'review.open': () => okR(null),
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
  bind: '{"questionId":"schedule"}', followup: '{"questionId":"layout"}', receipt: '{"questionId":"layout"}',
  package: '{"questionId":"room-route"}', errors: '{"questionId":"nope"}', offline: '{"questionId":"image-review"}',
  settings: '{"view":"settings"}'
}
const opened = []
globalThis.orca = {
  document: { session: async () => ({ value: files[scenario], onReplace(fn) { replace = fn }, change() {} }) },
  shell: { openExternal: async (url) => { opened.push(url); return { opened: true } } },
  plugin: worker,
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
const key = async (init) => { const ev = new window.Event('keydown', { bubbles: true }); Object.assign(ev, init); document.dispatchEvent(ev); await settle() }
const byLabel = (l) => document.querySelector(`[aria-label="${l}"]`)
const step = () => document.querySelector('.step[aria-current="step"]')?.textContent.trim()
const callsOf = (name) => calls.filter((c) => c.name === name).map((c) => c.input)
const last = (name) => callsOf(name).at(-1)
const setValue = async (e, v, type = 'change') => {
  assert.ok(e, 'field exists')
  if (e.tagName === 'SELECT') {
    // linkedom's select.value is read-only: pick the option, as a user would.
    const opts = [...e.querySelectorAll('option')]
    assert.ok(opts.some((o) => o.getAttribute('value') === v), `option ${v} exists`)
    for (const o of opts) { if (o.getAttribute('value') === v) o.setAttribute('selected', ''); else o.removeAttribute('selected') }
  } else { e.value = v; if (e.tagName === 'TEXTAREA') e.textContent = v }
  e.dispatchEvent(new window.Event(type, { bubbles: true })); await settle()
}
const changed = async () => { for (const fn of listeners['inbox.changed'] ?? []) fn({}); await settle() }
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
  drafts.set('schedule', { text: 'Tuesday works', optionId: 'tue', replyId: 'reply-persisted-1', kind: 'initial', annotations: [] })
  let first = true
  handlers.submitReply = (input) => {
    if (first) { first = false; return Promise.reject(hostError('timeout', 'The worker did not answer in time.')) }
    return base.submitReply(input)
  }
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
} else if (scenario === 'settings') {
  let revision = 3
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
  const bg = document.querySelector('[data-field="background"]').firstChild
  selection = { rangeCount: 1, isCollapsed: false, getRangeAt: () => ({ startContainer: bg, endContainer: bg, startOffset: 0, endOffset: 12, getBoundingClientRect: () => ({ left: 0, bottom: 0 }) }) }
  document.dispatchEvent(new window.Event('selectionchange'))
  await key({ altKey: true, key: 'n' })
  assert.match(document.querySelector('.side').textContent, /Notes \(2\)/); ok('Alt+N adds a note from the selection')
  assert.equal(document.activeElement.getAttribute('data-note'), '1'); ok('focus moves to the new note field')
  await sleep(450)
  assert.ok(!/Draft not saved/.test(text())); assert.equal(last('draft.save').draft.annotations.length, 1); ok('an empty new note stays local until it has text')
  await setValue(byLabel('Reply text'), 'draft', 'input')
  await click(find('button', 'Submit reply'))
  assert.equal(callsOf('submitReply').length, 0); assert.match(text(), /A note is empty/); ok('an empty note blocks sending')
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
  assert.match(text(), /Waiting for a matching receipt/); ok('no receipt is claimed')
  await sleep(10)
  assert.equal(last('draft.save').draft, null); ok('draft cleared after the reply is recorded')
  assert.equal(all('.step').length, 4); ok('four distinct states listed')
} else if (scenario === 'restart') {
  assert.equal(document.querySelector('input[type=radio][checked]')?.getAttribute('data-k') ?? all('input[type=radio]').find((r) => r.checked)?.getAttribute('data-k'), 'opt-tue'); ok('persisted option restored')
  assert.equal(byLabel('Reply text').value, 'Tuesday works'); ok('persisted text restored')
  await click(find('button', 'Submit reply'))
  assert.match(text(), /Not sent\. The Decision Inbox is unavailable\. The worker did not answer in time\./); ok('timeout reported truthfully')
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
  assert.equal(kept.kind, 'follow-up'); assert.equal(kept.replyId, undefined); assert.equal(kept.optionId, undefined)
  assert.equal(byLabel('Follow-up').value, 'Hold until the space is confirmed.'); ok('owner text kept as a new follow-up draft')
  await click(find('button', 'Send follow-up'))
  const fu = last('submitReply')
  assert.equal(fu.kind, 'follow-up'); assert.notEqual(fu.replyId, callsOf('submitReply')[0].replyId); ok('follow-up is a new attempt with a new reply ID')
  assert.match(text(), /This changed elsewhere\. Reply ID reused with different content\. The recorded answer is shown below/); ok('conflict shows the recorded answer')
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
} else if (scenario === 'followup') {
  assert.equal(document.querySelector('h1').textContent, 'Choose the catalogue layout'); ok('title')
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
  assert.match(text(), /Undelivered\. The original chat is closed\. The reply is kept\./); ok('inbox.changed refetch shows undelivered with its reason')
  await click(find('button', 'Copy reply'))
  assert.deepEqual(copied, ['Please also check the list view.']); ok('Copy reply copies the recorded text')
  await click(find('button', 'Retry (same reply ID, same destination)'))
  assert.deepEqual(last('retryReply'), { questionId: 'layout', replyId: fu.replyId }); ok('retry uses the original reply ID')
  assert.ok(!/Undelivered\. The original/.test(text())); ok('retried reply is pending again, not received')
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
  await click(find('button', 'Copy decision link'))
  assert.deepEqual(copied, ['https://example.invalid/inbox/room-route']); ok('decision link copied')
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
