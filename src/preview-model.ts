// Pure view-model for the preview. No Orca imports, so tests can use it directly.
// Sorting, search, deadline text and package grouping follow the production model (src/model.ts
// on main). Delivery is deliberately absent: a preview answer is saved here and never sent, so it
// gets its own state instead of production's Submitted / Agent received / Undelivered.
import type { Annotation, Answer, Decision, Priority } from './contract.ts'
import { SAMPLE_CLOCK, SAMPLE_DECISIONS } from './sample.ts'

export interface PreviewReply {
  replyId: string
  kind: 'initial' | 'follow-up'
  answer: Answer
  annotations: Annotation[]
  /** Milliseconds since the epoch, on this desktop. */
  savedAt: number
}

/** Everything the preview keeps. Stored under its own key, separate from production. */
export interface PreviewStore {
  /** First-open time; sample dates are placed relative to it. Null until the panel first opens. */
  seededAt: number | null
  replies: Record<string, PreviewReply[]>
}

export const EMPTY_STORE: PreviewStore = { seededAt: null, replies: {} }

export type CardState = 'awaiting-answer' | 'saved-in-preview' | 'sample-history'

export const CARD_STATE_LABEL: Record<CardState, string> = {
  'awaiting-answer': 'Awaiting answer',
  'saved-in-preview': 'Saved in preview',
  'sample-history': 'Sample history',
}

const shiftIso = (iso: string, by: number) => new Date(Date.parse(iso) + by).toISOString()

/** The sample decisions with their dates moved so SAMPLE_CLOCK lands on `seededAt`. */
export function samplesAt(seededAt: number, base: readonly Decision[] = SAMPLE_DECISIONS): Decision[] {
  const by = seededAt - Date.parse(SAMPLE_CLOCK)
  return base.map((d) => {
    const a = d.answerState
    return {
      ...d,
      createdAt: shiftIso(d.createdAt, by),
      ...(d.deadline ? { deadline: shiftIso(d.deadline, by) } : {}),
      answerState: a.state === 'answered'
        ? { ...a, initial: { ...a.initial, acceptedAt: shiftIso(a.initial.acceptedAt, by) } }
        : a,
    }
  })
}

export const repliesOf = (store: PreviewStore, d: Decision): PreviewReply[] => store.replies[d.questionId] ?? []

export function cardState(d: Decision, store: PreviewStore): CardState {
  if (repliesOf(store, d).length) return 'saved-in-preview'
  return d.answerState.state === 'answered' ? 'sample-history' : 'awaiting-answer'
}

/** Only unanswered cards need the owner; answered ones are history. */
export const isActionable = (d: Decision, store: PreviewStore) => cardState(d, store) === 'awaiting-answer'

/** Calendar day (YYYY-MM-DD) of an instant in an IANA zone. */
export const dayKey = (ms: number, zone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)

/** 0 = P0; 1 = overdue or due today in the desktop zone; 2 = everything else. */
export function group(d: Decision, now: number, zone: string): 0 | 1 | 2 {
  if (d.priority === 'P0') return 0
  if (d.deadline && dayKey(Date.parse(d.deadline), zone) <= dayKey(now, zone)) return 1
  return 2
}

const rank: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 }

/** Group, then priority, then oldest first, then question ID: a total order. */
export function order(list: readonly Decision[], now: number, zone: string): Decision[] {
  return [...list].sort((a, b) =>
    group(a, now, zone) - group(b, now, zone) ||
    rank[a.priority] - rank[b.priority] ||
    Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
    a.questionId.localeCompare(b.questionId))
}

const answerWords = (a: Answer) => (a.kind === 'text' ? [a.text] : [a.optionId, a.detail ?? ''])

/** Title, background, recommendation, options, reply text and IDs. Case-folded; CJK as typed. */
export function searchText(d: Decision, store: PreviewStore): string {
  const sample = d.answerState.state === 'answered' ? [d.answerState.initial, ...d.answerState.followUps] : []
  return [d.questionId, d.packageId, d.projectName, d.title, d.background, d.recommendation,
    ...d.options.flatMap((o) => [o.optionId, o.label, o.detail ?? '']),
    ...sample.flatMap((r) => answerWords(r.answer)),
    ...repliesOf(store, d).flatMap((r) => answerWords(r.answer)),
  ].join('\n').toLocaleLowerCase()
}

export type Query = { term: string; history: boolean; now: number; zone: string }

export function visible(all: readonly Decision[], store: PreviewStore, q: Query): Decision[] {
  const t = q.term.trim().toLocaleLowerCase()
  return order(all.filter((d) => (q.history || isActionable(d, store)) && (!t || searchText(d, store).includes(t))), q.now, q.zone)
}

/** "Overdue 21h", "Due in 3h", "Due in 2d". */
export function deadlineLabel(d: Decision, now: number): { text: string; overdue: boolean } | null {
  if (!d.deadline) return null
  const ms = Date.parse(d.deadline) - now
  const h = Math.round(Math.abs(ms) / 3_600_000)
  const span = h < 1 ? 'under 1h' : `${h}h`
  if (ms < 0) return { text: `Overdue ${span}`, overdue: true }
  return { text: h < 24 ? `Due in ${span}` : `Due in ${Math.round(h / 24)}d`, overdue: false }
}

/** Every question in the same package, this one included, in package order. */
export const packageOf = (all: readonly Decision[], d: Decision) => all.filter((x) => x.packageId === d.packageId)

export interface Draft { optionId: string; text: string; notes: Record<string, string> }
export const EMPTY_DRAFT: Draft = { optionId: '', text: '', notes: {} }

/**
 * Turns a draft into an answer, as production does: with options, the choice is required and the
 * text is optional detail; without options, the text is the answer and is required.
 */
export function answerFrom(d: Decision, draft: Draft): { ok: true; answer: Answer } | { ok: false; error: string } {
  const text = draft.text.trim()
  if (d.options.length) {
    if (!d.options.some((o) => o.optionId === draft.optionId)) return { ok: false, error: 'Choose an option before saving.' }
    return { ok: true, answer: { kind: 'option', optionId: draft.optionId, ...(text ? { detail: text } : {}) } }
  }
  if (!text) return { ok: false, error: 'Type a reply before saving.' }
  return { ok: true, answer: { kind: 'text', text } }
}

/** Image notes from the draft, tied to the evidence ID and version as the contract requires. */
export function notesFrom(d: Decision, draft: Draft): Annotation[] {
  return d.evidence.flatMap((e) => {
    const text = draft.notes[e.evidenceId]?.trim()
    return text && e.kind === 'image-snapshot' ? [{ kind: 'image' as const, evidence: { evidenceId: e.evidenceId, version: e.version }, text }] : []
  })
}

/** "Tuesday — bring the blue folder", or the text answer. */
export function describeAnswer(d: Decision, a: Answer): string {
  if (a.kind === 'text') return a.text
  const label = d.options.find((o) => o.optionId === a.optionId)?.label ?? a.optionId
  return a.detail ? `${label} — ${a.detail}` : label
}
