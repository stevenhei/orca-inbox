import type { Annotation, Answer, Decision, Delivery, Evidence, RecordedReply, SubmitReply } from './contract.ts'
import type { EffectivePolicy, InboxSettings } from './backend-protocol.ts'
import { STATE_LABEL, actionsOf, deadlineLabel, nativeOf, nativeStatusLabel, replyState, shownState, type NativeSource, type ShownState } from './model.ts'
import {
  call, clock, draftIsEmpty, emptyDraft, failureText, formatInstant, newReplyId, reconcile, replies,
  transportOf, type Draft, type Failure, type Requester
} from './client.ts'

// Wide review tab: an isolated custom editor on a `.orca-decision` reference file whose content is
// `{"questionId": "..."}` (a review) or `{"view": "settings"}` (Inbox Settings). Every decision,
// draft, reply, snapshot and setting comes from the plugin worker; there is no fixture fallback.
// Plain DOM, themed only through `--orca-*` (only foreground/background are confirmed, so the rest
// is derived with color-mix). Notes live in a sticky sidebar; below 800px they move to a modal.
//
// Truthfulness rules: the delivery strip only shows what the worker recorded. A reply is never
// shown as accepted before `submitReply` returns it, and Agent received needs a receipt that
// matches the reply, question and exact origin (see `replyState`).

const css = `
:root{--fg:var(--orca-foreground);--bg:var(--orca-background);
 --line:color-mix(in srgb,var(--fg) 18%,transparent);--soft:color-mix(in srgb,var(--fg) 6%,transparent);
 --mute:color-mix(in srgb,var(--fg) 62%,transparent);--acc:color-mix(in srgb,#3b82f6 80%,var(--fg));
 --bad:color-mix(in srgb,#ef4444 85%,var(--fg));--warn:color-mix(in srgb,#eab308 70%,var(--fg));
 --ring:color-mix(in srgb,#f59e0b 85%,var(--fg))}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.55 system-ui,sans-serif}
.layout{max-width:1120px;margin:0 auto;padding:16px 20px 48px;display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:24px;align-items:start}
@media(max-width:800px){.layout{grid-template-columns:1fr}.side{display:none}}
@media(min-width:801px){.only-narrow{display:none}}
.side{position:sticky;top:12px;border:1px solid var(--line);border-radius:8px;padding:10px;max-height:calc(100vh - 24px);overflow:auto}
h1{font-size:18px;margin:2px 0 4px;text-wrap:balance}h2{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--mute);margin:20px 0 6px}
.meta{color:var(--mute);display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.chip{border:1px solid var(--line);border-radius:99px;padding:0 8px;font-size:11px}
.chip.bad{background:var(--bad);color:#fff;border-color:transparent}
button,textarea,input,select{font:inherit;color:inherit}
button{background:var(--soft);border:1px solid var(--line);border-radius:6px;padding:3px 10px;cursor:pointer;min-block-size:28px;min-inline-size:28px}
button:hover{background:var(--line)}button.pri{background:var(--acc);color:#fff;border-color:transparent}
button[aria-disabled=true]{opacity:.55;cursor:not-allowed}
/* Selected and focused look different: selection is a filled tint and a check mark, focus is an outside ring. */
button[aria-pressed=true]{background:color-mix(in srgb,var(--acc) 22%,transparent);border-color:var(--acc);font-weight:600}
button[aria-pressed=true]::before{content:"✓ "}
:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
@media(forced-colors:active){:focus-visible{outline-color:Highlight}button[aria-pressed=true]{border:2px solid SelectedItem}}
textarea,input[type=text]{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:6px 8px}
.callout{border:1px solid var(--bad);border-radius:6px;padding:6px 10px;margin:10px 0}.callout.warn{border-color:var(--warn)}.callout.info{border-color:var(--line)}
.opt{display:flex;gap:8px;border:1px solid var(--line);border-radius:6px;padding:8px 10px;margin:4px 0;cursor:pointer}
.opt:has(input:checked){border-color:var(--acc);background:color-mix(in srgb,var(--acc) 10%,transparent)}
.opt:has(input:focus-visible){outline:2px solid var(--ring);outline-offset:2px}
.film{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
.vp{display:grid;grid-template-columns:minmax(0,1fr);gap:10px}.vp.pair{grid-template-columns:repeat(2,minmax(0,1fr))}
@media(max-width:640px){.vp.pair{grid-template-columns:minmax(0,1fr)}}
.view{height:340px;overflow:auto;background:var(--soft);border:1px solid var(--line);border-radius:8px}.vp.pair .view{height:260px}
dialog .note textarea{margin-top:4px}
.view img{display:block;height:auto;max-width:none}
.bar{display:flex;gap:6px;align-items:center;padding:6px 0;flex-wrap:wrap}.bar input{flex:1;min-width:140px}
.miss{display:grid;place-items:center;height:100%;color:var(--mute);text-align:center;padding:12px}
.note{border-left:3px solid var(--warn);padding:2px 8px;margin:8px 0}.note q{display:block;color:var(--mute);margin-bottom:2px}.note.stale{border-left-color:var(--bad)}
.strip{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0;list-style:none;padding:0}
.step{border:1px solid var(--line);border-radius:6px;padding:3px 9px;color:var(--mute)}
.step[aria-current=step]{color:var(--fg);border-color:var(--acc);font-weight:600}.step.bad[aria-current=step]{border-color:var(--bad)}
.pkg{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
#pop{position:fixed;display:none;z-index:5}
dialog{background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:10px;padding:14px;width:min(440px,92vw)}
dialog::backdrop{background:color-mix(in srgb,#000 45%,transparent)}
.raw{white-space:pre-wrap;border-left:3px solid var(--line);padding:2px 10px;color:var(--mute);margin:6px 0}
.sr{position:absolute;left:-9999px}
.reply{border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:8px 0}
.reply.fu{margin-left:18px;border-style:dashed}
.reply h3{margin:0 0 4px;font-size:12px;color:var(--mute);font-weight:600}
.set{max-width:760px;margin:0 auto;padding:16px 20px 48px}
.row2{display:grid;grid-template-columns:200px 1fr auto;gap:8px;align-items:start;margin:6px 0}@media(max-width:640px){.row2{grid-template-columns:1fr}}
.err{color:var(--bad);font-size:12px}
.prev{border:1px solid var(--line);border-radius:8px;padding:10px;background:var(--soft)}
`
document.head.append(Object.assign(document.createElement('style'), { textContent: css }))

type K = Record<string, unknown>
/** `data-k` names an element across re-renders so focus and caret survive them. */
function el<T extends HTMLElement>(tag: string, props: K = {}, ...kids: (Node | string)[]): T {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v as EventListener)
    else if (k === 'class') n.className = String(v)
    // ARIA states are strings: aria-pressed must be "true" or "false", never an empty attribute.
    else if (k.startsWith('aria-') && typeof v === 'boolean') n.setAttribute(k, String(v))
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : String(v))
  }
  n.append(...kids)
  return n as T
}
const field = (tag: 'textarea' | 'input', props: K, value: string) => {
  const f = el<HTMLTextAreaElement | HTMLInputElement>(tag, props)
  f.value = value
  if (tag === 'textarea') f.textContent = value
  return f
}

const req: Requester = (name, input, options) =>
  (orca.plugin.request as unknown as Requester)(name, input, options)

// ---- reference file ---------------------------------------------------------------------------
type Ref = { view: 'review'; questionId: string } | { view: 'settings' } | { view: 'invalid' }
const readRef = (text: string): Ref => {
  try {
    const v = JSON.parse(text)
    if (v?.view === 'settings') return { view: 'settings' }
    if (typeof v?.questionId === 'string' && v.questionId) return { view: 'review', questionId: v.questionId }
  } catch { /* fall through */ }
  return { view: 'invalid' }
}
const session = orca.document ? await orca.document.session<string>({ merge: (_b, outside) => outside }) : null
let ref: Ref = readRef(session?.value ?? '')

const root = el('div', { class: 'layout' })
const pop = el<HTMLButtonElement>('button', { id: 'pop', class: 'pri', type: 'button', onclick: () => addQuoteNote(),
  // Keep the text selection while pressing the button.
  onpointerdown: (e: Event) => e.preventDefault() }, 'Add note (Alt+N)')
const live = el('div', { class: 'sr', role: 'status', 'aria-live': 'polite' })
const composer = el<HTMLDialogElement>('dialog', { 'aria-labelledby': 'cmp-h' })
document.body.append(root, pop, live, composer)
const narrow = matchMedia('(max-width: 800px)')
narrow.addEventListener('change', () => render())
const say = (m: string) => { live.textContent = m }

// ---- background re-renders wait for the owner ---------------------------------------------------
// render() rebuilds the DOM. Background causes (worker invalidations, the minute clock, snapshot
// loads, save status) go through requestRender(), which waits while the owner is typing in a text
// field, composing with an IME, pressing a control, or holding a text selection, then renders once.
let composing = false
let pointerDown = false
let pendingRender = false
let pendingAnnounced = false
const isTextEntry = (e: Element | null) => !!e && root.contains(e) &&
  (e.tagName === 'TEXTAREA' || (e.tagName === 'INPUT' && ['text', 'search', ''].includes((e as HTMLInputElement).type ?? '')))
const busy = () => composing || pointerDown || quote !== null || composer.open || isTextEntry(document.activeElement)
function requestRender(external = false) {
  if (!busy()) { render(); return }
  pendingRender = true
  if (external && !pendingAnnounced) { pendingAnnounced = true; say('This decision changed elsewhere. The page updates when you leave the field.') }
}
function flushSoon() {
  if (!pendingRender) return
  setTimeout(() => { if (pendingRender && !busy()) render() }, 0)
}
document.addEventListener('compositionstart', () => { composing = true }, true)
document.addEventListener('compositionend', () => { composing = false; flushSoon() }, true)
document.addEventListener('pointerdown', () => { pointerDown = true }, true)
const released = () => { pointerDown = false; flushSoon() }
document.addEventListener('pointerup', released, true)
document.addEventListener('pointercancel', released, true)
root.addEventListener('focusout', () => flushSoon())
composer.addEventListener('close', () => render())

/** role="alert" only when the alert is new, so a re-render does not announce it again. */
let shownAlerts = new Set<string>()
let nextAlerts = new Set<string>()
const alertRole = (key: string): K => { nextAlerts.add(key); return shownAlerts.has(key) ? {} : { role: 'alert' } }

// ---- review state (bound to one question ID) ----------------------------------------------------
type Notice = { tone: 'bad' | 'warn' | 'info'; text: string; retry?: boolean; notes?: boolean }
type Snap = { state: 'loading' } | { state: 'ok'; url: string } | { state: 'fail'; f: Failure }
let d: Decision | null = null
let loadFail: Failure | null = null
let pkg: Decision[] = []
let pkgFail: Failure | null = null
let draft: Draft = emptyDraft()
let draftFor: string | null = null
let draftFail: Failure | null = null
let notice: Notice | null = null
let sending = false
let seq = 0
const snaps = new Map<string, Snap>()
let a = 0 // primary snapshot index
let b: number | null = null // optional second snapshot for side-by-side
let target: 'left' | 'right' = 'right'
const zoom = new Map<string, number>()
let quote: { field: 'background' | 'recommendation'; text: string; start: number; end: number } | null = null
let focusNote: number | null = null

/** What the owner is told about a recorded reply: only its actual state and receipt. */
function recordedNotice(r: RecordedReply, x: Decision, own: boolean): Notice {
  const state = replyState(r, x)
  const receipt = state === 'agent-received' && r.delivery.state === 'agent-received' ? `, receipt ${r.delivery.receipt.receiptId}` : ''
  const what = r.kind === 'initial' ? 'answer' : 'follow-up'
  return own
    ? state === 'undelivered' && r.delivery.state === 'undelivered'
      ? { tone: 'warn', text: `Your ${what} is saved in Decision Inbox (reply ID ${r.replyId}) but was not delivered to the original chat. ${REASON[r.delivery.reason]}` }
      : { tone: 'info', text: `Your ${what} was recorded (reply ID ${r.replyId}). ${STATE_LABEL[state]}${receipt}.${state === 'submitted' ? ` ${mailLine(r)}` : ''}` }
    : { tone: 'warn', text: `Another answer was recorded first, so yours was not sent. The recorded answer is shown below (${STATE_LABEL[state]}${receipt || ', no receipt yet'}). Your unsent answer is kept; nothing else is sent unless you choose to.` }
}

/**
 * Loads the decision (and, for a new question, its stored draft), then reconciles the draft with
 * what the worker recorded, by reply ID. `passive` loads come from invalidations: they change the
 * page only when the decision, its package or the draft actually changed.
 */
async function loadReview(questionId: string, keepNotice = false, passive = false) {
  const mine = ++seq
  if (!keepNotice) notice = null
  const dr = await call(req, 'getDecision', { questionId })
  if (mine !== seq) return
  // Native Bot Items are read-only here: no draft, no package siblings, no replies.
  const native = dr.ok && nativeOf(dr.value)
  const wr = native || draftFor === questionId ? null : await call(req, 'draft.get', { questionId })
  if (mine !== seq) return
  const before = d ? JSON.stringify(d) : null
  if (!dr.ok) {
    // A passive refresh that fails keeps the page; an explicit load shows the failure.
    if (passive && d) return
    d = null; loadFail = dr; render(); return
  }
  if (d?.questionId !== questionId) { snaps.clear(); a = 0; b = null; zoom.clear() }
  d = dr.value; loadFail = null
  let changed = JSON.stringify(d) !== before
  if (wr) {
    draftFor = questionId; changed = true
    if (wr.ok) { draft = wr.value.draft ?? emptyDraft(); draftRevision = wr.value.revision; draftFail = null }
    else { draft = emptyDraft(); draftRevision = null; draftFail = wr }
  }
  const attempted = draft.replyId
  const rec = reconcile(draft, d)
  if (rec.kind === 'sent') {
    // The attempt was recorded (for example after a timeout): say so, with its actual state.
    const r = replies(d).find((x) => x.replyId === attempted)!
    draft = emptyDraft(); void saveDraftNow()
    notice = recordedNotice(r, d, true); say(notice.text); changed = true
  }
  if (rec.kind === 'superseded' && !(keepNotice && notice)) {
    // Kept as the owner wrote it; reusing it as a follow-up is the owner's explicit choice. A more
    // specific notice from the send that just lost is kept.
    notice = { tone: 'warn', text: 'Another answer was recorded first, so yours was not sent. The recorded answer is shown below. Your unsent answer is kept; nothing else is sent unless you choose to.' }
    say(notice.text); changed = true
  }
  if (!passive) render()
  else if (changed) requestRender(true)
  if (native) return
  // Same-package questions from the same origin workspace, each with its own state.
  // One bounded, server-searched page by package ID; only exact package members are kept.
  const pr = await call(req, 'listDecisionPage', {
    scope: { kind: 'workspace', workspace: { hostId: d.origin.hostId, workspaceId: d.origin.workspaceId } },
    query: d.packageId, includeHistory: true, timeZone: clock.zone()
  })
  if (mine !== seq || !d) return
  const pkgBefore = JSON.stringify([pkg, pkgFail])
  if (pr.ok) { pkg = pr.value.rows.filter((x) => x.packageId === d!.packageId && x.questionId !== d!.questionId); pkgFail = null }
  else if (!passive) { pkg = []; pkgFail = pr }
  if (JSON.stringify([pkg, pkgFail]) !== pkgBefore) requestRender(passive)
  if (passive && !busy() && !saveTimer) await checkExternalDraft(questionId)
}

/**
 * After an invalidation, a stored draft revision we did not write means another tab or window
 * changed this draft. Adopt it only when this tab has no unsaved edits; otherwise the next save's
 * compare-and-set reports the conflict.
 */
async function checkExternalDraft(questionId: string) {
  await saving
  if (draftFor !== questionId || saveTimer || draftRevision === null) return
  const g = await call(req, 'draft.get', { questionId })
  if (!g.ok || draftFor !== questionId || saveTimer || busy() || g.value.revision === draftRevision) return
  draft = g.value.draft ?? emptyDraft(); draftRevision = g.value.revision
  notice = { tone: 'warn', text: 'This draft was changed in another tab or window. The saved draft is shown.' }
  say(notice.text); render()
}

// ---- draft persistence (worker-backed, bound to the question ID) --------------------------------
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saving: Promise<unknown> = Promise.resolve()
/** The stored draft's revision for compare-and-set; null when it could not be read. */
let draftRevision: number | null = null
function scheduleSave() {
  // Every edit records what the owner is writing, from the page they see: an initial answer while
  // the question awaits one, otherwise a follow-up. Only a genuine initial answer can be held.
  const x = shownD ?? d
  if (!draft.kind && x && !draftIsEmpty(draft)) draft.kind = answered(x) ? 'follow-up' : 'initial'
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { saveTimer = null; void saveDraftNow() }, 400)
}
/**
 * Saves the current draft (partial notes included) for the question it belongs to, against the
 * stored revision. Saves run one at a time, in order. Resolves true only when this save is durable.
 * A conflict means another tab or window saved first: its draft is loaded and shown instead.
 */
function saveDraftNow(): Promise<boolean> {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  const questionId = draftFor
  if (!questionId) return saving.then(() => false)
  const value: Draft | null = draftIsEmpty(draft) && !draft.replyId ? null : structuredClone(draft)
  const p = saving.then(async (): Promise<boolean> => {
    if (draftRevision === null) {
      const g = await call(req, 'draft.get', { questionId })
      if (draftFor !== questionId) return false
      if (!g.ok) { draftFail = g; requestRender(); return false }
      draftRevision = g.value.revision
    }
    const r = await call(req, 'draft.save', { questionId, draft: value, revision: draftRevision })
    if (draftFor !== questionId) return r.ok
    if (r.ok) {
      draftRevision = r.value.revision
      if (draftFail) { draftFail = null; requestRender() }
      return true
    }
    if (r.code === 'conflict') {
      const g = await call(req, 'draft.get', { questionId })
      if (draftFor !== questionId) return false
      if (g.ok) {
        draft = g.value.draft ?? emptyDraft(); draftRevision = g.value.revision; draftFail = null
        notice = { tone: 'warn', text: 'This draft was changed in another tab or window, so your latest edit was not saved. The saved draft is shown.' }
        say(notice.text)
      } else { draftRevision = null; draftFail = g }
      render(); return false
    }
    draftFail = r; requestRender(); return false
  })
  saving = p.catch(() => false)
  return p
}
const flushDraft = () => (saveTimer ? saveDraftNow() : saving)
orca.on('editor.flush', () => flushDraft())
window.addEventListener('pagehide', () => { void flushDraft() })
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void flushDraft() })

// ---- annotations --------------------------------------------------------------------------------
function staleNote(n: Annotation, x: Decision): string | null {
  if (n.kind === 'selection' && n.anchor.kind === 'question') {
    if (n.anchor.revision !== x.revision || x[n.anchor.field].slice(n.start, n.end) !== n.quote) return 'The text changed since this note was made. Remove it and select the text again.'
    return null
  }
  const ref = n.kind === 'image' ? n.evidence : n.anchor.kind === 'evidence' ? n.anchor.evidence : null
  if (ref && !x.evidence.some((e) => e.evidenceId === ref.evidenceId && e.version === ref.version)) return 'This evidence version is no longer attached.'
  return null
}
function addSelection(note: string) {
  if (!d || !quote) return
  draft.annotations.push({ kind: 'selection', anchor: { kind: 'question', field: quote.field, revision: d.revision }, start: quote.start, end: quote.end, quote: quote.text, text: note })
  scheduleSave()
}
function addQuoteNote() {
  const q = quote; pop.style.display = 'none'
  if (!q || (d && nativeOf(d))) return
  if (narrow.matches) return openComposer(q)
  addSelection('')
  focusNote = draft.annotations.length - 1
  quote = null; render(); say('Note added in the sidebar')
}
/**
 * Narrow layout (no sidebar): a native modal that lists every note for review, editing and
 * removal, plus a new note for the current selection when there is one. The browser handles the
 * inert page, focus containment, Esc and focus return; closing re-renders the page.
 */
function openComposer(quoted: { field: 'background' | 'recommendation'; text: string; start: number; end: number } | null) {
  fillComposer(quoted)
  if (!composer.open) composer.showModal()
}
function fillComposer(quoted: typeof quote) {
  const x = d; if (!x) return
  const ta = el<HTMLTextAreaElement>('textarea', { rows: 3, 'aria-label': 'New note', placeholder: 'Your note', autofocus: true })
  composer.replaceChildren(
    el('h3', { id: 'cmp-h', style: 'margin:0 0 6px' }, `Notes (${draft.annotations.length})`),
    ...(draft.annotations.length ? draft.annotations.map((n, i) => noteEditor(n, i, x, 'dialog'))
      : [el('p', { class: 'meta' }, 'No notes yet. Select text in Background or Recommendation to add one.')]),
    ...(quoted ? [el('h3', { style: 'margin:10px 0 4px' }, 'Add a note'), el('div', { class: 'raw' }, quoted.text), ta,
      el('div', { style: 'display:flex;justify-content:flex-end;margin-top:6px' }, el('button', { type: 'button', class: 'pri', onclick: () => {
        const text = ta.value
        if (!text.trim()) return say('Write the note first')
        quote = quoted; addSelection(text); quote = null; say('Note added'); fillComposer(null)
      } }, 'Add note'))] : []),
    el('div', { style: 'display:flex;gap:6px;justify-content:flex-end;margin-top:10px' },
      el('button', { type: 'button', autofocus: !quoted, onclick: () => composer.close() }, 'Done')))
}
/**
 * UTF-16 offsets into the field's text. A selection may start or end outside the paragraph or on an
 * element boundary (a triple-click ends at the start of the next element); it is clipped to the
 * field's text node.
 */
document.addEventListener('selectionchange', () => {
  const sel = getSelection()
  const had = quote !== null
  quote = null
  if (sel && sel.rangeCount && !sel.isCollapsed && d) {
    const r = sel.getRangeAt(0)
    for (const f of ['background', 'recommendation'] as const) {
      const p = root.querySelector(`[data-field="${f}"]`); const node = p?.firstChild
      if (!p || !node || !r.intersectsNode(node)) continue
      const len = d[f].length
      const whole = document.createRange(); whole.selectNodeContents(node)
      const start = r.startContainer === node ? r.startOffset : r.compareBoundaryPoints(Range.START_TO_START, whole) <= 0 ? 0 : len
      const end = r.endContainer === node ? r.endOffset : r.compareBoundaryPoints(Range.END_TO_END, whole) >= 0 ? len : 0
      const text = d[f].slice(start, end)
      if (end > start && text.trim()) quote = { field: f, text, start, end }
      break
    }
  }
  if (quote) {
    const box = sel!.getRangeAt(0).getBoundingClientRect()
    pop.style.cssText = `display:block;left:${box.left}px;top:${box.bottom + 6}px`
  } else {
    pop.style.display = 'none'
    if (had) flushSoon()
  }
})
document.addEventListener('keydown', (e) => {
  if (composer.open) return
  // e.code: on macOS Option+N is a dead key, so e.key is not "n" there.
  if (e.altKey && (e.code === 'KeyN' || e.key.toLowerCase() === 'n')) { e.preventDefault(); if (quote) addQuoteNote() }
  if (e.key === 'Escape') pop.style.display = 'none'
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && ref.view === 'review') { e.preventDefault(); void send() }
})

// ---- reply --------------------------------------------------------------------------------------
const answered = (x: Decision) => x.answerState.state === 'answered'
/** The decision as last drawn. Sends act on what the owner saw, never on a newer reload. */
let shownD: Decision | null = null
/** An initial answer the owner wrote that lost to another accepted answer: kept, never sent. */
const heldInitial = (x: Decision) => answered(x) && (draft.kind ?? 'initial') === 'initial' && !draftIsEmpty(draft)
function buildAnswer(x: Decision): Answer | null {
  const text = draft.text.trim()
  if (!answered(x) && draft.optionId && x.options.some((o) => o.optionId === draft.optionId))
    return { kind: 'option', optionId: draft.optionId, ...(text ? { detail: text } : {}) }
  return text ? { kind: 'text', text } : null
}

/** Opens the notes that block sending: the dialog on narrow layouts, the sidebar otherwise. */
function reviewNotes() {
  const x = d; if (!x) return
  if (narrow.matches) return openComposer(null)
  const i = draft.annotations.findIndex((n) => noteProblem(n, x))
  root.querySelector<HTMLElement>(`[data-note="${Math.max(0, i)}"]`)?.focus()
}

/**
 * Sends the initial answer or a follow-up. The reply ID is minted once per attempt and saved in
 * the draft before the request, so a retry (after a timeout, a restart or `unavailable`) reuses it.
 * The payload is fixed when Send is pressed and the compose fields are locked until the worker
 * answers, so nothing typed meanwhile is lost or mixed into the request.
 */
async function send() {
  const x = shownD
  if (!x || !d || sending) return
  // A background reload may have replaced the decision while drawing waited for the owner (for
  // example another surface recorded the answer). Never send against a page the owner did not see.
  if (x.questionId !== d.questionId || x.revision !== d.revision || JSON.stringify(x.answerState) !== JSON.stringify(d.answerState)) {
    notice = { tone: 'warn', text: 'This decision changed while you were writing, so nothing was sent. Check what is recorded below before you continue; your text is kept.' }
    render(); return say(notice.text)
  }
  if (heldInitial(x)) return say('Your unsent answer was not sent because another answer was recorded first. Choose “Write a follow-up from this text” to send it as a follow-up.')
  const kind: SubmitReply['kind'] = answered(x) ? 'follow-up' : 'initial'
  if (!actionsOf(x).includes(kind === 'initial' ? 'reply' : 'follow-up')) return say('Replying here is not available for this decision.')
  const answer = buildAnswer(x)
  if (!answer) return say(kind === 'initial' ? 'Choose an option or write a reply first' : 'Write a follow-up first')
  if (draft.annotations.some((n) => noteProblem(n, x))) {
    notice = { tone: 'bad', notes: true, text: 'Some notes are empty or no longer match the decision. Fix or remove them in Notes, then send again.' }
    render(); return say(notice.text)
  }
  sending = true
  if (!draft.replyId || draft.kind !== kind) { draft.replyId = newReplyId(); draft.kind = kind }
  const replyId = draft.replyId
  const annotations: Annotation[] = draft.annotations.map((n) => ({ ...structuredClone(n), text: n.text.trim() }))
  notice = null; render()
  // The attempt (with its reply ID) must be durable before sending, or a retry after a restart
  // could not reuse the ID.
  if (!(await saveDraftNow())) {
    sending = false
    if (d?.questionId !== x.questionId) return
    // A draft conflict during the save already set its own (warn) notice.
    const cur = notice as Notice | null
    if (!cur || cur.tone !== 'warn') notice = { tone: 'bad', retry: !!draft.replyId, text: `Not sent. This reply attempt could not be saved first, so a later retry could not reuse its reply ID.${draftFail ? ` ${failureText(draftFail)}` : ''}` }
    say((notice as Notice | null)?.text ?? ''); render(); return
  }
  const r = await call(req, 'submitReply', { questionId: x.questionId, replyId, kind, answer, annotations })
  sending = false
  if (d?.questionId !== x.questionId) return
  let conflictId: string | null = null
  if (r.ok && r.value.replyId === replyId) {
    draft = emptyDraft(); void saveDraftNow()
    notice = recordedNotice(r.value, x, true)
  } else if (r.ok) {
    // The first accepted answer wins. Keep the owner's answer as written (option included); it
    // becomes a follow-up only if the owner chooses that.
    const { replyId: _id, ...rest } = draft
    draft = rest; void saveDraftNow()
    notice = recordedNotice(r.value, x, false)
  } else if (r.code === 'conflict') {
    // This reply ID is already bound to other content. Keep the text as a new attempt and say
    // what was actually recorded once the decision reloads.
    conflictId = replyId
    const { replyId: _id, ...rest } = draft
    draft = rest; void saveDraftNow()
    notice = null
  } else if (r.code === 'unavailable') {
    // Ambiguous: the worker may have recorded it. The reload below reconciles by reply ID.
    notice = { tone: 'bad', retry: true, text: `Not confirmed. ${failureText(r)} The reply may or may not have been recorded. The draft and reply ID ${replyId} are kept; Retry sends the same reply ID, so it is recorded at most once.` }
  } else {
    notice = { tone: 'bad', retry: true, text: `Not sent. ${failureText(r)} Your draft and reply ID are kept.` }
  }
  if (notice) say(notice.text)
  await loadReview(x.questionId, true)
  if (conflictId && d?.questionId === x.questionId) {
    const rec = replies(d).find((y) => y.replyId === conflictId)
    const kept = draft.text.trim() ? ' Your text is kept as a new draft.' : ''
    notice = rec
      ? { tone: 'warn', text: `An earlier attempt with reply ID ${conflictId} was already recorded with different content. That recorded reply is shown below (${STATE_LABEL[replyState(rec, d)]}).${kept}` }
      : { tone: 'warn', text: `Reply ID ${conflictId} could not be used because a different reply was already recorded. The recorded answer is shown below.${kept}` }
    say(notice.text); render()
  }
}

async function retryDelivery(r: RecordedReply) {
  const x = d; if (!x) return
  const out = await call(req, 'retryReply', { questionId: r.questionId, replyId: r.replyId })
  notice = out.ok
    ? { tone: 'info', text: `Retried reply ${out.value.replyId} to the original chat. ${STATE_LABEL[replyState(out.value, x)]}.` }
    : { tone: 'bad', text: `Retry failed. ${failureText(out)} The reply is kept.` }
  say(notice.text)
  await loadReview(x.questionId, true)
}

async function copy(text: string, what: string) {
  try { await navigator.clipboard.writeText(text); say(`${what} copied`) }
  catch { say(`Could not copy the ${what.toLowerCase()}. Select the text and copy it instead.`) }
}

async function openLink(url: string) {
  const r = await orca.shell?.openExternal(url)
  if (!r) say('Opening links is not available here.')
  else if (!r.opened) say(r.reason === 'cancelled' ? 'Link not opened.' : 'Could not ask to open the link.')
}

async function openOther(questionId: string) {
  const r = await call(req, 'review.open', { questionId })
  if (!r.ok) { notice = { tone: 'bad', text: `Could not open that question. ${failureText(r)}` }; say(notice.text); render() }
}

// ---- evidence -----------------------------------------------------------------------------------
// PROVISIONAL (proposed by design, not owner-signed): one large viewer with an optional
// side-by-side compare. Reversible; confirm during owner review.
type Img = Extract<Evidence, { kind: 'image-snapshot' }>
const MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
function ensureSnapshot(e: Img) {
  const x = d; if (!x || snaps.has(e.attachmentId)) return
  snaps.set(e.attachmentId, { state: 'loading' })
  void call(req, 'getSnapshot', { questionId: x.questionId, attachmentId: e.attachmentId }).then((r) => {
    if (d?.questionId !== x.questionId) return
    const ok = r.ok && MIME.has(r.value.mimeType) && /^[A-Za-z0-9+/]+={0,2}$/.test(r.value.base64)
    snaps.set(e.attachmentId, ok ? { state: 'ok', url: `data:${r.value.mimeType};base64,${r.value.base64}` }
      : { state: 'fail', f: r.ok ? { ok: false, code: 'unavailable', message: 'The snapshot data was not a supported image.' } : r })
    requestRender()
  })
}
function snapshotFailure(e: Img, f: Failure) {
  const text = f.code === 'forbidden' ? 'You do not have access to this snapshot.'
    : f.code === 'not-found' ? 'Snapshot expired or missing.'
    : `Could not load the snapshot. ${failureText(f)}`
  return el('div', { class: 'miss' }, el('div', {}, el('p', { style: 'margin:0 0 6px' }, text),
    ...(f.code === 'unavailable' ? [el('button', { type: 'button', onclick: () => { snaps.delete(e.attachmentId); render() } }, 'Try again')] : [])))
}
function viewer(list: Img[], i: number, side: string) {
  const e = list[i]
  ensureSnapshot(e)
  const z = zoom.get(e.evidenceId) ?? 1
  const s = snaps.get(e.attachmentId)!
  const v = el('div', { class: 'view', tabindex: 0, 'data-k': `view-${side}`, role: 'group', 'aria-label': `${side} viewer: ${e.label}, v${e.version}, zoom ${Math.round(z * 100)}%` })
  if (s.state === 'ok') v.append(el('img', { src: s.url, alt: e.alt, width: e.width, height: e.height, style: `width:${Math.round(z * 100)}%` }))
  else if (s.state === 'loading') v.append(el('div', { class: 'miss', style: `aspect-ratio:${e.width}/${e.height}` }, `Loading ${e.label} (${e.width}×${e.height})…`))
  else v.append(snapshotFailure(e, s.f))
  const zb = (label: string, name: string, f: (n: number) => number) => el('button', { type: 'button', 'data-k': `z-${side}-${name}`, 'aria-label': `${name} ${e.label}`, onclick: () => { zoom.set(e.evidenceId, f(z)); render() } }, label)
  const note = draft.annotations.find((n) => n.kind === 'image' && n.evidence.evidenceId === e.evidenceId && n.evidence.version === e.version)
  return el('div', {}, v, el('div', { class: 'bar' }, zb('−', 'Zoom out', (n) => Math.max(0.25, n - 0.25)), zb('+', 'Zoom in', (n) => Math.min(4, n + 0.25)), zb('100%', 'Reset zoom', () => 1),
    field('input', { type: 'text', 'data-k': `note-${e.evidenceId}`, 'aria-label': `Note for ${e.label}`, placeholder: `Note on ${e.label}`,
      // Commit on every keystroke, as typed (trimmed only when sent). No re-render on blur, so a
      // click that moves focus away (Submit, Remove) is never swallowed by a rebuilt button.
      oninput: (ev: Event) => { setImageNote(e, (ev.target as HTMLInputElement).value); scheduleSave(); refreshNotes() } }, note?.text ?? '')))
}

/**
 * One note per image version, kept in place so the sidebar order stays stable while typing. The
 * text is stored exactly as typed ("Check the " keeps its space); clearing the field removes it.
 */
function setImageNote(e: Img, text: string) {
  const i = draft.annotations.findIndex((n) => n.kind === 'image' && n.evidence.evidenceId === e.evidenceId)
  const note: Annotation = { kind: 'image', evidence: { evidenceId: e.evidenceId, version: e.version }, text }
  if (i < 0) { if (text.trim()) draft.annotations.push(note) }
  else if (text.trim()) draft.annotations[i] = note
  else draft.annotations.splice(i, 1)
}

/** Notes that would block sending: empty, or no longer matching the decision. */
const noteProblem = (n: Annotation, x: Decision) => (!n.text.trim() ? 'This note is empty. Write it or remove it.' : staleNote(n, x))
const notesLabel = (x: Decision) => {
  const bad = draft.annotations.filter((n) => noteProblem(n, x)).length
  return `Notes (${draft.annotations.length})${bad ? ` · ${bad} need${bad > 1 ? '' : 's'} attention` : ''}`
}
/**
 * Updates note counts and the sidebar in place after a note edit, without rebuilding the page.
 * The sidebar is rebuilt only when focus is not inside it.
 */
function refreshNotes() {
  const x = d; if (!x) return
  root.querySelectorAll('[data-k="notes-open"]').forEach((btn) => { btn.textContent = notesLabel(x) })
  const side = root.querySelector('aside.side')
  if (side && !side.contains(document.activeElement)) side.replaceChildren(sidebar(x))
}

function sidebar(x: Decision) {
  const list = draft.annotations
  return el('div', {}, el('h2', { style: 'margin-top:0' }, `Notes (${list.length})`),
    ...(list.length ? [] : [el('p', { class: 'meta' }, 'Select text in Background or Recommendation, or write under an image. Notes go out together with your reply.')]),
    ...list.map((n, i) => noteEditor(n, i, x, 'side')))
}

/** One note with its anchor, any problem, its text and Remove. Shared by the sidebar and the
 *  narrow-layout notes dialog, so notes that block sending can be fixed at any width. */
function noteEditor(n: Annotation, i: number, x: Decision, where: 'side' | 'dialog') {
  const name = n.kind === 'image'
    ? `${x.evidence.find((e) => e.evidenceId === n.evidence.evidenceId)?.label ?? n.evidence.evidenceId} · v${n.evidence.version}`
    : n.anchor.kind === 'question' ? (n.anchor.field === 'background' ? 'Background' : 'Recommendation') : 'Evidence'
  const problem = noteProblem(n, x)
  const errId = `${where}-note-err-${i}`
  return el('div', { class: `note${problem ? ' stale' : ''}` },
    el('b', {}, name), ...(n.kind === 'selection' ? [el('q', {}, n.quote)] : []),
    ...(problem ? [el('div', { class: 'err', id: errId }, problem)] : []),
    field(where === 'side' ? 'input' : 'textarea', {
      ...(where === 'side' ? { type: 'text', 'data-note': i } : { rows: 2, 'data-dialog-note': i }),
      'data-k': `${where}-note-${i}`, 'aria-label': `Note text ${i + 1}`, 'aria-describedby': problem ? errId : false,
      oninput: (ev: Event) => { n.text = (ev.target as HTMLInputElement).value; scheduleSave(); refreshNotes() }
    }, n.text),
    el('button', { type: 'button', 'aria-label': `Remove note ${i + 1}`, onclick: () => {
      draft.annotations.splice(draft.annotations.indexOf(n), 1); scheduleSave()
      say('Note removed')
      if (where === 'dialog') fillComposer(null); else render()
    } }, 'Remove'))
}

// ---- answered thread and follow-ups -------------------------------------------------------------
const REASON: Record<Extract<Delivery, { state: 'undelivered' }>['reason'], string> = {
  'closed-origin': 'The original chat is closed.',
  disconnected: 'The host is disconnected.',
  'origin-mismatch': 'The chat no longer matches the original origin.',
  'delivery-failed': 'Orca could not hand it to that chat.'
}
const when = (iso: string) => formatInstant(iso, clock.zone())
function answerText(ans: Answer, x: Decision) {
  if (ans.kind === 'text') return ans.text
  const label = x.options.find((o) => o.optionId === ans.optionId)?.label ?? ans.optionId
  return ans.detail ? `${label}\n${ans.detail}` : label
}
/** Each reply carries its own delivery state: a receipt only ever applies to its own reply ID. */
/**
 * Mail custody and the origin's acknowledgement are separate facts: mail submitted means Orca
 * accepted the message for the original chat, not that the agent there received it.
 */
function mailLine(r: RecordedReply): string {
  const t = transportOf(r.delivery)
  return t ? `Mail submitted to the original chat at ${when(t.acceptedAt)} (message ${t.messageId}); waiting for that chat to acknowledge it.`
    : 'Mail hand-off to the original chat is not reported yet; waiting for that chat to acknowledge it.'
}
function deliveryView(r: RecordedReply, x: Decision) {
  const s = r.delivery
  const state = replyState(r, x)
  if (state === 'agent-received' && s.state === 'agent-received')
    return el('div', { class: 'meta' }, el('span', { class: 'chip' }, `● ${STATE_LABEL['agent-received']}`), `Receipt ${s.receipt.receiptId} · ${when(s.receipt.receivedAt)}`)
  if (s.state === 'undelivered')
    return el('div', { class: 'callout', ...alertRole(`undelivered:${r.replyId}:${s.reason}`) }, el('b', {}, `${STATE_LABEL.undelivered}. `),
      `Saved in Decision Inbox, but not delivered to the original chat. ${REASON[s.reason]} `,
      // Retry only when the worker supports it for this decision.
      ...(actionsOf(x).includes('retry') ? [el('button', { type: 'button', 'data-k': `retry-${r.replyId}`, onclick: () => retryDelivery(r) }, 'Retry (same reply ID, same destination)'), ' ']
        : [el('span', {}, 'Retry is not available here; copy the reply and paste it into that chat if it is needed now. ')]),
      el('button', { type: 'button', 'data-k': `copy-${r.replyId}`, onclick: () => copy(answerText(r.answer, x), 'Reply') }, 'Copy reply'))
  return el('div', { class: 'meta' }, el('span', { class: 'chip' }, `● ${STATE_LABEL.submitted}`),
    s.state === 'agent-received' ? 'A receipt arrived that does not match this reply and origin, so it is not counted.' : mailLine(r))
}
const thread = (x: Decision): HTMLElement[] => {
  if (x.answerState.state !== 'answered') return []
  const { initial, followUps } = x.answerState
  return [initial, ...followUps].map((r, i) => el('section', { class: `reply${i ? ' fu' : ''}`, 'aria-label': i === 0 ? 'Your answer' : `Follow-up ${i}` },
    el('h3', {}, `${i === 0 ? 'Answer' : `Follow-up ${i}`} · accepted ${when(r.acceptedAt)} · ${r.replyId}`),
    el('div', { style: 'white-space:pre-wrap' }, answerText(r.answer, x)),
    ...(r.annotations.length ? [el('p', { class: 'meta' }, `${r.annotations.length} note${r.annotations.length > 1 ? 's' : ''} sent with this reply`)] : []),
    deliveryView(r, x)))
}

/** The owner's unsent initial answer after another answer won: shown, with explicit choices. */
function heldArea(x: Decision): HTMLElement[] {
  const opt = draft.optionId ? x.options.find((o) => o.optionId === draft.optionId)?.label ?? draft.optionId : null
  return [
    el('h2', {}, 'Your unsent answer'),
    el('p', { class: 'meta' }, 'Another answer was recorded first, so this was not sent. Nothing is sent unless you choose to.'),
    el('div', { class: 'raw' }, [opt && `Option: ${opt}`, draft.text.trim()].filter(Boolean).join('\n')),
    el('div', { class: 'bar' },
      el('button', { type: 'button', class: 'pri', 'data-k': 'start-follow', onclick: () => {
        const { replyId: _id, optionId: _opt, ...rest } = draft
        draft = { ...rest, kind: 'follow-up' }; scheduleSave(); notice = null; render()
        root.querySelector<HTMLElement>('[data-k="reply"]')?.focus()
        say(opt ? `Follow-up started from your text. The option ${opt} is not part of a follow-up; mention it in the text if it still applies.` : 'Follow-up started from your text.')
      } }, 'Write a follow-up from this text'),
      el('button', { type: 'button', 'data-k': 'copy-held', onclick: () => copy(draft.text, 'Unsent answer') }, 'Copy'),
      el('button', { type: 'button', 'data-k': 'discard-held', onclick: () => { draft = emptyDraft(); scheduleSave(); notice = null; render(); say('Unsent answer discarded') } }, 'Discard'))
  ]
}

function composeArea(x: Decision): HTMLElement[] {
  if (heldInitial(x)) return [...(notice ? [el('div', { class: `callout ${notice.tone === 'bad' ? '' : notice.tone}`, ...(notice.tone === 'bad' ? alertRole(`notice:${notice.text}`) : {}) }, notice.text)] : []), ...heldArea(x)]
  const isFollow = answered(x)
  const empty = !buildAnswer(x)
  const label = isFollow ? 'Send follow-up' : 'Submit reply'
  const sendBtn = el<HTMLButtonElement>('button', { type: 'button', class: 'pri', 'data-k': 'send', 'aria-disabled': empty || sending, onclick: () => send() }, sending ? 'Sending…' : label)
  const ta = field('textarea', {
    rows: 3, 'data-k': 'reply', 'aria-label': isFollow ? 'Follow-up' : 'Reply text', readonly: sending, 'aria-busy': sending,
    placeholder: isFollow ? 'Follow-up to the agent (Ctrl+Enter to send)' : draft.optionId ? 'Optional detail with your option (Ctrl+Enter to submit)' : 'Free-text answer (Ctrl+Enter to submit)'
  }, draft.text)
  const onEdit = () => { draft.text = ta.value; scheduleSave(); sendBtn.setAttribute('aria-disabled', String(!buildAnswer(x) || sending)) }
  ta.addEventListener('input', onEdit); ta.addEventListener('change', onEdit)
  return [
    ...(isFollow ? [el('h2', {}, 'Add a follow-up'), el('p', { class: 'meta' }, 'Your first answer stays exactly as recorded. A follow-up is added below it and has its own receipt.')]
      : [el('h2', {}, 'Reply')]),
    el('button', { type: 'button', class: 'only-narrow', 'data-k': 'notes-open', style: 'margin-bottom:6px', onclick: () => openComposer(quote) }, notesLabel(x)),
    ta,
    ...(notice ? [el('div', { class: `callout ${notice.tone === 'bad' ? '' : notice.tone}`, ...(notice.tone === 'bad' ? alertRole(`notice:${notice.text}`) : {}) }, notice.text,
      ...(notice.retry && draft.replyId ? [' ', el('button', { type: 'button', 'data-k': 'retry-send', onclick: () => send() }, `Retry (same reply ID ${draft.replyId})`), ' ',
        el('button', { type: 'button', onclick: () => copy(draft.text, 'Reply') }, 'Copy reply')] : []),
      ...(notice.notes ? [' ', el('button', { type: 'button', 'data-k': 'review-notes', onclick: () => reviewNotes() }, 'Review notes')] : []))] : []),
    ...(draftFail ? [el('div', { class: 'callout warn', role: 'status' }, `Draft not saved. ${failureText(draftFail)} It is kept in this tab only.`)] : []),
    el('div', { class: 'bar' }, sendBtn, ...(draft.replyId ? [el('span', { class: 'meta' }, `Reply ID ${draft.replyId}`)] : []))
  ]
}

const STEPS: ShownState[] = ['awaiting-answer', 'submitted', 'agent-received', 'undelivered']
function renderReview(questionId: string) {
  const x = d
  if (!x) {
    shownD = null
    root.replaceChildren(el('main', {}, loadFail
      ? el('div', { class: 'callout', ...alertRole(`load:${questionId}:${loadFail.code}`) }, loadFail.code === 'not-found'
        ? `Decision "${questionId}" was not found. It may have been withdrawn, or you may not have access.`
        : loadFail.code === 'forbidden' ? `You do not have access to decision "${questionId}".`
        : `Could not load decision "${questionId}". ${failureText(loadFail)}`,
        ...(loadFail.code === 'unavailable' ? [' ', el('button', { type: 'button', onclick: () => loadReview(questionId) }, 'Try again')] : []))
      : el('p', { class: 'meta', role: 'status' }, 'Loading decision…')))
    return
  }
  const native = nativeOf(x)
  if (native) return renderNative(x, native)
  const now = clock.now()
  const state = shownState(x)
  const due = deadlineLabel(x, now)
  const imgs = x.evidence.filter((e): e is Img => e.kind === 'image-snapshot')
  const links = x.evidence.filter((e) => e.kind === 'link')
  const pair = b !== null && imgs.length > 1
  if (a >= imgs.length) a = 0
  if (b !== null && b >= imgs.length) b = null
  const remote = x.origin.hostId !== 'local'
  const main = el('main', {},
    el('div', { class: 'meta' }, x.projectName, '·', x.workspaceName, remote ? el('span', { class: 'chip' }, `host: ${x.origin.hostId}`) : '',
      el('span', { class: `chip ${x.priority === 'P0' ? 'bad' : ''}` }, x.priority),
      ...(x.deadline ? [el('span', { class: `chip ${due?.overdue ? 'bad' : ''}` }, `${due!.text} · ${when(x.deadline)}`)] : []),
      ...(x.blockedWork.length ? [`Blocks: ${x.blockedWork.join(', ')}`] : [])),
    el('h1', {}, x.title),
    el('div', { class: 'callout warn' }, `Replies go only to the original chat in ${x.projectName} / ${x.workspaceName}${remote ? ` on host “${x.origin.hostId}”` : ''}, whichever workspace you are in. Agent received appears only after that chat confirms this reply.`),
    ...(due?.overdue ? [el('div', { class: 'callout', ...alertRole(`due:${due.text}`) }, `${due.text}.`)] : []),
    ...(pkg.length || pkgFail ? [el('h2', {}, 'Same package · shared background and evidence'),
      pkgFail ? el('p', { class: 'meta' }, `Could not load the other questions in this package. ${failureText(pkgFail)}`)
        : el('div', { class: 'pkg' }, ...pkg.map((s) => el('span', { class: 'chip' }, `${s.title} · ${STATE_LABEL[shownState(s)]} `,
          el('button', { type: 'button', 'data-k': `open-${s.questionId}`, 'aria-label': `Open ${s.title}`, onclick: () => openOther(s.questionId) }, 'Open'))))] : []),
    el('h2', {}, 'Background'), el('p', { 'data-field': 'background', style: 'margin:0;user-select:text' }, x.background),
    el('h2', {}, 'Recommendation'), el('p', { 'data-field': 'recommendation', style: 'margin:0;user-select:text' }, x.recommendation),
    ...(answered(x) ? [] : [el('h2', {}, 'Options'),
      ...(x.options.length
        ? [el('div', { role: 'radiogroup', 'aria-label': 'Options' }, ...x.options.map((o) =>
            el('label', { class: 'opt' }, el<HTMLInputElement>('input', { type: 'radio', name: 'opt', 'data-k': `opt-${o.optionId}`, checked: draft.optionId === o.optionId, disabled: sending, onchange: () => { draft.optionId = o.optionId; scheduleSave(); render() } }),
              el('span', {}, o.label, ...(o.detail ? [el('div', { class: 'meta' }, o.detail)] : [])))))]
        : [el('p', { class: 'meta' }, 'No fixed options. Answer in text.')])]),
    ...(imgs.length ? [el('h2', {}, `Evidence · ${imgs.length} private snapshot${imgs.length > 1 ? 's' : ''}`),
      el('div', { class: 'film', role: 'group', 'aria-label': 'Snapshots' }, ...imgs.map((e, i) => el('button', {
        type: 'button', 'data-k': `thumb-${i}`, 'aria-pressed': a === i || b === i,
        onclick: (ev: MouseEvent) => { if (!pair) a = i; else if (ev.shiftKey || target === 'left') a = i; else b = i; render() }
      }, `${i + 1} · ${e.label}`))),
      el('div', { class: 'bar' }, el('button', { type: 'button', 'data-k': 'compare', 'aria-pressed': pair, onclick: () => { b = pair ? null : (a + 1) % imgs.length; target = 'right'; render() } }, 'Compare side by side'),
        ...(pair ? [el('span', { class: 'meta' }, 'Thumbnails fill:'),
          el('button', { type: 'button', 'data-k': 'target-left', 'aria-pressed': target === 'left', onclick: () => { target = 'left'; render() } }, 'Left'),
          el('button', { type: 'button', 'data-k': 'target-right', 'aria-pressed': target === 'right', onclick: () => { target = 'right'; render() } }, 'Right'),
          el('span', { class: 'meta' }, 'Shift-click fills the left.')] : [])),
      el('div', { class: `vp${pair ? ' pair' : ''}` }, viewer(imgs, a, pair ? 'Left' : 'Main'), ...(pair ? [viewer(imgs, b!, 'Right')] : []))] : []),
    ...(links.length ? [el('h2', {}, 'Linked evidence'), el('p', { style: 'margin:0' }, ...links.map((l) => l.kind === 'link'
      ? el('a', { href: l.url, onclick: (ev: Event) => { ev.preventDefault(); void openLink(l.url) } }, `${l.label} · v${l.version} ↗  `) : ''))] : []),
    ...(answered(x) ? [el('h2', {}, 'Recorded answer and follow-ups'), ...thread(x)] : []),
    ...(actionsOf(x).includes(answered(x) ? 'follow-up' : 'reply') ? composeArea(x)
      : [el('h2', {}, answered(x) ? 'Add a follow-up' : 'Reply'), el('p', { class: 'meta' }, 'Replying here is not available for this decision right now.')]),
    el('ol', { class: 'strip', 'aria-label': 'Delivery state of the answer' }, ...STEPS.map((s) =>
      el('li', { class: `step ${s === 'undelivered' ? 'bad' : ''}`, 'aria-current': s === state ? 'step' : false }, `${s === state ? '● ' : '○ '}${STATE_LABEL[s]}`))),
    el('h2', {}, 'Source links'),
    el('p', { style: 'margin:0' }, ...x.sourceLinks.map((l) => el('a', { href: l.url, onclick: (ev: Event) => { ev.preventDefault(); void openLink(l.url) } }, `${l.label} ↗  `)),
      el('button', { type: 'button', onclick: () => copy(x.decisionLink, 'Decision link') }, 'Copy decision link')))
  root.replaceChildren(main, el('aside', { class: 'side', 'aria-label': 'Notes' }, sidebar(x)))
  shownD = x
  if (focusNote !== null) { root.querySelector<HTMLInputElement>(`[data-note="${focusNote}"]`)?.focus(); focusNote = null }
}

// ---- native Bot Item (read-only) ------------------------------------------------------------------
/**
 * A read-only copy of a native Orca Bot Item. The Inbox shows what Orca reported and where to
 * answer it; it offers no reply, notes, retry, resolve or deep link, because none is supported.
 */
function renderNative(x: Decision, n: NativeSource) {
  const due = deadlineLabel(x, clock.now())
  const links = x.evidence.filter((e) => e.kind === 'link')
  const item = [n.botName && `bot “${n.botName}”`, n.itemLabel && `item ${n.itemLabel}`].filter(Boolean).join(', ')
  const main = el('main', {},
    el('div', { class: 'meta' },
      el('span', { class: 'chip' }, 'Bot Item · read-only'),
      ...(n.workspaceAttributed ? [x.projectName, '·', x.workspaceName] : [el('span', { class: 'chip' }, 'No workspace attribution')]),
      ...(x.origin.hostId && x.origin.hostId !== 'local' ? [el('span', { class: 'chip' }, `host: ${x.origin.hostId}`)] : []),
      el('span', { class: `chip ${x.priority === 'P0' ? 'bad' : ''}` }, x.priority),
      ...(x.deadline ? [el('span', { class: `chip ${due?.overdue ? 'bad' : ''}` }, `${due!.text} · ${when(x.deadline)}`)] : [])),
    el('h1', {}, x.title),
    el('section', { class: 'callout info', 'aria-labelledby': 'answer-where' },
      el('h2', { id: 'answer-where', style: 'margin-top:0' }, 'Where to answer'),
      el('p', { style: 'margin:0' }, `Answer this in Orca's Bot Items${item ? `: ${item}` : ''}. The Inbox shows a read-only copy and cannot answer, resolve or open this item for you.`)),
    el('h2', {}, 'Status in Orca'),
    el('p', { style: 'margin:0' }, nativeStatusLabel(n.itemStatus), ...(n.observedAt ? [el('span', { class: 'meta' }, ` · as of ${when(n.observedAt)}`)] : [])),
    ...(x.background ? [el('h2', {}, 'Details'), el('p', { style: 'margin:0;white-space:pre-wrap' }, x.background)] : []),
    ...(x.recommendation ? [el('h2', {}, 'Recommendation'), el('p', { style: 'margin:0;white-space:pre-wrap' }, x.recommendation)] : []),
    ...(x.options.length ? [el('h2', {}, 'Options offered in Orca'),
      el('ul', {}, ...x.options.map((o) => el('li', {}, o.label, ...(o.detail ? [el('div', { class: 'meta' }, o.detail)] : []))))] : []),
    ...(x.blockedWork.length ? [el('h2', {}, 'Blocks'), el('p', { style: 'margin:0' }, x.blockedWork.join(', '))] : []),
    ...(links.length ? [el('h2', {}, 'Linked evidence'), el('p', { style: 'margin:0' }, ...links.map((l) => l.kind === 'link'
      ? el('a', { href: l.url, onclick: (ev: Event) => { ev.preventDefault(); void openLink(l.url) } }, `${l.label} · v${l.version} ↗  `) : ''))] : []),
    ...(x.sourceLinks.length ? [el('h2', {}, 'Source links'), el('p', { style: 'margin:0' }, ...x.sourceLinks.map((l) =>
      el('a', { href: l.url, onclick: (ev: Event) => { ev.preventDefault(); void openLink(l.url) } }, `${l.label} ↗  `)))] : []))
  root.replaceChildren(main)
  shownD = x
}

// ---- Inbox Settings (same editor, `{"view":"settings"}`) -----------------------------------------
const ANY_OTHER = '(any other repo)'
let settings: InboxSettings | null = null
let savedSettings = ''
let settingsFail: Failure | null = null
let repos: string[] = []
let reposFail: Failure | null = null
let previewRepo = ANY_OTHER
let effective: { repo: string; r: { ok: true; value: EffectivePolicy } | Failure } | null = null
let settingsNotice: Notice | null = null
let stale = false
const editable = (s: InboxSettings) => JSON.stringify({ defaultTemplate: s.defaultTemplate, exceptions: s.exceptions })

let previewChosen = false
async function loadSettings() {
  const [s, rp] = await Promise.all([call(req, 'settings.get'), call(req, 'settings.repos')])
  if (s.ok) { settings = s.value; savedSettings = editable(s.value); settingsFail = null; stale = false } else { settings = null; settingsFail = s }
  if (rp.ok) { repos = rp.value; reposFail = null } else { repos = []; reposFail = rp }
  if (previewRepo !== ANY_OTHER && !repos.includes(previewRepo)) previewRepo = ANY_OTHER
  // Start on the first repo once; afterwards keep the owner's choice, "(any other repo)" included.
  if (!previewChosen && previewRepo === ANY_OTHER && repos.length) previewRepo = repos[0]
  previewChosen = true
  effective = null
  render()
}
/**
 * An invalidation fires for drafts, replies and deliveries too. Settings count as changed
 * elsewhere only when the stored revision differs: then unsaved edits are kept and flagged, and a
 * clean form takes the new settings. The repo list refreshes quietly.
 */
async function settingsInvalidated() {
  if (!settings) return loadSettings()
  const [s, rp] = await Promise.all([call(req, 'settings.get'), call(req, 'settings.repos')])
  if (ref.view !== 'settings' || !settings) return
  let changed = false
  if (rp.ok && JSON.stringify(rp.value) !== JSON.stringify(repos)) { repos = rp.value; reposFail = null; changed = true }
  if (s.ok && s.value.revision !== settings.revision) {
    if (editable(settings) !== savedSettings) stale = true
    else { settings = s.value; savedSettings = editable(s.value); stale = false }
    effective = null; changed = true
  }
  if (changed) requestRender(true)
}
let effectiveLoading: string | null = null
async function loadEffective(repo: string) {
  if (effectiveLoading === repo) return
  effectiveLoading = repo
  const r = await call(req, 'settings.effective', { repo })
  effectiveLoading = null
  effective = { repo, r }
  render()
}
async function saveSettings() {
  if (!settings) return
  const r = await call(req, 'settings.save', settings)
  if (r.ok) { settings = r.value; savedSettings = editable(r.value); stale = false; effective = null; settingsNotice = { tone: 'info', text: 'Settings saved.' } }
  else if (r.code === 'conflict') settingsNotice = { tone: 'bad', text: 'Settings changed elsewhere since you opened them, so nothing was saved. Load the latest settings (your edits are discarded), then edit again.' }
  else settingsNotice = { tone: 'bad', text: `Not saved. ${failureText(r)}` }
  say(settingsNotice.text); render()
}

function renderSettings() {
  if (!settings) {
    root.replaceChildren(el('main', { class: 'set' }, el('h1', {}, 'Inbox settings'), settingsFail
      ? el('div', { class: 'callout', ...alertRole(`settings:${settingsFail.message}`) }, `Could not load Inbox settings. ${failureText(settingsFail)} `, el('button', { type: 'button', onclick: () => loadSettings() }, 'Try again'))
      : el('p', { class: 'meta', role: 'status' }, 'Loading settings…')))
    return
  }
  const s = settings
  const dirty = editable(s) !== savedSettings
  const used = new Set(s.exceptions.map((e) => e.repo))
  const free = repos.filter((r) => !used.has(r))
  const defaultEmpty = !s.defaultTemplate.trim()
  const select = (label: string, k: string, value: string, options: string[], onchange: (v: string) => void) =>
    el<HTMLSelectElement>('select', { 'aria-label': label, 'data-k': k, onchange: (ev: Event) => onchange((ev.target as HTMLSelectElement).value) },
      ...options.map((o) => el('option', { value: o, selected: o === value }, o)))
  // Unsaved edits preview locally; once saved, the worker's effective policy is the source of truth.
  let preview: HTMLElement
  if (previewRepo === ANY_OTHER || dirty) {
    const hit = previewRepo === ANY_OTHER ? undefined : s.exceptions.find((e) => e.repo === previewRepo)
    preview = el('div', { class: 'prev', style: 'margin-top:8px' },
      el('div', { class: 'meta' }, el('span', { class: 'chip' }, hit ? `Exception for ${hit.repo}` : 'Default'), dirty ? 'Preview of your unsaved changes.' : 'The saved default template.'),
      el('div', { class: 'raw' }, (hit ? hit.template : s.defaultTemplate) || '(empty)'))
  } else if (effective?.repo !== previewRepo) {
    void loadEffective(previewRepo)
    preview = el('p', { class: 'meta', role: 'status' }, 'Loading the effective rules…')
  } else if (!effective.r.ok) {
    preview = el('div', { class: 'callout', ...alertRole(`effective:${effective.r.message}`) }, `Could not load the effective rules. ${failureText(effective.r)}`)
  } else {
    const p = effective.r.value
    preview = el('div', { class: 'prev', style: 'margin-top:8px' },
      el('div', { class: 'meta' }, el('span', { class: 'chip' }, p.source === 'exception' ? `Exception for ${previewRepo}` : 'Default'), 'This is the template an agent in that repo is told to follow.'),
      el('div', { class: 'raw' }, p.template || '(empty)'))
  }
  root.replaceChildren(el('main', { class: 'set' },
    el('h1', {}, 'Inbox settings'),
    el('p', { class: 'meta' }, 'These rules guide agents in supported Orca Chats. Agents also read each repo’s AGENTS.md and the role file they are given; those are not edited here.'),
    ...(stale ? [el('div', { class: 'callout warn', role: 'status' }, 'Settings were changed elsewhere. ', el('button', { type: 'button', onclick: () => loadSettings() }, 'Load latest (discards your edits)'))] : []),
    el('h2', {}, 'Default question template'),
    field('textarea', { rows: 7, 'data-k': 'default', 'aria-label': 'Default question template', 'aria-invalid': defaultEmpty, 'aria-describedby': 'default-err',
      oninput: (ev: Event) => { s.defaultTemplate = (ev.target as HTMLTextAreaElement).value; settingsNotice = null; settingsChrome() } }, s.defaultTemplate),
    el('div', { class: 'err', id: 'default-err', 'data-k': 'default-err', 'aria-live': 'polite' }, defaultEmpty ? 'The default template cannot be empty.' : ''),
    el('h2', {}, `Repo exceptions (${s.exceptions.length})`),
    ...(reposFail ? [el('div', { class: 'callout warn', role: 'status' }, `Could not load the repo list. ${failureText(reposFail)}`)] : []),
    ...(s.exceptions.length ? [] : [el('p', { class: 'meta' }, 'No exceptions. Every repo uses the default template.')]),
    ...s.exceptions.map((e, i) => el('div', { class: 'row2' },
      select(`Repo for exception ${i + 1}`, `ex-repo-${i}`, e.repo, [e.repo, ...free], (v) => { e.repo = v; render() }),
      field('textarea', { rows: 3, 'data-k': `ex-tpl-${i}`, 'aria-label': `Template for ${e.repo}`, oninput: (ev: Event) => { e.template = (ev.target as HTMLTextAreaElement).value; settingsChrome() } }, e.template),
      el('button', { type: 'button', 'aria-label': `Remove exception for ${e.repo}`, onclick: () => { s.exceptions.splice(i, 1); render() } }, 'Remove'))),
    el('button', { type: 'button', 'data-k': 'add-ex', 'aria-disabled': free.length === 0, onclick: () => { if (free.length) { s.exceptions.push({ repo: free[0], template: s.defaultTemplate }); render() } } },
      free.length ? 'Add exception' : repos.length ? 'Every repo already has an exception' : 'No repos to add'),
    el('h2', {}, 'Effective rules preview'),
    select('Preview repo', 'preview-repo', previewRepo, [...repos, ANY_OTHER], (v) => { previewRepo = v; previewChosen = true; render() }),
    el('div', { 'data-k': 'preview' }, preview),
    el('div', { class: 'meta' }, previewRepo === ANY_OTHER ? 'Also read: that repo’s AGENTS.md and the selected role file.' : `Also read: ${previewRepo}/AGENTS.md and the selected role file.`),
    ...(settingsNotice ? [el('div', { class: `callout ${settingsNotice.tone === 'bad' ? '' : settingsNotice.tone}`, ...(settingsNotice.tone === 'bad' ? alertRole(`snotice:${settingsNotice.text}`) : {}) }, settingsNotice.text,
      ...(settingsNotice.tone === 'bad' && /changed elsewhere/.test(settingsNotice.text) ? [' ', el('button', { type: 'button', onclick: () => { settingsNotice = null; void loadSettings() } }, 'Load latest settings')] : []))] : []),
    el('div', { class: 'bar', style: 'margin-top:14px' },
      // State is read at click time: typing updates these controls in place, never by a rebuild
      // between mousedown and click.
      el('button', { type: 'button', class: 'pri', 'data-k': 'save', 'aria-disabled': !dirty || defaultEmpty, onclick: () => {
        const c = settingsState(); if (c && c.dirty && !c.defaultEmpty) void saveSettings()
      } }, 'Save'),
      el('button', { type: 'button', 'data-k': 'revert', 'aria-disabled': !dirty, onclick: () => {
        const c = settingsState(); if (c?.dirty && settings) { settings = { ...settings, ...JSON.parse(savedSettings) }; settingsNotice = null; render() }
      } }, 'Revert'),
      el('span', { class: 'meta', role: 'status', 'data-k': 'set-status' }, dirty ? 'Unsaved changes' : 'Saved'))))
}
const settingsState = () => settings && { dirty: editable(settings) !== savedSettings, defaultEmpty: !settings.defaultTemplate.trim() }
/** After typing in a settings field: update Save, Revert, status, the empty-default error and the
 *  unsaved preview in place, keeping the field, its caret and any IME composition intact. */
function settingsChrome() {
  const c = settingsState(); if (!c || !settings) return
  const q = (k: string) => root.querySelector<HTMLElement>(`[data-k="${k}"]`)
  q('save')?.setAttribute('aria-disabled', String(!c.dirty || c.defaultEmpty))
  q('revert')?.setAttribute('aria-disabled', String(!c.dirty))
  const st = q('set-status'); const want = c.dirty ? 'Unsaved changes' : 'Saved'
  if (st && st.textContent !== want) st.textContent = want
  q('default')?.setAttribute('aria-invalid', String(c.defaultEmpty))
  const err = q('default-err'); const msg = c.defaultEmpty ? 'The default template cannot be empty.' : ''
  if (err && err.textContent !== msg) err.textContent = msg
  const pv = q('preview')
  if (pv && (c.dirty || previewRepo === ANY_OTHER)) {
    const hit = previewRepo === ANY_OTHER ? undefined : settings.exceptions.find((e) => e.repo === previewRepo)
    pv.replaceChildren(el('div', { class: 'prev', style: 'margin-top:8px' },
      el('div', { class: 'meta' }, el('span', { class: 'chip' }, hit ? `Exception for ${hit.repo}` : 'Default'), c.dirty ? 'Preview of your unsaved changes.' : 'The saved default template.'),
      el('div', { class: 'raw' }, (hit ? hit.template : settings.defaultTemplate) || '(empty)')))
  }
}

// ---- render with focus kept ---------------------------------------------------------------------
function render() {
  pendingRender = false; pendingAnnounced = false
  // Re-rendering replaces nodes; put focus, the caret and scroll positions back on the same
  // logical elements.
  const active = document.activeElement as (HTMLElement & { selectionStart?: number | null; selectionEnd?: number | null }) | null
  const k = active && root.contains(active) ? active.getAttribute('data-k') : null
  const caret = k && typeof active!.selectionStart === 'number' ? [active!.selectionStart, active!.selectionEnd ?? active!.selectionStart] as const : null
  const scrolls = Array.from(root.querySelectorAll<HTMLElement>('[data-k]')).filter((e) => e.scrollTop || e.scrollLeft)
    .map((e) => [e.getAttribute('data-k')!, e.scrollTop, e.scrollLeft] as const)
  const page = document.scrollingElement
  const pageTop = page?.scrollTop ?? 0
  nextAlerts = new Set()
  if (ref.view === 'settings') renderSettings()
  else if (ref.view === 'review') renderReview(ref.questionId)
  else root.replaceChildren(el('main', {}, el('div', { class: 'callout', role: 'alert' }, 'This review file does not name a decision.')))
  if (k) {
    const next = root.querySelector<HTMLElement & { setSelectionRange?: (s: number, e: number) => void }>(`[data-k="${CSS.escape(k)}"]`)
    if (next && document.activeElement !== next) {
      next.focus({ preventScroll: true })
      if (caret && next.setSelectionRange) try { next.setSelectionRange(caret[0], caret[1]) } catch { /* not a text field */ }
    }
  }
  for (const [key, top, left] of scrolls) {
    const e = root.querySelector<HTMLElement>(`[data-k="${CSS.escape(key)}"]`)
    if (e) { e.scrollTop = top; e.scrollLeft = left }
  }
  if (page && page.scrollTop !== pageTop) page.scrollTop = pageTop
  shownAlerts = nextAlerts
}

/** Opens what the reference file names. A new question flushes the old draft under its own ID. */
async function bind() {
  if (ref.view === 'review') {
    if (draftFor && draftFor !== ref.questionId) { await flushDraft(); draftFor = null; draft = emptyDraft(); draftRevision = null; draftFail = null; d = null; pkg = []; notice = null }
    render()
    await loadReview(ref.questionId)
  } else if (ref.view === 'settings') {
    render()
    await loadSettings()
  } else render()
}

session?.onReplace((v) => { ref = readRef(v); void bind() })
// Empty invalidation from the worker: refetch through the authenticated requests.
// Bursts (each draft save, delivery, receipt) coalesce; the page changes only on real differences.
let invalidTimer: ReturnType<typeof setTimeout> | null = null
orca.plugin.on('inbox.changed', () => {
  if (invalidTimer) clearTimeout(invalidTimer)
  invalidTimer = setTimeout(() => {
    invalidTimer = null
    if (ref.view === 'review') void loadReview(ref.questionId, true, true)
    else if (ref.view === 'settings') void settingsInvalidated()
  }, 150)
})
// Live clock: deadlines and relative text stay current, without interrupting typing.
setInterval(() => { if (ref.view === 'review' && d) requestRender() }, 60_000)
await bind()
