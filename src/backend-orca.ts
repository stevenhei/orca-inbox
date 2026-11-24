import type { OrcaWorkerApi, PanelRequestContext } from 'orca/worker'
import type { AgentCaller, InboxBackend, InboxBoundary } from './backend.ts'
import type { OwnerCaller, SourceAvailability } from './backend-protocol.ts'
import type { AcknowledgeReply, Decision, Priority } from './contract.ts'
import { hintPattern } from './backend-local.mjs'
import { InboxError, submission } from './backend-validation.ts'

type Cli = (args: string[]) => Promise<unknown>
type RecordValue = Record<string, unknown>
const record = (x: unknown): RecordValue => x && typeof x === 'object' && !Array.isArray(x) ? x as RecordValue : {}
const array = (x: unknown) => Array.isArray(x) ? x.map(record) : []
const text = (x: unknown, size = 4096) => typeof x === 'string' ? x.slice(0, size) : ''
const activityId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const marker = 'ORCA-INBOX-V1 '
export const nativePrefix = 'bot-item:'
const localOwner = 'decision-inbox-local-desktop'
const unavailable = (message: string) => new InboxError('unavailable', message)

export async function desktopOwner(orca: OrcaWorkerApi, context: PanelRequestContext): Promise<OwnerCaller> {
  const { id, surface, contributionId } = context.panel
  if (context.signal.aborted || !id || id === 'orca-cli' ||
    !(surface === 'panel' && contributionId === 'inbox' || surface === 'editor' && contributionId === 'review')) {
    throw new InboxError('forbidden', 'Use the Decision Inbox desktop panel or editor.')
  }
  const { workspaces } = await orca.host.call('workspace.list')
  const local = workspaces.filter(w => w.hostId === 'local' || w.hostId === null)
    .filter((w, _, all) => all.filter(other => other.id === w.id).length === 1)
  return { kind: 'owner', id: localOwner, workspaces: local.map(w => ({ hostId: 'local', workspaceId: w.id })),
    repos: [...new Set(local.flatMap(w => w.projectId ? [w.projectId] : []))] }
}

export function localInboxBoundary(cli: Cli): InboxBoundary {
  return {
    async grantSubmission(caller, input) {
      if (caller.origin.hostId !== 'local' || caller.policyOwnerId !== localOwner ||
        input.evidence.some(item => item.kind === 'image-snapshot')) {
        throw new InboxError('forbidden', 'This Chat path supports link evidence. Private snapshot upload is unavailable.')
      }
      return { participantIds: [caller.id, localOwner], snapshots: [] }
    },
    async canReadSnapshot() { return false },
    async send({ origin }) {
      // Orca 1.4.271 has no approved plugin sender. Verify the recorded destination
      // for useful status without calling mail with another principal's identity.
      try {
        if (origin.hostId !== 'local') return 'origin-mismatch'
        const response = record(await cli(['agent', 'show', 'orca_session_id:' + origin.sessionId]))
        if (response.kind !== 'chat' || response.orcaSessionId !== origin.sessionId) return 'origin-mismatch'
        const places = array(response.places)
        if (!places.length) return 'closed-origin'
        if (places.length !== 1 || !placeMatches(places[0], origin.sessionId, origin.workspaceId)) return 'origin-mismatch'
      } catch {
        return 'disconnected'
      }
      return 'delivery-failed'
    },
    async verifyReceipt(caller, input) {
      try {
        return Boolean(await findChatRecord(cli, caller.origin.sessionId, 'ack', input.receiptId, input))
      } catch {
        return false
      }
    }
  }
}

function placeMatches(place: RecordValue, session: string, workspace: string) {
  return place.kind === 'chat' && place.orcaSessionId === session && place.worktreeId === workspace &&
    place.hostId === 'local' && (place.agent === 'claude' || place.agent === 'codex')
}

async function findChatRecord(cli: Cli, session: string, op: string, lookupId: string, ack?: AcknowledgeReply) {
  const history = record(await cli(['agent', 'read', 'orca_session_id:' + session, '--limit', '20']))
  if (history.kind !== 'chat' || history.source !== 'chat' || history.orcaSessionId !== session || history.state !== 'done') return
  const entries = array(history.entries)
  const entry = entries.at(-1)
  // This CLI reports a bounded suffix and no turn ID. Require the latest user
  // boundary and final assistant message in that suffix. Older turns cannot
  // satisfy a hint, even when their markers have the same request ID.
  if (!entries.some(item => item.kind === 'message' && item.role === 'user') ||
    entry?.kind !== 'message' || entry.role !== 'assistant' || typeof entry.text !== 'string' ||
    entry.text.length > 32_768 || entry.shortened === true) return
  const matches = new Map<string, RecordValue>()
  for (const line of entry.text.split(/\r?\n/)) {
    if (!line.startsWith(marker)) continue
    try {
      const parsed = record(JSON.parse(line.slice(marker.length)))
      const input = record(parsed.input)
      if (parsed.op !== op || (op === 'submit' ? input.requestId : input.receiptId) !== lookupId) continue
      if (ack && (input.questionId !== ack.questionId || input.replyId !== ack.replyId)) continue
      const canonical = op === 'submit' ? submission(input) : input
      matches.set(JSON.stringify(canonical), canonical as unknown as RecordValue)
    } catch { /* An incomplete or invalid record cannot authorize an operation. */ }
  }
  if (matches.size === 1) return matches.values().next().value
}

export async function processChatHint(cli: Cli, backend: InboxBackend, owner: OwnerCaller, name: string): Promise<boolean> {
  const hint = hintPattern.exec(name)
  if (!hint) return false
  const [, op, session, lookupId] = hint
  const shown = record(await cli(['agent', 'show', 'orca_session_id:' + session]))
  const places = array(shown.places)
  const place = places[0]
  if (shown.kind !== 'chat' || shown.orcaSessionId !== session || places.length !== 1 ||
    !owner.workspaces.some(w => w.hostId === 'local' && w.workspaceId === place.worktreeId &&
      placeMatches(place, session, w.workspaceId))) return false
  const input = await findChatRecord(cli, session, op, lookupId)
  if (!input) return false
  const caller: AgentCaller = { kind: 'agent', id: session, origin: {
    hostId: 'local', workspaceId: String(place.worktreeId), sessionId: session
  }, projectName: text(place.repo), workspaceName: text(place.workspace), repo: text(place.repo), policyOwnerId: localOwner }
  if (op === 'submit') {
    if (submission(input).questions.some(q => q.questionId.startsWith(nativePrefix))) return false
    return (await backend.submitDecision(caller, input)).ok
  }
  // A transcript statement can confirm an actual submitted mail only. A locally
  // saved or failed reply cannot be promoted by a prewritten acknowledgement.
  const decision = await backend.getDecision(caller, input)
  if (!decision.ok || decision.value.answerState.state !== 'answered') return false
  const { initial, followUps } = decision.value.answerState
  const reply = [initial, ...followUps].find(r => r.replyId === input.replyId)
  if (reply?.delivery.state !== 'submitted' || !reply.delivery.transport) return false
  return (await backend.acknowledgeReply(caller, input)).ok
}

function metadata(description: string) {
  const match = /^ORCA-DECISION-META (\{.{0,2048}\})$/m.exec(description)
  let fields: RecordValue = {}
  try { if (match) fields = record(JSON.parse(match[1])) } catch { /* Plain Items remain readable. */ }
  const priority: Priority = fields.priority === 'P0' || fields.priority === 'P1' || fields.priority === 'P3' ? fields.priority : 'P2'
  const deadline = text(fields.deadline, 128)
  return { priority, ...(deadline && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(deadline) && Number.isFinite(Date.parse(deadline))
    ? { deadline } : {}), blockedWork: Array.isArray(fields.blockedWork)
    ? fields.blockedWork.slice(0, 12).map(item => text(item, 512)).filter(Boolean) : [] }
}

function itemRows(item: RecordValue): Decision[] {
  const uid = text(item.uid, 97)
  const title = text(item.title)
  const rawStatus = text(item.status, 64)
  const status = rawStatus === 'needs_you' ? 'needs-you' : rawStatus === 'in_progress' ? 'in-progress' : rawStatus
  if (uid.length > 96 || !activityId.test(uid) || !title || !status) return []
  const ask = record(item.question)
  const eventId = text(ask.eventId, 65)
  const event = eventId.length <= 64 && activityId.test(eventId) ? eventId : 'item'
  const asks = array(ask.decisions).slice(0, 5)
  const owner = record(item.owner)
  const botName = text(owner.name, 256)
  const itemLabel = typeof item.number === 'number' && Number.isSafeInteger(item.number) ? '#' + item.number : uid
  const observedAt = new Date().toISOString()
  const created = typeof item.createdAt === 'number' ? new Date(item.createdAt) : new Date(0)
  const description = text(item.description, 16_384)
  return (asks.length ? asks : [{}]).map((question, index) => {
    const options = array(question.replies).slice(0, 8)
    const questionId = nativePrefix + uid + ':' + event + ':' + index
    return {
      questionId, packageId: nativePrefix + uid, requestId: nativePrefix + uid, revision: 1,
      title: text(question.question) || title,
      background: [asks.length ? title : '', description, text(ask.text, 16_384)].filter(Boolean).join('\n\n'),
      recommendation: text(options.find(option => option.recommended === true)?.label),
      options: options.map((option, i) => ({ optionId: String(i), label: text(option.label), detail: text(option.detail) })),
      ...metadata(description), origin: { hostId: 'local', workspaceId: '', sessionId: '' },
      projectName: botName, workspaceName: '', createdAt: Number.isFinite(+created) ? created.toISOString() : new Date(0).toISOString(),
      access: { participantIds: [], attachmentReaderIds: {} }, decisionLink: '', sourceLinks: [], evidence: [],
      answerState: { state: 'awaiting-answer' }, actions: [],
      source: { kind: 'native-item', workspaceAttributed: false, botName, itemLabel, itemStatus: status, observedAt }
    }
  })
}

export async function nativePage(cli: Cli): Promise<{ rows: Decision[]; source: SourceAvailability }> {
  const source: SourceAvailability = { source: 'native-item', state: 'available' }
  try {
    const response = record(await cli(['bot', 'list']))
    if (!Array.isArray(response.bots)) throw unavailable('Bot list is unavailable.')
    const bots = array(response.bots)
    const ids = bots.filter(bot => !bot.server).map(b => text(b.id, 129)).filter(id => activityId.test(id))
    let partial = ids.length !== bots.length || ids.length > 4 || Boolean(Array.isArray(response.unreachable) && response.unreachable.length)
    const pages = await Promise.allSettled(ids.slice(0, 4).map(id => cli(['bot', 'item', 'list', '--bot', id, '--all', '--limit', '50'])))
    const rows = pages.flatMap(page => {
      if (page.status === 'rejected') { partial = true; return [] }
      const data = record(page.value)
      if (!Array.isArray(data.items) || data.nextCursor || data.nextClosedCursor) partial = true
      return array(data.items).flatMap(itemRows)
    })
    if (pages.length && pages.every(page => page.status === 'rejected')) throw unavailable('Bot Item reads are unavailable.')
    if (partial) return { rows, source: { ...source, state: 'partial', message: 'Only the first authorized local Item pages are shown.' } }
    return { rows, source }
  } catch {
    return { rows: [], source: { ...source, state: 'unavailable', message: 'Authorized Orca Bot Item reads are unavailable on this host.' } }
  }
}

export async function nativeDetail(cli: Cli, questionId: string): Promise<Decision> {
  const [, uid, event, index, extra] = questionId.split(':')
  if (!activityId.test(uid ?? '') || !activityId.test(event ?? '') || !/^[0-4]$/.test(index ?? '') || extra !== undefined) {
    throw new InboxError('not-found', 'Bot Item is missing or inaccessible.')
  }
  const page = await nativePage(cli)
  if (page.source.state === 'unavailable') throw unavailable(page.source.message!)
  if (!page.rows.some(row => row.questionId === questionId)) throw new InboxError('not-found', 'Bot Item is missing or inaccessible.')
  const result = record(await cli(['bot', 'item', 'show', uid]))
  const row = itemRows(record(result.item)).find(d => d.questionId === questionId)
  if (!row) throw new InboxError('not-found', 'Bot Item changed. Refresh the Inbox.')
  return row
}
