import type { OrcaWorkerApi, PanelRequestContext } from 'orca/worker'
import { InboxBackend, result } from './backend.ts'
import type { InboxBoundary } from './backend.ts'
import { orcaStorage } from './backend-storage.ts'
import type { OwnerCaller } from './backend-protocol.ts'
import { id, InboxError, object } from './backend-validation.ts'

type Reference = { questionId: string } | { view: 'settings' }

export interface WorkerBoundary {
  // The public PanelCaller contains surface metadata. A host adapter must provide
  // separate verified principal and scope claims before it can use the backend.
  resolveOwner(context: PanelRequestContext): Promise<OwnerCaller>
  native: InboxBoundary
  openReference(caller: OwnerCaller, reference: Reference): Promise<void>
}

const missing = (feature: string) => new InboxError('unavailable', `${feature} is unavailable on this Orca host.`)
const shippingBoundary: WorkerBoundary = {
  async resolveOwner() { throw missing('Authenticated owner access') },
  native: {
    async grantSubmission() { throw missing('Authenticated Chat submission') },
    async send() { return 'delivery-failed' },
    async verifyReceipt() { return false }
  },
  async openReference() { throw missing('Decision editor reference creation') }
}

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
    const workspaceId = id(object(input).workspaceId, 'workspaceId')
    const { workspaces, truncated } = await orca.host.call('workspace.list')
    const matches = workspaces.filter(item => item.id === workspaceId)
    if (truncated || matches.length > 1) throw missing('Unambiguous focused workspace identity')
    const workspace = matches[0]
    if (!workspace) throw new InboxError('not-found', 'Workspace is missing.')
    return { hostId: workspace.hostId ?? 'local', workspaceId }
  }))

  orca.panels.handle('listDecisions', (input, context) => withOwner(context, caller => backend.listDecisions(caller, input)))
  orca.panels.handle('getDecision', (input, context) => withOwner(context, caller => backend.getDecision(caller, input)))
  orca.panels.handle('submitReply', (input, context) => withOwner(context, caller => backend.submitReply(caller, input)))
  orca.panels.handle('retryReply', (input, context) => withOwner(context, caller => backend.retryReply(caller, input)))
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

  // A future authenticated Chat/native Items transport invokes the same backend.
  // No agent-write route is registered on the panel bridge.
  return backend
}

export default function activate(orca: OrcaWorkerApi): void {
  registerWorker(orca, shippingBoundary)
}
