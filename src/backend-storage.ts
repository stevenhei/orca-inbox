import type { OrcaWorkerApi } from 'orca/worker'
import { initialContentBudget, initialReplyEnvelope, largestReceipt, longestFailure, maxStoredId, type InboxStorage } from './backend.ts'
import type { PrivateSnapshot } from './backend-protocol.ts'
import { InboxError } from './backend-validation.ts'

type Storage = OrcaWorkerApi['storage']
type State = Parameters<InboxStorage['write']>[0]
type CompactState = Omit<State, 'decisions'> & {
  compact: true
  decisions: Omit<State['decisions'][number], 'packageSummary' | 'evidence' | 'sourceLinks' | 'access'>[]
}
type Index = { slot: 'a' | 'b'; count: number }
const indexKey = 'inbox.v1.state'
const chunkLength = 60_000
const metadataBudget = 1024 * 1024
// Leave room for a fully loaded pre-reservation generation to make progress.
// Two physical generations plus 2.5 MB of snapshots stay below the 5 MiB host cap.
const physicalMetadataBudget = 1280 * 1024
const snapshotBudget = 2_500_000
const blobPrefix = 'inbox.v1.snapshot.'
const blobKey = (blob: string, i: number) => `${blobPrefix}${blob}.${i}`
const missingSnapshot = () => new InboxError('unavailable', 'Inbox snapshot storage is incomplete.')
const prefix = (slot: Index['slot']) => `inbox.v1.${slot}.`
const chunkKey = (slot: Index['slot'], index: number) => prefix(slot) + index

const encoder = new TextEncoder()
// The host stores each chunk as a JSON string. This measures content without
// its enclosing quotes so costs can be added independently of chunk boundaries.
const storedStringBytes = (value: string) => encoder.encode(JSON.stringify(value)).length - 2
const storedBytes = (value: unknown) => storedStringBytes(JSON.stringify(value))
const draftContentBudget = 4096

function deliveryHeadroom(origin: State['decisions'][number]['origin'], questionId: string, replyId: string,
  delivery: { state: string }, queued: boolean) {
  const outbox = { questionId, replyId }
  const receipt = largestReceipt(origin, questionId, replyId)
  const current = storedBytes(delivery) + (queued ? storedBytes(outbox) + 1 : 0)
  return Math.max(0, Math.max(storedBytes(longestFailure) + storedBytes(outbox) + 1, storedBytes(receipt)) - current)
}

function transitionHeadroom(state: State) {
  const queued = new Set(state.outbox.map(entry => entry.replyId))
  const drafts = new Map(state.drafts.map(draft => [JSON.stringify([draft.questionId, draft.ownerId]), draft]))
  let bytes = 0
  for (const d of state.decisions) {
    if (d.answerState.state === 'answered') {
      for (const r of [d.answerState.initial, ...d.answerState.followUps]) {
        if (r.delivery.state !== 'agent-received') {
          bytes += deliveryHeadroom(d.origin, d.questionId, r.replyId, r.delivery, queued.has(r.replyId))
        }
      }
      continue
    }
    const initial = initialReplyEnvelope(d.questionId)
    const { acceptedAt: _acceptedAt, delivery, ...input } = initial
    const answerState = { state: 'answered', initial, followUps: [] }
    // The accepted payload is stored in both the thread and the idempotency log.
    let logBytes = 0
    for (const ownerId of new Set(d.access.participantIds)) {
      logBytes = Math.max(logBytes, storedBytes({ ownerId, input, acceptedId: maxStoredId }) + 1)
      const draft = drafts.get(JSON.stringify([d.questionId, ownerId]))
      const reserve = storedBytes({ ownerId, questionId: d.questionId, revision: Number.MAX_SAFE_INTEGER,
        value: { kind: 'follow-up', optionId: maxStoredId, replyId: maxStoredId, text: '', annotations: [] } }) + draftContentBudget + 1
      bytes += Math.max(0, reserve - (draft ? storedBytes(draft) + 1 : 0))
    }
    bytes += storedBytes(answerState) - storedBytes(d.answerState) + logBytes + 2 * initialContentBudget +
      storedBytes({ questionId: d.questionId, replyId: maxStoredId }) + 1 +
      deliveryHeadroom(d.origin, d.questionId, maxStoredId, delivery, true)
  }
  return bytes
}

function compactState(state: State): CompactState {
  return {
    ...state, compact: true,
    decisions: state.decisions.map(({ packageSummary: _summary, evidence: _evidence,
      sourceLinks: _links, access: _access, ...d }) => d)
  }
}

// Account for the outer quotes on every chunk with a fixed allowance. A fixed
// charge keeps transitions neutral when the serialized state crosses a boundary.
const chunkOverhead = 128
// Charge each reserved array entry one delimiter, including the first entry.
const account = (state: State, physicalBytes: number) => physicalBytes + transitionHeadroom(state) +
  Number(state.drafts.length > 0) + Number(state.outbox.length > 0) + Number(state.replies.length > 0)

async function readIndex(host: Storage): Promise<Index | null> {
  const value = await host.get(indexKey)
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value) || (value.slot !== 'a' && value.slot !== 'b') ||
    typeof value.count !== 'number' || !Number.isInteger(value.count) || value.count < 1 || value.count > 36) {
    throw new InboxError('unavailable', 'Inbox storage index is unreadable.')
  }
  return { slot: value.slot, count: value.count }
}

/** Orca caps each value at 256 KiB and the plugin at 5 MiB. Stage one bounded
 * metadata generation in the inactive slot, then atomically switch the index.
 * Immutable snapshot chunks are shared by generations. A later write removes abandoned blobs. */
export function orcaStorage(host: Storage): InboxStorage {
  const readState = async (index: Index) => {
    const chunks = await Promise.all(Array.from({ length: index.count }, (_, i) => host.get(chunkKey(index.slot, i))))
    if (!chunks.every(chunk => typeof chunk === 'string')) throw new InboxError('unavailable', 'Inbox storage is incomplete.')
    const stored = JSON.parse(chunks.join('')) as State | CompactState
    if (!('compact' in stored)) return stored
    const contexts = new Map(stored.packages.map(({ input, grant }) => [input.packageId, {
      ...(input.summary === undefined ? {} : { packageSummary: input.summary }),
      evidence: input.evidence, sourceLinks: input.sourceLinks,
      access: { participantIds: grant.participantIds, attachmentReaderIds: Object.fromEntries(
        grant.snapshots.map(s => [s.attachmentId, s.readerIds])
      ) }
    }]))
    const { compact: _compact, ...state } = stored
    return {
      ...state,
      decisions: state.decisions.map(d => {
        const context = contexts.get(d.packageId)
        if (!context) throw new InboxError('unavailable', 'Inbox package context is incomplete.')
        return { ...d, ...context }
      })
    }
  }
  return {
    async readSnapshot(blob) {
      const header = await host.get(blobKey(blob, 0))
      if (header === null) return undefined
      if (!header || typeof header !== 'object' || Array.isArray(header) ||
        typeof header.count !== 'number' || !Number.isInteger(header.count) || header.count < 1 || header.count > 15 ||
        (header.mimeType !== 'image/png' && header.mimeType !== 'image/jpeg' &&
         header.mimeType !== 'image/webp' && header.mimeType !== 'image/gif')) throw missingSnapshot()
      const chunks = await Promise.all(Array.from({ length: header.count }, (_, i) => host.get(blobKey(blob, i + 1))))
      if (!chunks.every(chunk => typeof chunk === 'string')) throw missingSnapshot()
      const base64 = chunks.join('')
      if (base64.length !== header.length || base64.length > 900_000) throw missingSnapshot()
      return { mimeType: header.mimeType, base64 }
    },
    async read() {
      const index = await readIndex(host)
      return index ? readState(index) : null
    },
    async write(state) {
      const active = await readIndex(host)
      const previous = active ? await readState(active) : null
      const slot = active?.slot === 'a' ? 'b' : 'a'
      const snapshots = state.packages.flatMap(p => p.grant.snapshots)
      const previousBlobs = new Set(previous?.packages.flatMap(p => p.grant.snapshots.flatMap(s => s.blob ? [s.blob] : [])))
      const staged: { blob: string; image: PrivateSnapshot }[] = []
      let snapshotBytes = 0
      for (const snapshot of snapshots) {
        if (snapshot.image) {
          const blob = globalThis.crypto.randomUUID()
          staged.push({ blob, image: snapshot.image })
          snapshotBytes += snapshot.image.base64.length
          snapshot.blob = blob
          delete snapshot.image
        } else if (snapshot.blob) {
          const header = await host.get(blobKey(snapshot.blob, 0))
          if (!header || typeof header !== 'object' || Array.isArray(header) || typeof header.length !== 'number') throw missingSnapshot()
          snapshotBytes += header.length
        }
      }
      if (snapshotBytes > snapshotBudget) throw new InboxError('unavailable', 'The Inbox has reached its private snapshot storage limit.')
      const serialized = JSON.stringify(compactState(state))
      const physicalBytes = storedStringBytes(serialized) + chunkOverhead
      const accounted = account(state, physicalBytes)
      if (physicalBytes > physicalMetadataBudget ||
        (accounted > metadataBudget && (!previous || accounted > account(previous, storedBytes(compactState(previous)) + chunkOverhead)))) {
        throw new InboxError('unavailable', 'The Inbox has reached its Orca storage limit.')
      }
      const chunks = []
      for (let start = 0; start < serialized.length;) {
        let end = Math.min(start + chunkLength, serialized.length)
        // Keep surrogate pairs together so slicing does not inflate stored bytes.
        if (end < serialized.length && /[\uD800-\uDBFF]/u.test(serialized[end - 1])) end--
        chunks.push(serialized.slice(start, end))
        start = end
      }
      for (const key of await host.keys()) {
        if (key.startsWith(prefix(slot)) || (key.startsWith(blobPrefix) &&
          !previousBlobs.has(key.slice(blobPrefix.length).split('.')[0]))) await host.delete(key)
      }
      for (const { blob, image } of staged) {
        let count = 0
        for (let i = 0; i < image.base64.length; i += chunkLength) {
          await host.set(blobKey(blob, ++count), image.base64.slice(i, i + chunkLength))
        }
        await host.set(blobKey(blob, 0), { mimeType: image.mimeType, count, length: image.base64.length })
      }
      for (const [i, chunk] of chunks.entries()) await host.set(chunkKey(slot, i), chunk)
      await host.set(indexKey, { slot, count: chunks.length })
    }
  }
}
