import type { OrcaWorkerApi } from 'orca/worker'
import type { InboxStorage } from './backend.ts'
import { InboxError } from './backend-validation.ts'

type Storage = OrcaWorkerApi['storage']
type Index = { slot: 'a' | 'b'; count: number }
const indexKey = 'inbox.v1.state'
const chunkLength = 60_000
const maxBytes = 2 * 1024 * 1024
const prefix = (slot: Index['slot']) => `inbox.v1.${slot}.`
const chunkKey = (slot: Index['slot'], index: number) => prefix(slot) + index

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
 * generation in the inactive slot, then atomically switch the index. */
export function orcaStorage(host: Storage): InboxStorage {
  return {
    async read() {
      const index = await readIndex(host)
      if (!index) return null
      const chunks = await Promise.all(Array.from({ length: index.count }, (_, i) => host.get(chunkKey(index.slot, i))))
      if (!chunks.every(chunk => typeof chunk === 'string')) throw new InboxError('unavailable', 'Inbox storage is incomplete.')
      return JSON.parse(chunks.join(''))
    },
    async write(state) {
      const active = await readIndex(host)
      const slot = active?.slot === 'a' ? 'b' : 'a'
      const serialized = JSON.stringify(state)
      const chunks = []
      const encode = new TextEncoder()
      let bytes = 0
      for (let start = 0; start < serialized.length; start += chunkLength) {
        const chunk = serialized.slice(start, start + chunkLength)
        bytes += encode.encode(JSON.stringify(chunk)).length
        if (bytes > maxBytes) throw new InboxError('unavailable', 'The Inbox has reached its Orca storage limit.')
        chunks.push(chunk)
      }
      for (const key of await host.keys()) {
        if (key.startsWith(prefix(slot))) await host.delete(key)
      }
      for (const [i, chunk] of chunks.entries()) await host.set(chunkKey(slot, i), chunk)
      await host.set(indexKey, { slot, count: chunks.length })
    }
  }
}
