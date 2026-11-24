import type { Decision, ListDecisions, RecordedReply, Result, SubmitReply, Workspace } from './contract.ts'

export interface InboxSettings {
  defaultTemplate: string
  exceptions: { repo: string; template: string }[]
  revision: number
}

export interface EffectivePolicy {
  template: string
  source: 'default' | 'exception'
}

export interface PrivateSnapshot {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  base64: string
}

export interface ReplyDraft {
  text: string
  optionId?: string
  replyId?: string
  kind?: SubmitReply['kind']
  annotations: SubmitReply['annotations']
}

export interface DraftRecord {
  draft: ReplyDraft | null
  revision: number
}

export type DecisionPageInput = ListDecisions & { cursor?: string; timeZone?: string }
export type SourceAvailability = {
  source: 'plugin' | 'native-item'
  state: 'available' | 'partial' | 'unavailable'
  message?: string
}

export interface DecisionPage {
  sources?: SourceAvailability[]
  mail?: { state: 'available' | 'unavailable'; message?: string }
  rows: Decision[]
  nextCursor?: string
}

export interface WorkspaceOptions {
  workspaces: (Workspace & { name: string; hostLabel?: string })[]
  truncated?: boolean
}

export interface InboxUiRequests {
  'workspace.options': { input: undefined; output: Result<WorkspaceOptions> }
  'workspace.resolve': { input: { workspaceId: string }; output: Result<Workspace> }
  'settings.repos': { input: undefined; output: Result<string[]> }
  listDecisionPage: { input: DecisionPageInput; output: Result<DecisionPage> }
  listDecisions: { input: ListDecisions; output: Result<Decision[]> }
  getDecision: { input: { questionId: string }; output: Result<Decision> }
  submitReply: { input: SubmitReply; output: Result<RecordedReply> }
  retryReply: { input: { questionId: string; replyId: string }; output: Result<RecordedReply> }
  getSnapshot: { input: { questionId: string; attachmentId: string }; output: Result<PrivateSnapshot> }
  'draft.get': { input: { questionId: string }; output: Result<DraftRecord> }
  'draft.save': { input: { questionId: string; draft: ReplyDraft | null; revision: number }; output: Result<DraftRecord> }
  'settings.get': { input: undefined; output: Result<InboxSettings> }
  'settings.save': { input: InboxSettings; output: Result<InboxSettings> }
  'settings.effective': { input: { repo: string }; output: Result<EffectivePolicy> }
  'review.open': { input: { questionId: string }; output: Result<null> }
  'settings.open': { input: undefined; output: Result<null> }
}

declare module 'orca' {
  interface PluginRequests extends InboxUiRequests {}
  interface PluginPanelEvents {
    'inbox.changed': Record<string, never>
  }
}

export type OwnerCaller = { kind: 'owner'; id: string; workspaces: readonly Workspace[]; repos: readonly string[]; workspaceOptions?: WorkspaceOptions }
