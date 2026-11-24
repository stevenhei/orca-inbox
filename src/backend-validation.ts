import type { Annotation, Decision, InlineImagePlacement, Result, SubmitDecision, SubmitReply } from './contract.ts'

export type InboxErrorCode = Extract<Result<never>, { ok: false }>['code']

export class InboxError extends Error {
  constructor(readonly code: InboxErrorCode, message: string) { super(message) }
}

export function requireInput(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InboxError('invalid', message)
}

export function object(value: unknown): Record<string, unknown> {
  requireInput(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected an object.')
  return value as Record<string, unknown>
}

export function list(value: unknown, name: string): unknown[] {
  requireInput(Array.isArray(value) && value.length <= 200, `Invalid ${name} list.`)
  return value
}

export function string(value: unknown, name: string, allowEmpty = false): string {
  requireInput(typeof value === 'string' && value.length <= 100_000 && (allowEmpty || value.trim()), `Invalid ${name}.`)
  return value
}

export function id(value: unknown, name: string, maxLength = 256): string {
  const result = string(value, name)
  requireInput(result.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(result), `Invalid ${name}.`)
  return result
}

function integer(value: unknown, name: string, minimum = 1): number {
  requireInput(typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum, `Invalid ${name}.`)
  return value
}

function distinct(values: string[], name: string) {
  requireInput(new Set(values).size === values.length, `Duplicate ${name}.`)
}

function url(value: unknown): string {
  const link = string(value, 'URL')
  let scheme: string | undefined
  try { scheme = new URL(link).protocol } catch { /* Report an invalid link below. */ }
  requireInput(scheme === 'https:' || scheme === 'http:', 'Expected an HTTP(S) source or evidence link.')
  return link
}

function optionalText(value: unknown, name: string) {
  return value === undefined ? {} : { [name]: string(value, name, true) }
}

function inlineImages(value: unknown, background: string): InlineImagePlacement[] {
  const entries = list(value, 'inline image')
  requireInput(entries.length <= 20, 'At most 20 inline images are supported per question.')
  const boundaries = new Set([0])
  let offset = 0
  let blank = true
  let fence: string | undefined
  for (const line of background.split(/(?<=\n)/)) {
    // Split only before a nonblank, unindented top-level line. List
    // siblings and quote lines can still belong to the preceding block.
    if (!fence && blank && /^\S/.test(line) && !/^(?:>|(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$))/.test(line)) {
      boundaries.add(offset)
    }
    const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(line)
    if (match) {
      if (fence) {
        if (match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) fence = undefined
      } else if (match[1][0] === '~' || !match[2].includes('`')) {
        fence = match[1]
      }
    }
    blank = !line.trim()
    offset += line.length
  }
  if (!fence) boundaries.add(background.length)

  let previous = -1
  return entries.map(entry => {
    const image = object(entry)
    const offset = integer(image.offset, 'inline image offset', 0)
    requireInput(boundaries.has(offset), 'Place inline images between Markdown blocks and outside fenced code.')
    requireInput(offset >= previous, 'Inline images must be in background order.')
    previous = offset
    const caption = image.caption === undefined ? undefined : string(image.caption, 'inline image caption', true)
    requireInput(caption === undefined || caption.length <= 1024, 'Inline image captions are limited to 1,024 characters.')
    return { offset, ...evidenceRef(image), ...(caption === undefined ? {} : { caption }) }
  })
}

export function submission(input: unknown): SubmitDecision {
  const value = object(input)
  const questions = list(value.questions, 'questions').map((entry): SubmitDecision['questions'][number] => {
    const q = object(entry)
    const priority = q.priority
    requireInput(priority === 'P0' || priority === 'P1' || priority === 'P2' || priority === 'P3', 'Invalid priority.')
    const options = list(q.options, 'options').map(entry => {
      const o = object(entry)
      return { optionId: id(o.optionId, 'optionId'), label: string(o.label, 'option label'), ...optionalText(o.detail, 'detail') }
    })
    distinct(options.map(o => o.optionId), 'option ID')
    const recommendedOptionId = q.recommendedOptionId === undefined ? undefined : id(q.recommendedOptionId, 'recommended option ID')
    requireInput(recommendedOptionId === undefined || options.some(option => option.optionId === recommendedOptionId),
      'The recommended option must match an option on this question.')
    const deadline = q.deadline === undefined ? undefined : string(q.deadline, 'deadline')
    requireInput(deadline === undefined || (/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(deadline) &&
      Number.isFinite(Date.parse(deadline))), 'Deadline must include a time and zone.')
    const description = q.description === undefined ? undefined : string(q.description, 'description', true)
    requireInput(description === undefined || description.length <= 16_384, 'Description exceeds 16,384 characters.')
    const background = string(q.background, 'background', true)
    return {
      questionId: id(q.questionId, 'questionId'), title: string(q.title, 'title'),
      ...(description === undefined ? {} : { description }),
      background, ...(q.inlineImages === undefined ? {} : { inlineImages: inlineImages(q.inlineImages, background) }),
      recommendation: string(q.recommendation, 'recommendation', true),
      ...(recommendedOptionId === undefined ? {} : { recommendedOptionId }),
      options, priority, ...(deadline === undefined ? {} : { deadline }),
      blockedWork: list(q.blockedWork, 'blockedWork').map(x => string(x, 'blocked work'))
    }
  })
  requireInput(questions.length, 'At least one question is required.')
  distinct(questions.map(q => q.questionId), 'question ID')
  const evidence = list(value.evidence, 'evidence').map((entry): SubmitDecision['evidence'][number] => {
    const e = object(entry)
    const ref = { ...evidenceRef(e), label: string(e.label, 'evidence label') }
    if (e.kind === 'link') return { ...ref, kind: e.kind, url: url(e.url) }
    requireInput(e.kind === 'image-snapshot', 'Invalid evidence kind.')
    return { ...ref, kind: e.kind, attachmentId: id(e.attachmentId, 'attachmentId'),
      width: integer(e.width, 'width'), height: integer(e.height, 'height'), alt: string(e.alt, 'alt', true) }
  })
  distinct(evidence.map(e => JSON.stringify([e.evidenceId, e.version])), 'evidence version')
  for (const question of questions) {
    for (const image of question.inlineImages ?? []) {
      requireInput(evidence.some(item => item.kind === 'image-snapshot' && item.evidenceId === image.evidenceId &&
        item.version === image.version), 'Inline images require matching image snapshot evidence and version.')
    }
  }
  const sourceLinks = list(value.sourceLinks, 'sourceLinks').map(entry => {
    const link = object(entry)
    return { label: string(link.label, 'source label'), url: url(link.url) }
  })
  return { requestId: id(value.requestId, 'requestId'), packageId: id(value.packageId, 'packageId'),
    ...optionalText(value.summary, 'summary'), evidence, sourceLinks, questions }
}

function evidenceRef(value: unknown) {
  const e = object(value)
  return { evidenceId: id(e.evidenceId, 'evidenceId'), version: integer(e.version, 'evidence version') }
}

export function annotations(value: unknown, allowEmptyText = false): Annotation[] {
  return list(value, 'annotations').map((entry): Annotation => {
    const note = object(entry)
    const text = string(note.text, 'annotation text', allowEmptyText)
    if (note.kind === 'image') return { kind: note.kind, text, evidence: evidenceRef(note.evidence) }
    requireInput(note.kind === 'selection', 'Invalid annotation kind.')
    const start = integer(note.start, 'start', 0)
    const end = integer(note.end, 'end', start + 1)
    const quote = string(note.quote, 'quote', true)
    requireInput(quote.length === end - start, 'Selection quote and range differ.')
    const anchor = object(note.anchor)
    if (anchor.kind === 'evidence') return { kind: note.kind, text, start, end, quote, anchor: { kind: anchor.kind, evidence: evidenceRef(anchor.evidence) } }
    requireInput(anchor.kind === 'question' &&
      (anchor.field === 'background' || anchor.field === 'description' || anchor.field === 'recommendation'),
    'Invalid question text anchor.')
    return { kind: note.kind, text, start, end, quote,
      anchor: { kind: anchor.kind, revision: integer(anchor.revision, 'revision'), field: anchor.field } }
  })
}

export function reply(input: unknown): SubmitReply {
  const value = object(input)
  requireInput(value.kind === 'initial' || value.kind === 'follow-up', 'Invalid reply kind.')
  const answer = object(value.answer)
  requireInput(answer.kind === 'option' || answer.kind === 'text', 'Invalid answer kind.')
  return { questionId: id(value.questionId, 'questionId'), replyId: id(value.replyId, 'replyId'), kind: value.kind,
    answer: answer.kind === 'text' ? { kind: answer.kind, text: string(answer.text, 'answer') }
      : { kind: answer.kind, optionId: id(answer.optionId, 'optionId'), ...optionalText(answer.detail, 'detail') },
    annotations: annotations(value.annotations) }
}

export function validateNotes(notes: Annotation[], visible: Decision, evidenceText: (id: string, version: number) => string | undefined) {
  for (const note of notes) {
    const ref = note.kind === 'image' ? note.evidence : note.anchor.kind === 'evidence' ? note.anchor.evidence : undefined
    if (!ref && note.kind === 'selection' && note.anchor.kind === 'question') {
      requireInput(note.anchor.revision === visible.revision &&
        visible[note.anchor.field]?.slice(note.start, note.end) === note.quote, 'Question selection does not match its source revision.')
      continue
    }
    requireInput(ref, 'Invalid evidence anchor.')
    const item = visible.evidence.find(e => e.evidenceId === ref.evidenceId && e.version === ref.version)
    requireInput(item, 'Evidence version is unavailable.')
    if (note.kind === 'image') requireInput(item.kind === 'image-snapshot', 'An image note requires an image snapshot.')
    else requireInput(evidenceText(ref.evidenceId, ref.version)?.slice(note.start, note.end) === note.quote, 'Evidence selection does not match trusted versioned text.')
  }
}
