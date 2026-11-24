// Pure view-model for the Decision Inbox. No Orca imports, so FE tests and the worker can share it.
// Types come from the shared contract; nothing here invents new domain shapes.
import type { Decision, DecisionAction, DecisionSource, Priority, RecordedReply, Workspace } from './contract.ts'

/** What the owner sees for a question. Four distinct states; never merged. */
export type ShownState = 'awaiting-answer' | 'submitted' | 'agent-received' | 'undelivered'

export const STATE_LABEL: Record<ShownState, string> = {
  'awaiting-answer': 'Awaiting answer',
  submitted: 'Submitted / awaiting confirmation',
  'agent-received': 'Agent received',
  undelivered: 'Undelivered'
}

/**
 * A receipt counts only when it names this reply and question and the decision's exact origin
 * (host, workspace and Chat session). Anything else stays Submitted / awaiting confirmation.
 */
export function receiptMatches(r: RecordedReply, d: Decision): boolean {
  if (r.delivery.state !== 'agent-received') return false
  const x = r.delivery.receipt
  return x.replyId === r.replyId && x.questionId === r.questionId && r.questionId === d.questionId &&
    x.origin.hostId === d.origin.hostId && x.origin.workspaceId === d.origin.workspaceId && x.origin.sessionId === d.origin.sessionId
}

/** The state the owner sees for one recorded reply: an unmatched receipt is not Agent received. */
export function replyState(r: RecordedReply, d: Decision): Exclude<ShownState, 'awaiting-answer'> {
  if (r.delivery.state === 'agent-received') return receiptMatches(r, d) ? 'agent-received' : 'submitted'
  return r.delivery.state
}

export function shownState(d: Decision): ShownState {
  return d.answerState.state === 'awaiting-answer' ? 'awaiting-answer' : replyState(d.answerState.initial, d)
}

/** Every recorded reply that was not delivered: the initial answer or any follow-up. */
export const undeliveredReplies = (d: Decision): RecordedReply[] =>
  d.answerState.state === 'answered'
    ? [d.answerState.initial, ...d.answerState.followUps].filter((r) => r.delivery.state === 'undelivered')
    : []

// ---- sources -------------------------------------------------------------------------------------
// One queue, two sources (agreed with the BE worker; optional on legacy rows):
//  * plugin: a plugin-owned decision from an ordinary workspace Chat. The owner answers here
//    (submitReply); the reply goes to that Chat by mail.
//  * native-item: a read-only mirror of a native Orca Bot Item. It is answered in Orca's own Bot
//    Items view; the Inbox has no owner write, deep link or resolve for it.
export type { DecisionAction, DecisionSource } from './contract.ts'
export type NativeSource = Extract<DecisionSource, { kind: 'native-item' }>

/** Absent on legacy rows, which are plugin-owned. */
export const sourceOf = (d: Decision): DecisionSource => d.source ?? { kind: 'plugin' }
export const nativeOf = (d: Decision): NativeSource | null => { const s = sourceOf(d); return s.kind === 'native-item' ? s : null }

const NATIVE_STATUS: Record<string, string> = { 'needs-you': 'Needs you', 'in-progress': 'In progress', planned: 'Planned', done: 'Done', canceled: 'Canceled', cancelled: 'Canceled' }
/** Orca's CLI may spell statuses `needs_you`, `Needs You` or `needs-you`: compare one canonical form. */
export const normalizeNativeStatus = (status?: string) => status?.trim().toLowerCase().replace(/[\s_]+/g, '-')
/** Recognized native statuses get a label; any other status is shown as Orca reported it. */
export const nativeStatusLabel = (status?: string) => (status ? NATIVE_STATUS[normalizeNativeStatus(status)!] ?? status : 'Status not reported')
export const nativeNeedsYou = (n: NativeSource) => normalizeNativeStatus(n.itemStatus) === 'needs-you'

/**
 * The actions the worker supports for this row. Native items have none. Legacy plugin rows
 * without the field get the plugin defaults for their state.
 */
export function actionsOf(d: Decision): DecisionAction[] {
  if (nativeOf(d)) return []
  const declared = d.actions
  if (declared) return declared
  if (d.answerState.state === 'awaiting-answer') return ['reply']
  return ['follow-up', ...(undeliveredReplies(d).length ? ['retry' as const] : [])]
}

/**
 * Design decision 1: Awaiting answer and Undelivered need the owner; the rest is history.
 * A native Bot Item needs the owner while Orca reports it as needs-you (answered in Orca).
 * Undelivered means any reply, so a failed follow-up keeps its question in the default queue
 * even after the initial answer was received. The canonical (initial) state is unchanged.
 * Shared with the worker, which applies the same rule to server-side filtering.
 */
export const isActionable = (d: Decision) => {
  const native = nativeOf(d)
  if (native) return nativeNeedsYou(native)
  return shownState(d) === 'awaiting-answer' || undeliveredReplies(d).length > 0
}

/** Scope identity is host + workspace: a paired host can reuse a workspace ID. */
export const workspaceKey = (w: Workspace) => `${w.hostId}:${w.workspaceId}`
export const sameWorkspace = (a: Workspace, b: Workspace) => workspaceKey(a) === workspaceKey(b)

/** Calendar day (YYYY-MM-DD) of an instant in an IANA zone. ISO dates compare correctly as strings. */
export const dayKey = (ms: number, zone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)

/**
 * 0 = P0; 1 = overdue or due today; 2 = everything else. "Today" is the calendar day in `zone`,
 * the reviewing desktop's time zone (orchestrator decision), with `now` and `zone` injected so
 * tests and fixtures are deterministic.
 */
export function group(d: Decision, now: number, zone: string): 0 | 1 | 2 {
  if (d.priority === 'P0') return 0
  if (d.deadline && dayKey(Date.parse(d.deadline), zone) <= dayKey(now, zone)) return 1
  return 2
}

const rank: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 }

function deadlineTime(d: Decision): number {
  const time = Date.parse(d.deadline ?? '')
  return Number.isFinite(time) ? time : Infinity
}

/** Priority, earliest deadline, then oldest first. Undated rows follow dated rows in each priority. */
export function order(list: readonly Decision[], _now?: number, _zone?: string): Decision[] {
  return [...list].sort(
    (a, b) =>
      rank[a.priority] - rank[b.priority] ||
      deadlineTime(a) - deadlineTime(b) ||
      Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
      (a.questionId < b.questionId ? -1 : a.questionId > b.questionId ? 1 : 0)
  )
}

/** Title, background, recommendation, options, reply text, and IDs. Case-folded; CJK matches as-is. */
export function searchText(d: Decision): string {
  const replies = d.answerState.state === 'answered' ? [d.answerState.initial, ...d.answerState.followUps] : []
  const replyText = replies.flatMap((r) => (r.answer.kind === 'text' ? [r.answer.text] : [r.answer.optionId, r.answer.detail ?? '']))
  return [d.questionId, d.packageId, d.title, d.background, d.recommendation,
    ...d.options.flatMap((o) => [o.optionId, o.label, o.detail ?? '']), ...replyText].join('\n').toLocaleLowerCase()
}

export type Query = { scope: 'workspace' | 'all'; current: Workspace; term: string; history: boolean; now: number; zone: string }

export function visible(all: readonly Decision[], q: Query): Decision[] {
  const t = q.term.trim().toLocaleLowerCase()
  return order(
    all.filter((d) =>
      (q.scope === 'all' || (nativeOf(d)?.workspaceAttributed !== false && sameWorkspace(d.origin, q.current))) &&
      (q.history || isActionable(d)) &&
      (!t || searchText(d).includes(t))),
    q.now,
    q.zone
  )
}

/** "Overdue 21h", "Due in 3h", "Due in 2d". Full timestamp belongs to the wide review. */
export function deadlineLabel(d: Decision, now: number): { text: string; overdue: boolean } | null {
  if (!d.deadline) return null
  // Overdue follows the sign of the raw difference, so a deadline minutes ago is never "Due in 0h".
  const ms = Date.parse(d.deadline) - now
  const h = Math.round(Math.abs(ms) / 3_600_000)
  const span = h < 1 ? 'under 1h' : `${h}h`
  if (ms < 0) return { text: `Overdue ${span}`, overdue: true }
  return { text: h < 24 ? `Due in ${span}` : `Due in ${Math.round(h / 24)}d`, overdue: false }
}

/** Questions that share a package (context and evidence), each still its own row and receipt. */
export const siblings = (all: readonly Decision[], d: Decision) =>
  all.filter((x) => x.packageId === d.packageId && x.questionId !== d.questionId)
