import { assert, mount, test } from 'orca/testing'
import type { TestPanel } from 'orca/testing'
import * as panel from './panel'
import { SAMPLE_CLOCK, SAMPLE_DECISIONS, IMAGE_FILES } from './sample'
import { EMPTY_STORE, answerFrom, order, samplesAt, searchText, visible, type PreviewStore } from './preview-model'

// Desktop-like checks: the panel is mounted with Orca's own runtime and checks, then driven with
// presses, typing and toggles as a person would. Nothing here injects sample data: the panel must
// show it on first open by itself.

const titles = (view: TestPanel) => view.findAll({ type: 'ListItem' }).map((e) => e.label)
const stored = (view: TestPanel) => view.persisted.plugin['preview.store'] as PreviewStore

async function fresh(fn: (view: TestPanel) => Promise<void>, persisted?: Record<string, unknown>) {
  const view = await mount(panel, persisted ? { persisted: { plugin: persisted } } : {})
  try {
    await fn(view)
    assert.deepEqual(view.errors, [], 'the panel never throws')
    assert.deepEqual(view.warnings, [], 'Orca drops no prop or component')
    assert.deepEqual(view.refusals, [], 'Orca refuses no host call')
    assert.deepEqual(view.host.calls, [], 'no host call at all: no mail, no Bot Items, no network')
  } finally { await view.unmount() }
}

test('first open shows the seeded sample queue with the preview notice, no setup step', () => fresh(async (view) => {
  assert.ok(view.find({ type: 'Callout', label: 'Preview · sample data' }), 'persistent demo indicator')
  assert.ok(view.find({ text: /Nothing is sent to a Chat, mail or Bot Items/ }))
  const list = titles(view)
  assert.equal(list.length, 8, 'eight cards need an answer; the sample history card is hidden')
  assert.deepEqual(list.slice(0, 2), ['Approve the reading room route', 'Approve the reading room reset window'], 'P0 first')
  assert.ok(!list.includes('Choose the catalogue layout'), 'sample history is hidden by default')
  assert.ok(view.find({ text: '8 need you' }))
  assert.ok(view.find({ text: 'Package · 3 questions' }), 'multi-question package badge')
  assert.ok(view.find({ text: '7 images' }), 'multi-image card badge')
  const seeded = stored(view).seededAt
  assert.ok(typeof seeded === 'number' && Math.abs(seeded - Date.now()) < 60_000, 'first open records the seed time')
}))

test('search filters as typed, including Chinese, IDs and history replies', () => fresh(async (view) => {
  await view.type({ label: 'Search' }, '錄音')
  assert.deepEqual(titles(view), ['Pick a rehearsal slot'])
  await view.type({ label: 'Search' }, 'vd-', { replace: true })
  assert.equal(titles(view).length, 3, 'package ID prefix finds all three questions')
  await view.type({ label: 'Search' }, 'matte sample', { replace: true })
  assert.ok(view.find({ type: 'EmptyState', label: 'No matches' }), 'history reply text hidden without history')
  await view.toggle({ label: 'Include history' })
  assert.deepEqual(titles(view), ['Choose the catalogue layout'])
  assert.ok(view.find({ text: 'Sample history' }))
  await view.type({ label: 'Search' }, '', { replace: true })
  assert.equal(titles(view).length, 9, 'history shows every sample card')
}))

test('selecting a card opens its review in the panel; back returns to the list', () => fresh(async (view) => {
  await view.press({ type: 'ListItem', label: 'Approve the reading room route' })
  assert.ok(view.find({ type: 'Heading', text: 'Background' }))
  assert.ok(view.find({ text: /narrow west aisle/ }))
  assert.ok(view.find({ text: /Keep a clear route from the east entrance/ }))
  assert.ok(view.find({ text: /Reading room plan \(linked plan, version 2/ }))
  assert.ok(view.find({ type: 'Card', label: 'Package · 2 questions' }))
  assert.ok(view.find({ type: 'Callout', label: 'Preview · sample data' }), 'indicator stays in the review')
  await view.press({ text: 'Back to list' })
  assert.equal(titles(view).length, 8)
  const current = view.findAll({ type: 'ListItem' }).find((e) => e.props.current)
  assert.equal(current?.label, 'Approve the reading room route', 'the last reviewed card stays marked')
}))

test('choosing an option and saving shows the locally saved result at once', () => fresh(async (view) => {
  await view.press({ type: 'ListItem', label: 'Pick a rehearsal slot' })
  await view.press({ text: 'Save test answer' })
  assert.ok(view.find({ text: 'Choose an option before saving.' }), 'empty answer is refused')
  assert.deepEqual(stored(view).replies, {}, 'nothing saved')
  await view.select({ label: 'Choose an option' }, 'thu')
  assert.ok(!view.find({ text: 'Choose an option before saving.' }), 'choosing clears the error')
  assert.ok(!view.find({ type: 'Callout', label: 'Saved in this preview' }), 'choosing alone does not save')
  await view.type({ label: 'Detail (optional)' }, 'Bring the 錄音 kit.')
  await view.press({ text: 'Save test answer' })
  assert.ok(view.find({ type: 'Callout', label: 'Saved in this preview' }))
  assert.ok(view.find({ text: 'Thursday — Bring the 錄音 kit.' }))
  assert.ok(view.find({ text: /Not sent anywhere/ }))
  const r = stored(view).replies.schedule
  assert.equal(r.length, 1)
  assert.deepEqual(r[0].answer, { kind: 'option', optionId: 'thu', detail: 'Bring the 錄音 kit.' })
  assert.equal(r[0].replyId, 'preview-schedule-1')
  assert.ok(view.find({ text: '7 need you' }))
  // Follow-up on the same question appends; the original stays as saved.
  await view.type({ label: 'Add a follow-up' }, 'Also book the small room.')
  await view.press({ text: 'Save follow-up' })
  assert.equal(stored(view).replies.schedule.length, 2)
  assert.ok(view.find({ type: 'Callout', label: 'Follow-up saved in this preview' }))
  assert.ok(view.find({ text: 'Thursday — Bring the 錄音 kit.' }), 'original answer unchanged')
  await view.press({ text: 'Back to list' })
  assert.ok(!titles(view).includes('Pick a rehearsal slot'), 'answered card moves to history')
  assert.ok(view.find({ text: /1 answered in this preview/ }))
  await view.toggle({ label: 'Include history' })
  assert.ok(view.find({ type: 'ListItem', label: 'Pick a rehearsal slot', text: /Saved in preview/ }))
}))

test('typed reply with notes on the seven-image card', () => fresh(async (view) => {
  await view.press({ type: 'ListItem', label: 'Compare seven paper model views' })
  assert.ok(view.find({ type: 'Heading', text: 'Evidence · 7 images' }))
  const images = view.findAll({ type: 'Image' })
  assert.equal(images.length, 8, 'one large view plus seven thumbnails')
  assert.equal(new Set(images.map((e) => e.props.src)).size, 7, 'seven distinct bundled images')
  assert.ok(view.find({ text: /Image 1 of 7 · Front wide/ }))
  assert.ok(view.find({ type: 'Button', text: 'Previous image' })?.disabled)
  await view.press({ text: 'Next image' })
  assert.ok(view.find({ text: /Image 2 of 7 · Front portrait/ }))
  await view.press({ type: 'Button', text: '6' })
  assert.ok(view.find({ text: /Image 6 of 7 · Panorama/ }))
  await view.type({ label: 'Note on image 6 (optional)' }, 'Compare the outer edge.')
  await view.press({ text: 'Save test answer' })
  assert.ok(view.find({ text: 'Type a reply before saving.' }), 'a text question needs text')
  await view.type({ label: 'Your reply' }, 'Use the side view as the comparison baseline.')
  await view.press({ text: 'Save test answer' })
  const r = stored(view).replies['image-review'][0]
  assert.deepEqual(r.answer, { kind: 'text', text: 'Use the side view as the comparison baseline.' })
  assert.deepEqual(r.annotations, [{ kind: 'image', evidence: { evidenceId: 'model-6', version: 1 }, text: 'Compare the outer edge.' }])
  assert.ok(view.find({ text: 'Note on Panorama: Compare the outer edge.' }), 'the saved note is shown with the answer')
}))

test('multi-question package: each question is answered on its own', () => fresh(async (view) => {
  await view.press({ type: 'ListItem', label: 'Pick the volunteer day' })
  const pkg = view.find({ type: 'Card', label: 'Package · 3 questions' })
  assert.ok(pkg)
  assert.match(pkg!.text, /1\. Pick the volunteer day.*2\. Approve the hand tool budget.*3\. Write the welcome note/s)
  await view.select({ label: 'Choose an option' }, 'sat')
  await view.press({ text: 'Save test answer' })
  await view.press({ type: 'ListItem', label: '2. Approve the hand tool budget' })
  assert.ok(view.find({ type: 'Heading', text: 'Approve the hand tool budget' }))
  assert.ok(view.find({ type: 'ListItem', label: '1. Pick the volunteer day', text: /Saved in preview/ }), 'sibling state shown')
  assert.ok(!view.find({ type: 'Callout', label: 'Saved in this preview' }), 'second question still unanswered')
  await view.press({ type: 'ListItem', label: '3. Write the welcome note for volunteers' })
  await view.type({ label: 'Your reply' }, 'Meet at the north gate. Bring gloves and water.', { submit: true })
  assert.ok(view.find({ text: 'Meet at the north gate. Bring gloves and water.' }))
  assert.deepEqual(Object.keys(stored(view).replies).sort(), ['vd-brief', 'vd-date'])
}))

test('saved answers survive reopening, and reset restores the sample', async () => {
  let saved: PreviewStore | undefined
  await fresh(async (view) => {
    await view.press({ type: 'ListItem', label: 'Approve the first lantern trial' })
    await view.select({ label: 'Choose an option' }, 'hold')
    await view.press({ text: 'Save test answer' })
    saved = stored(view)
  })
  await fresh(async (view) => {
    assert.ok(view.find({ text: '7 need you' }), 'the saved answer is still there after reopening')
    await view.press({ label: 'Reset preview data' })
    assert.ok(view.find({ type: 'Callout', label: 'Reset the preview?' }), 'reset asks first')
    await view.press({ text: 'Cancel' })
    assert.ok(view.find({ text: '7 need you' }), 'cancel keeps answers')
    await view.press({ label: 'Reset preview data' })
    await view.press({ type: 'Button', text: 'Reset preview data' })
    assert.ok(view.find({ text: '8 need you' }))
    assert.deepEqual(stored(view).replies, {})
    assert.equal(titles(view).length, 8)
  }, { 'preview.store': saved })
})

test('model: sample dates follow the first-open time; search and order match production rules', () => {
  const at = Date.parse('2026-01-05T10:00:00Z')
  const list = samplesAt(at)
  const stage = list.find((d) => d.questionId === 'stage')!
  assert.equal(Date.parse(stage.deadline!) - at, 3 * 3_600_000, 'deadline keeps its distance from the sample clock')
  assert.equal(SAMPLE_DECISIONS.length, 9)
  assert.equal(Date.parse(SAMPLE_CLOCK), Date.parse('2030-06-14T12:00:00Z'))
  assert.deepEqual(order(list, at, 'UTC').map((d) => d.questionId).slice(0, 3), ['room-route', 'room-reset', 'stage'])
  assert.ok(searchText(list[0], EMPTY_STORE).includes('錄音'))
  assert.deepEqual(visible(list, EMPTY_STORE, { term: 'fold-out', history: true, now: at, zone: 'UTC' }).map((d) => d.questionId), ['layout'])
  assert.deepEqual(answerFrom(list[0], { optionId: 'nope', text: '', notes: {} }), { ok: false, error: 'Choose an option before saving.' })
  assert.equal(Object.keys(IMAGE_FILES).length, 7)
  for (const f of Object.values(IMAGE_FILES)) assert.match(f, /^assets\/sample\/[a-z-]+\.png$/)
})
