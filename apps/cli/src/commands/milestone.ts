// `vinaya milestone …` — a Milestone means a product goal, and the Architect is
// the role that creates one. Each command parses its argv, calls one operation
// of the Milestone library (`milestone-operations`) and prints the outcome: the
// gates, the forge calls and the refusals live there. A refused outcome prints
// each finding as a JSON line on stderr and exits 1, exactly as before.

import { printJson } from '../../../../harness/kernel/effects/envelope.js'
import {
  adoptMilestone,
  closeMilestone,
  createMilestone,
  editMilestone,
  milestoneStatus,
  type Refused,
  type StatusIssueCounts,
  RETRY_ADOPT,
  RETRY_CLOSE,
  RETRY_CREATE,
  RETRY_EDIT,
  RETRY_STATUS
} from '../../../../harness/processes/vinaya-strict/tools/milestone/milestone-operations'
import {
  type BodyResult,
  ForgeArgError,
  extractTitle,
  locateBody,
  makeCheckError,
  refuse
} from '../../../../harness/processes/vinaya-strict/tools/task-contract/forge/forge-write.js'

/** A refused outcome ends the command: the findings on stderr, or an adopt write's partial-write notice, then exit 1. */
function endOnRefusal(outcome: Refused): never {
  if (outcome.partialWrite !== undefined) {
    console.error(`\n[milestone adopt] PARTIAL WRITE — ${outcome.partialWrite}`)
    console.error(`[milestone adopt] Re-running \`${RETRY_ADOPT}\` is safe — every write here is idempotent.`)
    process.exit(1)
  }
  refuse(outcome.findings)
}

/**
 * Shared by `create` and `edit` — both require a `--body-file`/`--body`
 * carrying the milestone description, refused with each command's own retry
 * string so the recovery prompt names the invocation that actually failed.
 */
function locateBodyOrRefuse(args: string[], commandName: 'create' | 'edit', retryCommand: string): BodyResult {
  let result: BodyResult | null
  try {
    result = locateBody(args)
  } catch (e) {
    if (e instanceof ForgeArgError) {
      refuse([makeCheckError('forge-args', e.message, `Fix the invocation, then re-run \`${retryCommand}\`.`)])
    }
    throw e
  }
  if (result === null) {
    refuse([
      makeCheckError(
        'forge-args',
        `\`vinaya milestone ${commandName}\` requires a \`--body-file <path>\` (or \`--body <text>\`) carrying the milestone description.`,
        `Add \`--body-file <path>\`, then re-run \`${retryCommand}\`.`
      )
    ])
  }
  return result
}

/** The `--validate-only` "nothing written" result shared by `create` and `edit`. */
function printValidateOnly(json: boolean, command: string): void {
  if (json) printJson({ validated: true, written: false, command })
  else process.stdout.write('✓ all brief-schema gates PASS — nothing written (--validate-only).\n')
}

export async function milestoneCreateCommand(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const validateOnly = args.includes('--validate-only')
  const rest = args.filter((a) => a !== '--json' && a !== '--validate-only')

  const title = extractTitle(rest)
  if (!title) {
    refuse([
      makeCheckError(
        'forge-args',
        '`vinaya milestone create` requires a `--title <title>` — the Milestone title is free text, never parsed for the version.',
        `Add \`--title <title>\`, then re-run \`${RETRY_CREATE}\`.`
      )
    ])
  }

  const body = locateBodyOrRefuse(rest, 'create', RETRY_CREATE).body

  const outcome = await createMilestone({ title, body, validateOnly })
  if (!outcome.ok) endOnRefusal(outcome)
  if (!outcome.written) return printValidateOnly(json, 'milestone create')
  if (json) printJson({ validated: true, written: true, number: outcome.number, url: outcome.url })
  else process.stdout.write(`${outcome.url}\n`)
}

/**
 * `<n>` is the first positional argument — same shape `issue edit <n>` and
 * `pr edit <n>` use. Refuses on anything but a bare digit string — `number` is
 * interpolated straight into a `gh api` REST path, so a malformed value must
 * never reach that call at all.
 */
function extractMilestoneNumber(rest: string[]): { number: string; ghArgs: string[] } | null {
  const numberArg = rest[0]
  if (!numberArg || numberArg.startsWith('-') || !/^\d+$/.test(numberArg)) return null
  return { number: numberArg, ghArgs: rest.slice(1) }
}

export async function milestoneEditCommand(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const validateOnly = args.includes('--validate-only')
  const rest = args.filter((a) => a !== '--json' && a !== '--validate-only')

  const target = extractMilestoneNumber(rest)
  if (!target) {
    refuse([
      makeCheckError(
        'forge-args',
        '`vinaya milestone edit` requires the target Milestone number (digits only) as the first argument.',
        `Pass the Milestone number, e.g. \`${RETRY_EDIT}\`.`
      )
    ])
  }
  const { number, ghArgs } = target

  const body = locateBodyOrRefuse(ghArgs, 'edit', RETRY_EDIT).body

  const outcome = await editMilestone({ number, body, validateOnly })
  if (!outcome.ok) endOnRefusal(outcome)
  if (!outcome.written) return printValidateOnly(json, 'milestone edit')
  if (json) printJson({ validated: true, written: true, number: outcome.number, url: outcome.url })
  else process.stdout.write(`${outcome.url}\n`)
}

function extractTarget(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === '--target' || a === '-m') return args[i + 1] ?? null
    if (a.startsWith('--target=')) return a.slice('--target='.length)
  }
  return null
}

function extractSlugs(args: string[]): string[] {
  const slugs: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === '--slug') {
      const v = args[i + 1]
      if (v) slugs.push(v)
    } else if (a.startsWith('--slug=')) {
      slugs.push(a.slice('--slug='.length))
    }
  }
  return slugs
}

export async function milestoneAdoptCommand(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const validateOnly = args.includes('--validate-only')
  const rest = args.filter((a) => a !== '--json' && a !== '--validate-only')

  const target = extractTarget(rest)
  if (!target) {
    refuse([
      makeCheckError(
        'forge-args',
        '`vinaya milestone adopt` requires a `--target <title>` — the Milestone every named slug is adopted into.',
        `Add \`--target <title>\`, then re-run \`${RETRY_ADOPT}\`.`
      )
    ])
  }

  const slugs = extractSlugs(rest)
  if (slugs.length === 0) {
    refuse([
      makeCheckError(
        'forge-args',
        '`vinaya milestone adopt` requires at least one `--slug <slug>` — the tranche(s) to move into the target Milestone.',
        `Add one or more \`--slug <slug>\`, then re-run \`${RETRY_ADOPT}\`.`
      )
    ])
  }

  const outcome = await adoptMilestone({ target, slugs, validateOnly })
  if (!outcome.ok) endOnRefusal(outcome)
  if (!outcome.written) {
    if (json) printJson({ validated: true, written: false, command: 'milestone adopt' })
    else process.stdout.write('✓ adopt is safe — nothing written (--validate-only).\n')
    return
  }

  if (json) printJson({ validated: true, written: true, target: outcome.target, adopted: outcome.adopted })
  else {
    for (const a of outcome.adopted) {
      const closedNote = a.closedMilestone ? ` (old Milestone #${a.closedMilestone} closed)` : ''
      process.stdout.write(`${a.slug}: ${a.issueCount} Issue(s) → "${outcome.target}"${closedNote}\n`)
    }
  }
}

function extractSlug(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === '--slug') return args[i + 1] ?? null
    if (a.startsWith('--slug=')) return a.slice('--slug='.length)
  }
  return null
}

export async function milestoneCloseCommand(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const validateOnly = args.includes('--validate-only')
  const rest = args.filter((a) => a !== '--json' && a !== '--validate-only')

  const slug = extractSlug(rest)
  if (!slug) {
    refuse([
      makeCheckError(
        'forge-args',
        '`vinaya milestone close` requires a `--slug <slug>` — the tranche whose Milestone is being closed.',
        `Add \`--slug <slug>\`, then re-run \`${RETRY_CLOSE}\`.`
      )
    ])
  }

  const outcome = await closeMilestone({ slug, validateOnly })
  if (!outcome.ok) endOnRefusal(outcome)
  if (!outcome.written) {
    if (json) printJson({ validated: true, written: false, command: 'milestone close', number: outcome.number })
    else {
      process.stdout.write(
        `✓ Milestone "${outcome.title}" (#${outcome.number}) attachment verified — nothing written (--validate-only).\n`
      )
    }
    return
  }
  if (json) printJson({ validated: true, written: true, number: outcome.number, url: outcome.url })
  else process.stdout.write(`${outcome.url}\n`)
}

function formatIssueCounts(total: number, counts: StatusIssueCounts): string {
  if (total === 0) return '0 issues'
  const parts: string[] = []
  if (counts.merged > 0) parts.push(`${counts.merged} merged`)
  if (counts.open > 0) parts.push(`${counts.open} open`)
  if (counts.notPlanned > 0) parts.push(`${counts.notPlanned} not planned`)
  return parts.length > 0 ? `${total} issues · ${parts.join(' · ')}` : `${total} issues`
}

/** `<n>` is the sole positional argument — digits only, same discipline `extractMilestoneNumber` uses. */
function extractStatusNumber(rest: string[]): string | null {
  const numberArg = rest[0]
  if (!numberArg || numberArg.startsWith('-') || !/^\d+$/.test(numberArg)) return null
  return numberArg
}

export async function milestoneStatusCommand(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const rest = args.filter((a) => a !== '--json')

  const numberArg = extractStatusNumber(rest)
  if (!numberArg) {
    refuse([
      makeCheckError(
        'forge-args',
        '`vinaya milestone status` requires the target Milestone number (digits only) as the first argument.',
        `Pass the Milestone number, e.g. \`${RETRY_STATUS}\`.`
      )
    ])
  }

  const outcome = await milestoneStatus({ number: numberArg })
  if (!outcome.ok) endOnRefusal(outcome)
  const header = outcome.milestone

  if (outcome.tranches.length === 0) {
    if (json) printJson({ milestone: header, tranches: [] })
    else {
      process.stdout.write(`${header.title} (#${header.number}, ${header.state})\n`)
      process.stdout.write('no tranche intents declared\n')
    }
    return
  }

  if (json) {
    printJson({ milestone: header, tranches: outcome.tranches })
  } else {
    process.stdout.write(`${header.title} (#${header.number}, ${header.state})\n`)
    for (const row of outcome.tranches) {
      process.stdout.write(`${row.slug} ${row.lifecycle} ${formatIssueCounts(row.issues, row.counts)}\n`)
    }
  }
}

import type { SurfaceExemption } from '../../../../harness/processes/vinaya-strict/tools/pr-report/surface-exemption'

export const SURFACE_EXEMPTIONS: Record<string, SurfaceExemption> = {
  'milestone create': { date: '2026-09-05', callsToday: 7, retiresVia: 'forgeWrite' },
  'milestone adopt': { date: '2026-09-05', callsToday: 3, retiresVia: 'forgeWrite' },
  'milestone edit': { date: '2026-09-05', callsToday: 6, retiresVia: 'forgeWrite' },
  'milestone close': { date: '2026-09-05', callsToday: 5, retiresVia: 'forgeWrite' },
  'milestone status': { date: '2026-09-10', callsToday: 3, retiresVia: 'forgeWrite' }
}
