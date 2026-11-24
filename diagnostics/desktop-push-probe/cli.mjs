import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function invokeCli(args) {
  const bundled = join(homedir(), '.orca', 'cli', 'bin', 'orca')
  const executable = existsSync(bundled) ? bundled : 'orca'
  // Inherit the public worker process context exactly. No shell or identity override.
  return new Promise(resolve => {
    execFile(executable, args, { timeout: 7000, maxBuffer: 512 * 1024, windowsHide: true },
      (failure, stdout, stderr) => {
        let payload
        try { payload = JSON.parse(stdout) } catch { /* Version output is plain text. */ }
        const processStatus = {
          exitCode: failure ? typeof failure.code === 'number' ? failure.code : null : 0,
          signal: failure?.signal ?? null,
          ...(typeof failure?.code === 'string' ? { processError: failure.code } : {})
        }
        return resolve({ executable, ...processStatus, payload,
          ...(args[0] === '--version' ? { version: stdout.trim() } : {}),
          ...(!payload && failure ? { diagnostic: (stderr.trim() || failure.message).slice(0, 4000) } : {}) })
      })
  })
}
