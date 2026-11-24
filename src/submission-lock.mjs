import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout } from 'node:timers/promises'

const ownerPattern = /^([1-9][0-9]{0,9})\.[0-9a-f-]{36}$/
const candidatePrefix = '.lock-candidate.'
const lockPrefix = '.lock.'
const missing = error => error.code === 'ENOENT'

function ownerExited(owner) {
  const pid = Number(ownerPattern.exec(owner)?.[1])
  if (!pid || pid > 0x7fffffff) return false
  try { process.kill(pid, 0) }
  catch (error) { return error.code === 'ESRCH' }
  return false
}

async function removeEmpty(path) {
  try { await rmdir(path) }
  catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error
  }
}

export async function reapSubmissionLock(root, name) {
  const path = join(root, name)
  if (name.startsWith(candidatePrefix)) {
    if (ownerExited(name.slice(candidatePrefix.length))) await rm(path, { recursive: true, force: true })
    return
  }
  if (!name.startsWith(lockPrefix)) return
  const owners = await readdir(path).catch(error => {
    if (!missing(error)) throw error
    return []
  })
  for (const owner of owners) {
    if (ownerExited(owner)) await rm(join(path, owner), { force: true })
  }
  await removeEmpty(path)
}

export async function withSubmissionLock(root, key, waitMs, operation) {
  const owner = `${process.pid}.${randomUUID()}`
  const candidate = join(root, candidatePrefix + owner)
  const name = lockPrefix + key
  const lock = join(root, name)
  const deadline = performance.now() + waitMs
  await mkdir(candidate, { mode: 0o700 })
  let acquired = false
  try {
    await writeFile(join(candidate, owner), '', { flag: 'wx', mode: 0o600 })
    for (;;) {
      try {
        // Rename claims an absent or empty lock atomically. A live lock is
        // always nonempty, so a contender cannot replace it.
        await rename(candidate, lock)
        acquired = true
        return { value: await operation() }
      } catch (error) {
        if (acquired || !['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error
      }
      await reapSubmissionLock(root, name)
      if (performance.now() >= deadline) return undefined
      await setTimeout(20)
    }
  } finally {
    if (acquired) {
      // The unique owner name prevents a late reaper from removing a
      // successor's owner file. rmdir also cannot remove a populated lock.
      await rm(join(lock, owner), { force: true })
      await removeEmpty(lock)
    } else {
      await rm(candidate, { recursive: true, force: true })
    }
  }
}
