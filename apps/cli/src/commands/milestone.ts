// `vinaya milestone create` — a Milestone means a product goal, and the
// Architect is the role that creates one. `checkMilestoneShape` (`@attalabs/aeg-core`) refuses a
// malformed body — goal absent, `Release:` present but malformed, the
// `### Tranche intents` section unparseable — before any `gh` call, exactly
// like the Issue-only content gate refuses before `issue.ts`'s forge write.
//
// `gh` has no built-in `milestone create` subcommand (unlike `issue`/`pr`),
// so the actual write goes through `gh api repos/<repo>/milestones` directly
// rather than the `runGhWrite`/`resolveShippableArgs` argv-passthrough
// plumbing `issue.ts`/`pr.ts` share — there is no `gh milestone create` argv
// shape to pass through.

import { execFileSync } from 'node:child_process'
import {
  type AdoptFacts,
  type AdoptSlugFacts,
  type AdoptTargetFacts,
  checkAdoptable,
  checkMilestoneShape
} from '@attalabs/aeg-core'
import { trancheLabel } from '@attalabs/aeg-forge-state'
import { detectGitRepo } from '../lib/detect.js'
import { printJson } from '../lib/envelope.js'
import {
  type BodyResult,
  ForgeArgError,
  extractTitle,
  locateBody,
  makeCheckError,
  refuse,
  resolveSections,
  validateForgeWrite
} from '../lib/forge-write.js'

const RETRY_CREATE = 'vinaya milestone create --title <title> --body-file <path>'
const RETRY_ADOPT = 'vinaya milestone adopt --target <title> --slug <slug> [--slug <slug> ...]'

function sh(args: string[], input?: string): string {
  // `env: process.env` is explicit, not redundant — same reason `waiver.ts`'s
  // own `gh` shell-out passes it: Bun's `execFileSync` snapshots the
  // environment at process start rather than re-reading `process.env` at
  // call time.
  return execFileSync(args[0] as string, args.slice(1), { encoding: 'utf8', input, env: process.env }).trim()
}

function shJson<T>(args: string[], input?: string): T {
  return JSON.parse(sh(args, input)) as T
}

/**
 * `execFileSync`'s thrown `.message` is `"Command failed: <the whole argv>\n<stderr>"`
 * — `gh`'s actual diagnostic (a validation error, a duplicate title, an auth
 * failure) is never on the first line, so truncating to it reports the same
 * content-free "Command failed" text on every failure. Prefers `.stderr`
 * (what `gh` actually wrote) when present, falling back to the full message.
 */
function ghErrorDetail(e: unknown): string {
  const stderr = (e as { stderr?: Buffer | string })?.stderr
  const text = typeof stderr === 'string' ? stderr : stderr?.toString()
  return (text && text.trim().length > 0 ? text : ((e as Error)?.message ?? 'unknown error')).trim()
}

function locateBodyOrRefuse(args: string[]): BodyResult {
  let result: BodyResult | null
  try {
    result = locateBody(args)
  } catch (e) {
    if (e instanceof ForgeArgError) {
      refuse([makeCheckError('forge-args', e.message, `Fix the invocation, then re-run \`${RETRY_CREATE}\`.`)])
    }
    throw e
  }
  if (result === null) {
    refuse([
      makeCheckError(
        'forge-args',
        '`vinaya milestone create` requires a `--body-file <path>` (or `--body <text>`) carrying the milestone description.',
        `Add \`--body-file <path>\`, then re-run \`${RETRY_CREATE}\`.`
      )
    ])
  }
  return result
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

  const bodyResult = locateBodyOrRefuse(rest)
  const body = bodyResult.body

  // Unconditional — runs whether or not `briefSchema.milestone` is
  // configured, mirroring the Issue-only content gate: config decides which
  // EXTRA sections are required, never whether this refusal runs.
  const shape = checkMilestoneShape(body)
  if (shape.status === 'fail') {
    refuse(
      shape.errors.map((message) =>
        makeCheckError('milestone-shape', message, `Fix the Milestone description, then re-run \`${RETRY_CREATE}\`.`)
      )
    )
  }

  // `title: null` — the Milestone title is free text (settled decision: the
  // version comes from `Release:` alone, never the title), so `checkForgeTitle`'s
  // commit-style/task-style grammar (built for PR/Issue titles) does not apply.
  const sections = resolveSections('milestone', RETRY_CREATE)
  const schemaErrors = validateForgeWrite({ body, title: null, sections, changedFiles: [], retryCommand: RETRY_CREATE })
  if (schemaErrors.length > 0) refuse(schemaErrors)

  if (validateOnly) {
    if (json) printJson({ validated: true, written: false, command: 'milestone create' })
    else process.stdout.write('✓ all brief-schema gates PASS — nothing written (--validate-only).\n')
    return
  }

  const repo = await detectGitRepo()
  if (!repo?.owner || !repo.repo) {
    refuse([
      makeCheckError(
        'forge-fetch',
        'Could not resolve a GitHub owner/repo from the `origin` remote.',
        'Run this command from inside a git repository whose `origin` remote points at GitHub.'
      )
    ])
  }
  const repoFlag = `${repo.owner}/${repo.repo}`

  let out: string
  try {
    out = sh(
      ['gh', 'api', `repos/${repoFlag}/milestones`, '--input', '-'],
      JSON.stringify({ title, description: body })
    )
  } catch (e) {
    refuse([
      makeCheckError(
        'forge-fetch',
        `\`gh api repos/${repoFlag}/milestones\` failed: ${ghErrorDetail(e)}`,
        `Check \`gh auth status\` and network, then re-run \`${RETRY_CREATE}\`.`
      )
    ])
  }

  const created = JSON.parse(out) as { number: number; html_url: string }
  if (json) printJson({ validated: true, written: true, number: created.number, url: created.html_url })
  else process.stdout.write(`${created.html_url}\n`)
}

// ---------------------------------------------------------------------------
// `vinaya milestone adopt` (vinaya-milestone-migration-v1 task 1) — moves an
// existing tranche into a Milestone. `checkAdoptable` (`@attalabs/aeg-core`)
// refuses before any forge write: an unknown slug, a slug whose label
// carries no Issues, a target that does not exist or is closed, or a slug
// already adopted into a different Milestone. Facts for EVERY requested slug
// are gathered first and checked in ONE `checkAdoptable` call — a single bad
// slug in a multi-slug invocation refuses the whole batch, so nothing is
// written for any slug, not even a valid one.
//
// Two forge-native primitives do the actual work, neither of which
// `@attalabs/aeg-forge-state` exposes a re-fetchable helper for at this
// package's public surface (`./labels`/`./strip-code`/`.` are the only
// subpaths it exports): `gh issue edit --milestone` (GitHub-view hygiene,
// same as `open-issue.ts`'s creation-time auto-attach — the label, not the
// native milestone field, is what every reader in this repo derives a
// tranche's identity and lifecycle from) and closing the old tranche's own
// legacy Milestone (`archive.ts`'s own `gh api -X PATCH .../state=closed`
// call, mirrored here for the same reason: closed, never deleted, so its
// history and Issue associations survive).

type GhLabelEntry = { name: string }
type GhMilestoneEntry = { number: number; title: string; state: 'open' | 'closed' }
type GhIssueRef = { number: number; state: 'OPEN' | 'CLOSED'; milestone: { title: string } | null }

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

/** A failed forge READ, before any refusal has run — same `CheckError` shape every other forge-fetch failure in this file uses. */
function ghJsonOrRefuse<T>(args: string[], what: string): T {
  try {
    return shJson<T>(args)
  } catch (e) {
    refuse([
      makeCheckError(
        'forge-fetch',
        `could not fetch ${what} from the forge: ${ghErrorDetail(e)}`,
        `Check \`gh auth status\` and network, then re-run \`${RETRY_ADOPT}\`.`
      )
    ])
  }
}

/**
 * Every fact `checkAdoptable` needs, for every requested slug, gathered
 * BEFORE the first refusal is evaluated — no write happens until this
 * returns and `checkAdoptable` passes over the whole result. Two repo-wide
 * reads (labels, Milestones) plus one Issue-list read per requested slug;
 * the Milestone snapshot is returned alongside the facts so the write phase
 * reuses it rather than re-fetching (and risking it drift mid-invocation).
 */
function fetchAdoptFacts(
  repoFlag: string,
  target: string,
  slugs: string[]
): { facts: AdoptFacts; milestones: GhMilestoneEntry[] } {
  const labels = ghJsonOrRefuse<GhLabelEntry[]>(
    ['gh', 'api', `repos/${repoFlag}/labels?per_page=100`],
    "this repo's labels"
  )
  const milestones = ghJsonOrRefuse<GhMilestoneEntry[]>(
    ['gh', 'api', `repos/${repoFlag}/milestones?state=all&per_page=100`],
    "this repo's Milestones"
  )

  const targetMilestone = milestones.find((m) => m.title === target)
  const targetFacts: AdoptTargetFacts = {
    title: target,
    exists: !!targetMilestone,
    state: targetMilestone?.state ?? null
  }

  const slugFacts: AdoptSlugFacts[] = slugs.map((slug) => {
    const labelExists = labels.some((l) => l.name === trancheLabel(slug))
    const issues = labelExists
      ? ghJsonOrRefuse<GhIssueRef[]>(
          [
            'gh',
            'issue',
            'list',
            '-R',
            repoFlag,
            '--label',
            trancheLabel(slug),
            '--state',
            'all',
            '--json',
            'number,state,milestone',
            '--limit',
            '200'
          ],
          `Issues for \`${trancheLabel(slug)}\``
        )
      : []

    // "Adopted elsewhere" excludes null (never attached), the slug itself
    // (its own legacy 1:1 tranche-Milestone — the ordinary pre-adopt state),
    // and the requested target (a harmless no-op re-run).
    const elsewhere = new Set<string>()
    for (const issue of issues) {
      const title = issue.milestone?.title
      if (title && title !== slug && title !== target) elsewhere.add(title)
    }

    return {
      slug,
      labelExists,
      issueNumbers: issues.map((i) => i.number),
      adoptedElsewhere: [...elsewhere]
    }
  })

  return { facts: { target: targetFacts, slugs: slugFacts }, milestones }
}

/**
 * A write-phase failure — distinct from `refuse()`, which always means
 * "nothing reached the forge." By the time this can fire, `checkAdoptable`
 * has already passed and some writes may have already landed for an earlier
 * slug (or an earlier Issue within this one); the message says exactly how
 * far the run got. Every write this command makes is idempotent
 * (`gh issue edit --milestone` re-sets the same value; closing an
 * already-closed Milestone is a no-op state transition) — the recovery story
 * is simply re-running the identical `adopt` invocation.
 */
function failMidWrite(message: string): never {
  console.error(`\n[milestone adopt] PARTIAL WRITE — ${message}`)
  console.error(`[milestone adopt] Re-running \`${RETRY_ADOPT}\` is safe — every write here is idempotent.`)
  process.exit(1)
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

  const repo = await detectGitRepo()
  if (!repo?.owner || !repo.repo) {
    refuse([
      makeCheckError(
        'forge-fetch',
        'Could not resolve a GitHub owner/repo from the `origin` remote.',
        'Run this command from inside a git repository whose `origin` remote points at GitHub.'
      )
    ])
  }
  const repoFlag = `${repo.owner}/${repo.repo}`

  // ---- gather everything -----------------------------------------------
  const { facts, milestones } = fetchAdoptFacts(repoFlag, target, slugs)

  // ---- refuse or proceed — one call over the WHOLE batch ----------------
  const verdict = checkAdoptable(facts)
  if (verdict.status === 'fail') {
    refuse(
      verdict.errors.map((message) =>
        makeCheckError('milestone-adopt', message, `Fix the input above, then re-run \`${RETRY_ADOPT}\`.`)
      )
    )
  }

  if (validateOnly) {
    if (json) printJson({ validated: true, written: false, command: 'milestone adopt' })
    else process.stdout.write('✓ adopt is safe — nothing written (--validate-only).\n')
    return
  }

  // ---- then write — never before every refusal above has run -----------
  const adopted: Array<{ slug: string; issueCount: number; closedMilestone: number | null }> = []
  for (const slugFact of facts.slugs) {
    for (const issueNumber of slugFact.issueNumbers) {
      try {
        sh(['gh', 'issue', 'edit', String(issueNumber), '-R', repoFlag, '--milestone', target])
      } catch (e) {
        failMidWrite(
          `failed to attach Issue #${issueNumber} (tranche \`${slugFact.slug}\`) to Milestone "${target}": ` +
            `${ghErrorDetail(e)}. Slugs already adopted this run: ${adopted.map((a) => a.slug).join(', ') || '(none)'}.`
        )
      }
    }

    const legacy = milestones.find((m) => m.title === slugFact.slug && m.title !== target)
    let closedMilestone: number | null = null
    if (legacy) {
      closedMilestone = legacy.number
      if (legacy.state !== 'closed') {
        try {
          sh(['gh', 'api', '-X', 'PATCH', `repos/${repoFlag}/milestones/${legacy.number}`, '-f', 'state=closed'])
        } catch (e) {
          failMidWrite(
            `attached tranche \`${slugFact.slug}\`'s Issue(s) to Milestone "${target}", but failed to close its old ` +
              `Milestone #${legacy.number}: ${ghErrorDetail(e)}. Slugs already adopted this run: ` +
              `${adopted.map((a) => a.slug).join(', ') || '(none)'}.`
          )
        }
      }
    }

    adopted.push({ slug: slugFact.slug, issueCount: slugFact.issueNumbers.length, closedMilestone })
  }

  if (json) printJson({ validated: true, written: true, target, adopted })
  else {
    for (const a of adopted) {
      const closedNote = a.closedMilestone ? ` (old Milestone #${a.closedMilestone} closed)` : ''
      process.stdout.write(`${a.slug}: ${a.issueCount} Issue(s) → "${target}"${closedNote}\n`)
    }
  }
}
