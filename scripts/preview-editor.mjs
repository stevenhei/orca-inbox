// Dev-only preview of the real review editor (`src/review.ts`: dashboard, single review, settings)
// in a local browser, with synthetic fixtures and a mock `window.orca` bridge.
//
//   npm run preview:editor                 serve on http://127.0.0.1:4870 (next free port if busy)
//   npm run preview:editor -- --port 5000
//   npm run preview:editor -- --shots DIR  headless Chrome: screenshots and layout checks, then exit
//
// URL parameters: ref=dashboard | settings | <questionId>, theme=dark|light, zone=<IANA>, history=1.
// Nothing is installed or built inside the plugin folder (Orca refuses plugins with symlinks): the
// sources compile with the pinned TypeScript into a temporary directory, which is deleted on exit.
// It reads no live Orca data; the shipping plugin never imports this script or the bridge.
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, watch, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TYPESCRIPT = '5.9.3'
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const args = process.argv.slice(2)
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const shotsDir = opt('--shots')
const tmp = mkdtempSync(path.join(process.env.PREVIEW_TMP_ROOT ?? os.tmpdir(), 'orca-inbox-preview-'))
const cleanup = () => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* already gone */ } }
process.on('exit', cleanup)
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0))

// ---- build -------------------------------------------------------------------------------------
writeFileSync(path.join(tmp, 'tsconfig.json'), JSON.stringify({
  extends: path.join(root, 'tsconfig.json'),
  compilerOptions: { noEmit: false, outDir: path.join(tmp, 'build'), rootDir: root, rewriteRelativeImportExtensions: true, allowImportingTsExtensions: false, noEmitOnError: false },
  files: [path.join(root, 'src/review.ts'), path.join(root, 'fixtures/decisions.ts')], include: []
}))
function build() {
  const t = Date.now()
  const r = spawnSync('npm', ['exec', '--yes', '--package', `typescript@${TYPESCRIPT}`, '--', 'tsc', '-p', path.join(tmp, 'tsconfig.json')], { encoding: 'utf8', cwd: root })
  copyFileSync(path.join(here, 'preview-bridge.mjs'), path.join(tmp, 'bridge.mjs'))
  const errors = `${r.stdout}${r.stderr}`.trim()
  if (errors) console.warn(`[preview] type errors (the build is still served):\n${errors}`)
  console.log(`[preview] built in ${Date.now() - t} ms`)
  return !errors
}
const page = (theme) => `<!doctype html><html lang="en" class="${theme}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Decision Inbox editor preview</title>
<style>:root{--orca-foreground:${theme === 'light' ? '#1f2328' : '#d6dae0'};--orca-background:${theme === 'light' ? '#ffffff' : '#1e1f22'}}</style>
<script type="module">
import { createMockOrca } from './bridge.mjs'
import { clock } from './build/src/client.js'
const p = new URLSearchParams(location.search)
const name = p.get('ref') ?? 'dashboard'
const ref = name === 'dashboard' ? { view: 'dashboard' } : name === 'settings' ? { view: 'settings' } : { questionId: name }
clock.now = () => Date.parse('2030-06-14T12:00:00Z') // the fixtures' clock
clock.zone = () => p.get('zone') ?? 'UTC'
window.orca = createMockOrca({ ref, history: p.has('history') })
new EventSource('/__reload').onmessage = () => location.reload()
await import('./build/src/review.js')
</script></head><body></body></html>`

// ---- serve on loopback with reload on source change --------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.map': 'application/json', '.css': 'text/css' }
const clients = new Set()
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/__reload') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }); res.write(': ok\n\n')
    clients.add(res); req.on('close', () => clients.delete(res)); return
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(page(url.searchParams.get('theme') === 'light' ? 'light' : 'dark')); return
  }
  const file = path.normalize(path.join(tmp, decodeURIComponent(url.pathname)))
  if (!file.startsWith(tmp + path.sep) || !existsSync(file)) { res.writeHead(404); res.end('Not found'); return }
  res.writeHead(200, { 'content-type': `${MIME[path.extname(file)] ?? 'application/octet-stream'}; charset=utf-8`, 'cache-control': 'no-store' })
  res.end(readFileSync(file))
})
build()
let timer = null
const onChange = () => { clearTimeout(timer); timer = setTimeout(() => { build(); for (const c of clients) c.write('data: reload\n\n'); console.log('[preview] reloaded') }, 150) }
for (const dir of ['src', 'fixtures']) watch(path.join(root, dir), { recursive: true }, (_e, f) => { if (f && /\.(ts|mts|tsx)$/.test(f) && !/\.test\./.test(f)) onChange() })
watch(path.join(here, 'preview-bridge.mjs'), onChange)

const listen = (port) => new Promise((resolve) => {
  server.once('error', (e) => { if (e.code === 'EADDRINUSE') resolve(listen(port + 1)); else throw e })
  server.listen(port, '127.0.0.1', () => resolve(port))
})
const port = await listen(Number(opt('--port') ?? 4870))
const base = `http://127.0.0.1:${port}/`
console.log(`[preview] serving the review editor at ${base}  (dashboard)`)
console.log(`[preview]   ${base}?ref=bot-item:preview:e1:0   native Item, 2 questions`)
console.log(`[preview]   ${base}?ref=preview-long             long Chinese Chat decision, sticky reply`)
console.log(`[preview]   ${base}?ref=image-review             seven images · ${base}?ref=settings · &theme=light`)
if (shotsDir) await shots(path.resolve(shotsDir)).then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })

// ---- headless screenshots and layout checks (--shots) ------------------------------------------
async function shots(dir) {
  mkdirSync(dir, { recursive: true })
  const chrome = process.env.CHROME ?? ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync)
  if (!chrome) throw new Error('No Chrome or Chromium found; set CHROME=/path/to/chrome')
  const profile = path.join(tmp, 'chrome-profile')
  const proc = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  const wsUrl = await new Promise((resolve, reject) => {
    let out = ''
    proc.stderr.on('data', (b) => { out += b; const m = /DevTools listening on (ws:\/\/\S+)/.exec(out); if (m) resolve(m[1]) })
    setTimeout(() => reject(new Error('Chrome did not start')), 15000)
  })
  // Chrome writes its profile until it exits: stop it and wait before the temp folder is removed.
  const stopChrome = () => new Promise((r) => { if (proc.exitCode !== null) return r(); proc.once('exit', r); proc.kill(); setTimeout(r, 5000) })
  try { await runShots(dir, wsUrl) } finally { await stopChrome() }
}

async function runShots(dir, wsUrl) {
  const browser = new WebSocket(wsUrl)
  await new Promise((r) => browser.addEventListener('open', r, { once: true }))
  let id = 0
  const pending = new Map()
  const events = []
  browser.addEventListener('message', (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) } else events.push(msg) })
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const n = ++id; pending.set(n, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)))
    browser.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const s = (method, params) => send(method, params, sessionId)
  await s('Page.enable'); await s('Runtime.enable')
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const evalJs = async (expr) => { const r = await s('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value }
  const open = async (query, width, height) => {
    await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await s('Page.navigate', { url: `${base}${query}` }); await wait(1500)
  }
  const shot = async (name) => { const { data } = await s('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(dir, `${name}.png`), Buffer.from(data, 'base64')); return `${name}.png` }
  const clickText = (t) => evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(t)} || x.textContent.trim().startsWith(${JSON.stringify(t)})); if (!b) return false; b.click(); return true })()`)
  const dock = () => evalJs(`(() => { const d = document.querySelector('.dock'); if (!d) return null; const r = d.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), viewport: innerHeight, scrollY: Math.round(scrollY), pageHeight: document.documentElement.scrollHeight } })()`)
  /** Column widths, dock height, sticky bar vs dock, and whether the Background heading is covered. */
  const geometry = () => evalJs(`(() => {
    const r = (sel) => { const e = document.querySelector(sel); if (!e || getComputedStyle(e).display === 'none') return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.left), w: Math.round(b.width), top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) } }
    const bg = [...document.querySelectorAll('h2')].find((h) => h.textContent === 'Background')
    let bgCovered = null
    if (bg) { const b = bg.getBoundingClientRect(); if (b.top >= 0 && b.bottom <= innerHeight) { const hit = document.elementFromPoint(b.left + 4, b.top + b.height / 2); bgCovered = !(hit === bg || bg.contains(hit)) } }
    const dk = r('.dock'), bar = r('.qbar')
    return { viewport: [innerWidth, innerHeight], queue: r('.qpane'), main: r('main'), notes: r('aside.side'), dock: dk, dockShare: dk ? +(dk.h / innerHeight).toFixed(2) : null,
      qbar: bar, barDockOverlap: !!(dk && bar && dk.top < bar.bottom), backgroundCovered: bgCovered }
  })()`)
  const checks = []
  const geometryLog = {}
  const check = (name, pass, detail) => { checks.push({ name, pass, detail }); console.log(`[shots] ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` ${JSON.stringify(detail)}` : ''}`) }
  const files = []

  for (const [w, h, label] of [[1280, 820, 'desktop-1280'], [820, 900, 'wide-820'], [390, 844, 'narrow-390']]) {
    await open('?ref=dashboard', w, h)
    files.push(await shot(`dashboard-${label}`))
    const g = await geometry(); geometryLog[`dashboard-${label}`] = g
    if (w > 800) check(`dashboard ${label}: reader column usable (≥ 420px), no Notes sidebar squeezing it, Background visible`, g.main && g.main.w >= 420 && g.backgroundCovered !== true && !g.barDockOverlap, { queue: g.queue?.w, main: g.main?.w, notes: g.notes?.w ?? null, dockShare: g.dockShare })
    const layout = await evalJs(`(() => { const q = document.querySelector('.qpane'), r = document.querySelector('.rpane'); const vis = (e) => !!e && getComputedStyle(e).display !== 'none'; return { queue: vis(q), reader: vis(r) && !!document.querySelector('.rpane h1'), rows: document.querySelectorAll('.qrow').length } })()`)
    check(`dashboard ${label}: ${w <= 800 ? 'queue only' : 'queue beside reader'}`, w <= 800 ? layout.queue && !layout.reader : layout.queue && layout.reader, layout)
    if (w <= 800) {
      await evalJs(`document.querySelectorAll('.qrow')[1].click()`); await wait(800)
      files.push(await shot(`dashboard-${label}-reader`))
      const one = await evalJs(`(() => ({ queue: getComputedStyle(document.querySelector('.qpane')).display !== 'none', title: document.querySelector('.rpane h1')?.textContent }))()`)
      check(`dashboard ${label}: one surface after selecting`, !one.queue && !!one.title, one)
    }
  }
  // Native Item with two questions: paging.
  await open('?ref=bot-item:preview:e1:0', 820, 900)
  files.push(await shot('native-820-question-1'))
  await clickText('Next'); await wait(900)
  const paged = await evalJs(`({ pager: document.querySelector('.pager')?.textContent, title: document.querySelector('h1')?.textContent })`)
  check('native paging: Next opens question 2 / 2', /Question 2 \/ 2/.test(paged.pager ?? '') && /第 2 題/.test(paged.title ?? ''), paged)
  files.push(await shot('native-820-question-2'))
  // Long Chinese Chat decision: the reply dock stays in view while scrolling.
  for (const [w, h, label] of [[820, 900, 'wide-820'], [390, 844, 'narrow-390']]) {
    await open('?ref=preview-long', w, h)
    const top = await dock()
    await evalJs('window.scrollTo(0, Math.round(document.documentElement.scrollHeight * 0.35))'); await wait(300)
    const mid = await dock()
    files.push(await shot(`chat-long-${label}-scrolled`))
    const g = await geometry(); geometryLog[`chat-long-${label}-scrolled`] = g
    check(`sticky reply dock (${label}) stays in the viewport while the question scrolls`, !!mid && mid.bottom <= mid.viewport + 1 && mid.top < mid.viewport, { atTop: top, scrolled: mid })
    check(`compact dock (${label}) ≤ 35% of the viewport; sticky question bar visible and not overlapped`, g.dockShare <= 0.35 && !!g.qbar && g.qbar.top === 0 && !g.barDockOverlap, { dockShare: g.dockShare, qbar: g.qbar, dock: g.dock })
    // Keyboard: focus Expand reply, press Enter, the full composer opens with focus in the reply box.
    await evalJs(`document.querySelector('[data-k="dock-toggle"]').focus()`)
    // A real Enter key press (with its character), which activates the focused button.
    await s('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' })
    await s('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await wait(400)
    const open1 = await evalJs(`({ open: document.querySelector('.dock').classList.contains('open'), expanded: document.querySelector('[data-k="dock-toggle"]').getAttribute('aria-expanded'), focus: document.activeElement?.getAttribute('data-k'), rows: document.querySelector('[data-k="reply"]').rows })`)
    files.push(await shot(`chat-long-${label}-expanded`))
    const ge = await geometry(); geometryLog[`chat-long-${label}-expanded`] = ge
    check(`Expand reply (${label}) by keyboard opens the full composer`, open1.open && open1.expanded === 'true' && open1.focus === 'reply' && open1.rows === 6, { ...open1, dockShare: ge.dockShare })
  }
  // Real Chrome anchors for the multi-link CJK sentence (in the long decision's recommendation).
  await open('?ref=preview-long', 820, 900)
  const anchors = await evalJs(`(() => { const p = [...document.querySelectorAll('[data-field="recommendation"] p')].at(-2); return { links: [...p.querySelectorAll('a')].map((a) => [a.href, a.textContent]), texts: [...p.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent) } })()`)
  check('link boundaries in Chrome: hrefs, link text and following CJK text', JSON.stringify(anchors) === JSON.stringify({
    links: [['https://a.invalid/1', 'https://a.invalid/1'], ['https://b.invalid/2', 'https://b.invalid/2'], ['https://en.wikipedia.org/wiki/A_(b)', 'C 文件'], ['https://example.invalid/run/42', 'https://example.invalid/run/42']],
    texts: ['參考 ', '、', ' 與 ', '，另見 ', '。下一句不是連結。'] }), anchors)
  const d1 = await evalJs(`(() => { const p = [...document.querySelectorAll('[data-field="recommendation"] p')].at(-1); return { links: [...p.querySelectorAll('a')].map((a) => [a.href, a.textContent]), texts: [...p.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent) } })()`)
  check('unmatched ], non-http(s) label and IPv6 in Chrome: anchors and plain text', JSON.stringify(d1) === JSON.stringify({
    links: [['https://example.invalid/x', 'https://example.invalid/x'], ['http://[::1]:8080/a', 'http://[::1]:8080/a']],
    texts: ['see [', '] here, ', 'https://ok.invalid', ' ', '(javascript:alert(1))', ' and ', '.'] }), d1)
  await evalJs(`[...document.querySelectorAll('[data-field="recommendation"] p')].at(-1).scrollIntoView({ block: 'center' })`); await wait(200)
  files.push(await shot('links-820'))
  // Draft survives an editor source change (reload).
  await open('?ref=preview-long', 820, 900)
  await evalJs(`(() => { const t = document.querySelector('[aria-label="Reply text"]'); t.value = 'Tuesday after 3pm'; t.dispatchEvent(new Event('input', { bubbles: true })); window.__beforeReload = true })()`)
  await wait(700)
  const now = new Date(); utimesSync(path.join(root, 'src/review.ts'), now, now) // touch only: no content change
  await wait(6000)
  const after = await evalJs(`({ reloaded: !window.__beforeReload, text: document.querySelector('[aria-label="Reply text"]')?.value })`)
  check('editing a source reloads the page and keeps the draft', after.reloaded && after.text === 'Tuesday after 3pm', after)
  // Seven images and settings, for the record.
  await open('?ref=image-review', 1280, 820); files.push(await shot('images-1280'))
  await open('?ref=settings&theme=light', 820, 900); files.push(await shot('settings-820-light'))
  // Native reader uses the full column (no empty sidebar column).
  for (const [w, h, label] of [[1280, 820, 'desktop-1280'], [820, 900, 'wide-820'], [390, 844, 'narrow-390']]) {
    await open('?ref=bot-item:preview:e1:0', w, h)
    const g = await geometry(); geometryLog[`native-${label}`] = g
    files.push(await shot(`native-${label}`))
    check(`native reader (${label}) uses the available column`, g.main && g.main.w >= Math.min(w, 1120) - 60, { main: g.main?.w, viewport: w })
  }
  writeFileSync(path.join(dir, 'checks.json'), JSON.stringify({ base, checks, files, geometry: geometryLog }, null, 2))
  browser.close()
  const failed = checks.filter((c) => !c.pass).length
  console.log(`[shots] ${files.length} screenshots and checks.json in ${dir}; ${failed ? `${failed} check(s) FAILED` : 'all checks passed'}`)
  if (failed) throw new Error('preview checks failed')
}
