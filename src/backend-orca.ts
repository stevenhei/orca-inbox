import type { OrcaWorkerApi, PanelRequestContext } from 'orca/worker'
import { jsonBytes, type AgentCaller, type InboxBackend, type InboxBoundary } from './backend.ts'
import type { OwnerCaller, SourceAvailability } from './backend-protocol.ts'
import type { AcknowledgeReply, Decision, Priority, Workspace } from './contract.ts'
import { hintPattern } from './backend-local.mjs'
import { InboxError, submission } from './backend-validation.ts'

type Cli = (args: string[], environment?: string, runtimeId?: string) => Promise<unknown>
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
  const scoped = workspaces.map(w => ({ ...w, hostId: w.hostId ?? 'local' }))
    .filter((w, _, all) => all.filter(other => other.id === w.id && other.hostId === w.hostId).length === 1)
  const local = scoped.filter(w => w.hostId === 'local')
  return { kind: 'owner', id: localOwner, workspaces: scoped.map(w => ({ hostId: w.hostId, workspaceId: w.id })),
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


type NativeHost = { id: string; label: string; selector?: string; runtimeId?: string }
type NativeItem = { host: NativeHost; botId: string; item: RecordValue }
type NativePage = { rows: Decision[]; source: SourceAvailability; hasPairedCoverage: boolean }
const localHost: NativeHost = { id: 'local', label: 'Local Orca' }
const hostLimit = 4

function timestamp(value: unknown) {
  const date = typeof value === 'number' ? new Date(value) : new Date(NaN)
  return Number.isFinite(+date) ? date.toISOString() : undefined
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return
  try {
    const url = new URL(value)
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) return value
  } catch { /* Keep native references without inventing a URL. */ }
}

function itemRows({ host, botId, item }: NativeItem, origin?: Decision['origin'], events: RecordValue[] = []): Decision[] {
  const uid = text(item.uid, 97)
  const title = text(item.title)
  const rawStatus = text(item.status, 64)
  const status = rawStatus === 'needs_you' ? 'needs-you' : rawStatus === 'in_progress' ? 'in-progress' : rawStatus
  if (uid.length > 96 || !activityId.test(uid) || !title || !status) return []
  const ask = record(item.question)
  const eventId = text(ask.eventId, 65)
  const event = eventId.length <= 64 && activityId.test(eventId) ? eventId : 'item'
  const asks = array(ask.decisions).slice(0, 5)
  const botName = text(record(item.owner).name, 256)
  const itemLabel = typeof item.number === 'number' && Number.isSafeInteger(item.number) ? '#' + item.number : uid
  const description = text(item.description, 16_384)
  const background = description.replace(/^ORCA-DECISION-META \{.{0,2048}\}\r?(?:\n|$)/gm, '')
  const askText = text(ask.text, 16_384)
  const current = events.find(entry => entry.id === event)
  const activity: NonNullable<Decision['activity']> = []
  let activityBytes = 0
  const original = (label: string, value: unknown, when?: unknown) => {
    const body = text(value, 16_384)
    const at = timestamp(when)
    if (!body || activity.length >= 20 || activity.some(entry => entry.text === body)) return
    const entry = { label, text: body, ...(at ? { at } : {}) }
    const bytes = jsonBytes(entry)
    if (activityBytes + bytes <= 256 * 1024) {
      activity.push(entry)
      activityBytes += bytes
    }
  }
  original('Current ask context', record(record(current?.data).ask).context, current?.at)
  original('Original ask', askText, current?.at)
  original('Done means', item.doneMeans)
  for (const entry of events) {
    if (entry.kind === 'commented' && entry.id !== event) original('Comment', record(entry.data).text, entry.at)
  }
  const nativeLinks = array(item.links).slice(0, 20).flatMap(link => {
    const kind = text(link.kind, 64)
    const ref = text(link.ref, 2048)
    const url = safeUrl(link.url) ?? safeUrl(record(link.pr).url) ?? safeUrl(ref)
    return kind && ref ? [{ kind, ref, label: text(link.title, 256) || ref, ...(url ? { url } : {}) }] : []
  })
  const sourceLinks = new Map(nativeLinks.flatMap(link => link.url ? [[link.url, { label: link.label, url: link.url }]] : []))
  for (const match of `${description}\n${askText}`.matchAll(/\[([^\]\r\n]{1,256})\]\((https?:\/\/[^\s)]+)\)/g)) {
    const url = safeUrl(match[2])
    if (url && sourceLinks.size < 20 && !sourceLinks.has(url)) sourceLinks.set(url, { label: match[1], url })
  }
  const packageId = nativePrefix + [encodeURIComponent(host.id), botId, uid, event].join(':')
  if (packageId.length + 2 > 256) return []
  const questions = asks.length ? asks : [{}]
  const questionIds = questions.map((_, index) => packageId + ':' + index)
  return questions.map((question, index) => {
    const options = array(question.replies).slice(0, 8)
    const questionTitle = text(question.question) || title
    return {
      questionId: questionIds[index], packageId, requestId: packageId, revision: 1,
      title: questionTitle, ...(questionTitle !== title ? { context: title } : {}), background,
      ...(activity.length ? { activity } : {}), ...(nativeLinks.length ? { nativeLinks } : {}),
      package: { index, size: questions.length, questionIds },
      recommendation: text(options.find(option => option.recommended === true)?.label),
      options: options.map((option, i) => ({ optionId: String(i), label: text(option.label, 512), detail: text(option.detail, 2048) })),
      ...metadata(description), origin: origin ?? { hostId: host.id, workspaceId: '', sessionId: '' },
      projectName: botName, workspaceName: '', createdAt: timestamp(item.createdAt) ?? new Date(0).toISOString(),
      access: { participantIds: [], attachmentReaderIds: {} }, decisionLink: '', sourceLinks: [...sourceLinks.values()], evidence: [],
      answerState: { state: 'awaiting-answer' }, actions: [],
      source: { kind: 'native-item', workspaceAttributed: Boolean(origin), botName, itemLabel, itemStatus: status, hostLabel: host.label }
    }
  })
}

function hostCommand(cli: Cli, host: NativeHost) {
  return (args: string[]) => cli(args, host.selector, host.runtimeId)
}

function cliProblem(error: unknown) {
  const code = record(error).code
  if (typeof code === 'string' && ['forbidden', 'permission_denied', 'unauthorized', 'not_permitted'].includes(code)) return 'permission denied'
  if (code === 'runtime_mismatch') return 'runtime identity did not match the saved pairing'
  if (code === 'method_not_found' || code === 'unknown_command' || code === 'invalid_argument') return 'Bot Item command unsupported or refused'
  return 'host or CLI unavailable'
}

async function discoverNativeHosts(cli: Cli, requestedHost?: string) {
  const hosts = requestedHost && requestedHost !== 'local' ? [] : [localHost]
  const notes: string[] = []
  if (requestedHost === 'local') return { hosts, notes }
  try {
    const data = record(await cli(['environment', 'list']))
    if (!Array.isArray(data.environments)) throw new Error('No paired inventory')
    const environments = array(data.environments)
    // Older saved environment entries can omit runtimeId. A routed status
    // supplies it without selecting a host by display name or using its token.
    const unresolved = environments.filter(environment => !environment.runtimeId).slice(0, hostLimit)
    const learned = new Map(await Promise.all(unresolved.flatMap(environment => {
      const selector = text(environment.id, 129)
      if (!activityId.test(selector) || selector === 'local') return []
      return [cli(['status'], selector).then(status =>
        [selector, text(record(record(status).runtime).runtimeId, 129)] as const, () => [selector, ''] as const)]
    })))
    const seen = new Set<string>()
    for (const environment of environments) {
      const selector = text(environment.id, 129)
      const runtimeId = text(environment.runtimeId, 129) || learned.get(selector) || ''
      if (!activityId.test(selector) || selector === 'local' || !activityId.test(runtimeId)) {
        if (!requestedHost) notes.push('A saved pairing has no usable runtime identity.')
        continue
      }
      const id = 'runtime:' + runtimeId
      if (seen.has(id) || (requestedHost && requestedHost !== id)) continue
      seen.add(id)
      hosts.push({ id, selector, runtimeId, label: text(environment.name, 96) || 'Paired Orca' })
    }
  } catch {
    notes.push('The local CLI could not read the saved paired-server inventory.')
  }
  if (requestedHost && hosts.length === 0) notes.push('No saved CLI pairing matches the selected workspace host.')
  if (hosts.length > hostLimit) notes.push('Only the first paired hosts within the Inbox host limit are shown.')
  return { hosts: hosts.slice(0, hostLimit), notes }
}

async function nativeOrigins(run: ReturnType<typeof hostCommand>, host: NativeHost, items: NativeItem[], workspaces: readonly Workspace[]) {
  const workspaceIds = new Set(workspaces.filter(w => w.hostId === host.id).map(w => w.workspaceId))
  const candidates = new Set(items.flatMap(({ item }) => {
    const chat = record(item.chat)
    return chat.kind === 'chat' && activityId.test(text(chat.id, 129)) ? [String(chat.id)] : []
  }))
  const origins = new Map<string, Decision['origin']>()
  if (!candidates.size || !workspaceIds.size) return { origins, incomplete: false }
  try {
    const [agentResult, worktreeResult] = await Promise.all([run(['agent', 'list']), run(['worktree', 'list', '--limit', '100'])])
    const agents = record(agentResult)
    const worktrees = record(worktreeResult)
    if (!Array.isArray(agents.agents) || !Array.isArray(worktrees.worktrees)) return { origins, incomplete: true }
    const localRows = array(worktrees.worktrees).filter(row => row.hostId === 'local' || row.hostId === host.id || row.hostId === undefined || row.hostId === null)
    for (const sessionId of candidates) {
      const matches = array(agents.agents).filter(row => row.orcaSessionId === sessionId && row.kind === 'chat' && (row.hostId === 'local' || row.hostId === host.id))
      if (matches.length !== 1) continue
      const rawId = matches[0].worktreeId
      const listed = localRows.filter(row => row.id === rawId)
      if (listed.length > 1) continue
      const key = text(record(listed[0]?.identity).key, 1024)
      const workspaceId = key && !String(rawId).startsWith('folder:') ? 'identity:' + key : rawId
      if (typeof workspaceId === 'string' && workspaceIds.has(workspaceId)) {
        origins.set(sessionId, { hostId: host.id, workspaceId, sessionId })
      }
    }
    return { origins, incomplete: origins.size !== candidates.size || agents.truncated === true || worktrees.truncated === true }
  } catch { return { origins, incomplete: true } }
}

type BotCoverage =
  | { state: 'complete' }
  | { state: 'partial' | 'unavailable'; reason: string }

async function nativeHostPage(cli: Cli, host: NativeHost, workspaces: readonly Workspace[]) {
  const run = hostCommand(cli, host)
  const notes: string[] = []
  const items: NativeItem[] = []
  const coverage = new Map<string, BotCoverage>()
  try {
    const roster = record(await run(['bot', 'list']))
    if (!Array.isArray(roster.bots)) throw new Error('Malformed Bot roster')
    const reportedPeers = array(roster.unreachable).length > 0 || array(roster.bots).some(bot => Boolean(bot.server))
    const entries = array(roster.bots).filter(bot => !bot.server).map(bot => text(bot.id, 129))
    const ids = [...new Set(entries.filter(id => activityId.test(id)))]
    const rosterComplete = roster.truncated !== true && entries.every(id => activityId.test(id))
    if (!rosterComplete) notes.push('The Bot roster could not be fully read.')
    if (ids.length > 4) notes.push('Bot coverage reached its limit.')
    for (const botId of ids) coverage.set(botId, { state: 'partial', reason: 'Bot coverage reached its limit.' })
    const queried = ids.slice(0, 4)
    const results = await Promise.allSettled(queried.map(async botId => {
      let cursor = ''
      let mismatchedItem = false
      for (let page = 0; page < 2; page++) {
        const data = record(await run(['bot', 'item', 'list', '--bot', botId, '--all', '--limit', '50', ...(cursor ? ['--cursor', cursor] : [])]))
        if (!Array.isArray(data.items) || (data.botId !== undefined && data.botId !== botId)) throw new Error('Malformed Bot Item page')
        for (const item of array(data.items)) {
          if (record(item.owner).botId !== undefined && record(item.owner).botId !== botId) {
            mismatchedItem = true
            continue
          }
          if (!items.some(entry => entry.botId === botId && entry.item.uid === item.uid)) items.push({ host, botId, item })
        }
        const continuation = data.nextCursor ?? data.nextClosedCursor
        if (continuation === undefined || continuation === '') {
          if (mismatchedItem || data.truncated === true) break
          coverage.set(botId, { state: 'complete' })
          return
        }
        if (typeof continuation !== 'string' || continuation.length > 128 || continuation === cursor) break
        cursor = continuation
      }
      const reason = mismatchedItem ? 'Some Item records did not match their Bot.' : 'More Item pages exist on this host or the list was truncated.'
      coverage.set(botId, { state: 'partial', reason })
      notes.push(reason)
    }))
    for (const [index, result] of results.entries()) {
      if (result.status !== 'rejected') continue
      const reason = 'Bot Item read failed (' + cliProblem(result.reason) + ').'
      coverage.set(queried[index], { state: 'unavailable', reason })
      notes.push(reason)
    }
    if (results.length && results.every(entry => entry.status === 'rejected') && !items.length) {
      return { rows: [], notes, available: false, reportedPeers, coverage, rosterComplete }
    }
    const { origins, incomplete } = await nativeOrigins(run, host, items, workspaces)
    if (incomplete) notes.push('Workspace attribution could not be fully verified.')
    const rows = items.flatMap(entry => {
      const chat = record(entry.item.chat)
      const projected = itemRows(entry, chat.kind === 'chat' ? origins.get(text(chat.id)) : undefined)
      if (!projected.length) {
        const reason = 'Some Item records could not be represented.'
        if (coverage.get(entry.botId)?.state === 'complete') coverage.set(entry.botId, { state: 'partial', reason })
        notes.push(reason)
      }
      return projected
    })
    return { rows, notes, available: true, reportedPeers, coverage, rosterComplete }
  } catch (error) {
    return { rows: [], notes: ['Bot discovery failed (' + cliProblem(error) + ').'], available: false,
      reportedPeers: false, coverage, rosterComplete: false }
  }
}

export async function nativePage(cli: Cli, workspaces: readonly Workspace[] = [], requestedHost?: string): Promise<NativePage> {
  const { hosts, notes } = await discoverNativeHosts(cli, requestedHost)
  if (!requestedHost && workspaces.some(w => w.hostId !== 'local' && !hosts.some(h => h.id === w.hostId))) {
    notes.push('Some workspace hosts have no matching CLI pairing.')
  }
  const pages = await Promise.all(hosts.map(async host => ({ host, ...await nativeHostPage(cli, host, workspaces) })))
  if (!requestedHost && !hosts.some(host => host.id !== 'local') && pages.some(page => page.reportedPeers)) {
    notes.push('Orca reported paired Bot sources but the worker found no usable saved CLI pairing.')
  }
  notes.push(...pages.flatMap(page => [...new Set(page.notes)].map(note => `${page.host.label} (${page.host.id}): ${note}`)))
  const state = !pages.some(page => page.available) ? 'unavailable' : notes.length ? 'partial' : 'available'
  return { rows: pages.flatMap(page => page.rows), hasPairedCoverage: hosts.some(host => host.id !== 'local'), source: {
    source: 'native-item', state, ...(notes.length ? { message: notes.join(' ').slice(0, 2048) } : {})
  } }
}

export async function nativeDetail(cli: Cli, questionId: string, workspaces: readonly Workspace[] = []): Promise<Decision> {
  const parts = questionId.split(':')
  const legacy = parts.length === 4
  const [, hostKey, botKey, uidKey, eventKey, indexKey] = parts
  const [uid, event, index] = legacy ? [hostKey, botKey, uidKey] : [uidKey, eventKey, indexKey]
  let hostId: string
  try { hostId = legacy ? 'local' : decodeURIComponent(hostKey) } catch { throw new InboxError('not-found', 'Bot Item is missing or inaccessible.') }
  if (questionId.length > 256 || (!legacy && (parts.length !== 6 || !activityId.test(botKey ?? ''))) ||
    !activityId.test(uid ?? '') || !activityId.test(event ?? '') || !/^[0-4]$/.test(index ?? '')) {
    throw new InboxError('not-found', 'Bot Item is missing or inaccessible.')
  }
  const { hosts, notes } = await discoverNativeHosts(cli, hostId)
  const host = hosts[0]
  if (!host) throw unavailable(notes.join(' '))
  const page = await nativeHostPage(cli, host, workspaces)
  if (!page.available) throw unavailable(page.notes.join(' '))
  const suffix = ':' + uid + ':' + event + ':' + index
  const selected = page.rows.filter(row => legacy ? row.questionId.endsWith(suffix) : row.questionId === questionId)
  const coverage = legacy
    ? [...page.coverage.values()].find(bot => bot.state !== 'complete')
    : page.coverage.get(botKey)
  if (selected.length !== 1) {
    const reason = coverage && coverage.state !== 'complete' ? coverage.reason : undefined
    if (reason || (!coverage && !page.rosterComplete)) {
      throw unavailable('The requested Bot Item could not be verified. ' + (reason ?? 'The Bot roster could not be fully read.'))
    }
    throw new InboxError('not-found', 'Bot Item is missing or inaccessible.')
  }
  const botId = selected[0].questionId.split(':')[2]
  const selectedCoverage = page.coverage.get(botId)
  if (selectedCoverage?.state === 'unavailable') {
    throw unavailable('The requested Bot Item could not be verified. ' + selectedCoverage.reason)
  }
  const after = /^e([1-9]\d*)$/.exec(event)
  const eventNumber = after && Number(after[1])
  const args = ['bot', 'item', 'show', uid, ...(eventNumber && Number.isSafeInteger(eventNumber) ? ['--after', 'e' + (eventNumber - 1)] : [])]
  const response = await hostCommand(cli, host)(args).catch(error => { throw unavailable('Bot Item detail failed (' + cliProblem(error) + ').') })
  const { item, events } = record(response)
  const itemRecord = record(item)
  const actualBot = record(itemRecord.owner).botId
  if (itemRecord.uid !== uid || (actualBot !== undefined && actualBot !== botId)) {
    throw new InboxError('not-found', 'Bot Item changed. Refresh the Inbox.')
  }
  const listed = selected[0]
  const row = itemRows({ host, botId, item: itemRecord }, listed.source?.kind === 'native-item' &&
    listed.source.workspaceAttributed && record(itemRecord.chat).kind === 'chat' && record(itemRecord.chat).id === listed.origin.sessionId ? listed.origin : undefined,
    array(events)).find(d => d.questionId === listed.questionId)
  if (!row) throw new InboxError('not-found', 'Bot Item changed. Refresh the Inbox.')
  return legacy ? { ...row, questionId } : row
}
