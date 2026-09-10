/**
 * `vinaya task status` — every open task Issue carrying a frozen brief, its
 * pull request, and whether its dev-review-loop is running, paused,
 * published, or has no driver at all. `vinaya task status <tranche> <n>`
 * narrows to one task and adds the last round's verdict lines plus the
 * exact resume command when paused.
 *
 * Origin (`#515`): the Principal, running seven loops in seven terminals,
 * asked "Can I list the current sessions?" and the honest answer was a
 * `ps | grep`. This command answers from the outbox and the forge instead.
 *
 * Argv parsing and rendering only — `lib/task-status.js`'s
 * `gatherTaskStatusList`/`gatherSingleTaskStatus` are the entire reader.
 */

import { printJson } from '../lib/envelope.js'
import { gatherSingleTaskStatus, gatherTaskStatusList } from '../lib/task-status.js'

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

function runSingle(tranche: string, id: string, json: boolean): void {
  const result = gatherSingleTaskStatus(tranche, id)

  if (result.kind === 'not_found') {
    console.error(`vinaya task status: task ${id} in tranche \`${tranche}\` is not an open task Issue.`)
    process.exit(1)
  }
  if (result.kind === 'no_brief') {
    console.error(`vinaya task status: task ${id} in tranche \`${tranche}\` carries no frozen brief yet.`)
    process.exit(1)
  }

  if (json) {
    printJson({ ...result.row, verdictLines: result.verdictLines, resumeCommand: result.resumeCommand })
    return
  }

  process.stdout.write(`${result.line}\n`)
  const lines = result.verdictLines
  if (lines) {
    if (lines.reviewer) process.stdout.write(`  reviewer (round ${lines.round}): ${lines.reviewer}\n`)
    if (lines.security) process.stdout.write(`  security (round ${lines.round}): ${lines.security}\n`)
  }
  if (result.resumeCommand) process.stdout.write(`Resume with: ${result.resumeCommand}\n`)
}

export async function taskStatusCommand(args: string[]): Promise<void> {
  const { json, positional } = parseArgs(args)

  if (positional.length === 0) {
    runList(json)
    return
  }
  if (positional.length !== 2) {
    console.error('Usage: vinaya task status [<tranche> <n>] [--json]')
    process.exit(2)
  }

  const [tranche, id] = positional as [string, string]
  runSingle(tranche, id, json)
}
