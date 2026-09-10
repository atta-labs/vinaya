/**
 * `vinaya task status` — every open task Issue carrying a frozen brief, its
 * pull request, and whether its dev-review-loop is running, paused,
 * published, or has no driver at all.
 *
 * Origin (`#515`): the Principal, running seven loops in seven terminals,
 * asked "Can I list the current sessions?" and the honest answer was a
 * `ps | grep`. This command answers from the outbox and the forge instead.
 *
 * Argv parsing and rendering only — `lib/task-status.js`'s
 * `gatherTaskStatusList` is the entire reader for this Part.
 */

import { printJson } from '../lib/envelope.js'
import { gatherTaskStatusList } from '../lib/task-status.js'

type ParsedArgs = { json: boolean; positional: string[] }

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = []
  let json = false
  for (const a of args) {
    if (a === '--json') json = true
    else positional.push(a)
  }
  return { json, positional }
}

function runList(json: boolean): void {
  const rows = gatherTaskStatusList()

  if (json) {
    printJson({ tasks: rows.map((r) => r.row) })
    return
  }
  if (rows.length === 0) {
    process.stdout.write('No open task carries a frozen brief.\n')
    return
  }
  for (const r of rows) process.stdout.write(`${r.line}\n`)
}

export async function taskStatusCommand(args: string[]): Promise<void> {
  const { json, positional } = parseArgs(args)

  if (positional.length === 0) {
    runList(json)
    return
  }
  console.error('Usage: vinaya task status [--json]')
  process.exit(2)
}
