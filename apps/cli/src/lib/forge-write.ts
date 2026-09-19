/**
 * Shared machinery for the validated forge-write commands (`pr create/edit`,
 * `issue create/edit`). Two concerns live here:
 *
 *  1. **Same-bytes body plumbing** (`locateBody` / `resolveShippableArgs`) —
 *     adapted from `packages/aeg-core/bin/open-pr.ts`'s own fix, NEVER
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
  checkBriefSections,
  checkDocsWithinSurface,
  checkDocUpdateList,
  checkForField,
  checkForgeTitle,
  checkIssueBriefSections,
  checkIssueObjectives,
  checkIssueRationale,
  checkMilestoneShape,
  checkNoBriefContent,
  checkNoForeignTaskOwnership,
  checkObjectivesRespectBoundary,
  checkPartsCiteDefinedObjectives,
  checkPartsCoverageAndSequence,
  checkPremiseCoverage,
  checkPrincipalPlaceholder,
  checkProjectField,
  checkRationaleNamesDocs,
  checkRationaleSurfaceCoverage,
  checkStopConditions,
  checkSurfaceExcludesBoundDoc,
  checkSurfaceGlobsResolve,
  checkSurfaceMap,
  checkSurfaceOverlap,
  checkTestPlan,
  checkTestPlanExclusivity,
  checkTierField,
  checkTrancheLabelPresence,
  checkWorktreeStep0,
  deriveBuiltinCrossCuttingDefaults,
  deriveWorkspacePackageDomains,
  type DispatchBlockerClass,
  DOC_OWNERS_PATH,
  findTrancheSlug,
  type FrozenBriefCandidate,
  frozenSectionsChanged,
  isBriefShaped,
  isPrincipal,
  isTaskBranch,
  isTaskIssueBodyShaped,
  isTaskIssueLabelSet,
  parseIssueSurface,
  parsePnpmWorkspaceYaml,
  parseRegistry,
  type ProjectPath,
  readTierFromPrBody,
  resolveNewestFrozenBrief,
  type TaskSurfaceFacts,
  trancheLabel
} from '@attalabs/aeg-core'
import {
  assembleAndRenderBrief,
  assembleAndRenderBriefForIssue,
  type AssembleAndRenderBriefResult,
  buildWorkspaceConsumersOf,
  canRenderBriefFromHere,
  DRAFT_ISSUE_SENTINEL,
  expandGlob,
  resolveTrancheTaskId
} from './brief-assembly'
import {
  findMilestoneAttachTargetForSlug,
  hasExplicitMilestoneFlag,
  parseRationaleDeps,
  resolveMilestoneAttachTarget
} from '@attalabs/aeg-forge-state'
import { coreCheckRegistry } from '../checks/registry'
import { resolveChecks } from '../checks/resolver'
import { defaultParallelism, runChecks } from '../checks/runner'
import { CHECK_SCHEMA_VERSION, type CheckError, type CheckSpec, emitCheckError } from '../checks/contract'
import {
  type BriefBuiltin,
  type BriefSection,
  VinayaConfigSchema,
  loadConfigChecked,
  loadTrustAnchorConfig,
  resolvePrincipalAllowlist
} from './config'
import { printJson } from './envelope'
import type { EffectIdentity, EffectReconcileResult } from './effects.js'
import { sha256Hex } from './effects.js'

// ---------------------------------------------------------------------------
// Arg errors — a malformed `--body-file` is a refusal in the CheckError shape,
// same as a failed brief-schema gate, so agents get one uniform contract.
// ---------------------------------------------------------------------------

/** A structural problem with the invocation itself (missing body path, etc.). */
export class ForgeArgError extends Error {}

// ---------------------------------------------------------------------------
// Same-bytes body plumbing (adapted from open-pr.ts / open-issue.ts).
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

/** Builds a well-formed `CheckError` with the current schema version. `severity` defaults to `'error'` — the one shape every existing call site already produced; a caller naming an informational finding (O2, `packages/aeg-core/src/dispatch-gate.ts`'s `depends-on-not-merged`/`conflicts-with` classes, folded by `validateRenderedBriefForIssue`) passes `'warning'` explicitly. */
export function makeCheckError(
  check: string,
  message: string,
  agentRecoveryPrompt: string,
  severity: CheckError['severity'] = 'error'
): CheckError {
  return {
    schema: CHECK_SCHEMA_VERSION,
    check,
    severity,
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
// family lacked: its suffix is open-ended by design, so
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

const CHECK_ISSUE_LABEL = 'issue-label'

/**
 * **Retired.** Used to refuse a task-shaped body
 * with no `vinaya/tranche:*` label — that invariant no longer holds: a task-
 * shaped, unlabeled body is now the exact shape of a legitimate backlog
 * Issue (see `checkTrancheLabelPresence`'s own doc comment, `@attalabs/aeg-core`,
 * for the full rationale). Delegates to that now-always-pass rule rather
 * than being deleted outright, so every call site stays wired to the one
 * shared predicate instead of independently re-deriving "never refuses"
 * three times over. `validateTaskIssue`'s own gate (below) is what changed
 * to actually run validation for an unlabeled-but-task-shaped body, closing
 * the hole this function used to guard from the other side.
 */
export function refuseUnlabeledTaskShapedBody(body: string | null, labels: string[], retryCommand: string): void {
  if (body === null) return
  const result = checkTrancheLabelPresence(body, labels)
  if (result.status === 'pass') return
  refuse([
    makeCheckError(
      CHECK_ISSUE_LABEL,
      result.errors.join(' '),
      `Add a \`vinaya/tranche:<slug>\` label (e.g. \`--label vinaya/tranche:<slug>\`), then re-run \`${retryCommand}\`.`
    )
  ])
}

/**
 * Resolves the config-defined required-section set for a command. Uses the
 * LOUD loader (`loadConfigChecked`): a malformed `vinaya.config.json` is a hard
 * refusal, never a silent `null` that would skip validation and let a broken
 * config print green over an unvalidated forge write. No config / no
 * `briefSchema` for this kind → an empty set (adopter-generic pass-through).
 *
 * `rings.ring1_forgeWriteInterception` means what it says: `true` (the
 * default — an absent key resolves the same way) RUNS forge-write
 * interception, so brief-schema validation runs exactly as it always has.
 * `false` is the opt-OUT — the only value that changes behavior — and skips
 * brief-schema validation entirely by resolving to an empty section set.
 * (Prior to issue-545/O2 this boolean's sense was inverted; `vinaya upgrade`
 * migrates a config still holding the old values.)
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
  if (result.config?.rings?.ring1_forgeWriteInterception === false) return []
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
 * O2 — every recovery prompt this file emits quotes the specific finding it
 * refuses (the underlying check's own message already names the offending
 * line/field, e.g. `checkForgeTitle`'s `"<bad title>" matches neither…`),
 * THEN states the edit that clears it. A prompt built only from a per-check
 * static template restates the rule; prefixing the quoted message makes every
 * prompt name its own fix rather than its rule, per-instance, not per-check-kind.
 */
function nameTheFix(message: string, fixInstruction: string): string {
  return `Refused for: \`${message}\` — ${fixInstruction}`
}

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
    'Add the missing `## Surface`/`## Parts`/`## Test plan`/`## Stop conditions`/`## Documentation` section(s) named above, well-formed per their own grammar (`## Documentation` accepts an explicit `None` line when no normative source governs this task; otherwise at least one source must cite a real `## Objectives` id via a trailing `(O<n>)`), then re-run `{cmd}`.',
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
            nameTheFix(
              message,
              `Rewrite \`--title\` (currently \`${input.title}\`) to match the forge-title grammar (\`Type: description\` / \`Type(scope): description\`, or \`[tranche] id — description\`), then re-run \`${input.retryCommand}\`.`
            )
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
      const instruction = BUILTIN_RECOVERY[section.builtin].replace('{cmd}', input.retryCommand)
      for (const message of runBuiltin(section.builtin, input)) {
        errors.push(makeCheckError(CHECK_BRIEF_SCHEMA, message, nameTheFix(message, instruction)))
      }
    } else {
      const message = runCustomSection(section, input.body)
      if (message !== null) {
        errors.push(
          makeCheckError(CHECK_BRIEF_SCHEMA, message, nameTheFix(message, customRecovery(section, input.retryCommand)))
        )
      }
    }
  }

  return errors
}

// ---------------------------------------------------------------------------
// O1/O2 — the ONE registry-runner call every forge-write path
// shares. `resolvedRegistry()` merges the core registry with whatever an
// adopter's own `vinaya.config.json` adds (`resolveChecks`, the same merge
// `commands/check.ts`/`commands/doctor.ts` already apply) — a config-
// registered check declaring `validates: 'body'`/`'issue'` is enforced here
// exactly like a core one, same discipline as every other `CheckSpec` field.
// ---------------------------------------------------------------------------

function resolvedRegistry(): CheckSpec[] {
  const result = loadConfigChecked()
  const configChecks = result.ok ? result.config?.checks : undefined
  return resolveChecks(coreCheckRegistry(), configChecks).resolved.map((rc) => rc.spec)
}

/**
 * Runs every registered check whose `validates` is `'body'` over the exact
 * bytes about to reach the forge — the SAME `runChecks` entry point
 * `vinaya check <name>`/`--all` spawns, so a body this refuses is, by
 * construction, a body CI's `vinaya-checks.yml`/`vinaya-body-checks.yml`
 * would also refuse, and a check registered `validates: 'body'` LATER is
 * enforced here with zero further wiring.
 *
 * `prNumber` distinguishes the two shapes every body write actually has:
 * `undefined` (no PR exists yet — `pr create`, before the write) sets
 * `localOnly: true`, which skips every `requiresOpenPr` check outright
 * (`closes-n`, `test-plan`, `body-bare-digits`, `token-report`,
 * `evidence-fresh` all take their own documented "no PR yet" bypass when
 * actually run — skipping here is cheaper and matches the pre-commit/
 * pre-push hooks' own `--local` posture); a real number (`pr edit`, `pr
 * report --push`, both against an already-open PR) runs the full set,
 * `PR_NUMBER` forwarded so a `requiresOpenPr` check resolves the REAL PR
 * rather than taking its no-PR bypass against one that already exists.
 *
 * Skipped entirely when `rings.ring1_forgeWriteInterception` is `false` —
 * the same opt-out `resolveSections` already honors to skip
 * `validateForgeWrite`'s config-driven sections; that value's whole point is
 * "skip brief-schema validation entirely," and running this pass
 * unconditionally underneath it would silently reintroduce exactly the
 * validation the opt-out was set to remove.
 *
 * A `principalOwed` check whose every reported error is `pending: true` is
 * excluded from the refusal decision, matching `isRunFailed`'s (`commands/
 * check.ts`) own rule exactly: `test-plan`'s unticked-`[principal]` wait
 * state is enforcement `review-gate` already owns at merge, not a reason to
 * stop a body write mid-round. A structural failure on the same check — no
 * `## Test Plan` section (no `pending` errors at all), or a mix of pending
 * and non-pending errors — still refuses, because that half the Developer
 * can actually fix.
 *
 * Refuses (never returns) on any other finding — same contract as
 * `refuse()` itself, which this calls.
 */
export async function runBodyChecks(
  body: string,
  branch: string,
  prNumber: number | undefined,
  retryCommand: string
): Promise<void> {
  const errors = await collectBodyCheckErrors(body, branch, prNumber)
  if (errors.length === 0) return
  refuse(
    errors.map((e) =>
      makeCheckError(e.check, e.message, `${e.agent_recovery_prompt} Fix the body, then re-run \`${retryCommand}\`.`)
    )
  )
}

/**
 * The non-refusing half of `runBodyChecks` above — runs the exact same
 * `validates: 'body'` registry over `body` and returns the aggregated
 * findings as an ordinary array (empty on pass) instead of calling
 * `refuse()`. Same `ring1_forgeWriteInterception` opt-out, same
 * `localOnly`/`PR_NUMBER` handling, same `principalOwed`/`pending`
 * exclusion as `runBodyChecks` — the two must never drift apart, which is
 * why `runBodyChecks` now delegates to this rather than duplicating the
 * logic. Exists for a caller that needs the findings without the process
 * ever being able to exit underneath it (`pr-report-engine.ts`'s
 * `bodyCheckRefusalMessage`, called from the developer-review loop's own
 * long-lived driver, where `refuse()`'s `process.exit(1)` would kill the
 * whole driver instead of just this one write, round 3 review MAJOR/HIGH).
 */
export async function collectBodyCheckErrors(
  body: string,
  branch: string,
  prNumber: number | undefined
): Promise<CheckError[]> {
  const config = loadConfigChecked()
  if (config.ok && config.config?.rings?.ring1_forgeWriteInterception === false) return []

  const specs = resolvedRegistry().filter((s) => s.validates === 'body')
  if (specs.length === 0) return []

  const callerEnv: NodeJS.ProcessEnv = { ...process.env, PR_BODY: body, BRANCH: branch }
  if (prNumber === undefined) delete callerEnv.PR_NUMBER
  else callerEnv.PR_NUMBER = String(prNumber)

  const outcomes = await runChecks(specs, {
    parallel: defaultParallelism(),
    diffOnly: false,
    changedFiles: null,
    defaultTimeoutMs: 30_000,
    callerEnv,
    localOnly: prNumber === undefined
  })

  return outcomes
    .filter((o) => o.status === 'fail' || o.status === 'error')
    .flatMap((o) => {
      const spec = specs.find((s) => s.name === o.name)
      if (spec?.principalOwed && o.errors.length > 0 && o.errors.every((e) => e.pending === true)) return []
      return o.errors
    })
}

/**
 * Runs every registered check whose `validates` is `'issue'` over a task
 * Issue's own content — title grammar, Objectives numbering, Parts coverage,
 * Surface glob resolution, tranche-label presence, Milestone attach.
 * These never apply to a pull request (a PR body has no Milestone, no
 * `## Objectives` numbering of its own to grade), so they run ONLY from an
 * Issue write path and from the coherence sweep over open Issues
 * (`packages/aeg-core/bin/verify-coherence.ts`) — never selected into a
 * pull-request workflow, matching every `validates: 'issue'` entry's
 * `ownWorkflow: true` declaration.
 *
 * Every fact these checks need is precomputed and injected by the caller as
 * an env var (`ISSUE_*`) — mirroring `brief-shape`'s own PR_BODY/BRANCH/
 * PR_NUMBER shape — rather than having each bin re-fetch the same forge
 * state the caller already fetched for its OWN gates.
 *
 * **O1 — returns findings, never refuses.** Used to call `refuse()` directly
 * on any finding; `collectTaskIssueErrors` needs this group's findings
 * returned instead, so they fold into the same union every other group
 * contributes to, refused once by the caller.
 */
export async function runIssueChecks(input: {
  body: string
  labels: string[]
  title: string | null
  issueNumber: number | null
  currentMilestoneTitle: string | null
  resolvedMilestoneTitle: string | null
  retryCommand: string
}): Promise<CheckError[]> {
  const specs = resolvedRegistry().filter((s) => s.validates === 'issue')
  if (specs.length === 0) return []

  const callerEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ISSUE_BODY: input.body,
    ISSUE_LABELS: input.labels.join(','),
    ISSUE_TITLE: input.title ?? '',
    ISSUE_NUMBER: input.issueNumber !== null ? String(input.issueNumber) : '',
    CURRENT_MILESTONE_TITLE: input.currentMilestoneTitle ?? '',
    RESOLVED_MILESTONE_TITLE: input.resolvedMilestoneTitle ?? ''
  }

  const outcomes = await runChecks(specs, {
    parallel: defaultParallelism(),
    diffOnly: false,
    changedFiles: null,
    defaultTimeoutMs: 30_000,
    callerEnv
  })

  const errors = outcomes.filter((o) => o.status === 'fail' || o.status === 'error').flatMap((o) => o.errors)
  return errors.map((e) =>
    makeCheckError(
      e.check,
      e.message,
      `${e.agent_recovery_prompt} Fix the Issue body, then re-run \`${input.retryCommand}\`.`
    )
  )
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

/**
 * `.vinaya/doc-owners`, read the same way `doc-coverage` reads it — a tree
 * file, never the forge — for `checkSurfaceExcludesBoundDoc`. Absent ⇒
 * `null`, the same dormancy value `evaluateC5`'s own caller passes.
 */
export function readDocOwnersContent(root: string = repoRoot()): string | null {
  if (!root) return null
  try {
    return readFileSync(join(root, DOC_OWNERS_PATH), 'utf8')
  } catch {
    return null
  }
}

const CHECK_ISSUE_CONTENT = 'issue-content'

const ISSUE_CONTENT_RECOVERY = {
  blastRadius:
    'Add a second registered `Project(s)` this task also touches, or a `blast-radius-ack: <why one lens is enough>` line, then re-run `{cmd}`.',
  noBriefContent:
    "Move the brief-shaped section named above out of the Issue body and into the brief — the Issue carries the Planner's durable rationale, not the brief's just-in-time surface — then re-run `{cmd}`.",
  rationaleNamesDocs:
    'Name a concrete doc/skill path (e.g. `aeg-root/…`, `.claude/skills/…/SKILL.md`) in "Docs to keep coherent" or "Traps", or write the `no-doc-surface` sentinel if the surface genuinely has none, then re-run `{cmd}`.',
  surfaceGlobsResolve:
    'Fix the named `## Surface` `in:` glob so it matches at least one real tracked file (a typo, or a directory that does not exist yet), then re-run `{cmd}`.',
  partsCiteObjectives:
    'Fix the named Part to cite an objective id the `## Objectives` section actually defines, or add the missing objective, then re-run `{cmd}`.',
  docsWithinSurface:
    'Move the named doc pointer to a path `## Surface`\'s `in:` globs actually cover (never widen the surface just to fit the pointer — that renders an unusable brief), or drop it from "Docs to keep coherent" if this task does not really keep it coherent, then re-run `{cmd}`.',
  surfaceExcludesBoundDoc:
    'Either move the named `out:` glob so it no longer covers the bound document, or narrow the `in:` glob so it no longer reaches the doc-owners binding — the Issue cannot declare both at once. Then re-run `{cmd}`.',
  rationaleSurfaceCoverage:
    'Widen the named `## Surface` `in:` glob to cover the Boundary path (nearest entry named above), or correct the path if it was mistyped, then re-run `{cmd}`.',
  surfaceOverlap:
    'Narrow the named `## Surface` `in:` glob so it no longer overlaps the other task, or declare a `Conflicts-with` entry naming one task in the other (either direction is enough), then re-run `{cmd}`.',
  objectivesRespectBoundary:
    "Drop or rewrite the named Objective/Part/Test plan line so it no longer names a path the Boundary's `Out:` clause or the Surface's `out:` list excludes — this task cannot both exclude and require that path. Then re-run `{cmd}`.",
  noForeignTaskOwnership:
    "Rewrite the named sentence so it does not assign ownership of this task's own objective to another task — depend on the other task instead (`Dependency rationale`), or fold the work back into this task's own Objectives/Parts. Then re-run `{cmd}`.",
  partsCoverageAndSequence:
    'Fix the named `## Parts` defect — cite every declared objective from at least one Part, and number Parts contiguously from 1 — then re-run `{cmd}`.'
} as const

export type IssueContentInput = {
  body: string
  labels: string[]
  sharedPackages: string[]
  projectPaths: ProjectPath[]
  retryCommand: string
  issueNumber: number | null
  resolvesToFile: (glob: string) => boolean
  docOwnersContent: string | null
  /**
   * O5's sibling task set, already resolved by the caller from the live
   * forge, scoped to the subject's own Milestone — `null` when no Milestone
   * could be determined (dormant: nothing to compare against, same
   * seam-is-dormant-when-absent convention `docOwnersContent`/
   * `sharedPackages` already use here).
   */
  milestoneSiblings: TaskSurfaceFacts[] | null
  /** How this subject is referred to in a sibling's `Conflicts-with` — its Issue number, or `''` for a not-yet-created Issue (a sibling cannot yet name a number that does not exist). */
  subjectRef: string
}

/**
 * Runs the Issue-only content checks and returns every finding as a
 * `CheckError`. Pure over its inputs, same discipline as `validateForgeWrite`
 * — the caller (a command file) resolves `sharedPackages`/`projectPaths` from
 * disk/forge and passes them in. `resolvesToFile` is the injected Surface-
 * glob predicate — the caller passes the SAME `expandGlob` implementation
 * `brief-assembly.ts`'s render path already uses, so the gate and the
 * renderer can never disagree about whether a glob resolves.
 */
export function validateIssueContent(input: IssueContentInput): CheckError[] {
  const surfaceResult = parseIssueSurface(input.body)
  const subjectSurfaceIn = surfaceResult.ok ? surfaceResult.value.in : []
  const subjectDeps = parseRationaleDeps(input.body)
  const subject: TaskSurfaceFacts = {
    ref: input.subjectRef,
    surfaceIn: subjectSurfaceIn,
    conflictsWith: subjectDeps.conflictsWith,
    dependsOn: subjectDeps.dependsOn
  }

  const findings: Array<[string[], keyof typeof ISSUE_CONTENT_RECOVERY]> = [
    [
      checkBlastRadiusScope(input.body, input.labels, input.sharedPackages, input.projectPaths, input.issueNumber)
        .errors,
      'blastRadius'
    ],
    [checkNoBriefContent(input.body).errors, 'noBriefContent'],
    [checkRationaleNamesDocs(input.body).errors, 'rationaleNamesDocs'],
    [checkSurfaceGlobsResolve(input.body, input.resolvesToFile).errors, 'surfaceGlobsResolve'],
    [checkPartsCiteDefinedObjectives(input.body).errors, 'partsCiteObjectives'],
    [checkDocsWithinSurface(input.body, input.issueNumber).errors, 'docsWithinSurface'],
    [checkSurfaceExcludesBoundDoc(input.body, input.docOwnersContent).errors, 'surfaceExcludesBoundDoc'],
    [checkRationaleSurfaceCoverage(input.body, input.issueNumber).errors, 'rationaleSurfaceCoverage'],
    [
      input.milestoneSiblings !== null ? checkSurfaceOverlap(subject, input.milestoneSiblings).errors : [],
      'surfaceOverlap'
    ],
    [checkObjectivesRespectBoundary(input.body).errors, 'objectivesRespectBoundary'],
    [checkNoForeignTaskOwnership(input.body).errors, 'noForeignTaskOwnership'],
    [checkPartsCoverageAndSequence(input.body).errors, 'partsCoverageAndSequence']
  ]
  const errors: CheckError[] = []
  for (const [messages, kind] of findings) {
    const instruction = ISSUE_CONTENT_RECOVERY[kind].replace('{cmd}', input.retryCommand)
    for (const message of messages) {
      errors.push(makeCheckError(CHECK_ISSUE_CONTENT, message, nameTheFix(message, instruction)))
    }
  }
  return errors
}

// ---------------------------------------------------------------------------
// The validated `issue edit` write path — extracted verbatim
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
 * target is a task Issue — the forge is the only truthful source. A
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
 * Fetches an Issue's current body plus its comments in one round trip — O3
 * needs the pre-edit body (to detect a frozen-brief section change) and the
 * comment list (to resolve the newest frozen brief, if any, via
 * `resolveNewestFrozenBrief`). A failed fetch is a HARD refusal, same
 * posture as `fetchForgeLabels` — a `gh` hiccup here must not silently
 * degrade to "no frozen brief", which would let a locked-section edit
 * through unrefused.
 */
/** `FrozenBriefCandidate` plus the comment's own URL — so a caller resolving the newest frozen brief can name it (`ResolvedFrozenBrief<C>` carries every field of `C` through unchanged). */
export type FrozenBriefCandidateWithUrl = FrozenBriefCandidate & { url: string }

export function fetchForgeIssueContext(
  issueRef: string,
  retryCommand: string
): { body: string; comments: FrozenBriefCandidateWithUrl[] } {
  let out: string
  try {
    out = execFileSync('gh', ['issue', 'view', issueRef, '--json', 'body,comments'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    refuse([
      makeCheckError(
        'forge-fetch',
        `Could not fetch Issue ${issueRef}'s body/comments from the forge (\`gh issue view\`) — the frozen-brief gate cannot decide whether it applies: ${(err as Error).message}`,
        `Check \`gh auth status\` and network, then re-run \`${retryCommand}\`. The edit is refused rather than passed through unvalidated.`
      )
    ])
  }
  try {
    const parsed = JSON.parse(out) as {
      body: string
      comments: Array<{ body: string; url: string; author: { login: string } | null }>
    }
    return {
      body: parsed.body,
      comments: parsed.comments.map((c) => ({ body: c.body, url: c.url, author: c.author?.login ?? null }))
    }
  } catch {
    refuse([
      makeCheckError(
        'forge-fetch',
        `Could not parse \`gh issue view ${issueRef} --json body,comments\` output.`,
        `Re-run \`${retryCommand}\`; the edit is refused rather than passed through unvalidated.`
      )
    ])
  }
}

/**
 * **O3 — refuses an `issue edit` that changes `## Objectives`, `## Surface`,
 * or `## Parts` on a task Issue whose brief is already frozen.** Fetches the
 * live pre-edit body and comment list, resolves the newest principal-authored
 * frozen brief (if any — dormant when none exists, the same
 * seam-is-dormant-when-absent posture this file uses elsewhere), and compares
 * the pre-edit body against `newBody` via `frozenSectionsChanged` (never
 * against the frozen comment's own rendered text — see that function's own
 * doc comment for why). Names the frozen comment's URL and
 * `vinaya issue objectives edit` as the sanctioned path for an Objectives
 * change; `## Surface`/`## Parts`/`## Documentation` have no self-serve edit path once frozen.
 *
 * `skipCheck`, when true, is `issue objectives edit`'s own escape hatch: that
 * command IS the sanctioned way to change `## Objectives` on a frozen task
 * (its own write goes through `writeValidatedIssueEdit`, below), and it posts
 * its own superseding `aeg:brief:v<k+1>` comment after writing — this
 * gate must not refuse the very command it names as the sanctioned escape.
 */
export function refuseFrozenSectionChange(
  issueRef: string,
  newBody: string | null,
  retryCommand: string,
  skipCheck = false
): void {
  if (skipCheck || newBody === null) return
  const { body: oldBody, comments } = fetchForgeIssueContext(issueRef, retryCommand)
  const allowlist = resolvePrincipalAllowlist(loadTrustAnchorConfig())
  const frozen = resolveNewestFrozenBrief(comments, allowlist)
  if (frozen === null) return
  const changed = frozenSectionsChanged(oldBody, newBody)
  if (changed.length === 0) return
  const sections = changed.map((s) => `\`## ${s}\``).join(', ')
  refuse([
    makeCheckError(
      'issue-frozen-brief',
      `This task Issue's brief is already frozen — the frozen comment is at ${frozen.url}. This edit changes ${sections}, which is locked once frozen. Use \`vinaya issue objectives edit\` for an Objectives change; \`## Surface\`/\`## Parts\`/\`## Documentation\` have no self-serve edit path once frozen — escalate to the Planner to supersede the frozen brief.`,
      `Revert the ${sections} change(s) in the body, or use \`vinaya issue objectives edit\` for an Objectives change, then re-run \`${retryCommand}\`.`
    )
  ])
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
/** How `validateTaskIssue` resolves O5's target Milestone — an edit reads the Issue's own current Milestone from the forge; a create has none yet, so `resolveMilestoneTitleForCreate` reads an explicit `--milestone` flag or, absent one, the same label-driven auto-attach target `resolveMilestoneAttachArgs` itself resolves at write time. */
export type MilestoneSource = { kind: 'edit'; issueRef: string } | { kind: 'create'; ghArgs: string[] }

/** Extracts `--milestone`/`-m`'s value from argv, or `null` if absent — the value half of `hasExplicitMilestoneFlag`'s presence check. */
function extractMilestoneFlagValue(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === '--milestone' || a === '-m') return args[i + 1] ?? null
    if (a.startsWith('--milestone=')) return a.slice('--milestone='.length)
  }
  return null
}

/**
 * The subject Issue's current Milestone title, best-effort — `null` on any
 * fetch/parse failure or when no Milestone is attached. Same
 * dormant-on-absence posture `docOwnersContent`/`sharedPackages` already use
 * elsewhere in this file: a Milestone this process cannot determine has no
 * known peer group for O5 to protect, so the overlap check goes dormant
 * rather than blocking every edit on an unrelated `gh` hiccup.
 */
function fetchForgeMilestoneBestEffort(issueRef: string): string | null {
  try {
    const out = execFileSync('gh', ['issue', 'view', issueRef, '--json', 'milestone'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const parsed = JSON.parse(out) as { milestone: { title: string } | null }
    return parsed.milestone?.title ?? null
  } catch {
    return null
  }
}

/**
 * O5's Milestone source for `issue create`: an explicit `--milestone`/`-m`
 * flag wins outright; absent that, mirrors `resolveMilestoneAttachArgs`'s own
 * label-driven auto-attach lookup so the common create workflow (a tranche
 * label, no explicit flag) still resolves a real target instead of leaving
 * O5 dormant.
 *
 * Security review, round 2, HIGH: the prior version only ever
 * read the explicit flag, so a normal `issue create --label
 * vinaya/tranche:<slug>` — the label-driven auto-attach path
 * `resolveMilestoneAttachArgs` itself resolves at write time — left
 * `milestoneTitle` `null` and the overlap check dead on `create` in the
 * common case. Same fail-open-to-dormant posture as
 * `resolveMilestoneAttachArgs`: a lookup failure degrades to "no Milestone
 * known" rather than refusing a create over a `gh api` hiccup.
 */
function resolveMilestoneTitleForCreate(ghArgs: string[], labels: string[]): string | null {
  const explicit = extractMilestoneFlagValue(ghArgs)
  if (explicit !== null) return explicit
  if (!isTaskIssueLabelSet(labels)) return null
  const slug = findTrancheSlug(labels)
  if (!slug) return null
  // `stdio: ['ignore', 'pipe', 'pipe']` deliberately, rather than reusing
  // `findMilestoneAttachTargetForSlug` directly: that helper's underlying
  // `gh api` call inherits the real `gh` stderr straight through to THIS
  // process's own stderr (Node's `execFileSync` default), bypassing the
  // try/catch below entirely. Harmless on the real-write path this task
  // does not touch (`resolveMilestoneAttachArgs`, run inside a real repo
  // with a real remote), but this call now also runs on `--validate-only` —
  // a raw `gh` error line (e.g. no git remote in a test fixture) would land
  // on the same stderr stream every reader parses as one `CheckError` JSON
  // per line, tripping `malformed` the way `check-coherence.ts`'s own
  // `git()` helper is annotated against. Fetched and parsed here, then
  // handed to the same pure `resolveMilestoneAttachTarget` matcher, so
  // behaviour is unchanged — only the stderr leak is closed.
  try {
    const out = execFileSync('gh', ['api', 'repos/{owner}/{repo}/milestones?state=all&per_page=100'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const milestones = JSON.parse(out) as Array<{
      number: number
      title: string
      description: string | null
      state: 'open' | 'closed'
    }>
    const target = resolveMilestoneAttachTarget(milestones, slug)
    return target ? target.title : null
  } catch {
    return null
  }
}

/**
 * O5's sibling-task resolver: every OTHER open task Issue sharing
 * `milestoneTitle`, reduced to `TaskSurfaceFacts`. Server-side-scoped to that
 * one Milestone via `gh issue list --milestone`, not a repo-wide fetch — O5's
 * peer group spans every tranche sharing a Milestone, but never Issues
 * outside it, so the query itself (not just a client-side filter afterward)
 * only ever returns candidates that could actually matter.
 *
 * Security review, round 2, MEDIUM: the prior version queried
 * `gh issue list` repo-wide with a flat `--limit 200` and filtered by
 * Milestone client-side — a genuinely overlapping sibling past the 200th
 * open Issue repo-wide was silently missed. Scoping the query itself to the
 * Milestone shrinks the realistic result size by orders of magnitude for any
 * repo with more than one active Milestone; `--limit` is raised well past
 * any plausible single-Milestone open-Issue count as a second margin, and
 * `gh` itself pages through the API internally to satisfy a `--limit` this
 * large in one invocation — no separate cursor loop is needed here.
 *
 * Unlike the Milestone read above, a failure HERE is still a hard refusal —
 * by this point a real Milestone is known, so degrading silently to "no
 * siblings found" would let a real collision through rather than merely skip
 * a cosmetic lookup, the same fail-closed posture `fetchForgeLabels` already
 * takes for the rationale gate's own applicability fetch — but O1 (this
 * task): the refusal is now a RETURNED finding, not a direct `refuse()`
 * call. This function used to call `refuse()` itself on a fetch/parse
 * failure, which — called from inside `collectTaskIssueErrors`, AFTER that
 * function had already pushed the schema group's own findings into its
 * union — discarded every finding already collected: a `gh` hiccup
 * coinciding with a real title-grammar or content defect reported only the
 * fetch error, hiding the real defect until a later run, exactly the
 * stop-at-first-group cost this task exists to remove. The caller folds a
 * returned error into the SAME union every other group contributes to; the
 * write still refuses (a `forge-fetch` finding is never dropped), it just no
 * longer erases what came before it.
 */
type FetchSiblingsResult = { ok: true; siblings: TaskSurfaceFacts[] } | { ok: false; error: CheckError }

function fetchOpenTaskSurfaceSiblings(
  milestoneTitle: string,
  excludeIssueNumber: number | null,
  retryCommand: string
): FetchSiblingsResult {
  let out: string
  try {
    out = execFileSync(
      'gh',
      [
        'issue',
        'list',
        '--state',
        'open',
        '--milestone',
        milestoneTitle,
        '--json',
        'number,body,labels,milestone',
        '--limit',
        '2000'
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
  } catch (err) {
    return {
      ok: false,
      error: makeCheckError(
        'forge-fetch',
        `Could not list open Issues (\`gh issue list\`) to check \`## Surface\` overlap against Milestone "${milestoneTitle}": ${(err as Error).message}`,
        `Check \`gh auth status\` and network, then re-run \`${retryCommand}\`. The write is refused rather than passed through unvalidated.`
      )
    }
  }
  let issues: Array<{
    number: number
    body: string
    labels: Array<{ name: string }>
    milestone: { title: string } | null
  }>
  try {
    issues = JSON.parse(out)
  } catch {
    return {
      ok: false,
      error: makeCheckError(
        'forge-fetch',
        'Could not parse `gh issue list --json number,body,labels,milestone` output.',
        `Re-run \`${retryCommand}\`; the write is refused rather than passed through unvalidated.`
      )
    }
  }
  return {
    ok: true,
    siblings: issues
      .filter((i) => i.number !== excludeIssueNumber)
      .filter((i) => i.milestone?.title === milestoneTitle)
      .filter((i) => isTaskIssueLabelSet(i.labels.map((l) => l.name)))
      .map((i) => {
        const surface = parseIssueSurface(i.body)
        const deps = parseRationaleDeps(i.body)
        return {
          ref: String(i.number),
          surfaceIn: surface.ok ? surface.value.in : [],
          conflictsWith: deps.conflictsWith,
          dependsOn: deps.dependsOn
        }
      })
  }
}

/**
 * Best-effort read of an Issue's CURRENT title from the forge — used only to
 * fill `validateRenderedBriefForIssue`'s render input when an `issue edit`
 * carries no `--title` of its own (the common case: nobody re-passes
 * `--title` to change only a body). A failed fetch degrades to an empty
 * title, same dormant-on-failure posture `fetchForgeMilestoneBestEffort`
 * already takes here — the title is decorative in the rendered brief
 * (`brief-render.ts` never grades it), so a miss here costs cosmetics, never
 * a false gate result.
 */
function fetchForgeTitleBestEffort(issueRef: string): string {
  try {
    return execFileSync('gh', ['issue', 'view', issueRef, '--json', 'title', '--jq', '.title'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } catch {
    return ''
  }
}

const CHECK_BRIEF_RENDER = 'brief-render'
const CHECK_BRIEF_SHAPE_PREWRITE = 'brief-shape'

/**
 * O2 — the two dispatch-blocker classes that name a task's OWN edges, not a
 * defect in the Issue being edited: an unmerged `Depends-on` or an open
 * `Conflicts-with` PR are facts about the state of the FORGE right now, not
 * about anything wrong with the brief this edit would render. `task run`
 * (`dispatch-task.ts`, unchanged by this task) still refuses on either —
 * this set exists ONLY to tell the write gate which of `renderBrief`'s
 * `missing` entries to report as informational rather than as a refusal of
 * the edit.
 */
const INFORMATIONAL_DISPATCH_BLOCKER_CLASSES: ReadonlySet<DispatchBlockerClass> = new Set([
  'depends-on-not-merged',
  'conflicts-with'
])

/**
 * **The write gate becomes the brief gate.** Renders the SAME twelve-section
 * brief `task brief`/`vinaya task brief` would produce from this draft —
 * never a second renderer, `assembleAndRenderBrief`/`assembleAndRenderBriefForIssue`
 * are the ones `apps/cli` already has, driven by an `override`/`bodyOverride`
 * escape hatch so each grades the bytes this write is ABOUT to send rather
 * than what is on the forge before it lands — then runs the SAME
 * `brief-shape` gate `pr create` applies (`checkBriefSections`,
 * `@attalabs/aeg-core`) over the rendered text — never a second validator. A
 * body that would freeze into a brief `pr create` refuses is refused here
 * instead: `checkBriefSections`'s own error strings already name both the
 * section (`brief-validation <Section>: …`) and the rule that failed.
 *
 * **A tranche-labeled Issue renders through the tranche path.** An EDIT of
 * an Issue already carrying a `vinaya/tranche:*` label has a real Issue
 * number to look up in its tranche's forge-derived task list
 * (`resolveTrancheTaskId`) — found, `assembleAndRenderBrief` renders it with
 * the drafted body substituted in. **Dormant only for a tranche-labeled
 * CREATE** (`issueNumber === null`): no Issue number exists yet to look up,
 * genuinely circular before the Issue itself lands — and dormant when the
 * lookup itself finds nothing (a label naming a tranche this checkout cannot
 * derive, or an Issue number not yet reflected in that tranche's task list),
 * the same fail-open-on-cannot-render posture as every other dormancy here.
 * A backlog Issue (no tranche label at all) always renders through
 * `assembleAndRenderBriefForIssue`, as before.
 *
 * Also dormant when `canRenderBriefFromHere()` is false — no brief template
 * on disk, or no resolvable owner/repo. A real `vinaya` invocation always has
 * both; a fixture/test environment or an Issue write attempted outside any
 * real checkout does not, and this gate must not turn "cannot render" into a
 * false refusal of an otherwise-valid Issue.
 *
 * No partition-by-rollout (`partitionBriefErrorsByRollout`): a pre-write
 * gate has no PR number to grandfather against, and `partitionBriefErrorsByRollout`'s
 * own contract treats `prNumber === null` as NOT grandfathered — every
 * finding here is blocking, the same fail-closed posture that contract
 * documents.
 *
 * **O1 — returns findings, never refuses.** Used to call `refuse()` directly
 * (twice — once for a render gap, once for `checkBriefSections`'s own
 * findings), which stopped `validateTaskIssue` from ever reaching its later
 * groups. Returns every finding as a `CheckError[]` instead so the caller can
 * fold this group's findings into the SAME union every other group
 * contributes to, and refuse once.
 */
async function validateRenderedBriefForIssue(input: {
  issueNumber: number | null
  title: string
  body: string
  labels: string[]
  retryCommand: string
}): Promise<CheckError[]> {
  if (!canRenderBriefFromHere()) return []

  const trancheSlug = findTrancheSlug(input.labels)
  let rendered: AssembleAndRenderBriefResult
  if (trancheSlug !== null) {
    if (input.issueNumber === null) return []
    const taskId = await resolveTrancheTaskId(trancheSlug, input.issueNumber)
    if (taskId === null) return []
    rendered = await assembleAndRenderBrief(trancheSlug, taskId, undefined, input.body)
  } else {
    rendered = await assembleAndRenderBriefForIssue(input.issueNumber ?? DRAFT_ISSUE_SENTINEL, {
      title: input.title,
      body: input.body,
      labels: input.labels
    })
  }
  if (!rendered.ok) {
    // O2 — a `missing` entry that came out of a dispatch-blocker class this
    // gate treats as informational (see `INFORMATIONAL_DISPATCH_BLOCKER_CLASSES`)
    // is reported as a `warning`-severity finding, never one that refuses the
    // edit: `checkDispatchReadiness`'s own blocker messages are exactly what
    // `renderBrief` copied verbatim into `missing` (`gate.blockers` is
    // `blockerDetails.map(b => b.message)`), so an exact-string match against
    // `dispatchBlockerDetails` recovers the classification `missing` itself
    // dropped, with no second call to `checkDispatchReadiness`.
    const informationalMessages = new Set(
      (rendered.dispatchBlockerDetails ?? [])
        .filter((b) => INFORMATIONAL_DISPATCH_BLOCKER_CLASSES.has(b.class))
        .map((b) => b.message)
    )
    return rendered.missing.map((m) =>
      makeCheckError(
        CHECK_BRIEF_RENDER,
        `brief-render: ${m}`,
        nameTheFix(
          `brief-render: ${m}`,
          `Fix the named gap so this Issue renders a valid brief, then re-run \`${input.retryCommand}\`.`
        ),
        informationalMessages.has(m) ? 'warning' : 'error'
      )
    )
  }

  const briefErrors = checkBriefSections(rendered.brief, readTierFromPrBody, {
    consumersOf: buildWorkspaceConsumersOf()
  }).errors
  return briefErrors.map((e) =>
    makeCheckError(
      CHECK_BRIEF_SHAPE_PREWRITE,
      e,
      nameTheFix(
        e,
        `Fix the named section in the Issue body — as written it would freeze into a brief \`pr create\` refuses — then re-run \`${input.retryCommand}\`.`
      )
    )
  )
}

/**
 * Test-only injection point (O1) — `collectTaskIssueErrors`'s last two
 * groups are the two that need live forge/filesystem/template state to run
 * for real (a rendered brief, a spawned registry check). Defaulted to the
 * real implementations everywhere except a test that wants to exercise the
 * union across all four groups without standing up that state.
 */
export type TaskIssueValidationDeps = {
  computeRenderedBriefErrors: typeof validateRenderedBriefForIssue
  runIssueChecks: typeof runIssueChecks
}

const defaultTaskIssueValidationDeps: TaskIssueValidationDeps = {
  computeRenderedBriefErrors: validateRenderedBriefForIssue,
  runIssueChecks
}

/**
 * **O1 — runs every gate group over the SAME body/title/labels and returns
 * the union of every finding, never refusing early.** Used to be four
 * separate refusal points (schema, content, rendered-brief-shape, registry),
 * each stopping `validateTaskIssue` before the next group ever ran — opening
 * one Issue with three independent defects cost three round-trips, one group
 * fixed per run, because each run only ever saw the ONE group it happened to
 * reach first. Every group below is independent of the others' outcome (none
 * needs a prior group to have PASSED to run — they all grade the same
 * already-buffered `body`/`title`/`labels`), so all four always run and
 * contribute to one combined list; `validateTaskIssue` refuses ONCE with
 * whatever that list holds.
 *
 * The one render (`deps.computeRenderedBriefErrors`) still happens exactly
 * once, not once per group — the brief-shape group's own findings come out
 * of that single render, same as before this change.
 */
export async function collectTaskIssueErrors(
  body: string,
  title: string | null,
  labels: string[],
  retryCommand: string,
  issueNumber: number | null,
  milestoneSource?: MilestoneSource,
  deps: TaskIssueValidationDeps = defaultTaskIssueValidationDeps
): Promise<CheckError[]> {
  const errors: CheckError[] = []

  const sections = resolveSections('issue', retryCommand)
  errors.push(
    ...validateForgeWrite({
      body,
      title,
      sections,
      changedFiles: [],
      retryCommand,
      issueNumber
    })
  )

  const milestoneTitle =
    milestoneSource === undefined
      ? null
      : milestoneSource.kind === 'edit'
        ? fetchForgeMilestoneBestEffort(milestoneSource.issueRef)
        : resolveMilestoneTitleForCreate(milestoneSource.ghArgs, labels)
  // O1 — a fetch failure here folds into the SAME union every other group
  // contributes to, rather than refusing immediately and discarding the
  // schema group's findings already pushed above.
  let milestoneSiblings: TaskSurfaceFacts[] | null = null
  if (milestoneTitle !== null) {
    const siblingsResult = fetchOpenTaskSurfaceSiblings(milestoneTitle, issueNumber, retryCommand)
    if (siblingsResult.ok) {
      milestoneSiblings = siblingsResult.siblings
    } else {
      errors.push(siblingsResult.error)
    }
  }

  errors.push(
    ...validateIssueContent({
      body,
      labels,
      sharedPackages: readSharedPackages(),
      projectPaths: readProjectPaths(),
      retryCommand,
      issueNumber,
      resolvesToFile: (glob) => expandGlob(glob).length > 0,
      docOwnersContent: readDocOwnersContent(),
      milestoneSiblings,
      subjectRef: issueNumber !== null ? String(issueNumber) : ''
    })
  )

  // Render the brief this write would freeze and grade it with the same
  // brief-shape gate `pr create` applies, before the write. `title` is null
  // on a plain `issue edit`/`issue objectives edit` that doesn't re-pass
  // `--title`; the Issue's own live title fills the gap (used only on the
  // backlog path — a tranche-labeled render reads its title from the
  // tranche's own task list instead).
  const effectiveTitle =
    title ?? (milestoneSource?.kind === 'edit' ? fetchForgeTitleBestEffort(milestoneSource.issueRef) : '')
  errors.push(
    ...(await deps.computeRenderedBriefErrors({ issueNumber, title: effectiveTitle, body, labels, retryCommand }))
  )

  // O2 (task 17) — the six write-only rules, through the SAME registry
  // runner `runBodyChecks` uses. `checkMilestoneAttach` stays dormant on
  // EVERY write-path call (both `currentMilestoneTitle`/`resolvedMilestoneTitle`
  // null): `create`'s auto-attach action happens as part of THIS SAME write,
  // once validation passes, so there is nothing to compare against yet
  // (flagging an attach that has not happened YET as one that never will is
  // exactly the false positive this must not produce); `edit` never
  // re-attaches at all, by this system's own design
  // (`packages/aeg-core/bin/open-issue.ts`'s `resolveMilestoneToAttach`:
  // "edit never force-attaches retroactively" — `vinaya milestone adopt` is
  // the sanctioned way to move a tranche's Milestone, and comparing an
  // adopted Issue's live Milestone against its label's DEFAULT resolution
  // would flag every legitimately-adopted tranche as a violation). The check
  // is still registered and directly invocable (`vinaya check
  // issue-milestone-attach`) — it simply has no write-path moment that is
  // both meaningful and free of that false-positive risk.
  errors.push(
    ...(await deps.runIssueChecks({
      body,
      labels,
      title,
      issueNumber,
      currentMilestoneTitle: null,
      resolvedMilestoneTitle: null,
      retryCommand
    }))
  )

  return errors
}

export async function validateTaskIssue(
  body: string | null,
  title: string | null,
  labels: string[],
  retryCommand: string,
  issueNumber: number | null,
  // Optional — every call site in `apps/cli/src/commands/issue.ts` now
  // passes it. Left optional rather than required so
  // an omission degrades to O5 dormant (`milestoneTitle` stays `null`)
  // exactly like a Milestone this process could not determine — never a
  // crash, never a silently-wrong Milestone guess.
  milestoneSource?: MilestoneSource
): Promise<void> {
  if (body === null) {
    refuse([
      makeCheckError(
        'forge-args',
        'A task Issue (a `vinaya/tranche:*` label) requires a `--body-file <path>` so the rationale gate can validate it.',
        `Add \`--body-file <path>\`, then re-run \`${retryCommand}\`.`
      )
    ])
  }

  const errors = await collectTaskIssueErrors(body, title, labels, retryCommand, issueNumber, milestoneSource)
  // O2 — a `warning`-severity finding (an unmerged Depends-on, an open
  // Conflicts-with PR: `validateRenderedBriefForIssue`'s own fold, above) is
  // reported but never refuses the edit on its own; only a real `error`
  // finding does. A refusal still prints every finding, warnings included,
  // so a genuine defect's context isn't stripped down to just the blockers.
  const blocking = errors.filter((e) => e.severity !== 'warning')
  if (blocking.length > 0) refuse(errors)
  for (const e of errors) emitCheckError(e)
}

/**
 * The validate-then-write core `issueEditCommand` runs for every non-
 * `--validate-only` edit: union the forge's real labels with argv, run
 * `validateTaskIssue` when the target is a task Issue, ensure the tranche
 * label exists, then write. `issue objectives edit` drives this
 * same path with a temp `--body-file` it wrote itself — one validated write
 * path for every Issue-edit caller, never a second hand-rolled one.
 */
export async function writeValidatedIssueEdit(input: {
  issueRef: string
  ghArgs: string[]
  bodyResult: BodyResult | null
  json: boolean
  retryCommand: string
  quiet?: boolean
  /** `issue objectives edit`'s own escape hatch — see `refuseFrozenSectionChange`'s doc comment. Every other caller omits this (defaults to `false`, the check runs). */
  skipFrozenSectionsCheck?: boolean
}): Promise<void> {
  const { issueRef, ghArgs, bodyResult, json, retryCommand, quiet, skipFrozenSectionsCheck } = input
  const body = bodyResult?.body ?? null
  const title = extractTitle(ghArgs)

  // Union the forge's real labels with any passed on argv — argv is normally
  // silent on edit, so the forge is what decides task-Issue applicability.
  const labels = [...new Set([...fetchForgeLabels(issueRef, retryCommand), ...extractLabels(ghArgs)])]

  refuseUnlabeledTaskShapedBody(body, labels, retryCommand)

  // O3: same widened gate as `issueCreateCommand`'s —
  // a backlog Issue's edit is validated too, minus the tranche-specific
  // label/Milestone machinery below.
  if (isTaskIssueLabelSet(labels) || (body !== null && isTaskIssueBodyShaped(body))) {
    refuseFrozenSectionChange(issueRef, body, retryCommand, skipFrozenSectionsCheck ?? false)
    await validateTaskIssue(body, title, labels, retryCommand, parseIssueNumberFromRef(issueRef), {
      kind: 'edit',
      issueRef
    })
  }

  const slugToEnsure = findTrancheSlug(labels)
  if (slugToEnsure) ensureTrancheLabelExists(slugToEnsure)

  runGhWrite(['issue', 'edit', issueRef], ghArgs, bodyResult, json, quiet ?? false)
}

// ---------------------------------------------------------------------------
// Principal-only gate — `issue objectives edit` and `pr rule` are
// Principal-only actions per `aeg-root/roles/principal.md`, but `gh`
// authenticates as "whoever is logged in": without this, any collaborator's
// (or co-resident agent session's) token can post a comment indistinguishable
// from a genuine Principal ruling, or silently rewrite a task's Objectives —
// zero gate (a CRITICAL security-review finding). `isPrincipal` itself is
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
// `issue objectives edit` and `pr rule` can post their own marked
// comments without duplicating the temp-file-then-`gh comment` dance.
// ---------------------------------------------------------------------------

/** How many of `bodies` open with `prefix` — the marker-numbering scheme every marked-comment poster uses (`k = count + 1`). Counted on the forge at post time, never derived from a local file. */
export function countMarkerComments(bodies: string[], prefix: string): number {
  return bodies.filter((b) => b.startsWith(prefix)).length
}

/** The exact bytes `postMarkedComment` posts — exported so a caller computing a payload digest for reconciliation (`EffectIdentity.payloadDigest`, `apps/cli/src/lib/effects.ts`) hashes the SAME string this function actually sends, rather than a hand-reconstructed copy that could drift from it. */
export function markedCommentBody(marker: string, body: string): string {
  return `${marker}\n${body}\n`
}

/**
 * Posts `body`, prefixed with `marker` on its own first line, as a comment on
 * an Issue or PR — the same buffered-temp-file shape `pr.ts`'s
 * `postBriefComment` uses, generalised over `kind`. Returns the URL `gh`
 * printed. A failed post is a hard refusal: nothing durable was recorded.
 */
export function postMarkedComment(kind: 'issue' | 'pr', ref: string, marker: string, body: string): string {
  const commentBody = markedCommentBody(marker, body)
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

/**
 * An `EffectReconciler` (`apps/cli/src/lib/effects.ts`) over `gh {issue,pr}
 * view --json comments`: fetches every comment on `ref`, and reports
 * `'confirmed'` (with that comment's own url) the instant a PRINCIPAL-
 * AUTHORED one's `body` hashes to `identity.payloadDigest` — exact-body
 * matching, the same assumption `commands/review-post.ts`'s own
 * `verifyPostedEscalation` already makes (`comments.find((c) => c.body ===
 * postedBody)`) for a re-fetched comment against what this process itself
 * posted, but author-filtered first through the SAME `isPrincipal`/
 * `resolvePrincipalAllowlist` machinery `principalBodies` (`review-post.ts`)
 * already uses for exactly this trust boundary (security review, round 2,
 * HIGH): every effect this reconciler is wired to reconciles a comment THIS
 * process itself posted as an allowlisted principal, so a byte-identical
 * body from anyone else is not evidence of that — without this filter, any
 * actor able to comment on `ref` could pre-post a spoofed body and have
 * `EffectExecutor` mark the effect `'verified'` against it, skipping the
 * real post entirely. A `gh` failure, or JSON this shape does not parse, is
 * reported `'ambiguous'` — never treated as "confirmed absent," since a
 * failed read proves nothing about the remote. Only a SUCCESSFUL read with
 * no matching principal-authored body is `'absent'`.
 */
export function reconcileGhComment(
  kind: 'issue' | 'pr',
  ref: string
): (identity: EffectIdentity) => EffectReconcileResult {
  return (identity) => {
    let raw: string
    try {
      // `env: process.env` passed explicitly (unlike this file's other
      // `execFileSync('gh', …)` call sites) — proven necessary for this
      // one during review-fix testing: a bare command's own executable
      // resolution did not consistently pick up a live-mutated
      // `process.env.PATH` without it, on the Bun version this repo pins,
      // making a fake `gh` on `PATH` unreliable to test against otherwise.
      // A no-op in production, where `process.env` is never mutated.
      raw = execFileSync('gh', [kind, 'view', ref, '--json', 'comments'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env
      })
    } catch (err) {
      return {
        outcome: 'ambiguous',
        reason: `could not fetch ${kind} ${ref}'s comments (\`gh ${kind} view --json comments\`): ${err instanceof Error ? err.message : String(err)}`
      }
    }
    let parsed: { comments: { body: string; url?: string; author?: { login?: string | null } | null }[] }
    try {
      parsed = JSON.parse(raw) as {
        comments: { body: string; url?: string; author?: { login?: string | null } | null }[]
      }
    } catch (err) {
      return {
        outcome: 'ambiguous',
        reason: `could not parse ${kind} ${ref}'s comments JSON: ${err instanceof Error ? err.message : String(err)}`
      }
    }
    const allowlist = resolvePrincipalAllowlist(loadTrustAnchorConfig())
    const match = parsed.comments.find(
      (c) => isPrincipal(c.author?.login ?? null, allowlist) && sha256Hex(c.body) === identity.payloadDigest
    )
    if (match) return { outcome: 'confirmed', url: match.url ?? '' }
    return { outcome: 'absent' }
  }
}
