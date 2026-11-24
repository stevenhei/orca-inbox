// The one Workspace choice shared by the dashboard and the panel: All workspaces, or exactly one
// workspace identified by host + workspace ID. Pure: no DOM, no Orca imports.
//
// Rules (owner-approved):
//  * Until the owner chooses, the choice follows the focused workspace (resolved by the worker).
//  * An explicit choice stays the same when focus changes.
//  * When focus is unknown or ambiguous, or the chosen workspace is no longer in the authorized
//    inventory, nothing is listed and the owner is asked to choose; the scope is never widened.
//  * Every authorized workspace is offered, even one with no decisions; equal names show the host.
import type { ListDecisions, Workspace } from './contract.ts'
import type { DecisionPageInput, WorkspaceOptions } from './backend-protocol.ts'

export type WorkspaceOption = WorkspaceOptions['workspaces'][number]
/** Exactly the `ListDecisions.scope` union the worker reads. */
export type Scope = ListDecisions['scope']

export const ALL_VALUE = 'all'
export const workspaceValue = (w: Workspace) => `ws:${encodeURIComponent(w.hostId)}:${encodeURIComponent(w.workspaceId)}`
export const scopeValue = (s: Scope) => (s.kind === 'all' ? ALL_VALUE : workspaceValue(s.workspace))
export const sameScope = (a: Scope | null, b: Scope | null) => (a && b ? scopeValue(a) === scopeValue(b) : a === b)

/** The scope a select value names, or null when it names nothing known. */
export function scopeFromValue(v: string, options: readonly WorkspaceOption[], extra: readonly Workspace[] = []): Scope | null {
  if (v === ALL_VALUE) return { kind: 'all' }
  const w = [...options, ...extra].find((o) => workspaceValue(o) === v)
  return w ? { kind: 'workspace', workspace: { hostId: w.hostId, workspaceId: w.workspaceId } } : null
}

/**
 * The scope to list: the explicit choice, else the focused workspace. Null means "ask the owner":
 * focus unknown or ambiguous, or the chosen workspace is missing from a complete inventory.
 */
export function effectiveScope(chosen: Scope | undefined, focus: Workspace | null | undefined, inv: WorkspaceOptions | null): Scope | null {
  const s: Scope | null = chosen ?? (focus ? { kind: 'workspace', workspace: focus } : null)
  if (!s || s.kind === 'all') return s
  return missing(s.workspace, inv) ? null : s
}
/** A workspace is missing only when a complete inventory was read and does not list it. */
export const missing = (w: Workspace, inv: WorkspaceOptions | null) =>
  !!inv && !inv.truncated && !inv.workspaces.some((o) => o.hostId === w.hostId && o.workspaceId === w.workspaceId)

/** "name", or "name · host" when another workspace has the same name. */
export function workspaceLabel(w: Workspace, options: readonly WorkspaceOption[]): string {
  const o = options.find((x) => x.hostId === w.hostId && x.workspaceId === w.workspaceId)
  if (!o) return w.hostId === 'local' ? w.workspaceId : `${w.workspaceId} · ${w.hostId}`
  const clash = options.some((x) => x !== o && x.name.trim().toLocaleLowerCase() === o.name.trim().toLocaleLowerCase())
  return clash ? `${o.name} · ${o.hostLabel ?? o.hostId}` : o.name
}

/**
 * Select options: All workspaces, then every authorized workspace by name. A selected or focused
 * workspace that the inventory does not list is still shown (marked unavailable) so the control
 * never claims a different selection than the one in effect. With no choice in effect, a
 * disabled placeholder asks for one.
 */
export function workspaceChoices(inv: WorkspaceOptions | null, shown: Scope | null, focus: Workspace | null | undefined):
  { value: string; label: string; disabled?: boolean }[] {
  const options = inv?.workspaces ?? []
  const out: { value: string; label: string; disabled?: boolean }[] = []
  if (!shown) out.push({ value: '', label: 'Choose a workspace…', disabled: true })
  out.push({ value: ALL_VALUE, label: 'All workspaces' })
  const extra = [shown?.kind === 'workspace' ? shown.workspace : null, focus ?? null]
    .filter((w): w is Workspace => !!w && !options.some((o) => o.hostId === w.hostId && o.workspaceId === w.workspaceId))
  for (const o of options) out.push({ value: workspaceValue(o), label: workspaceLabel(o, options) })
  for (const w of extra) if (!out.some((x) => x.value === workspaceValue(w))) {
    out.push({ value: workspaceValue(w), label: `${workspaceLabel(w, options)}${missing(w, inv) ? ' (unavailable)' : ''}` })
  }
  return out
}

/**
 * The one queue request both views send: the scope in effect (host-qualified), the worker-side
 * search, history and time zone, and a cursor only for the next page of the same query.
 */
export function queueInput(scope: Scope, q: { query?: string; includeHistory: boolean; timeZone: string; cursor?: string }): DecisionPageInput {
  const t = q.query?.trim()
  return {
    scope: scope.kind === 'all' ? { kind: 'all' } : { kind: 'workspace', workspace: { hostId: scope.workspace.hostId, workspaceId: scope.workspace.workspaceId } },
    ...(t ? { query: t } : {}), includeHistory: q.includeHistory, timeZone: q.timeZone, ...(q.cursor ? { cursor: q.cursor } : {})
  }
}
