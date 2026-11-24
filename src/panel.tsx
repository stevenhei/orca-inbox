import {
  atom, read, set, on, plugin,
  Badge, Box, Button, Callout, Card, Checkbox, Collapsible, EmptyState, Heading, IconButton, Input, KeyValue, Link, List,
  ListItem, Markdown, RadioGroup, Row, Select, Skeleton, Stack, Tab, Tabs, Text, Textarea
} from 'orca'
import type { PanelContext } from 'orca'
import type { Answer, Decision, Delivery, RecordedReply, SubmitReply, Workspace } from './contract.ts'
import type { InboxSettings } from './backend-protocol.ts'
import { autolinkForMarkdown } from './markdown-inline.ts'
import { NOTE_FIELD_LABEL, makeNote, noteLabel, notesFate, noteTargets, occurrences } from './note-anchors.ts'
import { STATE_LABEL, actionsOf, deadlineLabel, replyState, isActionable, isPractice, nativeNeedsYou, nativeOf, nativeStatusLabel, order, sameWorkspace, shownState, siblings, undeliveredReplies } from './model.ts'
import { replyReach, sourceStatus } from './source-status.ts'
import { call, clock, draftIsEmpty, emptyDraft, failureText, formatInstant, newReplyId, reconcile, replies, sourcesOf, transportOf, type Draft, type Failure, type Requester, type SourceStatus } from './client.ts'
import type { DecisionPage, WorkspaceOptions } from './backend-protocol.ts'
import { ALL_VALUE, ScopeTracker, emptyScopeState, intendedScope, lostWorkspace, queueInput, scopeOf, scopeValue, workspaceChoices, workspaceLabel, type Scope, type ScopeState } from './workspace-scope.ts'
type MailStatus = NonNullable<DecisionPage['mail']>

// Narrow right-sidebar panel, declarative Orca components only. Data comes from the plugin
// worker (`listDecisionPage`); there is no fixture fallback. Rules:
//  * One Workspace choice (workspace-scope.ts): All workspaces or one authorized workspace from
//    `workspace.options`. It follows the focused workspace until the owner chooses; an explicit
//    choice is never reset by focus changes. When focus is ambiguous or the chosen workspace is
//    gone, the panel asks instead of widening the scope.
//  * Scope identity is host + workspace. The focused workspace's host is resolved by the worker
//    (`workspace.resolve`); the panel never guesses a host.
//  * Only actionable rows (Awaiting answer, or any reply Undelivered) unless Include history is on.
//  * Pages are bounded and searched by the worker in the reviewing desktop zone; the panel never
//    re-applies search to the minimal projected rows.
//  * An open decision is bound to its question ID, not to whatever the scope shows next.

const req: Requester = (name, input, options) => (plugin.request as Requester)(name, input, options)

/**
 * The Workspace choice, focused workspace, authorized inventory and any refusal: one state, changed
 * only by the shared tracker (workspace-scope.ts), which the dashboard uses too.
 */
const ws = atom<ScopeState>(emptyScopeState())
const tracker = new ScopeTracker({ get: () => read(ws), set: (v) => set(ws, v) }, {
  options: () => call(req, 'workspace.options') as Promise<{ ok: true; value: WorkspaceOptions } | Failure>,
  resolve: (workspaceId) => call(req, 'workspace.resolve', { workspaceId }) as Promise<{ ok: true; value: Workspace } | Failure>
})
const term = atom('')
const history = atom(false)
/** The decision whose review tab the worker last opened, by question ID. Set only on success. */
const openId = atom<string | null>(null)
/** Loaded pages for one query key, so a failed refresh still shows (and labels) the last list. */
const rows = atom<{ key: string; list: Decision[]; nextCursor?: string; sources: SourceStatus[]; mail?: MailStatus } | null>(null)
const loading = atom<false | 'first' | 'more'>(false)
/** The last load failure, for the query key it happened in. */
const loadError = atom<{ key: string; f: Failure } | null>(null)
/** Live clock, ticking each minute so relative deadlines and "due today" stay current. */
const now = atom(clock.now())

let seq = 0
let searchTimer: ReturnType<typeof setTimeout> | null = null
/** The scope listed now, or null when the owner must choose. */
const scopeNow = () => scopeOf(read(ws))
const queryKey = (sc: Scope | null, t: string, h: boolean) => `${sc ? scopeValue(sc) : 'none'}|${h ? 'h' : '-'}|${t.trim()}`
const pageInput = (sc: Scope, t: string, h: boolean, cursor?: string) => queueInput(sc, { query: t, includeHistory: h, timeZone: clock.zone(), cursor })

/** Loads the first page of the current query, or the next page with `more`. */
async function load(more = false) {
  const sc = scopeNow(), t = read(term).trim(), h = read(history)
  const key = queryKey(sc, t, h)
  if (!sc) { ++seq; set(loading, false); return }
  const prev = read(rows)
  const cursor = more && prev?.key === key ? prev.nextCursor : undefined
  if (more && !cursor) return
  const mine = ++seq
  // A refresh this load supersedes is re-run once this load lands, so no invalidation is lost.
  const supersededRefresh = refreshing
  refreshing = false
  set(loading, more ? 'more' : 'first')
  const r = await call(req, 'listDecisionPage', pageInput(sc, t, h, cursor))
  if (mine !== seq) return // a newer query, scope or refresh won; it owns the loading state
  set(loading, false)
  // The worker refused this workspace and the inventory confirms it is gone: ask, never widen.
  if (!r.ok && await tracker.refused(sc, r)) { if (mine === seq) void load(); return }
  if (mine !== seq) return
  // The scope changed while this page was in flight (focus, inventory): it is not this view's list.
  if (queryKey(scopeNow(), read(term).trim(), read(history)) !== key) return
  if (supersededRefresh && r.ok) invalidated()
  if (r.ok) {
    const seen = new Set(cursor ? prev!.list.map((d) => d.questionId) : [])
    const list = cursor ? [...prev!.list, ...r.value.rows.filter((d) => !seen.has(d.questionId))] : r.value.rows
    // The latest page's per-source report describes the whole list.
    set(rows, { key, list, ...(r.value.nextCursor ? { nextCursor: r.value.nextCursor } : {}), sources: sourcesOf(r.value), ...(r.value.mail ? { mail: r.value.mail } : {}) })
    set(loadError, null)
  } else set(loadError, { key, f: r })
}

/** At most this many pages are re-read to keep what "Load more" already showed. */
const MAX_REFRESH_PAGES = 20
/**
 * Re-reads the current query after an invalidation, keeping as many rows as were loaded (so
 * "Load more" results stay) and changing nothing when the worker's answer is the same.
 */
let refreshing = false
async function refresh() {
  const sc = scopeNow(), t = read(term).trim(), h = read(history)
  const key = queryKey(sc, t, h)
  const prev = read(rows)
  if (!sc) return
  if (!prev || prev.key !== key) return load()
  // This refresh supersedes any in-flight load. If that was "Load more", read its page too, so
  // the owner's request is not dropped.
  const wantExtra = read(loading) === 'more'
  const mine = ++seq
  refreshing = true
  const list: Decision[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  let pages = 0
  let sources: SourceStatus[] = []
  let mail: MailStatus | undefined
  do {
    const r = await call(req, 'listDecisionPage', pageInput(sc, t, h, cursor))
    if (mine !== seq) return
    if (!r.ok) {
      refreshing = false; set(loading, false)
      if (await tracker.refused(sc, r)) { if (mine === seq) void load() } else if (mine === seq) set(loadError, { key, f: r })
      return
    }
    if (queryKey(scopeNow(), read(term).trim(), read(history)) !== key) { refreshing = false; set(loading, false); return }
    const before = list.length
    for (const d of r.value.rows) if (!seen.has(d.questionId)) { seen.add(d.questionId); list.push(d) }
    if (pages === 0) { sources = sourcesOf(r.value); mail = r.value.mail } // the first page reports availability
    cursor = r.value.nextCursor
    if (before >= prev.list.length) break // this was the extra page a pending "Load more" asked for
  } while (cursor && (list.length < prev.list.length || wantExtra) && ++pages < MAX_REFRESH_PAGES)
  refreshing = false
  set(loading, false)
  const next = { key, list, ...(cursor ? { nextCursor: cursor } : {}), sources, ...(mail ? { mail } : {}) }
  if (JSON.stringify(next) !== JSON.stringify(prev)) set(rows, next)
  if (read(loadError)) set(loadError, null)
}
let refreshTimer: ReturnType<typeof setTimeout> | null = null
/** Bursts of invalidations (each draft save, delivery, receipt) coalesce into one refresh. */
function invalidated() {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => { refreshTimer = null; void refresh() }, 150)
}

/**
 * Focus, lifecycle and refusals go through the shared tracker; a new first page is read whenever the
 * scope in effect changes, or when the loaded rows belong to another query. A later focus change
 * always wins, even when an earlier resolve answers last.
 */
const reloadIfStale = (changed: boolean) => {
  if (changed || read(rows)?.key !== queryKey(scopeNow(), read(term), read(history))) void load()
}
async function focus(context: { workspaceId?: string } | null) { reloadIfStale(await tracker.focusChanged(context)) }
/** Orca created or removed a workspace, the panel came back, or the owner retried: re-read the list. */
async function refreshWorkspaces() { reloadIfStale(await tracker.refreshInventory()) }
/** An explicit Workspace choice: kept across focus changes; a new first-page query. */
function chooseScope(v: string) {
  if (tracker.choose(v)) void load()
}

function search(v: string) {
  set(term, v)
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { searchTimer = null; void load() }, 250)
}

function toggleHistory(v: boolean) {
  set(history, v)
  void load()
}

// ---- Practice Inbox in the panel ------------------------------------------------------------------
// The worker's synthetic Practice Inbox: the same rows, reader and reply card, read through
// `practice.listDecisionPage` with no workspace scope. While it is shown nothing live is read: focus,
// workspace and inbox events are kept and applied when the owner goes back to the Inbox.
const mode = atom<'inbox' | 'practice'>('inbox')
const pList = atom<{ list: Decision[]; nextCursor?: string } | null>(null)
const pLoading = atom<false | 'first' | 'more'>(false)
const pFail = atom<Failure | null>(null)
let pSeq = 0
let deferred: { focus?: { context: { workspaceId?: string } | null }; inventory?: boolean; inbox?: boolean } = {}
const inPractice = () => read(mode) === 'practice'
async function loadPractice(more = false) {
  const prev = read(pList)
  const cursor = more ? prev?.nextCursor : undefined
  if (more && !cursor) return
  const mine = ++pSeq
  set(pLoading, more ? 'more' : 'first')
  const r = await call(req, 'practice.listDecisionPage', { includeHistory: true, timeZone: clock.zone(), ...(cursor ? { cursor } : {}) })
  if (mine !== pSeq) return
  set(pLoading, false)
  if (!r.ok) { set(pFail, r); return }
  const seen = new Set(cursor ? prev!.list.map((d) => d.questionId) : [])
  const list = cursor ? [...prev!.list, ...r.value.rows.filter((d) => !seen.has(d.questionId))] : r.value.rows
  const next = { list, ...(r.value.nextCursor ? { nextCursor: r.value.nextCursor } : {}) }
  if (JSON.stringify(next) !== JSON.stringify(prev)) set(pList, next)
  set(pFail, null)
}
/** Inbox ⇄ Practice: the open decision's draft is saved first and the panel returns to the list. */
function setMode(m: string) {
  const next = m === 'practice' ? 'practice' : 'inbox'
  if (read(mode) === next) return
  void flushDraft()
  nav++
  set(view, { kind: 'list' }); set(wide, null); set(mode, next)
  if (next === 'practice') { void loadPractice(); return }
  // Back in the Inbox: apply what Practice deferred.
  const { focus: f, inventory, inbox } = deferred
  deferred = {}
  if (f) void focus(f.context)
  else if (inventory) void refreshWorkspaces()
  else if (inbox) invalidated()
}

// ---- in-panel navigation ------------------------------------------------------------------------
// A row or the gear opens its view inside the panel at once, read through the authorized worker
// requests (getDecision, drafts, submitReply, settings.*). The wide editor tab is optional: if
// Orca cannot open it, that failure is reported as a wide-tab problem only. Every async answer is
// tagged with the navigation it belongs to, so a stale answer can never land on another view.
type View = { kind: 'list' } | { kind: 'decision'; questionId: string; title: string } | { kind: 'settings' }
type Loadable<T> = { state: 'loading' } | { state: 'ok'; value: T } | { state: 'fail'; f: Failure }
type Notice = { tone: 'neutral' | 'warning' | 'danger'; text: string; retry?: boolean; reload?: boolean }
const view = atom<View>({ kind: 'list' })
let nav = 0
const detail = atom<Loadable<Decision>>({ state: 'loading' })
/** The wide tab for the current view only: opening, opened, or why Orca did not open it. */
const wide = atom<{ nav: number; state: 'opening' | 'opened' | 'failed'; text?: string } | null>(null)

/**
 * The questions of the open decision's package, for "Question i / N" paging. A bounded,
 * server-searched page by package ID; `more` means the total is not known.
 */
const pkgRows = atom<{ packageId: string; rows: Decision[]; more: boolean } | null>(null)

/**
 * Whether the open decision was opened from Practice. It is bound when the decision opens (never
 * inferred from its ID, since a live question ID may begin with `practice:`) and every detail, draft,
 * snapshot and reply request for it carries `mode: "practice"`; live requests carry no mode.
 */
let detailPractice = false
const md = <T extends object>(input: T, practice = detailPractice): T => (practice ? { ...input, mode: 'practice' } : input) as T
/** Draft revisions are per mode and question, so equal IDs in Practice and the Inbox never mix. */
const rk = (questionId: string, practice = detailPractice) => `${practice ? 'practice' : 'live'}|${questionId}`
function openDecision(d: Decision) {
  void flushDraft()
  detailPractice = inPractice()
  const mine = ++nav
  set(view, { kind: 'decision', questionId: d.questionId, title: d.title })
  set(openId, d.questionId)
  set(detail, { state: 'loading' }); set(wide, null); resetCompose(d.questionId)
  if (read(pkgRows)?.packageId !== d.packageId) set(pkgRows, null)
  void loadDetail(mine, d.questionId)
  void loadPackage(mine, d)
}
async function loadPackage(mine: number, d: Decision) {
  const native = nativeOf(d)
  // Practice siblings come from the Practice Inbox only (none to read when their IDs are declared).
  if (isPractice(d) && d.package?.questionIds?.length) return
  const r = isPractice(d)
    ? await call(req, 'practice.listDecisionPage', { query: d.packageId, includeHistory: true, timeZone: clock.zone() })
    : await call(req, 'listDecisionPage', {
      scope: native && !native.workspaceAttributed ? { kind: 'all' } : { kind: 'workspace', workspace: { hostId: d.origin.hostId, workspaceId: d.origin.workspaceId } },
      query: d.packageId, includeHistory: true, timeZone: clock.zone()
    })
  if (mine !== nav || !r.ok) return
  const rows = r.value.rows.filter((x) => x.packageId === d.packageId)
  set(pkgRows, { packageId: d.packageId, rows: rows.some((x) => x.questionId === d.questionId) ? rows : [...rows, d], more: !!r.value.nextCursor })
}
/** Position of the open question in its package; `total` is null when unknown. */
function packagePosition(d: Decision): { index: number; total: number | null; known: number; prev?: Decision; next?: Decision } {
  const declared = d.package
  const loaded = read(pkgRows)
  const rows = loaded?.packageId === d.packageId ? [...loaded.rows].sort(packageOrder) : [d]
  // Native asks declare their sibling IDs, so paging works even when sibling rows were not loaded.
  if (declared?.questionIds?.length) {
    const ids = declared.questionIds
    const at = Math.max(0, ids.indexOf(d.questionId))
    const byId = (id?: string) => id === undefined ? undefined : rows.find((x) => x.questionId === id) ?? { ...d, questionId: id, title: `Question ${ids.indexOf(id) + 1}` }
    return { index: declared.index ?? at, total: ids.length, known: ids.length, prev: byId(ids[at - 1]), next: byId(ids[at + 1]) }
  }
  const at = Math.max(0, rows.findIndex((x) => x.questionId === d.questionId))
  const index = declared?.index ?? at
  const total = declared ? declared.size : loaded?.more ? null : rows.length
  return { index, total, known: rows.length, prev: rows[at - 1], next: rows[at + 1] }
}
const packageOrder = (a: Decision, b: Decision) => {
  const ia = (a as RichDecision).package?.index, ib = (b as RichDecision).package?.index
  if (ia !== undefined && ib !== undefined) return ia - ib
  const na = Number(a.questionId.split(':').at(-1)), nb = Number(b.questionId.split(':').at(-1))
  if (nativeOf(a) && Number.isInteger(na) && Number.isInteger(nb)) return na - nb
  return Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.questionId.localeCompare(b.questionId)
}
/** Optional reader fields agreed with the BE worker (absent on older workers). */
type RichDecision = Decision & {
  context?: string
  activity?: { label: string; at?: string; text: string }[]
  package?: { index: number; size: number | null }
  nativeLinks?: { kind: string; ref: string; label: string; url?: string }[]
}
async function loadDetail(mine: number, questionId: string, passive = false) {
  const r = await call(req, 'getDecision', md({ questionId }))
  if (mine !== nav) return // the owner moved on: never overwrite another view
  if (!r.ok && passive && read(detail).state === 'ok') return // a failed refresh keeps the shown detail
  set(detail, r.ok ? { state: 'ok', value: r.value } : { state: 'fail', f: r })
  if (r.ok && !nativeOf(r.value)) await loadDraft(mine, r.value)
}
function back() {
  void flushDraft()
  nav++
  set(view, { kind: 'list' }); set(wide, null)
}
async function openWide() {
  const v = read(view); const mine = nav
  if (v.kind === 'list') return
  set(wide, { nav: mine, state: 'opening' })
  const r = v.kind === 'settings' ? await call(req, 'settings.open') : await call(req, 'review.open', md({ questionId: v.questionId }))
  if (mine !== nav) return
  set(wide, r.ok ? { nav: mine, state: 'opened' } : { nav: mine, state: 'failed', text: failureText(r) })
}

// ---- Chat decision reply in the panel (same semantics as the wide review) -----------------------
const cDraft = atom<Draft>(emptyDraft())
const cMeta = atom<{ questionId: string | null; revision: number | null; loaded: boolean }>({ questionId: null, revision: null, loaded: false })
const cFail = atom<Failure | null>(null)
const cNotice = atom<Notice | null>(null)
const cSending = atom(false)
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saving: Promise<unknown> = Promise.resolve()

function resetCompose(questionId: string) {
  set(cDraft, emptyDraft()); set(cMeta, { questionId, revision: null, loaded: false })
  set(cFail, null); set(cNotice, null); set(cSending, false); set(pNote, null); set(pNoteSaved, false); set(pNotesList, false)
}

// ---- notes in the panel (no text selection here: pick a paragraph or image, optionally a phrase) --
/** The open note composer in the panel, for one question; null when closed. */
type PanelNote = { questionId: string; target: string; phrase: string; occurrence: number; text: string; error?: string; saving?: boolean }
const pNote = atom<PanelNote | null>(null)
const pNoteSaved = atom(false)
/** The saved-notes list is collapsed behind Notes (n) unless the owner opens it. */
const pNotesList = atom(false)
function editNote(patch: Partial<PanelNote>) {
  const cur = read(pNote); if (cur) set(pNote, { ...cur, error: undefined, ...patch })
}
/**
 * Adds the note to this question's draft and saves it (compare-and-set) right away. On success the
 * composer closes and a quiet line says it is saved, not sent; on failure the composer stays open
 * with the text and the note is not kept.
 */
async function addPanelNote(d: Decision) {
  const c = read(pNote); if (!c || c.saving || c.questionId !== d.questionId) return
  const t = noteTargets(d).find((x) => x.value === c.target)
  if (!t) return editNote({ error: 'Choose what the note is about.' })
  const n = makeNote(d, t, c.text, c.phrase, c.occurrence)
  if (typeof n === 'string') return editNote({ error: n })
  editNote({ saving: true })
  editDraft({ annotations: [...read(cDraft).annotations, n] })
  const ok = await saveDraftNow()
  if (read(cMeta).questionId !== d.questionId) return
  if (ok) { set(pNote, null); set(pNoteSaved, true); set(pNotesList, false); return }
  set(cDraft, { ...read(cDraft), annotations: read(cDraft).annotations.filter((a) => a !== n) })
  editNote({ saving: false, error: `The note was not saved. ${read(cFail) ? failureText(read(cFail)!) : 'Try again.'}` })
}
async function loadDraft(mine: number, d: Decision) {
  if (read(cMeta).loaded && read(cMeta).questionId === d.questionId) return reconcileDraft(d)
  const r = await call(req, 'draft.get', md({ questionId: d.questionId }))
  if (mine !== nav) return
  if (r.ok) {
    knownRevision.set(rk(d.questionId), r.value.revision)
    set(cDraft, r.value.draft ?? emptyDraft()); set(cMeta, { questionId: d.questionId, revision: r.value.revision, loaded: true }); set(cFail, null)
  }
  else { set(cMeta, { questionId: d.questionId, revision: null, loaded: true }); set(cFail, r) }
  reconcileDraft(d)
}
/** By reply ID: a recorded attempt clears the draft; a lost initial answer is kept, never converted. */
function reconcileDraft(d: Decision) {
  const draft = read(cDraft)
  const attempted = draft.replyId
  const rec = reconcile(draft, d)
  if (rec.kind === 'sent') {
    const r = replies(d).find((x) => x.replyId === attempted)!
    set(cDraft, emptyDraft()); void saveDraftNow()
    set(cNotice, { tone: 'neutral', text: `Your ${r.kind === 'initial' ? 'answer' : 'follow-up'} was recorded (reply ID ${r.replyId}). ${deliveryText(r, d)}` })
  } else if (rec.kind === 'superseded' && !read(cNotice)) {
    set(cNotice, { tone: 'warning', text: 'Another answer was recorded first, so yours was not sent. Your unsent answer is kept; nothing else is sent unless you choose to.' })
  }
}
function editDraft(patch: Partial<Draft>) {
  const d = read(detail)
  // Fields set to undefined are removed: worker requests carry JSON only, and an undefined field
  // makes the host refuse the save.
  const cur = Object.fromEntries(Object.entries({ ...read(cDraft), ...patch }).filter(([, v]) => v !== undefined)) as unknown as Draft
  if (!cur.kind && d.state === 'ok') cur.kind = d.value.answerState.state === 'answered' ? 'follow-up' : 'initial'
  set(cDraft, cur)
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { saveTimer = null; void saveDraftNow() }, 400)
}
/**
 * The draft revision this panel last read or wrote, per question: the revision the owner's edits are
 * based on. A queued save always writes against it (compare-and-set) and never re-reads the latest
 * revision, so a save that runs after navigation cannot overwrite a newer draft from the wide tab.
 */
const knownRevision = new Map<string, number>()
/** Panel edits that could not be saved because the draft changed elsewhere, kept for recovery. */
const recovered = atom<Record<string, Draft>>({})
function keepRecoverable(questionId: string, draft: Draft | null) {
  if (!draft || draftIsEmpty(draft)) return
  set(recovered, { ...read(recovered), [questionId]: draft })
}
function dropRecoverable(questionId: string) {
  if (!(questionId in read(recovered))) return
  const { [questionId]: _gone, ...rest } = read(recovered); set(recovered, rest)
}

/** Compare-and-set save for the draft's own question; resolves true only when durable. */
function saveDraftNow(): Promise<boolean> {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  const meta = read(cMeta)
  const questionId = meta.questionId
  if (!questionId || !meta.loaded) return saving.then(() => false)
  const draft = read(cDraft)
  const value: Draft | null = draftIsEmpty(draft) && !draft.replyId ? null : draft
  const practice = detailPractice // bound now: a queued save keeps the mode of the decision it belongs to
  const key = rk(questionId, practice)
  const p = saving.then(async (): Promise<boolean> => {
    // Our own earlier save of this question may have advanced the revision; that is still the
    // lineage the owner saw. No known revision means the draft could not be read: do not write.
    const revision = knownRevision.get(key)
    if (revision === undefined) {
      keepRecoverable(questionId, value)
      if (read(cMeta).questionId === questionId) set(cFail, { ok: false, code: 'unavailable', message: 'The stored draft could not be read, so this edit was not saved.' })
      return false
    }
    const r = await call(req, 'draft.save', md({ questionId, draft: value, revision }, practice))
    const here = read(cMeta).questionId === questionId
    if (r.ok) {
      knownRevision.set(key, r.value.revision)
      if (here) { set(cMeta, { ...read(cMeta), revision: r.value.revision }); set(cFail, null) }
      return true
    }
    if (r.code === 'conflict') {
      // The newer draft stays as it is; this edit is kept so the owner can choose to use it.
      keepRecoverable(questionId, value)
      if (here) {
        const g = await call(req, 'draft.get', md({ questionId }, practice))
        if (g.ok && read(cMeta).questionId === questionId) {
          knownRevision.set(key, g.value.revision)
          set(cDraft, g.value.draft ?? emptyDraft()); set(cMeta, { ...read(cMeta), revision: g.value.revision })
        }
      } else knownRevision.delete(key) // re-read when the question is opened again
      return false
    }
    keepRecoverable(questionId, value)
    if (here) set(cFail, r)
    return false
  })
  saving = p.catch(() => false)
  return p
}
const flushDraft = () => (saveTimer ? saveDraftNow() : saving)

function heldInitial(d: Decision, draft: Draft) {
  return d.answerState.state === 'answered' && (draft.kind ?? 'initial') === 'initial' && !draftIsEmpty(draft)
}
function buildAnswer(d: Decision, draft: Draft): Answer | null {
  const text = draft.text.trim()
  if (d.answerState.state !== 'answered' && draft.optionId && d.options.some((o) => o.optionId === draft.optionId))
    return { kind: 'option', optionId: draft.optionId, ...(text ? { detail: text } : {}) }
  return text ? { kind: 'text', text } : null
}
/** Sends against the decision as shown, with a reply ID saved durably first. */
async function send() {
  const shown = read(detail); const mine = nav
  if (shown.state !== 'ok' || read(cSending)) return
  const d = shown.value
  const draft = read(cDraft)
  const kind: SubmitReply['kind'] = d.answerState.state === 'answered' ? 'follow-up' : 'initial'
  if (!actionsOf(d).includes(kind === 'initial' ? 'reply' : 'follow-up')) return
  if (heldInitial(d, draft)) return
  const answer = buildAnswer(d, draft)
  if (!answer) { set(cNotice, { tone: 'warning', text: kind === 'initial' ? 'Choose an option or write a reply first.' : 'Write a follow-up first.' }); return }
  if (draft.annotations.some((n) => !n.text.trim())) {
    set(cNotice, { tone: 'danger', text: 'A note from the wide review is empty. Open the wide review to fix or remove it, then send again.' }); return
  }
  set(cSending, true); set(cNotice, null)
  const replyId = draft.replyId && draft.kind === kind ? draft.replyId : newReplyId()
  set(cDraft, { ...draft, replyId, kind })
  const annotations = draft.annotations.map((n) => ({ ...n, text: n.text.trim() }))
  if (!(await saveDraftNow())) {
    set(cSending, false)
    if (mine === nav && !read(cNotice)) set(cNotice, { tone: 'danger', retry: true, text: 'Not sent. This reply attempt could not be saved first, so a later retry could not reuse its reply ID.' })
    return
  }
  const r = await call(req, 'submitReply', md({ questionId: d.questionId, replyId, kind, answer, annotations }))
  set(cSending, false)
  if (mine !== nav) return
  if (r.ok && r.value.replyId === replyId) {
    set(cDraft, emptyDraft()); void saveDraftNow()
    set(cNotice, { tone: 'neutral', text: `Your ${kind === 'initial' ? 'answer' : 'follow-up'} was recorded (reply ID ${replyId}). ${deliveryText(r.value, d)}` })
  } else if (r.ok) {
    const { replyId: _id, ...rest } = read(cDraft); set(cDraft, rest); void saveDraftNow()
    set(cNotice, { tone: 'warning', text: 'Another answer was recorded first, so yours was not sent. The recorded answer is shown below. Your unsent answer is kept; nothing else is sent unless you choose to.' })
  } else if (r.code === 'conflict') {
    const { replyId: _id, ...rest } = read(cDraft); set(cDraft, rest); void saveDraftNow()
    set(cNotice, { tone: 'warning', text: `Reply ID ${replyId} could not be used because a different reply was already recorded. The recorded answer is shown below; your text is kept.` })
  } else if (r.code === 'unavailable') {
    set(cNotice, { tone: 'danger', retry: true, text: `Not confirmed. ${failureText(r)} The reply may or may not have been recorded. Your draft and reply ID ${replyId} are kept; Retry sends the same reply ID, so it is recorded at most once.` })
  } else {
    set(cNotice, { tone: 'danger', retry: true, text: `Not sent. ${failureText(r)} Your draft and reply ID are kept.` })
  }
  await loadDetail(mine, d.questionId, true)
}

const REASON: Record<Extract<Delivery, { state: 'undelivered' }>['reason'], string> = {
  'closed-origin': 'The original chat is closed.',
  disconnected: 'The host is disconnected.',
  'origin-mismatch': 'The chat no longer matches the original origin.',
  'delivery-failed': 'Orca could not hand it to that chat.'
}
const when = (iso: string) => formatInstant(iso, clock.zone())
/**
 * Saved, never sent: the worker reports no mail sender on this host and offers no retry, so a
 * `delivery-failed` reply was never handed to the chat. Real delivery failures keep their wording.
 */
const mailUnavailable = () => read(rows)?.mail?.state === 'unavailable'
const awaitingDelivery = (r: RecordedReply, d: Decision) =>
  r.delivery.state === 'undelivered' && r.delivery.reason === 'delivery-failed' && mailUnavailable() && !actionsOf(d).includes('retry')
function deliveryText(r: RecordedReply, d: Decision): string {
  if (r.delivery.state === 'local-only') return 'Saved in the Practice Inbox on this device. Nothing was sent to any chat or agent.'
  const state = replyState(r, d)
  if (state === 'agent-received' && r.delivery.state === 'agent-received') return `Agent received · receipt ${r.delivery.receipt.receiptId} · ${when(r.delivery.receipt.receivedAt)}.`
  if (awaitingDelivery(r, d)) return 'Saved in Decision Inbox and awaiting delivery. Orca mail from this plugin is unavailable on this host, so it has not been sent to the original chat yet.'
  if (r.delivery.state === 'undelivered') return `Saved in Decision Inbox, but not delivered to the original chat. ${REASON[r.delivery.reason]}${actionsOf(d).includes('retry') ? ' Retry it from the wide review.' : ' Retry is not available here; paste the reply into that chat yourself if it is needed now.'}`
  const t = transportOf(r.delivery)
  return t ? `Mail submitted to the original chat at ${when(t.acceptedAt)} (message ${t.messageId}); waiting for that chat to acknowledge it.`
    : 'Saved; mail hand-off to the original chat is not reported yet.'
}
function answerText(a: Answer, d: Decision) {
  if (a.kind === 'text') return a.text
  const label = d.options.find((o) => o.optionId === a.optionId)?.label ?? a.optionId
  return a.detail ? `${label} — ${a.detail}` : label
}

// ---- Inbox Settings in the panel ----------------------------------------------------------------
const sLoad = atom<Loadable<InboxSettings>>({ state: 'loading' })
const sEdit = atom<InboxSettings | null>(null)
const sSaved = atom('')
const sRepos = atom<string[]>([])
const sNotice = atom<Notice | null>(null)
const editable = (x: InboxSettings) => JSON.stringify({ defaultTemplate: x.defaultTemplate, exceptions: x.exceptions })

function openSettingsView() {
  void flushDraft()
  const mine = ++nav
  set(view, { kind: 'settings' }); set(wide, null); set(sNotice, null)
  void loadSettingsView(mine)
}
async function loadSettingsView(mine: number) {
  set(sLoad, { state: 'loading' })
  const [g, rp] = await Promise.all([call(req, 'settings.get'), call(req, 'settings.repos')])
  if (mine !== nav) return
  if (!g.ok) { set(sLoad, { state: 'fail', f: g }); return }
  set(sLoad, { state: 'ok', value: g.value }); set(sEdit, structuredClone(g.value)); set(sSaved, editable(g.value))
  set(sRepos, rp.ok ? rp.value : [])
  if (!rp.ok) set(sNotice, { tone: 'warning', text: `Could not read the repo list, so exceptions cannot be added. ${failureText(rp)}` })
}
async function saveSettingsView() {
  const s = read(sEdit); const mine = nav
  if (!s || !s.defaultTemplate.trim() || editable(s) === read(sSaved)) return
  const r = await call(req, 'settings.save', s)
  if (mine !== nav) return
  if (r.ok) { set(sEdit, structuredClone(r.value)); set(sSaved, editable(r.value)); set(sLoad, { state: 'ok', value: r.value }); set(sNotice, { tone: 'neutral', text: 'Settings saved.' }) }
  else if (r.code === 'conflict') set(sNotice, { tone: 'danger', reload: true, text: 'Settings changed elsewhere since you opened them, so nothing was saved. Load the latest settings (your edits are discarded), then edit again.' })
  else set(sNotice, { tone: 'danger', text: `Not saved. ${failureText(r)}` })
}

let practiceTimer: ReturnType<typeof setTimeout> | null = null
export function setup(ctx: PanelContext) {
  ctx.subscriptions.push(
    // Each new subscriber first receives the current context.
    // In Practice nothing live is read: the latest focus and any workspace or inbox news wait for
    // the switch back to the Inbox (setMode).
    on('workspace.changed', ({ context }) => { if (inPractice()) { deferred.focus = { context }; return } void focus(context) }),
    // Orca reports worktree and folder workspaces it creates or removes: the Workspace list follows.
    on('workspace.created', () => { if (inPractice()) { deferred.inventory = true; return } void refreshWorkspaces() }),
    on('workspace.removed', () => { if (inPractice()) { deferred.inventory = true; return } void refreshWorkspaces() }),
    // Empty invalidation: refetch through the authenticated request.
    plugin.on('inbox.changed', () => {
      if (inPractice()) { deferred.inbox = true; return }
      invalidated()
      // The open card follows its decision (receipts, another surface's answer); a failure keeps it.
      const v = read(view)
      if (v.kind === 'decision') void loadDetail(nav, v.questionId, true)
    }),
    // Practice writes have their own event, so a practice save never makes live sources be read.
    plugin.on('practice.changed', () => {
      if (!inPractice()) return
      if (practiceTimer) clearTimeout(practiceTimer)
      practiceTimer = setTimeout(() => {
        practiceTimer = null
        void loadPractice()
        const v = read(view)
        if (v.kind === 'decision') void loadDetail(nav, v.questionId, true)
      }, 150)
    })
  )
  set(now, clock.now())
  const tick = setInterval(() => set(now, clock.now()), 60_000)
  ctx.signal.addEventListener('abort', () => {
    clearInterval(tick); if (searchTimer) clearTimeout(searchTimer); if (refreshTimer) clearTimeout(refreshTimer); if (practiceTimer) clearTimeout(practiceTimer)
    void flushDraft() // never lose a draft when the panel closes
  })
  // The Workspace list; `all` needs no focused workspace, so load it now if the panel starts there.
  void refreshWorkspaces()
}

function DecisionRow(props: { d: Decision; all: readonly Decision[]; at: number; complete: boolean }) {
  const { d, all, at, complete } = props
  const native = nativeOf(d)
  const practice = isPractice(d)
  const due = deadlineLabel(d, at)
  const state = shownState(d)
  const pkg = native ? 0 : siblings(all, d).length
  // The canonical state stays the initial answer's; a failed follow-up gets its own badge.
  const failedFollowUps = native ? 0 : undeliveredReplies(d).filter((r) => r.kind === 'follow-up').length
  // Without a supported retry, an undelivered reply is a saved answer waiting for mail: say so.
  // Saved but never sent (no mail sender) reads differently from a delivery that actually failed.
  const initial = d.answerState.state === 'answered' ? d.answerState.initial : null
  const initialAwaiting = !native && !!initial && awaitingDelivery(initial, d)
  const followAwaiting = !native && undeliveredReplies(d).some((r) => r.kind === 'follow-up' && awaitingDelivery(r, d))
  const where = practice ? 'Practice Inbox · synthetic' : native && !native.workspaceAttributed
    ? 'No workspace attribution'
    : `${d.projectName} · ${d.workspaceName}${d.origin.hostId !== 'local' ? ` · ${d.origin.hostId}` : ''}`
  const item = native ? [native.botName, native.itemLabel && `item ${native.itemLabel}`].filter(Boolean).join(' · ') : ''
  return (
    <ListItem
      title={d.title}
      description={native ? `${item ? `${item} · ` : ''}${where}` : where}
      current={read(openId) === d.questionId}
      onPress={() => openDecision(d)}
    >
      <Row gap="xs" wrap>
        {/* The source is text, not color, so it reads the same to everyone. */}
        <Badge tone="neutral">{native ? 'Bot Item · answer in Orca' : practice ? 'Practice' : 'Chat decision'}</Badge>
        <Badge tone={d.priority === 'P0' ? 'danger' : d.priority === 'P1' ? 'warning' : 'neutral'}>{d.priority}</Badge>
        {due && <Badge tone={due.overdue ? 'danger' : 'warning'}>{due.text}</Badge>}
        {native
          ? <Badge tone={nativeNeedsYou(native) ? 'accent' : 'neutral'}>{nativeStatusLabel(native.itemStatus)}</Badge>
          : state !== 'awaiting-answer' && <Badge tone={state === 'undelivered' ? 'danger' : 'accent'}>{state === 'undelivered' && initialAwaiting ? 'Saved · awaiting delivery' : STATE_LABEL[state]}</Badge>}
        {/* Compact rows carry at most one failed follow-up, so the total is unknown here: name
            the condition, not a count. The review lists every reply. */}
        {failedFollowUps > 0 && <Badge tone="danger">{followAwaiting ? 'Follow-up saved · awaiting delivery' : 'Follow-up delivery failed'}</Badge>}
        {/* Only the loaded page is known; say "shown" unless every package member is loaded. */}
        {pkg > 0 && <Badge>{complete ? `Package · ${pkg + 1} questions` : `Package · ${pkg + 1} shown`}</Badge>}
      </Row>
      {d.blockedWork.length > 0 && <Text muted size="xs">{`Blocks: ${d.blockedWork.join(', ')}`}</Text>}
    </ListItem>
  )
}

/**
 * One collapsible source status (source-status.ts) instead of a banner per source: a read that
 * failed is named in the title, so it shows while collapsed; the rest is on demand. Mail is said at
 * the reply itself, not here.
 */
function SourceStatusBlock(props: { sources: readonly SourceStatus[] }) {
  const v = sourceStatus(props.sources)
  if (!v) return null
  const unavailable = props.sources.some((x) => x.state === 'unavailable')
  return (
    <Collapsible title={v.summary} defaultOpen={v.open}>
      <Stack gap="xs">
        {v.lines.map((l, i) => <Text key={`${i}`} size="xs" tone={l.tone === 'warn' ? 'warning' : undefined}>{`${l.label}. ${l.text}`}</Text>)}
        {unavailable && <Button size="sm" variant="outline" onPress={() => { void refreshWorkspaces(); void load() }}>Check sources again</Button>}
      </Stack>
    </Collapsible>
  )
}

/** The Practice Inbox list: what it is, said once, then the same rows as the Inbox. */
function PracticeList() {
  const p = read(pList); const f = read(pFail); const at = read(now)
  const shown = p ? order(p.list, at, clock.zone()) : []
  const waiting = p ? p.list.filter(isActionable).length : 0
  return (
    <Stack gap="sm">
      <Callout tone="neutral" title="Practice Inbox">
        Synthetic decisions to try answering. Drafts, notes and answers are saved in this Inbox on this device only; nothing is sent to any chat, agent or Orca mail. Your real Inbox and Bot Items are unchanged.
      </Callout>
      {f && <Callout tone="danger" title={p ? 'Showing the last loaded practice list' : 'Could not load the Practice Inbox'}>{failureText(f)}</Callout>}
      {f && !read(pLoading) && <Button size="sm" variant="outline" onPress={() => { void loadPractice() }}>Retry loading</Button>}
      {!p && !f && <Skeleton shape="block" lines={4} label="Loading practice decisions" />}
      {p && shown.length === 0 && <EmptyState icon="check" title="No practice decisions" description="Practice decisions appear here." />}
      {p && shown.length > 0 && (
        <Stack gap="xs">
          <Text muted size="xs">{`${shown.length} practice decision${shown.length === 1 ? '' : 's'} · ${waiting} waiting for an answer`}</Text>
          <List label="Practice decisions, most urgent first">
            {shown.map((d) => <DecisionRow key={d.questionId} d={d} all={p.list} at={at} complete={!p.nextCursor} />)}
          </List>
        </Stack>
      )}
      {p?.nextCursor && <Button size="sm" variant="outline" disabled={read(pLoading) === 'more'} onPress={() => loadPractice(true)}>{read(pLoading) === 'more' ? 'Loading more…' : 'Load more'}</Button>}
    </Stack>
  )
}

// ---- in-panel views -------------------------------------------------------------------------------
function WideNotice(props: { what: string }) {
  const w = read(wide)
  if (!w || w.nav !== nav) return null
  if (w.state === 'opening') return <Text muted size="xs">Opening the wide tab…</Text>
  if (w.state === 'opened') return <Text muted size="xs">Opened in a wide tab.</Text>
  return (
    <Callout tone="warning" title="The wide tab did not open">
      {`${w.text ?? ''} Only the wide tab failed; ${props.what} below ${props.what === 'settings' ? 'are' : 'is'} read from Decision Inbox and works here.`}
    </Callout>
  )
}
function ViewHeader(props: { title: string; wideLabel: string }) {
  return (
    <Stack gap="xs">
      <Row justify="between" align="center">
        <Button size="sm" variant="ghost" onPress={back}>← Back to list</Button>
        <Button size="sm" variant="outline" icon="open-external" disabled={read(wide)?.state === 'opening'} onPress={openWide}>{props.wideLabel}</Button>
      </Row>
      <Heading level={2}>{props.title}</Heading>
    </Stack>
  )
}
const NOTICE_TITLE: Record<Notice['tone'], string> = { neutral: 'Recorded', warning: 'Check before you continue', danger: 'Not sent' }

/** Sanitized GitHub-flavoured Markdown (Orca's own renderer): paragraphs, bold, links and lists. */
function Rich(props: { text: string }) {
  // Bare URLs are wrapped as <url> with the shared boundaries, so Orca's own autolinking cannot
  // run into the following text (for example a Chinese sentence after 。).
  return <Markdown content={autolinkForMarkdown(props.text)} />
}
function Section(props: { title: string; text?: string }) {
  if (!props.text?.trim()) return null
  return (
    <Stack gap="xs">
      <Text weight="semibold" size="sm">{props.title}</Text>
      <Rich text={props.text} />
    </Stack>
  )
}

/** "Question i / N" with Previous / Next; each question keeps its own draft. */
function Pager(props: { d: Decision }) {
  const p = packagePosition(props.d)
  const total = p.total === null ? `${Math.max(p.known, p.index + 1)}+` : String(p.total)
  if (p.total === 1 && !p.prev && !p.next) return <Text muted size="xs">Question 1 / 1</Text>
  return (
    <Row gap="xs" align="center" wrap>
      <Text muted size="xs">{`Question ${p.index + 1} / ${total}`}</Text>
      <Button size="sm" variant="ghost" disabled={!p.prev} onPress={() => p.prev && openDecision(p.prev)}>‹ Previous</Button>
      <Button size="sm" variant="ghost" disabled={!p.next} onPress={() => p.next && openDecision(p.next)}>Next ›</Button>
    </Row>
  )
}

/** The question and its context: what the owner reads first, then the rest on demand. */
function QuestionBody(props: { d: Decision }) {
  const d = props.d as RichDecision
  const n = nativeOf(d)
  const practice = isPractice(d)
  const due = deadlineLabel(d, read(now))
  const thread = replies(d)
  const state = shownState(d)
  const awaiting = d.answerState.state === 'answered' && awaitingDelivery(d.answerState.initial, d)
  return (
    <Stack gap="sm">
      {d.context && d.context !== d.title && <Text muted size="sm">{d.context}</Text>}
      <Heading level={2}>{d.title}</Heading>
      <Row gap="xs" wrap>
        <Badge tone="neutral">{n ? 'Bot Item · read-only' : practice ? 'Practice · saved on this device' : 'Chat decision'}</Badge>
        {n ? <Badge tone={nativeNeedsYou(n) ? 'accent' : 'neutral'}>{nativeStatusLabel(n.itemStatus)}</Badge>
          : <Badge tone={state === 'undelivered' ? 'danger' : 'accent'}>{state === 'undelivered' && awaiting ? 'Saved · awaiting delivery' : STATE_LABEL[state]}</Badge>}
        {(d.priority === 'P0' || d.priority === 'P1') && <Badge tone={d.priority === 'P0' ? 'danger' : 'warning'}>{d.priority}</Badge>}
        {due && <Badge tone={due.overdue ? 'danger' : 'warning'}>{due.text}</Badge>}
      </Row>
      <Section title="Background" text={d.background} />
      {d.blockedWork.length > 0 && <Section title="Blocks" text={d.blockedWork.map((x) => `- ${x}`).join('\n')} />}
      {!n && d.evidence.length > 0 && <Text muted size="xs">{`${d.evidence.length} evidence item${d.evidence.length > 1 ? 's' : ''} (${d.evidence.map((e) => e.label).join(', ')}): ${practice ? 'open the dashboard’s Practice view to see them.' : 'open the wide review to view them.'}`}</Text>}
      {thread.length > 0 && (
        <List label="Recorded answer and follow-ups">
          {thread.map((r, i) => (
            <ListItem key={r.replyId} title={`${i === 0 ? 'Answer' : `Follow-up ${i}`} · accepted ${when(r.acceptedAt)}`} description={answerText(r.answer, d)}>
              <Text muted size="xs">{deliveryText(r, d)}</Text>
              {/* The owner's own notes stay readable after the reply is recorded. */}
              {r.annotations.length > 0 && (
                <Collapsible title={`${r.annotations.length} note${r.annotations.length > 1 ? 's' : ''} ${notesFate(r.delivery)}`}>
                  {r.annotations.map((a, j) => <Text key={`${j}`} size="xs">{`${noteLabel(a, d)} — ${a.text}`}</Text>)}
                </Collapsible>
              )}
            </ListItem>
          ))}
        </List>
      )}
      <Collapsible title="Details">
        <KeyValue label="Details" items={[
          ...(n ? [{ label: 'Status in Orca', value: nativeStatusLabel(n.itemStatus) }, ...(n.observedAt ? [{ label: 'As of', value: when(n.observedAt) }] : []),
            ...(n.botName ? [{ label: 'Bot', value: n.botName }] : []), ...(n.itemLabel ? [{ label: 'Item', value: n.itemLabel }] : [])] : []),
          practice ? { label: 'Source', value: 'Practice Inbox · synthetic, saved on this device' }
            : { label: 'Workspace', value: n && !n.workspaceAttributed ? 'No workspace attribution' : `${d.projectName} · ${d.workspaceName}` },
          ...(!practice && d.origin.hostId && d.origin.hostId !== 'local' ? [{ label: 'Host', value: n?.hostLabel ?? d.origin.hostId }] : []),
          { label: 'Priority', value: d.priority },
          ...(d.deadline ? [{ label: 'Deadline', value: when(d.deadline) }] : []),
          { label: 'Created', value: when(d.createdAt) },
          { label: 'Question ID', value: d.questionId, code: true }
        ]} />
        {(d.nativeLinks ?? []).map((l) => l.url ? <Link key={l.ref} href={l.url}>{l.label}</Link> : <Text key={l.ref} size="xs">{`${l.label} (${l.kind} ${l.ref})`}</Text>)}
        {d.sourceLinks.map((l) => <Link key={l.url} href={l.url}>{l.label}</Link>)}
      </Collapsible>
      {(d.activity ?? []).length > 0 && (
        <Collapsible title="Original activity" description="As recorded at the source, unchanged">
          {d.activity!.map((a, i) => (
            <Stack key={`${i}`} gap="xs">
              <Text muted size="xs">{a.at ? `${a.label} · ${when(a.at)}` : a.label}</Text>
              <Rich text={a.text} />
            </Stack>
          ))}
        </Collapsible>
      )}
    </Stack>
  )
}

/** Native Items are answered in Orca: a compact footer with the options, and no reply controls. */
function NativeFooter(props: { d: Decision }) {
  const n = nativeOf(props.d)!
  const item = [n.botName && `bot “${n.botName}”`, n.itemLabel && `item ${n.itemLabel}`].filter(Boolean).join(', ')
  return (
    <Stack gap="xs">
      <Text weight="semibold" size="sm">{`Answer in Orca's Bot Items${item ? `: ${item}` : ''}`}</Text>
      {props.d.options.length > 0 && (
        <Row gap="xs" wrap>
          {props.d.options.map((o) => <Badge key={o.optionId} tone="neutral">{o.detail ? `${o.label} — ${o.detail}` : o.label}</Badge>)}
        </Row>
      )}
      <Text muted size="xs">Read-only copy: Decision Inbox cannot answer, resolve or open this Item for you.</Text>
      {/* The read-only path leads to a safe place to try answering, without touching this Item. */}
      <Row gap="xs" align="center" wrap>
        <Button size="sm" variant="outline" onPress={() => setMode('practice')}>Try answering in Practice</Button>
        <Text muted size="xs">Synthetic decisions, saved on this device; this Item stays unchanged.</Text>
      </Row>
    </Stack>
  )
}

/**
 * Notes in the panel: the same anchored notes as the wide review, saved with this question's draft
 * and sent with the reply. Without text selection, the owner picks a paragraph (Background,
 * Description or Recommendation, with exact raw offsets) or an image, and may narrow it to an exact
 * phrase (its occurrence when repeated). Works when the wide tab cannot open.
 */
function PanelNotes(props: { d: Decision }) {
  const { d } = props
  const draft = read(cDraft); const c = read(pNote); const sending = read(cSending)
  const open = c?.questionId === d.questionId ? c : null
  const targets = open ? noteTargets(d) : []
  const target = open ? targets.find((t) => t.value === open.target) : undefined
  const hits = open && target?.kind === 'text' && open.phrase ? occurrences(target.text, open.phrase).length : 0
  const name = (n: (typeof draft.annotations)[number]) => n.kind === 'image'
    ? `Image: ${d.evidence.find((e) => e.evidenceId === n.evidence.evidenceId)?.label ?? n.evidence.evidenceId} · v${n.evidence.version}`
    : n.anchor.kind === 'question' ? `${NOTE_FIELD_LABEL[n.anchor.field]}: “${n.quote.length > 48 ? `${n.quote.slice(0, 47)}…` : n.quote}”` : 'Evidence'
  return (
    <Stack gap="xs">
      {read(pNotesList) && !open && draft.annotations.map((n, i) => (
        <Row key={`${i}`} gap="xs" align="center" justify="between">
          <Text size="xs">{`${i + 1}. ${name(n)} — ${n.text}`}</Text>
          <Button size="sm" variant="ghost" disabled={sending} onPress={() => { set(pNoteSaved, false); editDraft({ annotations: read(cDraft).annotations.filter((x) => x !== n) }) }}>{`Remove note ${i + 1}`}</Button>
        </Row>
      ))}
      {read(pNoteSaved) && draft.annotations.length > 0 && !open && <Text muted size="xs">{isPractice(d) ? `Note saved with your practice draft (${draft.annotations.length}).` : `Note saved with your draft (${draft.annotations.length}). Not sent yet: notes go with your reply.`}</Text>}
      {open ? (
        <Card title="Add a note" description={isPractice(d) ? 'Notes are saved with your practice draft and answer, on this device only.' : 'Notes are saved with your draft and sent with your reply, not before.'}>
          <Select label="Note on" value={open.target || undefined} placeholder="Choose a paragraph or image…" options={targets.map((t) => ({ value: t.value, label: t.label }))}
            onChange={(v) => editNote({ target: v, phrase: '', occurrence: 0 })} />
          {target?.kind === 'text' && (
            <Input label="Exact words (optional)" value={open.phrase} placeholder="Leave empty to note the whole paragraph" onChange={(v) => editNote({ phrase: v, occurrence: 0 })} />
          )}
          {hits > 1 && (
            <Select label="Which occurrence" value={String(open.occurrence)} options={Array.from({ length: hits }, (_, i) => ({ value: String(i), label: `Occurrence ${i + 1} of ${hits}` }))}
              onChange={(v) => editNote({ occurrence: Number(v) })} />
          )}
          <Textarea label="Note" rows={3} value={open.text} placeholder="Your note (Ctrl+Enter adds it)" invalid={!!open.error}
            onChange={(v) => editNote({ text: v })} onSubmit={() => { void addPanelNote(d) }} />
          {open.error && <Text size="xs" tone="danger">{open.error}</Text>}
          <Row gap="xs" justify="end">
            <Button size="sm" variant="ghost" onPress={() => set(pNote, null)}>Cancel</Button>
            <Button size="sm" disabled={!!open.saving} onPress={() => { void addPanelNote(d) }}>{open.saving ? 'Saving…' : 'Add note'}</Button>
          </Row>
        </Card>
      ) : (
        <Row gap="xs" align="center" wrap>
          <Button size="sm" variant="outline" disabled={sending} onPress={() => { set(pNoteSaved, false); set(pNotesList, false); set(pNote, { questionId: d.questionId, target: '', phrase: '', occurrence: 0, text: '' }) }}>Add note</Button>
          {draft.annotations.length > 0 && (
            <Button size="sm" variant="ghost" onPress={() => { set(pNoteSaved, false); set(pNotesList, !read(pNotesList)) }}>{`${read(pNotesList) ? 'Hide notes' : 'Notes'} (${draft.annotations.length})`}</Button>
          )}
          {draft.annotations.length === 0 && <Text muted size="xs">Comment on a paragraph, exact words or an image. The wide review also lets you select text.</Text>}
        </Row>
      )}
    </Stack>
  )
}

/** The reply area for a Chat decision: notices, options and the composer, always at the bottom. */
function ChatFooter(props: { d: Decision }) {
  const { d } = props
  const draft = read(cDraft); const meta = read(cMeta); const sending = read(cSending); const notice = read(cNotice); const fail = read(cFail)
  const answered = d.answerState.state === 'answered'
  const practice = isPractice(d)
  const canSend = actionsOf(d).includes(answered ? 'follow-up' : 'reply')
  const held = heldInitial(d, draft)
  const answer = buildAnswer(d, draft)
  const mineRecovered = read(recovered)[d.questionId]
  return (
    <Stack gap="xs">
      {notice && <Callout tone={notice.tone} title={NOTICE_TITLE[notice.tone]}>{notice.text}</Callout>}
      {notice?.retry && draft.replyId && <Button size="sm" variant="outline" onPress={send}>{`Retry (same reply ID ${draft.replyId})`}</Button>}
      {fail && <Callout tone="warning" title="Draft not saved">{`${failureText(fail)} It is kept in this panel only.`}</Callout>}
      {mineRecovered && (
        <Card title="A panel edit was not saved" description="This draft changed in another tab or window, so your edit from this panel was not saved. The saved draft is shown below.">
          <Text>{`Your edit: “${[mineRecovered.optionId && `Option: ${d.options.find((o) => o.optionId === mineRecovered.optionId)?.label ?? mineRecovered.optionId}`, mineRecovered.text.trim()].filter(Boolean).join(' — ')}”`}</Text>
          <Row gap="xs" wrap>
            <Button size="sm" onPress={() => { dropRecoverable(d.questionId); const { replyId: _r, ...rest } = mineRecovered; set(cDraft, emptyDraft()); editDraft(rest); set(cNotice, null) }}>Use my panel edit</Button>
            <Button size="sm" variant="ghost" onPress={() => dropRecoverable(d.questionId)}>Discard my panel edit</Button>
          </Row>
        </Card>
      )}
      {!meta.loaded ? <Skeleton shape="text" lines={2} label="Loading your draft" />
        : held ? (
          <Card title="Your unsent answer" description="Another answer was recorded first, so this was not sent. Nothing is sent unless you choose to.">
            <Text>{[draft.optionId && `Option: ${d.options.find((o) => o.optionId === draft.optionId)?.label ?? draft.optionId}`, draft.text.trim()].filter(Boolean).join(' — ')}</Text>
            <Row gap="xs" wrap>
              <Button size="sm" onPress={() => { const { replyId: _i, optionId: _o, ...rest } = draft; editDraft({ ...rest, optionId: undefined, replyId: undefined, kind: 'follow-up' }); set(cNotice, null) }}>Write a follow-up from this text</Button>
              <Button size="sm" variant="ghost" onPress={() => { set(cDraft, emptyDraft()); editDraft({}); set(cNotice, null) }}>Discard</Button>
            </Row>
          </Card>
        ) : canSend ? (
          <Stack gap="xs">
            {!answered && d.options.length > 0 && (
              <RadioGroup label="Options" value={draft.optionId ?? ''} disabled={sending}
                options={d.options.map((o) => ({ value: o.optionId, label: o.label, description: o.detail }))}
                onChange={(v) => editDraft({ optionId: v, kind: 'initial' })} />
            )}
            <Textarea label={answered ? 'Follow-up' : 'Reply text'} rows={3} value={draft.text} disabled={sending}
              placeholder={practice ? (answered ? 'Practice follow-up (Ctrl+Enter saves it here)' : 'Practice answer (Ctrl+Enter saves it here)')
                : answered ? 'Follow-up to the agent (Ctrl+Enter to send)' : draft.optionId ? 'Optional detail with your option (Ctrl+Enter to submit)' : 'Free-text answer (Ctrl+Enter to submit)'}
              onChange={(v) => editDraft({ text: v })} onSubmit={() => { void send() }} />
            <PanelNotes d={d} />
            <Row gap="xs" align="center" justify="between">
              {/* Where this answer goes, at the point of reply: nothing is promised that Orca did not report. */}
              <Text muted size="xs">{replyReach(practice ? 'practice' : 'chat', read(rows)?.mail)}</Text>
              <Button disabled={sending || !answer} onPress={send}>{sending ? (practice ? 'Saving…' : 'Sending…') : practice ? (answered ? 'Save practice follow-up' : 'Save practice answer') : answered ? 'Send follow-up' : 'Submit reply'}</Button>
            </Row>
          </Stack>
        ) : <Text muted>Replying here is not available for this decision right now.</Text>}
    </Stack>
  )
}

/**
 * Reader layout: header (Back, wide tab, question pager), the question in its own scroll area, and
 * the reply area below it. Orca has no sticky or docked component; the question area scrolls
 * inside a column that fills the panel, so the reply area stays below it in view whenever the host
 * gives the panel a definite height.
 */
function DecisionView(props: { title: string }) {
  const r = read(detail)
  const d = r.state === 'ok' ? r.value : null
  return (
    <Box direction="column" height="100%" gap="sm">
      <Box shrink={false} gap="xs">
        <Row justify="between" align="center">
          <Button size="sm" variant="ghost" onPress={back}>{read(mode) === 'practice' ? '← Back to Practice' : '← Back to list'}</Button>
          {/* Practice has no wide review tab; it opens wide in the dashboard's Practice view. */}
          {d && isPractice(d) ? <Text muted size="xs">Wide: dashboard → Practice</Text>
            : <Button size="sm" variant="outline" icon="open-external" disabled={read(wide)?.state === 'opening'} onPress={openWide}>Open wide review</Button>}
        </Row>

        <WideNotice what="the decision" />
      </Box>
      <Box grow scroll="y" minHeight={0} gap="sm">
        {r.state === 'loading' && <Stack gap="sm"><Heading level={2}>{props.title}</Heading><Skeleton shape="block" lines={4} label="Loading decision" /></Stack>}
        {r.state === 'fail' && (
          <Stack gap="sm">
            <Heading level={2}>{props.title}</Heading>
            <Callout tone="danger" title={r.f.code === 'not-found' ? 'Decision not found' : r.f.code === 'forbidden' ? 'No access to this decision' : 'Could not read this decision'}>
              {r.f.code === 'not-found' ? 'It may have been withdrawn, or you may not have access.' : failureText(r.f)}
            </Callout>
            {r.f.code === 'unavailable' && <Button size="sm" variant="outline" onPress={() => { const v = read(view); if (v.kind === 'decision') { set(detail, { state: 'loading' }); void loadDetail(nav, v.questionId) } }}>Try again</Button>}
          </Stack>
        )}
        {d && <QuestionBody d={d} />}
      </Box>
      {d && (
        // Variant D's reply card: question paging and the recommendation (shown once) above the reply.
        <Box shrink={false} border padding="sm" radius="md" background="card" maxHeight="58%" scroll="y" gap="sm">
          <Pager d={d} />
          <Section title="Recommendation" text={d.recommendation} />
          {nativeOf(d) ? <NativeFooter d={d} /> : <ChatFooter d={d} />}
        </Box>
      )}
    </Box>
  )
}

function SettingsView() {
  const l = read(sLoad); const s = read(sEdit); const repos = read(sRepos); const notice = read(sNotice)
  const dirty = !!s && editable(s) !== read(sSaved)
  const empty = !!s && !s.defaultTemplate.trim()
  const used = new Set(s?.exceptions.map((e) => e.repo) ?? [])
  const free = repos.filter((r) => !used.has(r))
  const change = (f: (x: InboxSettings) => void) => { const next = structuredClone(read(sEdit)!); f(next); set(sEdit, next); set(sNotice, null) }
  return (
    <Stack gap="sm">
      <ViewHeader title="Inbox settings" wideLabel="Open in a wide tab" />
      <WideNotice what="settings" />
      {l.state === 'loading' && <Skeleton shape="block" lines={4} label="Loading settings" />}
      {l.state === 'fail' && (
        <Callout tone="danger" title={l.f.code === 'forbidden' ? 'No access to Inbox settings' : 'Could not read Inbox settings'}>{failureText(l.f)}</Callout>
      )}
      {l.state === 'fail' && <Button size="sm" variant="outline" onPress={() => void loadSettingsView(nav)}>Try again</Button>}
      {l.state === 'ok' && s && (
        <Stack gap="sm">
          <Text muted size="xs">These rules guide agents in supported Orca Chats. Agents also read each repo's AGENTS.md and their role file; those are not edited here.</Text>
          <Textarea label="Default question template" rows={6} value={s.defaultTemplate} invalid={empty} onChange={(v) => change((x) => { x.defaultTemplate = v })} />
          {empty && <Text tone="danger" size="xs">The default template cannot be empty.</Text>}
          <Heading level={3}>{`Repo exceptions (${s.exceptions.length})`}</Heading>
          {s.exceptions.map((e, i) => (
            <Card key={`${i}`} title={e.repo}>
              <Select label={`Repo for exception ${i + 1}`} value={e.repo} options={[e.repo, ...free].map((r) => ({ value: r, label: r }))} onChange={(v) => change((x) => { x.exceptions[i].repo = v })} />
              <Textarea label={`Template for ${e.repo}`} rows={3} value={e.template} onChange={(v) => change((x) => { x.exceptions[i].template = v })} />
              <Button size="sm" variant="ghost" onPress={() => change((x) => { x.exceptions.splice(i, 1) })}>{`Remove exception for ${e.repo}`}</Button>
            </Card>
          ))}
          <Button size="sm" variant="outline" disabled={free.length === 0} onPress={() => change((x) => { x.exceptions.push({ repo: free[0], template: x.defaultTemplate }) })}>
            {free.length ? 'Add exception' : repos.length ? 'Every repo already has an exception' : 'No repos to add'}
          </Button>
          {notice && <Callout tone={notice.tone} title={notice.tone === 'neutral' ? 'Saved' : notice.tone === 'warning' ? 'Note' : 'Not saved'}>{notice.text}</Callout>}
          {notice?.reload && <Button size="sm" variant="outline" onPress={() => void loadSettingsView(nav)}>Load latest settings</Button>}
          <Row gap="xs" align="center">
            <Button disabled={!dirty || empty} onPress={saveSettingsView}>Save</Button>
            <Button variant="ghost" disabled={!dirty} onPress={() => { set(sEdit, { ...l.value, ...JSON.parse(read(sSaved)) }); set(sNotice, null) }}>Revert</Button>
            <Text muted size="xs">{dirty ? 'Unsaved changes' : 'Saved'}</Text>
          </Row>
        </Stack>
      )}
    </Stack>
  )
}

export default function Panel() {
  const v = read(view)
  if (v.kind === 'decision') return <DecisionView title={v.title} />
  if (v.kind === 'settings') return <SettingsView />
  const sc = scopeNow()
  const st = read(ws)
  const w = st.focus
  const options = st.inv?.workspaces ?? []
  const at = read(now)
  const t = read(term)
  const h = read(history)
  const key = queryKey(sc, t, h)
  const scopePart = key.split('|')[0]
  const loaded = read(rows)
  // Rows loaded for another scope never show under this one. While a new search or history
  // query is in flight, the previous rows of the same scope stay, marked as updating.
  const all = loaded && loaded.key.split('|')[0] === scopePart ? loaded.list : null
  const updating = !!all && loaded!.key !== key
  const le = read(loadError)
  const err = le && le.key === key ? le.f : null
  // The worker already filtered and searched; the panel only orders in the desktop zone.
  const shown = all ? order(all, at, clock.zone()) : []
  const more = !updating && !!loaded?.nextCursor
  const complete = !updating && !more && h && !t.trim()
  const need = all ? all.filter(isActionable).length : 0
  const label = !sc ? 'No workspace' : sc.kind === 'all' ? 'All workspaces' : workspaceLabel(sc.workspace, options)
  const sources = all && loaded ? loaded.sources : []
  // "Nothing needs you" is only true for sources that could be read.
  const degraded = sources.some((x) => x.state !== 'available')

  let body
  if (!sc && !st.chosen && w === undefined) {
    body = <Skeleton shape="block" lines={4} label="Finding the focused workspace" />
  } else if (!sc) {
    // Ask; the scope is never widened without the owner's choice.
    const lost = lostWorkspace(st)
    const focusFail = st.focusFail ? failureText(st.focusFail) : null
    body = (
      <EmptyState icon="flag" title={lost ? `${workspaceLabel(lost, options)} is no longer available` : focusFail ? 'Could not identify the focused workspace' : 'No workspace is focused'}
        description={`${lost ? (st.chosen ? 'Your choice is kept until you pick another. ' : '') : focusFail ? `${focusFail} ` : ''}Choose a workspace or All workspaces in the Workspace list.`}>
        <Button size="sm" onPress={() => chooseScope(ALL_VALUE)}>Show all workspaces</Button>
      </EmptyState>
    )
  } else if (!all && err) {
    body = <Callout tone="danger" title="Could not load decisions">{failureText(err)}</Callout>
  } else if (!all) {
    body = <Skeleton shape="block" lines={4} label="Loading decisions" />
  } else if (shown.length === 0 && !updating) {
    body = (
      <EmptyState
        icon="check"
        title={t ? 'No matches' : degraded ? `Nothing found in ${label.toLowerCase()} from the sources that could be read` : `Nothing needs you in ${label.toLowerCase()}`}
        description={t ? 'Try another word, or turn on Include history.'
          : sc.kind === 'workspace' ? 'Choose All workspaces to check other workspaces. Bot Items without a workspace appear only there.'
          : degraded ? 'See the notice above for what could not be checked.' : 'You are all caught up.'}
      >
        {sc.kind === 'workspace' && !t && <Button size="sm" onPress={() => chooseScope(ALL_VALUE)}>Show all workspaces</Button>}
      </EmptyState>
    )
  } else {
    body = (
      <List label={`${label}, most urgent first`}>
        {shown.map((d) => <DecisionRow key={d.questionId} d={d} all={all!} at={at} complete={complete} />)}
      </List>
    )
  }

  return (
    <Stack gap="sm">
      <Row justify="between" align="center">
        <Heading level={2}>Decision Inbox</Heading>
        <Row gap="xs" align="center">
          {/* While searching, the count covers the matches only; say so. */}
          {!inPractice() && all && !updating && <Badge tone={need ? 'accent' : 'neutral'}>{`${need}${more ? '+' : ''} ${t.trim() ? 'matching ' : ''}need you`}</Badge>}
          <IconButton icon="settings" label="Inbox settings" size="sm" variant="ghost" onPress={openSettingsView} />
        </Row>
      </Row>

      {/* Always discoverable: Inbox (live sources) or Practice (synthetic, saved here only). Orca
          draws only the selected tab's children, so the hidden one reads nothing. */}
      <Tabs label="Which inbox" value={read(mode)} onChange={setMode}>
        <Tab value="inbox" label="Inbox">{!inPractice() && (
      <Stack gap="sm">
      {/* One Workspace choice: All workspaces or one authorized workspace (host shown for equal names). */}
      {/* Orca's Select shows its placeholder for no value; option values must be non-empty. */}
      <Select label="Workspace" {...(sc ? { value: scopeValue(sc) } : {})} placeholder="Choose a workspace…"
        options={workspaceChoices(st.inv, sc, sc ? null : (w ?? (intendedScope(st)?.kind === 'workspace' ? lostWorkspace(st) : null))).filter((o) => o.value)} onChange={chooseScope} />
      {st.invFail && <Text muted size="xs">{`Could not list your workspaces. ${failureText(st.invFail)}`}</Text>}
      {st.inv?.truncated && <Text muted size="xs">Some workspaces could not be listed.</Text>}

      <Input label="Search" type="search" placeholder="Title, background, option, ID, 中文…" value={t} onChange={search} />
      <Checkbox label="Include history" description="Submitted, received and answered" checked={h} onChange={toggleHistory} />
      {updating && <Text muted size="xs">Updating results…</Text>}

      {all && err && (
        <Callout tone="warning" title="Showing the last loaded list">
          {`${failureText(err)} Nothing is sent from this list.`}
        </Callout>
      )}
      {err && !read(loading) && <Button size="sm" variant="outline" onPress={() => { void refreshWorkspaces(); void load() }}>Retry loading</Button>}

      <SourceStatusBlock sources={sources} />
      {body}
      {more && (
        <Button size="sm" variant="outline" disabled={read(loading) === 'more'} onPress={() => load(true)}>
          {read(loading) === 'more' ? 'Loading more…' : 'Load more'}
        </Button>
      )}
      </Stack>
        )}</Tab>
        <Tab value="practice" label="Practice · safe">{inPractice() && <PracticeList />}</Tab>
      </Tabs>
    </Stack>
  )
}
