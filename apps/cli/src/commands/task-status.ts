/**
 * `vinaya task status` — one table: every open task Issue carrying a frozen
 * brief, its pull request, whether its dev-review-loop is running, paused,
 * published, or has no driver at all, and where that run is — its round, its
 * phase, how long it has been in that phase, the newest confidence on record,
 * and what the phase typically takes on this repository's recently merged
 * tasks (history, never a forecast). `vinaya task status <tranche> <n>`
 * narrows to one task and adds the last round's verdict lines plus the
 * exact resume command when paused. `--follow`,
 * on either the `<tranche> <n>` form or `--issue <n>`, tails that task's
 * driver log — `<runtimeDir>/tasks-execution/<issue>/output/driver.log` — live,
 * `tail -f` style, through the follow view (`lib/follow-view.js`): one
 * coloured line per actor, stage banners, and its detail lines unless
 * `--quiet` hides them, so the state of any run is one command away regardless
 * of where it was launched.
 *
 * Origin: the Principal, running seven loops in seven terminals,
 * asked "Can I list the current sessions?" and the honest answer was a
 * `ps | grep`. This command answers from the outbox and the forge instead.
 *
 * Argv parsing and rendering only — `lib/task-status.js`'s
 * `gatherTaskStatusList`/`gatherSingleTaskStatus`, plus
 * `followTaskLog` (`lib/follow-view.js`) for `--follow`, are the entire reader.
 */

import { StringDecoder } from 'node:string_decoder'
import { resolveRepo } from '@attalabs/aeg-forge-state'
import { printJson } from '../lib/envelope.js'
import { followTaskLog } from '../lib/follow-view.js'
import { gatherSingleTaskStatus, gatherTaskStatusList } from '../lib/task-status.js'

type ParsedArgs = { json: boolean; follow: boolean; quiet: boolean; issue: string | undefined; positional: string[] }

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = []
  let json = false
  let follow = false
  let quiet = false
  let issue: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === '--json') json = true
    else if (a === '--follow') follow = true
    else if (a === '--quiet') quiet = true
    else if (a === '--issue') issue = args[++i]
    else positional.push(a)
  }
  return { json, follow, quiet, issue, positional }
}

function runList(json: boolean): void {
  const { rows, table } = gatherTaskStatusList()

  if (json) {
    printJson({ tasks: rows })
    return
  }
  if (rows.length === 0) {
    process.stdout.write('No open task carries a frozen brief.\n')
    return
  }
  for (const line of table) process.stdout.write(`${line}\n`)
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

  // The same table the list form prints, one row wide — one shape to read,
  // whether the answer is about one task or every open one.
  for (const line of result.table) process.stdout.write(`${line}\n`)
  const lines = result.verdictLines
  if (lines) {
    if (lines.reviewer) process.stdout.write(`  reviewer (round ${lines.round}): ${lines.reviewer}\n`)
    if (lines.security) process.stdout.write(`  security (round ${lines.round}): ${lines.security}\n`)
  }
  if (result.resumeCommand) process.stdout.write(`Resume with: ${result.resumeCommand}\n`)
}

/** `--follow`'s own issue-number resolution: `--issue <n>` names it directly; the `<tranche> <n>` form resolves it through the same read the ordinary single-task view already uses. Prints a usage/not-found refusal and exits, never returning, on any failure to resolve. */
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
    console.error('Usage: vinaya task status [<tranche> <n> | --issue <n>] --follow [--quiet]')
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

const DETAIL_RECORD = /^(?:\S+(?: \[[^\]]*\])? {2}| {2})· /

/** Writes only the file's primary lines: a detail record, in the log form (`<ISO time>[ <metadata>]  · <text>`) or the terminal copy (`  · <text>`), is dropped, a trailing partial line waits for its newline (the log appends whole lines), and multibyte characters split across chunks stay whole. */
export function quietLogWriter(write: (text: string) => void): (chunk: Buffer) => void {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  return (chunk) => {
    const lines = (pending + decoder.write(chunk)).split('\n')
    pending = lines.pop() ?? ''
    const kept = lines.filter((line) => !DETAIL_RECORD.test(line))
    if (kept.length > 0) write(`${kept.join('\n')}\n`)
  }
}

/** Follows the task's driver log through the follow view (`followTaskLog`): one readable line per actor, with stage banners and the poll tick's still-in-stage lines. */
async function runFollow(parsed: ParsedArgs): Promise<void> {
  const issue = resolveFollowIssue(parsed)
  const repo = await resolveRepo().catch(() => null)
  await followTaskLog(repo, issue, { quiet: parsed.quiet })
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

import type { SurfaceExemption } from '../lib/surface-exemption'

export const SURFACE_EXEMPTIONS: Record<string, SurfaceExemption> = {
  'task status': { date: '2026-09-12', callsToday: 4, retiresVia: 'taskStatus' }
}
