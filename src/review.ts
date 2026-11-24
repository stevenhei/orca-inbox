import type { Annotation, Answer, Decision, Delivery, Evidence, RecordedReply, SubmitReply } from './contract.ts'
import type { EffectivePolicy, InboxSettings } from './backend-protocol.ts'
import { STATE_LABEL, deadlineLabel, replyState, shownState, type ShownState } from './model.ts'
import {
  call, clock, draftIsEmpty, emptyDraft, failureText, formatInstant, newReplyId, reconcile,
  type Draft, type Failure, type Requester
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
.vp{display:grid;grid-template-columns:repeat(var(--n,1),1fr);gap:10px}@media(max-width:640px){.vp{--n:1}}
.view{height:340px;overflow:auto;background:var(--soft);border:1px solid var(--line);border-radius:8px}.vp[style*="--n:2"] .view{height:260px}
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
const pop = el<HTMLButtonElement>('button', { id: 'pop', class: 'pri', type: 'button', onclick: () => addQuoteNote() }, 'Add note (Alt+N)')
const live = el('div', { class: 'sr', role: 'status', 'aria-live': 'polite' })
const composer = el<HTMLDialogElement>('dialog', { 'aria-labelledby': 'cmp-h' })
document.body.append(root, pop, live, composer)
const narrow = matchMedia('(max-width: 800px)')
narrow.addEventListener('change', () => render())
const say = (m: string) => { live.textContent = m }

// ---- review state (bound to one question ID) ----------------------------------------------------
type Notice = { tone: 'bad' | 'warn' | 'info'; text: string; retry?: boolean }
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

async function loadReview(questionId: string, keepNotice = false) {
  const mine = ++seq
  if (!keepNotice) notice = null
  const [dr, wr] = await Promise.all([
    call(req, 'getDecision', { questionId }),
    draftFor === questionId ? Promise.resolve(null) : call(req, 'draft.get', { questionId })
  ])
  if (mine !== seq) return
  if (!dr.ok) { d = null; loadFail = dr; render(); return }
  if (d?.questionId !== questionId) { snaps.clear(); a = 0; b = null; zoom.clear() }
  d = dr.value; loadFail = null
  if (wr) {
    draftFor = questionId
    if (wr.ok) { draft = wr.value ?? emptyDraft(); draftFail = null } else { draft = emptyDraft(); draftFail = wr }
  }
  const rec = reconcile(draft, d)
  if (rec.kind === 'sent') { draft = emptyDraft(); void saveDraftNow() }
  if (rec.kind === 'superseded') {
    draft = rec.draft!; void saveDraftNow()
    notice = { tone: 'warn', text: 'Another answer was recorded first, so yours was not sent. The recorded answer is shown below; your text is kept as a follow-up draft.' }
  }
  render()
  // Same-package questions from the same origin workspace, each with its own state.
  const pr = await call(req, 'listDecisions', { scope: { kind: 'workspace', workspace: { hostId: d.origin.hostId, workspaceId: d.origin.workspaceId } }, includeHistory: true })
  if (mine !== seq || !d) return
  if (pr.ok) { pkg = pr.value.filter((x) => x.packageId === d!.packageId && x.questionId !== d!.questionId); pkgFail = null }
  else { pkg = []; pkgFail = pr }
  render()
}

// ---- draft persistence (worker-backed, bound to the question ID) --------------------------------
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saving: Promise<void> = Promise.resolve()
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { saveTimer = null; void saveDraftNow() }, 400)
}
/** Saves the current draft for the question it belongs to. Saves run one at a time, in order. */
function saveDraftNow(): Promise<void> {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  const questionId = draftFor
  if (!questionId) return saving
  // A note becomes part of the stored draft once it has text (the worker refuses empty notes);
  // until then it lives only in this tab.
  const stored: Draft = { ...structuredClone(draft), annotations: structuredClone(draft.annotations.filter((n) => n.text.trim())) }
  const value: Draft | null = draftIsEmpty(stored) && !stored.replyId ? null : stored
  saving = saving.then(async () => {
    const r = await call(req, 'draft.save', { questionId, draft: value })
    if (draftFor !== questionId) return
    const before = draftFail
    draftFail = r.ok ? null : r
    if (!!before !== !!draftFail) render()
  })
  return saving
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
  if (!q) return
  if (narrow.matches) return openComposer(q.text)
  addSelection('')
  focusNote = draft.annotations.length - 1
  quote = null; render(); say('Note added in the sidebar')
}
function openComposer(quoted: string) {
  // Native modal: the browser handles inert page, focus containment, Esc and focus return.
  const ta = el<HTMLTextAreaElement>('textarea', { rows: 4, 'aria-label': 'Note', placeholder: 'Your note', autofocus: true })
  composer.replaceChildren(
    el('h3', { id: 'cmp-h', style: 'margin:0 0 6px' }, 'Add note'),
    ...(quoted ? [el('div', { class: 'raw' }, quoted)] : [el('p', { class: 'meta' }, 'Select text in Background or Recommendation first, then add a note to it.')]), ta,
    el('div', { style: 'display:flex;gap:6px;justify-content:flex-end;margin-top:8px' },
      el('button', { type: 'button', onclick: () => composer.close() }, 'Cancel'),
      el('button', { type: 'button', class: 'pri', onclick: () => {
        const text = ta.value.trim(); composer.close()
        if (text && quoted) { addSelection(text); quote = null; render(); say('Note added') }
      } }, 'Add')))
  composer.showModal()
}
/** UTF-16 offsets into the field's text. A selection may run past the paragraph; it is clipped. */
document.addEventListener('selectionchange', () => {
  const sel = getSelection()
  quote = null
  if (sel && sel.rangeCount && !sel.isCollapsed && d) {
    const r = sel.getRangeAt(0)
    for (const f of ['background', 'recommendation'] as const) {
      const p = root.querySelector(`[data-field="${f}"]`); const node = p?.firstChild
      if (!p || !node) continue
      const startIn = r.startContainer === node, endIn = r.endContainer === node
      if (!startIn && !endIn) continue
      const start = startIn ? r.startOffset : 0
      const end = endIn ? r.endOffset : d[f].length
      const text = d[f].slice(start, end)
      if (end > start && text.trim()) quote = { field: f, text, start, end }
      break
    }
  }
  if (quote) {
    const box = sel!.getRangeAt(0).getBoundingClientRect()
    pop.style.cssText = `display:block;left:${box.left}px;top:${box.bottom + 6}px`
  } else pop.style.display = 'none'
})
document.addEventListener('keydown', (e) => {
  if (composer.open) return
  if (e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); if (quote) addQuoteNote() }
  if (e.key === 'Escape') pop.style.display = 'none'
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && ref.view === 'review') { e.preventDefault(); void send() }
})

// ---- reply --------------------------------------------------------------------------------------
const answered = (x: Decision) => x.answerState.state === 'answered'
function buildAnswer(x: Decision): Answer | null {
  const text = draft.text.trim()
  if (!answered(x) && draft.optionId && x.options.some((o) => o.optionId === draft.optionId))
    return { kind: 'option', optionId: draft.optionId, ...(text ? { detail: text } : {}) }
  return text ? { kind: 'text', text } : null
}

/**
 * Sends the initial answer or a follow-up. The reply ID is minted once per attempt and saved in
 * the draft before the request, so a retry (after a timeout, a restart or `unavailable`) reuses it.
 */
async function send() {
  const x = d
  if (!x || sending) return
  const kind: SubmitReply['kind'] = answered(x) ? 'follow-up' : 'initial'
  const answer = buildAnswer(x)
  if (!answer) return say(kind === 'initial' ? 'Choose an option or write a reply first' : 'Write a follow-up first')
  if (draft.annotations.some((n) => !n.text.trim())) {
    notice = { tone: 'bad', text: 'A note is empty. Write the note or remove it, then send again.' }
    render(); return say(notice.text)
  }
  if (draft.annotations.some((n) => staleNote(n, x))) {
    notice = { tone: 'bad', text: 'Some notes no longer match the decision. Remove the notes marked out of date, then send again.' }
    render(); return say(notice.text)
  }
  if (!draft.replyId || draft.kind !== kind) { draft.replyId = newReplyId(); draft.kind = kind }
  const replyId = draft.replyId
  await saveDraftNow()
  sending = true; notice = null; render()
  const r = await call(req, 'submitReply', { questionId: x.questionId, replyId, kind, answer, annotations: draft.annotations })
  sending = false
  if (d?.questionId !== x.questionId) return
  if (r.ok && r.value.replyId === replyId) {
    draft = emptyDraft(); void saveDraftNow()
    notice = { tone: 'info', text: `${kind === 'initial' ? 'Answer' : 'Follow-up'} recorded. ${STATE_LABEL[replyState(r.value, x)]}.` }
  } else if (r.ok || r.code === 'conflict') {
    // The first accepted answer wins. Keep the owner's text as a new follow-up attempt.
    const { replyId: _id, optionId: _opt, ...rest } = draft
    draft = { ...rest, kind: 'follow-up' }; void saveDraftNow()
    notice = { tone: 'warn', text: r.ok
      ? 'Another answer was recorded first, so yours was not sent. The recorded answer and its receipt are shown below; your text is kept as a follow-up draft.'
      : `${failureText(r)} The recorded answer is shown below; your text is kept as a new draft.` }
  } else {
    notice = { tone: 'bad', retry: true, text: `Not sent. ${failureText(r)} Your draft and reply ID are kept; Retry sends the same reply.` }
  }
  say(notice.text)
  await loadReview(x.questionId, true)
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
    render()
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
      // Commit on every keystroke (no re-render), so a refresh or clock tick never loses typing.
      oninput: (ev: Event) => { setImageNote(e, (ev.target as HTMLInputElement).value); scheduleSave() },
      onchange: (ev: Event) => { setImageNote(e, (ev.target as HTMLInputElement).value); scheduleSave(); render() } }, note?.text ?? '')))
}

/** One note per image version, kept in place so the sidebar order stays stable while typing. */
function setImageNote(e: Img, raw: string) {
  const text = raw.trim()
  const i = draft.annotations.findIndex((n) => n.kind === 'image' && n.evidence.evidenceId === e.evidenceId)
  const note: Annotation = { kind: 'image', evidence: { evidenceId: e.evidenceId, version: e.version }, text }
  if (i < 0) { if (text) draft.annotations.push(note) }
  else if (text) draft.annotations[i] = note
  else draft.annotations.splice(i, 1)
}

function sidebar(x: Decision) {
  const list = draft.annotations
  const name = (n: Annotation) => n.kind === 'image'
    ? `${x.evidence.find((e) => e.evidenceId === n.evidence.evidenceId)?.label ?? n.evidence.evidenceId} · v${n.evidence.version}`
    : n.anchor.kind === 'question' ? (n.anchor.field === 'background' ? 'Background' : 'Recommendation') : 'Evidence'
  return el('div', {}, el('h2', { style: 'margin-top:0' }, `Notes (${list.length})`),
    ...(list.length ? [] : [el('p', { class: 'meta' }, 'Select text in Background or Recommendation, or write under an image. Notes go out together with your reply.')]),
    ...list.map((n, i) => {
      const stale = staleNote(n, x)
      return el('div', { class: `note${stale ? ' stale' : ''}` },
        el('b', {}, name(n)), ...(n.kind === 'selection' ? [el('q', {}, n.quote)] : []),
        ...(stale ? [el('div', { class: 'err' }, `Out of date: ${stale}`)] : []),
        field('input', { type: 'text', 'data-note': i, 'data-k': `side-note-${i}`, 'aria-label': `Note text ${i + 1}`, oninput: (ev: Event) => { n.text = (ev.target as HTMLInputElement).value; scheduleSave() }, onchange: (ev: Event) => { n.text = (ev.target as HTMLInputElement).value; scheduleSave(); render() } }, n.text),
        el('button', { type: 'button', 'aria-label': `Remove note ${i + 1}`, onclick: () => { list.splice(i, 1); scheduleSave(); render() } }, 'Remove'))
    }))
}

// ---- answered thread and follow-ups -------------------------------------------------------------
const REASON: Record<Extract<Delivery, { state: 'undelivered' }>['reason'], string> = {
  'closed-origin': 'The original chat is closed.',
  disconnected: 'The host is disconnected.',
  'origin-mismatch': 'The chat no longer matches the original origin.',
  'delivery-failed': 'Delivery failed.'
}
const when = (iso: string) => formatInstant(iso, clock.zone())
function answerText(ans: Answer, x: Decision) {
  if (ans.kind === 'text') return ans.text
  const label = x.options.find((o) => o.optionId === ans.optionId)?.label ?? ans.optionId
  return ans.detail ? `${label}\n${ans.detail}` : label
}
/** Each reply carries its own delivery state: a receipt only ever applies to its own reply ID. */
function deliveryView(r: RecordedReply, x: Decision) {
  const s = r.delivery
  const state = replyState(r, x)
  if (state === 'agent-received' && s.state === 'agent-received')
    return el('div', { class: 'meta' }, el('span', { class: 'chip' }, `● ${STATE_LABEL['agent-received']}`), `Receipt ${s.receipt.receiptId} · ${when(s.receipt.receivedAt)}`)
  if (s.state === 'undelivered')
    return el('div', { class: 'callout', role: 'alert' }, el('b', {}, `${STATE_LABEL.undelivered}. `), `${REASON[s.reason]} The reply is kept. `,
      el('button', { type: 'button', 'data-k': `retry-${r.replyId}`, onclick: () => retryDelivery(r) }, 'Retry (same reply ID, same destination)'), ' ',
      el('button', { type: 'button', 'data-k': `copy-${r.replyId}`, onclick: () => copy(answerText(r.answer, x), 'Reply') }, 'Copy reply'))
  return el('div', { class: 'meta' }, el('span', { class: 'chip' }, `● ${STATE_LABEL.submitted}`),
    s.state === 'agent-received' ? 'A receipt arrived that does not match this reply and origin, so it is not counted.' : 'Waiting for a matching receipt from the original chat.')
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

function composeArea(x: Decision): HTMLElement[] {
  const isFollow = answered(x)
  const empty = !buildAnswer(x)
  const label = isFollow ? 'Send follow-up' : 'Submit reply'
  const sendBtn = el<HTMLButtonElement>('button', { type: 'button', class: 'pri', 'data-k': 'send', 'aria-disabled': empty || sending, onclick: () => send() }, sending ? 'Sending…' : label)
  const ta = field('textarea', {
    rows: 3, 'data-k': 'reply', 'aria-label': isFollow ? 'Follow-up' : 'Reply text',
    placeholder: isFollow ? 'Follow-up to the agent (Ctrl+Enter to send)' : draft.optionId ? 'Optional detail with your option (Ctrl+Enter to submit)' : 'Free-text answer (Ctrl+Enter to submit)'
  }, draft.text)
  const onEdit = () => { draft.text = ta.value; scheduleSave(); sendBtn.setAttribute('aria-disabled', String(!buildAnswer(x) || sending)) }
  ta.addEventListener('input', onEdit); ta.addEventListener('change', onEdit)
  return [
    ...(isFollow ? [el('h2', {}, 'Add a follow-up'), el('p', { class: 'meta' }, 'Your first answer stays exactly as recorded. A follow-up is added below it and has its own receipt.')]
      : [el('h2', {}, 'Reply')]),
    el('button', { type: 'button', class: 'only-narrow', style: 'margin-bottom:6px', onclick: () => openComposer(quote?.text ?? '') }, `Notes (${draft.annotations.length})`),
    ta,
    ...(notice ? [el('div', { class: `callout ${notice.tone === 'bad' ? '' : notice.tone}`, role: notice.tone === 'bad' ? 'alert' : 'status' }, notice.text,
      ...(notice.retry ? [' ', el('button', { type: 'button', 'data-k': 'retry-send', onclick: () => send() }, `Retry (same reply ID ${draft.replyId ?? ''})`), ' ',
        el('button', { type: 'button', onclick: () => copy(draft.text, 'Reply') }, 'Copy reply')] : []))] : []),
    ...(draftFail ? [el('div', { class: 'callout warn', role: 'status' }, `Draft not saved. ${failureText(draftFail)} It is kept in this tab only.`)] : []),
    el('div', { class: 'bar' }, sendBtn, ...(draft.replyId ? [el('span', { class: 'meta' }, `Reply ID ${draft.replyId}`)] : []))
  ]
}

const STEPS: ShownState[] = ['awaiting-answer', 'submitted', 'agent-received', 'undelivered']
function renderReview(questionId: string) {
  const x = d
  if (!x) {
    root.replaceChildren(el('main', {}, loadFail
      ? el('div', { class: 'callout', role: 'alert' }, loadFail.code === 'not-found'
        ? `Decision "${questionId}" was not found. It may have been withdrawn, or you may not have access.`
        : loadFail.code === 'forbidden' ? `You do not have access to decision "${questionId}".`
        : `Could not load decision "${questionId}". ${failureText(loadFail)}`,
        ...(loadFail.code === 'unavailable' ? [' ', el('button', { type: 'button', onclick: () => loadReview(questionId) }, 'Try again')] : []))
      : el('p', { class: 'meta', role: 'status' }, 'Loading decision…')))
    return
  }
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
    ...(due?.overdue ? [el('div', { class: 'callout', role: 'alert' }, `${due.text}.`)] : []),
    ...(pkg.length || pkgFail ? [el('h2', {}, 'Same package · shared background and evidence'),
      pkgFail ? el('p', { class: 'meta' }, `Could not load the other questions in this package. ${failureText(pkgFail)}`)
        : el('div', { class: 'pkg' }, ...pkg.map((s) => el('span', { class: 'chip' }, `${s.title} · ${STATE_LABEL[shownState(s)]} `,
          el('button', { type: 'button', 'data-k': `open-${s.questionId}`, 'aria-label': `Open ${s.title}`, onclick: () => openOther(s.questionId) }, 'Open'))))] : []),
    el('h2', {}, 'Background'), el('p', { 'data-field': 'background', style: 'margin:0;user-select:text' }, x.background),
    el('h2', {}, 'Recommendation'), el('p', { 'data-field': 'recommendation', style: 'margin:0;user-select:text' }, x.recommendation),
    ...(answered(x) ? [] : [el('h2', {}, 'Options'),
      ...(x.options.length
        ? [el('div', { role: 'radiogroup', 'aria-label': 'Options' }, ...x.options.map((o) =>
            el('label', { class: 'opt' }, el<HTMLInputElement>('input', { type: 'radio', name: 'opt', 'data-k': `opt-${o.optionId}`, checked: draft.optionId === o.optionId, onchange: () => { draft.optionId = o.optionId; scheduleSave(); render() } }),
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
      el('div', { class: 'vp', style: `--n:${pair ? 2 : 1}` }, viewer(imgs, a, pair ? 'Left' : 'Main'), ...(pair ? [viewer(imgs, b!, 'Right')] : []))] : []),
    ...(links.length ? [el('h2', {}, 'Linked evidence'), el('p', { style: 'margin:0' }, ...links.map((l) => l.kind === 'link'
      ? el('a', { href: l.url, onclick: (ev: Event) => { ev.preventDefault(); void openLink(l.url) } }, `${l.label} · v${l.version} ↗  `) : ''))] : []),
    ...(answered(x) ? [el('h2', {}, 'Recorded answer and follow-ups'), ...thread(x)] : []),
    ...composeArea(x),
    el('ol', { class: 'strip', 'aria-label': 'Delivery state of the answer' }, ...STEPS.map((s) =>
      el('li', { class: `step ${s === 'undelivered' ? 'bad' : ''}`, 'aria-current': s === state ? 'step' : false }, `${s === state ? '● ' : '○ '}${STATE_LABEL[s]}`))),
    el('h2', {}, 'Source links'),
    el('p', { style: 'margin:0' }, ...x.sourceLinks.map((l) => el('a', { href: l.url, onclick: (ev: Event) => { ev.preventDefault(); void openLink(l.url) } }, `${l.label} ↗  `)),
      el('button', { type: 'button', onclick: () => copy(x.decisionLink, 'Decision link') }, 'Copy decision link')))
  root.replaceChildren(main, el('aside', { class: 'side', 'aria-label': 'Notes' }, sidebar(x)))
  if (focusNote !== null) { root.querySelector<HTMLInputElement>(`[data-note="${focusNote}"]`)?.focus(); focusNote = null }
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

async function loadSettings() {
  const [s, rp] = await Promise.all([call(req, 'settings.get'), call(req, 'settings.repos')])
  if (s.ok) { settings = s.value; savedSettings = editable(s.value); settingsFail = null; stale = false } else { settings = null; settingsFail = s }
  if (rp.ok) { repos = rp.value; reposFail = null } else { repos = []; reposFail = rp }
  if (previewRepo !== ANY_OTHER && !repos.includes(previewRepo)) previewRepo = ANY_OTHER
  if (previewRepo === ANY_OTHER && repos.length) previewRepo = repos[0]
  effective = null
  render()
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
      ? el('div', { class: 'callout', role: 'alert' }, `Could not load Inbox settings. ${failureText(settingsFail)} `, el('button', { type: 'button', onclick: () => loadSettings() }, 'Try again'))
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
    preview = el('div', { class: 'callout', role: 'alert' }, `Could not load the effective rules. ${failureText(effective.r)}`)
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
    field('textarea', { rows: 7, 'data-k': 'default', 'aria-label': 'Default question template', 'aria-invalid': defaultEmpty, 'aria-describedby': defaultEmpty ? 'default-err' : false,
      oninput: (ev: Event) => { s.defaultTemplate = (ev.target as HTMLTextAreaElement).value },
      onchange: (ev: Event) => { s.defaultTemplate = (ev.target as HTMLTextAreaElement).value; settingsNotice = null; render() } }, s.defaultTemplate),
    ...(defaultEmpty ? [el('div', { class: 'err', id: 'default-err', role: 'alert' }, 'The default template cannot be empty.')] : []),
    el('h2', {}, `Repo exceptions (${s.exceptions.length})`),
    ...(reposFail ? [el('div', { class: 'callout warn', role: 'status' }, `Could not load the repo list. ${failureText(reposFail)}`)] : []),
    ...(s.exceptions.length ? [] : [el('p', { class: 'meta' }, 'No exceptions. Every repo uses the default template.')]),
    ...s.exceptions.map((e, i) => el('div', { class: 'row2' },
      select(`Repo for exception ${i + 1}`, `ex-repo-${i}`, e.repo, [e.repo, ...free], (v) => { e.repo = v; render() }),
      field('textarea', { rows: 3, 'data-k': `ex-tpl-${i}`, 'aria-label': `Template for ${e.repo}`, oninput: (ev: Event) => { e.template = (ev.target as HTMLTextAreaElement).value }, onchange: (ev: Event) => { e.template = (ev.target as HTMLTextAreaElement).value; render() } }, e.template),
      el('button', { type: 'button', 'aria-label': `Remove exception for ${e.repo}`, onclick: () => { s.exceptions.splice(i, 1); render() } }, 'Remove'))),
    el('button', { type: 'button', 'data-k': 'add-ex', 'aria-disabled': free.length === 0, onclick: () => { if (free.length) { s.exceptions.push({ repo: free[0], template: s.defaultTemplate }); render() } } },
      free.length ? 'Add exception' : repos.length ? 'Every repo already has an exception' : 'No repos to add'),
    el('h2', {}, 'Effective rules preview'),
    select('Preview repo', 'preview-repo', previewRepo, [...repos, ANY_OTHER], (v) => { previewRepo = v; render() }),
    preview,
    el('div', { class: 'meta' }, previewRepo === ANY_OTHER ? 'Also read: that repo’s AGENTS.md and the selected role file.' : `Also read: ${previewRepo}/AGENTS.md and the selected role file.`),
    ...(settingsNotice ? [el('div', { class: `callout ${settingsNotice.tone === 'bad' ? '' : settingsNotice.tone}`, role: settingsNotice.tone === 'bad' ? 'alert' : 'status' }, settingsNotice.text,
      ...(settingsNotice.tone === 'bad' && /changed elsewhere/.test(settingsNotice.text) ? [' ', el('button', { type: 'button', onclick: () => { settingsNotice = null; void loadSettings() } }, 'Load latest settings')] : []))] : []),
    el('div', { class: 'bar', style: 'margin-top:14px' },
      el('button', { type: 'button', class: 'pri', 'data-k': 'save', 'aria-disabled': !dirty || defaultEmpty, onclick: () => { if (dirty && !defaultEmpty) void saveSettings() } }, 'Save'),
      el('button', { type: 'button', 'data-k': 'revert', 'aria-disabled': !dirty, onclick: () => { if (dirty) { settings = { ...s, ...JSON.parse(savedSettings) }; settingsNotice = null; render() } } }, 'Revert'),
      el('span', { class: 'meta', role: 'status' }, dirty ? 'Unsaved changes' : 'Saved'))))
}

// ---- render with focus kept ---------------------------------------------------------------------
function render() {
  // Re-rendering replaces nodes; put focus and the caret back on the same logical control.
  const active = document.activeElement as (HTMLElement & { selectionStart?: number | null; selectionEnd?: number | null }) | null
  const k = active && root.contains(active) ? active.getAttribute('data-k') : null
  const caret = k && typeof active!.selectionStart === 'number' ? [active!.selectionStart, active!.selectionEnd ?? active!.selectionStart] as const : null
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
}

/** Opens what the reference file names. A new question flushes the old draft under its own ID. */
async function bind() {
  if (ref.view === 'review') {
    if (draftFor && draftFor !== ref.questionId) { await flushDraft(); draftFor = null; draft = emptyDraft(); draftFail = null; d = null; pkg = []; notice = null }
    render()
    await loadReview(ref.questionId)
  } else if (ref.view === 'settings') {
    render()
    await loadSettings()
  } else render()
}

session?.onReplace((v) => { ref = readRef(v); void bind() })
// Empty invalidation from the worker: refetch through the authenticated requests.
orca.plugin.on('inbox.changed', () => {
  if (ref.view === 'review') void loadReview(ref.questionId, true)
  else if (ref.view === 'settings') {
    if (settings && editable(settings) !== savedSettings) { stale = true; render() } else void loadSettings()
  }
})
// Live clock: deadlines and relative text stay current; focus survives the re-render.
setInterval(() => { if (ref.view === 'review' && d) render() }, 60_000)
await bind()
