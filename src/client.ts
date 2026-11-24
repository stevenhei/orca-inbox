// FE-side helpers shared by the panel and the review editor: the live clock and desktop zone,
// typed worker requests that never throw, reply-ID minting, and draft reconciliation.
// No Orca imports: the panel passes `plugin.request` from 'orca', the editor `orca.plugin.request`.
import type { Decision, Delivery, RecordedReply } from './contract.ts'
import type { DecisionPage, DraftRecord, InboxUiRequests, ReplyDraft, SourceAvailability } from './backend-protocol.ts'

/**
 * The reviewing desktop's live clock and IANA zone. Production reads the real clock and zone;
 * tests replace `now`/`zone` with the fixture clock and UTC. There is no fixture fallback.
 */
export const clock = {
  now: (): number => Date.now(),
  zone: (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/** Drafts carry the per-attempt reply ID so a retry after a timeout or restart reuses it. */
export type Draft = ReplyDraft
/** A stored draft and its compare-and-set revision (required on every save, clears included). */
export type StoredDraft = DraftRecord
/** One bounded, server-searched page of minimal rows, ordered in the reviewing desktop zone. */
export type { DecisionPage }
/** The worker requests the FE calls, as declared by the shared protocol. */
export type FeRequests = InboxUiRequests

export type Failure = { ok: false; code: 'invalid' | 'forbidden' | 'not-found' | 'conflict' | 'unavailable'; message: string }
export type Requester = (name: string, input?: unknown, options?: { timeoutMs?: number }) => Promise<unknown>
type Out<K extends keyof FeRequests> = FeRequests[K]['output']

const CODES = new Set(['invalid', 'forbidden', 'not-found', 'conflict', 'unavailable'])

/**
 * Calls a worker request and always resolves to a `Result`. Host rejections (no worker, timeout,
 * unknown handler) become `unavailable`; a refused capability becomes `forbidden`. A malformed
 * answer is `unavailable`, never treated as success.
 */
export async function call<K extends keyof FeRequests>(req: Requester, name: K, input?: FeRequests[K]['input']): Promise<Out<K>> {
  let out: unknown
  try {
    out = await req(name, input as unknown)
  } catch (e) {
    const code = (e as { code?: string })?.code
    const message = e instanceof Error && e.message ? e.message : String(e)
    if (code === 'capability_denied' || code === 'not_permitted') return fail('forbidden', message) as Out<K>
    if (code === 'unknown_method') return fail('unavailable', `This Orca build does not provide “${name}”.`) as Out<K>
    if (code && CODES.has(code)) return fail(code as Failure['code'], message) as Out<K>
    return fail('unavailable', message || 'The Decision Inbox worker is unavailable.') as Out<K>
  }
  const r = out as { ok?: unknown; code?: unknown; message?: unknown }
  if (r && typeof r === 'object' && r.ok === true && 'value' in r) return out as Out<K>
  if (r && typeof r === 'object' && r.ok === false && typeof r.code === 'string' && CODES.has(r.code))
    return fail(r.code as Failure['code'], typeof r.message === 'string' ? r.message : '') as Out<K>
  return fail('unavailable', `Unexpected answer from “${name}”.`) as Out<K>
}
export const fail = (code: Failure['code'], message: string): Failure => ({ ok: false, code, message })

/** One line the owner reads for each failure code. The worker's own message follows it. */
export const FAILURE_TEXT: Record<Failure['code'], string> = {
  invalid: 'The request was refused as invalid.',
  forbidden: 'You do not have access.',
  'not-found': 'Not found. It may have been withdrawn, or you may not have access.',
  conflict: 'This changed elsewhere.',
  unavailable: 'The Decision Inbox is unavailable.'
}
export const failureText = (f: Failure) => (f.message ? `${FAILURE_TEXT[f.code]} ${f.message}` : FAILURE_TEXT[f.code])

/** A unique ID for one reply attempt. Kept in the draft until the reply is recorded. */
export function newReplyId(): string {
  const c = globalThis.crypto
  if (c?.randomUUID) return `reply-${c.randomUUID()}`
  const b = new Uint8Array(16); c.getRandomValues(b)
  return `reply-${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`
}

export const emptyDraft = (): Draft => ({ text: '', annotations: [] })
export const draftIsEmpty = (d: Draft) => !d.text.trim() && !d.optionId && d.annotations.length === 0

export const replies = (d: Decision): RecordedReply[] =>
  d.answerState.state === 'answered' ? [d.answerState.initial, ...d.answerState.followUps] : []

/**
 * Brings a stored draft in line with the recorded decision.
 *  - `sent`: the draft's reply ID is already recorded; the draft is done and should be cleared.
 *  - `superseded`: an initial draft lost to another accepted answer. The draft is kept unchanged
 *    (still an initial answer, option included) and is never converted or sent automatically; the
 *    owner decides whether to reuse its text as a follow-up.
 *  - `keep`: nothing changed.
 */
export function reconcile(draft: Draft, d: Decision): { kind: 'keep' | 'sent' | 'superseded'; draft: Draft | null } {
  if (draft.replyId && replies(d).some((r) => r.replyId === draft.replyId)) return { kind: 'sent', draft: null }
  if (d.answerState.state === 'answered' && (draft.kind ?? 'initial') === 'initial' && !draftIsEmpty(draft)) {
    return { kind: 'superseded', draft }
  }
  return { kind: 'keep', draft }
}

/** Full timestamp in the reviewing desktop zone, with the zone named. */
export function formatInstant(iso: string, zone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
  }).format(Date.parse(iso))
}

/** How one source answered a page: the queue is merged, but each source fails independently. */
export type SourceStatus = SourceAvailability
/** Per-source availability of a page; absent on older workers, meaning no per-source report. */
export const sourcesOf = (page: DecisionPage): SourceStatus[] => page.sources ?? []
/** Mail custody for a submitted plugin reply, when the worker reports it. */
export const transportOf = (delivery: Delivery): { messageId: string; acceptedAt: string } | null =>
  delivery.state === 'submitted' && delivery.transport ? delivery.transport : null
