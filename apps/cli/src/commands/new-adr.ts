import { createDecisionRecord } from '../lib/decision-records.js'

const USAGE = 'Usage: vinaya new adr <title>  (e.g. vinaya new adr Use one rule set for both prose checks)'

/**
 * `vinaya new adr <title>` — writes the next numbered decision record into
 * the folder `decisionRecords.path` names and indexes it
 * (`createDecisionRecord`). Refuses while the key is unset.
 */
export function newAdrCommand(args: string[]): void {
  const title = args.join(' ').trim()
  if (title.length === 0) {
    console.error(USAGE)
    process.exit(2)
  }
  const result = createDecisionRecord(title)
  if (!result.ok) {
    console.error(result.message)
    process.exit(result.exitCode)
  }
  process.stdout.write(
    `Created ${result.recordPath} (status: Proposed)\n${result.indexCreated ? 'Created' : 'Updated'} ${result.indexPath}\n`
  )
}
