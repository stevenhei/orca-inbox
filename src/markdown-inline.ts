// Inline Markdown boundaries shared by the wide reader (which renders text nodes itself) and the
// panel (which hands Markdown to Orca's renderer). Pure: no DOM, no Orca imports.
//
// Bare http(s) URLs follow the GFM extended-autolink trimming rules plus CJK prose punctuation:
//  * a URL stops at whitespace, `<`, `>`, quotes, backticks, full-width punctuation (。，、…) and at a
//    `]` that closes no `[` inside the URL, so the following sentence or Markdown is never part of it;
//  * trailing prose punctuation (. , ; : ! ? ' " * _ ~) is not part of the URL;
//  * a trailing `)` or `]` is part of the URL only while its pairs stay balanced, so IPv6 hosts such
//    as `http://[::1]:8080/` and `/wiki/A_(b)` are kept;
//  * internal punctuation and non-ASCII path text are kept (`/wiki/中文`, `a,b;c`, `#x:1`).
// Explicit `[label](destination)` links accept balanced parentheses. Only http(s) destinations
// become links; any other scheme (javascript:, mailto:, file:…) is shown as plain text, the label
// followed by the destination (plain text in the wide reader; a literal code span for the host
// renderer, so no sanitizer behaviour is assumed). Code spans use CommonMark backtick runs.

/** Full-width and CJK punctuation that ends a bare URL (prose, not path). */
const CJK_STOP = new Set([...'。，、；：！？「」『』（）《》〈〉【】〔〕…‥—～·“”‘’　'])
const ASCII_STOP = new Set([...'<>"\'`'])
const TRAILING = new Set([...'.,;:!?\'"*_~'])
const SCHEME = /^https?:\/\//i

export type InlineToken =
  /** `at` is the offset in the source; -1 marks display-only text with no source (no anchor). */
  | { kind: 'text'; text: string; at: number }
  | { kind: 'strong'; text: string; at: number; children: InlineToken[] }
  | { kind: 'code'; text: string; at: number }
  | { kind: 'link'; text: string; at: number; href: string; bare: boolean }

const count = (s: string, c: string) => s.split(c).length - 1

/** End (exclusive) of a bare http(s) URL starting at `i`, or -1 when there is none. */
export function bareUrlEnd(s: string, i: number, end = s.length): number {
  const scheme = SCHEME.exec(s.slice(i, i + 8))
  if (!scheme) return -1
  // Not inside a word such as `xhttps://`.
  if (i > 0 && /[\p{L}\p{N}_]/u.test(s[i - 1])) return -1
  let j = i + scheme[0].length
  let square = 0
  for (; j < end; j++) {
    const c = s[j]
    if (/\s/u.test(c) || CJK_STOP.has(c) || ASCII_STOP.has(c)) break
    if (c === '[') square++
    else if (c === ']') { if (square === 0) break; square-- } // an unmatched `]` ends the URL
  }
  // Trim trailing prose punctuation and unbalanced closing parentheses or brackets.
  for (;;) {
    const url = s.slice(i, j)
    const last = s[j - 1]
    if (TRAILING.has(last)) { j--; continue }
    if (last === ')' && count(url, ')') > count(url, '(')) { j--; continue }
    if (last === ']' && count(url, ']') > count(url, '[')) { j--; continue }
    break
  }
  return j > i + scheme[0].length ? j : -1
}

/**
 * `[label](destination)` at `i`, any scheme: positions, the destination and whether it may become
 * a link (http(s) only). Null when the text is not an explicit link.
 */
export function explicitLink(s: string, i: number, end = s.length): { label: string; labelAt: number; href: string; end: number; allowed: boolean } | null {
  if (s[i] !== '[') return null
  const close = s.indexOf(']', i + 1)
  if (close < 0 || close >= end || s.slice(i + 1, close).includes('\n') || close === i + 1 || s[close + 1] !== '(') return null
  let depth = 0
  let j = close + 1
  for (; j < end; j++) {
    const c = s[j]
    if (c === '(') depth++
    else if (c === ')') { depth--; if (depth === 0) break }
    else if (/\s/u.test(c)) return null
  }
  if (j >= end || depth !== 0) return null
  const href = s.slice(close + 2, j)
  if (!href) return null
  const allowed = SCHEME.test(href) && href.length > href.indexOf('//') + 2
  return { label: s.slice(i + 1, close), labelAt: i + 1, href, end: j + 1, allowed }
}

/** A CommonMark code span at `i` (a run of N backticks closed by exactly N): [contentStart, contentEnd, end]. */
export function codeSpan(s: string, i: number, end = s.length): [number, number, number] | null {
  if (s[i] !== '`' || (i > 0 && s[i - 1] === '`')) return null
  let n = 0
  while (s[i + n] === '`') n++
  let k = i + n
  while (k < end) {
    const open = s.indexOf('`', k)
    if (open < 0 || open >= end) return null
    let m = 0
    while (s[open + m] === '`') m++
    if (m === n) return [i + n, open, open + n]
    k = open + m
  }
  return null
}

/** Inline tokens of `s[start, end)`, each with its offset in `s` (for text anchors). */
export function tokenizeInline(s: string, start = 0, end = s.length, inStrong = false): InlineToken[] {
  const out: InlineToken[] = []
  let text = start
  const flush = (to: number) => { if (to > text) out.push({ kind: 'text', text: s.slice(text, to), at: text }) }
  let i = start
  while (i < end) {
    const c = s[i]
    if (c === '*' && s[i + 1] === '*' && !inStrong) {
      const close = s.indexOf('**', i + 2)
      if (close > i + 2 && close + 2 <= end && !s.slice(i + 2, close).includes('\n')) {
        flush(i)
        out.push({ kind: 'strong', text: s.slice(i + 2, close), at: i + 2, children: tokenizeInline(s, i + 2, close, true) })
        i = text = close + 2; continue
      }
    } else if (c === '`') {
      const span = codeSpan(s, i, end)
      if (span && !s.slice(span[0], span[1]).includes('\n')) {
        flush(i); out.push({ kind: 'code', text: s.slice(span[0], span[1]), at: span[0] }); i = text = span[2]; continue
      }
      // An unclosed run of backticks is literal text; skip the whole run.
      while (s[i] === '`') i++
      continue
    } else if (c === '[') {
      const link = explicitLink(s, i, end)
      if (link?.allowed) { flush(i); out.push({ kind: 'link', text: link.label, at: link.labelAt, href: link.href, bare: false }); i = text = link.end; continue }
      if (link) {
        // Unsupported scheme: the readable label, then the destination, as plain text (no link).
        flush(i)
        const paren = link.labelAt + link.label.length + 1 // the `(` after `]`
        out.push({ kind: 'text', text: link.label, at: link.labelAt })
        out.push({ kind: 'text', text: ' ', at: -1 })
        out.push({ kind: 'text', text: s.slice(paren, link.end), at: paren })
        i = text = link.end; continue
      }
    } else if (c === 'h' || c === 'H') {
      const j = bareUrlEnd(s, i, end)
      if (j > 0) { flush(i); out.push({ kind: 'link', text: s.slice(i, j), at: i, href: s.slice(i, j), bare: true }); i = text = j; continue }
    }
    i++
  }
  flush(end)
  return out
}

/**
 * Literal text for a host renderer: a code span, which no Markdown renderer turns into a link
 * (backslash escapes are not enough where autolinking runs after escapes are resolved).
 */
const literal = (t: string) => {
  const run = Math.max(0, ...(t.match(/`+/g) ?? []).map((r) => r.length)) + 1
  const fence = '`'.repeat(run)
  const pad = t.startsWith('`') || t.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${t}${pad}${fence}`
}

/**
 * For a host Markdown renderer (GFM): wraps bare http(s) URLs as `<url>` autolinks with the
 * boundaries above, so its own extended autolinking cannot run into the following prose, and turns
 * explicit links with other schemes into escaped plain text (label and destination), so only
 * http(s) can link whatever the host's sanitizer allows. Code spans (any backtick run), fenced and
 * indented code, explicit http(s) links, existing `<…>` autolinks and raw HTML tags are left as they
 * are.
 */
export function autolinkForMarkdown(md: string): string {
  let out = ''
  let fenced = false
  let prevBlank = true
  let inIndented = false
  for (const line of md.split(/(?<=\n)/)) {
    const blank = !line.trim()
    if (/^ {0,3}(```|~~~)/.test(line)) { fenced = !fenced; out += line; prevBlank = false; inIndented = false; continue }
    if (fenced) { out += line; continue }
    // An indented code block starts after a blank line (or continues one).
    if (/^( {4}|\t)/.test(line) && !blank && (prevBlank || inIndented)) { inIndented = true; out += line; prevBlank = false; continue }
    if (!blank) inIndented = false
    prevBlank = blank
    let i = 0
    while (i < line.length) {
      const c = line[i]
      if (c === '`') {
        const span = codeSpan(line, i)
        if (span) { out += line.slice(i, span[2]); i = span[2]; continue }
        while (line[i] === '`') { out += '`'; i++ }
        continue
      }
      if (c === '[') {
        const link = explicitLink(line, i)
        if (link?.allowed) { out += line.slice(i, link.end); i = link.end; continue }
        if (link) { out += literal(`${link.label} (${link.href})`); i = link.end; continue }
      } else if (c === '<') {
        const close = line.indexOf('>', i + 1)
        // Existing autolinks and raw HTML tags stay as written.
        if (close > i && (SCHEME.test(line.slice(i + 1)) || /^<\/?[A-Za-z][A-Za-z0-9-]*(\s[^<>]*)?\/?>$/.test(line.slice(i, close + 1)))) {
          out += line.slice(i, close + 1); i = close + 1; continue
        }
      } else if (c === 'h' || c === 'H') {
        const j = bareUrlEnd(line, i)
        if (j > 0) { out += `<${line.slice(i, j)}>`; i = j; continue }
      }
      out += c; i++
    }
  }
  return out
}
