export const ready = 'READY FOR DESKTOP PUSH PROBE'
export const prompt = 'Disposable Decision Inbox desktop push experiment. Do not call any tool, run any command, poll or read mail. Reply exactly READY FOR DESKTOP PUSH PROBE, then end your turn. If Orca later pushes a message titled Decision Inbox disposable push probe, reply with its exact INBOX-PUSH code and end your turn. Otherwise do nothing.'
export const subject = 'Decision Inbox disposable push probe'
export const sessionAddress = /^orca_session_id:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/
export const codePattern = /^INBOX-PUSH-[0-9a-f]{24}$/
const mailIdPattern = /^msg_[a-zA-Z0-9_-]+$/

const historyMatches = (history, session) => history?.kind === 'chat' && history.source === 'chat' &&
  history.orcaSessionId === session && history.limited === false && history.state === 'done' &&
  Array.isArray(history.entries) && history.entries.every(entry => entry?.kind === 'message')

const message = (entry, role, text) => entry?.role === role && entry.text === text

export function verifyReady(history, session) {
  return historyMatches(history, session) && history.entries.length === 2 &&
    message(history.entries[0], 'user', prompt) && message(history.entries[1], 'assistant', ready)
}

export function inspectDelivery(history, report) {
  const session = sessionAddress.exec(report?.target)?.[1]
  if (!session || report.state !== 'accepted' || !codePattern.test(report.code) ||
    !mailIdPattern.test(report.messageId)) return { observed: false, reason: 'An accepted probe report is required.' }
  if (!historyMatches(history, session) || history.entries.length !== 4 ||
    !verifyReady({ ...history, entries: history.entries.slice(0, 2) }, session)) {
    return { observed: false, reason: 'The complete, settled four-message transcript with zero tool entries is not visible.' }
  }
  const [, , mail, answer] = history.entries
  const lines = typeof mail.text === 'string' ? mail.text.split(/\r?\n/) : []
  if (mail.role !== 'user' || !lines.includes('Subject: ' + subject) || !lines.includes(report.code) ||
    !lines.some(line => line.startsWith('[Reply: orca orchestration reply --id ' + report.messageId + ' ')) ||
    !message(answer, 'assistant', report.code)) {
    return { observed: false, reason: 'The mail ID, fresh code and exact assistant response did not all match.' }
  }
  return { observed: true, recipientToolCallsInTranscript: 0, target: report.target, messageId: report.messageId }
}
