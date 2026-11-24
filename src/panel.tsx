import {
  atom, read, set, on, plugin,
  Badge, Button, Callout, Checkbox, EmptyState, Heading, IconButton, Input, List,
  ListItem, Row, Skeleton, Stack, Text, Toolbar
} from 'orca'
import type { PanelContext } from 'orca'
import type { Decision, Workspace } from './contract.ts'
import { STATE_LABEL, deadlineLabel, isActionable, sameWorkspace, shownState, siblings, visible } from './model.ts'
import { call, clock, failureText, type Failure, type Requester } from './client.ts'

// Narrow right-sidebar panel, declarative Orca components only. Data comes from the plugin
// worker (`listDecisions`); there is no fixture fallback. Rules:
//  * Opens on This workspace. Picking All workspaces sticks across focus changes (a plain atom,
//    never reset when the focused workspace changes).
//  * Scope identity is host + workspace. The focused workspace's host is resolved by the worker
//    (`workspace.resolve`); the panel never guesses a host.
//  * Only actionable rows (Awaiting answer, Undelivered) unless Include history is on.
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
/** Last loaded rows per scope key, so a failed refresh still shows (and labels) the last list. */
const rows = atom<{ key: string; list: Decision[] } | null>(null)
const loading = atom(false)
/** The last load failure, for the scope key it happened in. */
const loadError = atom<{ key: string; f: Failure } | null>(null)
/** Live clock, ticking each minute so relative deadlines and "due today" stay current. */
const now = atom(clock.now())

let seq = 0
const scopeKey = (sc: 'workspace' | 'all', w: Workspace | null | undefined) =>
  sc === 'all' ? 'all' : w ? `ws:${w.hostId}:${w.workspaceId}` : 'ws:none'

/** Loads the selected scope. History and search filter locally so package counts stay whole. */
async function load(sc = read(scope), w = read(current)) {
  const key = scopeKey(sc, w)
  if (sc === 'workspace' && !w) { set(loading, false); return }
  const mine = ++seq
  set(loading, true)
  const r = await call(req, 'listDecisions', {
    scope: sc === 'all' ? { kind: 'all' } : { kind: 'workspace', workspace: { hostId: w!.hostId, workspaceId: w!.workspaceId } },
    includeHistory: true
  })
  if (mine !== seq) return // a newer scope or refresh won
  set(loading, false)
  if (r.ok) { set(rows, { key, list: r.value }); set(loadError, null) }
  else set(loadError, { key, f: r })
}

async function focus(context: { workspaceId?: string } | null) {
  set(focusError, null)
  if (!context?.workspaceId) { set(current, null); if (read(scope) === 'workspace') set(rows, null); return }
  const r = await call(req, 'workspace.resolve', { workspaceId: context.workspaceId })
  if (r.ok) {
    const prev = read(current)
    set(current, r.value)
    if (!prev || !sameWorkspace(prev, r.value)) await load(read(scope), r.value)
  } else {
    set(current, null)
    set(focusError, failureText(r))
  }
}

function chooseScope(sc: 'workspace' | 'all') {
  if (read(scope) === sc) return
  set(scope, sc)
  void load(sc)
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
    plugin.on('inbox.changed', () => { void load() })
  )
  set(now, clock.now())
  const tick = setInterval(() => set(now, clock.now()), 60_000)
  ctx.signal.addEventListener('abort', () => clearInterval(tick))
  // `all` needs no focused workspace; load it now in case the panel starts there.
  if (read(scope) === 'all') void load()
}

function DecisionRow(props: { d: Decision; all: readonly Decision[]; at: number }) {
  const { d, all, at } = props
  const due = deadlineLabel(d, at)
  const state = shownState(d)
  const pkg = siblings(all, d).length
  return (
    <ListItem
      title={d.title}
      description={`${d.projectName} · ${d.workspaceName}${d.origin.hostId !== 'local' ? ` · ${d.origin.hostId}` : ''}`}
      current={read(openId) === d.questionId}
      onPress={() => openReview(d)}
    >
      <Row gap="xs" wrap>
        <Badge tone={d.priority === 'P0' ? 'danger' : d.priority === 'P1' ? 'warning' : 'neutral'}>{d.priority}</Badge>
        {due && <Badge tone={due.overdue ? 'danger' : 'warning'}>{due.text}</Badge>}
        {state !== 'awaiting-answer' && <Badge tone={state === 'undelivered' ? 'danger' : 'accent'}>{STATE_LABEL[state]}</Badge>}
        {pkg > 0 && <Badge>{`Package · ${pkg + 1} questions`}</Badge>}
      </Row>
      {d.blockedWork.length > 0 && <Text muted size="xs">{`Blocks: ${d.blockedWork.join(', ')}`}</Text>}
    </ListItem>
  )
}

export default function Panel() {
  const sc = read(scope)
  const w = read(current)
  const at = read(now)
  const key = scopeKey(sc, w)
  const loaded = read(rows)
  // Rows loaded for another scope never show under this one.
  const all = loaded && loaded.key === key ? loaded.list : null
  const le = read(loadError)
  const err = le && le.key === key ? le.f : null
  const t = read(term)
  const shown = all && (sc === 'all' || w)
    ? visible(all, { scope: sc, current: w ?? { hostId: '', workspaceId: '' }, term: t, history: read(history), now: at, zone: clock.zone() })
    : []
  const need = all ? all.filter((d) => isActionable(d) && (sc === 'all' || (w && sameWorkspace(d.origin, w)))).length : 0
  const label = sc === 'all' ? 'All workspaces' : 'This workspace'
  const oe = read(openError)

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
  } else if (shown.length === 0) {
    body = (
      <EmptyState
        icon="check"
        title={t ? 'No matches' : `Nothing needs you in ${label.toLowerCase()}`}
        description={t ? 'Try another word, or turn on Include history.' : sc === 'workspace' ? 'Switch to All workspaces to check other repos.' : 'You are all caught up.'}
      >
        {sc === 'workspace' && !t && <Button size="sm" onPress={() => chooseScope('all')}>Show all workspaces</Button>}
      </EmptyState>
    )
  } else {
    body = (
      <List label={`${label}, most urgent first`}>
        {shown.map((d) => <DecisionRow key={d.questionId} d={d} all={all} at={at} />)}
      </List>
    )
  }

  return (
    <Stack gap="sm">
      <Row justify="between" align="center">
        <Heading level={2}>Decision Inbox</Heading>
        <Row gap="xs" align="center">
          {all && <Badge tone={need ? 'accent' : 'neutral'}>{`${need} need you`}</Badge>}
          <IconButton icon="settings" label="Inbox settings" size="sm" variant="ghost" onPress={openSettings} />
        </Row>
      </Row>

      <Toolbar label="Scope" gap="xs">
        <Button size="sm" variant={sc === 'workspace' ? 'solid' : 'outline'} onPress={() => chooseScope('workspace')}>This workspace</Button>
        <Button size="sm" variant={sc === 'all' ? 'solid' : 'outline'} onPress={() => chooseScope('all')}>All workspaces</Button>
      </Toolbar>

      <Input label="Search" type="search" placeholder="Title, background, option, ID, 中文…" value={t} onChange={(v) => set(term, v)} />
      <Checkbox label="Include history" description="Submitted, received and answered" checked={read(history)} onChange={(v) => set(history, v)} />

      {all && err && (
        <Callout tone="warning" title="Showing the last loaded list">
          {`${failureText(err)} Nothing is sent from this list.`}
        </Callout>
      )}
      {err && !read(loading) && <Button size="sm" variant="outline" onPress={() => load()}>Retry loading</Button>}
      {oe && <Callout tone="danger" title={oe.title}>{oe.text}</Callout>}

      {body}
    </Stack>
  )
}
