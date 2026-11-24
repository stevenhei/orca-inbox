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

export interface InboxUiRequests {
  'workspace.resolve': { input: { workspaceId: string }; output: Result<Workspace> }
  'settings.repos': { input: undefined; output: Result<string[]> }
  listDecisions: { input: ListDecisions; output: Result<Decision[]> }
  getDecision: { input: { questionId: string }; output: Result<Decision> }
  submitReply: { input: SubmitReply; output: Result<RecordedReply> }
  retryReply: { input: { questionId: string; replyId: string }; output: Result<RecordedReply> }
  getSnapshot: { input: { questionId: string; attachmentId: string }; output: Result<PrivateSnapshot> }
  'draft.get': { input: { questionId: string }; output: Result<ReplyDraft | null> }
  'draft.save': { input: { questionId: string; draft: ReplyDraft | null }; output: Result<ReplyDraft | null> }
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

export type OwnerCaller = { kind: 'owner'; id: string; workspaces: readonly Workspace[]; repos: readonly string[] }
