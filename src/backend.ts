import type { AcknowledgeReply, Annotation, Decision, Delivery, Evidence, Origin, RecordedReply, Result, SubmitDecision, SubmitReply, Workspace } from './contract.ts'
import type { DecisionPage, InboxSettings, OwnerCaller, PrivateSnapshot, ReplyDraft } from './backend-protocol.ts'
import type { InboxErrorCode } from './backend-validation.ts'
import { annotations, id, InboxError, list, object, reply, requireInput, string, submission, validateNotes } from './backend-validation.ts'
import { isActionable, order, searchText } from './model.ts'

export type AgentCaller = {
  kind: 'agent'
  id: string
  origin: Origin
  projectName: string
  workspaceName: string
  repo: string
  policyOwnerId: string
}

export type Caller = OwnerCaller | AgentCaller
type ScopedParticipant = OwnerCaller | Pick<AgentCaller, 'kind' | 'id' | 'origin'>
export type SubmissionGrant = {
  participantIds: string[]
  snapshots: { attachmentId: string; readerIds: string[]; image: PrivateSnapshot }[]
  evidenceText?: { evidenceId: string; version: number; text: string }[]
}

export interface DeliveryTarget {
  origin: Origin
  reply: SubmitReply
}

export type SendOutcome = 'submitted' | { messageId: string } | Extract<Delivery, {state: 'undelivered'}>['reason']

export interface InboxBoundary {
  // Methods are implemented at a trusted host boundary. Submission grants must verify
  // participation, attachment identity/version and readers against the authenticated origin.
  grantSubmission(caller: AgentCaller, input: SubmitDecision): Promise<SubmissionGrant>
  // Evaluate current independently verified grants for this exact evidence version and caller.
  canReadSnapshot(caller: ScopedParticipant, binding: { origin: Origin; questionId: string; evidence: Extract<Evidence, {kind: 'image-snapshot'}> }): Promise<boolean>
  // Validate that the receiving session is still authorized. Use replyId as a durable
  // idempotency key at the destination. Storage receipts return only 'submitted'.
  send(target: DeliveryTarget): Promise<SendOutcome>
  // Validate proof of receipt in the original Chat, independently of panel input or mail.
  verifyReceipt(caller: AgentCaller, input: AcknowledgeReply): Promise<boolean>
}

export interface InboxStorage {
  read(): Promise<unknown>
  write(state: State): Promise<void>
  readSnapshot?(blob: string): Promise<PrivateSnapshot | undefined>
}

type StoredSnapshot = Omit<SubmissionGrant['snapshots'][number], 'image'> & { image?: PrivateSnapshot; blob?: string }
type StoredGrant = Omit<SubmissionGrant, 'snapshots'> & { snapshots: StoredSnapshot[] }
interface State {
  version: 1
  packages: { origin: Origin; sourceId: string; input: SubmitDecision; grant: StoredGrant }[]
  decisions: Decision[]
  replies: { ownerId: string; input: SubmitReply; acceptedId: string }[]
  outbox: { questionId: string; replyId: string }[]
  settings: { ownerId: string; value: InboxSettings }[]
  drafts: { ownerId: string; questionId: string; value: ReplyDraft | null; revision?: number }[]
}

type Options = {
  now?: () => number
  timeZone?: string
  changed?: () => void
}

const fresh = (): State => ({ version: 1, decisions: [], packages: [], replies: [], outbox: [], settings: [], drafts: [] })
const reason = (state: Exclude<SendOutcome, object>): Delivery =>
  state === 'submitted' ? { state } : { state: 'undelivered', reason: state }
const sameWorkspace = (a: Workspace, b: Workspace) => a.hostId === b.hostId && a.workspaceId === b.workspaceId
const sameOrigin = (a: Origin, b: Origin) => sameWorkspace(a, b) && a.sessionId === b.sessionId
const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const fail = (code: InboxErrorCode, message: string): never => { throw new InboxError(code, message) }
const thread = (d: Decision) => d.answerState.state === 'answered' ? [d.answerState.initial, ...d.answerState.followUps] : []
const bridgeBudget = 768 * 1024
export const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length

export const maxStoredId = '\ud800'.repeat(256) // Each code unit is escaped by JSON.stringify.
export const maxTimestamp = '+275760-09-13T00:00:00.000Z'
export const initialContentBudget = 4096

export function initialReplyEnvelope(questionId: string): RecordedReply {
  return {
    questionId, replyId: maxStoredId, kind: 'initial', answer: { kind: 'text', text: '' },
    annotations: [], acceptedAt: maxTimestamp, delivery: { state: 'submitted' }
  }
}

export function largestReceipt(origin: Origin, questionId: string, replyId: string): Delivery {
  return { state: 'agent-received', receipt: { questionId, replyId, receiptId: maxStoredId, origin, receivedAt: maxTimestamp } }
}

export const longestFailure: Delivery = { state: 'undelivered', reason: 'delivery-failed' }

function checkDetailBudget(d: Decision) {
  const awaiting = d.answerState.state === 'awaiting-answer'
  const initial = awaiting ? initialReplyEnvelope(d.questionId) : undefined
  const decision: Decision = initial
    ? { ...d, answerState: { state: 'answered', initial, followUps: [] } }
    : d
  let bytes = jsonBytes(decision) + (awaiting ? initialContentBudget : 0)
  for (const r of thread(decision)) {
    if (r.delivery.state === 'agent-received') continue
    const receipt = largestReceipt(d.origin, r.questionId, r.replyId)
    // Delivery can cycle through failure and submission before a receipt arrives.
    bytes += Math.max(jsonBytes(receipt), jsonBytes(longestFailure)) - jsonBytes(r.delivery)
  }
  requireInput(bytes <= bridgeBudget, awaiting
    ? 'Decision is too large to reserve space for an initial answer and receipt.'
    : 'Decision thread exceeds the Inbox detail limit.')
}

export function decisionSourceMetadata(links: Decision['sourceLinks'], sessionId: string) {
  const workItemLinks: NonNullable<Decision['workItemLinks']> = []
  const seen = new Set<string>()
  for (const link of links) {
    if (workItemLinks.length >= 20) break
    if (link.url.length > 2048) continue
    let url: URL
    try { url = new URL(link.url) } catch { continue }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || seen.has(link.url)) continue
    const github = url.hostname === 'github.com' && /^\/[\w.-]+\/[\w.-]+\/(issues|pull)\/[1-9]\d*\/?$/.exec(url.pathname)
    const linear = url.hostname === 'linear.app' && /^\/[\w-]+\/issue\/[A-Za-z][A-Za-z0-9]*-[1-9]\d*(?:\/[^/]+)?\/?$/.test(url.pathname)
    if (github) workItemLinks.push({ url: link.url, label: link.label.slice(0, 256), kind: github[1] === 'pull' ? 'github-pr' : 'github-issue' })
    if (linear) workItemLinks.push({ url: link.url, label: link.label.slice(0, 256), kind: 'linear-issue' })
    seen.add(link.url)
  }
  const original = sessionId.replace(/^orca_session_id:/, '')
  return {
    ...(workItemLinks.length ? { workItemLinks } : {}),
    ...(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(original)
      ? { originalSessionId: 'orca_session_id:' + original } : {})
  }
}

function projectRow({ description: _description, packageSummary: _summary, activity: _activity, nativeLinks: _nativeLinks, inlineImages: _inlineImages, workItemLinks: _workItemLinks, originalSessionId: _session, ...d }: Decision): Decision {
  const minimalReply = (r: RecordedReply): RecordedReply => ({
    ...r, answer: { kind: 'text', text: '' }, annotations: []
  })
  const answerState: Decision['answerState'] = d.answerState.state === 'answered'
    ? { ...d.answerState, initial: minimalReply(d.answerState.initial),
        followUps: d.answerState.followUps.filter(r => r.delivery.state === 'undelivered').slice(0, 1).map(minimalReply) }
    : d.answerState
  return {
    ...d, title: d.title.slice(0, 4096), background: '', recommendation: '', options: [],
    projectName: d.projectName.slice(0, 1024), workspaceName: d.workspaceName.slice(0, 1024),
    blockedWork: d.blockedWork.slice(0, 12).map(item => item.slice(0, 512)),
    evidence: [], sourceLinks: [], access: { participantIds: [], attachmentReaderIds: {} }, answerState
  }
}

const initialSettings = (): InboxSettings => ({
  revision: 0, exceptions: [],
  defaultTemplate: 'Read applicable repo instructions and the selected role. Check prior decisions. Describe the choice, recommendation, options, and blocked work. Continue unaffected work.'
})

export async function result<T>(action: () => T | Promise<T>): Promise<Result<T>> {
  try { return ok(await action()) }
  catch (error) {
    return error instanceof InboxError ? { ok: false, code: error.code, message: error.message }
      : { ok: false, code: 'unavailable', message: 'Inbox storage or host integration is unavailable.' }
  }
}

function owner(caller: Caller): OwnerCaller {
  if (caller.kind !== 'owner') return fail('forbidden', 'This operation requires an authenticated owner.')
  return caller
}

function agent(caller: Caller): AgentCaller {
  if (caller.kind !== 'agent') return fail('forbidden', 'This operation requires an authenticated Chat caller.')
  return caller
}

function mayRead(caller: ScopedParticipant, decision: Decision): boolean {
  return decision.access.participantIds.includes(caller.id) && (caller.kind === 'owner'
    ? caller.workspaces.some(workspace => sameWorkspace(workspace, decision.origin))
    : sameOrigin(caller.origin, decision.origin))
}

function findDecision(state: State, caller: Caller, questionId: string): Decision {
  const found = state.decisions.find(d => d.questionId === questionId && mayRead(caller, d))
  if (!found) return fail('not-found', 'Decision is missing or inaccessible.')
  return found
}

function mayReadAttachment(caller: ScopedParticipant, decision: Decision, attachmentId: string) {
  return Object.hasOwn(decision.access.attachmentReaderIds, attachmentId) &&
    decision.access.attachmentReaderIds[attachmentId].includes(caller.id)
}

function visibleNote(evidence: Evidence[], note: Annotation) {
  if (note.kind === 'selection' && note.anchor.kind === 'question') return true
  const ref = note.kind === 'image' ? note.evidence : note.anchor.kind === 'evidence' ? note.anchor.evidence : undefined
  return evidence.some(e => e.evidenceId === ref?.evidenceId && e.version === ref?.version)
}
function redact(caller: Caller, decision: Decision, evidence: Evidence[]): Decision {
  const visibleReply = (r: RecordedReply) => ({ ...r, annotations: r.annotations.filter(note => visibleNote(evidence, note)) })
  const answerState = decision.answerState.state === 'answered'
    ? { ...decision.answerState, initial: visibleReply(decision.answerState.initial), followUps: decision.answerState.followUps.map(visibleReply) }
    : decision.answerState
  const inlineImages = decision.inlineImages?.map(image =>
    'evidenceId' in image && evidence.some(item => item.kind === 'image-snapshot' &&
      item.evidenceId === image.evidenceId && item.version === image.version)
      ? image
      : { offset: image.offset, unavailable: true as const })
  return { ...decision, ...(inlineImages ? { inlineImages } : {}), evidence, answerState, access: {
    participantIds: [caller.id],
    attachmentReaderIds: Object.fromEntries(evidence.flatMap(e => e.kind === 'image-snapshot' ? [[e.attachmentId, [caller.id]]] : []))
  } }
}

export class InboxBackend {
  private tail: Promise<unknown> = Promise.resolve()
  private readonly inFlight = new Map<string, Promise<void>>()
  private readonly now: () => number
  private readonly timeZone: string

  constructor(private readonly store: InboxStorage, private readonly boundary: InboxBoundary, private readonly options: Options = {}) {
    this.now = options.now ?? Date.now
    this.timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  }

  // Orca owns the single writer. Serialize reads and writes and persist each transaction as
  // one storage value before observing its result or initiating a transport side effect.
  private transaction<T>(action: (state: State, commit: () => void) => T | Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
      const stored = await this.store.read()
      const state = stored == null ? fresh() : structuredClone(stored as State)
      if (state.version !== 1) return fail('unavailable', 'Inbox storage version is unsupported.')
      let dirty = false
      const value = await action(state, () => { dirty = true })
      if (dirty) {
        await this.store.write(state)
        try { this.options.changed?.() } catch { /* UI invalidation is best effort. */ }
      }
      return value
    })
    this.tail = next.catch(() => {})
    return next
  }

  private async canReadSnapshot(caller: ScopedParticipant, d: Decision, item: Extract<Evidence, {kind: 'image-snapshot'}>) {
    return mayRead(caller, d) && d.evidence.filter(e => e.kind === 'image-snapshot' &&
      e.attachmentId === item.attachmentId).length === 1 && mayReadAttachment(caller, d, item.attachmentId) &&
      await this.boundary.canReadSnapshot(caller, { origin: d.origin, questionId: d.questionId, evidence: item })
  }

  private async visibleDecision(caller: Caller, d: Decision) {
    const evidence = await Promise.all(d.evidence.map(async e =>
      e.kind === 'link' || await this.canReadSnapshot(caller, d, e) ? e : undefined))
    return redact(caller, d, evidence.filter((item): item is Evidence => item !== undefined))
  }

  submitDecision(caller: Caller, raw: unknown) {
    return result(async () => {
      const source = agent(caller)
      const input = submission(raw)
      return this.transaction(async (state, commit) => {
        const previous = state.packages.find(p => p.input.requestId === input.requestId)
        if (previous) {
          if (!sameOrigin(previous.origin, source.origin) || JSON.stringify(previous.input) !== JSON.stringify(input) ||
            previous.sourceId !== source.id) {
            return fail('conflict', 'Request ID already has a different submission or origin.')
          }
          return Promise.all(state.decisions.filter(d => d.packageId === input.packageId && mayRead(source, d)).map(d => this.visibleDecision(source, d)))
        }
        if (state.packages.some(p => p.input.packageId === input.packageId) ||
          input.questions.some(q => state.decisions.some(d => q.questionId === d.questionId))) {
          return fail('conflict', 'Package or question ID is already in use.')
        }
        const attachmentIds = input.evidence.flatMap(e => e.kind === 'image-snapshot' ? [e.attachmentId] : [])
        requireInput(new Set(attachmentIds).size === attachmentIds.length, 'Each snapshot version needs a distinct attachment ID.')
        if (state.packages.some(p => p.grant.snapshots.some(s => attachmentIds.includes(s.attachmentId)))) {
          return fail('conflict', 'Attachment ID already identifies a stored immutable snapshot.')
        }
        const grant = await this.boundary.grantSubmission(source, input)
        if (!grant.participantIds.includes(source.id) || !grant.participantIds.includes(source.policyOwnerId)) {
          return fail('forbidden', 'The submitting Chat and owner must be verified participants.')
        }
        const attachmentReaderIds = Object.fromEntries(input.evidence.flatMap(e => {
          if (e.kind !== 'image-snapshot') return []
          const snapshot = grant.snapshots.find(s => s.attachmentId === e.attachmentId)
          if (!snapshot || grant.snapshots.filter(s => s.attachmentId === e.attachmentId).length !== 1 || !snapshot.readerIds.includes(source.id) ||
            snapshot.readerIds.some(reader => !grant.participantIds.includes(reader))) {
            return fail('forbidden', 'The attachment was not verified for this Chat.')
          }
          requireInput(['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(snapshot.image.mimeType) &&
            snapshot.image.base64.length <= 900_000 && snapshot.image.base64.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(snapshot.image.base64) &&
            snapshot.image.base64.length > 0, 'Unsupported or oversized image snapshot.')
          return [[e.attachmentId, snapshot.readerIds]]
        }))
        const createdAt = new Date(this.now()).toISOString()
        const decisions = input.questions.map((q, index): Decision => ({
          ...q, package: { index, size: input.questions.length }, revision: 1, requestId: input.requestId, packageId: input.packageId,
          ...(input.summary === undefined ? {} : { packageSummary: input.summary }),
          origin: source.origin, projectName: source.projectName, workspaceName: source.workspaceName,
          access: { participantIds: grant.participantIds, attachmentReaderIds }, createdAt,
          decisionLink: `orca-inbox:question/${encodeURIComponent(q.questionId)}`,
          sourceLinks: input.sourceLinks, evidence: input.evidence, answerState: { state: 'awaiting-answer' }
        }))
        for (const decision of decisions) checkDetailBudget(decision)
        const visible = await Promise.all(decisions.map(d => this.visibleDecision(source, d)))
        state.decisions.push(...decisions)
        state.packages.push({ origin: source.origin, sourceId: source.id, input, grant: {
          ...grant, snapshots: grant.snapshots.filter(s => Object.hasOwn(attachmentReaderIds, s.attachmentId))
        } })
        commit()
        return visible
      })
    })
  }

  private queryRows(caller: Caller, raw: unknown, nativeRows: readonly Decision[] = []) {
    const input = object(raw)
    const scope = object(input.scope)
    requireInput(scope.kind === 'all' || scope.kind === 'workspace', 'Invalid scope kind.')
    requireInput(typeof input.includeHistory === 'boolean', 'Expected includeHistory.')
    const workspace = scope.kind === 'workspace' ? object(scope.workspace) : null
    const filter = workspace && { hostId: id(workspace.hostId, 'hostId', 1024), workspaceId: id(workspace.workspaceId, 'workspaceId', 1024) }
    const query = input.query === undefined ? '' : string(input.query, 'query', true).trim().toLocaleLowerCase()
    const zone = input.timeZone === undefined ? this.timeZone : id(input.timeZone, 'time zone')
    try { new Intl.DateTimeFormat('en', { timeZone: zone }) }
    catch { return fail('invalid', 'Invalid reviewing desktop time zone.') }
    return this.transaction(state => {
      const rows = [...state.decisions.filter(d => mayRead(caller, d)), ...nativeRows].filter(d =>
        (!filter || (d.source?.kind !== 'native-item' || d.source.workspaceAttributed) && sameWorkspace(filter, d.origin)) &&
        (input.includeHistory || isActionable(d)) && (!query || (input.includeHistory ? searchText(d)
          : searchText({ ...d, answerState: { state: 'awaiting-answer' } })).includes(query)))
      return order(rows, this.now(), zone)
    })
  }

  listDecisions(caller: Caller, raw: unknown) {
    return result(async () => {
      const rows = await this.queryRows(caller, raw)
      let bytes = 64
      const visible = []
      for (const { description: _description, ...row } of rows) {
        bytes += jsonBytes(row) + 1
        if (bytes > bridgeBudget) return fail('unavailable', 'Use the paged Inbox operation for this result.')
        visible.push(await this.visibleDecision(caller, row))
      }
      return visible
    })
  }

  listDecisionPage(caller: Caller, raw: unknown, nativeRows: readonly Decision[] = []) {
    return result(async (): Promise<DecisionPage> => {
      const cursor = object(raw).cursor
      const rows = await this.queryRows(caller, raw, nativeRows)
      const index = cursor === undefined ? -1 : rows.findIndex(d => d.questionId === id(cursor, 'cursor'))
      if (cursor !== undefined && index < 0) return fail('conflict', 'Inbox page changed. Reload from the first page.')
      const page: Decision[] = []
      let bytes = 1024
      for (const row of rows.slice(index + 1, index + 51)) {
        const next = projectRow(row)
        bytes += jsonBytes(next) + 1
        if (bytes > bridgeBudget) break
        page.push(next)
      }
      const nextCursor = index + 1 + page.length < rows.length ? page.at(-1)?.questionId : undefined
      return { rows: page, ...(nextCursor ? { nextCursor } : {}) }
    })
  }

  getDecision(caller: Caller, raw: unknown) {
    return result(() => this.transaction(async state => {
      const d = await this.visibleDecision(caller, findDecision(state, caller, id(object(raw).questionId, 'questionId')))
      const bytes = jsonBytes(d)
      if (bytes > bridgeBudget) return fail('unavailable', 'Decision exceeds the Inbox detail limit.')
      const metadata = decisionSourceMetadata(d.sourceLinks, d.origin.sessionId)
      // Optional display metadata must not make an existing readable detail fail.
      return bytes + jsonBytes(metadata) <= bridgeBudget ? { ...d, ...metadata } : d
    }))
  }

  getSnapshot(caller: Caller, raw: unknown) {
    return result(() => this.transaction(async state => {
      const input = object(raw)
      const d = findDecision(state, caller, id(input.questionId, 'questionId'))
      const attachmentId = id(input.attachmentId, 'attachmentId')
      const item = d.evidence.find((e): e is Extract<Evidence, {kind: 'image-snapshot'}> => e.kind === 'image-snapshot' && e.attachmentId === attachmentId)
      if (!item) return fail('not-found', 'Snapshot is missing.')
      if (!await this.canReadSnapshot(caller, d, item)) return fail('forbidden', 'Snapshot access was denied.')
      const matches = state.packages.find(p => p.input.packageId === d.packageId)?.grant.snapshots.filter(s => s.attachmentId === attachmentId)
      const stored = matches?.length === 1 ? matches[0] : undefined
      return (stored?.blob ? await this.store.readSnapshot?.(stored.blob) : stored?.image) ?? fail('not-found', 'Snapshot is missing.')
    }))
  }

  private async checkNotes(state: State, caller: Caller, d: Decision, notes: Annotation[], checkDestination = true) {
    const pack = state.packages.find(p => p.input.packageId === d.packageId)
    if (!notes.length) return
    const source = pack && { kind: 'agent' as const, id: pack.sourceId, origin: d.origin }
    for (const note of notes) {
      const ref = note.kind === 'image' ? note.evidence : note.anchor.kind === 'evidence' ? note.anchor.evidence : undefined
      const item = d.evidence.find(e => e.evidenceId === ref?.evidenceId && e.version === ref.version)
      if (item?.kind !== 'image-snapshot') continue
      if (!await this.canReadSnapshot(caller, d, item)) return fail('forbidden', 'The annotated snapshot is inaccessible.')
      if (checkDestination && (!source || !await this.canReadSnapshot(source, d, item))) {
        return fail('forbidden', 'The destination cannot read the annotated snapshot.')
      }
    }
    validateNotes(notes, d, (id, version) =>
      pack?.grant.evidenceText?.find(e => e.evidenceId === id && e.version === version)?.text)
  }

  submitReply(caller: Caller, raw: unknown) {
    return result(async () => {
      const author = owner(caller)
      const input = reply(raw)
      const accepted = await this.transaction(async (state, commit) => {
        const d = findDecision(state, author, input.questionId)
        const previous = state.replies.find(r => r.input.replyId === input.replyId)
        if (previous) {
          if (previous.ownerId !== author.id || JSON.stringify(previous.input) !== JSON.stringify(input)) {
            return fail('conflict', 'Reply ID already has a different answer or binding.')
          }
          if (previous.acceptedId !== input.replyId) await this.checkNotes(state, author, d, input.annotations)
          return { id: previous.acceptedId, isNew: false }
        }
        if (input.kind === 'follow-up' && d.answerState.state !== 'answered') {
          return fail('conflict', 'A follow-up requires an accepted initial answer.')
        }
        if (input.answer.kind === 'option') {
          const { optionId } = input.answer
          requireInput(d.options.some(o => o.optionId === optionId), 'Selected option does not exist.')
        }
        await this.checkNotes(state, caller, d, input.annotations)
        if (input.kind === 'initial' && d.answerState.state === 'answered') {
          const id = d.answerState.initial.replyId
          state.replies.push({ ownerId: author.id, input, acceptedId: id })
          commit()
          return { id, isNew: false }
        }
        const recorded: RecordedReply = { ...input, acceptedAt: new Date(this.now()).toISOString(), delivery: { state: 'submitted' } }
        if (d.answerState.state === 'answered') d.answerState.followUps.push(recorded)
        else d.answerState = { state: 'answered', initial: recorded, followUps: [] }
        checkDetailBudget(d)
        state.replies.push({ ownerId: author.id, input, acceptedId: input.replyId })
        state.outbox.push({ questionId: d.questionId, replyId: input.replyId })
        commit()
        return { id: input.replyId, isNew: true }
      })
      if (accepted.isNew) await this.deliver(author, input.questionId, accepted.id)
      return this.readReply(author, input.questionId, accepted.id)
    })
  }

  private readReply(caller: Caller, questionId: string, replyId: string) {
    return this.transaction(async state => thread(await this.visibleDecision(caller, findDecision(state, caller, questionId))).find(r => r.replyId === replyId)
      ?? fail('not-found', 'Reply is missing.'))
  }

  retryReply(caller: Caller, raw: unknown) {
    return result(async () => {
      const author = owner(caller)
      const input = object(raw)
      const questionId = id(input.questionId, 'questionId')
      const replyId = id(input.replyId, 'replyId')
      const shouldRetry = await this.transaction(async state => {
        const d = findDecision(state, author, questionId)
        const current = thread(d).find(r => r.replyId === replyId) ?? fail('not-found', 'Reply is missing.')
        if (current.delivery.state === 'agent-received') return false
        await this.checkNotes(state, author, d, current.annotations)
        return true
      })
      if (shouldRetry) await this.deliver(author, questionId, replyId)
      return this.readReply(author, questionId, replyId)
    })
  }

  private deliver(author: OwnerCaller, questionId: string, replyId: string): Promise<void> {
    const running = this.inFlight.get(replyId)
    if (running) return running
    const delivery = this.deliverOnce(author, questionId, replyId).finally(() => this.inFlight.delete(replyId))
    this.inFlight.set(replyId, delivery)
    return delivery
  }

  private async deliverOnce(author: OwnerCaller, questionId: string, replyId: string) {
    const target = await this.transaction(async (state, commit) => {
      const d = findDecision(state, author, questionId)
      const r = thread(d).find(r => r.replyId === replyId)!
      if (r.delivery.state === 'agent-received') return
      try {
        await this.checkNotes(state, author, d, r.annotations)
      } catch {
        // The answer was already accepted. A grant change before delivery leaves
        // its original payload intact and creates a visible failed attempt.
        r.delivery = reason('delivery-failed')
        state.outbox = state.outbox.filter(entry => entry.replyId !== replyId)
        commit()
        return
      }
      if (!state.outbox.some(entry => entry.replyId === replyId)) {
        state.outbox.push({ questionId, replyId })
        commit()
      }
      return { origin: d.origin, reply: reply(r) }
    })
    if (!target) return
    let outcome: SendOutcome
    try {
      outcome = await this.boundary.send(target)
      if (typeof outcome === 'object') outcome = { messageId: id(outcome.messageId, 'mail message ID') }
    }
    catch { outcome = 'delivery-failed' }
    await this.transaction((state, commit) => {
      const r = thread(state.decisions.find(d => d.questionId === questionId)!).find(r => r.replyId === replyId)!
      if (r.delivery.state !== 'agent-received') {
        r.delivery = typeof outcome === 'object'
          ? { state: 'submitted', transport: { messageId: outcome.messageId, acceptedAt: new Date(this.now()).toISOString() } }
          : reason(outcome)
        state.outbox = state.outbox.filter(entry => entry.replyId !== replyId)
        commit()
      }
    })
  }

  // An interrupted attempt has an unknown outcome. Surface it for explicit same-ID
  // recovery, rather than redriving the send during startup or replaying a submit.
  recoverInterruptedDelivery() {
    return result(() => this.transaction((state, commit) => {
      if (state.outbox.length === 0) return null
      for (const { questionId, replyId } of state.outbox) {
        const d = state.decisions.find(d => d.questionId === questionId)
        const r = d && thread(d).find(r => r.replyId === replyId)
        if (r && r.delivery.state === 'submitted') r.delivery = reason('delivery-failed')
      }
      state.outbox = []
      commit()
      return null
    }))
  }

  acknowledgeReply(caller: Caller, raw: unknown) {
    return result(() => {
      const source = agent(caller)
      const input = object(raw)
      const proof = { questionId: id(input.questionId, 'questionId'), replyId: id(input.replyId, 'replyId'),
        receiptId: id(input.receiptId, 'receiptId') }
      return this.transaction(async (state, commit) => {
        const d = findDecision(state, source, proof.questionId)
        if (!sameOrigin(source.origin, d.origin) || !state.packages.some(p => p.input.packageId === d.packageId && p.sourceId === source.id)) return fail('forbidden', 'Receipt must come from the original Chat.')
        const r = thread(d).find(r => r.replyId === proof.replyId)
        if (!r) return fail('not-found', 'Reply is missing.')
        if (r.delivery.state === 'agent-received') {
          if (r.delivery.receipt.receiptId !== proof.receiptId) return fail('conflict', 'Reply already has a different receipt.')
        } else {
          if (state.decisions.some(d => thread(d).some(r => r.delivery.state === 'agent-received' &&
            r.delivery.receipt.receiptId === proof.receiptId))) return fail('conflict', 'Receipt ID is already in use.')
          if (!await this.boundary.verifyReceipt(source, proof)) return fail('forbidden', 'Original Chat receipt could not be verified.')
          r.delivery = { state: 'agent-received', receipt: { ...proof, origin: d.origin, receivedAt: new Date(this.now()).toISOString() } }
          state.outbox = state.outbox.filter(entry => entry.replyId !== r.replyId)
          commit()
        }
        return thread(await this.visibleDecision(source, d)).find(r => r.replyId === proof.replyId)!
      })
    })
  }

  getDraft(caller: Caller, raw: unknown) {
    return result(() => this.transaction(async state => {
      const questionId = id(object(raw).questionId, 'questionId')
      const author = owner(caller)
      const d = findDecision(state, author, questionId)
      const record = state.drafts.find(d => d.ownerId === author.id && d.questionId === questionId)
      const evidence = record?.value ? (await this.visibleDecision(author, d)).evidence : []
      return { revision: record?.revision ?? 0, draft: record?.value ? {
        ...record.value, annotations: record.value.annotations.filter(note => visibleNote(evidence, note))
      } : null }
    }))
  }

  saveDraft(caller: Caller, raw: unknown) {
    return result(() => this.transaction(async (state, commit) => {
      const input = object(raw)
      const author = owner(caller)
      const questionId = id(input.questionId, 'questionId')
      const d = findDecision(state, author, questionId)
      const prior = state.drafts.findIndex(d => d.ownerId === author.id && d.questionId === questionId)
      const revision = state.drafts[prior]?.revision ?? 0
      requireInput(typeof input.revision === 'number' && Number.isSafeInteger(input.revision) && input.revision >= 0, 'Invalid draft revision.')
      if (input.revision !== revision) return fail('conflict', 'Draft changed. Reload before saving.')
      let value: ReplyDraft | null = null
      if (input.draft !== null) {
        const draft = object(input.draft)
        const kind = draft.kind
        requireInput(kind === undefined || kind === 'initial' || kind === 'follow-up', 'Invalid draft kind.')
        const optionId = draft.optionId === undefined ? undefined : id(draft.optionId, 'optionId')
        requireInput(optionId === undefined || d.options.some(o => o.optionId === optionId), 'Selected option does not exist.')
        value = { text: string(draft.text, 'draft text', true), annotations: annotations(draft.annotations, true),
          ...(kind === undefined ? {} : { kind }), ...(optionId === undefined ? {} : { optionId }),
          ...(draft.replyId === undefined ? {} : { replyId: id(draft.replyId, 'replyId') }) }
        if (value.annotations.length) await this.checkNotes(state, caller, d, value.annotations, false)
      }
      if (jsonBytes(value) > bridgeBudget) return fail('invalid', 'Draft exceeds the Inbox size limit.')
      if (JSON.stringify(value) === JSON.stringify(state.drafts[prior]?.value ?? null)) return { draft: value, revision }
      if (prior >= 0) state.drafts.splice(prior, 1)
      state.drafts.push({ ownerId: author.id, questionId, value, revision: revision + 1 })
      commit()
      return { draft: value, revision: revision + 1 }
    }))
  }

  getSettings(caller: Caller) {
    return result(() => this.transaction(state => {
      const author = owner(caller)
      const settings = state.settings.find(s => s.ownerId === author.id)?.value ?? initialSettings()
      return { ...settings, exceptions: settings.exceptions.filter(e => author.repos.includes(e.repo)) }
    }))
  }

  saveSettings(caller: Caller, raw: unknown) {
    return result(() => this.transaction((state, commit) => {
      const author = owner(caller)
      const input = object(raw)
      const prior = state.settings.find(s => s.ownerId === author.id)
      const revision = prior?.value.revision ?? 0
      if (input.revision !== revision) return fail('conflict', 'Settings changed. Reload before saving.')
      const exceptions = list(input.exceptions, 'exceptions').map(entry => {
        const exception = object(entry)
        const repo = id(exception.repo, 'repo')
        if (!author.repos.includes(repo)) return fail('forbidden', 'Repo policy is outside owner scope.')
        return { repo, template: string(exception.template, 'exception template') }
      })
      requireInput(new Set(exceptions.map(e => e.repo)).size === exceptions.length, 'Duplicate repo exception.')
      const value = { revision: revision + 1, defaultTemplate: string(input.defaultTemplate, 'default template'), exceptions }
      if (prior) {
        const other = prior.value.exceptions.filter(e => !author.repos.includes(e.repo))
        prior.value = { ...value, exceptions: [...exceptions, ...other] }
      } else state.settings.push({ ownerId: author.id, value })
      commit()
      return value
    }))
  }

  effectivePolicy(caller: Caller, raw: unknown) {
    return result(() => this.transaction(state => {
      const repo = id(object(raw).repo, 'repo')
      if (caller.kind === 'owner' ? !caller.repos.includes(repo) : caller.repo !== repo) {
        return fail('forbidden', 'Repo policy is outside caller scope.')
      }
      const ownerId = caller.kind === 'owner' ? caller.id : caller.policyOwnerId
      const settings = state.settings.find(s => s.ownerId === ownerId)?.value ?? initialSettings()
      const exception = settings.exceptions.find(e => e.repo === repo)
      return exception ? { source: 'exception' as const, template: exception.template }
        : { source: 'default' as const, template: settings.defaultTemplate }
    }))
  }
}
