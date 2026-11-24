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

export function registerWorker(orca: OrcaWorkerApi, boundary: WorkerBoundary) {
  const backend = new InboxBackend(orcaStorage(orca.storage), boundary.native, {
    changed: () => orca.panels.post('inbox.changed', {})
  })

  void backend.recoverInterruptedDelivery()

  async function withOwner<T>(context: PanelRequestContext, action: (owner: OwnerCaller) => Promise<T>) {
    const verified = await result(() => boundary.resolveOwner(context))
    return verified.ok ? action(verified.value) : verified
  }

  orca.panels.handle('workspace.resolve', input => result(async () => {
    const workspaceId = id(object(input).workspaceId, 'workspaceId', 1024)
    // Both host calls use Orca's canonical workspace ID. Confirm focus around
    // the inventory read, since a panel-supplied ID establishes no host binding.
    const before = await orca.host.call('workspace.readContext')
    if (before?.workspaceId !== workspaceId) throw missing('Current focused workspace identity')
    const { workspaces, truncated } = await orca.host.call('workspace.list')
    const after = await orca.host.call('workspace.readContext')
    const matches = workspaces.filter(item => item.id === workspaceId)
    if (after?.workspaceId !== workspaceId || matches.length > 1 || (truncated && matches.length === 0)) {
      throw missing('Unambiguous focused workspace identity')
    }
    const workspace = matches[0]
    if (!workspace) throw new InboxError('not-found', 'Workspace is missing.')
    return { hostId: workspace.hostId ?? 'local', workspaceId }
  }))

  const local = boundary.localSources
  let intake: Promise<boolean> | undefined
  const syncHints = (caller: OwnerCaller) => {
    if (!local) return Promise.resolve(false)
    return intake ??= (async () => {
      let pending = false
      try {
        const names = await local.hints()
        await Promise.all(names.map(async name => {
          try {
            if (await processChatHint(local.cli, backend, caller, name)) await local.removeHint(name)
            else pending = true
          } catch { pending = true }
        }))
      } catch { pending = true }
      return pending
    })().finally(() => { intake = undefined })
  }

  orca.panels.handle('listDecisionPage', (input, context) => withOwner(context, async caller => {
    if (!local) return backend.listDecisionPage(caller, input)
    const [pending, native] = await Promise.all([input?.cursor ? false : syncHints(caller), nativePage(local.cli)])
    const page = await backend.listDecisionPage(caller, input, native.rows)
    const plugin: SourceAvailability = { source: 'plugin', state: 'partial',
      message: (pending ? 'Some Chat submissions are waiting for verification. ' : '') +
        'Answers are saved in Decision Inbox. Orca mail from this plugin is unavailable on this host.' }
    return page.ok ? { ...page, value: { ...page.value, rows: page.value.rows.map(localActions), sources: [plugin, native.source] } } : page
  }))
  orca.panels.handle('listDecisions', (input, context) => withOwner(context, caller => backend.listDecisions(caller, input)))
  orca.panels.handle('getDecision', (input, context) => withOwner(context, async caller => {
    const questionId = input?.questionId
    if (local && typeof questionId === 'string' && questionId.startsWith(nativePrefix)) {
      return result(() => nativeDetail(local.cli, questionId))
    }
    const decision = await backend.getDecision(caller, input)
    return local && decision.ok ? { ...decision, value: localActions(decision.value) } : decision
  }))
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
    const decision = await backend.getDecision(caller, input)
    if (!decision.ok) return decision
    return result(async () => {
      await boundary.openReference(caller, { questionId: decision.value.questionId })
      return null
    })
  }))
  orca.panels.handle('settings.open', (_input, context) => withOwner(context, caller => result(async () => {
    await boundary.openReference(caller, { view: 'settings' })
    return null
  })))

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
      if (!orca.grantedCapabilities.includes('workspace:write')) throw missing('Approved review editor access')
      const before = await orca.host.call('workspace.readContext')
      const workspaceId = before?.workspaceId
      if (!workspaceId || !caller.workspaces.some(workspace => workspace.workspaceId === workspaceId && workspace.hostId === 'local')) {
        throw missing('Focused local workspace for the review')
      }
      const { workspaces } = await orca.host.call('workspace.list')
      const matches = workspaces.filter(workspace => workspace.id === workspaceId)
      if (matches.length !== 1 || (matches[0].hostId !== 'local' && matches[0].hostId !== null)) {
        throw missing('Unambiguous local workspace for the review')
      }
      const focused = () => orca.host.call('workspace.readContext')
      if ((await focused())?.workspaceId !== workspaceId) throw missing('Focused workspace changed')
      const path = await createReference(matches[0].path, reference)
      if ((await focused())?.workspaceId !== workspaceId) throw missing('Focused workspace changed')
      await orca.host.call('editor.open', { workspaceId, path })
    }
  })
}

export default function activate(orca: OrcaWorkerApi): void {
  registerDesktopWorker(orca)
}
