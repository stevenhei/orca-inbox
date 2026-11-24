import { createHash } from 'node:crypto'
import { link, lstat, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { boundedFile } from './bounded-file.mjs'
import { rasterMime } from './raster-metadata.mjs'
import { privateHintDirectory, hintPattern } from './backend-local.mjs'

const maxBytes = 675_000
const imageId = /^local-image:([0-9a-f]{64})$/
const invalid = () => new Error('The local image must be a staged PNG, JPEG, GIF or WebP of at most 675,000 bytes with complete image structure and safe dimensions.')

function mime(bytes) {
  const type = rasterMime(bytes)
  if (!type) throw invalid()
  return type
}

function submissionKey(session, request) {
  const key = `submit.${session}.${request}`
  if (!hintPattern.test(key)) throw invalid()
  return key
}

function digest(key, evidence, bytes) {
  return createHash('sha256').update(JSON.stringify([key, evidence.evidenceId, evidence.version])).update(bytes).digest('hex')
}

export async function prepareLocalSnapshot(session, request, evidence, path) {
  const key = submissionKey(session, request)
  const bytes = await boundedFile(path, maxBytes, invalid)
  mime(bytes)
  const token = digest(key, evidence, bytes)
  return { key, token, bytes, attachmentId: 'local-image:' + token }
}

const slots = [0, 1, 2, 3]

function snapshotPath(root, key, token, slot) {
  return join(root, `${key}.${token}${slot === undefined ? '' : `.${slot}`}.image`)
}

async function regularFile(path) {
  try { return (await lstat(path)).isFile() }
  catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function reserveSnapshot(root, { key, token, bytes }, created) {
  for (const slot of slots) {
    const path = snapshotPath(root, key, token, slot)
    // Only another publisher that has already committed may share this slot.
    try {
      await boundedFile(path + '.ready', maxBytes, invalid, async (staged, file, details) => {
        if (!staged.equals(bytes) || (process.getuid && (details.uid !== process.getuid() || (details.mode & 0o077)))) throw invalid()
        // A ready alias can outlive its base. With two links, require the other
        // name to be the staging base before changing the inode timestamp.
        if (details.nlink === 2) {
          const base = await lstat(path)
          if (base.ino !== details.ino || base.dev !== details.dev) throw invalid()
        } else if (details.nlink !== 1) {
          throw invalid()
        }
        await file.utimes(details.atime, new Date())
      })
      return
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  for (const slot of slots) {
    const path = snapshotPath(root, key, token, slot)
    let file
    try { file = await open(path, 'wx', 0o600) }
    catch (error) {
      if (error.code === 'EEXIST') continue
      throw error
    }
    created.push(path)
    try { await file.writeFile(bytes) } finally { await file.close() }
    // Confirm this filesystem supports the alias before committing the hint.
    await link(path, path + '.pending')
    return
  }
  throw new Error('Local image staging is busy. Refresh Decision Inbox or retry later.')
}

export async function publishLocalSnapshots(snapshots, publishHint) {
  if (!snapshots.length) return publishHint()
  const root = await privateHintDirectory(true)
  const created = []
  try {
    for (const snapshot of snapshots) await reserveSnapshot(root, snapshot, created)
    await publishHint()
    // Once the hint commits, this invocation will never roll back its blobs.
  } catch (error) {
    await Promise.allSettled(created.flatMap(path => [path, path + '.pending'].map(file => rm(file, { force: true }))))
    throw error
  }
  // A hard link is the immutable committed name. Readers and retries use
  // that name directly, so they cannot observe a reused uncommitted slot.
  await Promise.all(created.map(path => rename(path + '.pending', path + '.ready')))
}

export function isLocalSnapshotId(value) {
  return imageId.test(value)
}

export async function readLocalSnapshot(session, request, evidence) {
  const token = imageId.exec(evidence.attachmentId)?.[1]
  if (!token) throw invalid()
  const key = submissionKey(session, request)
  const root = await privateHintDirectory()
  for (const slot of [...slots, undefined]) {
    const path = snapshotPath(root, key, token, slot)
    const target = slot === undefined ? path : path + '.ready'
    try {
      const staged = await lstat(target)
      if (!staged.isFile() || (process.getuid && (staged.uid !== process.getuid() || (staged.mode & 0o077)))) continue
      const bytes = await boundedFile(target, maxBytes, invalid)
      if (digest(key, evidence, bytes) === token) return { mimeType: mime(bytes), base64: bytes.toString('base64') }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  throw invalid()
}

export async function clearLocalSnapshots(session, request, evidence) {
  const key = submissionKey(session, request)
  const tokens = evidence.flatMap(item => imageId.exec(item.attachmentId)?.[1] ?? [])
  if (!tokens.length) return
  const root = await privateHintDirectory()
  await Promise.all(tokens.flatMap(token => [...slots, undefined].map(async slot => {
    const target = snapshotPath(root, key, token, slot)
    if (slot !== undefined) {
      // Do not remove an in-progress publisher's private slot.
      if (!await regularFile(target + '.ready')) return
      await rm(target + '.ready', { force: true })
    }
    await rm(target, { force: true })
  })))
}
