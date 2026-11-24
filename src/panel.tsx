import {
  atom, read, set, on, plugin,
  Badge, Button, Callout, Checkbox, EmptyState, Heading, IconButton, Input, List,
  ListItem, RadioGroup, Row, Skeleton, Stack, Text
} from 'orca'
import type { PanelContext } from 'orca'
import type { Decision, Workspace } from './contract.ts'
import { STATE_LABEL, deadlineLabel, isActionable, nativeOf, nativeStatusLabel, order, sameWorkspace, shownState, siblings, undeliveredReplies } from './model.ts'
import { call, clock, failureText, sourcesOf, type Failure, type Requester, type SourceStatus } from './client.ts'

// Narrow right-sidebar panel, declarative Orca components only. Data comes from the plugin
// worker (`listDecisionPage`); there is no fixture fallback. Rules:
//  * Opens on This workspace. Picking All workspaces sticks across focus changes (a plain atom,
//    never reset when the focused workspace changes).
//  * Scope identity is host + workspace. The focused workspace's host is resolved by the worker
//    (`workspace.resolve`); the panel never guesses a host.
//  * Only actionable rows (Awaiting answer, or any reply Undelivered) unless Include history is on.
//  * Pages are bounded and searched by the worker in the reviewing desktop zone; the panel never
//    re-applies search to the minimal projected rows.
//  * An open decision is bound to its question ID, not to whatever the scope shows next.

const req: Requester = (name, input, options) => (plugin.request as Requester)(name, input, options)

const scope = atom<'workspace' | 'all'>('workspace')
const term = atom('')
const history = atom(false)
/** The decision whose review tab the worker last opened, by question ID. Set only on success. */
const openId = atom<string | null>(null)
const openError = atom<{ title: string; text: string } | null>(null)
/** Focused workspace: undefined while unknown, null when none is focused or it cannot be resolved. */
const current = atom<Workspace | null | undefined>(undefined)
const focusError = atom<string | null>(null)
/** Loaded pages for one query key, so a failed refresh still shows (and labels) the last list. */
const rows = atom<{ key: string; list: Decision[]; nextCursor?: string; sources: SourceStatus[] } | null>(null)
const loading = atom<false | 'first' | 'more'>(false)
/** The last load failure, for the query key it happened in. */
const loadError = atom<{ key: string; f: Failure } | null>(null)
/** Live clock, ticking each minute so relative deadlines and "due today" stay current. */
const now = atom(clock.now())

let seq = 0
let focusSeq = 0
let searchTimer: ReturnType<typeof setTimeout> | null = null
const queryKey = (sc: 'workspace' | 'all', w: Workspace | null | undefined, t: string, h: boolean) =>
  `${sc === 'all' ? 'all' : w ? `ws:${w.hostId}:${w.workspaceId}` : 'ws:none'}|${h ? 'h' : '-'}|${t.trim()}`

const pageInput = (sc: 'workspace' | 'all', w: Workspace | null | undefined, t: string, h: boolean, cursor?: string) => ({
  scope: sc === 'all' ? { kind: 'all' as const } : { kind: 'workspace' as const, workspace: { hostId: w!.hostId, workspaceId: w!.workspaceId } },
  ...(t ? { query: t } : {}),
  includeHistory: h,
  timeZone: clock.zone(),
  ...(cursor ? { cursor } : {})
})

/** Loads the first page of the current query, or the next page with `more`. */
async function load(more = false) {
  const sc = read(scope), w = read(current), t = read(term).trim(), h = read(history)
  const key = queryKey(sc, w, t, h)
  if (sc === 'workspace' && !w) { set(loading, false); return }
  const prev = read(rows)
  const cursor = more && prev?.key === key ? prev.nextCursor : undefined
  if (more && !cursor) return
  const mine = ++seq
  // A refresh this load supersedes is re-run once this load lands, so no invalidation is lost.
  const supersededRefresh = refreshing
  refreshing = false
  set(loading, more ? 'more' : 'first')
  const r = await call(req, 'listDecisionPage', pageInput(sc, w, t, h, cursor))
  if (mine !== seq) return // a newer query, scope or refresh won; it owns the loading state
  set(loading, false)
  if (supersededRefresh && r.ok) invalidated()
  if (r.ok) {
    const seen = new Set(cursor ? prev!.list.map((d) => d.questionId) : [])
    const list = cursor ? [...prev!.list, ...r.value.rows.filter((d) => !seen.has(d.questionId))] : r.value.rows
    // The latest page's per-source report describes the whole list.
    set(rows, { key, list, ...(r.value.nextCursor ? { nextCursor: r.value.nextCursor } : {}), sources: sourcesOf(r.value) })
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
  const sc = read(scope), w = read(current), t = read(term).trim(), h = read(history)
  const key = queryKey(sc, w, t, h)
  const prev = read(rows)
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
  do {
    const r = await call(req, 'listDecisionPage', pageInput(sc, w, t, h, cursor))
    if (mine !== seq) return
    if (!r.ok) { refreshing = false; set(loading, false); set(loadError, { key, f: r }); return }
    const before = list.length
    for (const d of r.value.rows) if (!seen.has(d.questionId)) { seen.add(d.questionId); list.push(d) }
    if (pages === 0) sources = sourcesOf(r.value) // the first page reports each source's availability
    cursor = r.value.nextCursor
    if (before >= prev.list.length) break // this was the extra page a pending "Load more" asked for
  } while (cursor && (list.length < prev.list.length || wantExtra) && ++pages < MAX_REFRESH_PAGES)
  refreshing = false
  set(loading, false)
  const next = { key, list, ...(cursor ? { nextCursor: cursor } : {}), sources }
  if (JSON.stringify(next) !== JSON.stringify(prev)) set(rows, next)
  if (read(loadError)) set(loadError, null)
}
let refreshTimer: ReturnType<typeof setTimeout> | null = null
/** Bursts of invalidations (each draft save, delivery, receipt) coalesce into one refresh. */
function invalidated() {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => { refreshTimer = null; void refresh() }, 150)
}

/** A later focus change always wins, even when an earlier resolve answers last. */
async function focus(context: { workspaceId?: string } | null) {
  const mine = ++focusSeq
  set(focusError, null)
  if (!context?.workspaceId) { set(current, null); return }
  const r = await call(req, 'workspace.resolve', { workspaceId: context.workspaceId })
  if (mine !== focusSeq) return
  if (r.ok) {
    const prev = read(current)
    set(current, r.value)
    // Reload when the workspace changed, or when the loaded rows belong to another query (for
    // example after the panel was reopened with state from an earlier run).
    const loadedKey = read(rows)?.key
    const stale = loadedKey !== queryKey('workspace', r.value, read(term), read(history))
    if (read(scope) === 'workspace' && (!prev || !sameWorkspace(prev, r.value) || stale)) await load()
  } else {
    set(current, null)
    set(focusError, failureText(r))
  }
}

function chooseScope(sc: 'workspace' | 'all') {
  if (read(scope) === sc) return
  set(scope, sc)
  void load()
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

async function openReview(d: Decision) {
  set(openError, null)
  const r = await call(req, 'review.open', { questionId: d.questionId })
  if (r.ok) set(openId, d.questionId)
  else set(openError, { title: 'Could not open the review tab', text: failureText(r) })
}

async function openSettings() {
  set(openError, null)
  const r = await call(req, 'settings.open')
  if (!r.ok) set(openError, { title: 'Could not open Inbox settings', text: failureText(r) })
}

export function setup(ctx: PanelContext) {
  ctx.subscriptions.push(
    // Each new subscriber first receives the current context.
    on('workspace.changed', ({ context }) => { void focus(context) }),
    // Empty invalidation: refetch through the authenticated request.
    plugin.on('inbox.changed', invalidated)
  )
  set(now, clock.now())
  const tick = setInterval(() => set(now, clock.now()), 60_000)
  ctx.signal.addEventListener('abort', () => { clearInterval(tick); if (searchTimer) clearTimeout(searchTimer); if (refreshTimer) clearTimeout(refreshTimer) })
  // `all` needs no focused workspace; load it now in case the panel starts there.
  if (read(scope) === 'all') void load()
}

function DecisionRow(props: { d: Decision; all: readonly Decision[]; at: number; complete: boolean }) {
  const { d, all, at, complete } = props
  const native = nativeOf(d)
  const due = deadlineLabel(d, at)
  const state = shownState(d)
  const pkg = native ? 0 : siblings(all, d).length
  // The canonical state stays the initial answer's; a failed follow-up gets its own badge.
  const failedFollowUps = native ? 0 : undeliveredReplies(d).filter((r) => r.kind === 'follow-up').length
  const where = native && !native.workspaceAttributed
    ? 'No workspace attribution'
    : `${d.projectName} · ${d.workspaceName}${d.origin.hostId !== 'local' ? ` · ${d.origin.hostId}` : ''}`
  const item = native ? [native.botName, native.itemLabel && `item ${native.itemLabel}`].filter(Boolean).join(' · ') : ''
  return (
    <ListItem
      title={d.title}
      description={native ? `${item ? `${item} · ` : ''}${where}` : where}
      current={read(openId) === d.questionId}
      onPress={() => openReview(d)}
    >
      <Row gap="xs" wrap>
        {/* The source is text, not color, so it reads the same to everyone. */}
        <Badge tone="neutral">{native ? 'Bot Item · answer in Orca' : 'Chat decision'}</Badge>
        <Badge tone={d.priority === 'P0' ? 'danger' : d.priority === 'P1' ? 'warning' : 'neutral'}>{d.priority}</Badge>
        {due && <Badge tone={due.overdue ? 'danger' : 'warning'}>{due.text}</Badge>}
        {native
          ? <Badge tone={native.itemStatus === 'needs-you' ? 'accent' : 'neutral'}>{nativeStatusLabel(native.itemStatus)}</Badge>
          : state !== 'awaiting-answer' && <Badge tone={state === 'undelivered' ? 'danger' : 'accent'}>{STATE_LABEL[state]}</Badge>}
        {/* Compact rows carry at most one failed follow-up, so the total is unknown here: name
            the condition, not a count. The review lists every reply. */}
        {failedFollowUps > 0 && <Badge tone="danger">Follow-up delivery failed</Badge>}
        {/* Only the loaded page is known; say "shown" unless every package member is loaded. */}
        {pkg > 0 && <Badge>{complete ? `Package · ${pkg + 1} questions` : `Package · ${pkg + 1} shown`}</Badge>}
      </Row>
      {d.blockedWork.length > 0 && <Text muted size="xs">{`Blocks: ${d.blockedWork.join(', ')}`}</Text>}
    </ListItem>
  )
}

const SOURCE_NAME: Record<SourceStatus['source'], string> = { plugin: 'Chat decisions', 'native-item': 'Bot Items' }
/**
 * One callout per source that is not fully available, saying what still works. A failing source
 * never hides the other source's rows.
 */
function SourceNotices(props: { sources: readonly SourceStatus[] }) {
  return (
    <Stack gap="xs">
      {props.sources.filter((x) => x.state !== 'available').map((x) => {
        const other = x.source === 'plugin' ? 'Bot Items' : 'Chat decisions'
        const title = x.state === 'partial' ? `Some ${SOURCE_NAME[x.source]} could not be read` : `${SOURCE_NAME[x.source]} are unavailable`
        const what = x.source === 'native-item'
          ? 'Check Bot Items in Orca directly.'
          : 'Chat decisions cannot be answered here until this is fixed; existing drafts are kept.'
        return (
          <Callout key={x.source} tone="warning" title={title}>
            {`${x.message ? `${x.message} ` : ''}${what} ${other} below are not affected.`}
          </Callout>
        )
      })}
    </Stack>
  )
}

export default function Panel() {
  const sc = read(scope)
  const w = read(current)
  const at = read(now)
  const t = read(term)
  const h = read(history)
  const key = queryKey(sc, w, t, h)
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
  const label = sc === 'all' ? 'All workspaces' : 'This workspace'
  const oe = read(openError)
  const sources = all && loaded ? loaded.sources : []
  // "Nothing needs you" is only true for sources that could be read.
  const degraded = sources.some((x) => x.state !== 'available')

  let body
  if (sc === 'workspace' && w === undefined) {
    body = <Skeleton shape="block" lines={4} label="Finding the focused workspace" />
  } else if (sc === 'workspace' && w === null) {
    body = (
      <EmptyState icon="flag" title={read(focusError) ? 'Could not identify this workspace' : 'No workspace is focused'}
        description={read(focusError) ?? 'Focus a workspace, or show every workspace.'}>
        <Button size="sm" onPress={() => chooseScope('all')}>Show all workspaces</Button>
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
          : sc === 'workspace' ? 'Switch to All workspaces to check other repos. Bot Items without a workspace appear only there.'
          : degraded ? 'See the notice above for what could not be checked.' : 'You are all caught up.'}
      >
        {sc === 'workspace' && !t && <Button size="sm" onPress={() => chooseScope('all')}>Show all workspaces</Button>}
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
          {all && !updating && <Badge tone={need ? 'accent' : 'neutral'}>{`${need}${more ? '+' : ''} ${t.trim() ? 'matching ' : ''}need you`}</Badge>}
          <IconButton icon="settings" label="Inbox settings" size="sm" variant="ghost" onPress={openSettings} />
        </Row>
      </Row>

      {/* A radio group exposes which scope is selected to assistive technology. */}
      <RadioGroup label="Scope" orientation="horizontal" value={sc}
        options={[{ value: 'workspace', label: 'This workspace' }, { value: 'all', label: 'All workspaces' }]}
        onChange={(v) => chooseScope(v === 'all' ? 'all' : 'workspace')} />

      <Input label="Search" type="search" placeholder="Title, background, option, ID, 中文…" value={t} onChange={search} />
      <Checkbox label="Include history" description="Submitted, received and answered" checked={h} onChange={toggleHistory} />
      {updating && <Text muted size="xs">Updating results…</Text>}

      {all && err && (
        <Callout tone="warning" title="Showing the last loaded list">
          {`${failureText(err)} Nothing is sent from this list.`}
        </Callout>
      )}
      {err && !read(loading) && <Button size="sm" variant="outline" onPress={() => load()}>Retry loading</Button>}
      {oe && <Callout tone="danger" title={oe.title}>{oe.text}</Callout>}

      <SourceNotices sources={sources} />
      {body}
      {more && (
        <Button size="sm" variant="outline" disabled={read(loading) === 'more'} onPress={() => load(true)}>
          {read(loading) === 'more' ? 'Loading more…' : 'Load more'}
        </Button>
      )}
    </Stack>
  )
}
