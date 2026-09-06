/**
 * Shared machinery for the validated forge-write commands (`pr create/edit`,
 * `issue create/edit`). Two concerns live here:
 *
 *  1. **Same-bytes body plumbing** (`locateBody` / `resolveShippableArgs`) —
 *     adapted from `packages/aeg-core/bin/open-pr.ts`'s #333 fix, NEVER
 *     imported (those bins `process.chdir(REPO_ROOT)` and shell out to this
 *     repo's `bin/*` gate scripts; dragging them into a distributable CLI
 *     drags this repo's layout in). A stream/heredoc body is empty on a
 *     SECOND read by the time `gh` opens the original path, so the body is
 *     buffered ONCE, validated, then materialized into a fresh temp file whose
 *     path replaces the `--body-file` slot — `gh` reads the same bytes this
 *     process validated.
 *
 *  2. **The config-defined brief-schema validation runner**
 *     (`validateForgeWrite`) — pure over its inputs, built on `@attalabs/aeg-core`
 *     public exports, emitting the versioned `CheckError` contract instead of
 *     human text (the same move `src/checks/bin/check-brief-shape.ts` makes for
 *     the check runner). WHICH sections a body must carry comes from
 *     `vinaya.config.json`'s `briefSchema` key, never hardcoded here — this
 * repo's required-section set is just one config instance.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkAutonomyClause,
  checkBlastRadiusScope,
  checkBriefClosesN,
  checkDocUpdateList,
  checkForField,
  checkForgeTitle,
  checkIssueBriefSections,
  checkIssueObjectives,
  checkIssueRationale,
  checkMilestoneShape,
  checkNoBriefContent,
  checkPremiseCoverage,
  checkPrincipalPlaceholder,
  checkProjectField,
  checkRationaleNamesDocs,
  checkStopConditions,
  checkSurfaceMap,
  checkTestPlan,
  checkTestPlanExclusivity,
  checkTierField,
  checkWorktreeStep0,
  deriveBuiltinCrossCuttingDefaults,
  deriveWorkspacePackageDomains,
  findTrancheSlug,
  isBriefShaped,
  isPrincipal,
  isTaskBranch,
  isTaskIssueLabelSet,
  parsePnpmWorkspaceYaml,
  parseRegistry,
  type ProjectPath,
  readTierFromPrBody,
  trancheLabel
} from '@attalabs/aeg-core'
import { findMilestoneAttachTargetForSlug, hasExplicitMilestoneFlag } from '@attalabs/aeg-forge-state'
import { CHECK_SCHEMA_VERSION, type CheckError, emitCheckError } from '../checks/contract'
import {
  type BriefBuiltin,
  type BriefSection,
  VinayaConfigSchema,
  loadConfigChecked,
  loadTrustAnchorConfig,
  resolvePrincipalAllowlist
} from './config'
import { printJson } from './envelope'

// ---------------------------------------------------------------------------
// Arg errors — a malformed `--body-file` is a refusal in the CheckError shape,
// same as a failed brief-schema gate, so agents get one uniform contract.
// ---------------------------------------------------------------------------

/** A structural problem with the invocation itself (missing body path, etc.). */
export class ForgeArgError extends Error {}

// ---------------------------------------------------------------------------
// Same-bytes body plumbing (adapted from open-pr.ts / open-issue.ts, #333).
// ---------------------------------------------------------------------------

/** Where a validated body's bytes came from — a file/stream path, or an inline arg value. */
export type BodySource = { kind: 'file'; argIndex: number; inlineForm: boolean } | { kind: 'inline' }

export type BodyResult = {
  body: string
  source: BodySource
}

/**
 * Reads the body exactly once and records where it came from. `argIndex` +
 * `inlineForm` let `resolveShippableArgs` find and replace the same slot later
 * — the read here and the value shipped to `gh` must be the same buffered
 * string, not two independent reads of the same path (empty for a stream on
 * the second read). Returns null when no body flag is present.
 */
export function locateBody(args: string[]): BodyResult | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === '--body-file' || a === '-F') {
      const p = args[i + 1]
      if (!p) throw new ForgeArgError('`--body-file` was given with no path.')
      return { body: readFileSync(p, 'utf8'), source: { kind: 'file', argIndex: i + 1, inlineForm: false } }
    }
    if (a.startsWith('--body-file=')) {
      const p = a.slice('--body-file='.length)
      if (!p) throw new ForgeArgError('`--body-file=` was given with no path.')
      return { body: readFileSync(p, 'utf8'), source: { kind: 'file', argIndex: i, inlineForm: true } }
    }
    if (a === '--body' || a === '-b') {
      const v = args[i + 1]
      if (v === undefined) throw new ForgeArgError('`--body` was given with no value.')
      return { body: v, source: { kind: 'inline' } }
    }
    if (a.startsWith('--body=')) return { body: a.slice('--body='.length), source: { kind: 'inline' } }
  }
  return null
}

/**
 * Materializes an already-buffered body into a fresh temp file and rewrites
 * the `--body-file`/`-F` slot to point at it, so `gh`'s own read sees the SAME
 * bytes this process validated — never a second read of the original path.
 * Inline `--body`/`-b` args are untouched: no file, no second read, no risk.
 */
export function resolveShippableArgs(
  args: string[],
  bodyResult: BodyResult | null
): { finalArgs: string[]; cleanup: () => void } {
  if (bodyResult?.source.kind !== 'file') {
    return { finalArgs: args, cleanup: () => {} }
  }
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-forge-body-'))
  const tempPath = join(dir, 'body.md')
  writeFileSync(tempPath, bodyResult.body, 'utf8')
  const finalArgs = [...args]
  const { argIndex, inlineForm } = bodyResult.source
  finalArgs[argIndex] = inlineForm ? `--body-file=${tempPath}` : tempPath
  return { finalArgs, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Extracts `--title`/`-t` from the passthrough args, if present. */
export function extractTitle(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === '--title' || a === '-t') return args[i + 1] ?? null
    if (a.startsWith('--title=')) return a.slice('--title='.length)
  }
  return null
}

/** Collects every `--label`/`-l`/`--add-label` value (comma-split), like open-issue.ts. */
export function extractLabels(args: string[]): string[] {
  const labels: string[] = []
  const push = (v: string | undefined) => {
    if (v) for (const s of v.split(',').map((x) => x.trim())) if (s) labels.push(s)
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === '--label' || a === '-l' || a === '--add-label') push(args[i + 1])
    else if (a.startsWith('--label=')) push(a.slice('--label='.length))
    else if (a.startsWith('--add-label=')) push(a.slice('--add-label='.length))
  }
  return labels
}

// ---------------------------------------------------------------------------
// Refusal — the CheckError contract, one JSON line per finding on stderr.
// ---------------------------------------------------------------------------

/** Builds a well-formed `CheckError` with the current schema version. */
export function makeCheckError(check: string, message: string, agentRecoveryPrompt: string): CheckError {
  return {
    schema: CHECK_SCHEMA_VERSION,
    check,
    severity: 'error',
    message,
    agent_recovery_prompt: agentRecoveryPrompt
  }
}

/** Emits every finding as a JSON line on stderr, then exits 1. Nothing reached the forge. */
export function refuse(errors: CheckError[]): never {
  for (const e of errors) emitCheckError(e)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Tranche label — the real creation path the `vinaya/tranche:<slug>` prefix
// family lacked (Issue #54's Origin): its suffix is open-ended by design, so
// no fixed install-time list can seed it, and until now nothing created it
// either — cutting a tranche's first task Issue failed outright at `gh` with
// `not found`, worked around by hand-running `gh label create`. This is the
// point that mints it: `issueCreateCommand`/`issueEditCommand` are the
// shipped `vinaya issue create`/`edit` — the only commands that attach a
// `vinaya/tranche:*` label to a forge object. No `-R` flag: `gh` resolves
// the current repo from cwd, the adopter's own repo the CLI runs in.
// Existing labels are never modified, matching every create-if-absent label
// path in this repo.
// ---------------------------------------------------------------------------
const TRANCHE_LABEL_COLOR = '1D76DB'

export function ensureTrancheLabelExists(slug: string): void {
  const name = trancheLabel(slug)
  let existing: Array<{ name: string }>
  try {
    const out = execFileSync('gh', ['label', 'list', '--json', 'name', '--limit', '200'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    existing = JSON.parse(out) as Array<{ name: string }>
  } catch (err) {
    refuse([
      makeCheckError(
        'forge-fetch',
        `Could not list labels (\`gh label list\`) to check for '${name}': ${(err as Error).message}`,
        'Check `gh auth status` and network, then retry.'
      )
    ])
  }
  if (existing.some((l) => l.name === name)) return
  try {
    execFileSync('gh', ['label', 'create', name, '--color', TRANCHE_LABEL_COLOR, '--description', `Tranche: ${slug}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    refuse([
      makeCheckError(
        'forge-fetch',
        `Could not create tranche label '${name}' (\`gh label create\`): ${(err as Error).message}`,
        'Check `gh auth status`/repo write access, then retry.'
      )
    ])
  }
}

/**
 * `issue create`'s Milestone auto-attach: appends `--milestone <title>` to a
 * task Issue's argv when the tranche it declares has a matching OPEN
 * Milestone and the caller didn't already pass one. Never a hard refusal —
 * `findMilestoneAttachTargetForSlug` throwing (network/auth) or resolving
 * nothing degrades to "create without --milestone", identically to
 * `ensureTrancheLabelExists`'s label-write half being best-effort here: a
 * cosmetic GitHub-view attachment is never worth blocking the write for.
 * `labels` is the full label set already computed by the caller — not
 * re-derived — the same union of argv `--label`s and the ensured tranche
 * label `issueCreateCommand` already has in hand.
 */
export function resolveMilestoneAttachArgs(ghArgs: string[], labels: string[]): string[] {
  if (!isTaskIssueLabelSet(labels)) return ghArgs
  if (hasExplicitMilestoneFlag(ghArgs)) return ghArgs
  const slug = findTrancheSlug(labels)
  if (!slug) return ghArgs

  let target: ReturnType<typeof findMilestoneAttachTargetForSlug>
  try {
    target = findMilestoneAttachTargetForSlug('{owner}', '{repo}', slug)
  } catch {
    process.stderr.write(`vinaya: milestone lookup for '${slug}' failed (\`gh api\`) — creating without --milestone.\n`)
    return ghArgs
  }
  return target ? [...ghArgs, '--milestone', target.title] : ghArgs
}

/**
 * Resolves the config-defined required-section set for a command. Uses the
 * LOUD loader (`loadConfigChecked`): a malformed `vinaya.config.json` is a hard
 * refusal, never a silent `null` that would skip validation and let a broken
 * config print green over an unvalidated forge write. No config / no
 * `briefSchema` for this kind → an empty set (adopter-generic pass-through).
 *
 * `rings.ring1_forgeWriteInterception` is additive, never disabling: `false`
 * (or absent — every pre-existing `vinaya init` starter config reads `false`
 * here) is a no-op, leaving brief-schema validation running exactly as it
 * does today, unconditionally, for every existing adopter. `true` is the new
 * opt-in accelerator — the only value that changes behavior — and skips
 * brief-schema validation entirely by resolving to an empty section set.
 */
export function resolveSections(kind: 'pr' | 'issue' | 'milestone', retryCommand: string): BriefSection[] {
  const result = loadConfigChecked()
  if (!result.ok) {
    refuse([
      makeCheckError(
        'config',
        `${result.path}: invalid vinaya.config.json — ${result.error}`,
        `Fix the invalid key/value named above in ${result.path}, then re-run \`${retryCommand}\`.`
      )
    ])
  }
  if (result.config?.rings?.ring1_forgeWriteInterception === true) return []
  return result.config?.briefSchema?.[kind]?.sections ?? []
}

// ---------------------------------------------------------------------------
// The config-defined brief-schema validation runner.
// ---------------------------------------------------------------------------

export type ForgeValidationInput = {
  body: string
  /** The `--title` value, or null. When present it is grammar-checked (`checkForgeTitle`). */
  title: string | null
  /** The config-defined required-section set for this command (pr/issue). */
  sections: BriefSection[]
  /** The write's changed-file list — drives `premiseCoverage`. Empty for issues. */
  changedFiles: string[]
  /** The exact command the agent should re-run after fixing (named in every recovery prompt). */
  retryCommand: string
  /**
   * The branch this write lands on, when it can be resolved — the current
   * checkout for `pr create`, the PR's `headRefName` for `pr edit`.
   *
   * Present so this authoring-time gate applies the same branch grammar the
   * CI-time gate applies (`checks/bin/check-brief-shape.ts`). Without it a
   * standalone `fix/*` PR is refused here for a `Closes #N` its branch cannot
   * carry, while CI passes the identical body — the divergence
   * `aeg-root/enforcement.md` rules out: "one codebase, two enforcement
   * points, so the local gates and CI can never disagree".
   *
   * Omitted, empty, or the literal `HEAD` (git's detached-HEAD sentinel) all
   * mean "branch not resolvable", and the validation stays fail-closed: every
   * configured section is enforced. Issue writes never set it (an Issue has
   * no branch).
   *
   * Note this is deliberately STRICTER than the CI-time check on that one
   * axis: `check-brief-shape.ts` reads `BRANCH` from the environment and
   * drops `closesN` when it is unset, whereas an unresolvable branch here
   * enforces everything. Erring toward enforcement is the safe direction for
   * a prevention-layer gate, and it is what this change's own safety
   * argument rests on.
   */
  branch?: string
  /**
   * The target Issue's number, for the `objectives` builtin's
   * `OBJECTIVES_SINCE_ISSUE` cutover — `null` for `issue create` (no number
   * exists until the write completes) and unused by a `pr` write (the
   * builtin never appears in a `pr` section list). `checkIssueObjectives`
   * treats `null` as NOT exempted (fail-closed), the same posture
   * `partitionBriefErrorsByRollout` takes for an unparseable PR number.
   */
  issueNumber?: number | null
}

const CHECK_BRIEF_SCHEMA = 'brief-schema'
const CHECK_FORGE_TITLE = 'forge-title'

/**
 * Maps each built-in section name to the `@attalabs/aeg-core` validator that backs
 * it. The `Record<BriefBuiltin, …>` type makes this exhaustive — adding a name
 * to `BRIEF_BUILTINS` without wiring it here is a compile error.
 */
function runBuiltin(name: BriefBuiltin, input: ForgeValidationInput): string[] {
  const { body, changedFiles } = input
  const table: Record<BriefBuiltin, () => { errors: string[] }> = {
    tier: () => checkTierField(body, readTierFromPrBody),
    testPlan: () => checkTestPlan(body),
    testPlanExclusivity: () => checkTestPlanExclusivity(body),
    principalPlaceholder: () => checkPrincipalPlaceholder(body),
    surfaceMap: () => checkSurfaceMap(body),
    docUpdateList: () => checkDocUpdateList(body),
    worktreeStep0: () => checkWorktreeStep0(body),
    stopConditions: () => checkStopConditions(body),
    autonomyClause: () => checkAutonomyClause(body),
    project: () => checkProjectField(body),
    for: () => checkForField(body),
    closesN: () => checkBriefClosesN(body),
    premiseCoverage: () => checkPremiseCoverage(body, changedFiles),
    issueRationale: () => checkIssueRationale(body),
    objectives: () => checkIssueObjectives(body, input.issueNumber ?? null),
    briefSections: () => checkIssueBriefSections(body, input.issueNumber ?? null),
    milestoneShape: () => {
      const result = checkMilestoneShape(body)
      return { errors: result.status === 'fail' ? result.errors : [] }
    }
  }
  return table[name]().errors
}

/** The corrective instruction per built-in — the command to run, never a restatement of the diagnosis. */
const BUILTIN_RECOVERY: Record<BriefBuiltin, string> = {
  tier: 'Add a `Tier: 0`, `Tier: 1`, or `Tier: 3` field to the body header block (before the first `##` heading), then re-run `{cmd}`.',
  testPlan:
    'Add a Test Plan section with at least one `**[agent]**` or `**[principal]**` checklist item (or the `Test Plan: unit-tests-only` sentinel), then re-run `{cmd}`.',
  testPlanExclusivity:
    'Remove either the `Test Plan: unit-tests-only` sentinel or the tagged `- [ ]` checklist items — declare one form, not both — then re-run `{cmd}`.',
  principalPlaceholder:
    'Delete the `**[principal]**` "None" placeholder checklist item entirely (an untickable box blocks the merge gate forever), then re-run `{cmd}`.',
  surfaceMap: 'Add a `## Technical surface map` section listing the files this change touches, then re-run `{cmd}`.',
  docUpdateList: 'Add a `## Documentation-update list` section, then re-run `{cmd}`.',
  worktreeStep0: 'Add the `git worktree add …` Step 0 command to the body, then re-run `{cmd}`.',
  stopConditions: 'Add a `## Stop conditions` section, then re-run `{cmd}`.',
  autonomyClause:
    'Add the standing autonomy clause ("Do not stop to ask clarifying questions…") to the body, then re-run `{cmd}`.',
  project:
    'Add a `Project: <name>` field to the body header block (before the first `##` heading), then re-run `{cmd}`.',
  for: 'Add a `For: <model + environment>` field to the body header block (before the first `##` heading), then re-run `{cmd}`.',
  closesN: 'Add a `Closes #<N>` reference naming the task Issue to the body, then re-run `{cmd}`.',
  premiseCoverage: 'Add a `Premise:` assertion whose path matches a file this change touches, then re-run `{cmd}`.',
  issueRationale:
    'Add the missing Planner-rationale field named above (every task Issue carries all eight fields), then re-run `{cmd}`.',
  objectives:
    'Add a `## Objectives` section of numbered `O<n>. <sentence>` lines (one observable outcome each), then re-run `{cmd}`.',
  briefSections:
    'Add the missing `## Surface`/`## Parts`/`## Test plan`/`## Stop conditions` section(s) named above, well-formed per their own grammar, then re-run `{cmd}`.',
  milestoneShape:
    'Fix the Milestone description as named above — a goal, an optional well-formed `Release:` field, and an optional parseable `### Tranche intents` section — then re-run `{cmd}`.'
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The declarative (non-built-in) section forms an adopter authors for their own required sections. */
type CustomSection =
  | Extract<BriefSection, { heading: string }>
  | Extract<BriefSection, { field: string }>
  | Extract<BriefSection, { phrase: string }>

/** Evaluates a declarative custom-section matcher against the body. Returns a diagnosis or null (pass). */
function runCustomSection(section: CustomSection, body: string): string | null {
  if ('heading' in section) {
    const re = new RegExp(`^#{1,6}\\s+.*${escapeRegExp(section.heading)}`, 'im')
    if (re.test(body)) return null
    const name = section.name ?? section.heading
    return `brief-schema ${name}: no "${section.heading}" heading found in the body.`
  }
  if ('field' in section) {
    const re = new RegExp(`^(?:\\*\\*)?\\s*${escapeRegExp(section.field)}\\s*(?:\\*\\*)?\\s*:`, 'im')
    if (re.test(body)) return null
    const name = section.name ?? section.field
    return `brief-schema ${name}: no "${section.field}:" field found in the body.`
  }
  // phrase
  if (body.toLowerCase().includes(section.phrase.toLowerCase())) return null
  const name = section.name ?? section.phrase
  return `brief-schema ${name}: required phrase "${section.phrase}" not found in the body.`
}

/** Recovery instruction for a custom-section failure — names how to satisfy it and the command to re-run. */
function customRecovery(section: CustomSection, retryCommand: string): string {
  const cmd = `\`${retryCommand}\``
  if ('heading' in section) {
    return `Add a \`## ${section.heading}\` heading (with its section) to the body, then re-run ${cmd}.`
  }
  if ('field' in section) {
    return `Add a \`${section.field}: <value>\` field to the body, then re-run ${cmd}.`
  }
  return `Add the required phrase "${section.phrase}" to the body, then re-run ${cmd}.`
}

/**
 * Runs the full config-defined brief-schema validation over a body (+ optional
 * title). Pure: no `fs`, no `gh`, no `process`. Returns every finding as a
 * `CheckError`; an empty array means the write may proceed.
 */
export function validateForgeWrite(input: ForgeValidationInput): CheckError[] {
  const errors: CheckError[] = []

  if (input.title !== null) {
    const t = checkForgeTitle(input.title)
    if (t.status === 'fail') {
      for (const message of t.errors) {
        errors.push(
          makeCheckError(
            CHECK_FORGE_TITLE,
            message,
            `Rewrite the \`--title\` to match the forge-title grammar (\`Type: description\` / \`Type(scope): description\`, or \`[tranche] id — description\`), then re-run \`${input.retryCommand}\`.`
          )
        )
      }
    }
  }

  // The branch grammar. It matches `checks/bin/check-brief-shape.ts`'s on
  // every branch that check can see; the one deliberate difference is the
  // unresolvable case, where this side is STRICTER (see below). The title
  // check above stays outside the grammar, since title grammar binds on every
  // branch. An unresolvable branch keeps the pre-change fail-closed
  // behaviour: `branchKnown` false enforces every configured section.
  //
  // `HEAD` counts as unresolvable, not as a branch named "HEAD". Git prints
  // that literal for a detached HEAD (`rev-parse --abbrev-ref`), and reading
  // it as an ordinary non-task branch is a fail-OPEN: it would take the
  // relaxed path and, for a non-brief-shaped body, skip every section. Call
  // sites resolve via `symbolic-ref` so the sentinel should never arrive
  // here, but the guard is kept because the cost of a future call site
  // reintroducing it is a silently disabled gate. Lossless: git refuses to
  // create a branch named `HEAD`, so no real branch is swallowed.
  const rawBranch = input.branch ?? ''
  const branch = rawBranch === 'HEAD' ? '' : rawBranch
  const branchKnown = branch !== ''
  const taskBranch = isTaskBranch(branch)

  // A non-task branch whose body isn't brief-shaped has no brief to grade — an
  // ordinary one-line dependency-bump PR must not be forced to grow one.
  if (branchKnown && !taskBranch && !isBriefShaped(input.body)) {
    return errors
  }

  for (const section of input.sections) {
    // `Closes #N` names the task Issue a task branch closes; a standalone
    // `fix/*` PR has none, so requiring it there is unsatisfiable by
    // construction. Mirrors `requireClosesN: isTaskBranch(branch)`.
    if (branchKnown && !taskBranch && 'builtin' in section && section.builtin === 'closesN') {
      continue
    }
    if ('builtin' in section) {
      const recovery = BUILTIN_RECOVERY[section.builtin].replace('{cmd}', input.retryCommand)
      for (const message of runBuiltin(section.builtin, input)) {
        errors.push(makeCheckError(CHECK_BRIEF_SCHEMA, message, recovery))
      }
    } else {
      const message = runCustomSection(section, input.body)
      if (message !== null) {
        errors.push(makeCheckError(CHECK_BRIEF_SCHEMA, message, customRecovery(section, input.retryCommand)))
      }
    }
  }

  return errors
}

// ---------------------------------------------------------------------------
// Issue-only content gate — `checkBlastRadiusScope`, `checkNoBriefContent`,
// `checkRationaleNamesDocs` (`packages/aeg-core/bin/open-issue.ts`'s A/B/D
// block; C, `checkConflictCompleteness`, is warn-only and stays out of this
// gate). These three are NOT `briefSchema` sections and cannot live in
// `runBuiltin`'s table above: they grade what the rationale fields SAY
// against the surface the task touches, not whether a section is present —
// `checkNoBriefContent` in particular REFUSES brief-shaped content, the
// opposite of what every `runBuiltin` entry proves. Unconditional for a task
// Issue (`isTaskIssueLabelSet`), exactly like the presence gate one level up:
// config decides which sections are required, never whether this gate runs.
// ---------------------------------------------------------------------------

/** Array-form execFileSync — no shell, mirrors `pr.ts`'s own local `git()` helper. */
function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

/**
 * The adopter repo's git top-level, or `''` outside a git repo. Resolved at
 * call time (never this monorepo's own static `REPO_ROOT` the way
 * `open-issue.ts` does it) because `apps/cli` runs against whichever repo
 * invokes it — the same reason this file never imports the bin scripts (see
 * the file header). `''` propagates to a dormant, non-crashing result, same
 * posture as `checks/bin/check-coherence.ts`'s `readRegisteredProjectNames`.
 */
function repoRoot(): string {
  return git(['rev-parse', '--show-toplevel'])
}

function readWorkspaceGlobs(root: string): string[] {
  const fromPackageJson = (): string[] => {
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { workspaces?: unknown }
      return Array.isArray(pkg.workspaces) ? pkg.workspaces.filter((w): w is string => typeof w === 'string') : []
    } catch {
      return []
    }
  }
  const fromPnpmWorkspaceYaml = (): string[] => {
    try {
      return parsePnpmWorkspaceYaml(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'))
    } catch {
      return []
    }
  }
  return [...fromPackageJson(), ...fromPnpmWorkspaceYaml()]
}

function listWorkspaceChildDirs(dir: string, root: string): string[] {
  try {
    return readdirSync(join(root, dir), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

/**
 * `<root>/vinaya.config.json`'s `blastRadius.extraDomains` — read WITHOUT the
 * cwd-walking, global-fallback `loadConfig()`, same reason `doctor.ts`'s own
 * `readConfig(repoRoot)` avoids it: this must resolve `root`'s own file, never
 * an ancestor repo's config and never the adopter's machine-wide
 * `~/.vinaya/config.json`. `loadConfig()` here would silently fold an
 * unrelated global `blastRadius.extraDomains` into THIS repo's blast-radius
 * check — a false refusal on legitimate content.
 */
function readConfigExtraDomains(root: string): string[] {
  try {
    const parsed = VinayaConfigSchema.safeParse(JSON.parse(readFileSync(join(root, 'vinaya.config.json'), 'utf8')))
    return parsed.success ? (parsed.data.blastRadius?.extraDomains ?? []) : []
  } catch {
    return []
  }
}

/**
 * The full collision-domain list `checkBlastRadiusScope` consumes: live
 * workspace derivation + built-in cross-cutting defaults +
 * `vinaya.config.json`'s `blastRadius.extraDomains`. No knowledge of the
 * legacy `.aeg/packages` file — retired here AND in `open-issue.ts`'s own
 * `readSharedPackages`, in the same wave, zero backward compatibility on
 * either side (Principal decision: no real adopter depends on it, and it's
 * being removed from attalabs, the one real consumer, at the same time).
 * Mirrors `open-issue.ts`'s own `readSharedPackages` otherwise (`apps/cli`
 * cannot import that bin file — see this file's header — so this is the
 * adopter-runtime equivalent, built from the same public
 * `@attalabs/aeg-core` primitives that function itself uses). A fresh
 * adopter with none of the optional inputs still gets the live-derived +
 * built-in-default set; outside a git repo this returns `[]` and the check
 * goes dormant, never crashes.
 */
export function readSharedPackages(root: string = repoRoot()): string[] {
  if (!root) return []
  const derived = deriveWorkspacePackageDomains(readWorkspaceGlobs(root), (dir) => listWorkspaceChildDirs(dir, root))
  const defaults = deriveBuiltinCrossCuttingDefaults((p) => existsSync(join(root, p)))
  const configExtra = readConfigExtraDomains(root)
  return [...new Set([...derived, ...defaults, ...configExtra])]
}

/** Registry rows (`.vinaya/projects.md`) — absent ⇒ nothing is owned, the check goes dormant. */
export function readProjectPaths(root: string = repoRoot()): ProjectPath[] {
  if (!root) return []
  try {
    return parseRegistry(readFileSync(join(root, '.vinaya/projects.md'), 'utf8'))
  } catch {
    return []
  }
}

const CHECK_ISSUE_CONTENT = 'issue-content'

const ISSUE_CONTENT_RECOVERY = {
  blastRadius:
    'Add a second registered `Project(s)` this task also touches, or a `blast-radius-ack: <why one lens is enough>` line, then re-run `{cmd}`.',
  noBriefContent:
    "Move the brief-shaped section named above out of the Issue body and into the brief — the Issue carries the Planner's durable rationale, not the brief's just-in-time surface — then re-run `{cmd}`.",
  rationaleNamesDocs:
    'Name a concrete doc/skill path (e.g. `aeg-root/…`, `.claude/skills/…/SKILL.md`) in "Docs to keep coherent" or "Traps", or write the `no-doc-surface` sentinel if the surface genuinely has none, then re-run `{cmd}`.'
} as const

export type IssueContentInput = {
  body: string
  labels: string[]
  sharedPackages: string[]
  projectPaths: ProjectPath[]
  retryCommand: string
}

/**
 * Runs the three Issue-only content checks and returns every finding as a
 * `CheckError`. Pure over its inputs, same discipline as `validateForgeWrite`
 * — the caller (a command file) resolves `sharedPackages`/`projectPaths` from
 * disk/forge and passes them in.
 */
export function validateIssueContent(input: IssueContentInput): CheckError[] {
  const findings: Array<[string[], keyof typeof ISSUE_CONTENT_RECOVERY]> = [
    [checkBlastRadiusScope(input.body, input.labels, input.sharedPackages, input.projectPaths).errors, 'blastRadius'],
    [checkNoBriefContent(input.body).errors, 'noBriefContent'],
    [checkRationaleNamesDocs(input.body).errors, 'rationaleNamesDocs']
  ]
  const errors: CheckError[] = []
  for (const [messages, kind] of findings) {
    const recovery = ISSUE_CONTENT_RECOVERY[kind].replace('{cmd}', input.retryCommand)
    for (const message of messages) errors.push(makeCheckError(CHECK_ISSUE_CONTENT, message, recovery))
  }
  return errors
}

// ---------------------------------------------------------------------------
// The validated `issue edit` write path (task 3, #413) — extracted verbatim
// out of `commands/issue.ts` so a second command (`issue objectives edit`)
// can drive the same validated write without importing another command file
// (`commands/*.ts` never imports `commands/*.ts` — shared logic lives here).
// `issueEditCommand` itself now calls `writeValidatedIssueEdit`; behaviour is
// unchanged, its tests stay green.
// ---------------------------------------------------------------------------

/**
 * Runs the `gh` write. `quiet` (default `false`) skips the stdout/JSON print
 * of the URL `gh` returns — for a caller that goes on to print its OWN,
 * more specific URL (`issue objectives edit` prints its comment's url, never
 * the plain issue-edit url the underlying write also produces).
 */
export function runGhWrite(
  ghCmd: string[],
  ghArgs: string[],
  bodyResult: BodyResult | null,
  json: boolean,
  quiet = false
): void {
  const { finalArgs, cleanup } = resolveShippableArgs(ghArgs, bodyResult)
  try {
    const out = execFileSync('gh', [...ghCmd, ...finalArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
    if (quiet) return
    const url = out.trim()
    if (json) printJson({ validated: true, written: true, url })
    else if (url) process.stdout.write(`${url}\n`)
  } finally {
    cleanup()
  }
}

/**
 * Fetches the target Issue's actual current labels from the forge. `edit`
 * invocations don't re-pass `--label`, so argv says nothing about whether the
 * target is a task Issue — the forge is the only truthful source (#417). A
 * failed fetch is a HARD refusal, never treated as "no tranche label".
 */
export function fetchForgeLabels(issueRef: string, retryCommand: string): string[] {
  let out: string
  try {
    out = execFileSync('gh', ['issue', 'view', issueRef, '--json', 'labels'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch {
    refuse([
      makeCheckError(
        'forge-fetch',
        `Could not fetch Issue ${issueRef}'s labels from the forge (\`gh issue view\`) — the rationale gate cannot decide whether it applies.`,
        `Check \`gh auth status\` and network, then re-run \`${retryCommand}\`. The edit is refused rather than passed through unvalidated.`
      )
    ])
  }
  try {
    return (JSON.parse(out) as { labels: Array<{ name: string }> }).labels.map((l) => l.name)
  } catch {
    refuse([
      makeCheckError(
        'forge-fetch',
        `Could not parse \`gh issue view ${issueRef} --json labels\` output.`,
        `Re-run \`${retryCommand}\`; the edit is refused rather than passed through unvalidated.`
      )
    ])
  }
}

/**
 * The Issue number `issue edit`'s target ref names, for `checkIssueObjectives`'s
 * `OBJECTIVES_SINCE_ISSUE` cutover. `edit` targets a REAL, already-existing
 * Issue, so unlike `create`'s genuinely-unknown-until-write number, `null`
 * here means only "this ref's shape carried no digits" — the Issue itself
 * has a number regardless of how the caller spelled the ref. Parses the
 * TRAILING digits so both a bare `123` and a URL (`.../issues/123`) resolve
 * to the real number; only a ref with no digits at all (should never happen
 * in practice — `fetchForgeLabels` already resolved this same ref against
 * the forge before this is called) falls through to `null`, and even then
 * `checkIssueObjectives` treats that fail-closed, never as license to skip.
 */
export function parseIssueNumberFromRef(ref: string): number | null {
  const m = /(\d+)\s*$/.exec(ref.trim())
  return m ? Number.parseInt(m[1] as string, 10) : null
}

/**
 * Runs the task-Issue brief-schema gate for a body whose applicability was
 * already decided from the labels. Non-task Issues never reach here — they
 * pass through unvalidated, exactly like `open-issue.ts`.
 *
 * Two stages, same order as `open-issue.ts`: the config-driven presence gate
 * (rationale fields exist, etc.) refuses first with its own findings; only
 * once it passes does the unconditional content gate (blast-radius scope,
 * no-brief-content, rationale-names-docs) run. `labels` feeds
 * `checkBlastRadiusScope`; `sharedPackages`/`projectPaths` are resolved from
 * the adopter repo on disk, not threaded through from argv.
 */
export function validateTaskIssue(
  body: string | null,
  title: string | null,
  labels: string[],
  retryCommand: string,
  issueNumber: number | null
): void {
  if (body === null) {
    refuse([
      makeCheckError(
        'forge-args',
        'A task Issue (a `vinaya/tranche:*` label) requires a `--body-file <path>` so the rationale gate can validate it.',
        `Add \`--body-file <path>\`, then re-run \`${retryCommand}\`.`
      )
    ])
  }
  const sections = resolveSections('issue', retryCommand)
  const schemaErrors = validateForgeWrite({
    body,
    title,
    sections,
    changedFiles: [],
    retryCommand,
    issueNumber
  })
  if (schemaErrors.length > 0) refuse(schemaErrors)

  const contentErrors = validateIssueContent({
    body,
    labels,
    sharedPackages: readSharedPackages(),
    projectPaths: readProjectPaths(),
    retryCommand
  })
  if (contentErrors.length > 0) refuse(contentErrors)
}

/**
 * The validate-then-write core `issueEditCommand` runs for every non-
 * `--validate-only` edit: union the forge's real labels with argv, run
 * `validateTaskIssue` when the target is a task Issue, ensure the tranche
 * label exists, then write. `issue objectives edit` (task 3) drives this
 * same path with a temp `--body-file` it wrote itself — one validated write
 * path for every Issue-edit caller, never a second hand-rolled one.
 */
export function writeValidatedIssueEdit(input: {
  issueRef: string
  ghArgs: string[]
  bodyResult: BodyResult | null
  json: boolean
  retryCommand: string
  quiet?: boolean
}): void {
  const { issueRef, ghArgs, bodyResult, json, retryCommand, quiet } = input
  const body = bodyResult?.body ?? null
  const title = extractTitle(ghArgs)

  // Union the forge's real labels with any passed on argv — argv is normally
  // silent on edit, so the forge is what decides task-Issue applicability.
  const labels = [...new Set([...fetchForgeLabels(issueRef, retryCommand), ...extractLabels(ghArgs)])]

  if (isTaskIssueLabelSet(labels)) {
    validateTaskIssue(body, title, labels, retryCommand, parseIssueNumberFromRef(issueRef))
  }

  const slugToEnsure = findTrancheSlug(labels)
  if (slugToEnsure) ensureTrancheLabelExists(slugToEnsure)

  runGhWrite(['issue', 'edit', issueRef], ghArgs, bodyResult, json, quiet ?? false)
}

// ---------------------------------------------------------------------------
// Principal-only gate — `issue objectives edit` and `pr rule` (task 3) are
// Principal-only actions per `aeg-root/roles/principal.md`, but `gh`
// authenticates as "whoever is logged in": without this, any collaborator's
// (or co-resident agent session's) token can post a comment indistinguishable
// from a genuine Principal ruling, or silently rewrite a task's Objectives —
// zero gate (security review, PR #430, CRITICAL). `isPrincipal` itself is
// pre-existing (`review-status.ts`/`review-gate.ts` etc. already use it to
// classify the AUTHOR of an existing comment); what was missing is checking
// it against the CURRENT actor before a Principal-only write, which is what
// this gate adds. Reads `principals` from the DEFAULT branch
// (`loadTrustAnchorConfig`) — never a task branch's own `vinaya.config.json`,
// which the actor being checked could otherwise edit to add themselves.
// ---------------------------------------------------------------------------

/** The login `gh` is currently authenticated as, or `null` if it cannot be resolved. */
export function currentGhLogin(): string | null {
  try {
    const out = execFileSync('gh', ['api', 'user', '-q', '.login'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
    return out || null
  } catch {
    return null
  }
}

/**
 * Refuses unless the identity `gh` is authenticated as resolves to an
 * allowlisted principal. An unresolvable identity refuses the same as a
 * disallowed one — fail-closed, never "no identity found, so let it through".
 */
export function refuseUnlessPrincipal(retryCommand: string): void {
  const login = currentGhLogin()
  const allowlist = resolvePrincipalAllowlist(loadTrustAnchorConfig())
  if (login !== null && isPrincipal(login, allowlist)) return
  refuse([
    makeCheckError(
      'principal-only',
      login === null
        ? 'Could not resolve the identity `gh` is authenticated as — this command is Principal-only and refuses rather than proceeding with an unverified actor.'
        : `\`${login}\` is not on the Principal allowlist — this command is Principal-only.`,
      `Authenticate \`gh\` as an allowlisted principal, then re-run \`${retryCommand}\`.`
    )
  ])
}

// ---------------------------------------------------------------------------
// Marked comments — the `<!-- aeg:… -->`-prefixed comment shape `pr.ts`'s
// `postBriefComment` established for the brief comment, generalised so
// `issue objectives edit` and `pr rule` (task 3) can post their own marked
// comments without duplicating the temp-file-then-`gh comment` dance.
// ---------------------------------------------------------------------------

/** How many of `bodies` open with `prefix` — the marker-numbering scheme every marked-comment poster uses (`k = count + 1`). Counted on the forge at post time, never derived from a local file. */
export function countMarkerComments(bodies: string[], prefix: string): number {
  return bodies.filter((b) => b.startsWith(prefix)).length
}

/**
 * Posts `body`, prefixed with `marker` on its own first line, as a comment on
 * an Issue or PR — the same buffered-temp-file shape `pr.ts`'s
 * `postBriefComment` uses, generalised over `kind`. Returns the URL `gh`
 * printed. A failed post is a hard refusal: nothing durable was recorded.
 */
export function postMarkedComment(kind: 'issue' | 'pr', ref: string, marker: string, body: string): string {
  const commentBody = `${marker}\n${body}\n`
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-marked-comment-'))
  const tmp = join(dir, 'comment.md')
  writeFileSync(tmp, commentBody, 'utf8')
  try {
    const out = execFileSync('gh', [kind, 'comment', ref, '--body-file', tmp], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return out.trim()
  } catch (err) {
    refuse([
      makeCheckError(
        'forge-comment',
        `Could not post comment on ${kind} ${ref} (\`gh ${kind} comment\`): ${err instanceof Error ? err.message : String(err)}`,
        'Check `gh auth status` and network, then retry.'
      )
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
