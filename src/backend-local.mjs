import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, open, opendir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

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

export function localOrca(args, environment = 'local', runtimeId) {
  const bundled = join(homedir(), '.orca', 'cli', 'bin', 'orca')
  const env = { ...process.env }
  for (const key of ['ORCA_AGENT_SESSION_ID', 'ORCA_AGENT_SESSION_SPAWN_TOKEN', 'ORCA_AGENT_SESSION_TOOL_TOKEN',
    'ORCA_TERMINAL_HANDLE', 'ORCA_BOT_TOOLS_TOKEN', 'ORCA_PANE_KEY', 'ORCA_PAIRING_CODE', 'ORCA_ENVIRONMENT']) delete env[key]
  return new Promise((resolve, reject) => {
    const route = args[0] === 'environment' && args[1] === 'list' ? [] : ['--environment', environment]
    // The local Bot roster may wait for Orca's own four-second paired fan-out.
    const timeout = environment === 'local' && args[0] === 'bot' && args[1] === 'list' ? 8500
      : environment === 'local' ? 2500 : 4000
    execFile(existsSync(bundled) ? bundled : 'orca', [...args, ...route, '--json'],
      { env, timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (_error, stdout) => {
        try {
          const envelope = JSON.parse(stdout)
          if (envelope.ok === true) {
            if (runtimeId && envelope._meta?.runtimeId !== runtimeId) {
              reject(Object.assign(new Error('Orca returned a different runtime identity.'), { code: 'runtime_mismatch' }))
            } else resolve(envelope.result)
          } else {
            reject(Object.assign(new Error('Orca CLI denied or could not perform the operation.'), { code: envelope.error?.code }))
          }
        } catch {
          reject(Object.assign(new Error('Orca CLI is unavailable.'), { code: _error?.killed ? 'timeout' : 'cli_unavailable' }))
        }
      })
  })
}

// Store only a review reference, never the decision body, draft or answer.
export async function writeReference(workspace, reference) {
  const invalid = code => Object.assign(new Error('Invalid Decision Inbox review reference.'), { code })
  if (!isAbsolute(workspace)) throw invalid('invalid_workspace_path')
  const root = await realpath(workspace)
  const directory = join(root, '.orca-decision-inbox')
  await mkdir(directory, { mode: 0o700 }).catch(error => {
    if (error.code !== 'EEXIST') throw error
  })
  const folder = await lstat(directory)
  if (!folder.isDirectory() || await realpath(directory) !== directory) throw invalid('unsafe_reference_directory')
  const contents = JSON.stringify(reference)
  const name = createHash('sha256').update(contents).digest('hex') + '.orca-decision'
  const target = join(directory, name)
  try {
    await writeFile(target, contents, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const existing = await lstat(target)
    if (!existing.isFile() || existing.size !== Buffer.byteLength(contents)) throw invalid('invalid_reference_file')
    const file = await open(target, 'r')
    try {
      if (await file.readFile('utf8') !== contents) throw invalid('invalid_reference_file')
    } finally { await file.close() }
  }
  return '.orca-decision-inbox/' + name
}
