import { randomBytes } from 'node:crypto'
import { invokeCli } from './cli.mjs'
import { sessionAddress, subject, verifyReady } from './protocol.mjs'

function cliStatus({ executable, exitCode, signal, processError, diagnostic, payload }) {
  return { executable, exitCode, signal, ...(processError ? { processError } : {}), ...(diagnostic ? { diagnostic } : {}),
    ...(payload?.ok === false ? { error: { code: payload.error?.code ?? null, message: payload.error?.message ?? null } } : {}) }
}

export function makeProbe(cli = invokeCli) {
  let attempted = false
  return async (input, signal) => {
    const target = input?.target
    const session = typeof target === 'string' && sessionAddress.exec(target)?.[1]
    if (!session || input.confirmDisposable !== true) {
      return { state: 'not-attempted', reason: 'Enter the exact disposable Orca Chat address and confirm the experiment.' }
    }
    const alreadyAttempted = { state: 'not-attempted', reason: 'This activation already attempted one send. Use a new Chat and restart the probe for another experiment.' }
    if (attempted) return alreadyAttempted
    const before = async (step, args) => {
      const invocation = await cli(args)
      return { invocation, failure: invocation.exitCode !== 0 || invocation.payload?.ok !== true
        ? { state: 'not-attempted', target, step, cli: cliStatus(invocation) }
        : null }
    }

    const version = await cli(['--version'])
    const shown = await before('agent show', ['agent', 'show', target, '--json'])
    if (shown.failure) return shown.failure
    const { kind, orcaSessionId, places } = shown.invocation.payload.result ?? {}
    if (kind !== 'chat' || orcaSessionId !== session || !Array.isArray(places) || places.length !== 1 || places[0]?.kind !== 'chat' ||
      places[0].orcaSessionId !== session || places[0].hostId !== 'local' || !places[0].worktreeId ||
      !['codex', 'claude'].includes(places[0].agent)) {
      return { state: 'not-attempted', target, reason: 'Orca did not resolve one live local Claude or Codex workspace Chat.' }
    }
    const history = await before('agent read', ['agent', 'read', target, '--limit', '10', '--json'])
    if (history.failure) return history.failure
    if (!verifyReady(history.invocation.payload.result, session)) {
      return { state: 'not-attempted', target, reason: 'The exact ready exchange in a fresh tool-free disposable Chat was not visible.' }
    }

    const terminals = await before('terminal list', ['terminal', 'list', '--limit', '1', '--json'])
    if (terminals.failure) return terminals.failure
    const inventory = terminals.invocation.payload.result
    if (inventory?.truncated !== false || !Array.isArray(inventory.terminals) || inventory.terminals.length !== 0) {
      return { state: 'not-attempted', target, reason: 'Run in a disposable local runtime with no live Orca terminal panes. The CLI can infer a sender from a terminal.' }
    }
    if (attempted) return alreadyAttempted
    if (signal?.aborted) return { state: 'not-attempted', target, reason: 'The desktop request ended before send.' }
    attempted = true
    const code = 'INBOX-PUSH-' + randomBytes(12).toString('hex')
    const sent = await cli(['orchestration', 'send', '--to', target, '--type', 'status', '--subject', subject, '--body', code, '--json'])
    const { payload } = sent
    const messageId = payload?.result?.messageId
    const accepted = sent.exitCode === 0 && payload?.ok === true && typeof messageId === 'string' && /^msg_[a-zA-Z0-9_-]+$/.test(messageId)
    return { state: accepted ? 'accepted' : sent.exitCode !== null && payload?.ok === false ? 'refused' : 'unknown',
      target, code, cliVersion: version.version || null, cli: cliStatus(sent), ...(accepted ? { messageId } : {}) }
  }
}

export default function activate(orca) {
  const probe = makeProbe()
  orca.panels.handle('probe.send', (input, context) => {
    if (context.signal.aborted || context.panel.surface !== 'panel' || context.panel.contributionId !== 'probe') {
      return { state: 'not-attempted', reason: 'Use the Push Probe desktop panel.' }
    }
    if (['ORCA_AGENT_SESSION_ID', 'ORCA_AGENT_SESSION_TOOL_TOKEN', 'ORCA_AGENT_SESSION_SPAWN_TOKEN',
      'ORCA_TERMINAL_HANDLE', 'ORCA_PANE_KEY', 'ORCA_BOT_TOOLS_TOKEN'].some(key => process.env[key])) {
      return { state: 'not-attempted', reason: 'This worker inherited an agent or terminal identity. Use a desktop worker without that identity.' }
    }
    return probe(input, context.signal)
  })
}
