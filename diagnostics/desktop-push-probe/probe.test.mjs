import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeProbe } from './worker.mjs'
import { codePattern, inspectDelivery, prompt, ready, subject } from './protocol.mjs'

const session = 'a388da28-0b8b-4a1f-861f-532af10075a9'
const target = 'orca_session_id:' + session
const input = { target, confirmDisposable: true }
const entry = (role, text) => ({ kind: 'message', role, text })
const history = {
  kind: 'chat', orcaSessionId: session, source: 'chat', limited: false, state: 'done',
  entries: [entry('user', prompt), entry('assistant', ready)]
}

function fixture({ transcript = history, host = 'local', terminals = [], send = { exitCode: 0, payload: { ok: true, result: { messageId: 'msg_mock' } } } } = {}) {
  const calls = []
  const probe = makeProbe(async args => {
    calls.push(args)
    const status = { executable: 'orca', exitCode: 0, signal: null }
    if (args[0] === '--version') return { ...status, version: '1.4.271' }
    if (args[1] === 'show') return { ...status, payload: { ok: true, result: {
      kind: 'chat', orcaSessionId: session,
      places: [{ kind: 'chat', orcaSessionId: session, hostId: host, worktreeId: 'workspace', agent: 'codex' }]
    } } }
    if (args[1] === 'read') return { ...status, payload: { ok: true, result: transcript } }
    if (args[0] === 'terminal') return { ...status, payload: { ok: true, result: { terminals, truncated: false } } }
    return { ...status, ...send }
  })
  return { probe, calls }
}

test('one opted-in worker send uses the exact verified destination and no sender or environment override', async () => {
  const { probe, calls } = fixture()
  assert.equal((await probe({ target })).state, 'not-attempted')
  assert.equal(calls.length, 0)
  const reports = await Promise.all([probe(input), probe(input)])
  const accepted = reports.find(result => result.state === 'accepted')
  assert.equal(reports.filter(result => result.state === 'not-attempted').length, 1)
  assert.match(accepted.code, codePattern)
  assert.equal(accepted.cliVersion, '1.4.271')
  assert.equal(accepted.messageId, 'msg_mock')
  assert.deepEqual(calls.filter(args => args[0] === 'orchestration'), [
    ['orchestration', 'send', '--to', target, '--type', 'status', '--subject', subject, '--body', accepted.code, '--json']
  ])
})

test('paired scope, unrelated history, and tool activity cannot trigger a send', async () => {
  for (const { probe, calls } of [fixture({ host: 'paired' }), fixture({ terminals: [{}] }), fixture({ transcript: {
    ...history, entries: [...history.entries, { kind: 'tool' }]
  } }), fixture({ transcript: { ...history, entries: [entry('user', 'Unrelated'), entry('assistant', ready)] } })]) {
    assert.equal((await probe(input)).state, 'not-attempted')
    assert.ok(!calls.some(args => args[0] === 'orchestration'))
  }
})

test('the CLI refusal and ambiguous failure stay distinct from mail acceptance', async () => {
  const error = { code: 'no_active_sender_terminal', message: 'No active sender.' }
  const refusal = await fixture({ send: { exitCode: 1, payload: { ok: false, error } } }).probe(input)
  assert.equal(refusal.state, 'refused')
  assert.deepEqual(refusal.cli.error, error)
  assert.equal(refusal.cli.exitCode, 1)
  assert.equal(refusal.messageId, undefined)
  const unknown = await fixture({ send: { exitCode: null, signal: 'SIGTERM', diagnostic: 'Timeout' } }).probe(input)
  assert.equal(unknown.state, 'unknown')
  assert.equal(unknown.cli.signal, 'SIGTERM')
})

test('observer requires an exact receipt-free transcript with matching code and mail ID and zero tool entries', async () => {
  const report = await fixture().probe(input)
  const incoming = entry('user', 'Envelope\nSubject: ' + subject + '\n' + report.code +
    '\n[Reply: orca orchestration reply --id ' + report.messageId + ' --body "…"]')
  const delivered = { ...history, entries: [...history.entries, incoming, entry('assistant', report.code)] }
  assert.deepEqual(inspectDelivery(delivered, report), {
    observed: true, recipientToolCallsInTranscript: 0, target, messageId: report.messageId
  })
  assert.equal(inspectDelivery(history, report).observed, false)
  assert.equal(inspectDelivery(delivered, { ...report, messageId: 'msg_wrong' }).observed, false)
  assert.equal(inspectDelivery({ ...delivered, entries: [...delivered.entries, { kind: 'tool' }] }, report).observed, false)
})
