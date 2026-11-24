#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hintDirectory, hintPattern } from '../../src/backend-local.mjs'

try {
  const [op, inputPath, ...extra] = process.argv.slice(2)
  if (!['submit', 'ack'].includes(op) || !inputPath || extra.length) throw new Error('Usage: node inbox.mjs submit|ack INPUT.json')
  const session = process.env.ORCA_AGENT_SESSION_ID
  if (!session || process.env.ORCA_BOT_TOOLS_TOKEN) throw new Error('Run this from the originating ordinary Orca workspace Chat.')
  const raw = await readFile(inputPath, 'utf8')
  if (raw.length > 32_000) throw new Error('Inbox marker input is too large.')
  const input = JSON.parse(raw)
  const lookupId = op === 'submit' ? input.requestId : input.receiptId
  if (typeof lookupId !== 'string') throw new Error('Provide a stable request ID or receipt ID.')
  const name = [op, session, lookupId].join('.')
  if (!hintPattern.test(name)) throw new Error('Invalid session lookup hint or request ID.')
  const line = 'ORCA-INBOX-V1 ' + JSON.stringify({ op, input })
  if (line.length > 32_768) throw new Error('Inbox marker is too large.')
  await mkdir(hintDirectory, { recursive: true, mode: 0o700 })
  try { await writeFile(join(hintDirectory, name), '', { flag: 'wx', mode: 0o600 }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  console.log(line)
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Decision Inbox invocation failed.')
  process.exitCode = 1
}
