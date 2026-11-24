// Pure view-model for the Decision Inbox. No Orca imports, so FE tests and the worker can share it.
// Types come from the shared contract; nothing here invents new domain shapes.
import type { Decision, Priority, RecordedReply, Workspace } from './contract.ts'

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

/** Design decision 1: only Awaiting answer and Undelivered need the owner. The rest is history. */
export const isActionable = (d: Decision) => {
  const s = shownState(d)
  return s === 'awaiting-answer' || s === 'undelivered'
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

/** Group, then priority, then oldest first. Ties by question ID so the order is total. */
export function order(list: readonly Decision[], now: number, zone: string): Decision[] {
  return [...list].sort(
    (a, b) =>
      group(a, now, zone) - group(b, now, zone) ||
      rank[a.priority] - rank[b.priority] ||
      Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
      a.questionId.localeCompare(b.questionId)
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
      (q.scope === 'all' || sameWorkspace(d.origin, q.current)) &&
      (q.history || isActionable(d)) &&
      (!t || searchText(d).includes(t))),
    q.now,
    q.zone
  )
}

/** "Overdue 21h", "Due in 3h", "Due in 2d". Full timestamp belongs to the wide review. */
export function deadlineLabel(d: Decision, now: number): { text: string; overdue: boolean } | null {
  if (!d.deadline) return null
  const h = Math.round((Date.parse(d.deadline) - now) / 3_600_000)
  if (h < 0) return { text: `Overdue ${-h}h`, overdue: true }
  return { text: h < 24 ? `Due in ${h}h` : `Due in ${Math.round(h / 24)}d`, overdue: false }
}

/** Questions that share a package (context and evidence), each still its own row and receipt. */
export const siblings = (all: readonly Decision[], d: Decision) =>
  all.filter((x) => x.packageId === d.packageId && x.questionId !== d.questionId)
