/**
 * `vinaya task status` — every open task Issue carrying a frozen brief, its
 * pull request, and whether its dev-review-loop is running, paused,
 * published, or has no driver at all. `vinaya task status <tranche> <n>`
 * narrows to one task and adds the last round's verdict lines plus the
 * exact resume command when paused. `--follow` (O6),
 * on either the `<tranche> <n>` form or `--issue <n>`, tails that task's
 * driver log — `~/.vinaya/loops/<owner>-<repo>/<issue>.log` — live,
 * `tail -f` style, so the state of any run is one command away regardless
 * of where it was launched.
 *
 * Origin (`#515`): the Principal, running seven loops in seven terminals,
 * asked "Can I list the current sessions?" and the honest answer was a
 * `ps | grep`. This command answers from the outbox and the forge instead.
 *
 * Argv parsing and rendering only — `lib/task-status.js`'s
 * `gatherTaskStatusList`/`gatherSingleTaskStatus`, plus `loop-log.js`'s
 * `loopLogPathFor`/`followLoopLog` for `--follow`, are the entire reader.
 */

import { resolveRepo } from '@attalabs/aeg-forge-state'
import { printJson } from '../lib/envelope.js'
import { followLoopLog, loopLogPathFor } from '../lib/loop-log.js'
import { gatherSingleTaskStatus, gatherTaskStatusList } from '../lib/task-status.js'

type ParsedArgs = { json: boolean; follow: boolean; issue: string | undefined; positional: string[] }

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = []
  let json = false
  let follow = false
  let issue: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === '--json') json = true
    else if (a === '--follow') follow = true
    else if (a === '--issue') issue = args[++i]
    else positional.push(a)
  }
  return { json, follow, issue, positional }
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

/** `--follow`'s own issue-number resolution (O6): `--issue <n>` names it directly; the `<tranche> <n>` form resolves it through the same read the ordinary single-task view already uses. Prints a usage/not-found refusal and exits, never returning, on any failure to resolve. */
function resolveFollowIssue(parsed: ParsedArgs): number {
  if (parsed.issue !== undefined) {
    const n = Number.parseInt(parsed.issue, 10)
    if (!Number.isInteger(n) || String(n) !== parsed.issue) {
      console.error(`vinaya task status: --issue must be numeric — got "${parsed.issue}".`)
      process.exit(2)
    }
    return n
  }
  if (parsed.positional.length !== 2) {
    console.error('Usage: vinaya task status [<tranche> <n> | --issue <n>] --follow')
    process.exit(2)
  }
  const [tranche, id] = parsed.positional as [string, string]
  const result = gatherSingleTaskStatus(tranche, id)
  if (result.kind === 'not_found') {
    console.error(`vinaya task status: task ${id} in tranche \`${tranche}\` is not an open task Issue.`)
    process.exit(1)
  }
  if (result.kind === 'no_brief') {
    console.error(`vinaya task status: task ${id} in tranche \`${tranche}\` carries no frozen brief yet.`)
    process.exit(1)
  }
  return result.row.issue
}

async function runFollow(parsed: ParsedArgs): Promise<void> {
  const issue = resolveFollowIssue(parsed)
  const repo = await resolveRepo().catch(() => null)
  const path = loopLogPathFor(repo, issue)
  await followLoopLog(path)
}

export async function taskStatusCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args)
  const { json, follow, positional } = parsed

  if (follow) {
    await runFollow(parsed)
    return
  }

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
