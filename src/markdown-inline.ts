// Inline Markdown boundaries shared by the wide reader (which renders text nodes itself) and the
// panel (which hands Markdown to Orca's renderer). Pure: no DOM, no Orca imports.
//
// Bare http(s) URLs follow the GFM extended-autolink trimming rules plus CJK prose punctuation:
//  * a URL stops at whitespace, `<`, `>`, quotes, backticks and full-width punctuation (。，、…),
//    so the following Chinese sentence is never part of the link;
//  * trailing prose punctuation (. , ; : ! ? ' " * _ ~) is not part of the URL;
//  * a trailing `)` is part of the URL only while parentheses inside it stay balanced;
//  * internal punctuation and non-ASCII path text are kept (`/wiki/中文`, `a,b;c`, `#x:1`).
// Explicit `[text](url)` links accept balanced parentheses in the URL. Any scheme other than http(s)
// stays plain text.

/** Full-width and CJK punctuation that ends a bare URL (prose, not path). */
const CJK_STOP = new Set([...'。，、；：！？「」『』（）《》〈〉【】〔〕…‥—～·“”‘’　'])
const ASCII_STOP = new Set([...'<>"\'`'])
const TRAILING = new Set([...'.,;:!?\'"*_~'])
const SCHEME = /^https?:\/\//i

export type InlineToken =
  | { kind: 'text'; text: string; at: number }
  | { kind: 'strong'; text: string; at: number }
  | { kind: 'code'; text: string; at: number }
  | { kind: 'link'; text: string; at: number; href: string; bare: boolean }

const count = (s: string, c: string) => s.split(c).length - 1

/** End (exclusive) of a bare http(s) URL starting at `i`, or -1 when there is none. */
export function bareUrlEnd(s: string, i: number, end = s.length): number {
  const head = s.slice(i, i + 8)
  const scheme = SCHEME.exec(head)
  if (!scheme) return -1
  // Not inside a word such as `xhttps://`.
  if (i > 0 && /[\p{L}\p{N}_]/u.test(s[i - 1])) return -1
  let j = i + scheme[0].length
  while (j < end && !/\s/u.test(s[j]) && !CJK_STOP.has(s[j]) && !ASCII_STOP.has(s[j])) j++
  // Trim trailing prose punctuation and unbalanced closing parentheses.
  for (;;) {
    const url = s.slice(i, j)
    const last = s[j - 1]
    if (TRAILING.has(last)) { j--; continue }
    if (last === ')' && count(url, ')') > count(url, '(')) { j--; continue }
    break
  }
  return j > i + scheme[0].length ? j : -1
}

/** `[label](url)` at `i`: label/url positions and the end, or null (not a supported link). */
export function explicitLink(s: string, i: number, end = s.length): { label: string; labelAt: number; href: string; end: number } | null {
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
  if (!SCHEME.test(href) || href.length <= href.indexOf('//') + 2) return null
  return { label: s.slice(i + 1, close), labelAt: i + 1, href, end: j + 1 }
}

/** Inline tokens of `s[start, end)`, each with its offset in `s` (for text anchors). */
export function tokenizeInline(s: string, start = 0, end = s.length): InlineToken[] {
  const out: InlineToken[] = []
  let text = start
  const flush = (to: number) => { if (to > text) out.push({ kind: 'text', text: s.slice(text, to), at: text }) }
  let i = start
  while (i < end) {
    const c = s[i]
    if (c === '*' && s[i + 1] === '*') {
      const close = s.indexOf('**', i + 2)
      if (close > i + 2 && close + 2 <= end && !s.slice(i + 2, close).includes('\n')) {
        flush(i); out.push({ kind: 'strong', text: s.slice(i + 2, close), at: i + 2 }); i = text = close + 2; continue
      }
    } else if (c === '`') {
      const close = s.indexOf('`', i + 1)
      if (close > i + 1 && close < end && !s.slice(i + 1, close).includes('\n')) {
        flush(i); out.push({ kind: 'code', text: s.slice(i + 1, close), at: i + 1 }); i = text = close + 1; continue
      }
    } else if (c === '[') {
      const link = explicitLink(s, i, end)
      if (link) { flush(i); out.push({ kind: 'link', text: link.label, at: link.labelAt, href: link.href, bare: false }); i = text = link.end; continue }
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
 * For a host Markdown renderer (GFM): wraps bare http(s) URLs as `<url>` autolinks with the
 * boundaries above, so its own extended autolinking cannot run into the following prose. Code
 * spans, fenced code, explicit links and existing `<…>` autolinks are left as they are.
 */
export function autolinkForMarkdown(md: string): string {
  let out = ''
  let fenced = false
  for (const line of md.split(/(?<=\n)/)) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; out += line; continue }
    if (fenced) { out += line; continue }
    let i = 0
    while (i < line.length) {
      const c = line[i]
      if (c === '`') {
        const close = line.indexOf('`', i + 1)
        if (close > i) { out += line.slice(i, close + 1); i = close + 1; continue }
      } else if (c === '[') {
        const link = explicitLink(line, i)
        if (link) { out += line.slice(i, link.end); i = link.end; continue }
      } else if (c === '<') {
        const close = line.indexOf('>', i + 1)
        if (close > i && SCHEME.test(line.slice(i + 1))) { out += line.slice(i, close + 1); i = close + 1; continue }
      } else if (c === 'h' || c === 'H') {
        const j = bareUrlEnd(line, i)
        if (j > 0) { out += `<${line.slice(i, j)}>`; i = j; continue }
      }
      out += c; i++
    }
  }
  return out
}
