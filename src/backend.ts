import type { AcknowledgeReply, Annotation, Decision, Delivery, Origin, RecordedReply, Result, SubmitDecision, SubmitReply, Workspace } from './contract.ts'
import type { InboxSettings, OwnerCaller, PrivateSnapshot, ReplyDraft } from './backend-protocol.ts'
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
export type SubmissionGrant = {
  participantIds: string[]
  snapshots: { attachmentId: string; readerIds: string[]; image: PrivateSnapshot }[]
  evidenceText?: { evidenceId: string; version: number; text: string }[]
}

export interface DeliveryTarget {
  origin: Origin
  reply: SubmitReply
}

export type SendOutcome = 'submitted' | Extract<Delivery, {state: 'undelivered'}>['reason']

export interface InboxBoundary {
  // Methods are implemented at a trusted host boundary. Submission grants must verify
  // participation, attachment identity/version and readers against the authenticated origin.
  grantSubmission(caller: AgentCaller, input: SubmitDecision): Promise<SubmissionGrant>
  // Validate that the receiving session is still authorized. Use replyId as a durable
  // idempotency key at the destination. Storage receipts return only 'submitted'.
  send(target: DeliveryTarget): Promise<SendOutcome>
  // Validate proof of receipt in the original Chat, independently of panel input or mail.
  verifyReceipt(caller: AgentCaller, input: AcknowledgeReply): Promise<boolean>
}

export interface InboxStorage {
  read(): Promise<unknown>
  write(state: State): Promise<void>
}

interface State {
  version: 1
  packages: { origin: Origin; sourceId: string; input: SubmitDecision; grant: SubmissionGrant }[]
  decisions: Decision[]
  replies: { ownerId: string; input: SubmitReply; acceptedId: string }[]
  outbox: { questionId: string; replyId: string }[]
  settings: { ownerId: string; value: InboxSettings }[]
  drafts: { ownerId: string; questionId: string; value: ReplyDraft }[]
}

type Options = {
  now?: () => number
  timeZone?: string
  changed?: () => void
}

const fresh = (): State => ({ version: 1, decisions: [], packages: [], replies: [], outbox: [], settings: [], drafts: [] })
const reason = (state: SendOutcome): Delivery => state === 'submitted' ? { state } : { state: 'undelivered', reason: state }
const sameWorkspace = (a: Workspace, b: Workspace) => a.hostId === b.hostId && a.workspaceId === b.workspaceId
const sameOrigin = (a: Origin, b: Origin) => sameWorkspace(a, b) && a.sessionId === b.sessionId
const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const fail = (code: InboxErrorCode, message: string): never => { throw new InboxError(code, message) }
const thread = (d: Decision) => d.answerState.state === 'answered' ? [d.answerState.initial, ...d.answerState.followUps] : []
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

function mayRead(caller: Caller, decision: Decision): boolean {
  return decision.access.participantIds.includes(caller.id) && (caller.kind === 'owner'
    ? caller.workspaces.some(workspace => sameWorkspace(workspace, decision.origin))
    : sameWorkspace(caller.origin, decision.origin))
}

function findDecision(state: State, caller: Caller, questionId: string): Decision {
  const found = state.decisions.find(d => d.questionId === questionId && mayRead(caller, d))
  if (!found) return fail('not-found', 'Decision is missing or inaccessible.')
  return found
}

function mayReadAttachment(caller: Caller, decision: Decision, attachmentId: string) {
  return Object.hasOwn(decision.access.attachmentReaderIds, attachmentId) &&
    decision.access.attachmentReaderIds[attachmentId].includes(caller.id)
}

function visibleDecision(caller: Caller, decision: Decision): Decision {
  const evidence = decision.evidence.filter(e => e.kind !== 'image-snapshot' || mayReadAttachment(caller, decision, e.attachmentId))
  const canSeeNote = (note: Annotation) => {
    if (note.kind === 'selection' && note.anchor.kind === 'question') return true
    const ref = note.kind === 'image' ? note.evidence : note.anchor.kind === 'evidence' ? note.anchor.evidence : undefined
    return evidence.some(e => e.evidenceId === ref?.evidenceId && e.version === ref?.version)
  }
  const visibleReply = (r: RecordedReply) => ({ ...r, annotations: r.annotations.filter(canSeeNote) })
  const answerState = decision.answerState.state === 'answered'
    ? { ...decision.answerState, initial: visibleReply(decision.answerState.initial), followUps: decision.answerState.followUps.map(visibleReply) }
    : decision.answerState
  return { ...decision, evidence, answerState, access: {
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
          return state.decisions.filter(d => d.packageId === input.packageId && mayRead(source, d)).map(d => visibleDecision(source, d))
        }
        if (state.packages.some(p => p.input.packageId === input.packageId) ||
          input.questions.some(q => state.decisions.some(d => q.questionId === d.questionId))) {
          return fail('conflict', 'Package or question ID is already in use.')
        }
        const grant = await this.boundary.grantSubmission(source, input)
        if (!grant.participantIds.includes(source.id) || !grant.participantIds.includes(source.policyOwnerId)) {
          return fail('forbidden', 'The submitting Chat and owner must be verified participants.')
        }
        const attachmentReaderIds = Object.fromEntries(input.evidence.flatMap(e => {
          if (e.kind !== 'image-snapshot') return []
          const snapshot = grant.snapshots.find(s => s.attachmentId === e.attachmentId)
          if (!snapshot || !snapshot.readerIds.includes(source.id) ||
            snapshot.readerIds.some(reader => !grant.participantIds.includes(reader))) {
            return fail('forbidden', 'The attachment was not verified for this Chat.')
          }
          requireInput(['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(snapshot.image.mimeType) &&
            snapshot.image.base64.length <= 900_000 && snapshot.image.base64.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(snapshot.image.base64) &&
            snapshot.image.base64.length > 0, 'Unsupported or oversized image snapshot.')
          return [[e.attachmentId, snapshot.readerIds]]
        }))
        const createdAt = new Date(this.now()).toISOString()
        const decisions = input.questions.map((q): Decision => ({
          ...q, revision: 1, requestId: input.requestId, packageId: input.packageId,
          ...(input.summary === undefined ? {} : { packageSummary: input.summary }),
          origin: source.origin, projectName: source.projectName, workspaceName: source.workspaceName,
          access: { participantIds: grant.participantIds, attachmentReaderIds }, createdAt,
          decisionLink: `orca-inbox:question/${encodeURIComponent(q.questionId)}`,
          sourceLinks: input.sourceLinks, evidence: input.evidence, answerState: { state: 'awaiting-answer' }
        }))
        state.decisions.push(...decisions)
        state.packages.push({ origin: source.origin, sourceId: source.id, input, grant: {
          ...grant, snapshots: grant.snapshots.filter(s => Object.hasOwn(attachmentReaderIds, s.attachmentId))
        } })
        commit()
        return decisions.map(d => visibleDecision(source, d))
      })
    })
  }

  listDecisions(caller: Caller, raw: unknown) {
    return result(() => {
      const input = object(raw)
      const scope = object(input.scope)
      requireInput(scope.kind === 'all' || scope.kind === 'workspace', 'Invalid scope kind.')
      requireInput(typeof input.includeHistory === 'boolean', 'Expected includeHistory.')
      const workspace = scope.kind === 'workspace' ? object(scope.workspace) : null
      const filter = workspace && { hostId: id(workspace.hostId, 'hostId'), workspaceId: id(workspace.workspaceId, 'workspaceId') }
      const query = input.query === undefined ? '' : string(input.query, 'query', true).trim().toLocaleLowerCase()
      return this.transaction(state => {
        const now = this.now()
        const candidates = state.decisions.filter(d => mayRead(caller, d) && (!filter || sameWorkspace(filter, d.origin)) &&
          (input.includeHistory || isActionable(d)))
        const rows = candidates.map(d => visibleDecision(caller, d)).filter(d => !query || (input.includeHistory
          ? searchText(d) : searchText({ ...d, answerState: { state: 'awaiting-answer' } })).includes(query))
        return order(rows, now, this.timeZone)
      })
    })
  }

  getDecision(caller: Caller, raw: unknown) {
    return result(() => this.transaction(state => visibleDecision(caller, findDecision(state, caller, id(object(raw).questionId, 'questionId')))))
  }

  getSnapshot(caller: Caller, raw: unknown) {
    return result(() => this.transaction(state => {
      const input = object(raw)
      const d = findDecision(state, caller, id(input.questionId, 'questionId'))
      const attachmentId = id(input.attachmentId, 'attachmentId')
      if (!d.evidence.some(e => e.kind === 'image-snapshot' && e.attachmentId === attachmentId)) {
        return fail('not-found', 'Snapshot is missing.')
      }
      if (!mayReadAttachment(caller, d, attachmentId)) return fail('forbidden', 'Snapshot access was denied.')
      return state.packages.find(p => p.input.packageId === d.packageId)?.grant.snapshots
        .find(s => s.attachmentId === attachmentId)?.image ?? fail('not-found', 'Snapshot is missing.')
    }))
  }

  private checkNotes(state: State, caller: Caller, d: Decision, notes: Annotation[]) {
    const evidence = state.packages.find(p => p.input.packageId === d.packageId)?.grant.evidenceText
    validateNotes(notes, visibleDecision(caller, d), (id, version) =>
      evidence?.find(e => e.evidenceId === id && e.version === version)?.text)
    const refs = notes.flatMap(note => note.kind === 'image' ? [note.evidence] :
      note.anchor.kind === 'evidence' ? [note.anchor.evidence] : [])
    for (const ref of refs) {
      const item = d.evidence.find(e => e.evidenceId === ref.evidenceId && e.version === ref.version)
      if (item?.kind === 'image-snapshot') {
        const sourceId = state.packages.find(p => p.input.packageId === d.packageId)?.sourceId
        if (!sourceId || !d.access.attachmentReaderIds[item.attachmentId]?.includes(sourceId)) {
          return fail('forbidden', 'The destination cannot read the annotated snapshot.')
        }
      }
    }
  }

  submitReply(caller: Caller, raw: unknown) {
    return result(async () => {
      const author = owner(caller)
      const input = reply(raw)
      const accepted = await this.transaction((state, commit) => {
        const d = findDecision(state, author, input.questionId)
        const previous = state.replies.find(r => r.input.replyId === input.replyId)
        if (previous) {
          if (previous.ownerId !== author.id || JSON.stringify(previous.input) !== JSON.stringify(input)) {
            return fail('conflict', 'Reply ID already has a different answer or binding.')
          }
          return { id: previous.acceptedId, isNew: false }
        }
        if (input.kind === 'initial' && d.answerState.state === 'answered') {
          const id = d.answerState.initial.replyId
          state.replies.push({ ownerId: author.id, input, acceptedId: id })
          commit()
          return { id, isNew: false }
        }
        if (input.kind === 'follow-up' && d.answerState.state !== 'answered') {
          return fail('conflict', 'A follow-up requires an accepted initial answer.')
        }
        if (input.answer.kind === 'option') {
          const { optionId } = input.answer
          requireInput(d.options.some(o => o.optionId === optionId), 'Selected option does not exist.')
        }
        this.checkNotes(state, caller, d, input.annotations)
        const recorded: RecordedReply = { ...input, acceptedAt: new Date(this.now()).toISOString(), delivery: { state: 'submitted' } }
        if (d.answerState.state === 'answered') d.answerState.followUps.push(recorded)
        else d.answerState = { state: 'answered', initial: recorded, followUps: [] }
        state.replies.push({ ownerId: author.id, input, acceptedId: input.replyId })
        state.outbox.push({ questionId: d.questionId, replyId: input.replyId })
        commit()
        return { id: input.replyId, isNew: true }
      })
      if (accepted.isNew) await this.deliver(input.questionId, accepted.id)
      return this.readReply(author, input.questionId, accepted.id)
    })
  }

  private readReply(caller: Caller, questionId: string, replyId: string) {
    return this.transaction(state => thread(visibleDecision(caller, findDecision(state, caller, questionId))).find(r => r.replyId === replyId)
      ?? fail('not-found', 'Reply is missing.'))
  }

  retryReply(caller: Caller, raw: unknown) {
    return result(async () => {
      const author = owner(caller)
      const input = object(raw)
      const questionId = id(input.questionId, 'questionId')
      const replyId = id(input.replyId, 'replyId')
      const current = await this.readReply(author, questionId, replyId)
      if (current.delivery.state !== 'agent-received') await this.deliver(questionId, replyId)
      return this.readReply(author, questionId, replyId)
    })
  }

  private deliver(questionId: string, replyId: string): Promise<void> {
    const running = this.inFlight.get(replyId)
    if (running) return running
    const delivery = this.deliverOnce(questionId, replyId).finally(() => this.inFlight.delete(replyId))
    this.inFlight.set(replyId, delivery)
    return delivery
  }

  private async deliverOnce(questionId: string, replyId: string) {
    const target = await this.transaction((state, commit) => {
      const d = state.decisions.find(q => q.questionId === questionId)!
      const r = thread(d).find(r => r.replyId === replyId)!
      if (r.delivery.state === 'agent-received') return
      if (!state.outbox.some(entry => entry.replyId === replyId)) {
        state.outbox.push({ questionId, replyId })
        commit()
      }
      return { origin: d.origin, reply: reply(r) }
    })
    if (!target) return
    let outcome: SendOutcome
    try { outcome = await this.boundary.send(target) }
    catch { outcome = 'delivery-failed' }
    await this.transaction((state, commit) => {
      const r = thread(state.decisions.find(d => d.questionId === questionId)!).find(r => r.replyId === replyId)!
      if (r.delivery.state !== 'agent-received') {
        r.delivery = reason(outcome)
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
          r.delivery = { state: 'agent-received', receipt: { ...proof, origin: source.origin, receivedAt: new Date(this.now()).toISOString() } }
          state.outbox = state.outbox.filter(entry => entry.replyId !== r.replyId)
          commit()
        }
        return thread(visibleDecision(source, d)).find(r => r.replyId === proof.replyId)!
      })
    })
  }

  getDraft(caller: Caller, raw: unknown) {
    return result(() => this.transaction(state => {
      const questionId = id(object(raw).questionId, 'questionId')
      const author = owner(caller)
      findDecision(state, author, questionId)
      return state.drafts.find(d => d.ownerId === author.id && d.questionId === questionId)?.value ?? null
    }))
  }

  saveDraft(caller: Caller, raw: unknown) {
    return result(() => this.transaction((state, commit) => {
      const input = object(raw)
      const author = owner(caller)
      const questionId = id(input.questionId, 'questionId')
      const d = findDecision(state, author, questionId)
      const prior = state.drafts.findIndex(d => d.ownerId === author.id && d.questionId === questionId)
      let value: ReplyDraft | null = null
      if (input.draft !== null) {
        const draft = object(input.draft)
        const kind = draft.kind
        requireInput(kind === undefined || kind === 'initial' || kind === 'follow-up', 'Invalid draft kind.')
        const optionId = draft.optionId === undefined ? undefined : id(draft.optionId, 'optionId')
        requireInput(optionId === undefined || d.options.some(o => o.optionId === optionId), 'Selected option does not exist.')
        value = { text: string(draft.text, 'draft text', true), annotations: annotations(draft.annotations),
          ...(kind === undefined ? {} : { kind }), ...(optionId === undefined ? {} : { optionId }),
          ...(draft.replyId === undefined ? {} : { replyId: id(draft.replyId, 'replyId') }) }
        this.checkNotes(state, caller, d, value.annotations)
      }
      if (JSON.stringify(value) === JSON.stringify(state.drafts[prior]?.value ?? null)) return value
      if (prior >= 0) state.drafts.splice(prior, 1)
      if (value) state.drafts.push({ ownerId: author.id, questionId, value })
      commit()
      return value
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
