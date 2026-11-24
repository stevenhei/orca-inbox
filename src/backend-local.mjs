import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, open, opendir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const hintDirectory = join(homedir(), '.orca-decision-inbox', 'hints')

// Nonsensitive scope identifiers only. A filename never authenticates a Chat.
export const hintPattern = /^(submit|ack)\.([0-9a-f-]{36})\.([a-zA-Z0-9_-]{1,128})$/

export async function hints() {
  try {
    const dir = await opendir(hintDirectory)
    const result = []
    let inspected = 0
    for await (const entry of dir) {
      if (++inspected > 256 || result.length === 8) break
      if (!entry.isFile() || !hintPattern.test(entry.name)) continue
      const details = await stat(join(hintDirectory, entry.name)).catch(() => undefined)
      if (!details) continue
      if (Date.now() - details.mtimeMs > 60 * 60 * 1000) await removeHint(entry.name)
      else result.push(entry.name)
    }
    return result
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

export async function removeHint(name) {
  if (hintPattern.test(name)) await rm(join(hintDirectory, name), { force: true })
}

export function localOrca(args) {
  const bundled = join(homedir(), '.orca', 'cli', 'bin', 'orca')
  const env = { ...process.env }
  for (const key of ['ORCA_AGENT_SESSION_ID', 'ORCA_AGENT_SESSION_SPAWN_TOKEN', 'ORCA_AGENT_SESSION_TOOL_TOKEN',
    'ORCA_TERMINAL_HANDLE', 'ORCA_BOT_TOOLS_TOKEN', 'ORCA_PANE_KEY', 'ORCA_PAIRING_CODE', 'ORCA_ENVIRONMENT']) delete env[key]
  return new Promise((resolve, reject) => {
    execFile(existsSync(bundled) ? bundled : 'orca', [...args, '--environment', 'local', '--json'],
      { env, timeout: 2500, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (_error, stdout) => {
        try {
          const envelope = JSON.parse(stdout)
          if (envelope.ok === true) resolve(envelope.result)
          else reject(new Error('Orca CLI denied or could not perform the operation.'))
        } catch {
          reject(new Error('Local Orca CLI is unavailable.'))
        }
      })
  })
}

// Store only a review reference, never the decision body, draft or answer.
export async function writeReference(workspace, reference) {
  const root = await realpath(workspace)
  const directory = join(root, '.orca-decision-inbox')
  await mkdir(directory, { mode: 0o700 }).catch(error => {
    if (error.code !== 'EEXIST') throw error
  })
  const folder = await lstat(directory)
  if (!folder.isDirectory() || await realpath(directory) !== directory) throw new Error('Unsafe review reference directory.')
  const contents = JSON.stringify(reference)
  const name = createHash('sha256').update(contents).digest('hex') + '.orca-decision'
  const target = join(directory, name)
  try {
    await writeFile(target, contents, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const existing = await lstat(target)
    if (!existing.isFile() || existing.size !== Buffer.byteLength(contents)) throw new Error('Invalid review reference file.')
    const file = await open(target, 'r')
    try {
      if (await file.readFile('utf8') !== contents) throw new Error('Existing review reference differs.')
    } finally { await file.close() }
  }
  return '.orca-decision-inbox/' + name
}
