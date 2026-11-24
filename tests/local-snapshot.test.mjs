import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { rasterMime } from '../src/local/raster-metadata.mjs'

const images = {
  'png': 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==',
  'jpeg': '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z',
  'gif': 'R0lGODdhAgACAIEAAP8AAAAAAAAAAAAAACwAAAAAAgACAAAIBgABCAQQEAA7',
  'webp': 'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAIAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=',
}

test('raster metadata accepts complete containers and rejects truncated or excessive dimensions', () => {
  for (const [format, data] of Object.entries(images)) {
    const bytes = Buffer.from(data, 'base64')
    assert.equal(rasterMime(bytes), 'image/' + format)
    assert.equal(rasterMime(bytes.subarray(0, 14)), undefined)
    const oversized = Buffer.from(bytes)
    if (format === 'png') oversized.writeUInt32BE(8193, 16)
    if (format === 'gif') oversized.writeUInt16LE(8193, 6)
    if (format === 'jpeg') oversized.writeUInt16BE(8193, oversized.indexOf(Buffer.from([0xff, 0xc0])) + 7)
    if (format === 'webp') oversized.writeUInt16LE(8193, 26)
    assert.equal(rasterMime(oversized), undefined)
  }
})

test('CLI bounds manifest files, accepts CJK and leaves no partial attachments on failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inbox-cli-files-'))
  const hintDir = join(root, '.orca-decision-inbox', 'hints')
  const manifest = join(root, 'input.json')
  const script = new URL('../agent/decision-inbox/inbox.mjs', import.meta.url).href
  const session = 'a2fb54cf-fd4c-4fac-801d-7fe8161c71ff'
  const run = (path, args = []) => spawnSync(process.execPath, ['--input-type=module', '-e', `
    import os from 'node:os'
    import { syncBuiltinESMExports } from 'node:module'
    os.homedir = () => ${JSON.stringify(root)}
    syncBuiltinESMExports()
    process.argv = ['node', 'inbox.mjs', 'submit', ...process.argv.slice(1)]
    await import(${JSON.stringify(script)})
  `, '--', path, ...args], { encoding: 'utf8', timeout: 2500,
    env: { ...process.env, ORCA_AGENT_SESSION_ID: session, ORCA_BOT_TOOLS_TOKEN: '' } })
  try {
    const cjk = '界'.repeat(30_000)
    await writeFile(manifest, JSON.stringify({ requestId: 'cjk', summary: cjk }))
    const accepted = run(manifest)
    assert.equal(accepted.status, 0, accepted.stderr)
    assert.equal(JSON.parse(accepted.stdout.slice('ORCA-INBOX-V1 '.length)).input.summary, cjk)
    const before = await readdir(hintDir)
    await writeFile(manifest, ' '.repeat(96_001))
    assert.equal(run(manifest).status, 1)
    await writeFile(manifest, JSON.stringify({ requestId: 'too-long', summary: '字'.repeat(32_001) }))
    assert.equal(run(manifest).status, 1)
    if (process.platform !== 'win32') {
      const fifo = join(root, 'fifo')
      execFileSync('mkfifo', [fifo])
      assert.equal(run(fifo).status, 1)
    }
    const png = join(root, 'valid.png')
    const bad = join(root, 'bad.png')
    await writeFile(png, Buffer.from(images.png, 'base64'))
    await writeFile(bad, Buffer.from(images.png, 'base64').subarray(0, 8))
    const evidence = ['first', 'second'].map(evidenceId => ({ kind: 'image-snapshot', evidenceId, version: 1 }))
    await writeFile(manifest, JSON.stringify({ requestId: 'bad-batch', evidence }))
    assert.equal(run(manifest, ['--image', 'first', '1', png, '--image', 'second', '1', bad]).status, 1)
    assert.deepEqual(await readdir(hintDir), before)
    await writeFile(manifest, JSON.stringify({ requestId: 'failed-hint', evidence: [evidence[0]] }))
    const blockedHint = `submit.${session}.failed-hint`
    await mkdir(join(hintDir, blockedHint))
    assert.equal(run(manifest, ['--image', 'first', '1', png]).status, 1)
    assert.deepEqual((await readdir(hintDir)).sort(), [...before, blockedHint].sort())
    await writeFile(manifest, JSON.stringify({ requestId: 'valid-image', evidence: [evidence[0]] }))
    const staged = run(manifest, ['--image', 'first', '1', png])
    assert.equal(staged.status, 0, staged.stderr)
    const token = JSON.parse(staged.stdout.slice('ORCA-INBOX-V1 '.length)).input.evidence[0].attachmentId
    assert.match(token, /^local-image:[0-9a-f]{64}$/)
    assert.ok(!staged.stdout.includes(png) && !staged.stdout.includes(images.png))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('PNG IHDR accepts legal examples and rejects invalid combinations and method fields', () => {
  const valid = [
    images.png,
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQAAAABazTCJAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC',
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAgMAAAAP2OW3AAAADFBMVEUAAAAAAAAAAAAAAAA16TeWAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC',
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACEAAAAAAHTY67AAAAC0lEQVR4nGNggAEAAAoAAX+AdF4AAAAASUVORK5CYII=',
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAC0lEQVR4nGNgQAcAABIAAXfx+gAAAAAASUVORK5CYII=',
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAQAAADYv8WvAAAAC0lEQVR4nGNggAEAAAoAAX+AdF4AAAAASUVORK5CYII='
  ]
  for (const example of valid) assert.equal(rasterMime(Buffer.from(example, 'base64')), 'image/png')
  // Corrupt just the selected IHDR field. Checksums and pixels are outside this test.
  for (const [field, value] of [[24, 4], [25, 5], [26, 1], [27, 1], [28, 2]]) {
    const bytes = Buffer.from(images.png, 'base64')
    bytes[field] = value
    assert.equal(rasterMime(bytes), undefined)
  }
  const indexed = Buffer.from(valid[2], 'base64')
  indexed[24] = 16
  assert.equal(rasterMime(indexed), undefined)
})

test('a failed publisher cannot roll back bytes committed by an overlapping CLI process', { timeout: 7000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'inbox-cli-overlap-'))
  const session = 'a2fb54cf-fd4c-4fac-801d-7fe8161c71ff'
  const request = 'overlap'
  const image = join(root, 'image.png')
  const manifest = join(root, 'input.json')
  const evidence = { kind: 'image-snapshot', evidenceId: 'sample', version: 2 }
  const module = new URL('../src/local/local-snapshot.mjs', import.meta.url).href
  const cli = new URL('../agent/decision-inbox/inbox.mjs', import.meta.url).href
  const home = `
    import os from 'node:os'
    import { syncBuiltinESMExports } from 'node:module'
    os.homedir = () => ${JSON.stringify(root)}
    syncBuiltinESMExports()
  `
  const nodeArgs = code => ['--input-type=module', '-e', home + code]
  let first
  try {
    await writeFile(image, Buffer.from(images.png, 'base64'))
    await writeFile(manifest, JSON.stringify({ requestId: request, evidence: [evidence] }))
    first = spawn(process.execPath, nodeArgs(`
      const { prepareLocalSnapshot, publishLocalSnapshots } = await import(${JSON.stringify(module)})
      const snapshot = await prepareLocalSnapshot(${JSON.stringify(session)}, ${JSON.stringify(request)},
        ${JSON.stringify(evidence)}, ${JSON.stringify(image)})
      try {
        await publishLocalSnapshots([snapshot], async () => {
          console.log('reserved')
          await new Promise(resolve => process.stdin.once('data', resolve))
          throw new Error('Synthetic failed hint')
        })
      } catch (error) {
        if (error.message !== 'Synthetic failed hint') throw error
        process.exit(7)
      }
    `))
    const completed = once(first, 'close')
    const output = createInterface({ input: first.stdout })
    const next = output[Symbol.asyncIterator]()
    assert.deepEqual(await next.next(), { value: 'reserved', done: false })
    const args = [manifest, '--image', 'sample', '2', image]
    const publish = () => spawnSync(process.execPath, [...nodeArgs(`
      process.argv = ['node', 'inbox.mjs', 'submit', ...process.argv.slice(1)]
      await import(${JSON.stringify(cli)})
    `), '--', ...args], { encoding: 'utf8', timeout: 2500,
      env: { ...process.env, ORCA_AGENT_SESSION_ID: session, ORCA_BOT_TOOLS_TOKEN: '' } })
    const second = publish()
    assert.equal(second.status, 0, second.stderr)
    first.stdin.end('fail')
    assert.deepEqual(await completed, [7, null])
    const staged = JSON.parse(second.stdout.slice('ORCA-INBOX-V1 '.length)).input.evidence[0]
    const imported = spawnSync(process.execPath, nodeArgs(`
      const { scanHints } = await import(${JSON.stringify(new URL('../src/local/backend-local.mjs', import.meta.url).href)})
      if (!(await scanHints()).names.includes(${JSON.stringify(`submit.${session}.${request}`)})) throw new Error('Missing hint')
      const { readLocalSnapshot } = await import(${JSON.stringify(module)})
      const image = await readLocalSnapshot(${JSON.stringify(session)}, ${JSON.stringify(request)}, ${JSON.stringify(staged)})
      console.log(JSON.stringify(image))
    `), { encoding: 'utf8', timeout: 2500 })
    assert.equal(imported.status, 0, imported.stderr)
    assert.deepEqual(JSON.parse(imported.stdout), { mimeType: 'image/png', base64: images.png })
    const dir = join(root, '.orca-decision-inbox', 'hints')
    const remaining = await readdir(dir)
    assert.equal(remaining.filter(path => path.endsWith('.image')).length, 1)
    assert.equal(publish().stdout, second.stdout)
    assert.deepEqual((await readdir(dir)).sort(), remaining.sort())
    output.close()
  } finally {
    first?.kill()
    await rm(root, { recursive: true, force: true })
  }
})

test('identical CLI retries refresh expired hints and ready images before the first sweep', { timeout: 7000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'inbox-cli-renew-'))
  const session = 'a2fb54cf-fd4c-4fac-801d-7fe8161c71ff'
  const dir = join(root, '.orca-decision-inbox', 'hints')
  const image = join(root, 'image.png')
  const manifest = join(root, 'input.json')
  const evidence = { kind: 'image-snapshot', evidenceId: 'sample', version: 2 }
  const prefix = `submit.${session}.`
  const old = new Date(Date.now() - 3_700_000)
  const node = (code, args = []) => spawnSync(process.execPath, ['--input-type=module', '-e', `
    import os from 'node:os'
    import { syncBuiltinESMExports } from 'node:module'
    os.homedir = () => ${JSON.stringify(root)}
    syncBuiltinESMExports()
    ${code}
  `, '--', ...args], { encoding: 'utf8', timeout: 2500,
    env: { ...process.env, ORCA_AGENT_SESSION_ID: session, ORCA_BOT_TOOLS_TOKEN: '' } })
  const publish = () => {
    const result = node(`
      process.argv = ['node', 'inbox.mjs', 'submit', ...process.argv.slice(1)]
      await import(${JSON.stringify(new URL('../agent/decision-inbox/inbox.mjs', import.meta.url).href)})
    `, [manifest, '--image', 'sample', '2', image])
    assert.equal(result.status, 0, result.stderr)
    return result.stdout
  }
  try {
    await writeFile(image, Buffer.from(images.png, 'base64'))
    const renewed = []
    for (const requestId of ['both-expired', 'hint-expired', 'image-expired', 'abandoned']) {
      await writeFile(manifest, JSON.stringify({ requestId, evidence: [evidence] }))
      const marker = publish()
      const key = prefix + requestId
      const entries = (await readdir(dir)).filter(name => name === key || name.startsWith(key + '.'))
      assert.equal(entries.length, 3)
      for (const name of entries) {
        if (requestId === 'hint-expired' && name !== key) continue
        if (requestId === 'image-expired' && name === key) continue
        await utimes(join(dir, name), old, old)
      }
      if (requestId === 'abandoned') continue
      assert.equal(publish(), marker)
      assert.deepEqual((await readdir(dir)).filter(name => name === key || name.startsWith(key + '.')).sort(), entries.sort())
      renewed.push(JSON.parse(marker.slice('ORCA-INBOX-V1 '.length)).input)
    }
    const result = node(`
      const { scanHints } = await import(${JSON.stringify(new URL('../src/local/backend-local.mjs', import.meta.url).href)})
      const { readLocalSnapshot } = await import(${JSON.stringify(new URL('../src/local/local-snapshot.mjs', import.meta.url).href)})
      const keys = (await scanHints()).names.sort()
      const images = []
      for (const { requestId, evidence } of ${JSON.stringify(renewed)}) {
        images.push(await readLocalSnapshot(${JSON.stringify(session)}, requestId, evidence[0]))
      }
      console.log(JSON.stringify({ keys, images }))
    `)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), {
      keys: renewed.map(({ requestId }) => prefix + requestId).sort(),
      images: renewed.map(() => ({ mimeType: 'image/png', base64: images.png }))
    })
    assert.ok(!(await readdir(dir)).some(name => name.startsWith(prefix + 'abandoned')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
