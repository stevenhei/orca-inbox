import type { OrcaWorkerApi, PanelRequestContext } from 'orca/worker'
import { InboxBackend, result } from './backend.ts'
import type { InboxBoundary } from './backend.ts'
import { orcaStorage } from './backend-storage.ts'
import type { Decision } from './contract.ts'
import type { OwnerCaller, SourceAvailability } from './backend-protocol.ts'
import { hints, localOrca, removeHint, writeReference } from './backend-local.mjs'
import { desktopOwner, localInboxBoundary, nativeDetail, nativePage, nativePrefix, processChatHint } from './backend-orca.ts'
import { id, InboxError, object } from './backend-validation.ts'

type Reference = { questionId: string } | { view: 'settings' }

export interface WorkerBoundary {
  // Resolve plugin-local desktop scope from the host-supplied request context.
  resolveOwner(context: PanelRequestContext): Promise<OwnerCaller>
  native: InboxBoundary
  openReference(caller: OwnerCaller, reference: Reference): Promise<void>
  localSources?: {
    cli: typeof localOrca
    hints: typeof hints
    removeHint: typeof removeHint
  }
}

function localActions(decision: Decision): Decision {
  if (decision.source?.kind === 'native-item') return decision
  return { ...decision, source: { kind: 'plugin' },
    actions: decision.answerState.state === 'awaiting-answer' ? ['reply'] : ['follow-up'] }
}

const missing = (feature: string) => new InboxError('unavailable', `${feature} is unavailable on this Orca host.`)

type NavigationStage = 'workspace selection' | 'file materialization' | 'editor.open'
type NavigationView = 'review' | 'settings'

const hostNavigationCodes = new Set([
  'invalid_request', 'invalid_params', 'unknown_method', 'capability_denied', 'consent_required',
  'not_permitted', 'rate_limited', 'unavailable', 'action_failed', 'cancelled', 'timeout', 'conflict', 'too_large'
])
const fileNavigationCodes = new Set([
  'EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'ENOENT', 'ENOTDIR', 'ELOOP', 'EEXIST',
  'invalid_workspace_path', 'unsafe_reference_directory', 'invalid_reference_file'
])

class NavigationError extends InboxError {
  constructor(readonly stage: NavigationStage, readonly reason: string) {
    super('unavailable', `Could not open the wide tab (${stage}: ${reason}).`)
  }
}

function navigationError(stage: NavigationStage, error: unknown): NavigationError {
  if (error instanceof NavigationError) return error
  const failure = error as { code?: unknown; message?: unknown } | null
  const code = failure?.code
  const message = failure?.message
  const codes = stage === 'file materialization' ? fileNavigationCodes : hostNavigationCodes
  // The v1.4.271 renderer sends its workspace-not-listed message through
  // editor.open's action_failed. Keep the category without the workspace ID.
  const reason = stage === 'editor.open' && code === 'action_failed' &&
    typeof message === 'string' && message.startsWith('This window does not list ')
    ? 'workspace_not_found'
    : typeof code === 'string' && codes.has(code) ? code : 'unexpected_error'
  return new NavigationError(stage, reason)
}

async function navigationStep<T>(stage: NavigationStage, work: () => T | Promise<T>): Promise<T> {
  try { return await work() }
  catch (error) { throw navigationError(stage, error) }
}

export function registerWorker(orca: OrcaWorkerApi, boundary: WorkerBoundary) {
  const backend = new InboxBackend(orcaStorage(orca.storage), boundary.native, {
    changed: () => orca.panels.post('inbox.changed', {})
  })

  void backend.recoverInterruptedDelivery()

  function logNavigationFailure(view: NavigationView, error: NavigationError) {
    try { orca.log(`[wide-tab] ${view}: ${error.stage}: ${error.reason}`) }
    catch { /* A log failure must preserve the navigation result. */ }
  }

  async function withOwner<T>(context: PanelRequestContext, action: (owner: OwnerCaller) => Promise<T>, view?: NavigationView) {
    const verified = await result(async () => {
      try { return await boundary.resolveOwner(context) }
      catch (error) {
        if (!view || error instanceof InboxError) throw error
        const failure = navigationError('workspace selection', error)
        logNavigationFailure(view, failure)
        throw failure
      }
    })
    return verified.ok ? action(verified.value) : verified
  }

  function openWide(caller: OwnerCaller, view: NavigationView, reference: Reference) {
    return result(async () => {
      try {
        await navigationStep('editor.open', () => boundary.openReference(caller, reference))
      } catch (error) {
        if (error instanceof NavigationError) logNavigationFailure(view, error)
        throw error
      }
      return null
    })
  }

  orca.panels.handle('workspace.options', (_input, context) => withOwner(context, caller => result(() => {
    if (!caller.workspaceOptions) throw missing('Workspace choices')
    return caller.workspaceOptions
  })))

  orca.panels.handle('workspace.resolve', input => result(async () => {
    const workspaceId = id(object(input).workspaceId, 'workspaceId', 1024)
    // Both host calls use Orca's canonical workspace ID. Confirm focus around
    // the inventory read, since a panel-supplied ID establishes no host binding.
    const before = await orca.host.call('workspace.readContext')
    if (before?.workspaceId !== workspaceId) {
      throw new InboxError('unavailable', 'The focused workspace could not be verified. Switch to All workspaces.')
    }
    const { workspaces, truncated } = await orca.host.call('workspace.list')
    const after = await orca.host.call('workspace.readContext')
    const matches = workspaces.filter(item => item.id === workspaceId)
    if (after?.workspaceId !== workspaceId) {
      throw new InboxError('unavailable', 'Workspace focus changed during verification. Switch to All workspaces.')
    }
    if (matches.length > 1) {
      throw new InboxError('unavailable', 'Multiple hosts report the focused workspace ID. Switch to All workspaces.')
    }
    if (truncated && matches.length === 0) {
      throw new InboxError('unavailable', 'The workspace inventory was incomplete. Switch to All workspaces.')
    }
    const workspace = matches[0]
    if (!workspace) throw new InboxError('unavailable', 'The focused workspace is missing from the inventory. Switch to All workspaces.')
    return { hostId: workspace.hostId ?? 'local', workspaceId }
  }))

  const local = boundary.localSources
  let intake: Promise<boolean> | undefined
  let hintsPending = false
  let attachmentPending = false
  const syncHints = (caller: OwnerCaller) => {
    if (!local) return Promise.resolve(false)
    return intake ??= (async () => {
      let pending = false
      attachmentPending = false
      try {
        const names = await local.hints()
        await Promise.all(names.map(async name => {
          try {
            if (await processChatHint(local.cli, backend, caller, name)) await local.removeHint(name)
            else pending = true
          } catch (error) {
            pending = true
            if (error instanceof InboxError && error.message.startsWith('A staged local image is missing or invalid.')) attachmentPending = true
          }
        }))
      } catch { pending = true }
      hintsPending = pending
      return pending
    })().finally(() => { intake = undefined })
  }

  orca.panels.handle('listDecisionPage', (input, context) => withOwner(context, async caller => {
    if (!local) return backend.listDecisionPage(caller, input)
    const selection = input?.scope
    const host = selection?.kind === 'workspace' ? selection.workspace?.hostId : undefined
    if (selection?.kind === 'workspace' && !caller.workspaces.some(workspace =>
      workspace.hostId === host && workspace.workspaceId === selection.workspace?.workspaceId)) {
      return result(() => { throw new InboxError('forbidden', 'Inbox workspace is missing or inaccessible.') })
    }
    const remoteScope = Boolean(host && host !== 'local')
    const [pending, native] = await Promise.all([
      remoteScope ? false : input?.cursor ? hintsPending : syncHints(caller),
      nativePage(local.cli, caller.workspaces, host)
    ])
    const page = await backend.listDecisionPage(caller, input, native.rows)
    const remoteGap = 'Paired Chat submissions cannot be read yet. The local lookup hint is not exposed by Orca’s paired CLI.'
    const coverage = [pending ? 'Some Chat submissions are waiting for verification.' : '',
      !remoteScope && attachmentPending ? 'A staged local image is missing or invalid. Stage it again or use a source link.' : '',
      native.hasPairedCoverage || (!host && caller.workspaces.some(workspace => workspace.hostId !== 'local')) ? remoteGap : ''
    ].filter(Boolean)
    const plugin: SourceAvailability = remoteScope
      ? { source: 'plugin', state: 'unavailable', message: remoteGap }
      : coverage.length ? { source: 'plugin', state: 'partial', message: coverage.join(' ') }
      : { source: 'plugin', state: 'available' }
    return page.ok ? { ...page, value: {
      ...page.value, rows: page.value.rows.map(localActions), sources: [plugin, native.source],
      mail: { state: 'unavailable' as const, message: 'Answers are saved in Decision Inbox. Orca mail from this plugin is unavailable on this host.' }
    } } : page
  }))
  orca.panels.handle('listDecisions', (input, context) => withOwner(context, caller => backend.listDecisions(caller, input)))

  async function readDecision(caller: OwnerCaller, input: { questionId: string }) {
    const questionId = input?.questionId
    if (local && typeof questionId === 'string' && questionId.startsWith(nativePrefix)) {
      return result(() => nativeDetail(local.cli, questionId, caller.workspaces))
    }
    const decision = await backend.getDecision(caller, input)
    return local && decision.ok ? { ...decision, value: localActions(decision.value) } : decision
  }

  orca.panels.handle('getDecision', (input, context) => withOwner(context, caller => readDecision(caller, input)))
  orca.panels.handle('submitReply', (input, context) => withOwner(context, caller => backend.submitReply(caller, input)))
  orca.panels.handle('retryReply', (input, context) => withOwner(context, caller => local
    ? result(() => { throw missing('Orca mail from Decision Inbox') })
    : backend.retryReply(caller, input)))
  orca.panels.handle('getSnapshot', (input, context) => withOwner(context, caller => backend.getSnapshot(caller, input)))
  orca.panels.handle('draft.get', (input, context) => withOwner(context, caller => backend.getDraft(caller, input)))
  orca.panels.handle('draft.save', (input, context) => withOwner(context, caller => backend.saveDraft(caller, input)))
  orca.panels.handle('settings.get', (_input, context) => withOwner(context, caller => backend.getSettings(caller)))
  orca.panels.handle('settings.save', (input, context) => withOwner(context, caller => backend.saveSettings(caller, input)))
  orca.panels.handle('settings.effective', (input, context) => withOwner(context, caller => backend.effectivePolicy(caller, input)))
  orca.panels.handle('settings.repos', (_input, context) => withOwner(context, caller => result(() => [...new Set(caller.repos)].sort())))
  orca.panels.handle('review.open', (input, context) => withOwner(context, async caller => {
    const decision = await readDecision(caller, input)
    return decision.ok ? openWide(caller, 'review', { questionId: decision.value.questionId }) : decision
  }, 'review'))
  orca.panels.handle('settings.open', (_input, context) => withOwner(context,
    caller => openWide(caller, 'settings', { view: 'settings' }), 'settings'))

  return backend
}

export function registerDesktopWorker(
  orca: OrcaWorkerApi,
  localSources = { cli: localOrca, hints, removeHint },
  createReference = writeReference
) {
  return registerWorker(orca, {
    resolveOwner: context => desktopOwner(orca, context),
    native: localInboxBoundary(localSources.cli),
    localSources,
    async openReference(caller, reference) {
      if (!orca.grantedCapabilities.includes('workspace:write')) throw new NavigationError('editor.open', 'capability_denied')
      const focused = async () => (await orca.host.call('workspace.readContext'))?.workspaceId
      const selectWorkspace = () => navigationStep('workspace selection', async () => {
        const workspaceId = await focused()
        if (!workspaceId) throw new NavigationError('workspace selection', 'no_focused_workspace')
        const { workspaces, truncated } = await orca.host.call('workspace.list')
        const matches = workspaces.filter(workspace => workspace.id === workspaceId)
        if (matches.length > 1) throw new NavigationError('workspace selection', 'ambiguous_workspace')
        const match = matches[0]
        if (!match) throw new NavigationError('workspace selection', truncated ? 'workspace_list_truncated' : 'workspace_not_listed')
        const localFolder = match.hostId === null && match.kind === 'folder' && workspaceId.startsWith('folder:')
        if (match.hostId !== 'local' && !localFolder) throw new NavigationError('workspace selection', 'local_workspace_required')
        if (!caller.workspaces.some(workspace => workspace.workspaceId === workspaceId && workspace.hostId === 'local')) {
          throw new NavigationError('workspace selection', 'workspace_out_of_scope')
        }
        if (await focused() !== workspaceId) throw new NavigationError('workspace selection', 'focus_changed')
        return { workspaceId, root: match.path, hostId: match.hostId, kind: match.kind }
      })
      const target = await selectWorkspace()
      const path = await navigationStep('file materialization', async () => {
        const path = await createReference(target.root, reference)
        if (path.length > 1024 || /[\\:\u0000-\u001f]/u.test(path) ||
          path.split('/').some(part => part === '' || part === '.' || part === '..')) {
          throw new NavigationError('file materialization', 'invalid_relative_path')
        }
        return path
      })
      const current = await selectWorkspace()
      if (current.workspaceId !== target.workspaceId) throw new NavigationError('workspace selection', 'focus_changed')
      if (current.root !== target.root || current.hostId !== target.hostId || current.kind !== target.kind) {
        throw new NavigationError('workspace selection', 'workspace_changed')
      }
      await navigationStep('editor.open', async () => {
        const opened = await orca.host.call('editor.open', { workspaceId: target.workspaceId, path })
        if (opened?.opened !== true) throw new NavigationError('editor.open', 'not_opened')
      })
    }
  })
}

export default function activate(orca: OrcaWorkerApi): void {
  registerDesktopWorker(orca)
}
