#!/usr/bin/env node
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { prepareLocalSnapshot, publishLocalSnapshots } from '../../src/local-snapshot.mjs'
import { boundedFile, withFileDescriptor } from '../../src/bounded-file.mjs'
import { withSubmissionLock } from '../../src/submission-lock.mjs'
import { privateHintDirectory, hintPattern } from '../../src/backend-local.mjs'

try {
  const [op, inputPath, ...extra] = process.argv.slice(2)
  if (!['submit', 'ack'].includes(op) || !inputPath || (op === 'ack' && extra.length) || extra.length % 4 || extra.length > 32) {
    throw new Error('Usage: node inbox.mjs submit INPUT.json [--image EVIDENCE_ID VERSION LOCAL_PATH]… or ack INPUT.json')
  }
  const session = process.env.ORCA_AGENT_SESSION_ID
  if (!session || process.env.ORCA_BOT_TOOLS_TOKEN) throw new Error('Run this from the originating ordinary Orca workspace Chat.')
  // Up to three UTF-8 bytes per UTF-16 unit keeps valid CJK within the original character limit.
  const bytes = await boundedFile(inputPath, 96_000, () => new Error('Inbox input must be a stable regular file within the size limit.'))
  const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  if (raw.length > 32_000) throw new Error('Inbox marker input is too large.')
  const input = JSON.parse(raw)
  const lookupId = op === 'submit' ? input.requestId : input.receiptId
  if (typeof lookupId !== 'string') throw new Error('Provide a stable request ID or receipt ID.')
  const name = [op, session, lookupId].join('.')
  if (!hintPattern.test(name)) throw new Error('Invalid session lookup hint or request ID.')
  const pending = []
  for (let i = 0; i < extra.length; i += 4) {
    const [flag, evidenceId, version, path] = extra.slice(i, i + 4)
    const matches = (input.evidence ?? []).filter(item => item.kind === 'image-snapshot' &&
      item.evidenceId === evidenceId && String(item.version) === version)
    if (flag !== '--image' || matches.length !== 1 || pending.some(entry => entry.item === matches[0])) {
      throw new Error('Each --image must match one distinct image-snapshot evidence ID and version.')
    }
    pending.push({ item: matches[0], path })
  }
  if (op === 'submit' && (input.evidence ?? []).some(item => item.kind === 'image-snapshot' &&
    !pending.some(entry => entry.item === item))) throw new Error('Stage each image with --image or use a source link.')
  const snapshots = []
  for (const { item, path } of pending) {
    const snapshot = await prepareLocalSnapshot(session, lookupId, item, path)
    item.attachmentId = snapshot.attachmentId
    snapshots.push(snapshot)
  }
  const line = 'ORCA-INBOX-V1 ' + JSON.stringify({ op, input })
  if (line.length > 32_768) throw new Error('Inbox marker is too large.')
  const root = await privateHintDirectory(true)
  const published = await withSubmissionLock(root, name, 1000, () =>
    publishLocalSnapshots(snapshots, async () => {
      const path = join(root, name)
      try { await writeFile(path, '', { flag: 'wx', mode: 0o600 }) }
      catch (error) {
        if (error.code !== 'EEXIST') throw error
        await withFileDescriptor(path, async (file, details) => {
          if (!details.isFile() || details.size !== 0 || details.nlink !== 1 ||
            (process.getuid && (details.uid !== process.getuid() || (details.mode & 0o077)))) {
            throw new Error('Inbox lookup hint must be an empty private file.')
          }
          await file.utimes(details.atime, new Date())
        })
      }
    })
  )
  if (!published) throw new Error('Inbox staging is busy. Retry this submission shortly.')
  console.log(line)
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Decision Inbox invocation failed.')
  process.exitCode = 1
}
