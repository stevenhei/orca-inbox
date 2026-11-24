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
