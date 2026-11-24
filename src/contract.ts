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

export interface QuestionInput {
  questionId: string
  title: string
  background: string
  recommendation: string
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
      | { kind: 'question'; revision: number; field: 'background' | 'recommendation' }
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
  | { state: 'submitted' }
  | { state: 'agent-received'; receipt: AgentReceipt }
  | { state: 'undelivered'; reason: 'closed-origin' | 'disconnected' | 'origin-mismatch' | 'delivery-failed' }

export interface RecordedReply extends SubmitReply {
  acceptedAt: string
  delivery: Delivery
}

export type AnswerState =
  | { state: 'awaiting-answer' }
  | { state: 'answered'; initial: RecordedReply; followUps: RecordedReply[] }

export interface Decision extends QuestionInput {
  revision: number
  requestId: string
  packageId: string
  packageSummary?: string
  projectName: string
  workspaceName: string
  origin: Origin
  access: AccessContext
  createdAt: string
  decisionLink: string
  sourceLinks: SourceLink[]
  evidence: Evidence[]
  answerState: AnswerState
}

export interface ListDecisions {
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
