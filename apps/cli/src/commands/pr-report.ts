import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { anchoredRegionBounds } from '@attalabs/aeg-core'
import { packageRoot } from '../lib/package-root.js'

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
 * would have to interpret or word. Every line is a command's output,
 * verbatim; normalised only to strip non-deterministic noise (durations)
 * that would make two runs at the same sha differ byte-for-byte for no
 * reason.
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
 */

const EVIDENCE_START = '<!-- AEG:EVIDENCE:START -->'
const EVIDENCE_END = '<!-- AEG:EVIDENCE:END -->'

// Array-form execFileSync — no shell, so no injection surface.
function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
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
 * nothing. Round 1 of this PR fixed that collapse for the merge-base only;
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
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
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
 * sides independently produce `''` — found in review, round 1 of this PR: an
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
 * `check-no-disk-state.ts`, `check-closes-n.ts`, `check-single-plan-pr.ts`),
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
 * width-invariant `--numstat` diff between them. Throws
 * `UnresolvableMergeBaseError` when `head` resolves but no base does — see
 * that class's doc comment. `head` itself resolving to `''` (not a git repo,
 * or an unborn branch) is a separate, pre-existing condition this leaves
 * unchanged: there is no HEAD to diff against at all, so `base`/`numstat`
 * stay `''` rather than attempting a base resolution that has nothing to
 * resolve against.
 */
export function computeGroupA(): GroupA {
  // Every step throws rather than degrading. An unborn branch (no commits
  // yet, so `rev-parse HEAD` fails) previously short-circuited BOTH ternaries
  // below, so `resolveMergeBase` was never reached and nothing refused — the
  // emitter wrote an empty head and an empty Group A and exited 0. That is
  // the round-1 BLOCKER's shape reached by a different door.
  const head = gitStrict(['rev-parse', 'HEAD'])
  const base = resolveMergeBase(head)
  const numstat = gitStrict(['diff', `${base}...${head}`, '--numstat'])
  return { head, base, numstat }
}

export type GateOutcome = { name: string; status: string; errors: { severity: string; message: string }[] }
export type GateRunResult = { outcomes: GateOutcome[]; failed: boolean }
export type GateRunner = () => GateRunResult | Promise<GateRunResult>

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
  const proc = Bun.spawnSync([process.execPath, entry, 'check', '--all', '--diff-only', '--json'], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'ignore'
  })
  const stdout = new TextDecoder().decode(proc.stdout)
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
 * `origin/main` having actually resolved against `main` (found in review,
 * round 1). `compareEvidenceBlock` never parses this line — only the fenced
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

/** Group B, rendered inside its fenced block — name/status/message only, no durations or cache-status lines, so two runs at the same sha are byte-identical. Sorted by name for determinism independent of registry order or completion order. */
function renderGroupB(outcomes: GateOutcome[]): string {
  const sorted = [...outcomes].sort((a, b) => a.name.localeCompare(b.name))
  const lines = sorted.flatMap((o) => {
    const rows = [`${o.name}: ${o.status}`]
    for (const e of o.errors) rows.push(`  ${e.severity}: ${e.message}`)
    return rows
  })
  return ['### Group B — attested', '', '`vinaya check --all --diff-only`', '', '```', lines.join('\n'), '```'].join(
    '\n'
  )
}

function buildBlockInner(groupA: GroupA, gateOutcomes: GateOutcome[]): string {
  return [`Head: ${groupA.head}`, '', renderGroupA(groupA), '', renderGroupB(gateOutcomes)].join('\n')
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
export function replaceEvidenceBlock(body: string, blockInner: string): string {
  const full = `${EVIDENCE_START}\n${blockInner}\n${EVIDENCE_END}`
  const bounds = anchoredRegionBounds(body, 'EVIDENCE')
  if (bounds) {
    return `${body.slice(0, bounds.outerStart)}${full}${body.slice(bounds.outerEnd)}`
  }
  const sep = body.length === 0 || body.endsWith('\n') ? '' : '\n'
  return `${body}${sep}\n${full}\n`
}

export type ReportResult = { block: string; blockInner: string; gatesFailed: boolean; gateOutcomes: GateOutcome[] }

/**
 * Builds the evidence block. Pure w.r.t. its inputs: `groupA` and
 * `gateRunner` are both overridable so this is testable without touching a
 * real git repo or spawning the real gate suite — see the module doc's
 * "Recursion" note.
 */
export async function buildReport(opts: { groupA?: GroupA; gateRunner?: GateRunner } = {}): Promise<ReportResult> {
  const groupA = opts.groupA ?? computeGroupA()
  const gateRunner = opts.gateRunner ?? runRealGates
  const gateResult = await gateRunner()
  const blockInner = buildBlockInner(groupA, gateResult.outcomes)
  const block = `${EVIDENCE_START}\n${blockInner}\n${EVIDENCE_END}`
  return { block, blockInner, gatesFailed: gateResult.failed, gateOutcomes: gateResult.outcomes }
}

export async function prReportCommand(args: string[]): Promise<void> {
  const writeIdx = args.indexOf('--write')
  const writePath = writeIdx !== -1 ? args[writeIdx + 1] : undefined

  if (writeIdx !== -1 && !writePath) {
    console.error('Usage: vinaya pr report [--write <body-file>]')
    process.exit(2)
  }

  let result: ReportResult
  try {
    result = await buildReport()
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

  if (writePath) {
    const existing = existsSync(writePath) ? readFileSync(writePath, 'utf8') : ''
    const updated = replaceEvidenceBlock(existing, result.blockInner)
    writeFileSync(writePath, updated)
    process.stdout.write(`Wrote AEG:EVIDENCE block to ${writePath}\n`)
  } else {
    process.stdout.write(`${result.block}\n`)
  }

  process.exit(result.gatesFailed ? 1 : 0)
}
