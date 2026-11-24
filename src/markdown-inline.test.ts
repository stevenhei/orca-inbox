import { assert, test } from 'orca/testing'
import { autolinkForMarkdown, tokenizeInline, type InlineToken } from './markdown-inline'

/** Links as [href, text] and the plain text around them, for readable assertions. */
const view = (s: string) => {
  const t = tokenizeInline(s)
  return {
    links: t.filter((x): x is Extract<InlineToken, { kind: 'link' }> => x.kind === 'link').map((x) => [x.href, x.text]),
    texts: t.filter((x) => x.kind === 'text').map((x) => x.text),
    tokens: t
  }
}

test('bare URL stops at a full-width terminator; the Chinese sentence stays text', () => {
  const v = view('見 https://example.invalid/run/42。下一句')
  assert.deepEqual(v.links, [['https://example.invalid/run/42', 'https://example.invalid/run/42']])
  assert.deepEqual(v.texts, ['見 ', '。下一句'])
  assert.deepEqual(view('https://example.invalid/run/42，然後').texts, ['，然後'])
  assert.deepEqual(view('（見 https://example.invalid/a）').links.map((l) => l[0]), ['https://example.invalid/a'])
  assert.deepEqual(view('網址：https://example.invalid/a；另外').links.map((l) => l[0]), ['https://example.invalid/a'])
})

test('trailing ASCII prose punctuation is not part of the URL; internal punctuation is', () => {
  assert.deepEqual(view('see https://example.invalid/42.').links.map((l) => l[0]), ['https://example.invalid/42'])
  assert.deepEqual(view('see https://example.invalid/42.').texts, ['see ', '.'])
  assert.deepEqual(view('https://example.invalid/a?x=1&y=2, next').links.map((l) => l[0]), ['https://example.invalid/a?x=1&y=2'])
  assert.deepEqual(view('Done? https://example.invalid/q?a=1!').links.map((l) => l[0]), ['https://example.invalid/q?a=1'])
  assert.deepEqual(view('at https://example.invalid/a,b;c/file.v2.html#x:1 ok').links.map((l) => l[0]), ['https://example.invalid/a,b;c/file.v2.html#x:1'])
  assert.deepEqual(view('"https://example.invalid/q"').links.map((l) => l[0]), ['https://example.invalid/q'])
})

test('multilingual paths and balanced parentheses are kept', () => {
  assert.deepEqual(view('看 https://zh.wikipedia.org/wiki/中文維基百科 這頁').links.map((l) => l[0]), ['https://zh.wikipedia.org/wiki/中文維基百科'])
  assert.deepEqual(view('https://en.wikipedia.org/wiki/Mercury_(planet) is').links.map((l) => l[0]), ['https://en.wikipedia.org/wiki/Mercury_(planet)'])
  assert.deepEqual(view('(see https://example.invalid/a)').links.map((l) => l[0]), ['https://example.invalid/a'])
  assert.deepEqual(view('(see https://en.wikipedia.org/wiki/A_(b)).').links.map((l) => l[0]), ['https://en.wikipedia.org/wiki/A_(b)'])
  const md = view('參考 [維基](https://en.wikipedia.org/wiki/A_(b))。')
  assert.deepEqual(md.links, [['https://en.wikipedia.org/wiki/A_(b)', '維基']])
  assert.deepEqual(md.texts, ['參考 ', '。'])
})

test('only http(s) becomes a link; other schemes and words stay plain text', () => {
  assert.deepEqual(view('[x](javascript:alert(1)) and ftp://example.invalid/a').links, [])
  assert.deepEqual(view('[x](mailto:a@example.invalid)').links, [])
  assert.deepEqual(view('xhttps://example.invalid/a').links, [])
  assert.deepEqual(view('https:// only').links, [])
  assert.deepEqual(view('`https://example.invalid/in-code`').links, [], 'code spans are not linked')
})

test('a multi-link sentence keeps every boundary and text anchors match the raw source', () => {
  const s = '參考 https://a.invalid/1、https://b.invalid/2 與 [C 文件](https://c.invalid/3)，見 **重點** 或 HTTPS://d.invalid/4.'
  const v = view(s)
  assert.deepEqual(v.links, [['https://a.invalid/1', 'https://a.invalid/1'], ['https://b.invalid/2', 'https://b.invalid/2'], ['https://c.invalid/3', 'C 文件'], ['HTTPS://d.invalid/4', 'HTTPS://d.invalid/4']])
  assert.deepEqual(v.texts, ['參考 ', '、', ' 與 ', '，見 ', ' 或 ', '.'])
  for (const t of v.tokens) assert.equal(s.slice(t.at, t.at + t.text.length), t.text, `offset of ${t.kind} “${t.text}”`)
})

test('host Markdown input: bare URLs become <url> autolinks; code, links and existing autolinks untouched', () => {
  assert.equal(autolinkForMarkdown('見 https://example.invalid/run/42。下一句'), '見 <https://example.invalid/run/42>。下一句')
  assert.equal(autolinkForMarkdown('see https://example.invalid/42.'), 'see <https://example.invalid/42>.')
  assert.equal(autolinkForMarkdown('[wiki](https://en.wikipedia.org/wiki/A_(b)) and <https://x.invalid/a>'), '[wiki](https://en.wikipedia.org/wiki/A_(b)) and <https://x.invalid/a>')
  assert.equal(autolinkForMarkdown('`https://x.invalid/code` **https://x.invalid/b**'), '`https://x.invalid/code` **<https://x.invalid/b>**')
  assert.equal(autolinkForMarkdown('```\nhttps://x.invalid/fenced\n```\nhttps://x.invalid/after'), '```\nhttps://x.invalid/fenced\n```\n<https://x.invalid/after>')
  assert.equal(autolinkForMarkdown('- 一\n- 二 https://x.invalid/b，結束'), '- 一\n- 二 <https://x.invalid/b>，結束')
})

// ---- recheck D1 and pre-wrapping lows -------------------------------------------------------------
test('an unmatched ] ends a bare URL; balanced brackets (IPv6 hosts) are kept', () => {
  const v = view('see [https://example.invalid/x] here')
  assert.deepEqual(v.links.map((l) => l[0]), ['https://example.invalid/x'])
  assert.deepEqual(v.texts, ['see [', '] here'])
  assert.deepEqual(view('open http://[::1]:8080/a now').links.map((l) => l[0]), ['http://[::1]:8080/a'])
  assert.deepEqual(view('(see http://[2001:db8::1]/x)').links.map((l) => l[0]), ['http://[2001:db8::1]/x'])
  assert.deepEqual(view('見 http://[::1]/a]。').links.map((l) => l[0]), ['http://[::1]/a'])
})

test('a URL used as the label of a non-http(s) link stays plain: readable label, then the destination', () => {
  for (const [s, dest] of [['[https://example.invalid/label](mailto:x@y.invalid)', '(mailto:x@y.invalid)'], ['[https://ok.invalid](javascript:alert(1))', '(javascript:alert(1))'], ['[file](file:///etc/passwd)', '(file:///etc/passwd)']] as const) {
    const v = view(s)
    assert.deepEqual(v.links, [], s)
    assert.deepEqual(v.tokens.map((t) => t.text), [s.slice(1, s.indexOf(']')), ' ', dest], s)
    for (const t of v.tokens) if (t.at >= 0) assert.equal(s.slice(t.at, t.at + t.text.length), t.text, 'anchored text matches the source')
  }
})

test('URLs inside bold are links; multi-backtick code spans stay code', () => {
  const v = tokenizeInline('**見 https://x.invalid/a。** 與 ``code `x` https://x.invalid/c``')
  const strong = v[0] as Extract<InlineToken, { kind: 'strong' }>
  assert.equal(strong.kind, 'strong')
  assert.deepEqual(strong.children.map((c) => [c.kind, c.text]), [['text', '見 '], ['link', 'https://x.invalid/a'], ['text', '。']])
  assert.deepEqual(v.slice(1).map((t) => [t.kind, t.text]), [['text', ' 與 '], ['code', 'code `x` https://x.invalid/c']])
})

test('panel pre-wrapping respects labels, destinations, multi-backtick and indented code, and HTML tags', () => {
  assert.equal(autolinkForMarkdown('see [https://example.invalid/x] here'), 'see [<https://example.invalid/x>] here')
  assert.equal(autolinkForMarkdown('[https://example.invalid/label](mailto:x@y.invalid) ok'), '`https://example.invalid/label (mailto:x@y.invalid)` ok')
  assert.equal(autolinkForMarkdown('[x](javascript:alert(1))'), '`x (javascript:alert(1))`')
  assert.equal(autolinkForMarkdown('[a `b`](mailto:z@y.invalid)'), '``a `b` (mailto:z@y.invalid)``')
  assert.equal(autolinkForMarkdown('[維基](https://en.wikipedia.org/wiki/A_(b))'), '[維基](https://en.wikipedia.org/wiki/A_(b))')
  assert.equal(autolinkForMarkdown('``x https://x.invalid/a``'), '``x https://x.invalid/a``')
  assert.equal(autolinkForMarkdown('para\n\n    https://x.invalid/indented\n    more\n\nhttps://x.invalid/after'), 'para\n\n    https://x.invalid/indented\n    more\n\n<https://x.invalid/after>')
  assert.equal(autolinkForMarkdown('<a href="https://x.invalid/a">a</a> https://x.invalid/b'), '<a href="https://x.invalid/a">a</a> <https://x.invalid/b>')
  assert.equal(autolinkForMarkdown('open http://[::1]:8080/a now'), 'open <http://[::1]:8080/a> now')
})
