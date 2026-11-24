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
console.log(`[preview]   ${base}?ref=image-review             seven images · ${base}?ref=preview-narrative  narrative, inline images`)
console.log(`[preview]   ${base}?ref=settings · &theme=light · &history=1`)
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
  /** Variant D geometry: tabs row and workspace picker, table, sheet, its scrolling body and the reply card. */
  const geometry = () => evalJs(`(() => {
    const r = (sel) => { const e = document.querySelector(sel); if (!e || getComputedStyle(e).display === 'none' || e.closest('[hidden]')) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.left), right: Math.round(b.right), w: Math.round(b.width), top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) } }
    const body = document.querySelector('.d-sheet-body')
    return { viewport: [innerWidth, innerHeight], tabsRow: r('.d-tabs-row'), tabs: r('.d-tabs'), ws: r('.d-ws-select'), table: r('.d-table-wrap'), sheet: r('.d-sheet'), body: r('.d-sheet-body'), dock: r('.d-dock'),
      send: r('[data-k="send"]'), reply: r('[data-k="reply"]'), pager: r('.d-dock .d-pager'),
      bodyScrolls: body ? body.scrollHeight > body.clientHeight + 4 : null, pageScrolls: document.documentElement.scrollHeight > innerHeight + 1,
      dockShare: document.querySelector('.d-dock') ? +(document.querySelector('.d-dock').getBoundingClientRect().height / innerHeight).toFixed(2) : null }
  })()`)
  /** Every button has an accessible name made of words (not just a glyph). */
  const unlabelled = () => evalJs(`[...document.querySelectorAll('button')].filter((b) => !b.closest('[hidden]') && !(b.getAttribute('aria-label') || '').trim() && !/[\\p{L}\\p{N}]/u.test(b.textContent)).map((b) => b.outerHTML.slice(0, 80))`)
  const checks = []
  const geometryLog = {}
  const check = (name, pass, detail) => { checks.push({ name, pass, detail }); console.log(`[shots] ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` ${JSON.stringify(detail)}` : ''}`) }
  const files = []
  const key = async (k, code, vk, text) => {
    await s('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, ...(text ? { text, unmodifiedText: text } : {}) })
    await s('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk })
  }
  const SIZES = [[1920, 1080, 'ultra-1920'], [1603, 656, 'short-1603'], [1280, 820, 'desktop-1280'], [820, 900, 'wide-820'], [390, 844, 'narrow-390']]

  // ---- dashboard: tabs row, workspace picker, grouped table, sheet ----
  for (const [w, h, label] of SIZES) {
    await open('?ref=dashboard', w, h)
    files.push(await shot(`dashboard-${label}`))
    const g0 = await geometry(); geometryLog[`dashboard-${label}`] = g0
    // Owner note 1: the workspace selector sits at the right end of the tabs row, on the same line.
    check(`note 1 (${label}): workspace selector at the top right of the tabs row`, !!g0.ws && !!g0.tabsRow && Math.abs(g0.ws.right - g0.tabsRow.right) <= 2 && g0.ws.top < g0.tabs.bottom && g0.ws.bottom > g0.tabs.top, { ws: g0.ws, tabsRow: g0.tabsRow, tabs: g0.tabs })
    // Owner note 2: no "Question x/N" in table rows.
    const rowsText = await evalJs(`[...document.querySelectorAll('tr.d-row')].map((r) => r.textContent)`)
    const cells = await evalJs(`[...document.querySelectorAll('tr.d-row')].map((r) => { const th = r.querySelector('th'); return { only: th.children.length === 1 && th.textContent === th.querySelector('.qt').textContent, extra: th.querySelectorAll('.d-tag,.d-pill,.d-sub,.chip,.badge').length } })`)
    check(`annotation 1 (${label}): question cell holds only the question text`, cells.length > 0 && cells.every((c) => c.only && !c.extra), { rows: cells.length })
    check(`note 2 (${label}): no "Question x/N" in ${rowsText.length} table rows`, rowsText.length > 0 && !rowsText.some((t) => /Question\s*\d+\s*(\/|of)\s*\d+/i.test(t)), { rows: rowsText.length })
    await evalJs(`document.querySelector('.qrow').click()`); await wait(900)
    files.push(await shot(`dashboard-${label}-sheet`))
    const g = await geometry(); geometryLog[`dashboard-${label}-sheet`] = g
    const narrow = w < 900
    check(`dashboard ${label}: ${narrow ? 'sheet covers the list (modal)' : 'sheet beside the table, full height'}`, !!g.sheet && (narrow ? g.sheet.w >= w - 1 : g.table && g.sheet.x >= g.table.right - 1 && g.sheet.top <= 1 && g.sheet.bottom >= h - 1), { sheet: g.sheet, table: g.table })
    check(`note 4 (${label}): reply card in view, body scrolls on its own, page does not scroll`, !!g.dock && g.dock.bottom <= h + 1 && !!g.send && g.send.bottom <= h + 1 && !g.pageScrolls, { dock: g.dock, send: g.send, bodyScrolls: g.bodyScrolls, pageScrolls: g.pageScrolls })
    const sel = await evalJs(`({ rowSel: !!document.querySelector('tr.d-row[data-sel] .qrow[aria-current="true"]'), modal: document.querySelector('.d-sheet')?.getAttribute('aria-modal'), inert: document.querySelector('.d-list-side').hasAttribute('inert') })`)
    check(`dashboard ${label}: selected row marked; modal and inert list only when narrow`, (narrow || sel.rowSel) && sel.modal === String(narrow) && sel.inert === narrow, sel)
    const bad = await unlabelled()
    check(`note 4 (${label}): every icon control has a label`, bad.length === 0, bad.length ? { bad } : undefined)
    // Esc closes the sheet and returns focus to the row.
    await evalJs(`document.querySelector('[data-k="reply"]')?.blur(); document.querySelector('.d-sheet-body').focus()`)
    await key('Escape', 'Escape', 27); await wait(400)
    const closed = await evalJs(`({ sheet: !!document.querySelector('.d-sheet'), focus: document.activeElement?.classList.contains('qrow') })`)
    check(`dashboard ${label}: Esc closes the sheet and focuses the row`, !closed.sheet && closed.focus, closed)
  }
  // Pending / Answered / All with the answered history fixture; arrow keys move between tabs.
  await open('?ref=dashboard&history=1', 1280, 820)
  await evalJs(`(() => { const w = document.querySelector('[data-k="ws-select"]'); w.value = 'all'; w.dispatchEvent(new Event('change', { bubbles: true })) })()`); await wait(800)
  await evalJs(`document.querySelector('[data-k="tab-pending"]').focus()`)
  await key('ArrowRight', 'ArrowRight', 39); await wait(300)
  const tabs = await evalJs(`({ sel: document.querySelector('[role=tab][aria-selected=true]')?.id, focus: document.activeElement?.id, rows: document.querySelectorAll('tr.d-row').length, counts: [...document.querySelectorAll('.d-tab')].map((t) => t.textContent) })`)
  check('tabs: ArrowRight moves to Answered and shows answered rows', tabs.sel === 'tab-answered' && tabs.focus === 'tab-answered' && tabs.rows > 0, tabs)
  files.push(await shot('dashboard-1280-answered'))

  // ---- owner note 3 and 5: reply card and narrative (seven inline images) ----
  for (const [w, h, label] of SIZES) {
    await open('?ref=preview-narrative', w, h)
    files.push(await shot(`narrative-${label}`))
    const g = await geometry(); geometryLog[`narrative-${label}`] = g
    const n = await evalJs(`(() => {
      const recs = [...document.querySelectorAll('[data-field="recommendation"]')]
      return { recs: recs.length, recInDock: recs.every((r) => r.closest('.d-dock')), recText: document.body.textContent.split('Use Side square as the baseline').length - 1,
        pagerInDock: !document.querySelector('.d-sheet-body .pager'),
        headings: [...document.querySelectorAll('.rich .rich-h')].map((h) => h.tagName + ':' + h.textContent),
        figures: document.querySelectorAll('.rich figure.fig').length, unavailable: document.querySelectorAll('.rich figure.fig.unavailable').length,
        captions: [...document.querySelectorAll('.rich figcaption > span:first-child')].map((c) => c.textContent),
        code: document.querySelector('.codeblock pre')?.textContent, copy: document.querySelector('.codeblock .code-copy')?.getAttribute('aria-label'),
        scripts: document.querySelectorAll('.d-sheet script, .d-sheet iframe').length, links: [...document.querySelectorAll('.rich a')].map((a) => a.href),
        imgsLoaded: [...document.querySelectorAll('.rich figure img')].filter((i) => i.complete && i.naturalWidth > 0).length }
    })()`)
    check(`note 3 (${label}): recommendation shown once, in the reply card`, n.recs === 1 && n.recInDock && n.recText === 1 && n.pagerInDock, n)
    check(`note 5 (${label}): narrative headings, link, inert code with Copy, 7 placed images (1 unavailable) with captions`, n.headings.length === 3 && n.figures === 7 && n.unavailable === 1 && n.imgsLoaded === 6 &&
      n.captions[0].startsWith('Front wide') && /npm run fold/.test(n.code ?? '') && n.copy === 'Copy sh code' && n.scripts === 0 && n.links[0] === 'https://example.invalid/guide', n)
    check(`note 4 (${label}): reply card in view with the body scrolling inside the sheet`, !!g.send && g.send.bottom <= h + 1 && g.bodyScrolls && !g.pageScrolls && g.dockShare <= 0.62, { dock: g.dock, dockShare: g.dockShare, bodyScrolls: g.bodyScrolls })
    await evalJs(`document.querySelector('.d-sheet-body').scrollTop = 99999`); await wait(300)
    files.push(await shot(`narrative-${label}-end`))
  }
  // Short viewport / on-screen keyboard: the visible height shrinks to 420px with the reply box focused.
  for (const [w, h, label] of [[390, 420, 'keyboard-390x420'], [1280, 480, 'short-1280x480']]) {
    await open('?ref=preview-narrative', w, h)
    await evalJs(`document.querySelector('[data-k="reply"]').focus()`); await wait(200)
    const g = await geometry(); geometryLog[`narrative-${label}`] = g
    files.push(await shot(`narrative-${label}`))
    check(`note 4 (${label}): focused reply box and Submit not clipped`, !!g.reply && g.reply.top >= 0 && g.reply.bottom <= h && !!g.send && g.send.bottom <= h + 1 && g.dock.top >= 0 && !g.pageScrolls, { reply: g.reply, send: g.send, dock: g.dock })
  }
  // Notes open in the reply card (wide) and as a dialog (narrow).
  await open('?ref=preview-narrative', 1280, 820)
  await evalJs(`document.querySelector('[data-k="notes-open"]').click()`); await wait(300)
  const notes = await evalJs(`(() => { const p = document.querySelector('#notesPanel'); const b = p?.getBoundingClientRect(); return { open: !!p && !p.hidden, expanded: document.querySelector('[data-k="notes-open"]').getAttribute('aria-expanded'), inDock: !!p?.closest('.d-dock'), top: b && Math.round(b.top), bottom: b && Math.round(b.bottom) } })()`)
  files.push(await shot('narrative-1280-notes'))
  check('notes panel opens from the reply card, above it', notes.open && notes.expanded === 'true' && notes.inDock && notes.top >= 0, notes)
  // ---- second round of owner annotations (2–6) in real Chrome ----
  for (const [w, h, label] of [[1280, 820, 'desktop-1280'], [390, 844, 'narrow-390']]) {
    await open('?ref=preview-narrative', w, h)
    const top = await evalJs(`(() => { const p = document.querySelector('.d-progress'); const b = p.getBoundingClientRect(); return { visible: !p.closest('details') && b.top >= 0 && b.bottom <= innerHeight, text: p.textContent,
      acts: [...document.querySelectorAll('.d-src-act')].map((a) => [a.getAttribute('aria-label'), a.getAttribute('href')]) } })()`)
    check(`annotation 3 (${label}): state card visible near the top without expanding`, top.visible && /Awaiting answer/.test(top.text) && /No answer saved yet/.test(top.text) && !/Agent received/.test(top.text), top)
    check(`annotation 6 (${label}): deduplicated https source actions and Copy session ID`, JSON.stringify(top.acts) === JSON.stringify([['Open GitHub issue paper/fold#12', 'https://github.com/example/paper/issues/12'], ['Open GitHub pull request paper/fold#13', 'https://github.com/example/paper/pull/13'], ['Open Linear issue PAP-7', 'https://linear.app/example/issue/PAP-7'], ['Copy session ID of the original chat', null]]), top.acts)
    // Use PM recommendation selects the recommended option by its ID; nothing is sent.
    await evalJs(`(() => { const t = document.querySelector('[data-k="reply"]'); t.value = 'keep this'; t.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await evalJs(`document.querySelector('[data-k="use-rec"]').click()`); await wait(300)
    const ask = await evalJs(`({ confirm: document.querySelector('.d-confirm')?.textContent, focus: document.activeElement?.getAttribute('data-k') })`)
    files.push(await shot(`annotations-${label}-rec-confirm`))
    await evalJs(`document.querySelector('[data-k="rec-replace"]').click()`); await wait(500)
    const rec = await evalJs(`({ checked: document.querySelector('[data-k="opt-side"]').checked, text: document.querySelector('[data-k="reply"]').value, state: document.querySelector('.d-state-pill').textContent, proposed: document.querySelector('.d-proposed')?.textContent })`)
    check(`annotation 5 (${label}): existing draft asks first (Keep focused); Replace selects “Side square”, sends nothing`, /Replace your draft/.test(ask.confirm ?? '') && ask.focus === 'rec-keep' && rec.checked && rec.text === '' && rec.state === '● Awaiting answer' && /Proposed from the PM recommendation/.test(rec.proposed ?? ''), { ask, rec })
    files.push(await shot(`annotations-${label}-use-rec`))
    await evalJs(`document.querySelector('[data-k="rec-undo"]').click()`); await wait(400)
    const undo = await evalJs(`({ text: document.querySelector('[data-k="reply"]').value, checked: document.querySelector('[data-k="opt-side"]').checked })`)
    check(`annotation 5 (${label}): Undo restores the owner's draft`, undo.text === 'keep this' && !undo.checked, undo)
    // Ctrl+Enter in a note field saves the note only.
    await evalJs(`document.querySelector('[data-k^="fig-note-"]').click()`); await wait(400)
    await evalJs(`(() => { const n = document.activeElement; n.value = 'fold depth'; n.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await s('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 2, text: '\r' })
    await s('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 2 }); await wait(700)
    const ns = await evalJs(`({ state: document.querySelector('.d-state-pill').textContent.replace('● ', ''), said: document.querySelector('[aria-live]')?.textContent ?? '', notes: document.querySelector('[data-k="notes-open"]').textContent, dialog: !!document.querySelector('dialog[open]') })`)
    check(`annotation 2 (${label}): Ctrl+Enter in a note saves it and does not submit`, ns.state === 'Awaiting answer' && /Notes \([1-9]/.test(ns.notes), ns)
    files.push(await shot(`annotations-${label}-note`))
    await evalJs(`document.querySelector('dialog[open]')?.close()`); await wait(300)
    // Image viewer: viewport-level, fit, zoom, pan, Esc, focus and scroll restored.
    await evalJs(`(() => { const b = document.querySelector('.d-sheet-body'); const f = document.querySelector('[data-k="fig-open-model-3"]'); f.scrollIntoView({ block: 'center' }); window.__top = b.scrollTop })()`); await wait(300)
    await evalJs(`document.querySelector('[data-k="fig-open-model-3"]').click()`); await wait(600)
    const fit = await evalJs(`(() => { const z = document.querySelector('.d-zoom'), i = z.querySelector('img'); const zr = z.getBoundingClientRect(), ir = i.getBoundingClientRect(), sh = document.querySelector('.d-sheet').getBoundingClientRect()
      return { overlay: [Math.round(zr.left), Math.round(zr.top), Math.round(zr.width), Math.round(zr.height)], viewport: [innerWidth, innerHeight], sheetW: Math.round(sh.width), natural: i.naturalWidth, img: [Math.round(ir.left), Math.round(ir.top), Math.round(ir.right), Math.round(ir.bottom)], focus: document.activeElement.getAttribute('aria-label'), outside: !z.closest('.d-sheet') } })()`)
    check(`annotation 4 (${label}): viewer covers the viewport (not the sheet), image pixels fit inside`, fit.outside && fit.overlay[0] === 0 && fit.overlay[1] === 0 && fit.overlay[2] === w && fit.overlay[3] === h && fit.natural > 0 && fit.img[0] >= 0 && fit.img[1] >= 0 && fit.img[2] <= w && fit.img[3] <= h && fit.focus === 'Close image', fit)
    files.push(await shot(`zoom-${label}-fit`))
    await evalJs(`document.querySelector('[data-zk="in"]').click(); document.querySelector('[data-zk="in"]').click()`); await wait(200)
    const z1 = await evalJs(`(() => { const i = document.querySelector('.d-zoom img').getBoundingClientRect(); return { w: Math.round(i.width), level: document.querySelector('.d-zoom-level').textContent, t: document.querySelector('.d-zoom img').style.transform } })()`)
    await s('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(w / 2), y: Math.round(h / 2), button: 'left', clickCount: 1 })
    await s('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(w / 2) + 60, y: Math.round(h / 2) + 40, button: 'left', buttons: 1 })
    await s('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(w / 2) + 60, y: Math.round(h / 2) + 40, button: 'left', clickCount: 1 }); await wait(200)
    const z2 = await evalJs(`({ t: document.querySelector('.d-zoom img').style.transform, pageScroll: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight })`)
    check(`annotation 4 (${label}): zoom in to 225% and drag to pan, no page overflow`, z1.level === '225%' && z1.w > fit.img[2] - fit.img[0] && z2.t !== z1.t && !/translate\(0px, 0px\)/.test(z2.t) && !z2.pageScroll, { z1, z2 })
    files.push(await shot(`zoom-${label}-panned`))
    await key('Escape', 'Escape', 27); await wait(400)
    const closed = await evalJs(`({ overlay: !!document.querySelector('.d-zoom'), sheet: !!document.querySelector('.d-sheet'), focus: document.activeElement?.getAttribute('data-k'), top: Math.round(document.querySelector('.d-sheet-body').scrollTop), was: Math.round(window.__top) })`)
    check(`annotation 4 (${label}): Esc closes the viewer only; focus and scroll restored`, !closed.overlay && closed.sheet && closed.focus === 'fig-open-model-3' && Math.abs(closed.top - closed.was) <= 2, closed)
  }
  // ---- third round: sections, note composer, resizable sheet ----
  for (const [w, h, label] of [[1920, 1080, 'ultra-1920'], [1280, 820, 'desktop-1280'], [820, 900, 'wide-820'], [390, 844, 'narrow-390']]) {
    await open('?ref=preview-narrative', w, h)
    // Start each size from an empty draft (the preview keeps drafts in session storage).
    await evalJs('sessionStorage.clear()'); await open('?ref=preview-narrative', w, h)
    const sec = await evalJs(`({ heads: [...document.querySelectorAll('.d-sheet-body h2.d-sec-h')].map((h) => h.textContent), bgBeforeDesc: (() => { const a = document.querySelector('#secBackground'), b = document.querySelector('#secDescription'); return !!a && !!b && !!(a.compareDocumentPosition(b) & 4) && !b.previousElementSibling.closest('[data-field="background"]') === false })(), descText: document.querySelector('#secDescription + .d-desc')?.textContent, bgFirst: document.querySelector('#secBackground + [data-field="background"] .rich-h')?.textContent })`)
    check(`sections (${label}): Background then Description, each once, content under its own heading`, sec.bgBeforeDesc && /comparison baseline/.test(sec.descText ?? '') && sec.bgFirst === 'What changed' && sec.heads.filter((t) => t === 'Description').length === 1 && sec.heads.filter((t) => t === 'Background').length === 1, sec)
    // Text note: select a phrase, Add note, write, Ctrl+Enter.
    await evalJs(`(() => { const b = document.querySelector('.d-sheet-body'); b.scrollTop = 0; const p = document.querySelector('[data-field="background"] p'); p.scrollIntoView({ block: 'center' }); const t = [...p.childNodes].find((n) => n.nodeType === 3 && n.textContent.includes('now covers')); const r = document.createRange(); const i = t.textContent.indexOf('seven views'); r.setStart(t, i); r.setEnd(t, i + 11); getSelection().removeAllRanges(); getSelection().addRange(r); window.__top = b.scrollTop })()`); await wait(300)
    await evalJs(`document.querySelector('#pop').click()`); await wait(300)
    const nc = await evalJs(`(() => { const n = document.querySelector('.d-nc'); if (!n) return null; const b = n.getBoundingClientRect(); return { quote: n.querySelector('.d-nc-quote').textContent, focus: document.activeElement?.getAttribute('aria-label'), box: [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)], sheet: n.classList.contains('d-nc-sheet') } })()`)
    files.push(await shot(`notes-${label}-composer`))
    check(`note composer (${label}): opens next to the selection with the quote, focused, inside the viewport`, !!nc && nc.quote === 'seven views' && nc.focus === 'New note' && nc.box[0] >= 0 && nc.box[1] >= 0 && nc.box[2] <= w && nc.box[3] <= h, nc)
    await evalJs(`(() => { const t = document.querySelector('[aria-label="New note"]'); t.value = 'count them'; t.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await s('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 2, text: '\r' })
    await s('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 2 }); await wait(700)
    const after = await evalJs(`(() => { const dk = document.querySelector('.d-dock').getBoundingClientRect(); return { composer: !!document.querySelector('.d-nc'), panelHidden: document.querySelector('#notesPanel').hidden, mark: document.querySelector('mark.d-n')?.textContent, saved: document.querySelector('.d-note-saved')?.textContent, focus: document.activeElement?.getAttribute('data-k'), top: Math.round(document.querySelector('.d-sheet-body').scrollTop), was: Math.round(window.__top), state: document.querySelector('.d-state-pill').textContent, dockIn: dk.bottom <= innerHeight + 1 } })()`)
    files.push(await shot(`notes-${label}-saved`))
    check(`note composer (${label}): Ctrl+Enter saves, composer and panel close, highlight + quiet confirmation, focus and scroll restored, nothing sent`, !after.composer && after.panelHidden && after.mark === 'seven views' && /Not sent yet/.test(after.saved ?? '') && after.focus === 'notes-open' && Math.abs(after.top - after.was) <= 2 && after.state === '● Awaiting answer' && after.dockIn, after)
    // Image note from ✎, cancel with Esc keeps nothing; then add.
    const notesBefore = await evalJs(`document.querySelector('[data-k="notes-open"]').textContent`)
    await evalJs(`(() => { const b = document.querySelector('[data-k="fig-note-model-3"]'); b.scrollIntoView({ block: 'center' }); b.click() })()`); await wait(300)
    const inc = await evalJs(`({ title: document.querySelector('#ncTitle')?.textContent, quote: document.querySelector('.d-nc-quote')?.textContent })`)
    await key('Escape', 'Escape', 27); await wait(300)
    const esc = await evalJs(`({ composer: !!document.querySelector('.d-nc'), sheet: !!document.querySelector('.d-sheet'), focus: document.activeElement?.getAttribute('data-k'), notes: document.querySelector('[data-k="notes-open"]').textContent })`)
    check(`image note (${label}): ✎ opens the composer with the caption; Esc dismisses only it, focus back on ✎`, inc.title === 'Note on Side square' && /fold depth/.test(inc.quote ?? '') && !esc.composer && esc.sheet && esc.focus === 'fig-note-model-3' && esc.notes === notesBefore, { inc, esc, notesBefore })
  }
  // Grouping: a labelled Group by control in the toolbar; groups as clear bands, title closer to its own rows.
  for (const [w, h, label] of [[1600, 900, 'wide-1600'], [820, 900, 'wide-820'], [390, 844, 'narrow-390']]) {
    await open('?ref=dashboard&history=1', w, h)
    await evalJs(`(() => { const s = document.querySelector('[data-k="ws-select"]'); s.value = 'all'; s.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('[data-k="tab-all"]').click() })()`); await wait(800)
    for (const g of ['urgency', 'priority', 'status', 'workspace']) {
      await evalJs(`(() => { const s = document.querySelector('[data-k="group-by"]'); s.value = '${g}'; s.dispatchEvent(new Event('change', { bubbles: true })) })()`); await wait(250)
      const m = await evalJs(`(() => {
        const sel = document.querySelector('[data-k="group-by"]'), lab = sel.closest('label')
        const rows = [...document.querySelectorAll('tbody tr')], out = []
        rows.forEach((r, i) => { if (!r.classList.contains('d-group') || i === 0) return; const prev = rows[i - 1].getBoundingClientRect(), head = r.getBoundingClientRect(), nameTop = r.querySelector('.d-gname').getBoundingClientRect(), next = rows[i + 1]?.getBoundingClientRect()
          out.push({ before: Math.round(nameTop.top - prev.bottom), after: next ? Math.round(next.top - nameTop.bottom) : null }) })
        return { inToolbar: !!sel.closest('.d-toolbar'), label: lab?.textContent.startsWith('Group by'), value: sel.value, groups: document.querySelectorAll('tr.d-group').length, gaps: out,
          counts: [...document.querySelectorAll('tr.d-group .d-gc')].every((c) => /^\\d+$/.test(c.textContent) && c.getAttribute('aria-label')), titleOnly: [...document.querySelectorAll('tr.d-row th')].every((t) => t.children.length === 1) }
      })()`)
      if (g === 'priority' || label === 'narrow-390') files.push(await shot(`grouped-${label}-${g}`))
      check(`grouping (${label}, ${g}): labelled control in the toolbar; ${m.groups} groups, each heading closer to its rows than to the previous group`, m.inToolbar && m.label && m.value === g && m.groups >= 2 && m.counts && m.titleOnly && m.gaps.every((x) => x.after === null || x.before > x.after), m)
    }
  }
  // Resizable sheet: keyboard and pointer, limits, reset; table stays usable; narrow is full screen.
  await open('?ref=dashboard', 1280, 820)
  await evalJs(`document.querySelector('.qrow').click()`); await wait(800)
  const w0 = await evalJs(`Math.round(document.querySelector('.d-sheet').getBoundingClientRect().width)`)
  await evalJs(`document.querySelector('[data-k="divider"]').focus()`)
  await key('ArrowLeft', 'ArrowLeft', 37); await key('ArrowLeft', 'ArrowLeft', 37); await wait(200)
  const k1 = await evalJs(`({ w: Math.round(document.querySelector('.d-sheet').getBoundingClientRect().width), now: +document.querySelector('[data-k="divider"]').getAttribute('aria-valuenow'), reset: !document.querySelector('[data-k="sheet-reset"]').hidden })`)
  check('divider: ArrowLeft widens the sheet by 24px steps, separator value and reset button follow', k1.w === w0 + 48 && k1.now === k1.w && k1.reset, { w0, k1 })
  await key('Home', 'Home', 36); await wait(200)
  const kMax = await evalJs(`(() => { const t = document.querySelector('.d-table-wrap').getBoundingClientRect(), d = document.querySelector('.d-dock').getBoundingClientRect(); return { table: Math.round(t.width), sheet: Math.round(document.querySelector('.d-sheet').getBoundingClientRect().width), dockIn: d.bottom <= innerHeight + 1, max: +document.querySelector('[data-k="divider"]').getAttribute('aria-valuemax') } })()`)
  files.push(await shot('divider-1280-max'))
  check('divider: Home = maximum; the table keeps ≥ 420px and the reply card stays anchored', kMax.sheet === kMax.max && kMax.table >= 420 && kMax.dockIn, kMax)
  await key('End', 'End', 35); await wait(200)
  const kMin = await evalJs(`({ sheet: Math.round(document.querySelector('.d-sheet').getBoundingClientRect().width), send: (() => { const b = document.querySelector('[data-k="send"]').getBoundingClientRect(); return b.right <= innerWidth && b.bottom <= innerHeight })() })`)
  files.push(await shot('divider-1280-min'))
  check('divider: End = minimum (380px); reply controls still fit', kMin.sheet === 380 && kMin.send, kMin)
  // Pointer drag.
  const sep = await evalJs(`(() => { const r = document.querySelector('[data-k="divider"]').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top + r.height / 2) } })()`)
  await s('Input.dispatchMouseEvent', { type: 'mousePressed', x: sep.x, y: sep.y, button: 'left', clickCount: 1 })
  await s('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sep.x - 200, y: sep.y, button: 'left', buttons: 1 })
  await s('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sep.x - 200, y: sep.y, button: 'left', clickCount: 1 }); await wait(200)
  const drag = await evalJs(`Math.round(document.querySelector('.d-sheet').getBoundingClientRect().width)`)
  check('divider: dragging 200px left widens the sheet by 200px', drag === 580, { drag })
  await evalJs(`document.querySelector('[data-k="sheet-reset"]').click()`); await wait(200)
  const reset = await evalJs(`({ w: Math.round(document.querySelector('.d-sheet').getBoundingClientRect().width), hidden: document.querySelector('[data-k="sheet-reset"]').hidden })`)
  check('divider: Reset returns to the default width', reset.w === w0 && reset.hidden, { reset, w0 })
  await s('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }); await wait(400)
  const nar = await evalJs(`({ sheet: Math.round(document.querySelector('.d-sheet').getBoundingClientRect().width), divider: getComputedStyle(document.querySelector('[data-k="divider"]')).display })`)
  check('divider: hidden at 390px; the sheet is full screen', nar.sheet === 390 && nar.divider === 'none', nar)
  // Native Item with two questions: paging in the read-only card.
  for (const [w, h, label] of SIZES) {
    await open('?ref=bot-item:preview:e1:0', w, h)
    files.push(await shot(`native-${label}`))
    const ro = await evalJs(`({ textarea: !!document.querySelector('.d-dock textarea, .d-dock [data-k="send"]'), where: document.querySelector('.d-ro-dock > .d-dock-row p')?.textContent, pager: document.querySelector('.d-dock .d-pager span')?.textContent, recs: document.querySelectorAll('.d-dock .d-rec').length })`)
    const g = await geometry(); geometryLog[`native-${label}`] = g
    check(`native (${label}): read-only card with pager and recommendation once, no reply controls`, !ro.textarea && /Bot Items/.test(ro.where ?? '') && ro.pager === '1 / 2' && ro.recs === 1 && g.dock.bottom <= h + 1, ro)
  }
  await evalJs(`document.querySelector('[data-k="q-next"]').focus()`)
  await key('Enter', 'Enter', 13, '\r'); await wait(900)
  const paged = await evalJs(`({ pager: document.querySelector('.d-pager span')?.textContent, title: document.querySelector('h1')?.textContent })`)
  check('native paging: Next (keyboard) opens question 2 / 2', paged.pager === '2 / 2' && /第 2 題/.test(paged.title ?? ''), paged)
  files.push(await shot('native-390-question-2'))
  // Long Chinese Chat decision: Real Chrome anchors for the multi-link CJK sentence (recommendation, in the card).
  await open('?ref=preview-long', 820, 900)
  files.push(await shot('chat-long-820'))
  const anchors = await evalJs(`(() => { const p = [...document.querySelectorAll('[data-field="recommendation"] p')].at(-2); return { links: [...p.querySelectorAll('a')].map((a) => [a.href, a.textContent]), texts: [...p.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent) } })()`)
  check('link boundaries in Chrome: hrefs, link text and following CJK text', JSON.stringify(anchors) === JSON.stringify({
    links: [['https://a.invalid/1', 'https://a.invalid/1'], ['https://b.invalid/2', 'https://b.invalid/2'], ['https://en.wikipedia.org/wiki/A_(b)', 'C 文件'], ['https://example.invalid/run/42', 'https://example.invalid/run/42']],
    texts: ['參考 ', '、', ' 與 ', '，另見 ', '。下一句不是連結。'] }), anchors)
  const d1 = await evalJs(`(() => { const p = [...document.querySelectorAll('[data-field="recommendation"] p')].at(-1); return { links: [...p.querySelectorAll('a')].map((a) => [a.href, a.textContent]), texts: [...p.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent) } })()`)
  check('unmatched ], non-http(s) label and IPv6 in Chrome: anchors and plain text', JSON.stringify(d1) === JSON.stringify({
    links: [['https://example.invalid/x', 'https://example.invalid/x'], ['http://[::1]:8080/a', 'http://[::1]:8080/a']],
    texts: ['see [', '] here, ', 'https://ok.invalid', ' ', '(javascript:alert(1))', ' and ', '.'] }), d1)
  // Draft survives an editor source change (reload).
  await open('?ref=preview-long', 820, 900)
  await evalJs(`(() => { const t = document.querySelector('[aria-label="Reply text"]'); t.value = 'Tuesday after 3pm'; t.dispatchEvent(new Event('input', { bubbles: true })); window.__beforeReload = true })()`)
  await wait(700)
  const now = new Date(); utimesSync(path.join(root, 'src/review.ts'), now, now) // touch only: no content change
  await wait(6000)
  const after = await evalJs(`({ reloaded: !window.__beforeReload, text: document.querySelector('[aria-label="Reply text"]')?.value })`)
  check('editing a source reloads the page and keeps the draft', after.reloaded && after.text === 'Tuesday after 3pm', after)
  // Seven images with compare, light theme, and settings, for the record.
  await open('?ref=image-review', 1280, 820); files.push(await shot('images-1280'))
  await open('?ref=preview-narrative&theme=light', 1280, 820); files.push(await shot('narrative-1280-light'))
  await open('?ref=dashboard&theme=light', 1280, 820); files.push(await shot('dashboard-1280-light'))
  await open('?ref=settings&theme=light', 820, 900); files.push(await shot('settings-820-light'))
  writeFileSync(path.join(dir, 'checks.json'), JSON.stringify({ base, checks, files, geometry: geometryLog }, null, 2))
  browser.close()
  const failed = checks.filter((c) => !c.pass).length
  console.log(`[shots] ${files.length} screenshots and checks.json in ${dir}; ${failed ? `${failed} check(s) FAILED` : 'all checks passed'}`)
  if (failed) throw new Error('preview checks failed')
}
