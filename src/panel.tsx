import {
  atom, read, set, update,
  Badge, Button, Callout, Card, Checkbox, EmptyState, Grid, Heading, IconButton, Image, Input, List,
  ListItem, RadioGroup, RelativeTime, Row, Stack, Text, Textarea
} from 'orca'
import type { PanelContext } from 'orca'
import type { Decision } from './contract.ts'
import { IMAGE_FILES } from './sample.ts'
import {
  CARD_STATE_LABEL, EMPTY_DRAFT, EMPTY_STORE, answerFrom, cardState, deadlineLabel, describeAnswer,
  isActionable, notesFrom, packageOf, repliesOf, samplesAt, visible,
  type Draft, type PreviewReply, type PreviewStore
} from './preview-model.ts'

// Decision Inbox Preview: one components panel with built-in synthetic decisions. The list and the
// review both live in this panel. Answers are saved only in this plugin's own persisted state
// (`preview.store`, separate plugin id, so separate from production). No worker, no capabilities,
// no network, no mail, no Bot Items.

/** Saved answers and the first-open time. Survives panel reopen and Orca restart. */
const store = atom<PreviewStore>('preview.store', EMPTY_STORE, { persist: 'plugin', version: 1 })
const term = atom('preview.term', '')
const history = atom('preview.history', false)
const selected = atom<string | null>('preview.selected', null)
/** The card last reviewed, kept marked in the list after Back, as production marks the open row. */
const lastViewed = atom<string | null>('preview.lastViewed', null)
const openCard = (id: string) => { set(selected, id); set(lastViewed, id) }
const drafts = atom<Record<string, Draft>>('preview.drafts', {})
const followUps = atom<Record<string, string>>('preview.followUps', {})
const errors = atom<Record<string, string>>('preview.errors', {})
const imageAt = atom<Record<string, number>>('preview.imageAt', {})
const confirmReset = atom('preview.confirmReset', false)
/** Live clock, ticking each minute so deadline text stays current. */
const now = atom(Date.now())

const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

export function setup(ctx: PanelContext) {
  // First open seeds the sample: its dates are placed relative to this moment.
  if (read(store).seededAt === null) update(store, (s) => ({ ...s, seededAt: Date.now() }))
  set(now, Date.now())
  const tick = setInterval(() => set(now, Date.now()), 60_000)
  ctx.signal.addEventListener('abort', () => clearInterval(tick))
}

const draftOf = (id: string): Draft => read(drafts)[id] ?? EMPTY_DRAFT
const editDraft = (id: string, change: Partial<Draft>) => {
  update(drafts, (all) => ({ ...all, [id]: { ...(all[id] ?? EMPTY_DRAFT), ...change } }))
  update(errors, (all) => { const { [id]: _gone, ...rest } = all; return rest })
}

function saveReply(d: Decision, kind: 'initial' | 'follow-up') {
  const id = d.questionId
  const draft = kind === 'initial' ? draftOf(id) : { ...EMPTY_DRAFT, text: read(followUps)[id] ?? '' }
  // A follow-up is always free text, even on a question with options.
  const r = kind === 'initial' ? answerFrom(d, draft) : answerFrom({ ...d, options: [] }, draft)
  if (!r.ok) { update(errors, (all) => ({ ...all, [id]: r.error })); return }
  const existing = repliesOf(read(store), d)
  const reply: PreviewReply = {
    replyId: `preview-${id}-${existing.length + 1}`,
    kind,
    answer: r.answer,
    annotations: kind === 'initial' ? notesFrom(d, draft) : [],
    savedAt: Date.now(),
  }
  update(store, (s) => ({ ...s, replies: { ...s.replies, [id]: [...existing, reply] } }))
  if (kind === 'initial') update(drafts, (all) => { const { [id]: _gone, ...rest } = all; return rest })
  else update(followUps, (all) => { const { [id]: _gone, ...rest } = all; return rest })
  update(errors, (all) => { const { [id]: _gone, ...rest } = all; return rest })
}

function resetPreview() {
  set(store, { seededAt: Date.now(), replies: {} })
  set(drafts, {})
  set(followUps, {})
  set(errors, {})
  set(imageAt, {})
  set(selected, null)
  set(lastViewed, null)
  set(term, '')
  set(history, false)
  set(confirmReset, false)
}

const priorityTone = (d: Decision) => (d.priority === 'P0' ? 'danger' : d.priority === 'P1' ? 'warning' : 'neutral')
const where = (d: Decision) => `${d.projectName} · ${d.workspaceName}${d.origin.hostId !== 'local' ? ` · ${d.origin.hostId}` : ''}`

/** Always visible: says this is sample data and that nothing leaves the preview. */
function PreviewNotice() {
  return (
    <Callout tone="accent" icon="info" title="Preview · sample data">
      Answers you save stay in this preview on this desktop. Nothing is sent to a Chat, mail or Bot Items.
    </Callout>
  )
}

function ResetConfirm() {
  if (!read(confirmReset)) return null
  return (
    <Callout tone="warning" title="Reset the preview?">
      <Stack gap="xs">
        <Text size="sm">This clears every test answer saved in the preview and restores the sample cards.</Text>
        <Row gap="xs">
          <Button size="sm" tone="danger" onPress={resetPreview}>Reset preview data</Button>
          <Button size="sm" variant="ghost" onPress={() => set(confirmReset, false)}>Cancel</Button>
        </Row>
      </Stack>
    </Callout>
  )
}

function Header(props: { need: number }) {
  return (
    <Row justify="between" align="center">
      <Heading level={2}>Decision Inbox Preview</Heading>
      <Row gap="xs" align="center">
        <Badge tone={props.need ? 'accent' : 'neutral'}>{`${props.need} need you`}</Badge>
        <IconButton icon="refresh" label="Reset preview data" tooltip="Reset preview data" size="sm" variant="ghost"
          onPress={() => set(confirmReset, true)} />
      </Row>
    </Row>
  )
}

function DecisionRow(props: { d: Decision; all: readonly Decision[]; st: PreviewStore; at: number }) {
  const { d, all, st, at } = props
  const due = deadlineLabel(d, at)
  const state = cardState(d, st)
  const pkg = packageOf(all, d).length
  const images = d.evidence.filter((e) => e.kind === 'image-snapshot').length
  return (
    <ListItem title={d.title} description={where(d)} current={read(lastViewed) === d.questionId}
      onPress={() => openCard(d.questionId)}>
      <Row gap="xs" wrap>
        <Badge tone={priorityTone(d)}>{d.priority}</Badge>
        {due && <Badge tone={due.overdue ? 'danger' : 'warning'}>{due.text}</Badge>}
        {state !== 'awaiting-answer' && <Badge tone={state === 'saved-in-preview' ? 'success' : 'neutral'}>{CARD_STATE_LABEL[state]}</Badge>}
        {pkg > 1 && <Badge>{`Package · ${pkg} questions`}</Badge>}
        {images > 0 && <Badge>{`${images} images`}</Badge>}
      </Row>
      {d.blockedWork.length > 0 && <Text muted size="xs">{`Blocks: ${d.blockedWork.join(', ')}`}</Text>}
    </ListItem>
  )
}

function ListView(props: { all: readonly Decision[]; st: PreviewStore; at: number }) {
  const { all, st, at } = props
  const t = read(term)
  const h = read(history)
  const shown = visible(all, st, { term: t, history: h, now: at, zone: zone() })
  const saved = all.filter((d) => cardState(d, st) === 'saved-in-preview').length
  return (
    <Stack gap="sm">
      <Input label="Search" type="search" placeholder="Title, background, option, ID, 中文…" value={t}
        onChange={(v) => set(term, v)} />
      <Checkbox label="Include history" description="Sample history and answers saved in this preview"
        checked={h} onChange={(v) => set(history, v)} />
      {!h && saved > 0 && (
        <Text muted size="xs">{`${saved} answered in this preview. Turn on Include history to see ${saved === 1 ? 'it' : 'them'}.`}</Text>
      )}
      {shown.length === 0
        ? (
          <EmptyState icon="check" title={t.trim() ? 'No matches' : 'Nothing needs you'}
            description={t.trim() ? 'Try another word, or turn on Include history.' : 'Turn on Include history, or reset the preview to start again.'} />
        )
        : (
          <List label="Sample decisions, most urgent first">
            {shown.map((d) => <DecisionRow key={d.questionId} d={d} all={all} st={st} at={at} />)}
          </List>
        )}
    </Stack>
  )
}

function Evidence(props: { d: Decision }) {
  const { d } = props
  const images = d.evidence.flatMap((e) => (e.kind === 'image-snapshot' ? [e] : []))
  const links = d.evidence.flatMap((e) => (e.kind === 'link' ? [e] : []))
  if (!images.length && !links.length) return null
  const answered = repliesOf(read(store), d).length > 0
  const i = Math.min(read(imageAt)[d.questionId] ?? 0, Math.max(images.length - 1, 0))
  const go = (n: number) => update(imageAt, (all) => ({ ...all, [d.questionId]: n }))
  const img = images[i]
  const notes = draftOf(d.questionId).notes
  return (
    <Stack gap="xs">
      <Heading level={3}>{images.length ? `Evidence · ${images.length} images` : 'Evidence'}</Heading>
      {img && (
        <Stack gap="xs">
          <Image src={IMAGE_FILES[img.attachmentId]} alt={img.alt} size="full" fit="contain" rounded />
          <Text size="xs" muted>{`Image ${i + 1} of ${images.length} · ${img.label} · ${img.width}×${img.height} (synthetic)`}</Text>
          <Row justify="between">
            <Button size="sm" variant="outline" disabled={i === 0} onPress={() => go(i - 1)}>Previous image</Button>
            <Button size="sm" variant="outline" disabled={i === images.length - 1} onPress={() => go(i + 1)}>Next image</Button>
          </Row>
          <Grid columns={4} gap="xs">
            {images.map((e, k) => (
              <Stack key={e.evidenceId} gap="xs" align="center">
                <Image src={IMAGE_FILES[e.attachmentId]} alt="" size="xs" fit="cover" rounded />
                <Button size="xs" variant={k === i ? 'solid' : 'ghost'} tooltip={e.label} onPress={() => go(k)}>
                  {`${k + 1}${notes[e.evidenceId]?.trim() ? ' •' : ''}`}
                </Button>
              </Stack>
            ))}
          </Grid>
          {!answered && (
            <Input label={`Note on image ${i + 1} (optional)`} placeholder="Saved with your answer" value={notes[img.evidenceId] ?? ''}
              onChange={(v) => editDraft(d.questionId, { notes: { ...draftOf(d.questionId).notes, [img.evidenceId]: v } })} />
          )}
        </Stack>
      )}
      {links.map((e) => <Text key={e.evidenceId} size="sm">{`${e.label} (linked plan, version ${e.version}; not opened in the preview)`}</Text>)}
    </Stack>
  )
}

function SavedReply(props: { d: Decision; r: PreviewReply }) {
  const { d, r } = props
  return (
    <Callout tone="success" icon="check" title={r.kind === 'initial' ? 'Saved in this preview' : 'Follow-up saved in this preview'}>
      <Stack gap="xs">
        <Text size="sm">{describeAnswer(d, r.answer)}</Text>
        {r.annotations.map((a, k) => (
          <Text key={k} size="xs" muted>{`Note on ${a.kind === 'image' ? d.evidence.find((e) => e.evidenceId === a.evidence.evidenceId)?.label ?? 'image' : 'text'}: ${a.text}`}</Text>
        ))}
        <Text size="xs" muted>Saved <RelativeTime at={r.savedAt} /> · {r.replyId}</Text>
        <Text size="xs" muted>Not sent anywhere. In the real Inbox this reply goes to the original Chat.</Text>
      </Stack>
    </Callout>
  )
}

function ReplyForm(props: { d: Decision }) {
  const { d } = props
  const id = d.questionId
  const draft = draftOf(id)
  const error = read(errors)[id]
  const save = () => saveReply(d, 'initial')
  return (
    <Stack gap="sm">
      <Heading level={3}>Your answer</Heading>
      {d.options.length > 0 && (
        <RadioGroup label="Choose an option" value={draft.optionId}
          options={d.options.map((o) => ({ value: o.optionId, label: o.label, ...(o.detail ? { description: o.detail } : {}) }))}
          onChange={(v) => editDraft(id, { optionId: v })} />
      )}
      <Textarea label={d.options.length ? 'Detail (optional)' : 'Your reply'} rows={3} maxLength={4000}
        placeholder={d.options.length ? 'Anything the agent should know' : 'Type your reply'}
        value={draft.text} invalid={!!error && !d.options.length}
        onChange={(v) => editDraft(id, { text: v })}
        onSubmit={(v) => { editDraft(id, { text: v }); save() }} />
      {error && <Text tone="danger" size="sm">{error}</Text>}
      <Button tone="accent" icon="check" onPress={save}>Save test answer</Button>
      <Text muted size="xs">Saved only in this preview. Ctrl+Enter (Cmd+Enter on macOS) also saves.</Text>
    </Stack>
  )
}

function Thread(props: { d: Decision; replies: PreviewReply[] }) {
  const { d, replies } = props
  const id = d.questionId
  const error = read(errors)[id]
  const a = d.answerState
  return (
    <Stack gap="sm">
      <Heading level={3}>Answers</Heading>
      {a.state === 'answered' && (
        <Card title="Sample answer" description="Part of the sample data">
          <Stack gap="xs">
            <Text size="sm">{describeAnswer(d, a.initial.answer)}</Text>
            <Text size="xs" muted>Shown as Agent received in the sample history. The receipt is synthetic.</Text>
          </Stack>
        </Card>
      )}
      {replies.map((r) => <SavedReply key={r.replyId} d={d} r={r} />)}
      <Textarea label="Add a follow-up" rows={2} maxLength={4000} placeholder="A later note on the same question"
        value={read(followUps)[id] ?? ''} invalid={!!error}
        onChange={(v) => { update(followUps, (all) => ({ ...all, [id]: v })); update(errors, (all) => { const { [id]: _g, ...rest } = all; return rest }) }}
        onSubmit={(v) => { update(followUps, (all) => ({ ...all, [id]: v })); saveReply(d, 'follow-up') }} />
      {error && <Text tone="danger" size="sm">{error}</Text>}
      <Button variant="outline" onPress={() => saveReply(d, 'follow-up')}>Save follow-up</Button>
    </Stack>
  )
}

function DetailView(props: { d: Decision; all: readonly Decision[]; st: PreviewStore; at: number }) {
  const { d, all, st, at } = props
  const due = deadlineLabel(d, at)
  const state = cardState(d, st)
  const pkg = packageOf(all, d)
  const replies = repliesOf(st, d)
  return (
    <Stack gap="md">
      <Row>
        <Button size="sm" variant="ghost" icon="collapse" onPress={() => set(selected, null)}>Back to list</Button>
      </Row>
      <Stack gap="xs">
        <Text muted size="xs">{where(d)}</Text>
        <Heading level={3}>{d.title}</Heading>
        <Row gap="xs" wrap>
          <Badge tone={priorityTone(d)}>{d.priority}</Badge>
          {due && <Badge tone={due.overdue ? 'danger' : 'warning'}>{due.text}</Badge>}
          <Badge tone={state === 'saved-in-preview' ? 'success' : state === 'awaiting-answer' ? 'accent' : 'neutral'}>{CARD_STATE_LABEL[state]}</Badge>
        </Row>
        {d.deadline && <Text muted size="xs">{`Deadline ${new Date(d.deadline).toLocaleString()}`}</Text>}
        {d.blockedWork.length > 0 && <Text muted size="xs">{`Blocks: ${d.blockedWork.join(', ')}`}</Text>}
      </Stack>

      {pkg.length > 1 && (
        <Card title={`Package · ${pkg.length} questions`} description={d.packageSummary ?? 'These questions share context. Each is answered on its own.'}>
          <List label="Questions in this package">
            {pkg.map((x, k) => (
              <ListItem key={x.questionId} title={`${k + 1}. ${x.title}`} description={CARD_STATE_LABEL[cardState(x, st)]}
                current={x.questionId === d.questionId} onPress={() => openCard(x.questionId)} />
            ))}
          </List>
        </Card>
      )}

      <Stack gap="xs">
        <Heading level={3}>Background</Heading>
        <Text size="sm">{d.background}</Text>
      </Stack>
      <Stack gap="xs">
        <Heading level={3}>Recommendation</Heading>
        <Text size="sm">{d.recommendation}</Text>
      </Stack>
      {d.options.length > 0 && state !== 'awaiting-answer' && (
        <Stack gap="xs">
          <Heading level={3}>Options</Heading>
          {d.options.map((o) => <Text key={o.optionId} size="sm">{`• ${o.label}${o.detail ? ` — ${o.detail}` : ''}`}</Text>)}
        </Stack>
      )}
      <Evidence d={d} />
      {state === 'awaiting-answer' ? <ReplyForm d={d} /> : <Thread d={d} replies={replies} />}
    </Stack>
  )
}

export default function Panel() {
  const st = read(store)
  const at = read(now)
  const all = samplesAt(st.seededAt ?? at)
  const need = all.filter((d) => isActionable(d, st)).length
  const id = read(selected)
  const open = id ? all.find((d) => d.questionId === id) : undefined
  return (
    <Stack gap="sm">
      <Header need={need} />
      <PreviewNotice />
      <ResetConfirm />
      {open ? <DetailView d={open} all={all} st={st} at={at} /> : <ListView all={all} st={st} at={at} />}
    </Stack>
  )
}
