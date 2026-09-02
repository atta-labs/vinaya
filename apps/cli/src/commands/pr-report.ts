import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { anchoredRegionBounds, formatTokenReportRow, resolveMeteringCapability } from '@attalabs/aeg-core'
import { maskCode } from '@attalabs/aeg-forge-state/strip-code'
import { ScanContext } from '../checks/scan-context'
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
 * pricing table). A host whose corroborated wiring exists but cannot be read
 * gets an all-`—` row carrying the probe's reason inline (Agent/Model cell),
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
function buildBlockInner(groupA: GroupA, gateOutcomes: GateOutcome[]): string {
  return [
    `Head: ${groupA.head}`,
    `${EVIDENCE_SUMMARY_PREFIX}\`${summariseNumstat(groupA.numstat)}\``,
    '',
    renderGroupA(groupA),
    '',
    renderGroupB(gateOutcomes)
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
  'or, on a host whose usage arrives by some other means, emit the row directly and paste it into',
  'the `## Token report` table:',
  '',
  '  vinaya tokens --phase "<task-id>: develop" --role Developer --in <tokens-in> --out <tokens-out>'
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
  const transcriptIdx = args.indexOf('--transcript')
  const transcriptPath = transcriptIdx !== -1 ? args[transcriptIdx + 1] : undefined
  const phaseIdx = args.indexOf('--phase')
  const phaseOverride = phaseIdx !== -1 ? args[phaseIdx + 1] : undefined
  const roleIdx = args.indexOf('--role')
  const roleOverride = roleIdx !== -1 ? args[roleIdx + 1] : undefined
  const modelIdx = args.indexOf('--model')
  const modelOverride = modelIdx !== -1 ? args[modelIdx + 1] : undefined

  if (writeIdx !== -1 && !writePath) {
    console.error(
      'Usage: vinaya pr report [--write <body-file>] [--phase <phase>] [--role <role>] ' +
        '[--model <id>] [--transcript <path>]'
    )
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

  // A refused token row must not cost the caller its Evidence block.
  // `aeg-root/roles/developer.md` makes this command's exit code the
  // Developer's pre-open verification run, and states that a red gate still
  // writes the block and exits non-zero — so refusing here means withholding
  // the row and exiting non-zero, never aborting before the write. Aborting
  // would leave every unwired host unable to populate Evidence at all.
  let tokensRefused = false
  if (writePath) {
    const existing = existsSync(writePath) ? readFileSync(writePath, 'utf8') : ''
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
