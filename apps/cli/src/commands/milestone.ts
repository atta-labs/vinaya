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
import {
  checkMilestoneAttachment,
  fetchTrancheIssuesAsync,
  findMilestoneForSlug,
  intentLines,
  resolveMilestoneAttachTarget,
  trancheFromIssues,
  trancheLabel
} from '@attalabs/aeg-forge-state'
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
const RETRY_EDIT = 'vinaya milestone edit <n> --body-file <path>'
const RETRY_CLOSE = 'vinaya milestone close --slug <slug>'
const RETRY_STATUS = 'vinaya milestone status <n>'

function sh(args: string[], input?: string): string {
  // `env: process.env` is explicit, not redundant — same reason `waiver.ts`'s
  // own `gh` shell-out passes it: Bun's `execFileSync` snapshots the
  // environment at process start rather than re-reading `process.env` at
  // call time.
  //
  // `stdio: ['pipe', 'pipe', 'pipe']` — explicit, not cosmetic: without it,
  // Bun's `execFileSync` inherits the child's stderr to this process's real
  // stderr at spawn time, BEFORE the thrown error is ever caught — so a
  // failing `gh` call leaked its raw error text as an extra, non-JSON line
  // ahead of the `CheckError` `refuse()` emits, breaking the "one JSON line
  // per finding on stderr" contract every reader of this CLI's stderr
  // depends on (found live via the `milestone edit` PATCH-failure test).
  // stdin stays `'pipe'` (not `'ignore'`, unlike `waiver.ts`'s own `gh()`,
  // which never sends `input`) — `create`/`edit` pipe a JSON body through it.
  return execFileSync(args[0] as string, args.slice(1), {
    encoding: 'utf8',
    input,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim()
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

/**
 * Is this failure just "no such Milestone", not a genuine forge-unreachable
 * error? Same whole-message-plus-stderr scan `lib/config.ts`'s
 * `isMissingFileError` already documents the need for: `execFileSync` throws
 * with `message = "Command failed: <argv>\n<stderr>"`, so `gh`'s real `Not
 * Found (HTTP 404)` text is never on line 1.
 */
function is404(e: unknown): boolean {
  const stderr = (e as { stderr?: Buffer | string })?.stderr
  const haystack = [(e as Error)?.message ?? '', typeof stderr === 'string' ? stderr : (stderr?.toString() ?? '')].join(
    '\n'
  )
  return /\b404\b|not found/i.test(haystack)
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

/**
 * `checkMilestoneShape` refusal — unconditional, same discipline `create`
 * and `edit` both run before any write: config decides which EXTRA sections
 * are required (`refuseOnSchemaErrors`, below), never whether THIS refusal
 * runs.
 */
function refuseOnBadShape(body: string, retryCommand: string): void {
  const shape = checkMilestoneShape(body)
  if (shape.status === 'fail') {
    refuse(
      shape.errors.map((message) =>
        makeCheckError('milestone-shape', message, `Fix the Milestone description, then re-run \`${retryCommand}\`.`)
      )
    )
  }
}

/**
 * The config-defined `briefSchema.milestone` sections gate — `title: null`
 * because a Milestone's title is free text (settled decision: the version
 * comes from `Release:` alone, never the title), so `checkForgeTitle`'s
 * commit-style/task-style grammar (built for PR/Issue titles) does not apply.
 */
function refuseOnSchemaErrors(body: string, retryCommand: string): void {
  const sections = resolveSections('milestone', retryCommand)
  const schemaErrors = validateForgeWrite({ body, title: null, sections, changedFiles: [], retryCommand })
  if (schemaErrors.length > 0) refuse(schemaErrors)
}

/**
 * Prints the `--validate-only` "nothing written" result and reports whether
 * the caller should return immediately — shared by every `milestone`
 * subcommand's identical dry-run shape.
 */
function reportIfValidateOnly(validateOnly: boolean, json: boolean, command: string): boolean {
  if (!validateOnly) return false
  if (json) printJson({ validated: true, written: false, command })
  else process.stdout.write('✓ all brief-schema gates PASS — nothing written (--validate-only).\n')
  return true
}

/** Resolves `owner/repo` from `origin`, refusing with the same message every `milestone` write command uses. */
async function resolveRepoFlagOrRefuse(retryCommand: string): Promise<string> {
  const repo = await detectGitRepo()
  if (!repo?.owner || !repo.repo) {
    refuse([
      makeCheckError(
        'forge-fetch',
        'Could not resolve a GitHub owner/repo from the `origin` remote.',
        `Run this command from inside a git repository whose \`origin\` remote points at GitHub, then re-run \`${retryCommand}\`.`
      )
    ])
  }
  return `${repo.owner}/${repo.repo}`
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

  const bodyResult = locateBodyOrRefuse(rest, 'create', RETRY_CREATE)
  const body = bodyResult.body

  refuseOnBadShape(body, RETRY_CREATE)
  refuseOnSchemaErrors(body, RETRY_CREATE)

  if (reportIfValidateOnly(validateOnly, json, 'milestone create')) return

  const repoFlag = await resolveRepoFlagOrRefuse(RETRY_CREATE)

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
// `vinaya milestone edit` — the gated replacement for the raw `gh api PATCH`
// that has patched a Milestone's description twice in two days. Same shape
// as `create`: `checkMilestoneShape` refuses a malformed body before any
// write reaches the forge, and the config-defined `briefSchema.milestone`
// sections (dormant today — `vinaya.config.json` declares none) run the same
// way `create`'s do. Only the description changes; the title is untouched.
// ---------------------------------------------------------------------------

/**
 * `<n>` is the first positional argument — same shape `issue edit <n>` and
 * `pr edit <n>` already use (not a named `--target`-style flag: those two
 * sibling `edit` commands, which `milestone edit` mirrors, both take the
 * target's number/URL positionally; `create`/`adopt` take named flags
 * because they have no existing forge object to address yet). Refuses on
 * anything but a bare digit string — `number` is interpolated straight into
 * a `gh api` REST path below, so a malformed value must never reach that
 * call at all.
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

  const bodyResult = locateBodyOrRefuse(ghArgs, 'edit', RETRY_EDIT)
  const body = bodyResult.body

  refuseOnBadShape(body, RETRY_EDIT)
  refuseOnSchemaErrors(body, RETRY_EDIT)

  if (reportIfValidateOnly(validateOnly, json, 'milestone edit')) return

  const repoFlag = await resolveRepoFlagOrRefuse(RETRY_EDIT)

  let out: string
  try {
    out = sh(
      ['gh', 'api', '-X', 'PATCH', `repos/${repoFlag}/milestones/${number}`, '--input', '-'],
      JSON.stringify({ description: body })
    )
  } catch (e) {
    refuse([
      makeCheckError(
        'forge-fetch',
        `\`gh api repos/${repoFlag}/milestones/${number}\` failed: ${ghErrorDetail(e)}`,
        `Check \`gh auth status\` and network, then re-run \`${RETRY_EDIT}\`.`
      )
    ])
  }

  const edited = JSON.parse(out) as { number: number; html_url: string }
  if (json) printJson({ validated: true, written: true, number: edited.number, url: edited.html_url })
  else process.stdout.write(`${edited.html_url}\n`)
}

// ---------------------------------------------------------------------------
// `vinaya milestone adopt` — moves an existing tranche into a Milestone.
// `checkAdoptable` (`@attalabs/aeg-core`)
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
type GhMilestoneEntry = { number: number; title: string; description: string | null; state: 'open' | 'closed' }
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

/**
 * A failed forge READ, before any refusal has run — same `CheckError` shape
 * every other forge-fetch failure in this file uses. `retryCommand` names
 * whichever invocation actually failed (`adopt` and `close` both share this
 * helper rather than each keeping its own fetch-or-refuse copy).
 */
function ghJsonOrRefuse<T>(args: string[], what: string, retryCommand: string): T {
  try {
    return shJson<T>(args)
  } catch (e) {
    refuse([
      makeCheckError(
        'forge-fetch',
        `could not fetch ${what} from the forge: ${ghErrorDetail(e)}`,
        `Check \`gh auth status\` and network, then re-run \`${retryCommand}\`.`
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
    "this repo's labels",
    RETRY_ADOPT
  )
  const milestones = ghJsonOrRefuse<GhMilestoneEntry[]>(
    ['gh', 'api', `repos/${repoFlag}/milestones?state=all&per_page=100`],
    "this repo's Milestones",
    RETRY_ADOPT
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
          `Issues for \`${trancheLabel(slug)}\``,
          RETRY_ADOPT
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

  const repoFlag = await resolveRepoFlagOrRefuse(RETRY_ADOPT)

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

// ---------------------------------------------------------------------------
// `vinaya milestone close` — replaces the raw `gh api .../milestones/<n> -X
// PATCH -f state=closed` recipe `tranche-archivist.md` step 3 used to carry,
// unconditionally, on faith. The one forge write in the whole lifecycle that
// shipped with zero validation in front of it: step 1 verifies
// each task Issue is CLOSED and LABELED, never that it is ATTACHED (the
// native `milestone` field) — an assumption that was live-false (`vinaya
// issue create` never attached before a real fix) and is checked here, on
// the write, rather than trusted. `checkMilestoneAttachment`
// (`@attalabs/aeg-forge-state`) is the pure diff between the two forge facts;
// this command's only job is fetching them and gating the PATCH on the
// result — same discipline as every other forge write in this file.
// ---------------------------------------------------------------------------

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

  const repoFlag = await resolveRepoFlagOrRefuse(RETRY_CLOSE)

  // ---- resolve the target Milestone — same legacy-or-intent-declared match
  // `resolveMilestoneAttachTarget` already applies at Issue-create time
  // — closing must find the same Milestone an Issue's auto-attach
  // would have named, or step 3's recipe silently does nothing for any
  // intent-declared tranche, exactly the gap this task exists to close. ----
  const milestones = ghJsonOrRefuse<GhMilestoneEntry[]>(
    ['gh', 'api', `repos/${repoFlag}/milestones?state=all&per_page=100`],
    "this repo's Milestones",
    RETRY_CLOSE
  )

  const target = resolveMilestoneAttachTarget(milestones, slug)
  if (!target) {
    refuse([
      makeCheckError(
        'milestone-close',
        `No OPEN Milestone resolves for tranche \`${slug}\` — it may already be closed, or never had one attached.`,
        `Confirm with \`gh issue list --label ${trancheLabel(slug)} --json milestone\`, or run \`vinaya milestone ` +
          `create\`/\`${RETRY_ADOPT}\` if a Milestone is genuinely still owed, then re-run \`${RETRY_CLOSE}\`.`
      )
    ])
  }

  // ---- gather the two facts the pure function diffs — both fetched here,
  // never inside `checkMilestoneAttachment` itself. ----
  const labeledIssues = ghJsonOrRefuse<GhIssueRef[]>(
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
    `Issues for \`${trancheLabel(slug)}\``,
    RETRY_CLOSE
  )

  const attachedIssues = ghJsonOrRefuse<GhIssueRef[]>(
    [
      'gh',
      'issue',
      'list',
      '-R',
      repoFlag,
      '--milestone',
      target.title,
      '--state',
      'all',
      '--json',
      'number,state,milestone',
      '--limit',
      '200'
    ],
    `Issues attached to Milestone "${target.title}"`,
    RETRY_CLOSE
  )

  const report = checkMilestoneAttachment(
    labeledIssues.map((i) => i.number),
    attachedIssues.map((i) => i.number)
  )

  // ---- refuse on any mismatch, naming the repair path — BEFORE the PATCH,
  // always. ----
  if (report.status === 'mismatch') {
    const errors = []
    if (report.unattached.length > 0) {
      errors.push(
        makeCheckError(
          'milestone-close',
          `Issue(s) ${report.unattached.map((n) => `#${n}`).join(', ')} carry \`${trancheLabel(slug)}\` but ` +
            `are not attached to Milestone "${target.title}".`,
          `Attach each with \`gh issue edit <n> --milestone "${target.title}"\`, then re-run \`${RETRY_CLOSE}\`.`
        )
      )
    }
    if (report.foreign.length > 0) {
      errors.push(
        makeCheckError(
          'milestone-close',
          `Issue(s) ${report.foreign.map((n) => `#${n}`).join(', ')} are attached to Milestone "${target.title}" ` +
            `but do not carry \`${trancheLabel(slug)}\` — closing would end tracking for whatever they belong to as well.`,
          `Move them with \`${RETRY_ADOPT}\` if they belong to a different tranche, or \`gh issue edit <n> ` +
            `--milestone <title>\` to relocate them, then re-run \`${RETRY_CLOSE}\`.`
        )
      )
    }
    refuse(errors)
  }

  if (validateOnly) {
    if (json) printJson({ validated: true, written: false, command: 'milestone close', number: target.number })
    else {
      process.stdout.write(
        `✓ Milestone "${target.title}" (#${target.number}) attachment verified — nothing written (--validate-only).\n`
      )
    }
    return
  }

  // ---- then write — never before every refusal above has run ----
  let out: string
  try {
    out = sh(['gh', 'api', '-X', 'PATCH', `repos/${repoFlag}/milestones/${target.number}`, '-f', 'state=closed'])
  } catch (e) {
    refuse([
      makeCheckError(
        'forge-fetch',
        `\`gh api repos/${repoFlag}/milestones/${target.number}\` failed: ${ghErrorDetail(e)}`,
        `Check \`gh auth status\` and network, then re-run \`${RETRY_CLOSE}\`.`
      )
    ])
  }

  const closed = JSON.parse(out) as { number: number; html_url: string }
  if (json) printJson({ validated: true, written: true, number: closed.number, url: closed.html_url })
  else process.stdout.write(`${closed.html_url}\n`)
}

// ---------------------------------------------------------------------------
// `vinaya milestone status` — read-only: for each `- <slug>: …` line in a
// Milestone's `### Tranche intents` section, print the tranche's lifecycle
// and issue counts, derived from the forge. Nothing is written anywhere.
//
// The lifecycle/goal half reuses the exact composition
// `deriveTrancheFromForge` performs (`findMilestoneForSlug` +
// `fetchTrancheIssuesAsync` + `trancheFromIssues`, all already exported)
// rather than calling that wrapper directly — calling it directly would
// still leave this command needing its own second fetch of the same
// label's Issues to build the merged/not-planned breakdown, since a `Task`
// carries no close-reason field. Composing the same three primitives by
// hand gets both halves from the ONE Issue fetch.
//
// The merged/not-planned breakdown itself reads GitHub's native
// `stateReason` off the same labeled-Issue fetch — not
// `fetchForgeFacts`/`deriveTranche` (`@attalabs/aeg-core`)'s heavier,
// PR-merge-verifying dispatch-status pipeline, which queries
// `@octokit/graphql` directly over HTTP rather than through a stubbable
// `gh` binary (documented in `apps/cli/tests/commands/brief-render.test.ts`
// and `apps/cli/tests/checks/branch-topology.test.ts`) and so cannot be
// exercised by this file's fake-`gh`-on-PATH unit tests at all. "merged"
// here means "closed, not explicitly `NOT_PLANNED`" — the same honest
// terminal reading `derive-tranche.ts`'s own status derivation gives a
// closed Issue with no verified merged PR — not proof a PR merged.
// ---------------------------------------------------------------------------

type StatusIssueCounts = { merged: number; open: number; notPlanned: number }

function tallyIssueCounts(issues: Array<{ state: 'OPEN' | 'CLOSED'; stateReason?: string | null }>): StatusIssueCounts {
  const counts: StatusIssueCounts = { merged: 0, open: 0, notPlanned: 0 }
  for (const issue of issues) {
    if (issue.state === 'OPEN') counts.open++
    else if (issue.stateReason === 'NOT_PLANNED') counts.notPlanned++
    else counts.merged++
  }
  return counts
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

  const repoFlag = await resolveRepoFlagOrRefuse(RETRY_STATUS)
  const [owner, repo] = repoFlag.split('/') as [string, string]

  let milestone: GhMilestoneEntry
  try {
    milestone = shJson<GhMilestoneEntry>(['gh', 'api', `repos/${repoFlag}/milestones/${numberArg}`])
  } catch (e) {
    if (is404(e)) {
      refuse([
        makeCheckError(
          'milestone-status',
          `Milestone #${numberArg} is not an open-or-closed Milestone in ${repoFlag}.`,
          `Confirm the number with \`gh api repos/${repoFlag}/milestones\`, then re-run \`${RETRY_STATUS}\`.`
        )
      ])
    }
    refuse([
      makeCheckError(
        'forge-fetch',
        `could not fetch Milestone #${numberArg} from the forge: ${ghErrorDetail(e)}`,
        `Check \`gh auth status\` and network, then re-run \`${RETRY_STATUS}\`.`
      )
    ])
  }

  const header = { number: milestone.number, title: milestone.title, state: milestone.state }
  const intents = intentLines(milestone.description ?? '')

  if (intents.length === 0) {
    if (json) printJson({ milestone: header, tranches: [] })
    else {
      process.stdout.write(`${header.title} (#${header.number}, ${header.state})\n`)
      process.stdout.write('no tranche intents declared\n')
    }
    return
  }

  const rows: Array<{ slug: string; lifecycle: string; issues: number; counts: StatusIssueCounts }> = []
  for (const intent of intents) {
    let issues: Awaited<ReturnType<typeof fetchTrancheIssuesAsync>>
    try {
      issues = await fetchTrancheIssuesAsync(owner, repo, intent.slug)
    } catch (e) {
      refuse([
        makeCheckError(
          'forge-fetch',
          `could not fetch tranche \`${intent.slug}\`'s Issues from the forge: ${ghErrorDetail(e)}`,
          `Check \`gh auth status\` and network, then re-run \`${RETRY_STATUS}\`.`
        )
      ])
    }
    let milestoneFacts: ReturnType<typeof findMilestoneForSlug>
    try {
      milestoneFacts = findMilestoneForSlug(owner, repo, intent.slug)
    } catch (e) {
      refuse([
        makeCheckError(
          'forge-fetch',
          `could not derive tranche \`${intent.slug}\`'s Milestone facts from the forge: ${ghErrorDetail(e)}`,
          `Check \`gh auth status\` and network, then re-run \`${RETRY_STATUS}\`.`
        )
      ])
    }
    const tranche = trancheFromIssues(intent.slug, issues, milestoneFacts)
    rows.push({
      slug: intent.slug,
      lifecycle: tranche.lifecycle,
      issues: issues.length,
      counts: tallyIssueCounts(issues)
    })
  }

  if (json) {
    printJson({ milestone: header, tranches: rows })
  } else {
    process.stdout.write(`${header.title} (#${header.number}, ${header.state})\n`)
    for (const row of rows) {
      process.stdout.write(`${row.slug} ${row.lifecycle} ${formatIssueCounts(row.issues, row.counts)}\n`)
    }
  }
}

import type { SurfaceExemption } from '../lib/surface-exemption'

export const SURFACE_EXEMPTIONS: Record<string, SurfaceExemption> = {
  'milestone create': { date: '2026-09-05', callsToday: 8, retiresVia: 'forgeWrite' },
  'milestone adopt': { date: '2026-09-05', callsToday: 4, retiresVia: 'forgeWrite' },
  'milestone edit': { date: '2026-09-05', callsToday: 7, retiresVia: 'forgeWrite' },
  'milestone close': { date: '2026-09-05', callsToday: 4, retiresVia: 'forgeWrite' },
  'milestone status': { date: '2026-09-10', callsToday: 4, retiresVia: 'forgeWrite' }
}
