export type Priority = 'P0' | 'P1' | 'P2' | 'P3'

export interface Workspace {
  hostId: string
  workspaceId: string
}

export interface Origin extends Workspace {
  sessionId: string
}

export interface AccessContext {
  // Host-resolved participant IDs. Attachment grants may further restrict access.
  participantIds: string[]
  attachmentReaderIds: Record<string, string[]>
}

export interface SourceLink {
  label: string
  url: string
}

export interface EvidenceRef {
  evidenceId: string
  version: number
}

export type Evidence = EvidenceRef & {
  label: string
} & (
  | { kind: 'image-snapshot'; attachmentId: string; width: number; height: number; alt: string }
  | { kind: 'link'; url: string }
)

export interface InlineImagePlacement extends EvidenceRef {
  // UTF-16 offset into the original background Markdown. Insert before this offset.
  offset: number
  caption?: string
}

export type VisibleInlineImage = InlineImagePlacement | { offset: number; unavailable: true }

export interface QuestionInput {
  questionId: string
  title: string
  description?: string
  background: string
  inlineImages?: InlineImagePlacement[]
  recommendation: string
  recommendedOptionId?: string
  options: { optionId: string; label: string; detail?: string }[]
  priority: Priority
  deadline?: string
  blockedWork: string[]
}

export interface SubmitDecision {
  requestId: string
  packageId: string
  summary?: string
  evidence: Evidence[]
  sourceLinks: SourceLink[]
  questions: QuestionInput[]
}

export type Annotation = { text: string } & (
  | { kind: 'image'; evidence: EvidenceRef }
  | { kind: 'selection'; anchor:
      | { kind: 'evidence'; evidence: EvidenceRef }
      | { kind: 'question'; revision: number; field: 'background' | 'description' | 'recommendation' }
    start: number; end: number; quote: string }
)

export type Answer =
  | { kind: 'option'; optionId: string; detail?: string }
  | { kind: 'text'; text: string }

export interface SubmitReply {
  questionId: string
  replyId: string
  kind: 'initial' | 'follow-up'
  answer: Answer
  annotations: Annotation[]
}

export interface AcknowledgeReply {
  questionId: string
  replyId: string
  receiptId: string
}

export interface AgentReceipt extends AcknowledgeReply {
  origin: Origin
  receivedAt: string
}

export type Delivery =
  | { state: 'local-only' }
  | { state: 'submitted'; transport?: { messageId: string; acceptedAt: string } }
  | { state: 'agent-received'; receipt: AgentReceipt }
  | { state: 'undelivered'; reason: 'closed-origin' | 'disconnected' | 'origin-mismatch' | 'delivery-failed' }

export interface RecordedReply extends SubmitReply {
  acceptedAt: string
  delivery: Delivery
}

export type AnswerState =
  | { state: 'awaiting-answer' }
  | { state: 'answered'; initial: RecordedReply; followUps: RecordedReply[] }

export const practicePrefix = 'practice:'

export type DecisionSource = { kind: 'plugin' } | { kind: 'practice' } | {
  kind: 'native-item'
  workspaceAttributed: boolean
  botName?: string
  itemLabel?: string
  itemStatus?: string
  observedAt?: string
  hostLabel?: string
}

export type DecisionAction = 'reply' | 'retry' | 'follow-up'

export interface Decision extends Omit<QuestionInput, 'inlineImages'> {
  inlineImages?: VisibleInlineImage[]
  source?: DecisionSource
  context?: string
  activity?: { label: string; at?: string; text: string }[]
  nativeLinks?: { kind: string; ref: string; label: string; url?: string }[]
  package?: { index: number; size: number | null; questionIds?: string[] }
  actions?: DecisionAction[]
  revision: number
  requestId: string
  packageId: string
  packageSummary?: string
  backgroundPreview?: string
  projectName: string
  workspaceName: string
  origin: Origin
  access: AccessContext
  createdAt: string
  decisionLink: string
  sourceLinks: SourceLink[]
  workItemLinks?: (SourceLink & { kind: 'github-issue' | 'github-pr' | 'linear-issue' })[]
  originalSessionId?: string
  evidence: Evidence[]
  answerState: AnswerState
}

export const decisionColumns = ['question', 'background', 'priority', 'status', 'source', 'workspace', 'due'] as const
export type DecisionColumn = typeof decisionColumns[number]
export type DecisionSort = { column: DecisionColumn; direction: 'asc' | 'desc' }

export interface ListDecisions {
  sort?: DecisionSort
  scope: { kind: 'workspace'; workspace: Workspace } | { kind: 'all' }
  query?: string
  includeHistory: boolean
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'invalid' | 'forbidden' | 'not-found' | 'conflict' | 'unavailable'; message: string }

// Conceptual operations. Authentication comes from the verified caller context at the
// transport boundary. These declarations do not expose Orca routes or register handlers.
export interface DecisionInbox {
  submitDecision(input: SubmitDecision): Promise<Result<Decision[]>>
  listDecisions(input: ListDecisions): Promise<Result<Decision[]>>
  getDecision(input: { questionId: string }): Promise<Result<Decision>>
  submitReply(input: SubmitReply): Promise<Result<RecordedReply>>
  acknowledgeReply(input: AcknowledgeReply): Promise<Result<RecordedReply>>
}
