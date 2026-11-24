// One concise, collapsible source status for the dashboard and the sidebar panel, in place of one
// banner per source plus a mail banner. Pure: no Orca or DOM imports, so tests and both views share it.
//
//  * Each source is reported on its own; a failing source never hides or blames the other one.
//  * The worker's typed coverage notices become one line per kind (repeats are merged): Chat
//    submissions not verified yet, paired hosts whose submissions cannot be read, a staged image to
//    fix, Bot Items that could not all be read, and Bot Items without workspace attribution.
//  * Nothing here promises an outcome. Waiting for verification and attribution are information;
//    a read that actually failed (an unavailable source, a lookup that could not be read, partly read
//    Bot Items, a staged image to fix) is flagged in the summary itself, so it shows while collapsed.
//  * Reading a source and saving locally are independent: decisions already shown, drafts and saved
//    answers keep working whatever a source reports. Mail is said at the reply, not here.
import type { CoverageNotice, SourceAvailability } from './backend-protocol.ts'

export type StatusTone = 'info' | 'warn'
export type StatusLine = { source: SourceAvailability['source']; tone: StatusTone; label: string; text: string }
export type SourceStatusView = { tone: StatusTone; summary: string; lines: StatusLine[]; open: boolean } | null
/** What one page reports per source (older workers send no `coverage`). */
export type StatusSource = SourceAvailability

export const SOURCE_PLURAL: Record<SourceAvailability['source'], string> = { plugin: 'Chat decisions', 'native-item': 'Bot Items' }

// Kinds added by newer workers are listed too, so this file compiles against either protocol version.
type Kind = CoverageNotice['kind'] | 'hint-read-failed' | 'hint-scan-limited'
const COVERAGE: Record<Kind, { tone: StatusTone; label: string; short: string; advice: string }> = {
  'pending-verification': { tone: 'info', label: 'Not verified yet', short: 'some Chat submissions not verified yet',
    advice: 'Refresh later. If a Chat decision is still missing, ask that Chat’s agent to submit it again.' },
  'hint-read-failed': { tone: 'warn', label: 'Chat lookup could not be read', short: 'Chat lookup could not be read',
    advice: 'New Chat decisions may be missing. Check that Orca can read this workspace, then refresh.' },
  'hint-scan-limited': { tone: 'info', label: 'Lookup limit reached', short: 'more Chat submissions to check',
    advice: 'Refresh to check the rest.' },
  'paired-unreadable': { tone: 'info', label: 'Paired hosts', short: 'paired-host Chats not read',
    advice: 'Open those decisions on the paired host.' },
  'attachment-invalid': { tone: 'warn', label: 'Staged image', short: 'a staged image needs attention',
    advice: 'Ask the agent to stage the image again or to use a source link.' },
  'native-partial': { tone: 'warn', label: 'Some Bot Items not read', short: 'some Bot Items not read',
    advice: 'Check Bot Items in Orca for anything missing here.' },
  'native-attribution': { tone: 'info', label: 'No workspace attribution', short: 'Bot Items without a workspace',
    advice: 'They appear only under All workspaces.' }
}
/** An older worker's verification notice that is really a failed read (newer ones send hint-read-failed). */
const failedRead = (n: { kind: string; message: string }) => n.kind === 'pending-verification' && /could not (be )?read|denied|not permitted/i.test(n.message)

/** The status block for one page's sources, or null when every source was read in full. */
export function sourceStatus(sources: readonly StatusSource[]): SourceStatusView {
  const lines: StatusLine[] = []
  const flagged: string[] = []
  const quiet: string[] = []
  const add = (list: string[], v: string) => { if (!list.includes(v)) list.push(v) }
  for (const s of sources) {
    const name = SOURCE_PLURAL[s.source]
    if (s.state === 'unavailable') {
      lines.push({ source: s.source, tone: 'warn', label: `${name} could not be read`,
        text: `${s.message ? `${s.message} ` : ''}${s.source === 'plugin'
          ? 'New Chat decisions may be missing. Decisions already shown, your drafts and saved answers still work.'
          : 'Bot Items may be missing here; check them in Orca.'}` })
      add(flagged, `${name} could not be read`)
      continue
    }
    const known = ((s.coverage ?? []) as { kind: string; message: string }[]).filter((c): c is { kind: Kind; message: string } => c.kind in COVERAGE)
    // One line per kind; repeated messages are merged. A failed lookup read is its own flagged line.
    const byKind = new Map<string, { tone: StatusTone; label: string; messages: string[]; advice: string; short: string }>()
    for (const c of known) {
      const k = COVERAGE[c.kind]
      const failed = failedRead(c)
      const key = failed ? 'hint-read-failed' : c.kind
      const def = failed ? COVERAGE['hint-read-failed'] : k
      const g = byKind.get(key) ?? { tone: def.tone, label: def.label, messages: [], advice: def.advice, short: def.short }
      if (c.message && !g.messages.includes(c.message.trim())) g.messages.push(c.message.trim())
      byKind.set(key, g)
    }
    for (const g of byKind.values()) {
      lines.push({ source: s.source, tone: g.tone, label: g.label, text: [...g.messages, g.advice].join(' ') })
      add(g.tone === 'warn' ? flagged : quiet, g.short)
    }
    // An older worker (or a gap it has no kind for) still says what was not read.
    if (s.state === 'partial' && !known.length) {
      lines.push({ source: s.source, tone: 'warn', label: `Some ${name} not read`, text: s.message ?? `Some ${name} could not be read.` })
      add(flagged, `some ${name} not read`)
    }
  }
  if (!lines.length) return null
  const cap = (t: string) => `${t.charAt(0).toUpperCase()}${t.slice(1)}`
  const tone: StatusTone = flagged.length ? 'warn' : 'info'
  const summary = flagged.length
    ? `Needs attention: ${cap(flagged.join(' · '))}${quiet.length ? ` · ${quiet.join(' · ')}` : ''}`
    : `Sources: ${cap(quiet.join(' · '))}`
  return { tone, summary, lines, open: sources.some((s) => s.state === 'unavailable') }
}

/**
 * What happens to an answer, said at the reply itself. Practice saves in this Inbox only; a Chat
 * decision's answer is saved in Decision Inbox, and when no plugin mail sender exists it stays there.
 */
export function replyReach(kind: 'practice' | 'chat', mail?: { state: 'available' | 'unavailable' } | null): string {
  if (kind === 'practice') return 'Practice: saved in this Inbox on this device only. Nothing is sent to any chat or agent.'
  // No notification is promised: only a delivery Orca actually reports is shown, under the answer.
  if (mail?.state === 'unavailable') return 'Saved in Decision Inbox only: Orca mail from this plugin is unavailable here, so the original chat is not notified.'
  if (mail?.state === 'available') return 'Saved in Decision Inbox for the original chat only. Delivery shows below once Orca reports it.'
  return 'Saved in Decision Inbox for the original chat only. Delivery shows below only if Orca reports it.'
}
