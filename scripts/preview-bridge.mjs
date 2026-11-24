// Dev-only mock of the Orca editor frame bridge (`window.orca`) for `npm run preview:editor`.
// It answers the review editor's worker requests from the shared synthetic fixtures plus a few
// synthetic reader cases (a native Bot Item package with Markdown, long Chinese text, a seven-image narrative). No live
// Orca, network or private data. Drafts follow the worker's compare-and-set rule and live in
// sessionStorage, so a reload after a source edit keeps them, as worker storage would.
import { decisions, historyExample, clock, origins } from './build/fixtures/decisions.js'
import { createPractice, practiceOwner } from './build/src/backend-practice.js'
import { order } from './build/src/model.js'

const clone = (v) => (v === undefined ? v : structuredClone(v))
const ok = (value) => ({ ok: true, value })
const err = (code, message = '') => ({ ok: false, code, message })
const log = (...a) => console.info('[preview bridge]', ...a)

// ---- synthetic reader cases (no real items) ------------------------------------------------------
const md = '確認發佈流程。**請決定是否發佈第 42 版。** 參考 [執行紀錄](https://example.invalid/run/42)。\n\n- 測試全部通過\n- 文件已更新\n- 回滾步驟已演練'
const longZh = Array.from({ length: 14 }, (_, i) => `第 ${i + 1} 段：這是一段刻意寫長的中文說明，用來檢查段落換行、閱讀節奏，以及捲動時底部回覆區是否仍然可用。`).join('\n\n')
const nativeBase = (i, title) => ({
  ...clone(decisions[0]), questionId: `bot-item:preview:e1:${i}`, packageId: 'bot-item:preview', title,
  context: 'Release bot · 第 42 版發佈', background: md, recommendation: i === 0 ? '發佈，並在明早觀察指標。' : '', blockedWork: ['Publish release notes'],
  options: [{ optionId: '0', label: '發佈' }, { optionId: '1', label: '暫緩', detail: '等下一版' }],
  origin: { hostId: 'local', workspaceId: '', sessionId: '' }, projectName: '', workspaceName: '', actions: [],
  activity: [{ label: 'Original ask', at: '2030-06-14T10:00:00Z', text: '問題：是否發佈？\n選項：\n1. 發佈\n2. 暫緩' }],
  package: { index: i, size: 2, questionIds: ['bot-item:preview:e1:0', 'bot-item:preview:e1:1'] },
  source: { kind: 'native-item', workspaceAttributed: false, botName: 'Release bot', itemLabel: '#2', itemStatus: 'needs-you', observedAt: '2030-06-14T11:30:00Z' }
})
const chatLong = { ...clone(decisions.find((d) => d.questionId === 'schedule')), questionId: 'preview-long', packageId: 'preview-pkg', title: '長篇中文問題：要在週二還是週四排練？',
  background: longZh, recommendation: '**週二**，因為 [場地表](https://example.invalid/rooms) 顯示較少衝突。\n\n參考 https://a.invalid/1、https://b.invalid/2 與 [C 文件](https://en.wikipedia.org/wiki/A_(b))，另見 https://example.invalid/run/42。下一句不是連結。\n\nsee [https://example.invalid/x] here, [https://ok.invalid](javascript:alert(1)) and http://[::1]:8080/a.', createdAt: '2030-06-10T08:00:00Z' }
const chatLong2 = { ...clone(chatLong), questionId: 'preview-long-2', title: '第二題：排練需要多久？', background: '- 一小時\n- 兩小時', recommendation: '', createdAt: '2030-06-10T08:05:00Z',
  options: [{ optionId: 'one', label: '一小時' }, { optionId: 'two', label: '兩小時' }] }

// A seven-image agent narrative: headings, prose, links, an inert command, and images placed at raw
// offsets (each before a line that follows a blank line, or at the end), one of them denied.
const narrativeParts = [
  '## What changed\n\nThe [fold guide](https://example.invalid/guide) now covers seven views. Each view below is a synthetic placeholder.\n\n',
  'The front views show the crease line. Compare the wide and portrait framing.\n\n',
  '### Side views\n\nThe side views show the fold depth.\n\n',
  'Detail and panorama views follow.\n\n',
  '## Reproduce\n\nRun this locally; the Inbox never runs it:\n\n```sh\nnpm run fold -- --views 7 && echo done\n```\n\n',
  'Choose the view that should be the comparison baseline.'
]
const narrative = narrativeParts.join('')
const at = (i) => narrativeParts.slice(0, i).join('').length
const chatNarrative = { ...clone(decisions.find((d) => d.questionId === 'image-review')), questionId: 'preview-narrative', title: 'Which view should be the comparison baseline?',
  description: 'Pick one view as the **comparison baseline** for the fold review. The other six views are compared against it.',
  background: narrative, recommendation: 'Use **Side square** as the baseline: it shows the fold depth without distortion.', recommendedOptionId: 'side',
  sourceLinks: [{ label: 'Fold guide', url: 'https://example.invalid/guide' }, { label: 'paper/fold#12', url: 'https://github.com/example/paper/issues/12' }, { label: 'paper/fold#13', url: 'https://github.com/example/paper/pull/13' }, { label: 'PAP-7', url: 'https://linear.app/example/issue/PAP-7' }],
  workItemLinks: [{ kind: 'github-issue', label: 'paper/fold#12', url: 'https://github.com/example/paper/issues/12' }, { kind: 'github-pr', label: 'paper/fold#13', url: 'https://github.com/example/paper/pull/13' },
    { kind: 'linear-issue', label: 'PAP-7', url: 'https://linear.app/example/issue/PAP-7' }, { kind: 'github-issue', label: 'paper/fold#12', url: 'https://github.com/example/paper/issues/12/' },
    { kind: 'github-issue', label: 'not https', url: 'http://github.com/example/paper/issues/1' }, { kind: 'github-pr', label: 'other path', url: 'https://github.com/example/paper/tree/main' }],
  originalSessionId: 'orca_session_id:00000000-0000-4000-8000-000000000001',
  options: [{ optionId: 'side', label: 'Side square' }, { optionId: 'front', label: 'Front wide', detail: 'shows the crease' }, { optionId: 'pano', label: 'Panorama' }],
  inlineImages: [
    { offset: at(1), evidenceId: 'model-1', version: 1, caption: 'Front wide: the crease runs left to right.' },
    { offset: at(1), evidenceId: 'model-2', version: 1, caption: 'Front portrait: same crease, tall framing.' },
    { offset: at(3), evidenceId: 'model-3', version: 1, caption: 'Side square: fold depth is clearest here.' },
    { offset: at(3), evidenceId: 'model-4', version: 1 },
    { offset: at(4), evidenceId: 'model-5', version: 1, caption: 'Detail portrait.' },
    { offset: at(4), unavailable: true },
    { offset: narrative.length, evidenceId: 'model-7', version: 1, caption: 'Tall detail, placed at the end.' }
  ], createdAt: '2030-06-10T09:00:00Z' }

export function createMockOrca({ ref, history = false }) {
  const db = new Map([...decisions, nativeBase(0, '第 1 題：是否發佈第 42 版？'), nativeBase(1, '第 2 題：何時發佈？'), chatLong, chatLong2, chatNarrative]
    .map((d) => [d.questionId, clone(d)]))
  if (history) db.set('layout', clone(historyExample))
  const key = (q) => `preview-draft:${q}`
  const draft = (q) => JSON.parse(sessionStorage.getItem(key(q)) ?? 'null') ?? { draft: null, revision: 0 }
  let settings = { defaultTemplate: 'Ask one question with clear options and a recommendation.', exceptions: [], revision: 1 }
  const listeners = {}
  // Run the same sample packages, draft revision checks and local answer store as the plugin.
  const practice = createPractice({
    storage: {
      get: async key => JSON.parse(sessionStorage.getItem(key) ?? 'null'),
      set: async (key, value) => sessionStorage.setItem(key, JSON.stringify(value)),
      delete: async key => sessionStorage.removeItem(key),
      keys: async () => Object.keys(sessionStorage)
    },
    panels: { post: event => setTimeout(() => (listeners[event] ?? []).forEach(fn => fn({})), 0) }
  })
  const practiceRow = row => ({ ...row, source: { kind: 'practice' },
    actions: row.answerState.state === 'awaiting-answer' ? ['reply'] : ['follow-up'] })
  async function practiceRequest(name, input) {
    await practice.ready()
    if (name === 'practice.listDecisionPage') {
      const r = await practice.backend.listDecisionPage(practiceOwner, { ...input, scope: { kind: 'all' } })
      return r.ok ? ok({ ...r.value, rows: r.value.rows.map(practiceRow) }) : r
    }
    if (name === 'getDecision') {
      const r = await practice.backend.getDecision(practiceOwner, input)
      return r.ok ? ok(practiceRow(r.value)) : r
    }
    const method = { 'draft.get': 'getDraft', 'draft.save': 'saveDraft', getSnapshot: 'getSnapshot', submitReply: 'submitReply' }[name]
    return method ? practice.backend[method](practiceOwner, input) : err('unavailable', 'This action is unavailable in Practice.')
  }
  const page = ({ scope, query, includeHistory, cursor }) => {
    const t = (query ?? '').toLocaleLowerCase()
    const rows = order([...db.values()]).filter((d) => (scope.kind === 'all' ||
      (d.origin.hostId === scope.workspace.hostId && d.origin.workspaceId === scope.workspace.workspaceId)) &&
      (includeHistory || d.answerState.state === 'awaiting-answer' || d.source?.kind === 'native-item') &&
      (!t || JSON.stringify(d).toLocaleLowerCase().includes(t)))
    const start = cursor ? Number(cursor) : 0
    const size = 8
    return ok({ rows: rows.slice(start, start + size).map(clone), ...(start + size < rows.length ? { nextCursor: String(start + size) } : {}),
      sources: [{ source: 'plugin', state: 'available' }, { source: 'native-item', state: 'available' }],
      mail: { state: 'unavailable', message: 'Answers are saved in Decision Inbox. Orca mail from this plugin is unavailable on this host.' } })
  }
  /** A synthetic labelled PNG for each image snapshot, drawn locally. */
  const snapshot = (attachmentId) => {
    const ev = [...db.values()].flatMap((d) => d.evidence).find((e) => e.attachmentId === attachmentId)
    if (!ev) return err('not-found', 'Snapshot expired or missing.')
    const c = document.createElement('canvas'); c.width = ev.width / 2; c.height = ev.height / 2
    const g = c.getContext('2d'); g.fillStyle = '#8aa4c8'; g.fillRect(0, 0, c.width, c.height)
    g.fillStyle = '#10233f'; g.font = `${Math.round(Math.min(c.width, c.height) / 9)}px sans-serif`; g.textAlign = 'center'
    g.fillText(`${ev.label} · ${ev.width}×${ev.height}`, c.width / 2, c.height / 2)
    return ok({ mimeType: 'image/png', base64: c.toDataURL('image/png').split(',')[1] })
  }
  const handlers = {
    'workspace.resolve': () => ok({ hostId: origins.studio.hostId, workspaceId: origins.studio.workspaceId }),
    // Synthetic authorized inventory: equal names on two hosts and an empty workspace.
    'workspace.options': () => ok({ workspaces: [
      { hostId: 'local', workspaceId: 'studio', name: 'Paper Studio', hostLabel: 'Local Orca' },
      { hostId: 'local', workspaceId: 'library', name: 'Seed Catalogue', hostLabel: 'Local Orca' },
      { hostId: 'paired', workspaceId: 'studio', name: 'Paper Studio' },
      { hostId: 'local', workspaceId: 'annex', name: 'Quiet Annex', hostLabel: 'Local Orca' }] }),
    listDecisionPage: page,
    getDecision: ({ questionId }) => (db.has(questionId) ? ok(clone(db.get(questionId))) : err('not-found', 'Decision is missing or inaccessible.')),
    'draft.get': ({ questionId }) => ok(draft(questionId)),
    'draft.save': ({ questionId, draft: value, revision }) => {
      const cur = draft(questionId)
      if (revision !== cur.revision) return err('conflict', 'Stale draft revision.')
      const next = { draft: clone(value), revision: cur.revision + 1 }
      sessionStorage.setItem(key(questionId), JSON.stringify(next)); return ok(next)
    },
    submitReply: (input) => {
      const d = db.get(input.questionId)
      if (!d || d.source?.kind === 'native-item') return err('not-found', 'Decision is missing or inaccessible.')
      const rec = { ...clone(input), acceptedAt: new Date().toISOString(), delivery: { state: 'undelivered', reason: 'delivery-failed' } }
      d.answerState = d.answerState.state === 'answered' ? { ...d.answerState, followUps: [...d.answerState.followUps, rec] } : { state: 'answered', initial: rec, followUps: [] }
      d.actions = ['follow-up']; emit(); return ok(clone(rec))
    },
    retryReply: () => err('unavailable', 'Orca mail from Decision Inbox is unavailable in the preview.'),
    getSnapshot: ({ attachmentId }) => snapshot(attachmentId),
    'settings.get': () => ok(clone(settings)),
    'settings.repos': () => ok(['Paper Studio', 'Seed Catalogue', 'Lantern Workshop']),
    'settings.save': (input) => (input.revision !== settings.revision ? err('conflict', 'Stale revision.') : ok(clone(settings = { ...clone(input), revision: settings.revision + 1 }))),
    'settings.effective': ({ repo }) => ok({ template: settings.exceptions.find((e) => e.repo === repo)?.template ?? settings.defaultTemplate, source: settings.exceptions.some((e) => e.repo === repo) ? 'exception' : 'default' }),
    'review.open': ({ questionId }) => { log('review.open (no wide tab in the preview)', questionId); return ok(null) },
    'settings.open': () => { log('settings.open (no wide tab in the preview)'); return ok(null) }
  }
  const emit = () => setTimeout(() => (listeners['inbox.changed'] ?? []).forEach((fn) => fn({})), 0)
  return {
    api: { major: 1, minor: 10 }, locale: 'en-US',
    document: { session: async () => ({ value: JSON.stringify(ref), readOnly: false, onReplace() { return { dispose() {} } }, change() {}, flush: async () => {}, dispose() {} }) },
    shell: { openExternal: async (url) => { log('openExternal', url); return { opened: false, reason: 'cancelled' } } },
    host: { call: async (method) => (method === 'workspace.readContext' ? { workspaceId: 'studio-local', branch: 'main', displayName: 'studio', terminals: [] } : null) },
    plugin: {
      request: async (name, input) => {
        if (name === 'practice.listDecisionPage' || input?.mode === 'practice') return practiceRequest(name, input)
        const h = handlers[name]
        if (!h) throw Object.assign(new Error(`No handler ${name}`), { code: 'unknown_method' })
        await new Promise((r) => setTimeout(r, 40)) // a little latency, like the worker bridge
        return h(input)
      },
      on: (event, fn) => { (listeners[event] ??= []).push(fn); return { dispose() {} } }
    },
    on: () => ({ dispose() {} }),
    __fixtureClock: clock
  }
}
