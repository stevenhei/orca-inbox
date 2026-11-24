// Built-in synthetic sample data for the preview. Shapes come from the shared contract and the
// cases mirror the production fixtures (fixtures/decisions.ts on main), plus one three-question
// package. Every name, place and receipt here is invented; nothing refers to a real Chat, mail or
// Bot Item. Times are written against SAMPLE_CLOCK and shifted to the first-open time at runtime.
import type { Decision, Evidence, Origin, QuestionInput, RecordedReply } from './contract.ts'

export const SAMPLE_CLOCK = '2030-06-14T12:00:00Z'

export const origins = {
  studio: { hostId: 'local', workspaceId: 'studio', sessionId: 'studio-chat' },
  library: { hostId: 'local', workspaceId: 'library', sessionId: 'library-chat' },
  garden: { hostId: 'local', workspaceId: 'garden', sessionId: 'garden-chat' },
  remote: { hostId: 'paired', workspaceId: 'studio', sessionId: 'remote-chat' },
} satisfies Record<string, Origin>

function decision(
  origin: Origin, projectName: string, packageId: string, createdAt: string, question: QuestionInput,
  evidence: Evidence[] = [], packageSummary?: string,
): Decision {
  return {
    ...question,
    source: { kind: 'plugin' },
    origin, projectName, workspaceName: origin.workspaceId, packageId, evidence,
    ...(packageSummary ? { packageSummary } : {}),
    revision: 1,
    requestId: `request-${packageId}`,
    createdAt,
    sourceLinks: [{ label: 'Synthetic project record', url: `https://example.invalid/records/${packageId}` }],
    decisionLink: `https://example.invalid/inbox/${question.questionId}`,
    access: { participantIds: ['sample-owner', origin.sessionId], attachmentReaderIds: {} },
    answerState: { state: 'awaiting-answer' },
  }
}

const schedule = decision(origins.studio, 'Paper Studio', 'calendar', '2030-06-10T09:00:00Z', {
  questionId: 'schedule', title: 'Pick a rehearsal slot', background: 'Both rooms are available.',
  recommendation: 'Choose Tuesday for 錄音 practice.', priority: 'P3', blockedWork: ['Send invitations'],
  options: [{ optionId: 'tue', label: 'Tuesday' }, { optionId: 'thu', label: 'Thursday' }],
})

const stage = decision(origins.remote, 'Lantern Workshop', 'pilot', '2030-06-12T09:00:00Z', {
  questionId: 'stage', title: 'Approve the first lantern trial',
  background: 'Phase one uses three paper models. Any wider trial needs a separate approval.',
  recommendation: 'Approve phase one before the borrowed space closes.', priority: 'P1',
  deadline: '2030-06-14T15:00:00Z', blockedWork: ['Book the trial space'],
  options: [{ optionId: 'phase-one', label: 'Approve phase one only' }, { optionId: 'hold', label: 'Hold trial' }],
})

const layout = decision(origins.library, 'Seed Catalogue', 'layout', '2030-06-11T09:00:00Z', {
  questionId: 'layout', title: 'Choose the catalogue layout',
  background: 'The printed sample varies in contrast and browsing speed.',
  recommendation: 'Use the grid if text remains readable.', priority: 'P2', deadline: '2030-06-13T11:00:00Z',
  blockedWork: ['Prepare print sample'],
  options: [{ optionId: 'grid', label: 'Grid' }, { optionId: 'list', label: 'List' }, { optionId: 'tiles', label: 'Fold-out tiles' }],
})

const floorPlan: Evidence[] = [{ kind: 'link', evidenceId: 'floor-plan', version: 2, label: 'Reading room plan', url: 'https://example.invalid/evidence/floor-plan' }]
const readingRoom = {
  background: 'The shared reading room has a narrow west aisle and a quieter east entrance. The display can be moved after the morning session. A separate class uses the room after lunch, so volunteers need to know when to reset the furniture. The plan records both entrances and the display footprint.',
  recommendation: 'Keep a clear route from the east entrance and reserve a reset window before lunch.',
  priority: 'P0',
  options: [{ optionId: 'approve', label: 'Approve proposed arrangement' }, { optionId: 'revise', label: 'Request revision' }],
  blockedWork: ['Confirm volunteer instructions'],
} satisfies Omit<QuestionInput, 'questionId' | 'title'>
const route = decision(origins.library, 'Seed Catalogue', 'room', '2030-06-10T09:00:00Z',
  { ...readingRoom, questionId: 'room-route', title: 'Approve the reading room route' }, floorPlan)
const reset = decision(origins.library, 'Seed Catalogue', 'room', '2030-06-11T09:00:00Z',
  { ...readingRoom, questionId: 'room-reset', title: 'Approve the reading room reset window' }, floorPlan)

/** Bundled synthetic images, one per view. Width and height are the original snapshot sizes. */
export const IMAGE_FILES: Record<string, string> = {}
const views = [
  { file: 'front-wide', label: 'Front wide', width: 1600, height: 900 },
  { file: 'front-portrait', label: 'Front portrait', width: 900, height: 1600 },
  { file: 'side-square', label: 'Side square', width: 1000, height: 1000 },
  { file: 'side-landscape', label: 'Side landscape', width: 1200, height: 800 },
  { file: 'detail-portrait', label: 'Detail portrait', width: 800, height: 1200 },
  { file: 'panorama', label: 'Panorama', width: 1800, height: 600 },
  { file: 'tall-detail', label: 'Tall detail', width: 600, height: 1800 },
]
const imageEvidence: Evidence[] = views.map(({ file, label, width, height }, index) => {
  const attachmentId = `sample-${file}`
  IMAGE_FILES[attachmentId] = `assets/sample/${file}.png`
  return {
    kind: 'image-snapshot', evidenceId: `model-${index + 1}`, version: 1,
    attachmentId, label, width, height, alt: `Synthetic ${label.toLowerCase()} view of a folded paper model`,
  }
})
const imageReview = decision(origins.studio, 'Paper Studio', 'models', '2030-06-10T10:00:00Z', {
  questionId: 'image-review', title: 'Compare seven paper model views',
  background: 'Paper models use different fold angles. Each view shows the same model family from another side.',
  recommendation: 'Compare the panorama with the portrait before choosing.', options: [],
  priority: 'P2', blockedWork: ['Select display model'],
}, imageEvidence)

// A three-question package: each question is its own card and its own answer.
const volunteerSummary = 'Three linked questions for the spring volunteer day. Answer each on its own.'
const vdDate = decision(origins.garden, 'Community Garden', 'volunteer-day', '2030-06-13T08:00:00Z', {
  questionId: 'vd-date', title: 'Pick the volunteer day',
  background: 'Twelve volunteers signed up. Saturday has more helpers; Sunday has the larger tool shed slot.',
  recommendation: 'Saturday, because the planting crew can only come that day.', priority: 'P1',
  deadline: '2030-06-15T08:00:00Z', blockedWork: ['Send volunteer schedule'],
  options: [{ optionId: 'sat', label: 'Saturday morning', detail: '12 helpers, small shed slot' }, { optionId: 'sun', label: 'Sunday afternoon', detail: '8 helpers, large shed slot' }],
}, [], volunteerSummary)
const vdBudget = decision(origins.garden, 'Community Garden', 'volunteer-day', '2030-06-13T08:00:00Z', {
  questionId: 'vd-budget', title: 'Approve the hand tool budget',
  background: 'Hiring twelve hand tools costs 180 credits. Borrowing six from the library halves the cost but needs a pickup.',
  recommendation: 'Approve the full set so nobody waits for tools.', priority: 'P2', blockedWork: ['Reserve tools'],
  options: [{ optionId: 'full', label: 'Hire all twelve' }, { optionId: 'mixed', label: 'Hire six, borrow six' }],
}, [], volunteerSummary)
const vdBrief = decision(origins.garden, 'Community Garden', 'volunteer-day', '2030-06-13T08:00:00Z', {
  questionId: 'vd-brief', title: 'Write the welcome note for volunteers',
  background: 'The note is printed on the sign-in sheet. It should say where to meet and what to bring.',
  recommendation: 'Mention gloves, water and the north gate.', priority: 'P2', blockedWork: ['Print sign-in sheet'],
  options: [],
}, [], volunteerSummary)

// Sample history: an already answered question, so Include history has something to show.
const layoutAnswer = {
  questionId: 'layout', replyId: 'layout-answer', kind: 'initial',
  answer: {
    kind: 'option', optionId: 'grid',
    detail: 'Use the grid if each label stays readable at arm’s length on the matte sample. Ask two volunteers to identify the smallest labels without moving the sample. If either volunteer misses two labels, switch to the list for the first print run.',
  },
  annotations: [], acceptedAt: '2030-06-14T08:01:00Z',
  delivery: {
    state: 'agent-received',
    receipt: { questionId: 'layout', replyId: 'layout-answer', receiptId: 'layout-receipt', origin: origins.library, receivedAt: '2030-06-14T08:02:00Z' },
  },
} satisfies RecordedReply
const layoutHistory: Decision = { ...layout, answerState: { state: 'answered', initial: layoutAnswer, followUps: [] } }

export const SAMPLE_DECISIONS: readonly Decision[] = [
  schedule, stage, layoutHistory, route, reset, imageReview, vdDate, vdBudget, vdBrief,
]
