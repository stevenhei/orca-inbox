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
import type { Failure } from './client.ts'

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

// ---- lifecycle: one owner for the choice, the focused workspace and the authorized inventory ------
//
// Both views keep their Workspace state in a ScopeState and change it only through a ScopeTracker.
// The tracker re-reads `workspace.options` on focus changes, on Orca's workspace.created/removed,
// when the view comes back into view, on an explicit retry, and after the worker refuses the scope
// in effect. Late answers never overwrite newer ones (sequence numbers per read). It never widens:
// a workspace that a complete inventory no longer lists leaves the view asking for a choice (the
// explicit choice stays pinned, so it comes back by itself if the workspace returns); a refusal the
// inventory does not confirm (for example "owner only") is an ordinary error, shown as such.

export type ScopeState = {
  /** The owner's explicit choice; pinned for the life of the view. */
  chosen?: Scope
  /** Focused workspace: undefined while unknown, null when none or it could not be resolved. */
  focus: Workspace | null | undefined
  focusFail: Failure | null
  inv: WorkspaceOptions | null
  invFail: Failure | null
}
export const emptyScopeState = (): ScopeState => ({ focus: undefined, focusFail: null, inv: null, invFail: null })
type R<T> = { ok: true; value: T } | Failure
export type ScopeIO = {
  options(): Promise<R<WorkspaceOptions>>
  resolve(workspaceId: string): Promise<R<Workspace>>
}

/** The scope to list now, or null when the owner must choose. */
export const scopeOf = (s: ScopeState): Scope | null => effectiveScope(s.chosen, s.focus, s.inv)
export const scopeKey = (s: ScopeState) => { const sc = scopeOf(s); return sc ? scopeValue(sc) : 'none' }
/** What the owner meant: the choice, else the focused workspace. */
export const intendedScope = (s: ScopeState): Scope | null => s.chosen ?? (s.focus ? { kind: 'workspace', workspace: s.focus } : null)
/** The intended workspace when a complete inventory no longer lists it. */
export function lostWorkspace(s: ScopeState): Workspace | null {
  const i = intendedScope(s)
  return i?.kind === 'workspace' && missing(i.workspace, s.inv) ? i.workspace : null
}
/** The worker refused this workspace scope: the owner is asked again; nothing is widened. */
export const refusesScope = (r: { ok: boolean; code?: string }, scope: Scope) =>
  !r.ok && scope.kind === 'workspace' && (r.code === 'forbidden' || r.code === 'not-found')

export class ScopeTracker {
  private invSeq = 0
  private focusSeq = 0
  private invRead: Promise<boolean> | null = null
  constructor(private store: { get(): ScopeState; set(s: ScopeState): void }, private io: ScopeIO) {}
  get state() { return this.store.get() }
  /** Applies a change; true when the scope in effect changed (the caller starts a new first page). */
  private apply(patch: Partial<ScopeState>): boolean {
    const before = scopeKey(this.state)
    this.store.set({ ...this.state, ...patch })
    return scopeKey(this.state) !== before
  }
  /** Re-reads the authorized inventory. A failed read keeps the last list and says why. */
  refreshInventory(): Promise<boolean> {
    const mine = ++this.invSeq
    const p = this.io.options().then((r) => {
      if (mine !== this.invSeq) return false
      return r.ok ? this.apply({ inv: r.value, invFail: null }) : this.apply({ invFail: r })
    }).finally(() => { if (this.invRead === p) this.invRead = null })
    this.invRead = p
    return p
  }
  /** The first inventory read, or the one in flight. */
  ensureInventory(): Promise<boolean> {
    if (this.invRead) return this.invRead
    return this.state.inv || this.state.invFail ? Promise.resolve(false) : this.refreshInventory()
  }
  /**
   * Orca's focused workspace changed (or is first reported). The inventory is read again with it,
   * so a workspace created and focused since the last read is offered instead of reported missing.
   */
  async focusChanged(context: { workspaceId?: string } | null | undefined): Promise<boolean> {
    const mine = ++this.focusSeq
    const inv = this.refreshInventory()
    if (!context?.workspaceId) {
      await inv
      if (mine !== this.focusSeq) return false
      return this.apply({ focus: null, focusFail: null })
    }
    const [r] = await Promise.all([this.io.resolve(context.workspaceId), inv])
    if (mine !== this.focusSeq) return false
    return this.apply({ focus: r.ok ? r.value : null, focusFail: r.ok ? null : r })
  }
  /**
   * An explicit Workspace choice (a select value). Always pinned, also when it names the workspace
   * already shown through focus, so a later focus change does not move it. True when the scope in
   * effect changed (the caller reads a new first page).
   */
  choose(value: string): boolean {
    const s = this.state
    const extra = [s.chosen?.kind === 'workspace' ? s.chosen.workspace : null, s.focus ?? null].filter((x): x is Workspace => !!x)
    const sc = scopeFromValue(value, s.inv?.workspaces ?? [], extra)
    if (!sc) return false
    return this.apply({ chosen: sc })
  }
  /**
   * A list answer for `scope`. When the worker refused a workspace scope, the inventory is read
   * again; true when that inventory confirms the workspace is gone (the view then asks for a choice
   * and shows nothing from this answer). False means show the answer's error as usual.
   */
  async refused(scope: Scope, r: { ok: boolean; code?: string }): Promise<boolean> {
    if (!refusesScope(r, scope)) return false
    await this.refreshInventory()
    return scope.kind === 'workspace' && missing(scope.workspace, this.state.inv)
  }
}
