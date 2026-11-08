/**
 * `vinaya-task-brief <tranche> <n> [--supersede --reason <text> [--surface-in <glob,...>]]`
 * — argv parsing only, around `prepareTaskOrIssue` (`lib/dispatch-task.ts`), the
 * one lib function it calls. Preparation only: it renders and freezes the
 * brief and starts no worker. `--supersede` posts a new, higher-versioned frozen brief naming its
 * predecessor and `--reason`'s text, instead of refusing on the one that's
 * already there — always paired with `--reason`, never accepted alone.
 * `--surface-in`, only meaningful alongside `--supersede`, widens the
 * frozen brief's `## Surface` `in:` list with the given globs before
 * re-freezing — the one self-serve way to broaden a Surface once frozen.
 * A Surface widened in answer to a Developer's `widen_surface` escalation
 * goes through `vinaya task run … --widen-surface <glob,...> --reason <text>`
 * instead, which runs this same supersede and then starts the run in order.
 */

import { isEntryPoint } from '../../../../../kernel/gates/checks/entry-point.js'
import { prepareTaskOrIssue } from '../dispatch-task.js'

/** Parses `--supersede`/`--reason`/`--surface-in` — shared by the `<tranche> <n>` and `--issue <n>` forms of `task brief`. */
function parseSupersede(rest: string[], usage: string): { reason: string; surfaceIn?: string[] } | undefined {
  const hasSupersede = rest.includes('--supersede')
  const reasonIdx = rest.indexOf('--reason')
  const reason = reasonIdx !== -1 ? rest[reasonIdx + 1] : undefined
  const surfaceInIdx = rest.indexOf('--surface-in')
  const surfaceInArg = surfaceInIdx !== -1 ? rest[surfaceInIdx + 1] : undefined

  if (hasSupersede && !reason) {
    console.error(`vinaya task brief: --supersede requires --reason <text>.\n${usage}`)
    process.exit(2)
  }
  if (!hasSupersede && reasonIdx !== -1) {
    console.error(`vinaya task brief: --reason is only meaningful with --supersede.\n${usage}`)
    process.exit(2)
  }
  if (surfaceInIdx !== -1 && !hasSupersede) {
    console.error(`vinaya task brief: --surface-in is only meaningful with --supersede.\n${usage}`)
    process.exit(2)
  }
  if (surfaceInIdx !== -1 && !surfaceInArg) {
    console.error(`vinaya task brief: --surface-in <glob1,glob2,...> was passed with no value.\n${usage}`)
    process.exit(2)
  }
  const surfaceIn = surfaceInArg
    ? surfaceInArg
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined
  if (surfaceInIdx !== -1 && (!surfaceIn || surfaceIn.length === 0)) {
    console.error(`vinaya task brief: --surface-in resolved to zero globs.\n${usage}`)
    process.exit(2)
  }

  return hasSupersede ? { reason: reason as string, surfaceIn } : undefined
}

const TASK_BRIEF_USAGE = [
  'Usage: vinaya-task-brief <tranche> <n> [--supersede --reason <text> [--surface-in <glob,...>]]',
  '   or: vinaya-task-brief --issue <n> [--supersede --reason <text> [--surface-in <glob,...>]]'
].join('\n')

/**
 * `--issue <n>` — renders and freezes a backlog
 * Issue's brief exactly as `<tranche> <n>` does for a tranche task. Mutually
 * exclusive with the `<tranche> <n>` positional form.
 */
export async function taskBriefCommand(args: string[]): Promise<void> {
  const issueIdx = args.indexOf('--issue')
  const firstLooksPositional = args[0] !== undefined && !args[0].startsWith('--')

  if (issueIdx !== -1 && firstLooksPositional) {
    console.error(`vinaya task brief: pass either <tranche> <n> or --issue <n>, never both.\n${TASK_BRIEF_USAGE}`)
    process.exit(2)
  }

  if (issueIdx !== -1) {
    const issueArg = args[issueIdx + 1]
    const issueN = issueArg !== undefined ? Number.parseInt(issueArg, 10) : Number.NaN
    if (!issueArg || !Number.isInteger(issueN) || String(issueN) !== issueArg) {
      console.error(`vinaya task brief: --issue must be numeric — got "${issueArg}".\n${TASK_BRIEF_USAGE}`)
      process.exit(2)
    }
    const rest = [...args.slice(0, issueIdx), ...args.slice(issueIdx + 2)]
    const supersede = parseSupersede(rest, TASK_BRIEF_USAGE)
    const result = await prepareTaskOrIssue({ issue: issueN, supersede })
    process.stdout.write(`${result.brief}\n`)
    process.stdout.write(`\nPosted (v${result.version}): ${result.commentUrl}\n`)
    return
  }

  const trancheSlug = args[0]
  const taskIdArg = args[1]
  if (!trancheSlug || !taskIdArg || trancheSlug.startsWith('--')) {
    console.error(TASK_BRIEF_USAGE)
    process.exit(2)
  }

  const n = Number.parseInt(taskIdArg, 10)
  if (!Number.isInteger(n) || String(n) !== taskIdArg) {
    console.error(`vinaya task brief: task id must be numeric — got "${taskIdArg}".`)
    process.exit(2)
  }

  const supersede = parseSupersede(args.slice(2), TASK_BRIEF_USAGE)
  const result = await prepareTaskOrIssue({ tranche: trancheSlug, n, supersede })
  process.stdout.write(`${result.brief}\n`)
  process.stdout.write(`\nPosted (v${result.version}): ${result.commentUrl}\n`)
}

// Run as a program (`vinaya-task-brief`): started through the shared program entry.
if (isEntryPoint(import.meta.url, 'task-brief')) {
  const { runProgram } = await import('../../program-entry.js')
  await runProgram('task-brief', async (argv: string[]) => {
    await taskBriefCommand(argv)
  })
}
