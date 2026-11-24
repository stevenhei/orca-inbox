import { readFile } from 'node:fs/promises'
import { invokeCli } from './cli.mjs'
import { inspectDelivery, sessionAddress } from './protocol.mjs'

try {
  const report = JSON.parse(await readFile(process.argv[2], 'utf8'))
  if (report.state !== 'accepted' || !sessionAddress.test(report.target)) throw new Error('Provide an accepted probe report.')
  const history = await invokeCli(['agent', 'read', report.target, '--limit', '10', '--json'])
  if (history.exitCode !== 0 || history.payload?.ok !== true) {
    throw new Error(history.payload?.error?.message ?? history.diagnostic ?? 'Orca could not read the observer transcript.')
  }
  const result = inspectDelivery(history.payload.result, report)
  console.log(JSON.stringify(result, null, 2))
  if (!result.observed) process.exitCode = 1
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
