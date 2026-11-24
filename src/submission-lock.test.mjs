import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const root = await fs.mkdtemp(join(os.tmpdir(), 'inbox-sweep-race-'))
const originalHome = os.homedir
const { lstat, rm } = fs
const dir = join(root, '.orca-decision-inbox', 'hints')
const image = join(root, 'pixel.png')
const manifest = join(root, 'input.json')
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg=='
const session = '91408397-3661-48c4-940f-7744deb0d07a'
const evidence = { kind: 'image-snapshot', evidenceId: 'sample', version: 1 }
const cli = new URL('../agent/decision-inbox/inbox.mjs', import.meta.url).href
const homeOverride = `
  import os from 'node:os'
  import { syncBuiltinESMExports } from 'node:module'
  os.homedir = () => ${JSON.stringify(root)}
  syncBuiltinESMExports()
`
const child = (code, args = []) => spawnSync(process.execPath, ['--input-type=module', '-e', homeOverride + code, '--', ...args], {
  env: { ...process.env, ORCA_AGENT_SESSION_ID: session, ORCA_BOT_TOOLS_TOKEN: '' },
  encoding: 'utf8', timeout: 2500
})
const run = (input = manifest) => child(`
  process.argv = ['node', 'inbox.mjs', 'submit', ...process.argv.slice(1)]
  await import(${JSON.stringify(cli)})
`, [input, '--image', 'sample', '1', image])

await fs.writeFile(image, Buffer.from(pixel, 'base64'))
os.homedir = () => root
syncBuiltinESMExports()
const { hints } = await import('./backend-local.mjs')
const { readLocalSnapshot, clearLocalSnapshots } = await import('./local-snapshot.mjs')
os.homedir = originalHome
syncBuiltinESMExports()

test.after(async () => { await rm(root, { recursive: true, force: true }) })

async function stage(requestId, input = manifest) {
  await fs.writeFile(input, JSON.stringify({ requestId, evidence: [evidence] }))
  const result = run(input)
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

const keyFor = id => `submit.${session}.${id}`
const age = async path => {
  const old = new Date(Date.now() - 3_700_000)
  await fs.utimes(path, old, old)
}

for (const part of ['hint', 'ready']) {
  test(`stale ${part} observation cannot remove a subsequently renewed file`, { timeout: 6000 }, async () => {
    const requestId = `renew-first-${part}`
    const key = keyFor(requestId)
    const marker = await stage(requestId)
    const claim = JSON.parse(marker.slice('ORCA-INBOX-V1 '.length)).input.evidence[0]
    const controlInput = join(root, 'control.json')
    const control = keyFor('abandoned-' + part)
    await stage('abandoned-' + part, controlInput)
    for (const name of await fs.readdir(dir)) {
      if (name === control || name.startsWith(control + '.')) await age(join(dir, name))
    }
    const ready = (await fs.readdir(dir)).find(name => name.startsWith(key + '.') && name.endsWith('.ready'))
    const target = join(dir, part === 'hint' ? key : ready)
    await age(target)
    let intercepted = false
    fs.lstat = async (path, ...args) => {
      const details = await lstat(path, ...args)
      if (path === target && !intercepted) {
        intercepted = true
        const retry = run()
        assert.equal(retry.status, 0, retry.stderr)
        assert.equal(retry.stdout, marker)
      }
      return details
    }
    syncBuiltinESMExports()
    try {
      const fresh = await hints()
      assert.ok(intercepted)
      assert.ok(fresh.includes(key))
      assert.ok(!fresh.includes(control))
      assert.ok(!(await fs.readdir(dir)).some(name => name === control || name.startsWith(control + '.')))
      assert.equal((await readLocalSnapshot(session, requestId, claim)).base64, pixel)
    } finally {
      fs.lstat = lstat
      syncBuiltinESMExports()
      await clearLocalSnapshots(session, requestId, [claim])
      await rm(join(dir, key), { force: true })
    }
  })

  test(`a sweep holding the ${part} lock cannot delete a successful CLI retry`, { timeout: 6000 }, async () => {
    const requestId = `sweep-first-${part}`
    const key = keyFor(requestId)
    const marker = await stage(requestId)
    const claim = JSON.parse(marker.slice('ORCA-INBOX-V1 '.length)).input.evidence[0]
    const ready = (await fs.readdir(dir)).find(name => name.startsWith(key + '.') && name.endsWith('.ready'))
    const target = join(dir, part === 'hint' ? key : ready)
    await age(target)
    let intercepted = false
    const unrelatedInput = join(root, 'unrelated.json')
    fs.rm = async (path, ...args) => {
      if (path === target && !intercepted) {
        intercepted = true
        const blocked = run()
        assert.equal(blocked.status, 1, blocked.stderr)
        assert.match(blocked.stderr, /staging is busy/)
        assert.equal(blocked.stdout, '')
        await stage('unrelated-' + part, unrelatedInput)
      }
      return rm(path, ...args)
    }
    syncBuiltinESMExports()
    try { await hints() }
    finally {
      fs.rm = rm
      syncBuiltinESMExports()
    }
    assert.ok(intercepted)
    const retry = run()
    assert.equal(retry.status, 0, retry.stderr)
    assert.equal(retry.stdout, marker)
    assert.ok((await hints()).includes(key))
    assert.equal((await readLocalSnapshot(session, requestId, claim)).base64, pixel)
  })
}

test('a publisher can recover the same lock after its owner exits in the critical section', { timeout: 6000 }, async () => {
  const requestId = 'crashed-owner'
  const key = keyFor(requestId)
  const crashed = child(`
    const { privateHintDirectory } = await import(${JSON.stringify(new URL('./backend-local.mjs', import.meta.url).href)})
    const { withSubmissionLock } = await import(${JSON.stringify(new URL('./submission-lock.mjs', import.meta.url).href)})
    await withSubmissionLock(await privateHintDirectory(true), ${JSON.stringify(key)}, 0, () => process.exit(17))
  `)
  assert.equal(crashed.status, 17, crashed.stderr)
  assert.ok((await fs.readdir(dir)).includes('.lock.' + key))
  await stage(requestId)
  assert.ok(!(await fs.readdir(dir)).includes('.lock.' + key))
  assert.ok((await hints()).includes(key))
})
