import type { Annotation, Decision } from './contract.ts'

/**
 * Note targets for surfaces without text selection (the narrow panel, drawn by Orca's components).
 * Each target is a paragraph of a question field, with its exact raw UTF-16 range, or an attached
 * image version. Notes made from them are the same anchored annotations the wide review makes
 * (question revision, raw offsets, quote), saved through the same question-scoped draft.
 */
export type NoteField = 'background' | 'description' | 'recommendation'
export const NOTE_FIELD_LABEL: Record<NoteField, string> = { background: 'Background', description: 'Description', recommendation: 'Recommendation' }

export type NoteTarget =
  | { value: string; label: string; kind: 'text'; field: NoteField; start: number; end: number; text: string }
  | { value: string; label: string; kind: 'image'; evidenceId: string; version: number }

const excerpt = (s: string, n = 56) => {
  const t = s.replace(/[*`#>]+/g, '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/** Paragraphs (blank-line separated, fences skipped) of one field, with raw offsets of their text. */
export function paragraphs(raw: string): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = []
  let at = 0, fence = false, cur: { start: number; end: number } | null = null
  const close = () => { if (cur) { out.push({ ...cur, text: raw.slice(cur.start, cur.end) }); cur = null } }
  for (const line of raw.split('\n')) {
    const lineAt = at
    at += line.length + 1
    if (/^ {0,3}(```|~~~)/.test(line)) { close(); fence = !fence; continue }
    if (fence) continue
    if (!line.trim()) { close(); continue }
    // Leading Markdown markers (heading, list, quote) are not part of the quoted text.
    const lead = /^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)?/.exec(line)![0].length
    const s = lineAt + lead, e = lineAt + line.replace(/\s+$/, '').length
    if (e <= s) continue
    if (cur && lead === 0) cur.end = e
    else { close(); cur = { start: s, end: e } }
  }
  close()
  return out
}

/** Every paragraph of Background, Description and Recommendation, then each image version. */
export function noteTargets(d: Decision): NoteTarget[] {
  const out: NoteTarget[] = []
  for (const field of ['background', 'description', 'recommendation'] as const) {
    const raw = d[field] ?? ''
    paragraphs(raw).forEach((p, i, all) => out.push({
      value: `${field}:${p.start}:${p.end}`, kind: 'text', field, start: p.start, end: p.end, text: p.text,
      label: `${NOTE_FIELD_LABEL[field]}${all.length > 1 ? ` ¶${i + 1}` : ''}: ${excerpt(p.text)}`
    }))
  }
  for (const e of d.evidence) if (e.kind === 'image-snapshot') {
    out.push({ value: `image:${e.evidenceId}:${e.version}`, kind: 'image', evidenceId: e.evidenceId, version: e.version, label: `Image: ${e.label} · v${e.version}` })
  }
  return out
}

/** Start offsets (inside the paragraph) of each occurrence of the quote. */
export function occurrences(text: string, quote: string): number[] {
  const out: number[] = []
  if (!quote) return out
  for (let i = text.indexOf(quote); i >= 0; i = text.indexOf(quote, i + 1)) out.push(i)
  return out
}

/**
 * Builds the annotation for a target. A text note quotes the whole paragraph, or an exact phrase in
 * it (the chosen occurrence when it appears more than once). Returns an error text instead when the
 * note cannot be anchored exactly.
 */
export function makeNote(d: Decision, t: NoteTarget, note: string, phrase = '', occurrence = 0): Annotation | string {
  if (!note.trim()) return 'Write the note first.'
  if (t.kind === 'image') return { kind: 'image', evidence: { evidenceId: t.evidenceId, version: t.version }, text: note }
  const raw = d[t.field] ?? ''
  if (raw.slice(t.start, t.end) !== t.text) return 'This text changed. Choose the paragraph again.'
  let start = t.start, end = t.end
  if (phrase) {
    const at = occurrences(t.text, phrase)
    if (!at.length) return 'That exact text is not in the chosen paragraph.'
    const i = at[Math.min(Math.max(0, occurrence), at.length - 1)]
    start = t.start + i; end = start + phrase.length
  }
  return { kind: 'selection', anchor: { kind: 'question', field: t.field, revision: d.revision }, start, end, quote: raw.slice(start, end), text: note }
}

/** What a recorded note is about, for read-only lists: field and a short quote, or the image label. */
export function noteLabel(n: Annotation, d: Pick<Decision, 'evidence'>): string {
  if (n.kind === 'image') {
    const e = d.evidence.find((x) => x.evidenceId === n.evidence.evidenceId)
    return `Image: ${e?.label ?? n.evidence.evidenceId} · v${n.evidence.version}`
  }
  const where = n.anchor.kind === 'question' ? NOTE_FIELD_LABEL[n.anchor.field] : 'Evidence'
  return `${where}: “${excerpt(n.quote, 48)}”`
}
/**
 * How the notes of a recorded reply travelled. "Sent" only once Orca reported a hand-off (mail
 * accepted or the chat's receipt); a local-only, merely saved or undelivered reply kept them here.
 */
export function notesFate(delivery: { state: string; transport?: unknown }): string {
  if (delivery.state === 'local-only') return 'saved with this practice answer, on this device only'
  if (delivery.state === 'agent-received' || (delivery.state === 'submitted' && delivery.transport)) return 'sent with this reply'
  if (delivery.state === 'undelivered') return 'saved with this reply; not delivered'
  return 'saved with this reply; not reported as sent'
}
