import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { promisify } from 'node:util'
import {
  type AnchorField,
  anchoredRegionBounds,
  extractFencedBlocks,
  formatTokenReportRow,
  locateTestPlanSection,
  type MeteringCapability,
  resolveMeteringCapability
} from '@attalabs/aeg-core'
import { maskCode } from '@attalabs/aeg-forge-state/strip-code'
import { coreCheckRegistry } from '../checks/registry'
import { buildCheckEnv } from '../checks/runner'
import { ScanContext } from '../checks/scan-context'
import { loadConfig } from './config'
import { type DispatchTeeRecovery, realDispatchTeeRecoveryDeps, recoverUsageFromDispatchTee } from './dispatch.js'
import { collectBodyCheckErrors } from './forge-write.js'
import { EVIDENCE_SUMMARY_PREFIX, summariseNumstat } from './numstat'
import { packageRoot } from './package-root.js'
import { ensureRunDir, runPath, runtimeDirForThisRepo } from './run-paths.js'
import { meteringRefusalMessage, realDeps } from '../commands/tokens'

/**
 * The `AEG:EVIDENCE`/`AEG:TOKENS` engine — every function that computes, or
 * writes, the two anchored blocks `aeg-root/roles/developer.md`'s PR-body
 * canonical form describes. Moved out of `apps/cli/src/commands/pr-report.ts`:
 * a COMMAND (`apps/cli/src/commands/pr-report.ts`'s
 * `prReportCommand`, argv-parsing and console I/O only) and the loop's own
 * driver (`apps/cli/src/lib/dev-review-loop.ts`) both need this engine, and a
 * command never calls a command (`apps/cli/specs/surface.md`'s "the rule") —
 * so the shared logic lives in `apps/cli/src/lib/`, imported by both, rather
 * than the loop shelling out to `vinaya pr report --push` as a subprocess.
 * `pr-report.ts` re-exports every name below under its own path, so no
 * existing import elsewhere in this codebase needed to change.
 *
 * `--write` also fills a second, independent block: `AEG:TOKENS`, real
 * usage figures collected the same way `vinaya tokens` collects them
 * (`resolveMeteringCapability`), rendered into the `## Token report`
 * heading's table. Unlike Evidence, re-entry APPENDS a row rather than
 * replacing the block — see `writeTokensBlock`'s doc comment and this
 * task's own brief for why. Cost is always `—` by design (no maintained
 * pricing table). A session whose OWN wiring was reached but failed — a pointer
 * whose id matches, or one at this project's own pointer path — gets an
 * all-`—` row carrying the probe's reason inline (Agent/Model cell),
 * never a fabricated `0/0/—`; a session that resolved no transcript at all
 * gets NO row and a refusal (`collectTokensAddition`) — the
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
 * necessarily invokes `--write`, and that suite itself runs under
 * `bunx turbo test` — so a test case that let `--write` shell out to the
 * real gate suite would make an already-running test run touch the CLI's own
 * build/network-dependent checks from inside itself, which is slow,
 * environment-coupled, and not what a *unit* test for this engine's
 * formatting logic should depend on. `buildReport` therefore takes an
 * injectable `gateRunner` (default: the real subprocess runner below); the
 * test suite passes a fake one. There is no `--no-gates` CLI flag — every
 * real `vinaya pr report --write` always runs the real gates, because the
 * emitted block claiming a gate result IS the gate result; a flag that let a
 * real invocation skip that would reopen the gap this engine exists to close.
 *
 * **`cwd`.** Every git/check/Test-Plan-command read below
 * (`computeGroupA`, `runRealGates`, `runAgentCommand`/`computeGroupC`) takes
 * an explicit `cwd`, threaded from `buildReport`'s own `opts.cwd` (default
 * `process.cwd()`). The CLI command runs from the Developer's own worktree,
 * so `process.cwd()` was always correct for it and stays the default; the
 * loop's driver runs from the REPO ROOT, not the task's worktree
 * (`.worktrees/<branch>`) — a bare `process.cwd()` read from there would
 * diff and gate-check the wrong checkout entirely. The driver passes its
 * task worktree's path explicitly instead. Never a `process.chdir()`: the
 * driver dispatches this report in parallel with two reviewer dispatches
 * (`Promise.all`), and a process-global `chdir` racing a concurrent spawn
 * that omits its own `cwd` would corrupt whichever one starts second.
 */

const EVIDENCE_START = '<!-- AEG:EVIDENCE:START -->'
const EVIDENCE_END = '<!-- AEG:EVIDENCE:END -->'

// `node:child_process`'s async `execFile`, promisified — never
// `execFileSync`/`spawnSync`. Bun 1.2.14's synchronous spawn kept spinning
// the event loop while it waited, which incidentally let other concurrent
// work (a sibling reviewer dispatch, another spawned child's own exit)
// interleave; Bun 1.4.2's synchronous spawn genuinely blocks the single
// thread, so every read this module performs while running inside the
// loop's own `Promise.all` (`dev-review-loop.ts`) must be a real async
// child, or it starves whichever dispatch is racing it. No shell, so no
// injection surface — same discipline the removed `execFileSync` calls had.
const execFileAsync = promisify(execFile)

// `env: { ...process.env }` explicit on every call below — the same reason
// `runRealGates`'s own spawn already carries it (see that function's doc
// comment): Bun resolves the child EXECUTABLE's own PATH lookup from a
// cached environment when `env` is omitted, not from `process.env` read at
// call time, so a runtime `process.env.PATH` mutation (a test's fake `gh`/
// `git` on a prepended directory) is silently ignored without this.
async function git(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { encoding: 'utf8', env: process.env, cwd })
    return stdout.trim()
  } catch {
    return ''
  }
}

/** Array-form async `execFile` against `gh` — same no-shell discipline as `git()`, but throws (rather than collapsing to `''`) since a `--push` run must never mistake a failed forge call for an empty answer. Mirrors `review-post.ts`'s `gh()`. `gh` resolves the repo from the git remote, which is identical whether the caller's cwd is the main checkout or one of its worktrees — so, unlike `git()`/`gitStrict()`, this never needs an explicit `cwd`. */
export async function gh(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('gh', args, { encoding: 'utf8', env: process.env })
    return stdout.trim()
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
 * nothing. An earlier fix covered the merge-base only;
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
async function gitStrict(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { encoding: 'utf8', env: process.env, cwd })
    return stdout.trim()
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
 * sides independently produce `''` — found in review: an
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
 * `main`: a bare local fixture (this engine's own test setup, and several
 * existing `apps/cli/tests/*.test.ts` fixtures) has neither, and both
 * `git merge-base` calls fail outright there. When every tried ref fails,
 * this throws `UnresolvableMergeBaseError` rather than returning `''` — see
 * that class's doc comment for why silently degrading to an empty base is
 * the wrong failure mode.
 */
export async function resolveMergeBase(head: string, cwd?: string): Promise<string> {
  const primary = process.env.BASE_SHA || 'origin/main'
  const tried = primary === 'main' ? [primary] : [primary, 'main']
  for (const ref of tried) {
    const base = await git(['merge-base', ref, head], cwd)
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
export async function computeGroupA(cwd?: string): Promise<GroupA> {
  // Every step throws rather than degrading. An unborn branch (no commits
  // yet, so `rev-parse HEAD` fails) previously short-circuited BOTH ternaries
  // below, so `resolveMergeBase` was never reached and nothing refused — the
  // emitter wrote an empty head and an empty Group A and exited 0. That is
  // the same fail-open shape, reached by a different door.
  const head = await gitStrict(['rev-parse', 'HEAD'], cwd)
  const base = await resolveMergeBase(head, cwd)
  const numstat = await gitStrict(['diff', `${base}...${head}`, '--numstat'], cwd)
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
 * same silent shape a genuine pass has (a real incident: `pr-report-density`
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

/**
 * The real gate runner: shells to this CLI's own `check --all --diff-only
 * --json`, from `cwd` (default `process.cwd()` — see this module's doc
 * comment, "`cwd`"). `env` (default `process.env`, read at call time — see
 * the comment on the spawn call below) is the base the child's own
 * `PR_BODY`/`PR_NUMBER`/`BRANCH` are read from; a caller running inside a
 * long-lived, concurrent process (the loop's driver — never a one-shot CLI
 * invocation, which safely mutates its own `process.env` before calling
 * this) passes an explicit overlay object here instead of mutating the
 * shared `process.env` binding, so a reviewer/security dispatch running at
 * the same time in that same process never observes this call's PR context.
 */
export async function runRealGates(cwd?: string, env?: NodeJS.ProcessEnv): Promise<GateRunResult> {
  const entry = resolveSelfEntry()
  // `node:child_process`, not `Bun.spawn`: this package ships a
  // `#!/usr/bin/env node` bin with `engines.node >= 20`, so a `Bun.*` call
  // here is a `ReferenceError: Bun is not defined` for every adopter running
  // the published CLI under node — Group B could never run for them. It
  // failed closed (the ReferenceError escapes the narrowed catch below
  // before any write), so no false attestation could be published.
  let stdout = ''
  try {
    const result = await execFileAsync(process.execPath, [entry, 'check', '--all', '--diff-only', '--json'], {
      cwd: cwd ?? process.cwd(),
      // Explicit, and load-bearing under Bun — not merely clearer than omitting
      // the key. A one-shot CLI invocation (`--push`) sets `PR_BODY`/
      // `PR_NUMBER`/`BRANCH` by mutating its OWN `process.env` just before this
      // call, safely, since that process does nothing else concurrently. Node
      // propagates a runtime `process.env` mutation into a child that
      // inherits the parent environment; Bun does not — its child sees the
      // environment the process started with, so under Bun the
      // omitted-key form would hand the gate child a `PR_BODY` that is stale
      // or absent, and every body-reading gate in Group B would grade the
      // wrong text (or skip). Spreading `env ?? process.env` here reads the
      // caller's intended values at call time and passes them explicitly,
      // which is correct on both runtimes, and never touches the caller's own
      // `process.env` when an explicit overlay is given.
      env: { ...(env ?? process.env) },
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    })
    stdout = result.stdout
  } catch (err) {
    // `check --all --diff-only` exits non-zero when a check fails — that is
    // its normal, expected shape here, not a spawn failure. `execFile`
    // rejects on any non-zero exit, but still attaches the captured stdout
    // to the error, which is the same JSON payload `spawnSync` used to hand
    // back on `proc.stdout` regardless of `proc.status`.
    stdout = (err as { stdout?: string }).stdout ?? ''
  }
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
 * Group C — the `[agent]` half of the Test Plan (task 12; per a Principal
 * ruling: an agent never ticks a box or edits a PR body). The
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

export type GroupCCommandResult = {
  command: string
  output: string
  exitCode: number | null
  timedOut: boolean
  /** True when the command's captured stdout+stderr exceeded `runAgentCommand`'s own buffer budget — Node kills the child on either a timeout OR a maxBuffer overflow, so this is checked and reported BEFORE `timedOut`, never folded into it. */
  overflowed: boolean
  /** Set only when this result was reused from a prior green run against the identical head, working tree and command — names the run it reused rather than silently re-presenting cached output as freshly run. `undefined` for every command this call actually executed. */
  reusedFrom?: string
}
export type GroupC = { commands: GroupCCommandResult[] }

/**
 * One prior GREEN run of a Test-plan command, keyed by the exact command
 * text, the head it ran against, the working tree's content at that moment,
 * and the machine it ran on — a result is reused only when
 * all four still match, so a stale, cross-branch, or cross-machine result
 * can never masquerade as evidence for a run that never happened.
 */
export type TestRunCacheRecord = {
  output: string
  exitCode: 0
  timedOut: false
  overflowed: false
  recordedAt: string
  source: 'pre-push' | 'pr-report'
  /**
   * The test files this run covered, when it was a `bun test <files>`
   * invocation (`bunTestFileArgs`) — set only on the STATE-keyed
   * file-coverage record `FILE_COVERAGE_PREFIX` reads and writes, never on
   * the exact-command-keyed record `testRunCacheKey`
   * addresses: that record's own key already encodes the command text, so a
   * second, redundant file list on it would never be read. Absolute,
   * resolved paths (`resolveFileSet`) — comparable against a later Test-plan
   * command's own resolved file arguments regardless of which relative form
   * either command happened to spell them in. On a coverage record carrying
   * `runs`, this top-level field mirrors the MOST RECENT run only — every
   * run's own files, individually, live in `runs`.
   */
  files?: string[]
  /**
   * Every distinct green `bun test <files>` run ever recorded at this exact
   * state (head/tree/machine), oldest first — set only on the file-coverage
   * record. A round-2 review finding: writing a SECOND run at the same
   * state used to overwrite the coverage record wholesale, discarding a
   * broader run's file list (the pre-push hook's own wide selection, most
   * often) the moment ANY later, narrower `bun test <files>` command ran at
   * the same head/tree — so a file that had already proven green minutes
   * earlier, in the very same `pr report` invocation, was silently forced
   * to re-run because the run that covered it was gone. `runs` is what
   * fixes that: every run's own {files, output} stays independently
   * queryable, so a later command missing one run's coverage can still
   * match an EARLIER one — {@link findCoveringRun} — rather than only ever
   * the most recent. A reuse never synthesizes output by merging two runs'
   * text together: it always names ONE real run that alone covers every
   * file the command asks for, never a composite no run actually produced.
   */
  runs?: FileCoverageRun[]
}

/** One entry in a file-coverage record's own `runs` history — the minimal shape {@link findCoveringRun} matches a request against. */
export type FileCoverageRun = {
  files: string[]
  output: string
  recordedAt: string
  source: 'pre-push' | 'pr-report'
}

/** A place a green Test-plan run can be looked up and recorded — `get`/`set` rather than a bare object so a test can inject an in-memory stand-in without touching disk. */
export type TestRunCache = {
  get: (key: string) => TestRunCacheRecord | undefined
  set: (key: string, record: TestRunCacheRecord) => void
}

/**
 * The cache's leaf file, read and written directly — never through
 * `mkdirNoSymlinks` (a DIRECTORY check; this is one file) — so both halves
 * close their own symlink gap by hand (round-4 security review, HIGH/MEDIUM):
 * on a shared, configurable `runtimeDir` a co-tenant able to write anywhere
 * under it (never this process's own already-hardened directories, only
 * files) could pre-plant a SYMLINK at this exact leaf path. A plain
 * `writeFileSync` would follow it and overwrite whatever it points at (the
 * WRITE half); a plain `readFileSync` would follow it and silently trust
 * whatever JSON sits there as a real cached run — the exact "evidence that
 * cannot be traced to a real run" O3 exists to rule out (the READ half).
 * This cache never creates a symlink at its own path itself, so — the same
 * reasoning `mkdirNoSymlinks` already applies to a directory segment — one
 * found there is refused rather than followed, on both sides:
 *
 *   - Read: `lstatSync` first, UNFOLLOWED; anything other than a real file
 *     (a symlink, a directory, nothing at all) reads as "no cache yet"
 *     rather than being opened.
 *   - Write: a temp file under a fresh, per-call random name — which cannot
 *     itself be a pre-planted symlink, since it never existed before this
 *     call — then `renameSync` into place, mirroring
 *     `control-store/local.ts`'s own `atomicWriteFile`. `rename` REPLACES
 *     whatever sits at the destination — a real file or a symlink — without
 *     ever opening or following it, so a planted symlink is atomically
 *     swapped out for a real file rather than written through.
 */
function readTestRunCacheFile(path: string): Record<string, TestRunCacheRecord> {
  try {
    if (!lstatSync(path).isFile()) return {}
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, TestRunCacheRecord>
  } catch {
    return {}
  }
}

function writeTestRunCacheFile(path: string, all: Record<string, TestRunCacheRecord>): void {
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`
  const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
  try {
    writeSync(fd, JSON.stringify(all, null, 2), null, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

/**
 * A `TestRunCache` backed by one JSON file, read-modify-written whole on
 * every `set` — the file is small (one entry per distinct command/head/tree
 * combination actually run) and writes are infrequent (once per Test-plan
 * command that finishes green), so a heavier per-key store buys nothing here.
 * `runtimeDir` is threaded through only for `ensureRunDir`'s own
 * ownership/mode re-assertion on the containing directory, matching every
 * other run-file writer in this codebase (`run-paths.ts`) — the leaf file
 * itself is guarded separately, above.
 */
export function fileBackedTestRunCache(path: string, runtimeDir: string): TestRunCache {
  return {
    get: (key) => readTestRunCacheFile(path)[key],
    set: (key, record) => {
      const all = readTestRunCacheFile(path)
      all[key] = record
      ensureRunDir(dirname(path), runtimeDir)
      writeTestRunCacheFile(path, all)
    }
  }
}

/**
 * The default cache location for a live process: this repository's own
 * runtime directory, always `'unscoped'` — deliberately NOT scoped by PR
 * number (round-3 security review, MEDIUM). A PR-scoped path looked
 * reasonable in isolation, but the pre-push hook's own writer
 * (`pre-push-cache-test-run.ts`) never has a PR number to set — it runs at
 * push time, often before a PR even exists — so it always wrote the
 * unscoped file while `pr report --push` on a real open PR set `PR_NUMBER`
 * and read/wrote a DIFFERENT, PR-scoped one: two files for the same repo
 * state, so a run the hook already proved green was never found by the
 * primary real-PR evidence path. The cache key itself (`testRunCacheKey`)
 * already disambiguates every dimension that matters — head, working tree,
 * command, machine — so a second axis of separation by PR number was never
 * load-bearing for correctness, only for tidiness; one shared file per repo
 * is what actually delivers "in the pre-push hook or an earlier pr report"
 * reuse for every caller, not just the ones that happen to agree on a PR
 * number.
 */
export function defaultTestRunCache(): TestRunCache {
  const runtimeDir = runtimeDirForThisRepo()
  const path = runPath(runtimeDir, 'unscoped', { area: 'output', file: 'test-run-cache.json' })
  return fileBackedTestRunCache(path, runtimeDir)
}

/**
 * `git()` (this module's shared helper) collapses ANY failure — a real "no
 * output" AND a broken pipe, a lock, a missing binary — to the same `''`,
 * which is correct for its other callers but wrong here: this function's own
 * job is telling "the repo has no changes" apart from "the repo could not be
 * read", and folding both into `''` let a transient git failure produce a
 * cache key indistinguishable from a real one (round-2 security review,
 * HIGH) — two different heads or working trees that both hit the failure on
 * the same command would collide and reuse each other's output. `null` means
 * "could not resolve, don't know" and is never hashed into a key; only a
 * REAL zero-exit run — even one whose own stdout happens to be empty —
 * reaches the caller as a string.
 */
async function gitOrNull(args: string[], cwd?: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { encoding: 'utf8', env: process.env, cwd })
    return stdout.trim()
  } catch {
    return null
  }
}

/**
 * Everything that makes a prior run of `command` reusable for THIS one: the
 * exact command text, the head it would run against, a hash of the working
 * tree's own content, and the machine running it — `null` when any of that
 * cannot be established, which the caller must treat as "skip the cache
 * entirely for this call" (round-2 security review, HIGH — see
 * {@link gitOrNull}).
 *
 * The working-tree hash covers tracked changes (`git diff HEAD`), every
 * UNTRACKED file's own content (a status listing alone would miss a file
 * whose content changed while its path stayed the same), and — `--ignored`
 * (round-2 security review, MEDIUM) — every IGNORED path git's own default
 * (non-`matching`) listing names, with the same per-file content hash for
 * any ignored entry that is itself a regular file (closing the `.env`/single
 * generated-file case the finding named). A large ignored DIRECTORY (most
 * commonly `node_modules`) is deliberately NOT expanded file-by-file:
 * `--ignored=matching` would force git to walk and list every file inside
 * it, and hashing that tree's full content on every cache lookup would cost
 * more than O3 exists to save. Its own path stays in the hash (from the
 * status line, and — via `MISSING`, since `readFileSync` on a directory
 * throws — from the per-entry loop below), so the directory's mere
 * presence/absence still changes the key; a content change to a file NESTED
 * inside it does not. A known, accepted gap, not a silent one.
 *
 * `-z` (round-3 security review, LOW): git's DEFAULT `--porcelain` quotes any
 * path containing a space, a double quote, or a non-ASCII byte, wrapping it
 * in `"…"` with C-style escapes — a real path read that way still carries
 * its quotes and escape sequences, so `readFileSync` on it always misses and
 * every such file silently falls back to the constant `'MISSING'` hash
 * contribution, meaning a real content edit to it never invalidates a
 * cached result. `-z` disables that quoting entirely and NUL-terminates
 * each record instead of newline-terminating it, so every path below is the
 * exact, literal one `readFileSync` needs.
 */
const NUL = String.fromCharCode(0)

/**
 * Hashes ONE field as a fixed-width (4-byte, big-endian) length prefix
 * followed by its bytes — never a bare delimiter between fields (round-5
 * security review, HIGH). A delimiter chosen from a fixed alphabet (a
 * space, a NUL) can still occur INSIDE a field whose content this function
 * does not control — `git diff HEAD`'s own output, an untracked file's own
 * name or bytes — so two genuinely different (field, field) pairs can
 * concatenate to the IDENTICAL byte stream by shifting where one field ends
 * and the next begins (e.g. status `"a b"` + diff `"c"` vs status `"a"` +
 * diff `"b c"`, joined by a bare space either way): a Test-plan command run
 * against one real state would then be served as reused evidence for a
 * DIFFERENT state that merely hashes the same, exactly the fabrication O3
 * exists to rule out. A length prefix closes this the way any
 * length-prefixed framing does: it is fixed-width, so it can never itself
 * be mistaken for field content, and it is written BEFORE the field it
 * measures, so no byte sequence can be reinterpreted as spanning a
 * different split between two fields.
 */
function hashField(hash: ReturnType<typeof createHash>, value: string | Buffer): void {
  const buf = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
  const length = Buffer.alloc(4)
  length.writeUInt32BE(buf.length, 0)
  hash.update(length)
  hash.update(buf)
}

/**
 * Everything `testRunCacheKey`/`testRunStateKey` hash, short of the command
 * text itself — split out so the two can share one git/filesystem read
 * without either owning a second, divergent copy of it: the per-file reuse
 * key must hash the identical state the exact-command key already does,
 * hostname/head/status/diff/uncommitted-file-contents alike, differing only
 * in whether the command text is one more field in the same sequence.
 * `null` propagates the same "could not resolve, don't know" refusal
 * {@link gitOrNull} already establishes for its own callers.
 */
async function collectStateFields(cwd?: string): Promise<(string | Buffer)[] | null> {
  const head = await gitOrNull(['rev-parse', 'HEAD'], cwd)
  if (!head) return null
  const status = await gitOrNull(['status', '--porcelain=v1', '-uall', '--ignored', '-z'], cwd)
  if (status === null) return null
  const diff = await gitOrNull(['diff', 'HEAD'], cwd)
  if (diff === null) return null
  const fields: (string | Buffer)[] = [hostname(), head, status, diff]
  const uncommitted = status
    .split(NUL)
    .filter((entry) => entry.startsWith('?? ') || entry.startsWith('!! '))
    .map((entry) => entry.slice(3))
    .sort()
  const base = cwd ?? process.cwd()
  for (const f of uncommitted) {
    fields.push(f)
    try {
      fields.push(readFileSync(join(base, f)))
    } catch {
      fields.push('MISSING')
    }
  }
  return fields
}

function digestFields(fields: (string | Buffer)[]): string {
  const hash = createHash('sha256')
  for (const f of fields) hashField(hash, f)
  return hash.digest('hex')
}

export async function testRunCacheKey(command: string, cwd?: string): Promise<string | null> {
  const fields = await collectStateFields(cwd)
  if (!fields) return null
  return digestFields([...fields, command])
}

/**
 * The same head/working-tree/machine state {@link testRunCacheKey} hashes,
 * WITHOUT the command text — the key a green run's per-file coverage record
 * is filed under, so a Test-plan command whose own text
 * never ran verbatim can still be matched against every `bun test <files>`
 * run recorded for this exact state, never one from a different head,
 * working tree, or machine.
 */
export async function testRunStateKey(cwd?: string): Promise<string | null> {
  const fields = await collectStateFields(cwd)
  if (!fields) return null
  return digestFields(fields)
}

/**
 * Prefixes the file-coverage record's own key so it can share one
 * `TestRunCache` (a plain string-keyed store) with the exact-command
 * records `testRunCacheKey` addresses, with no collision: a state key is a
 * bare sha256 hex digest, which never contains `:`, so prefixing it here
 * can never coincide with a real exact-command key.
 */
const FILE_COVERAGE_PREFIX = 'files:'

/**
 * The test-file arguments of a `bun test <files...>` Test-plan command — or
 * `null` when `command` isn't shaped like one at all.
 * Recognizes an optional leading `bun`, the `test` subcommand, then treats
 * every remaining whitespace-separated token as either a flag (starts with
 * `-`, including a lone `--` separator — dropped) or a file argument
 * (kept). This is a Test-plan command's own argv, not a shell parse: a
 * quoted path containing whitespace is not handled, matching both the
 * pre-push hook's own recorded command (`prePushBody`'s `VINAYA_TEST_CMD`,
 * one absolute path per selected file, space-joined, never shell-quoted)
 * and every existing `bun test <files>` Test-plan line in this repo's own
 * PRs. Returns `null` (not an empty array) when the command matches the
 * `bun test` shape but names no files at all — nothing for per-file reuse
 * to match against, same as not matching the shape in the first place.
 */
export function bunTestFileArgs(command: string): string[] | null {
  const tokens = command.trim().split(/\s+/)
  let i = 0
  if (tokens[i] === 'bun') i++
  if (tokens[i] !== 'test') return null
  i++
  const files: string[] = []
  for (; i < tokens.length; i++) {
    const t = tokens[i] as string
    if (t === '' || t === '--' || t.startsWith('-')) continue
    files.push(t)
  }
  return files.length > 0 ? files : null
}

/** Resolves every file argument against `cwd` (default `process.cwd()`) into an absolute path, deduplicated and sorted — the normal form both a recorded run's file list and a later command's requested files are compared in, so a repo-relative Test-plan argument matches the pre-push hook's own absolute-path recording of the identical file. */
function resolveFileSet(files: string[], cwd?: string): string[] {
  const base = cwd ?? process.cwd()
  return [...new Set(files.map((f) => resolvePath(base, f)))].sort()
}

/** Describes a cache hit for `reusedFrom` — names the run's own record time and source, and, for a per-file (rather than exact-command) hit, how many files it covered, so the evidence never merely says "reused" without saying what was actually verified to cover the command it stands in for. Structural (never `TestRunCacheRecord` by name) so a single `FileCoverageRun` — one real run out of a coverage record's own history — describes itself identically to a whole record. */
function describeReuse(hit: { recordedAt: string; source: string; files?: string[] }): string {
  const base = `a green run recorded ${hit.recordedAt} (${hit.source})`
  return hit.files ? `${base}, covering ${hit.files.length} file(s) including every file this command names` : base
}

/**
 * Every run a file-coverage record has ever accumulated, oldest first —
 * `record.runs` when present, or a one-element list synthesized from the
 * record's own top-level fields for a record written before `runs` existed
 * (or by a caller that never goes through {@link mergeFileCoverageRecord}).
 * `undefined`/no-`files` records (an exact-command record read by mistake
 * through this path) contribute nothing.
 */
function coverageRuns(record: TestRunCacheRecord | undefined): FileCoverageRun[] {
  if (!record) return []
  if (record.runs) return record.runs
  return record.files
    ? [{ files: record.files, output: record.output, recordedAt: record.recordedAt, source: record.source }]
    : []
}

/**
 * The one run, among a coverage record's own history, whose file list alone
 * covers every file in `requestedFiles` — or `undefined` when none does.
 * Never synthesizes a covering answer by combining two runs' file lists:
 * O1's own reuse contract is that the evidence names THE run it reused, a
 * single real execution, never a composite no run actually produced.
 */
function findCoveringRun(
  record: TestRunCacheRecord | undefined,
  requestedFiles: string[]
): FileCoverageRun | undefined {
  return coverageRuns(record).find((run) => {
    const covered = new Set(run.files)
    return requestedFiles.every((f) => covered.has(f))
  })
}

/**
 * Builds the file-coverage record a fresh green run's write should replace
 * the existing one with — round-2 review, MAJOR: the prior code simply
 * `cache.set` a brand-new record on every green `bun test <files>` run,
 * which silently discarded every EARLIER run's own coverage at the same
 * state the moment a narrower run came along, forcing a real re-run for a
 * file that had already proven green minutes earlier in the very same `pr
 * report` invocation. This appends the new run to `runs` (never drops an
 * earlier one) and keeps the top-level `files`/`output`/`recordedAt`/`source`
 * mirroring the newest run only, for a reader/caller that never looks past
 * the top level — `runs`, not the top level, is what {@link findCoveringRun}
 * actually searches.
 */
function mergeFileCoverageRecord(
  existing: TestRunCacheRecord | undefined,
  newRun: FileCoverageRun
): TestRunCacheRecord {
  return {
    output: newRun.output,
    exitCode: 0,
    timedOut: false,
    overflowed: false,
    recordedAt: newRun.recordedAt,
    source: newRun.source,
    files: newRun.files,
    runs: [...coverageRuns(existing), newRun]
  }
}

/**
 * The `[agent]` command lines out of the PR body's Test Plan section — the
 * first fenced block found there, one command per non-blank line, with the
 * `→ <observable>` half of each line stripped off. Empty (no commands) for
 * the `unit-tests-only` sentinel, a body with no Test Plan section at all,
 * or a Test Plan with no fenced block (the earlier checkbox shape) — in
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
 * not the whole run (task 1): task `12` measured a `47` KB PR body
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
 * Runs one command from `cwd` (default `process.cwd()`) via `bash -c`,
 * capturing stdout+stderr together (most of these commands are CLI
 * invocations that report their real result on either stream, and Group C's
 * job is to show what actually happened, not to pre-judge which stream
 * mattered). A command that exceeds `timeoutMs` (default
 * `resolveCommandTimeoutMs()`, O5) is recorded with the budget it exceeded,
 * never silently dropped from the block and never a bare, budget-less
 * `timeout` string.
 *
 * Spawned with `buildCheckEnv(undefined)` plus `extraEnv` — the same
 * baseline `runner.ts` gives every registered check (`PATH`/`LANG`/`HOME`/
 * proxy vars/`TMPDIR` only) — never the bare `spawnSync` default of the full
 * `process.env` (Principal ruling, PR `open-1` addendum). This command's
 * text came from a PR body; nothing in `AEG:EVIDENCE`'s trust model lets a
 * body author choose what secrets its own §9 line can read, so
 * `GH_TOKEN`/`GITHUB_TOKEN` never reach it. `extraEnv` (round 3 review,
 * F2 test-honesty) is never a secret — `PR_BODY` is the exact text this
 * command was extracted FROM, not new information the body author could
 * leverage — and is what makes a `[agent]` command that itself calls
 * `vinaya check` (reading `PR_BODY`, e.g. `closes-n`/`test-plan`) grade
 * correctly instead of always seeing an empty body and failing every
 * `requiresOpenPr` check regardless of the PR's real state: found live, this
 * exact PR's own Evidence Group C previously showed `closes-n` failing on
 * every run for this reason alone, contradicting the Test Plan's own
 * "→ exits 0" claim for a command that could never have exited 0.
 */
/**
 * The output-buffer budget `execFileAsync` is spawned with below — Node kills
 * the child the same way it does on a `timeout`, and sets `killed: true` on
 * the SAME error either way, so the overflow case must be told apart from a
 * genuine timeout BEFORE the `killed` check: Node's own
 * error carries `code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'` only for this
 * case, checked first.
 */
const AGENT_COMMAND_MAX_BUFFER_BYTES = 32 * 1024 * 1024
const MAXBUFFER_ERROR_CODE = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'

async function runOneAgentCommand(
  command: string,
  timeoutMs: number,
  cwd: string | undefined,
  extraEnv: Record<string, string>,
  maxBufferBytes: number
): Promise<GroupCCommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync('bash', ['-c', command], {
      cwd: cwd ?? process.cwd(),
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: maxBufferBytes,
      env: { ...buildCheckEnv(undefined), ...extraEnv }
    })
    const output = truncateAgentOutput(`${stdout}${stderr}`.trim())
    return { command, output, exitCode: 0, timedOut: false, overflowed: false }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string
      stderr?: string
      code?: number | string
      killed?: boolean
    }
    // Checked BEFORE `killed`: Node kills the child on a maxBuffer overflow
    // exactly as it does on a timeout, and sets `killed: true` either way —
    // only `code` tells the two apart. Reported as its own outcome, never
    // folded into `timedOut` (a command that overflowed had already produced
    // its correct result; it never ran out of TIME).
    if (e.code === MAXBUFFER_ERROR_CODE) {
      return {
        command,
        output: `output overflow (budget ${maxBufferBytes} bytes)`,
        exitCode: null,
        timedOut: false,
        overflowed: true
      }
    }
    // Node's async `timeout` option kills the child itself when it fires
    // (`subprocess.killed` true only when node's own kill call did it — never
    // when the command under test kills itself or is signalled by something
    // else), which is the async equivalent of `spawnSync`'s own
    // `error.code === 'ETIMEDOUT'` this replaces.
    if (e.killed) {
      return { command, output: `timeout (budget ${timeoutMs}ms)`, exitCode: null, timedOut: true, overflowed: false }
    }
    const output = truncateAgentOutput(`${e.stdout ?? ''}${e.stderr ?? ''}`.trim())
    return {
      command,
      output,
      exitCode: typeof e.code === 'number' ? e.code : null,
      timedOut: false,
      overflowed: false
    }
  }
}

export async function runAgentCommand(
  command: string,
  timeoutMs: number = resolveCommandTimeoutMs(),
  cwd?: string,
  extraEnv: Record<string, string> = {},
  cache?: TestRunCache,
  maxBufferBytes: number = AGENT_COMMAND_MAX_BUFFER_BYTES
): Promise<GroupCCommandResult> {
  // A command that already ran green against this EXACT
  // head, working tree and command text — in an earlier `pr report`, or the
  // pre-push hook, whichever wrote the matching record — is reused rather
  // than run again. `cache` is `undefined` for every existing caller of this
  // function (every test that calls it directly, and any future one that
  // doesn't opt in) — reuse is additive, never a behavior change for a
  // caller that never asked for it.
  const cacheKey = cache ? await testRunCacheKey(command, cwd) : null
  if (cache && cacheKey) {
    const hit = cache.get(cacheKey)
    if (hit) {
      return {
        command,
        output: hit.output,
        exitCode: 0,
        timedOut: false,
        overflowed: false,
        reusedFrom: describeReuse(hit)
      }
    }
  }
  // Per-file reuse: a Test-plan `bun test <files>` command
  // whose own text never ran verbatim still reuses a recorded green run at
  // this exact head/working-tree/machine, provided every file it names was
  // covered by that run — never a run missing even one named file, never a
  // failing/partial/cancelled run (only a green run is ever recorded, below
  // and in `recordGreenTestRun`), and never one from another machine (the
  // state key hashes `hostname()` exactly as the exact-command key does).
  const requestedFiles = cache ? bunTestFileArgs(command) : null
  let resolvedRequested: string[] | undefined
  if (cache && requestedFiles) {
    const stateKey = await testRunStateKey(cwd)
    if (stateKey) {
      const coverage = cache.get(`${FILE_COVERAGE_PREFIX}${stateKey}`)
      resolvedRequested = resolveFileSet(requestedFiles, cwd)
      const covering = findCoveringRun(coverage, resolvedRequested)
      if (covering) {
        return {
          command,
          output: covering.output,
          exitCode: 0,
          timedOut: false,
          overflowed: false,
          reusedFrom: describeReuse(covering)
        }
      }
    }
  }
  const result = await runOneAgentCommand(command, timeoutMs, cwd, extraEnv, maxBufferBytes)
  if (cache && cacheKey && result.exitCode === 0 && !result.timedOut && !result.overflowed) {
    const recordedAt = new Date().toISOString()
    cache.set(cacheKey, {
      output: result.output,
      exitCode: 0,
      timedOut: false,
      overflowed: false,
      recordedAt,
      source: 'pr-report'
    })
    if (requestedFiles) {
      const stateKey = await testRunStateKey(cwd)
      if (stateKey) {
        const coverageKey = `${FILE_COVERAGE_PREFIX}${stateKey}`
        const merged = mergeFileCoverageRecord(cache.get(coverageKey), {
          files: resolvedRequested ?? resolveFileSet(requestedFiles, cwd),
          output: result.output,
          recordedAt,
          source: 'pr-report'
        })
        cache.set(coverageKey, merged)
      }
    }
  }
  return result
}

/**
 * Records a command as a green run WITHOUT running it — for the one caller
 * that already knows it ran green, by its own separate means: the pre-push
 * hook (`pre-push-cache-test-run.ts`), whose shell already ran `bun test`
 * and captured its output before this is ever reached. This is what makes
 * the O3 reuse clause's other half real: without it, `source: 'pre-push'`
 * was a value `TestRunCacheRecord` could type but no code path ever wrote,
 * so a run the hook already proved green still re-ran the first time a `pr
 * report` built evidence for that same head (round-2 code review, BLOCKER).
 * A `null` key (see {@link testRunCacheKey}) records nothing rather than
 * guessing — an unresolvable git state is never a reason to fabricate a
 * cache entry, on this path any more than on `runAgentCommand`'s own.
 */
export async function recordGreenTestRun(
  command: string,
  output: string,
  cwd: string | undefined,
  source: 'pre-push' | 'pr-report',
  cache: TestRunCache = defaultTestRunCache()
): Promise<boolean> {
  const key = await testRunCacheKey(command, cwd)
  if (!key) return false
  const truncated = truncateAgentOutput(output)
  const recordedAt = new Date().toISOString()
  cache.set(key, { output: truncated, exitCode: 0, timedOut: false, overflowed: false, recordedAt, source })
  // The pre-push hook always calls this with the exact
  // `bun test <files>` command it just ran green — this is what makes that
  // run reusable per-file by a LATER Test-plan command naming only some of
  // the same files, never only by one naming the identical command text.
  const files = bunTestFileArgs(command)
  if (files) {
    const stateKey = await testRunStateKey(cwd)
    if (stateKey) {
      const coverageKey = `${FILE_COVERAGE_PREFIX}${stateKey}`
      const merged = mergeFileCoverageRecord(cache.get(coverageKey), {
        files: resolveFileSet(files, cwd),
        output: truncated,
        recordedAt,
        source
      })
      cache.set(coverageKey, merged)
    }
  }
  return true
}

/**
 * Extracts the command list from `prBody` and runs each one from `cwd` — the
 * one place this module actually executes PR-body content. `extraEnv`
 * (round 3 review, F2) threads `PR_BODY` (always — it is `prBody` itself,
 * the exact text these commands were extracted from) and, when the caller
 * has them, `PR_NUMBER`/`BRANCH`: a `[agent]` command that itself invokes
 * `vinaya check` needs these to grade the SAME PR the rest of this report is
 * about, never an ambient value some other repo state happened to leave
 * around.
 */
export async function computeGroupC(
  prBody: string,
  cwd?: string,
  extraEnv: Record<string, string> = {},
  cache?: TestRunCache
): Promise<GroupC> {
  // Sequential, deliberately — a `.map` into `Promise.all` would run every
  // Test-Plan command concurrently, and a §9 list is conventionally ordered
  // (build, then test, then run) with later commands depending on earlier
  // ones' side effects. Each command is still an async child (O2) — this
  // loop never blocks the event loop between commands, it only preserves the
  // original one-after-another order.
  const commands: GroupCCommandResult[] = []
  for (const line of extractAgentCommandLines(prBody)) {
    commands.push(
      await runAgentCommand(agentCommandText(line), undefined, cwd, { PR_BODY: prBody, ...extraEnv }, cache)
    )
  }
  return { commands }
}

/** True when any Group C command timed out, overflowed its output budget, or exited non-zero — folded into this command's overall exit code exactly like a failing Group B gate. */
export function groupCFailed(groupC: GroupC): boolean {
  return groupC.commands.some((c) => c.timedOut || c.overflowed || (c.exitCode !== null && c.exitCode !== 0))
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
    const status = c.overflowed
      ? '[output overflow]'
      : c.timedOut
        ? '[timeout]'
        : c.exitCode !== 0
          ? `[exit ${c.exitCode}]`
          : null
    // Status FIRST (task 5): the one fact a reviewer reads is
    // pass/fail, and a tail-truncated 600-char block should never bury it
    // below output text — put it at the top of the fence, not the bottom.
    const output = [...(status ? [status] : []), c.output].join('\n')
    // A reused result names the run it reused, right below
    // its own fence — never inside it, so the fence stays byte-identical to
    // what a fresh run of the same command would have produced.
    const reused = c.reusedFrom ? [`\n_Reused from ${c.reusedFrom} — not re-run._`] : []
    return [`#### C${i + 1}: \`${c.command}\``, '', '```', output, '```', ...reused].join('\n')
  })
  return ['### Group C — Test Plan commands', '', blocks.join('\n\n')].join('\n')
}

/**
 * The `Summary:` line — column 0, one space, case-sensitive, immediately under
 * `Head:`.
 *
 * Derived from the very numstat two lines below it, so a PR body never needs a
 * hand-written "four files changed" sentence that a later commit silently
 * falsifies — measured to have gone stale three times in production.
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
 * worked example of its own anchor (this engine's own test plan evidence
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
  // which is precisely the channel the reader-side checks already close for
  // the same zero-width-character mismatch. Left
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
 * therefore the wrong one to copy here; see this task's own brief for why.
 *
 * The anchors are deliberately sited INSIDE the `## Token report` heading
 * this repo's own PR template already carries — `body-bare-digits-logic.ts`'s
 * `blankTokenReportSection` already blanks that whole heading's content,
 * unconditionally, before the bare-digit scan ever runs. Anchoring inside a
 * region a sibling check already exempts needs no new exemption of any kind,
 * which is the point: `body-bare-digits-logic.ts` stays untouched, and the
 * still-open exemption/verification coupling failure this avoids never has a
 * new instance to reopen.
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
export async function derivePhase(): Promise<string> {
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const m = /^task\/[^/]+\/(.+)$/.exec(branch)
  const taskId = m ? m[1] : branch || 'unknown'
  return `${taskId}: develop`
}

export function isoToday(): string {
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
 * this whole change exists to remove (per code review). The caller
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
 *   - **Incapable, `no-transcript-resolved`** — REFUSES. That
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
/**
 * `resolveMeteringCapability(realDeps())` — the one call site every other
 * caller in this file already reaches through (`collectTokensAddition`,
 * below). Exported so a COMMAND (`pr create`, O7) can resolve capability
 * without importing `realDeps` from `../commands/tokens.ts` itself —
 * `apps/cli/specs/surface.md`'s own rule refuses a command calling into
 * another `commands/*.ts` file outright; routing through this lib-layer
 * wrapper keeps that call inside `apps/cli/src/lib`, where it already lived.
 */
/**
 * `resolveTokenReportCapabilityWith`'s I/O, injected the same way every
 * other deps type in this file is — the merge logic below is otherwise
 * untestable end to end (round-2 review, MAJOR finding F1): the two
 * halves — `resolveMeteringCapability` and `recoverUsageFromDispatchTee` —
 * each had unit coverage in isolation, but nothing proved the merge itself
 * (a `no-transcript-resolved` verdict plus a real recovered summary
 * actually becoming `{capable: true, ...}`) without this seam.
 */
export type TokenReportCapabilityDeps = {
  resolveMetering: (transcriptPath?: string) => MeteringCapability
  recoverFromTee: () => DispatchTeeRecovery | null
}

/** Real, production deps — `resolveMeteringCapability(realDeps())` and `recoverUsageFromDispatchTee(realDispatchTeeRecoveryDeps())`, unchanged from before this seam existed. */
export function realTokenReportCapabilityDeps(): TokenReportCapabilityDeps {
  return {
    resolveMetering: (transcriptPath) => resolveMeteringCapability(realDeps(), transcriptPath),
    recoverFromTee: () => recoverUsageFromDispatchTee(realDispatchTeeRecoveryDeps())
  }
}

/**
 * O1: tries the real probe first, exactly as before; only when it
 * comes back `no-transcript-resolved` (this session's own wiring — no
 * pointer at all — never a resolved-but-broken one) does it also try
 * `recoverUsageFromDispatchTee` before giving up. Every other verdict
 * (capable, or incapable for a different reason) passes through unchanged —
 * this never overrides a real wiring-defect diagnosis with a recovered
 * number. The pure merge, deps-injected so a test can compose both halves
 * with fakes and assert the actual branch taken.
 */
export function resolveTokenReportCapabilityWith(
  deps: TokenReportCapabilityDeps,
  transcriptPath?: string
): MeteringCapability {
  const capability = deps.resolveMetering(transcriptPath)
  if (capability.capable || capability.reason !== 'no-transcript-resolved') return capability
  const recovered = deps.recoverFromTee()
  if (!recovered) return capability
  return { capable: true, transcriptPath: recovered.teePath, summary: recovered.summary }
}

export function resolveTokenReportCapability(transcriptPath?: string): MeteringCapability {
  return resolveTokenReportCapabilityWith(realTokenReportCapabilityDeps(), transcriptPath)
}

export function collectTokensAddition(opts: {
  phase: string
  role: string
  date: string
  transcriptPath?: string
  modelOverride?: string
}): TokensAddition {
  const capability = resolveTokenReportCapability(opts.transcriptPath)
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
 * own success message never claims a write that didn't happen. Also skipped
 * entirely, by construction, when `tokens.collected` is false — the caller
 * passes `{ collected: false, refusal: '' }` on purpose when it never
 * intends to collect a token row at all (the driver's in-process call —
 * see `runReportForOpenPr`'s doc comment).
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
 * conversion round-tripped through the forge, or a bug in this engine.
 * `runReportForOpenPr`'s live-splice path calls this on the pre-edit and the
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
 * gap this module's own doc comment records (per code review).
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
 * commands — see this module's doc comment's "Recursion" note. `body`
 * (default `process.env.PR_BODY ?? ''`) is what Group C's command list is
 * extracted from; the caller (`prReportCommand`, or the loop's driver) always
 * has a more specific body in hand (the `--write` draft file, or the live
 * `--push` fetch) and passes it explicitly rather than relying on this
 * default. `opts.cwd` (default `process.cwd()`) is threaded into every git/
 * check/Test-Plan-command read — see this module's doc comment, "`cwd`".
 * `opts.envOverlay`, when given, is passed straight through to
 * `runRealGates` instead of that function's own `process.env` default — the
 * loop's driver (a long-lived, concurrent process, never a one-shot CLI
 * invocation) uses it so Group B's gate child sees this call's PR context
 * without the driver ever mutating its own `process.env` (see
 * `runRealGates`'s doc comment).
 */
export async function buildReport(
  opts: {
    groupA?: GroupA
    gateRunner?: GateRunner
    body?: string
    groupC?: GroupC
    gradedBodySource?: GradedBodySource
    cwd?: string
    envOverlay?: NodeJS.ProcessEnv
    /** Where a green Test-plan run is looked up and recorded. Defaults to this repository's own runtime directory — a test that wants isolation from that real location injects its own, an in-memory one most often. */
    testRunCache?: TestRunCache
  } = {}
): Promise<ReportResult> {
  const groupA = opts.groupA ?? (await computeGroupA(opts.cwd))
  const gateRunner = opts.gateRunner ?? (() => runRealGates(opts.cwd, opts.envOverlay))
  const gateResult = await gateRunner()
  const gradedBody = opts.body ?? process.env.PR_BODY ?? ''
  const gradedBodySource = opts.gradedBodySource ?? 'ambient'
  // O6 (found live 2026-09-04, initially misread): this gate run happens
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
  // PR_NUMBER/BRANCH: read from the SAME source Group B's gate child already
  // reads them from (`opts.envOverlay ?? process.env` — `runRealGates`'s own
  // default) rather than a third, independent source, so Group C's `[agent]`
  // commands and Group B's gates always grade the identical PR context.
  const ambientReportEnv = opts.envOverlay ?? process.env
  const groupCExtraEnv: Record<string, string> = {}
  if (ambientReportEnv.PR_NUMBER !== undefined) groupCExtraEnv.PR_NUMBER = ambientReportEnv.PR_NUMBER
  if (ambientReportEnv.BRANCH !== undefined) groupCExtraEnv.BRANCH = ambientReportEnv.BRANCH
  const groupC =
    opts.groupC ??
    (await computeGroupC(gradedBody, opts.cwd, groupCExtraEnv, opts.testRunCache ?? defaultTestRunCache()))
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

/** `gh pr edit <pr> --body-file <path>` via a scratch file — no shell, no long argv body. `mkdtempSync`, matching `forge-write.ts`'s own scratch-file discipline, rather than a pid/timestamp name in the shared tmp root. */
export async function ghEditBody(pr: string, body: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-pr-report-push-'))
  const tmp = join(dir, 'body.md')
  writeFileSync(tmp, body)
  try {
    await gh(['pr', 'edit', pr, '--body-file', tmp])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * The outcome of pushing a freshly-built Evidence/Tokens report onto an
 * OPEN pull request's LIVE body — `runReportForOpenPr`'s own return type.
 * `'ok'` is not "no gate failed"; a red gate still writes the block
 * (recording the failure honestly, `aeg-root/roles/developer.md`) — `'ok'`
 * means the PUSH ITSELF (fetch, splice, edit, self-verify) went through
 * cleanly. Every other case names exactly which step refused, mirroring the
 * distinct messages `prReportCommand`'s own `--push` branch always printed,
 * so translating an outcome back into a CLI message loses nothing (this
 * engine calls no `console.*`/`process.exit` itself — `EVIDENCE_START` and
 * this whole module doc's "Recursion" note both being test-suite-facing
 * reasons why exiting/printing must stay the CALLER's job, never the
 * engine's own).
 */
export type EvidenceReportOutcome =
  | { kind: 'ok'; tokensSpliced: boolean; tokensCollected: boolean; tokensRefusal?: string; gatesFailed: boolean }
  | { kind: 'splice-refused'; message: string }
  | { kind: 'body-checks-refused'; message: string }
  | { kind: 'edit-failed'; message: string }
  | { kind: 'reread-failed'; message: string }
  | { kind: 'drift-restore-failed'; message: string }
  | { kind: 'drift-restored'; message: string }

/**
 * `runBodyChecks` (`forge-write.ts`) refuses via `refuse()`, which is typed
 * `never` and calls `process.exit(1)` directly — there is no exception a
 * caller could ordinarily catch. `runReportForOpenPr` below runs this check
 * from inside the developer-review loop's own long-lived driver process,
 * concurrently (via `Promise.all`) with reviewer dispatch and that same
 * process's own real `SIGTERM`/`SIGINT` handlers, so that exit would kill
 * the WHOLE driver mid-round — or, if a shutdown signal happened to land
 * while some earlier version of this code had globally monkey-patched
 * `process.exit` for the call's duration, hijack that unrelated signal's
 * own real exit into a thrown error instead (round 3 review, MAJOR/HIGH:
 * patching a process-global for a concurrently-running process is exactly
 * the shared-mutable-state hazard `defaultRunEvidenceReport`'s own doc
 * comment already calls out and avoids for `process.env`). Never
 * intercepting `process.exit` at all — rather than patching it — is what
 * actually closes both hazards: `collectBodyCheckErrors` below runs the
 * SAME registry `runBodyChecks` runs and returns its findings as an
 * ordinary array instead of calling `refuse()`, so this call site simply
 * never reaches the one line that would exit the process. `runBodyChecks`
 * and `refuse()` themselves are unchanged (each now calls
 * `collectBodyCheckErrors` too, so behavior for their existing callers is
 * byte-for-byte the same): every OTHER caller (`pr.ts`'s create/edit paths,
 * `pr-report.ts`'s own `--push <n> --body-file` branch) still goes through
 * `runBodyChecks` directly and still exits the process on a refusal,
 * exactly as before.
 */
async function bodyCheckRefusalMessage(body: string, branch: string, prNumber: number): Promise<string | null> {
  const errors = await collectBodyCheckErrors(body, branch, prNumber)
  if (errors.length === 0) return null
  return `vinaya pr report: refused — ${errors.map((e) => `${e.check}: ${e.message}`).join(' | ')}`
}

/**
 * Pushes `result` (a `buildReport` output already computed against `pushPr`'s
 * live body) onto that PR — fetch-then-splice-then-self-verify, exactly the
 * sequence `prReportCommand`'s own `--push <n>` (no `--body-file`) branch
 * always ran inline. Extracted here so the loop's driver
 * calls the SAME function the CLI command calls, in-process, rather than
 * shelling out to `vinaya pr report --push` as a subprocess — `prReportCommand`
 * itself now delegates to this function too, translating its
 * `EvidenceReportOutcome` back into the exact console messages and exit code
 * it always printed.
 *
 * `opts.includeTokens` (default `true`, matching every real `--push`
 * invocation) is `false` for the driver's own call: the driver runs in its
 * OWN process/session, not the Developer's, so `collectTokensAddition`'s
 * metering probe would resolve the DRIVER's token usage, not the
 * Developer's — misattributing it under the Developer's own `<task>: develop`
 * phase row. Token reporting stays the Developer's own concern, populated at
 * PR-open time via `--write`; this task's Objectives (O1/O2) name the
 * `AEG:EVIDENCE` block only, never `AEG:TOKENS`, when describing what the
 * driver now owns. `includeTokens: false` passes `{ collected: false,
 * refusal: '' }` through to `spliceIntoLiveBody`, which already treats
 * `!tokens.collected` as "skip the token splice entirely" — no new branch
 * needed, and `tokensCollected` on the returned `'ok'` outcome is `false`
 * with no refusal message attached (never printed as a real refusal).
 * `opts.branch`, when given, is what the `runBodyChecks` call below grades
 * against instead of that call's own `process.env.BRANCH` default — the
 * loop's driver passes it explicitly so this function never reads the
 * shared `process.env` of the long-lived, concurrent process it runs in
 * (see `runRealGates`'s doc comment for the same reasoning applied to
 * Group B).
 */
export async function runReportForOpenPr(
  pushPr: string,
  preEditBody: string,
  result: ReportResult,
  opts: {
    includeTokens?: boolean
    transcriptPath?: string
    phaseOverride?: string
    roleOverride?: string
    modelOverride?: string
    branch?: string
  } = {}
): Promise<EvidenceReportOutcome> {
  const includeTokens = opts.includeTokens ?? true
  const tokens: TokensAddition = includeTokens
    ? collectTokensAddition({
        phase: opts.phaseOverride ?? (await derivePhase()),
        role: opts.roleOverride ?? 'Developer',
        date: isoToday(),
        transcriptPath: opts.transcriptPath,
        modelOverride: opts.modelOverride
      })
    : { collected: false, refusal: '' }

  let spliced: SpliceResult
  try {
    spliced = spliceIntoLiveBody(preEditBody, result.blockInner, tokens)
  } catch (err) {
    return { kind: 'splice-refused', message: err instanceof Error ? err.message : String(err) }
  }

  // O1 (task 17): the outgoing spliced bytes go through the SAME registry
  // runner `pr create`/`pr edit` do before `gh pr edit` ever sees them — a
  // body this function sends is, by construction, a body CI's own
  // `vinaya-checks.yml`/`vinaya-body-checks.yml` also accepts. Goes through
  // `collectBodyCheckErrors` rather than `runBodyChecks` itself: a refusal
  // here must return an outcome, never exit this process (see
  // `bodyCheckRefusalMessage`'s own doc comment above for why).
  const bodyCheckMessage = await bodyCheckRefusalMessage(
    spliced.body,
    opts.branch ?? process.env.BRANCH ?? '',
    Number(pushPr)
  )
  if (bodyCheckMessage !== null) {
    return { kind: 'body-checks-refused', message: bodyCheckMessage }
  }

  try {
    await ghEditBody(pushPr, spliced.body)
  } catch (err) {
    return {
      kind: 'edit-failed',
      message: `vinaya pr report: refused — \`gh pr edit ${pushPr}\` failed: ${err instanceof Error ? err.message : String(err)}. Nothing was pushed.`
    }
  }

  let postEditBody: string
  try {
    postEditBody = await gh(['pr', 'view', pushPr, '--json', 'body', '-q', '.body'])
  } catch (err) {
    return {
      kind: 'reread-failed',
      message: `vinaya pr report: pushed to PR ${pushPr} but could not re-read its live body to self-verify: ${err instanceof Error ? err.message : String(err)}. Inspect PR ${pushPr} by hand — this command could not confirm the push landed cleanly.`
    }
  }

  if (!bodiesAgreeOutsideRegions(preEditBody, postEditBody)) {
    try {
      await ghEditBody(pushPr, preEditBody)
    } catch (err) {
      const dir = mkdtempSync(join(tmpdir(), 'vinaya-pr-report-push-restore-failed-'))
      const savePath = join(dir, 'pre-edit-body.md')
      writeFileSync(savePath, preEditBody)
      return {
        kind: 'drift-restore-failed',
        message: `vinaya pr report: self-verification FAILED on PR ${pushPr} AND the restore of its pre-edit body also failed: ${err instanceof Error ? err.message : String(err)}. PR ${pushPr}'s body may now be corrupted — the pre-edit body was saved to ${savePath}; restore it by hand with \`gh pr edit ${pushPr} --body-file ${savePath}\`.`
      }
    }
    return {
      kind: 'drift-restored',
      message: `vinaya pr report: refused — self-verification FAILED: PR ${pushPr}'s live body changed outside the AEG:EVIDENCE/AEG:TOKENS regions after the push. Restored the pre-edit body. Inspect this command and PR ${pushPr} for drift before retrying.`
    }
  }

  return {
    kind: 'ok',
    tokensSpliced: spliced.tokensSpliced,
    tokensCollected: tokens.collected,
    tokensRefusal: !tokens.collected && includeTokens ? tokens.refusal : undefined,
    gatesFailed: result.gatesFailed
  }
}
