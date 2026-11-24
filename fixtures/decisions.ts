import type { Decision, Evidence, Origin, QuestionInput, RecordedReply } from '../src/contract.ts'

export const clock = '2030-06-14T12:00:00Z'
export const origins = {
  studio: { hostId: 'local', workspaceId: 'studio', sessionId: 'studio-chat' },
  library: { hostId: 'local', workspaceId: 'library', sessionId: 'library-chat' },
  remote: { hostId: 'paired', workspaceId: 'studio', sessionId: 'remote-chat' },
} satisfies Record<string, Origin>

function decision(
  origin: Origin, projectName: string, packageId: string, day: number, question: QuestionInput,
  evidence: Evidence[] = [],
): Decision {
  return {
    ...question,
    origin, projectName, workspaceName: origin.workspaceId, packageId, evidence,
    revision: 1,
    requestId: `request-${packageId}`,
    createdAt: `2030-06-${day}T09:00:00Z`,
    sourceLinks: [{ label: 'Synthetic project record', url: `https://example.invalid/records/${packageId}` }],
    decisionLink: `https://example.invalid/inbox/${question.questionId}`,
    access: {
      participantIds: ['fixture-owner', origin.sessionId],
      attachmentReaderIds: Object.fromEntries(evidence.flatMap((item) =>
        item.kind === 'image-snapshot' ? [[item.attachmentId, ['fixture-owner', origin.sessionId]]] : [],
      )),
    },
    answerState: { state: 'awaiting-answer' },
  }
}

const schedule = decision(origins.studio, 'Paper Studio', 'calendar', 10, {
  questionId: 'schedule', title: 'Pick a rehearsal slot', background: 'Both rooms are available.',
  recommendation: 'Choose Tuesday for 錄音 practice.', priority: 'P3', blockedWork: ['Send invitations'],
  options: [{ optionId: 'tue', label: 'Tuesday' }, { optionId: 'thu', label: 'Thursday' }],
})

const stage = decision(origins.remote, 'Lantern Workshop', 'pilot', 12, {
  questionId: 'stage', title: 'Approve the first lantern trial', background: 'Phase one uses three paper models. Any wider trial needs a separate approval.',
  recommendation: 'Approve phase one before the borrowed space closes.', priority: 'P1',
  deadline: '2030-06-14T15:00:00Z', blockedWork: ['Book the trial space'],
  options: [{ optionId: 'phase-one', label: 'Approve phase one only' }, { optionId: 'hold', label: 'Hold trial' }],
})

const layout = decision(origins.library, 'Seed Catalogue', 'layout', 11, {
  questionId: 'layout', title: 'Choose the catalogue layout', background: 'The printed sample varies in contrast and browsing speed.',
  recommendation: 'Use the grid if text remains readable.', priority: 'P2', deadline: '2030-06-13T11:00:00Z',
  blockedWork: ['Prepare print sample'],
  options: [{ optionId: 'grid', label: 'Grid' }, { optionId: 'list', label: 'List' }, { optionId: 'tiles', label: 'Fold-out tiles' }],
})

const sharedEvidence: Evidence[] = [{ kind: 'link', evidenceId: 'floor-plan', version: 2, label: 'Reading room plan', url: 'https://example.invalid/evidence/floor-plan' }]
const readingRoom = {
  background: 'The shared reading room has a narrow west aisle and a quieter east entrance. The display can be moved after the morning session. A separate class uses the room after lunch, so volunteers need to know when to reset the furniture. The plan records both entrances and the display footprint.',
  recommendation: 'Keep a clear route from the east entrance and reserve a reset window before lunch.',
  priority: 'P0',
  options: [{ optionId: 'approve', label: 'Approve proposed arrangement' }, { optionId: 'revise', label: 'Request revision' }],
  blockedWork: ['Confirm volunteer instructions'],
} satisfies Omit<QuestionInput, 'questionId' | 'title'>
const route = decision(origins.library, 'Seed Catalogue', 'room', 10,
  { ...readingRoom, questionId: 'room-route', title: 'Approve the reading room route' }, sharedEvidence)
const reset = decision(origins.library, 'Seed Catalogue', 'room', 11,
  { ...readingRoom, questionId: 'room-reset', title: 'Approve the reading room reset window' }, sharedEvidence)

const images = [
  { label: 'Front wide', width: 1600, height: 900 },
  { label: 'Front portrait', width: 900, height: 1600 },
  { label: 'Side square', width: 1000, height: 1000 },
  { label: 'Side landscape', width: 1200, height: 800 },
  { label: 'Detail portrait', width: 800, height: 1200 },
  { label: 'Panorama', width: 1800, height: 600 },
  { label: 'Tall detail', width: 600, height: 1800 },
]
const imageEvidence: Evidence[] = images.map(({ label, width, height }, index) => ({
  kind: 'image-snapshot', evidenceId: `model-${index + 1}`, version: 1,
  attachmentId: `placeholder-${index + 1}`, label, width, height, alt: `Synthetic ${label.toLowerCase()} view`,
}))
const review = decision(origins.studio, 'Paper Studio', 'models', 10, {
  questionId: 'image-review', title: 'Compare seven paper model views', background: 'Paper models use different fold angles.',
  recommendation: 'Compare the panorama with the portrait before choosing.', options: [],
  priority: 'P2', blockedWork: ['Select display model'],
}, imageEvidence)

export const decisions = [schedule, stage, layout, route, reset, review]

const initial = {
  questionId: 'layout', replyId: 'layout-answer', kind: 'initial',
  answer: {
    kind: 'option', optionId: 'grid',
    detail: 'Use the grid if each label stays readable at arm’s length on the matte sample. Ask two volunteers to identify the smallest labels without moving the sample. If either volunteer misses two labels, switch to the list for the first print run and bring a revised grid to a later review. Keep fold-out tiles for a separate demonstration.',
  },
  annotations: [], acceptedAt: '2030-06-14T12:01:00Z',
  delivery: {
    state: 'agent-received',
    receipt: { questionId: 'layout', replyId: 'layout-answer', receiptId: 'layout-receipt', origin: origins.library, receivedAt: '2030-06-14T12:02:00Z' },
  },
} satisfies RecordedReply

export const historyExample: Decision = { ...layout, answerState: { state: 'answered', initial, followUps: [] } }
export const reviewReply = {
  questionId: 'image-review', replyId: 'image-reply', kind: 'initial',
  answer: { kind: 'text', text: 'Use the side view as the comparison baseline.' },
  annotations: [
    { kind: 'image', evidence: { evidenceId: 'model-6', version: 1 }, text: 'Compare the outer edge in the panorama.' },
    { kind: 'selection', anchor: { kind: 'question', field: 'background', revision: 1 }, start: 0, end: 12, quote: 'Paper models', text: 'Use the same paper stock.' },
  ],
  acceptedAt: '2030-06-14T12:03:00Z', delivery: { state: 'submitted' },
} satisfies RecordedReply
