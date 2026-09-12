import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AnchorField,
  anchoredRegionBounds,
  extractFencedBlocks,
  formatTokenReportRow,
  locateTestPlanSection,
  resolveMeteringCapability
} from '@attalabs/aeg-core'
import { maskCode } from '@attalabs/aeg-forge-state/strip-code'
import { coreCheckRegistry } from '../checks/registry'
import { buildCheckEnv } from '../checks/runner'
import { ScanContext } from '../checks/scan-context'
import { loadConfig } from '../lib/config'
import { runBodyChecks } from '../lib/forge-write'
import { EVIDENCE_SUMMARY_PREFIX, summariseNumstat } from '../lib/numstat'
import { packageRoot } from '../lib/package-root.js'
import { meteringRefusalMessage, realDeps } from './tokens'

/**
 * `vinaya pr report` — emits the `AEG:EVIDENCE` block: a PR body's factual
 * claims, produced by running commands instead of being typed by hand.
 * `check-evidence-fresh` (the CI-side check) refuses a body whose block
 * doesn't match the head it's attached to. Together they close the
 * fabrication class recorded in this task's brief (fix/pr-report-emitter,
 * §1) for the two facts a checker can cheaply recompute — a diff stat, a
 * pass/fail gate run — never for narrative prose, which this command does
 * not touch.
 *
 * `--write` also fills a second, independent block: `AEG:TOKENS`, real
 * usage figures collected the same way `vinaya tokens` collects them
 * (`resolveMeteringCapability`), rendered into the `## Token report`
 * heading's table. Unlike Evidence, re-entry APPENDS a row rather than
 * replacing the block — see `writeTokensBlock`'s doc comment and this
 * task's brief (#270) for why. Cost is always `—` by design (no maintained
 * pricing table). A session whose OWN wiring was reached but failed — a pointer
 * whose id matches, or one at this project's own pointer path — gets an
 * all-`—` row carrying the probe's reason inline (Agent/Model cell),
 * never a fabricated `0/0/—`; a session that resolved no transcript at all
 * gets NO row and a refusal (`collectTokensAddition`, Issue #365) — the
 * Evidence block is written either way.
 *
 * Two groups, deliberately kept apart, because they are verifiable to
 * different degrees:
 *
 *   - **Group A (recomputable).** The head sha and `git diff --numstat`
 *     against `origin/main`'s merge-base (`BASE_SHA`, then `main`, on repos
 *     where that doesn't resolve — see `resolveMergeBase`). `check-evidence-fresh`
 *     recomputes this exactly and byte-compares it — a hand-typed diff stat
 *     cannot survive that. `--numstat`, never `--stat`: `--stat` scales its
 *     column widths to the output width (the terminal's on a TTY, 80 when
 *     piped), so a block written in a developer's terminal and recomputed in
 *     CI would differ byte-for-byte with identical content — a red-line for
 *     the exact reason this command exists. `--numstat` is width-invariant.
 *     When NO tried ref resolves, this REFUSES (`UnresolvableMergeBaseError`,
 *     non-zero exit, nothing written) rather than writing an empty Group A —
 *     an unresolvable base is an infrastructure failure, and "no diff" is a
 *     claim this command must never make without actually having computed one.
 *
 *   - **Group B (attested).** The result of `vinaya check --all
 *     --diff-only` — THIS repo's own portable gate suite, not `ci.yml`'s
 *     `bunx biome check .` / `bun run typecheck` / `bunx turbo test`
 *     commands. Those are this repo's own toolchain; hardcoding them into a
 *     published CLI would make Group B wrong or empty in every adopter not
 *     on bun+turbo+biome (attalabs is a live one). `vinaya check --all
 *     --diff-only` is portable by construction and is the suite that
 *     actually blocks merge here. `check-evidence-fresh` can only check this
 *     group for STALENESS (its recorded head sha still matches the PR's real
 *     head) — it cannot detect a fabricated pass without re-running the
 *     whole suite, which it deliberately does not do.
 *
 * Emits no free-text field — no summary, no risk note, nothing this command
 * would have to interpret or word. Every VALUE is a command's output,
 * verbatim; the section headings and the Group A command line are
 * display-only (`renderGroupA`). No normalising step is needed or present:
 * `GateOutcome` carries no timing or cache-status field, so two runs at the
 * same sha are byte-identical by construction.
 *
 * **Recursion, and why gate running is injectable.** Group B runs this same
 * CLI's own `check --all --diff-only` as a subprocess. `pr-report.test.ts`
 * (this command's own test suite) necessarily invokes `--write`, and that
 * suite itself runs under `bunx turbo test` — so a test case that let
 * `--write` shell out to the real gate suite would make an already-running
 * test run touch the CLI's own build/network-dependent checks from inside
 * itself, which is slow, environment-coupled, and not what a *unit* test
 * for this command's formatting logic should depend on. `runPrReport`
 * therefore takes an injectable `gateRunner` (default: the real subprocess
 * runner below); the test suite passes a fake one. There is no `--no-gates`
 * CLI flag — every real `vinaya pr report --write` always runs the real
 * gates, because the emitted block claiming a gate result IS the gate
 * result; a flag that let a real invocation skip that would reopen the gap
 * this command exists to close.
 *
 * `--push <pr>` is the post-open sibling of `--write`: it fetches the PR's
 * LIVE body from the forge, splices the freshly-built blocks into it through
 * the same anchor resolver, pushes the result via `gh pr edit`, then re-reads
 * the live body and refuses (restoring the pre-edit body) unless the two
 * bodies agree outside the `AEG:EVIDENCE`/`AEG:TOKENS` regions. The local body
 * file a Developer might still be holding is never the input — the live body
 * always is — so a `--push` run can never carry a stale local draft over a
 * forge edit made since (e.g. a Principal's `[principal]` tick). See
 * `spliceIntoLiveBody` and `bodiesAgreeOutsideRegions`.
 */

const EVIDENCE_START = '<!-- AEG:EVIDENCE:START -->'
const EVIDENCE_END = '<!-- AEG:EVIDENCE:END -->'

// Array-form execFileSync — no shell, so no injection surface.
// `env: { ...process.env }` explicit on every call below — the same reason
// `runRealGates`'s own spawnSync already carries it (see that function's doc
// comment): Bun resolves the child EXECUTABLE's own PATH lookup from a
// cached environment when `env` is omitted, not from `process.env` read at
// call time, so a runtime `process.env.PATH` mutation (a test's fake `gh`/
// `git` on a prepended directory) is silently ignored without this.
function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: process.env }).trim()
  } catch {
    return ''
  }
}

/** Array-form execFileSync against `gh` — same no-shell discipline as `git()`, but throws (rather than collapsing to `''`) since a `--push` run must never mistake a failed forge call for an empty answer. Mirrors `review-post.ts`'s `gh()`. */
function gh(args: string[]): string {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env }).trim()
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr
    throw new Error(String(stderr ?? (err as Error).message).trim() || 'gh command failed')
  }
}

/**
 * Thrown by `gitStrict` when a git command exits non-zero. Same reasoning as
 * `UnresolvableMergeBaseError` below, applied to the other two commands this
 * module runs: `git()` returns `''` for a FAILED command and for a command
 * that legitimately printed nothing, and those two are not the same fact.
 * `git diff --numstat` printing nothing means "no files changed" — a real,
 * verifiable answer; `git diff` FAILING also produced `''`, and both sides of
 * the evidence contract then agreed on it and reported PASS having compared
 * nothing. An earlier fix (PR #126) covered the merge-base only;
 * the same collapse survived behind `rev-parse` and `diff`. Commands whose
 * empty output is meaningful must therefore distinguish "empty" from
 * "failed", which means throwing rather than returning a sentinel.
 */
export class GitCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly cause: string
  ) {
    super(`\`git ${args.join(' ')}\` failed: ${cause}`)
    this.name = 'GitCommandError'
  }
}

/**
 * `git`, but a non-zero exit throws instead of collapsing to `''`. Use this
 * wherever an empty stdout is a legitimate answer that must not be
 * confusable with failure — see `GitCommandError`. `resolveMergeBase` keeps
 * the soft `git()`: there, an empty result IS the signal it acts on, and it
 * raises its own error once every candidate ref has been tried.
 */
function gitStrict(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env }).trim()
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr
    throw new GitCommandError(args, String(stderr ?? (err as Error).message).trim() || 'non-zero exit')
  }
}

/**
 * Thrown by `resolveMergeBase` when none of the tried refs produce a
 * merge-base. An unresolvable base is an infrastructure failure — the repo's
 * default branch isn't reachable as any of the tried names, or `origin` isn't
 * configured — not evidence of an empty diff. Swallowing it to `''` (what
 * `git()` itself does for every other caller) let a REAL failure collapse
 * into the exact same value as a genuinely empty diff, and `compareEvidenceBlock`
 * cannot tell "verified: no changes" from "never verified anything" once both
 * sides independently produce `''` — found in review (PR #126): an
 * adopter whose default branch is `master`/`develop` hits this on every run,
 * silently.
 */
export class UnresolvableMergeBaseError extends Error {
  constructor(
    readonly head: string,
    readonly triedRefs: readonly string[]
  ) {
    super(
      `could not resolve a merge-base for HEAD (${head}) against any of: ${triedRefs.join(', ')}. ` +
        'This repo\'s default branch may not be named "main", or "origin" may not be configured — set BASE_SHA to override.'
    )
    this.name = 'UnresolvableMergeBaseError'
  }
}

/**
 * `BASE_SHA` if set, else `origin/main`, falling back to plain `main` when
 * that doesn't resolve either — same `BASE_SHA || 'origin/main'` convention
 * four sibling core checks already use (`check-doc-coverage.ts`,
 * `check-no-disk-state.ts`, `check-doc-coverage-push.ts`, `check-single-plan-pr.ts`),
 * plus the `main` fallback `pr.ts`'s `localChangedFiles()` also uses. Not
 * every repo this runs in has a remote named `origin`, or a branch named
 * `main`: a bare local fixture (this command's own test setup, and several
 * existing `apps/cli/tests/*.test.ts` fixtures) has neither, and both
 * `git merge-base` calls fail outright there. When every tried ref fails,
 * this throws `UnresolvableMergeBaseError` rather than returning `''` — see
 * that class's doc comment for why silently degrading to an empty base is
 * the wrong failure mode.
 */
function resolveMergeBase(head: string): string {
  const primary = process.env.BASE_SHA || 'origin/main'
  const tried = primary === 'main' ? [primary] : [primary, 'main']
  for (const ref of tried) {
    const base = git(['merge-base', ref, head])
    if (base) return base
  }
  throw new UnresolvableMergeBaseError(head, tried)
}

export type GroupA = { head: string; base: string; numstat: string }

/**
 * The head sha, its resolved merge-base (`resolveMergeBase`), and the
 * width-invariant `--numstat` diff between them.
 *
 * Every step refuses rather than degrading, because the two facts this
 * function can report — "verified: no changes" and "never verified
 * anything" — are otherwise the same bytes. `git rev-parse HEAD` failing
 * (not a git repo, or an unborn branch) throws `GitCommandError`; no base
 * resolving throws `UnresolvableMergeBaseError`; `git diff` failing throws
 * `GitCommandError` again. Only an empty `numstat` from a SUCCEEDING diff is
 * a legitimate result, and it is returned normally.
 */
export function computeGroupA(): GroupA {
  // Every step throws rather than degrading. An unborn branch (no commits
  // yet, so `rev-parse HEAD` fails) previously short-circuited BOTH ternaries
  // below, so `resolveMergeBase` was never reached and nothing refused — the
  // emitter wrote an empty head and an empty Group A and exited 0. That is
  // the same fail-open shape, reached by a different door.
  const head = gitStrict(['rev-parse', 'HEAD'])
  const base = resolveMergeBase(head)
  const numstat = gitStrict(['diff', `${base}...${head}`, '--numstat'])
  return { head, base, numstat }
}

export type GateOutcome = { name: string; status: string; errors: { severity: string; message: string }[] }
export type GateRunResult = { outcomes: GateOutcome[]; failed: boolean }
export type GateRunner = () => GateRunResult | Promise<GateRunResult>

/** Which body Group B's checks actually graded — named in the rendered block (O2) so a reader can never mistake a check that never ran against real text for one that passed against it. */
export type GradedBodySource = 'write' | 'push' | 'push-from-file' | 'ambient'

function describeGradedBodySource(source: GradedBodySource): string {
  switch (source) {
    case 'write':
      return 'the drafted body file (`--write`)'
    case 'push':
      return 'the live pull-request body (`--push`)'
    case 'push-from-file':
      return 'the local body file, whole, about to replace the live body (`--push --body-file`)'
    case 'ambient':
      return 'the ambient `PR_BODY` environment (no `--write`/`--push`)'
  }
}

/**
 * Names of every registered check that declares `PR_BODY` in its own `env`
 * (`registry.ts`) — the check's own declared contract that it reads the PR
 * body, not a guess made here. Computed once; the registry is static data.
 */
const BODY_READING_CHECK_NAMES: ReadonlySet<string> = new Set(
  coreCheckRegistry()
    .filter((spec) => {
      const decl = spec.env?.PR_BODY
      return decl === true || (typeof decl === 'object' && decl !== null && 'optional' in decl)
    })
    .map((spec) => spec.name)
)

/**
 * A body-reading check handed an empty body exits 0 with no error — the
 * same silent shape a genuine pass has (PR #481's incident: `pr-report-density`
 * read `pass` on an empty body, then CI failed the same check against the
 * real one). `gradedBody` is the exact text this run fed Group B, so when it
 * is empty, any of THOSE checks reporting a clean pass graded nothing — shown
 * here as `skipped`, never `pass`. A check outside this set, or one that
 * itself emitted an error, is left untouched: it did something regardless of
 * body content, or it already failed honestly.
 */
function shouldRenderAsSkipped(outcome: GateOutcome, gradedBody: string): boolean {
  return (
    gradedBody === '' &&
    outcome.status === 'pass' &&
    outcome.errors.length === 0 &&
    BODY_READING_CHECK_NAMES.has(outcome.name)
  )
}

/** `dist/index.js` when built, the raw `src/index.ts` entry otherwise — same fallback `checks/registry.ts` uses for its own bins. */
function resolveSelfEntry(): string {
  const root = packageRoot(import.meta.url)
  const dist = join(root, 'dist', 'index.js')
  return existsSync(dist) ? dist : join(root, 'src', 'index.ts')
}

const FAILING_STATUSES = new Set(['fail', 'error', 'timeout'])

/**
 * Whether any outcome is fail/error/timeout — `pass` and `skipped` are the
 * only non-failing statuses `vinaya check`'s `CheckOutcome` can carry.
 * Pulled out of `runRealGates` as its own pure, exported function so it's
 * directly unit-testable: `runRealGates` itself needs a real subprocess to
 * exercise, which hid a mutation-testing gap in review — a test asserting
 * only on hand-built `{ failed: true }` fixtures never actually re-derives
 * this computation, so narrowing `FAILING_STATUSES` to `['fail']` alone left
 * every existing test green.
 */
export function anyGateFailed(outcomes: GateOutcome[]): boolean {
  return outcomes.some((o) => FAILING_STATUSES.has(o.status))
}

/** The real gate runner: shells to this CLI's own `check --all --diff-only --json`, from the caller's cwd. */
export function runRealGates(): GateRunResult {
  const entry = resolveSelfEntry()
  // `node:child_process`, not `Bun.spawnSync`: this package ships a
  // `#!/usr/bin/env node` bin with `engines.node >= 20`, so a `Bun.*` call
  // here is a `ReferenceError: Bun is not defined` for every adopter running
  // the published CLI under node — Group B could never run for them. It
  // failed closed (the ReferenceError escapes the narrowed catch below
  // before any write), so no false attestation could be published.
  const proc = spawnSync(process.execPath, [entry, 'check', '--all', '--diff-only', '--json'], {
    cwd: process.cwd(),
    // Explicit, and load-bearing under Bun — not merely clearer than omitting
    // the key. `--push` sets `PR_BODY`/`PR_NUMBER`/`BRANCH` by MUTATING
    // `process.env` just before this call. Node propagates a runtime
    // `process.env` mutation into a `spawnSync` child that inherits the
    // parent environment; Bun does not — its child sees the environment the
    // process started with, so under Bun the omitted-key form would hand the
    // gate child a `PR_BODY` that is stale or absent, and every body-reading
    // gate in Group B would grade the wrong text (or skip). Spreading
    // `process.env` here reads the mutated values at call time and passes
    // them explicitly, which is correct on both runtimes.
    env: { ...process.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 32 * 1024 * 1024
  })
  const stdout = proc.stdout ?? ''
  try {
    const parsed = JSON.parse(stdout) as { data: { checks: GateOutcome[] } }
    const outcomes = parsed.data.checks
    return { outcomes, failed: anyGateFailed(outcomes) }
  } catch {
    return {
      outcomes: [
        {
          name: 'check',
          status: 'error',
          errors: [
            { severity: 'error', message: '`vinaya check --all --diff-only --json` did not produce parseable output.' }
          ]
        }
      ],
      failed: true
    }
  }
}

/**
 * Group A, rendered inside its fenced block. The command line names the REAL
 * resolved base and head — not a hardcoded `git merge-base origin/main HEAD`
 * label — because on the `main`/`BASE_SHA` fallback path that label would be
 * a hand-typed claim inside the one block built to have none: it would say
 * `origin/main` having actually resolved against `main`.
 * `compareEvidenceBlock` never parses this line — only the fenced
 * `numstat` content below it is compared — so this is display-only honesty,
 * not a verification input.
 */
function renderGroupA(groupA: GroupA): string {
  return [
    '### Group A — recomputable',
    '',
    `\`git diff ${groupA.base}...${groupA.head} --numstat\``,
    '',
    '```',
    groupA.numstat,
    '```'
  ].join('\n')
}

/** Group B, rendered inside its fenced block — name/status/message only, no durations or cache-status lines, so two runs at the same sha are byte-identical. Sorted by name for determinism independent of registry order or completion order. The `Graded body:` line (O2) sits outside the fence, before it, in a fixed position `compareEvidenceBlock` never parses (it only reads the fence contents and the `Head:`/`Summary:` lines) — reproducible byte-for-byte for the same `gradedBodySource`. */
function renderGroupB(outcomes: GateOutcome[], gradedBodySource: GradedBodySource): string {
  const sorted = [...outcomes].sort((a, b) => a.name.localeCompare(b.name))
  const lines = sorted.flatMap((o) => {
    const rows = [`${o.name}: ${o.status}`]
    for (const e of o.errors) rows.push(`  ${e.severity}: ${e.message}`)
    return rows
  })
  return [
    '### Group B — attested',
    '',
    '`vinaya check --all --diff-only`',
    '',
    `Graded body: ${describeGradedBodySource(gradedBodySource)}`,
    '',
    '```',
    lines.join('\n'),
    '```'
  ].join('\n')
}

/**
 * Group C — the `[agent]` half of the Test Plan (task 12, #387; Principal
 * ruling after PR #395: an agent never ticks a box or edits a PR body). The
 * renderer emits §9 as a fenced list of commands, one per line, each with
 * its expected observable after a literal `→`; this runs every command in
 * that list from the PR head and records its actual output, so the
 * `AEG:EVIDENCE` block IS the evidence — never a round comment, never a
 * hand-typed paste.
 *
 * Policy, not a mirrored constant (issue-545, O5): `report.commandTimeoutMs`
 * in `vinaya.config.json`, defaulting to `DEFAULT_COMMAND_TIMEOUT_MS`. The
 * prior hardcoded `30_000` (mirrored from `apps/cli/src/commands/check.ts`'s
 * own per-check default) was far too small for a real Test Plan command — a
 * production build, a booted app, an end-to-end check — so a genuinely slow
 * command was recorded as a false `timeout` for lack of budget, never for
 * lack of correctness.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 900_000

export function resolveCommandTimeoutMs(): number {
  return loadConfig()?.report?.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
}

export type GroupCCommandResult = { command: string; output: string; exitCode: number | null; timedOut: boolean }
export type GroupC = { commands: GroupCCommandResult[] }

/**
 * The `[agent]` command lines out of the PR body's Test Plan section — the
 * first fenced block found there, one command per non-blank line, with the
 * `→ <observable>` half of each line stripped off. Empty (no commands) for
 * the `unit-tests-only` sentinel, a body with no Test Plan section at all,
 * or a Test Plan with no fenced block (the pre-#387 checkbox shape) — in
 * every one of those cases there is nothing for this group to run.
 */
export function extractAgentCommandLines(prBody: string): string[] {
  const located = locateTestPlanSection(prBody)
  if (!located.found) return []
  if (/unit-tests-only/i.test(located.section)) return []
  const blocks = extractFencedBlocks(located.section)
  const first = blocks[0]
  if (!first) return []
  return first.content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

/** Strips a line's trailing `→ <observable>` (if any), leaving the command alone. */
export function agentCommandText(line: string): string {
  const idx = line.indexOf('→')
  return (idx === -1 ? line : line.slice(0, idx)).trim()
}

/**
 * GitHub's PR-body size limit (`updatePullRequest`'s GraphQL mutation) is
 * ~65536 characters for the whole body, not per command — a single §9 item
 * that runs the repo's full test suite can emit output orders of magnitude
 * past that alone. Each command's captured output is kept to its own last
 * `AGENT_COMMAND_OUTPUT_MAX_CHARS`, since the observable a §9 item states
 * (`→ summary line ends "0 fail"`) is conventionally the tail of the run,
 * never the head — never silently dropped, marked when cut. Kept the tail,
 * not the whole run (task 1, #397): task `12` measured a `47` KB PR body
 * from six-command §9 lists whose full output rode into `AEG:EVIDENCE`
 * uncut at `4_000` chars each; `renderGroupC` below puts the pass/fail
 * status first in the block, so cutting the tail harder never costs the one
 * fact a reviewer actually reads first.
 */
const AGENT_COMMAND_OUTPUT_MAX_CHARS = 600

function truncateAgentOutput(output: string): string {
  if (output.length <= AGENT_COMMAND_OUTPUT_MAX_CHARS) return output
  const cut = output.length - AGENT_COMMAND_OUTPUT_MAX_CHARS
  return `[... ${cut} earlier characters truncated ...]\n${output.slice(-AGENT_COMMAND_OUTPUT_MAX_CHARS)}`
}

/**
 * Runs one command from the repo root via `bash -c`, capturing stdout+stderr
 * together (most of these commands are CLI invocations that report their
 * real result on either stream, and Group C's job is to show what actually
 * happened, not to pre-judge which stream mattered). A command that exceeds
 * `timeoutMs` (default `resolveCommandTimeoutMs()`, O5) is recorded with the
 * budget it exceeded, never silently dropped from the block and never a
 * bare, budget-less `timeout` string.
 *
 * Spawned with `buildCheckEnv(undefined)` — the same baseline `runner.ts`
 * gives every registered check (`PATH`/`LANG`/`HOME`/proxy vars/`TMPDIR`
 * only) — never the bare `spawnSync` default of the full `process.env`
 * (Principal ruling, PR `open-1` addendum). This command's text came from a
 * PR body; nothing in `AEG:EVIDENCE`'s trust model lets a body author choose
 * what secrets its own §9 line can read, so `GH_TOKEN`/`GITHUB_TOKEN` never
 * reach it.
 */
export function runAgentCommand(command: string, timeoutMs: number = resolveCommandTimeoutMs()): GroupCCommandResult {
  const proc = spawnSync('bash', ['-c', command], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: buildCheckEnv(undefined)
  })
  if (proc.error && (proc.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    return { command, output: `timeout (budget ${timeoutMs}ms)`, exitCode: null, timedOut: true }
  }
  const output = truncateAgentOutput(`${proc.stdout ?? ''}${proc.stderr ?? ''}`.trim())
  return { command, output, exitCode: proc.status, timedOut: false }
}

/** Extracts the command list from `prBody` and runs each one — the one place this module actually executes PR-body content. */
export function computeGroupC(prBody: string): GroupC {
  return { commands: extractAgentCommandLines(prBody).map((line) => runAgentCommand(agentCommandText(line))) }
}

/** True when any Group C command timed out or exited non-zero — folded into this command's overall exit code exactly like a failing Group B gate. */
export function groupCFailed(groupC: GroupC): boolean {
  return groupC.commands.some((c) => c.timedOut || (c.exitCode !== null && c.exitCode !== 0))
}

/**
 * Group C, each command rendered as a `#### C<n>: \`<command>\`` heading
 * followed by its OWN fenced output block — never one shared fence over
 * every command's output (Principal ruling, PR `open-2`). A single fence
 * with `$ <command>` lines between outputs was ambiguous: a command whose
 * own output happens to start a line with `$ ` (`bun run test`'s own
 * `$ turbo test` progress line, among others) was indistinguishable from a
 * genuine next command — `evidence-fresh`'s attested comparison found FIVE
 * commands in a four-command §9 list. A heading is a delimiter output
 * cannot forge: `evidence-fresh` reads the `#### C<n>:` lines only, never a
 * fence's contents, so what a command prints is no longer load-bearing for
 * where one command ends and the next begins.
 */
export function renderGroupC(groupC: GroupC): string {
  if (groupC.commands.length === 0) {
    return ['### Group C — Test Plan commands', '', '(no [agent] commands in the Test Plan section)'].join('\n')
  }
  const blocks = groupC.commands.map((c, i) => {
    const status = c.timedOut ? '[timeout]' : c.exitCode !== 0 ? `[exit ${c.exitCode}]` : null
    // Status FIRST (task 5, #397): the one fact a reviewer reads is
    // pass/fail, and a tail-truncated 600-char block should never bury it
    // below output text — put it at the top of the fence, not the bottom.
    const output = [...(status ? [status] : []), c.output].join('\n')
    return [`#### C${i + 1}: \`${c.command}\``, '', '```', output, '```'].join('\n')
  })
  return ['### Group C — Test Plan commands', '', blocks.join('\n\n')].join('\n')
}

/**
 * The `Summary:` line — column 0, one space, case-sensitive, immediately under
 * `Head:` (Issue #189).
 *
 * Derived from the very numstat two lines below it, so a PR body never needs a
 * hand-written "four files changed" sentence that a later commit silently
 * falsifies — measured to have gone stale three times on `atta-labs/vinaya#185`.
 *
 * The VALUE is emitted inside an inline code span, and that is load-bearing
 * rather than cosmetic. `body-bare-digits` runs from a `pull_request_target`
 * checkout of the default branch, so a digit exemption added on a branch is not
 * in force for the pull request that adds it — the first body to use it is
 * judged by a checker that has never heard of it. A backticked value is blanked
 * by `maskCode`, which every released version of that check already runs, so
 * this line needs no exemption at all and works on every checker, old and new.
 *
 * `check-evidence-fresh` byte-compares the whole line, backticks included,
 * locating it through `summaryLineIndex` on the masked view.
 */
function buildBlockInner(
  groupA: GroupA,
  gateOutcomes: GateOutcome[],
  groupC: GroupC,
  gradedBodySource: GradedBodySource
): string {
  return [
    `Head: ${groupA.head}`,
    `${EVIDENCE_SUMMARY_PREFIX}\`${summariseNumstat(groupA.numstat)}\``,
    '',
    renderGroupA(groupA),
    '',
    renderGroupB(gateOutcomes, gradedBodySource),
    '',
    renderGroupC(groupC)
  ].join('\n')
}

/**
 * Replaces the content between the REAL, non-fenced `AEG:EVIDENCE` anchor
 * pair in `body`, in place — found via `anchoredRegionBounds`'s masked
 * search, never a raw `indexOf`. A raw `indexOf` finds whichever copy of the
 * marker text comes first, fenced decoy included; a PR body that quotes a
 * worked example of its own anchor (this command's own test plan evidence
 * does exactly that) would get its replacement written into the quoted
 * example instead of the real field — found live, in this task's own PR
 * body, before this fix. Appends a fresh anchored pair at the end when the
 * body carries no REAL pair yet (first adoption) — a body with only a fenced
 * decoy is "no real pair" by the same rule.
 */
export class DivergentEvidenceAnchorError extends Error {
  constructor() {
    super(
      'the AEG:EVIDENCE anchor resolves differently before and after normalisation — a zero-width character or an HTML entity inside a marker makes this writer and the checks that read the block disagree about which pair is real. Remove it and re-run.'
    )
    this.name = 'DivergentEvidenceAnchorError'
  }
}

export function replaceEvidenceBlock(body: string, blockInner: string): string {
  // The writer is the third consumer of this anchor, and it cannot adopt the
  // readers' offsets: it must splice into the raw body it was handed, and
  // normalisation is not length-preserving. What it can do is refuse when the
  // raw and normalised resolutions disagree about whether a real pair exists —
  // which is precisely the channel Issue #189 closes on the reader side. Left
  // unchecked, a body with a zero-width character in its START marker gets a
  // SECOND block appended here while `body-bare-digits` treats the first,
  // hand-written one as the trusted region.
  if (!ScanContext.from(body).rawResolutionAgrees('EVIDENCE')) throw new DivergentEvidenceAnchorError()

  const full = `${EVIDENCE_START}\n${blockInner}\n${EVIDENCE_END}`
  const bounds = anchoredRegionBounds(body, 'EVIDENCE')
  if (bounds) {
    return `${body.slice(0, bounds.outerStart)}${full}${body.slice(bounds.outerEnd)}`
  }
  const sep = body.length === 0 || body.endsWith('\n') ? '' : '\n'
  return `${body}${sep}\n${full}\n`
}

/**
 * `AEG:TOKENS` — the second block `--write` fills, alongside `AEG:EVIDENCE`.
 * Unlike Evidence, this one has APPEND semantics: a Developer re-entry after
 * `CHANGES_REQUESTED` reports again, and `aeg-root/tranche-model.md` §12 is
 * explicit that a second report is a second row — "never a sum, never an
 * overwrite" — with the tranche total derived at read time
 * (`sum-ledger.ts`). `replaceEvidenceBlock`'s replace-in-place model is
 * therefore the wrong one to copy here; see this task's brief (#270) for why.
 *
 * The anchors are deliberately sited INSIDE the `## Token report` heading
 * this repo's own PR template already carries — `body-bare-digits-logic.ts`'s
 * `blankTokenReportSection` already blanks that whole heading's content,
 * unconditionally, before the bare-digit scan ever runs. Anchoring inside a
 * region a sibling check already exempts needs no new exemption of any kind,
 * which is the point: `body-bare-digits-logic.ts` stays untouched, and #189
 * (a still-open exemption/verification coupling failure) never has a new
 * instance to reopen.
 *
 * `TOKEN_REPORT_HEADING`/`HEADING_LINE` intentionally duplicate
 * `blankTokenReportSection`'s own heading/section-bound regexes rather than
 * importing them (that module is out of this task's surface, and neither
 * regex is exported) — the region this writer creates must be exactly the
 * region that check later blanks, so the two definitions are kept
 * byte-identical on purpose.
 */
const TOKENS_START = '<!-- AEG:TOKENS:START -->'
const TOKENS_END = '<!-- AEG:TOKENS:END -->'
const TOKEN_REPORT_HEADING = /^#{1,6}\s*token report\s*$/i
const HEADING_LINE = /^#{1,6}\s/
const TOKEN_TABLE_HEADER = '| Phase | Role | Agent/Model | Tokens in | Tokens out | Cost | Date |'
const TOKEN_TABLE_SEPARATOR = '|---|---|---|---|---|---|---|'

/**
 * Locate the real (non-fenced) `AEG:TOKENS` anchor pair, if one exists —
 * masked-search, same discipline `anchoredRegionBounds` uses for the other
 * anchored fields, so a decoy copy pasted into this PR's own Test Plan
 * evidence (a fenced paste of "the resulting block", exactly what this
 * task's own Test Plan asks the Developer to do) can never be mistaken for
 * the real block. Per-line comparison against the masked view: `maskCode`
 * blanks fenced/inline code to same-length spaces without touching line
 * structure, so a decoy line never equals the literal anchor text after
 * masking, while the real anchor (never fenced) always does.
 */
function tokensBlockLineBounds(maskedLines: string[]): { startIdx: number; endIdx: number } | null {
  const startIdx = maskedLines.findIndex((l) => l.trim() === TOKENS_START)
  if (startIdx === -1) return null
  for (let i = startIdx + 1; i < maskedLines.length; i++) {
    if ((maskedLines[i] as string).trim() === TOKENS_END) return { startIdx, endIdx: i }
  }
  return null
}

/** Whether `body` carries a real (non-fenced) `AEG:TOKENS` pair — `spliceIntoLiveBody`'s guard for whether appending a row is safe. */
function hasTokensAnchor(body: string): boolean {
  return tokensBlockLineBounds(maskCode(body).split('\n')) !== null
}

/**
 * Splices `addition` (one new table row) into `body`'s `AEG:TOKENS` block —
 * appending immediately before the closing
 * anchor when a real block already exists, or creating a fresh one
 * (sited inside the `## Token report` heading section when present, appended
 * at the end of the body otherwise) when it doesn't. Never edits an existing
 * row: append semantics per §12, enforced by construction — there is no
 * code path here that touches a byte before the closing anchor.
 */
export function writeTokensBlock(body: string, addition: string): string {
  const rawLines = body.split('\n')
  const maskedLines = maskCode(body).split('\n')
  const additionLines = addition.split('\n')

  const existing = tokensBlockLineBounds(maskedLines)
  if (existing) {
    const before = rawLines.slice(0, existing.endIdx)
    const after = rawLines.slice(existing.endIdx)
    return [...before, ...additionLines, ...after].join('\n')
  }

  const freshBlock = [TOKENS_START, TOKEN_TABLE_HEADER, TOKEN_TABLE_SEPARATOR, ...additionLines, TOKENS_END]

  const headingIdx = rawLines.findIndex((l) => TOKEN_REPORT_HEADING.test(l))
  if (headingIdx !== -1) {
    let sectionEnd = rawLines.length
    for (let i = headingIdx + 1; i < rawLines.length; i++) {
      if (HEADING_LINE.test(rawLines[i] as string)) {
        sectionEnd = i
        break
      }
    }
    const before = rawLines.slice(0, headingIdx + 1)
    const after = rawLines.slice(sectionEnd)
    return [...before, '', ...freshBlock, '', ...after].join('\n')
  }

  const sep = body.length === 0 || body.endsWith('\n') ? [] : ['']
  return [...rawLines, ...sep, '', '## Token report', '', ...freshBlock, ''].join('\n')
}

/**
 * `<n>` out of a `task/<tranche>/<n>` branch name — the `<task-id>` half of
 * the `<task-id>: develop` phase convention (`types.ts`'s `LedgerRow.phase`
 * doc: e.g. `9: develop`). Falls back to the raw branch name for anything
 * that doesn't match (a manual run off another branch) rather than
 * refusing — a wrong-shaped phase string is still legible and re-pivotable,
 * and refusing here would block the Evidence half of this command over a
 * Token-report-only concern.
 */
function derivePhase(): string {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const m = /^task\/[^/]+\/(.+)$/.exec(branch)
  const taskId = m ? m[1] : branch || 'unknown'
  return `${taskId}: develop`
}

function isoToday(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Named in the refusal below rather than left to the reader: both routes out
 * of `no-transcript-resolved` are real, and neither is a fallback to a blank
 * row.
 *
 * Deliberately says nothing about what else was written. This constant is
 * composed inside `collectTokensAddition`, which writes no file — a sentence
 * here claiming the Evidence block was written would be true only because
 * one caller happens to write it, which is the same shape of unearned claim
 * this whole change exists to remove (code review, PR #369). The caller
 * states that, where it is the caller's own fact.
 */
const TOKEN_ROW_REMEDY = [
  'Nothing here established that this host cannot meter — only that this session resolved no',
  'transcript of its own. Report real figures by naming your own transcript:',
  '',
  '  vinaya pr report --write <body-file> --transcript <path>',
  '',
  'or, on a host whose usage arrives by some other means, format figures you already hold with:',
  '',
  '  vinaya tokens --phase "<task-id>: develop" --role Developer --in <tokens-in> --out <tokens-out>',
  '',
  'and transcribe them into the `## Token report` table. That command prints a `Tokens:` line, not',
  'a table row — the table takes | Phase | Role | Agent/Model | Tokens in | Tokens out | Cost | Date |,',
  'and a line inside the block that does not start with `|` truncates the table for every row after it.'
].join('\n')

/**
 * Either the `AEG:TOKENS` row to append, or a refusal to append one. A
 * discriminated union rather than a nullable string because the caller must
 * not be able to splice "no row" into the block as an empty line: the two
 * outcomes carry different obligations (write the row / print the refusal and
 * exit non-zero), and the type is what enforces that both are handled.
 */
export type TokensAddition = { collected: true; row: string } | { collected: false; refusal: string }

/**
 * Collects real usage figures via the same `resolveMeteringCapability` probe
 * `vinaya tokens` uses, and renders the `AEG:TOKENS` addition — never a
 * fabricated `0/0/—` row (`bin/report-tokens.ts`'s own throw-rather-than-guess
 * discipline, which must survive here too). Three outcomes, not two:
 *
 *   - **Capable** — a real row.
 *   - **Incapable, `no-transcript-resolved`** — REFUSES (Issue #365). That
 *     reason covers "no pointer file at all" and "a pointer that could not be
 *     corroborated as this session's": both mean this session has no wiring of
 *     its own, and neither means this host cannot produce usage figures. A
 *     blank-celled row here would assert the latter, which
 *     `aeg-root/roles/developer.md` reserves for the host-has-no-usage case
 *     alone — the misrepresentation that doc names in its own words. The
 *     caller writes Evidence anyway and exits non-zero; see `prReportCommand`.
 *   - **Incapable, any other reason** (`pointer-unusable`,
 *     `transcript-unreadable`, `transcript-empty`) — the all-`—` row carrying
 *     the probe's `reason` inline in the Agent/Model cell, unchanged. There a
 *     pointer this session OWNS was reached — its id matches, or it sits at
 *     this project's own pointer path (`resolvePointer`'s error arms set
 *     `oursByLocation`, never `corroborated`, and say so themselves) — and the
 *     figures still could not be, so the row states a fact the probe actually
 *     established, and `token-collection-wired` already flags it as the wiring
 *     defect it is.
 */
export function collectTokensAddition(opts: {
  phase: string
  role: string
  date: string
  transcriptPath?: string
  modelOverride?: string
}): TokensAddition {
  const capability = resolveMeteringCapability(realDeps(), opts.transcriptPath)
  if (!capability.capable) {
    if (capability.reason === 'no-transcript-resolved') {
      return {
        collected: false,
        refusal: `${meteringRefusalMessage('vinaya pr report', capability)}\n\n${TOKEN_ROW_REMEDY}`
      }
    }
    // The reason rides inside the Agent/Model cell, never a sibling line: a
    // second line here that doesn't start with `|` breaks `parseTableSection`'s
    // contiguous row scan for every row appended after it (found live —
    // a first incapable row followed by a later real row silently
    // truncated `parseTokenReportEntries` to one row). One line per row,
    // always, is what keeps append-then-round-trip sound.
    return {
      collected: true,
      row: formatTokenReportRow({
        phase: opts.phase,
        role: opts.role,
        summary: null,
        modelOverride: `— (${capability.reason})`,
        date: opts.date
      })
    }
  }
  return {
    collected: true,
    row: formatTokenReportRow({
      phase: opts.phase,
      role: opts.role,
      summary: capability.summary,
      modelOverride: opts.modelOverride,
      date: opts.date
    })
  }
}

/**
 * The body `--write` writes: Evidence always, the token row only when one was
 * collected. Split out of `prReportCommand` so the invariant that matters
 * most here — a refused token row never costs the caller its Evidence block —
 * is a directly testable fact rather than a claim about a function that ends
 * in `process.exit`.
 */
export function composeWrittenBody(existing: string, blockInner: string, tokens: TokensAddition): string {
  const withEvidence = replaceEvidenceBlock(existing, blockInner)
  return tokens.collected ? writeTokensBlock(withEvidence, tokens.row) : withEvidence
}

/**
 * Thrown by `spliceIntoLiveBody` when the live PR body carries no real
 * `AEG:EVIDENCE` pair. `replaceEvidenceBlock` itself APPENDS a fresh pair in
 * that case — the right behaviour for `--write`'s local draft, which starts
 * from `aeg-root/templates/pr-report-template.md` and is expected to grow the
 * pair on first adoption. A LIVE, already-open PR body with no pair is a
 * different fact: the template's Evidence section was never carried into the
 * opened body, which is malformed per `aeg-root/roles/developer.md`'s PR-body
 * canonical form. `--push` must never paper over that by silently appending —
 * appending here would let a PR open without the section its own review gates
 * assume, then have `--push` manufacture one no reviewer ever saw form.
 */
export class MissingEvidenceAnchorError extends Error {
  constructor() {
    super(
      'the live PR body carries no AEG:EVIDENCE anchor pair. `--push` never appends one the way `--write` ' +
        'does for a fresh local draft — a live PR body without the pair is malformed. Add the `## Evidence` ' +
        'section (see aeg-root/templates/pr-report-template.md) to the PR body first, then re-run --push.'
    )
    this.name = 'MissingEvidenceAnchorError'
  }
}

export type SpliceResult = { body: string; tokensSpliced: boolean }

/**
 * The `--push` counterpart to `composeWrittenBody`: splices the freshly-built
 * Evidence/Tokens content into a LIVE forge body rather than a local draft.
 * Refuses — writes nothing — under the two conditions that make splicing
 * unsafe: the raw/normalised anchor resolutions disagree (`replaceEvidenceBlock`'s
 * own `DivergentEvidenceAnchorError`, checked here up front so the caller
 * never proceeds to `gh pr edit` on a body it cannot correctly locate), or the
 * live body has no real `EVIDENCE` pair at all (`MissingEvidenceAnchorError`,
 * above — checked separately because `replaceEvidenceBlock` would otherwise
 * silently append rather than refuse).
 *
 * `AEG:TOKENS` gets the SAME no-pair guard as `AEG:EVIDENCE`, but a softer
 * outcome: `composeWrittenBody`/`writeTokensBlock` would otherwise CREATE a
 * fresh `AEG:TOKENS` pair (correct for `--write`'s local draft, which starts
 * from the template and is expected to grow the pair on first adoption — see
 * `MissingEvidenceAnchorError`'s doc comment for why that's wrong for a LIVE
 * body). Creating one here would show up as "drift" outside the two regions
 * `bodiesAgreeOutsideRegions` is supposed to police — false drift, since this
 * command authored it, but drift a reviewer diffing the push could still
 * mistake for an unrelated change. So when the live body carries no real
 * `AEG:TOKENS` pair, the token splice is skipped entirely — `EVIDENCE` alone
 * is spliced, and the caller learns this via `tokensSpliced: false` so its
 * own success message never claims a write that didn't happen.
 */
export function spliceIntoLiveBody(live: string, blockInner: string, tokens: TokensAddition): SpliceResult {
  if (!ScanContext.from(live).rawResolutionAgrees('EVIDENCE')) throw new DivergentEvidenceAnchorError()
  if (anchoredRegionBounds(live, 'EVIDENCE') === null) throw new MissingEvidenceAnchorError()
  const withEvidence = replaceEvidenceBlock(live, blockInner)
  // `withEvidence`, not `live`: the Evidence splice is what this function has
  // already produced, and it is the body the token splice will actually be
  // applied to. Testing `live` asks whether the anchor existed in a body that
  // is no longer the one being written — the two agree today only because
  // `replaceEvidenceBlock` happens not to touch the `AEG:TOKENS` pair, which
  // is an invariant of another function, not of this decision.
  if (!tokens.collected || !hasTokensAnchor(withEvidence)) return { body: withEvidence, tokensSpliced: false }
  return { body: writeTokensBlock(withEvidence, tokens.row), tokensSpliced: true }
}

/** Removes the first real `AEG:<field>` anchored region (markers included) from `body`, or returns `body` unchanged when none is found — `anchoredRegionBounds` already does the masked, decoy-blind search. */
function stripAnchoredRegion(body: string, field: AnchorField): string {
  const bounds = anchoredRegionBounds(body, field)
  return bounds ? body.slice(0, bounds.outerStart) + body.slice(bounds.outerEnd) : body
}

/**
 * The `--push` self-verification predicate: with the `AEG:EVIDENCE` and
 * `AEG:TOKENS` regions removed from both, are `before` and `after` the exact
 * same bytes? These are the only two regions a `--push` run is authorized to
 * change (`aeg-root/roles/developer.md`'s frozen-body rule); anything else
 * differing means the edit clobbered content it had no business touching — a
 * whole-body overwrite racing a Principal's `[principal]` tick, a line-ending
 * conversion round-tripped through the forge, or a bug in this command.
 * `prReportCommand`'s `--push` path calls this on the pre-edit and the
 * re-fetched post-edit body and restores the pre-edit body on a `false`
 * result rather than letting the mismatch stand.
 *
 * `AEG:TOKENS` isn't one of `anchoredRegionBounds`'s six `AnchorField`s (it's
 * this module's own, append-only anchor — see `writeTokensBlock`'s doc
 * comment), so its region is found the same masked-line way that function
 * already does, via `tokensBlockLineBounds`, rather than through
 * `anchoredRegionBounds`.
 */
function stripTokensRegion(body: string): string {
  const rawLines = body.split('\n')
  const bounds = tokensBlockLineBounds(maskCode(body).split('\n'))
  if (!bounds) return body
  return [...rawLines.slice(0, bounds.startIdx), ...rawLines.slice(bounds.endIdx + 1)].join('\n')
}

export function bodiesAgreeOutsideRegions(before: string, after: string): boolean {
  const strip = (b: string) => stripTokensRegion(stripAnchoredRegion(b, 'EVIDENCE'))
  return strip(before) === strip(after)
}

/**
 * This command's exit code: non-zero when the gate run failed, when the token
 * row was refused, or both — one non-zero exit either way, never two reasons
 * competing for it.
 *
 * Pulled out as its own pure, exported function for the reason `anyGateFailed`
 * was: `prReportCommand` ends in `process.exit`, so the computation is
 * otherwise reachable only through a real subprocess run, and an inline
 * expression there is invisible to the unit suite — the exact mutation-survivor
 * gap this module's own doc comment records (code review, PR #369).
 */
export function prReportExitCode(opts: { gatesFailed: boolean; tokensRefused: boolean }): number {
  return opts.gatesFailed || opts.tokensRefused ? 1 : 0
}

export type ReportResult = {
  block: string
  blockInner: string
  gatesFailed: boolean
  gateOutcomes: GateOutcome[]
  groupC: GroupC
}

/**
 * Builds the evidence block. Pure w.r.t. its inputs: `groupA`, `gateRunner`
 * and `groupC` are all overridable so this is testable without touching a
 * real git repo, spawning the real gate suite, or running real subprocess
 * commands — see the module doc's "Recursion" note. `body` (default
 * `process.env.PR_BODY ?? ''`) is what Group C's command list is extracted
 * from; the caller (`prReportCommand`) always has a more specific body in
 * hand (the `--write` draft file, or the `--push` live fetch) and passes it
 * explicitly rather than relying on this default.
 */
export async function buildReport(
  opts: {
    groupA?: GroupA
    gateRunner?: GateRunner
    body?: string
    groupC?: GroupC
    gradedBodySource?: GradedBodySource
  } = {}
): Promise<ReportResult> {
  const groupA = opts.groupA ?? computeGroupA()
  const gateRunner = opts.gateRunner ?? runRealGates
  const gateResult = await gateRunner()
  const gradedBody = opts.body ?? process.env.PR_BODY ?? ''
  const gradedBodySource = opts.gradedBodySource ?? 'ambient'
  // O6 (found live 2026-09-04, misread on PR #409): this gate run happens
  // while the OLD AEG:EVIDENCE block is still the live/on-disk body —
  // `evidence-fresh` necessarily grades that stale block against a fresh
  // recompute and reports `fail`, even though the block this very Group B is
  // part of is about to replace it. Pasting that `fail` into Group B reads
  // as a live red on the PR a reviewer is looking at, when it is actually a
  // fact about the body BEFORE this write, not after. Excluded from both the
  // rendered outcomes and `gatesFailed` — a self-referential staleness
  // artifact must not itself redden a report that is otherwise clean.
  const outcomes = gateResult.outcomes
    .filter((o) => o.name !== 'evidence-fresh')
    .map((o) => (shouldRenderAsSkipped(o, gradedBody) ? { ...o, status: 'skipped' } : o))
  const groupC = opts.groupC ?? computeGroupC(gradedBody)
  const blockInner = buildBlockInner(groupA, outcomes, groupC, gradedBodySource)
  const block = `${EVIDENCE_START}\n${blockInner}\n${EVIDENCE_END}`
  return {
    block,
    blockInner,
    gatesFailed: anyGateFailed(outcomes) || groupCFailed(groupC),
    gateOutcomes: outcomes,
    groupC
  }
}

const USAGE =
  'Usage: vinaya pr report [--write <body-file> | --push <pr> [--body-file <path>]] [--phase <phase>] ' +
  '[--role <role>] [--model <id>] [--transcript <path>]'

/** `gh pr edit <pr> --body-file <path>` via a scratch file — no shell, no long argv body. `mkdtempSync`, matching `forge-write.ts`'s own scratch-file discipline, rather than a pid/timestamp name in the shared tmp root. */
function ghEditBody(pr: string, body: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-pr-report-push-'))
  const tmp = join(dir, 'body.md')
  writeFileSync(tmp, body)
  try {
    gh(['pr', 'edit', pr, '--body-file', tmp])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * `testOverrides.gateRunner`, when passed, replaces the real subprocess gate
 * runner `buildReport` would otherwise default to — the same injection seam
 * `buildReport` itself exposes, threaded one layer further out so a test can
 * prove THIS function's own env-setting statements (not just `buildReport`'s)
 * without shelling out to the real `vinaya check --all --diff-only`. Absent
 * in every real invocation; `index.ts` never passes it.
 */
export async function prReportCommand(args: string[], testOverrides?: { gateRunner?: GateRunner }): Promise<void> {
  const writeIdx = args.indexOf('--write')
  const writePath = writeIdx !== -1 ? args[writeIdx + 1] : undefined
  const pushIdx = args.indexOf('--push')
  const pushPr = pushIdx !== -1 ? args[pushIdx + 1] : undefined
  // (`#543`, O6) `--body-file <path>` names the
  // local file that IS the whole body source for this push — every byte of
  // it, not only the freshly regenerated AEG:EVIDENCE/AEG:TOKENS blocks,
  // reaches the forge (`composeWrittenBody`, the SAME whole-body composer
  // `--write` alone already uses). Valid only alongside `--push`: it names
  // what to push, and `--write` alone has no forge target for it to reach.
  const bodyFileIdx = args.indexOf('--body-file')
  const bodyFilePath = bodyFileIdx !== -1 ? args[bodyFileIdx + 1] : undefined
  const transcriptIdx = args.indexOf('--transcript')
  const transcriptPath = transcriptIdx !== -1 ? args[transcriptIdx + 1] : undefined
  const phaseIdx = args.indexOf('--phase')
  const phaseOverride = phaseIdx !== -1 ? args[phaseIdx + 1] : undefined
  const roleIdx = args.indexOf('--role')
  const roleOverride = roleIdx !== -1 ? args[roleIdx + 1] : undefined
  const modelIdx = args.indexOf('--model')
  const modelOverride = modelIdx !== -1 ? args[modelIdx + 1] : undefined

  if (writeIdx !== -1 && !writePath) {
    console.error(USAGE)
    process.exit(2)
  }
  if (pushIdx !== -1 && !pushPr) {
    console.error(USAGE)
    process.exit(2)
  }
  if (pushPr && !/^\d+$/.test(pushPr)) {
    // Catches a flag value swallowed as the PR number (e.g. a stray
    // `--transcript` with no path) before it ever reaches `gh pr view`,
    // which would otherwise surface as an opaque forge error instead of a
    // clean usage refusal.
    console.error(`vinaya pr report: refused — \`--push ${pushPr}\` is not a PR number.\n${USAGE}`)
    process.exit(2)
  }
  if (writePath && pushPr) {
    console.error(`vinaya pr report: refused — --write and --push are mutually exclusive.\n${USAGE}`)
    process.exit(2)
  }
  if (bodyFileIdx !== -1 && !bodyFilePath) {
    console.error(USAGE)
    process.exit(2)
  }
  if (bodyFilePath && !pushPr) {
    console.error(`vinaya pr report: refused — --body-file only applies alongside --push.\n${USAGE}`)
    process.exit(2)
  }
  if (bodyFilePath && !existsSync(bodyFilePath)) {
    console.error(`vinaya pr report: refused — --body-file ${bodyFilePath} does not exist.\n${USAGE}`)
    process.exit(2)
  }

  // `--push` fetches the LIVE body up front — it is the input the splice
  // targets, never a local file — and exports it (with PR_NUMBER and BRANCH)
  // before the gate run below, so Group B's own `evidence-fresh` check
  // actually compares against this PR's real state instead of silently
  // skipping for want of `PR_NUMBER` (the gap the manual sequence this
  // command replaces left open — see `aeg-root/roles/developer.md`).
  let preEditBody: string | undefined
  if (pushPr) {
    try {
      preEditBody = gh(['pr', 'view', pushPr, '--json', 'body', '-q', '.body'])
    } catch (err) {
      console.error(
        `vinaya pr report: refused — could not fetch PR ${pushPr}'s live body: ${err instanceof Error ? err.message : String(err)}`
      )
      process.exit(1)
    }
    process.env.PR_BODY = preEditBody
    process.env.PR_NUMBER = pushPr
    process.env.BRANCH = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  }

  // (`#543` O6) `--body-file` names the actual source this push grades and
  // sends — never the stale live body fetched just above, which exists
  // here only so the live-splice branch (no `--body-file`) has something to
  // splice into.
  const bodyFileSource = bodyFilePath !== undefined ? readFileSync(bodyFilePath, 'utf8') : undefined
  if (bodyFileSource !== undefined) {
    process.env.PR_BODY = bodyFileSource
  }

  // Read BEFORE `buildReport()`, not after: Group C extracts its command
  // list from the body it is given, and the `--write` local draft is the
  // one body this command can read for that purpose before its own write
  // happens. `--push` already has `preEditBody`; the stdout-only path (no
  // flag) falls back to `buildReport`'s own `PR_BODY` env default.
  const existingForWrite =
    writePath === undefined ? undefined : existsSync(writePath) ? readFileSync(writePath, 'utf8') : ''

  // `--write` forwards the drafted body and branch to Group B the same way
  // `--push` does above — set right before the gate run, so `runRealGates`'s
  // `env: { ...process.env }` spread (read at call time, not construction
  // time) picks these up. No `PR_NUMBER`: there is no pull request yet, and
  // a `requiresOpenPr` check must keep skipping honestly rather than reading
  // a fake number.
  if (writePath !== undefined) {
    process.env.PR_BODY = existingForWrite
    process.env.BRANCH = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  }

  const gradedBodySource: GradedBodySource =
    bodyFileSource !== undefined ? 'push-from-file' : pushPr ? 'push' : writePath !== undefined ? 'write' : 'ambient'

  let result: ReportResult
  try {
    result = await buildReport({
      body: bodyFileSource ?? preEditBody ?? existingForWrite,
      gradedBodySource,
      gateRunner: testOverrides?.gateRunner
    })
  } catch (err) {
    if (err instanceof UnresolvableMergeBaseError || err instanceof GitCommandError) {
      // Refuse — write nothing, print nothing that looks like a block.
      // See that class's doc comment: an unresolvable base is an
      // infrastructure failure, and writing an empty Group A here would
      // silently claim "verified: no changes" for "never verified anything."
      console.error(`vinaya pr report: refused — ${err.message}`)
      process.exit(1)
    }
    throw err
  }

  // A refused token row must not cost the caller its Evidence block.
  // `aeg-root/roles/developer.md` makes this command's exit code the
  // Developer's pre-open verification run, and states that a red gate still
  // writes the block and exits non-zero — so refusing here means withholding
  // the row and exiting non-zero, never aborting before the write. Aborting
  // would leave every unwired host unable to populate Evidence at all.
  let tokensRefused = false
  if (pushPr && bodyFileSource !== undefined) {
    // (`#543` O6) The whole local body — every byte of it, never only the
    // regenerated blocks — replaces the live body outright. `composeWrittenBody`
    // is the SAME whole-body composer `--write` alone already uses (source +
    // freshly regenerated Evidence/Tokens); the only difference here is the
    // destination (the forge, via `gh pr edit`) rather than a local file.
    const tokens = collectTokensAddition({
      phase: phaseOverride ?? derivePhase(),
      role: roleOverride ?? 'Developer',
      date: isoToday(),
      transcriptPath,
      modelOverride
    })
    const composed = composeWrittenBody(bodyFileSource, result.blockInner, tokens)

    await runBodyChecks(
      composed,
      process.env.BRANCH ?? '',
      Number(pushPr),
      `vinaya pr report --push ${pushPr} --body-file ${bodyFilePath}`
    )

    try {
      ghEditBody(pushPr, composed)
    } catch (err) {
      console.error(
        `vinaya pr report: refused — \`gh pr edit ${pushPr}\` failed: ${err instanceof Error ? err.message : String(err)}. Nothing was pushed.`
      )
      process.exit(1)
    }

    let postEditBody: string
    try {
      postEditBody = gh(['pr', 'view', pushPr, '--json', 'body', '-q', '.body'])
    } catch (err) {
      console.error(
        `vinaya pr report: pushed to PR ${pushPr} but could not re-read its live body to self-verify: ${err instanceof Error ? err.message : String(err)}. Inspect PR ${pushPr} by hand — this command could not confirm the push landed cleanly.`
      )
      process.exit(1)
    }
    if (postEditBody !== composed) {
      console.error(
        `vinaya pr report: PR ${pushPr}'s live body, re-read after the push, does not byte-match what was sent — inspect it by hand (a forge-side normalisation, or a concurrent edit, may be the cause).`
      )
    }

    if (!tokens.collected) tokensRefused = true
    process.stdout.write(`Pushed the whole body from ${bodyFilePath} to PR ${pushPr}\n`)
    if (!tokens.collected) {
      console.error(`${tokens.refusal}\n\nThe AEG:EVIDENCE block was still pushed to PR ${pushPr}.`)
    }
  } else if (pushPr) {
    const tokens = collectTokensAddition({
      phase: phaseOverride ?? derivePhase(),
      role: roleOverride ?? 'Developer',
      date: isoToday(),
      transcriptPath,
      modelOverride
    })
    let spliced: SpliceResult
    try {
      spliced = spliceIntoLiveBody(preEditBody as string, result.blockInner, tokens)
    } catch (err) {
      // Refuse before writing anything — no tmp file, no `gh pr edit`.
      console.error(`vinaya pr report: refused — ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }

    // O1 (task 17): the outgoing spliced bytes go through the SAME registry
    // runner `pr create`/`pr edit` do before `gh pr edit` ever sees them —
    // refuses (never returns) on a finding, so a body `pr report --push`
    // sends is a body CI's own `vinaya-checks.yml`/`vinaya-body-checks.yml`
    // also accepts.
    await runBodyChecks(spliced.body, process.env.BRANCH ?? '', Number(pushPr), `vinaya pr report --push ${pushPr}`)

    try {
      ghEditBody(pushPr, spliced.body)
    } catch (err) {
      console.error(
        `vinaya pr report: refused — \`gh pr edit ${pushPr}\` failed: ${err instanceof Error ? err.message : String(err)}. Nothing was pushed.`
      )
      process.exit(1)
    }

    let postEditBody: string
    try {
      postEditBody = gh(['pr', 'view', pushPr, '--json', 'body', '-q', '.body'])
    } catch (err) {
      console.error(
        `vinaya pr report: pushed to PR ${pushPr} but could not re-read its live body to self-verify: ${err instanceof Error ? err.message : String(err)}. Inspect PR ${pushPr} by hand — this command could not confirm the push landed cleanly.`
      )
      process.exit(1)
    }

    if (!bodiesAgreeOutsideRegions(preEditBody as string, postEditBody)) {
      try {
        ghEditBody(pushPr, preEditBody as string)
      } catch (err) {
        // The restore itself failed — the live PR body is now the SPLICED
        // (bad) content, with no forge-side copy of the pre-edit body left to
        // point at. Write the pre-edit body to a durable scratch file and
        // name its path, rather than telling the reader to scroll up for "the
        // pre-edit copy above" (which isn't a copy of anything they can feed
        // back into `gh pr edit` without retyping it by hand).
        const dir = mkdtempSync(join(tmpdir(), 'vinaya-pr-report-push-restore-failed-'))
        const savePath = join(dir, 'pre-edit-body.md')
        writeFileSync(savePath, preEditBody as string)
        console.error(
          `vinaya pr report: self-verification FAILED on PR ${pushPr} AND the restore of its pre-edit body also failed: ${err instanceof Error ? err.message : String(err)}. PR ${pushPr}'s body may now be corrupted — the pre-edit body was saved to ${savePath}; restore it by hand with \`gh pr edit ${pushPr} --body-file ${savePath}\`.`
        )
        process.exit(1)
      }
      console.error(
        `vinaya pr report: refused — self-verification FAILED: PR ${pushPr}'s live body changed outside the AEG:EVIDENCE/AEG:TOKENS regions after the push. Restored the pre-edit body. Inspect this command and PR ${pushPr} for drift before retrying.`
      )
      process.exit(1)
    }

    if (!spliced.tokensSpliced && tokens.collected) {
      console.error(
        `vinaya pr report: PR ${pushPr}'s live body carries no AEG:TOKENS anchor pair — the token row was withheld rather than creating one via --push (only --write's local draft creates a fresh pair; see aeg-root/templates/pr-report-template.md). The AEG:EVIDENCE block was still pushed to PR ${pushPr}.`
      )
    }

    if (spliced.tokensSpliced) {
      process.stdout.write(`Pushed AEG:EVIDENCE and AEG:TOKENS blocks to PR ${pushPr}\n`)
    } else {
      if (!tokens.collected) tokensRefused = true
      process.stdout.write(`Pushed AEG:EVIDENCE block to PR ${pushPr}\n`)
      if (!tokens.collected) {
        console.error(`${tokens.refusal}\n\nThe AEG:EVIDENCE block was still pushed to PR ${pushPr}.`)
      }
    }
  } else if (writePath) {
    const existing = existingForWrite ?? ''
    const tokens = collectTokensAddition({
      phase: phaseOverride ?? derivePhase(),
      role: roleOverride ?? 'Developer',
      date: isoToday(),
      transcriptPath,
      modelOverride
    })
    writeFileSync(writePath, composeWrittenBody(existing, result.blockInner, tokens))
    if (tokens.collected) {
      process.stdout.write(`Wrote AEG:EVIDENCE and AEG:TOKENS blocks to ${writePath}\n`)
    } else {
      tokensRefused = true
      process.stdout.write(`Wrote AEG:EVIDENCE block to ${writePath}\n`)
      // The Evidence half is the CALLER's fact — this is the only place that
      // knows a file was written, and to which path. `TOKEN_ROW_REMEDY` says
      // nothing about it on purpose; see its doc comment.
      console.error(`${tokens.refusal}\n\nThe AEG:EVIDENCE block was still written to ${writePath}.`)
    }
  } else {
    process.stdout.write(`${result.block}\n`)
  }

  process.exit(prReportExitCode({ gatesFailed: result.gatesFailed, tokensRefused }))
}
