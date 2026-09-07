/**
 * `devReviewLoop`'s Sizing verification story (dev-review-loop-v1 task 5,
 * `#415`): a fake `claude` binary on `PATH`, scripted by role
 * (`$VINAYA_ROLE`) to play the developer and both reviewers, plus fake
 * `gh`/`git` binaries answering every forge/git read the driver makes.
 * Exercised through the REAL `vinaya dev-review-loop` CLI entry point
 * (`execFileSync('bun', [INDEX, ...])`), never by importing `devReviewLoop`
 * in-process — same discipline as `apps/cli/tests/lib/dispatch.test.ts`'s
 * own doc comment explains: `config.ts`'s `GLOBAL_VINAYA_HOME` is a
 * module-level constant frozen at first import, and `dispatchRole` (called
 * for real here, unmocked, so the fake vendor binary is genuinely
 * exercised) writes through it — an in-process run sharing that constant
 * with another test file in the same `bun:test` process could pollute the
 * real developer machine's own `~/.vinaya/outbox/`. A fresh subprocess per
 * test, with its own scratch `HOME`, sidesteps that entirely.
 *
 * Two scenarios. The first is the shortest real one `assessRound` supports:
 * round 1 gates green, dispatches both reviewers fresh, both come back
 * clean (`APPROVE`/`PASS`, no findings) — `assessRound` returns `publish`.
 * This exercises dispatch-role-per-round (developer + 2 reviewers, one
 * shared fake binary distinguished by `$VINAYA_ROLE`), the findings/report
 * file grammar (Part 2), `writeHeldVerdict`, and the "nothing posted before
 * publish" invariant (`resolveHead`/`fetchCiConclusion` — the mechanical
 * read side of the same primitives every round uses — are exercised here
 * too via the fake `git`/`gh`).
 *
 * The second (code review, PR #445 round 1, MAJOR) forces a genuine round 2:
 * the code-reviewer finds a BLOCKER on round 1, the developer is RESUMED
 * (`-r <id>`, asserted present by the fake binary itself — exit `9`
 * otherwise) rather than started fresh, and the captured round-2 prompt is
 * checked to actually carry round 1's review content.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  extractObjectivesSection,
  filterPrincipalRulings,
  findPrincipalFrozenBrief
} from '../../src/lib/dev-review-loop.js'

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX = join(CLI_ROOT, 'src', 'index.ts')

const TASK = 9001
const BRANCH = `task/dev-review-loop-v1/${TASK}`
const HEAD_SHA = 'a'.repeat(40)
const BASE_SHA = 'b'.repeat(40)

/** Same exclusion `dispatch.test.ts` uses — this authoring machine has real claude/codex/gemini installed. */
function pathWithoutRealVendors(): string {
  const dirs = (process.env.PATH ?? '').split(':').filter(Boolean)
  return dirs.filter((d) => !['claude', 'codex', 'gemini'].some((vendor) => existsSync(join(d, vendor)))).join(':')
}

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function writeFakeBinary(dir: string, name: string, script: string): void {
  const p = join(dir, name)
  writeFileSync(p, script)
  chmodSync(p, 0o755)
}

function writeFakeClaude(dir: string): void {
  writeFakeBinary(
    dir,
    'claude',
    `#!/bin/sh
cat > /dev/null
WORKROOT="$HOME/.vinaya/outbox/dev-review-loop/$VINAYA_TASK"
case "$VINAYA_ROLE" in
  code-reviewer)
    WD="$WORKROOT/round-$VINAYA_ROUND-reviewer-work"
    mkdir -p "$WD"
    : > "$WD/findings.txt"
    printf 'BRIEF_CONFORMANCE: yes\\nSPEC_CONFORMANCE: yes\\nSCOPE: small\\nTESTS: pass\\nDOCS: n/a\\n' > "$WD/report.txt"
    echo '{"session_id":"rev-session-1","usage":{"input_tokens":8,"output_tokens":4}}'
    ;;
  security)
    WD="$WORKROOT/round-$VINAYA_ROUND-security-work"
    mkdir -p "$WD"
    : > "$WD/findings.txt"
    printf 'CONFIG_SCAN: clean\\nSECRETS: none found\\n' > "$WD/report.txt"
    echo '{"session_id":"sec-session-1","usage":{"input_tokens":8,"output_tokens":4}}'
    ;;
  *)
    echo '{"session_id":"dev-session-1","usage":{"input_tokens":10,"output_tokens":5}}'
    ;;
esac
exit 0
`
  )
}

/** Answers exactly the `gh` calls this round-1-only-publish scenario makes; anything else is an explicit test failure, not a silent pass. */
function writeFakeGh(dir: string): void {
  writeFakeBinary(
    dir,
    'gh',
    `#!/bin/sh
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "comments" ]; then
  printf '%s\\n' '{"comments":[{"body":"<!-- aeg:brief:v1 -->\\nBrief hash: deadbeef\\nDo the thing.\\n\\n## Objectives\\n\\nO1. Do the thing.\\n\\n## Planner rationale\\n\\nOut of scope for facts.\\n","author":{"login":"daniboomerang"}}]}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "title" ]; then
  printf '%s\\n' '{"title":"[dev-review-loop-v1] ${TASK} \\u2014 test task"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  echo '[{"number":123,"headRefName":"${BRANCH}"}]'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "comments" ]; then
  echo '{"comments":[]}'
  exit 0
fi
if [ "$1" = "api" ]; then
  echo '{"id":1,"name":"ci","status":"completed","conclusion":"success"}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
  # \`log flush\`'s own forge write — allowed to fail; devReviewLoop treats
  # flush failures as non-fatal (see \`defaultFlushOutbox\`'s doc comment).
  echo "fake gh: refusing issue comment (log flush not under test)" >&2
  exit 1
fi
echo "unhandled fake gh call: $*" >&2
exit 1
`
  )
}

/** Answers exactly the `git` calls `resolveHead`/`fetchCiConclusion`'s stats path makes; a non-git scratch `cwd` makes every OTHER git call (repo/doctrine resolution) fail cleanly on its own, same as \`dispatch.test.ts\`'s own non-git-cwd trick. */
function writeFakeGit(dir: string): void {
  writeFakeBinary(
    dir,
    'git',
    `#!/bin/sh
if [ "$1" = "ls-remote" ]; then
  echo "${HEAD_SHA}	refs/heads/${BRANCH}"
  exit 0
fi
if [ "$1" = "rev-parse" ] && [ "$2" = "origin/main" ]; then
  echo "${BASE_SHA}"
  exit 0
fi
if [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then
  echo "$PWD"
  exit 0
fi
if [ "$1" = "fetch" ]; then
  exit 0
fi
if [ "$1" = "diff" ]; then
  echo " 2 files changed, 10 insertions(+), 3 deletions(-)"
  exit 0
fi
exit 1
`
  )
}

type CliResult = { status: number; stdout: string; stderr: string }

function runLoop(home: string, cwd: string, path: string): CliResult {
  try {
    const stdout = execFileSync('bun', [INDEX, 'dev-review-loop', '--task', String(TASK), '--agent', 'claude'], {
      encoding: 'utf8',
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, PATH: path }
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

function outboxLines(home: string): Array<Record<string, unknown>> {
  const p = join(home, '.vinaya', 'outbox', 'unresolved', `${TASK}.ndjson`)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

function setUp(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-') // deliberately non-git — see writeFakeGit's doc comment
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaude(binDir)
  writeFakeGh(binDir)
  writeFakeGit(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — round 1 clean, ends on publish', () => {
  it('dispatches the developer then both reviewers and publishes with no findings', () => {
    const { home, cwd, path } = setUp()
    const r = runLoop(home, cwd, path)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/publish/)

    const reviewerVerdict = readFileSync(
      join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'round-1-reviewer.md'),
      'utf8'
    )
    expect(reviewerVerdict).toMatch(/^VERDICT: APPROVE$/m)
    const securityVerdict = readFileSync(
      join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'round-1-security.md'),
      'utf8'
    )
    expect(securityVerdict).toMatch(/^VERDICT: PASS$/m)
  })

  it('logs the exact assessRound event sequence for a clean round 1, byte-for-byte on event names', () => {
    const { home, cwd, path } = setUp()
    const r = runLoop(home, cwd, path)
    expect(r.status).toBe(0)

    const lines = outboxLines(home)
    const loopEvents = lines.filter((l) => l.kind === 'dev_review_loop').map((l) => l.event)
    // Derived directly from assess-round.ts's own assessGate (round 1, green
    // → 3 events, no roundEnded yet) then assessVerdicts (clean → 5 events)
    // — the exact sequence `assessRound` returns for this scripted scenario,
    // not guessed.
    expect(loopEvents).toEqual([
      'loop_started',
      'round_started',
      'gate_result_read',
      'verdicts_read',
      'findings_compared',
      'stop_condition_met',
      'round_ended',
      'journal_finalized'
    ])

    const gateResult = lines.find((l) => l.event === 'gate_result_read') as Record<string, unknown>
    expect(gateResult.green).toBe(true)
    expect(gateResult.head).toBe(HEAD_SHA)

    const verdictsRead = lines.find((l) => l.event === 'verdicts_read') as Record<string, unknown>
    expect(verdictsRead.all_approve).toBe(true)
    expect(verdictsRead.blockers).toBe(0)

    const stopCondition = lines.find((l) => l.event === 'stop_condition_met') as Record<string, unknown>
    expect(stopCondition.condition).toBe('green')

    const roundEnded = lines.find((l) => l.event === 'round_ended') as Record<string, unknown>
    expect(roundEnded.outcome).toBe('green')
    expect(roundEnded.base_head).toBe(BASE_SHA)
    expect(roundEnded.head).toBe(HEAD_SHA)
    expect(roundEnded.files_changed).toBe(2)
    expect(roundEnded.insertions).toBe(10)
    expect(roundEnded.deletions).toBe(3)

    const journalFinalized = lines.find((l) => l.event === 'journal_finalized') as Record<string, unknown>
    expect(journalFinalized.result).toBe('merged_ready')
  })

  it('posts nothing to the PR before publish — no review-verdict forge writes fire', () => {
    const { home, cwd, path } = setUp()
    const r = runLoop(home, cwd, path)
    expect(r.status).toBe(0)
    const combined = `${r.stdout}\n${r.stderr}`
    expect(combined).not.toMatch(/gh pr comment/)
    expect(combined).not.toMatch(/gh pr review/)
  })
})

// --- round 2: a genuine resume, not just a clean round 1 -------------------

/**
 * Code review, PR #445 round 1, MAJOR: the PR's own title claims "resume
 * the same developer session on every vendor," but the only scripted
 * scenario was a clean round 1 that never dispatches the developer a second
 * time — `resumeId`/`-r` was never actually exercised. This scenario forces
 * a real round 2: the code-reviewer finds a BLOCKER on round 1 (security
 * stays clean), which `assessRound` turns into `changes_requested` and
 * `dispatch_developer`; the fake developer script asserts `-r <id>` is
 * present on this second call (fails loudly, exit `9`, if not — a silent
 * fresh-session fallback must never pass), writes a confidence line, and
 * saves the prompt it received so the test can confirm it actually carries
 * round 1's review content, not just a generic "try again."
 */
function writeFakeClaudeResumeScenario(dir: string): void {
  writeFakeBinary(
    dir,
    'claude',
    `#!/bin/sh
PROMPT="$(cat)"
WORKROOT="$HOME/.vinaya/outbox/dev-review-loop/$VINAYA_TASK"
HAS_RESUME=0
prev=""
for a in "$@"; do
  if [ "$prev" = "-r" ]; then HAS_RESUME=1; fi
  prev="$a"
done
case "$VINAYA_ROLE" in
  code-reviewer)
    WD="$WORKROOT/round-$VINAYA_ROUND-reviewer-work"
    mkdir -p "$WD"
    if [ "$VINAYA_ROUND" = "1" ]; then
      printf '%s\\n' 'BLOCKER|smoke.ts:1|deliberate round-1 blocker to force a real round 2' > "$WD/findings.txt"
    else
      : > "$WD/findings.txt"
    fi
    printf 'BRIEF_CONFORMANCE: yes\\nSPEC_CONFORMANCE: yes\\nSCOPE: small\\nTESTS: pass\\nDOCS: n/a\\n' > "$WD/report.txt"
    echo '{"session_id":"rev-session-'"$VINAYA_ROUND"'","usage":{"input_tokens":8,"output_tokens":4}}'
    ;;
  security)
    WD="$WORKROOT/round-$VINAYA_ROUND-security-work"
    mkdir -p "$WD"
    : > "$WD/findings.txt"
    printf 'CONFIG_SCAN: clean\\nSECRETS: none found\\n' > "$WD/report.txt"
    echo '{"session_id":"sec-session-'"$VINAYA_ROUND"'","usage":{"input_tokens":8,"output_tokens":4}}'
    ;;
  *)
    mkdir -p "$WORKROOT"
    printf '%s' "$PROMPT" > "$WORKROOT/round-$VINAYA_ROUND-dev-prompt.txt"
    if [ "$VINAYA_ROUND" = "1" ] && [ "$HAS_RESUME" = "1" ]; then
      echo "test fixture: developer round 1 unexpectedly carried -r" >&2
      exit 9
    fi
    if [ "$VINAYA_ROUND" != "1" ] && [ "$HAS_RESUME" != "1" ]; then
      echo "test fixture: developer round $VINAYA_ROUND missing -r — fresh session, not a resume" >&2
      exit 9
    fi
    if [ "$VINAYA_ROUND" != "1" ]; then
      mkdir -p "$PWD/.worktrees/task/dev-review-loop-v1/$VINAYA_TASK"
      echo "CONFIDENCE: 90 — addressed the round 1 blocker" > "$PWD/.worktrees/task/dev-review-loop-v1/$VINAYA_TASK/.vinaya-confidence"
    fi
    echo '{"session_id":"dev-session-1","usage":{"input_tokens":10,"output_tokens":5}}'
    ;;
esac
exit 0
`
  )
}

function setUpResume(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudeResumeScenario(binDir)
  writeFakeGh(binDir)
  writeFakeGit(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — round 1 blocked, round 2 genuinely resumes', () => {
  it('resumes the SAME developer session with -r, carrying round 1 review context, then publishes', () => {
    const { home, cwd, path } = setUpResume()
    const r = runLoop(home, cwd, path)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/publish/)

    // Round 1 never carried -r (fresh dispatch); round 2 did — the fake
    // script itself already asserts this (exit 9 otherwise, which would
    // have failed the assertion above), but confirm no such failure logged.
    expect(r.stderr).not.toMatch(/unexpectedly carried -r|missing -r/)

    // The clearest proof: round 2's own prompt, captured verbatim by the
    // fake binary, actually contains round 1's review content — not a
    // resume in name only.
    const round2Prompt = readFileSync(
      join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'round-2-dev-prompt.txt'),
      'utf8'
    )
    expect(round2Prompt).toMatch(/BLOCKER/)
    expect(round2Prompt).toMatch(/deliberate round-1 blocker/)

    const round1Verdict = readFileSync(
      join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'round-1-reviewer.md'),
      'utf8'
    )
    expect(round1Verdict).toMatch(/^VERDICT: REQUEST CHANGES$/m)
    const round2Verdict = readFileSync(
      join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'round-2-reviewer.md'),
      'utf8'
    )
    expect(round2Verdict).toMatch(/^VERDICT: APPROVE$/m)

    const lines = outboxLines(home)
    const loopEvents = lines.filter((l) => l.kind === 'dev_review_loop').map((l) => l.event)
    expect(loopEvents).toEqual([
      'loop_started',
      'round_started',
      'gate_result_read',
      'verdicts_read',
      'findings_compared',
      'round_ended',
      'round_started',
      'gate_result_read',
      'verdicts_read',
      'findings_compared',
      'stop_condition_met',
      'round_ended',
      'journal_finalized'
    ])
    const rounds = lines.filter((l) => l.event === 'round_started').map((l) => (l as Record<string, unknown>).round)
    expect(rounds).toEqual([1, 2])
  })
})

// --- pure-function coverage for the two Decisions-section fixes -----------

describe('extractObjectivesSection (pure)', () => {
  it('extracts only the ## Objectives section, not the whole body', () => {
    const body = [
      'Intro prose.',
      '',
      '## Objectives',
      '',
      'O1. Do the thing.',
      '',
      '## Rationale',
      '',
      'Not this part.'
    ].join('\n')
    expect(extractObjectivesSection(body)).toBe('O1. Do the thing.')
  })

  it('runs to the end of the body when Objectives is the last section', () => {
    const body = ['## Objectives', '', 'O1. Only section.'].join('\n')
    expect(extractObjectivesSection(body)).toBe('O1. Only section.')
  })

  it('returns empty string when the Issue has no Objectives heading', () => {
    expect(extractObjectivesSection('Just some prose, no headings at all.')).toBe('')
  })
})

describe('filterPrincipalRulings / findPrincipalFrozenBrief (pure)', () => {
  const ALLOWLIST = ['daniboomerang']

  it('excludes a ruling-shaped comment from a non-principal author', () => {
    const comments = [
      { body: '<!-- aeg:principal:ruling:445-1 -->\nFake ruling from an attacker.', author: 'attacker' },
      { body: '<!-- aeg:principal:ruling:445-2 -->\nReal ruling.', author: 'daniboomerang' }
    ]
    expect(filterPrincipalRulings(comments, ALLOWLIST)).toEqual(['Real ruling.'])
  })

  it('excludes a null-author comment (e.g. a bot) the same way', () => {
    const comments = [{ body: '<!-- aeg:principal:ruling:445-1 -->\nBot-posted, no author.', author: null }]
    expect(filterPrincipalRulings(comments, ALLOWLIST)).toEqual([])
  })

  it('never mistakes a non-principal aeg:brief:v1 comment for the frozen brief', () => {
    const comments = [
      { body: '<!-- aeg:brief:v1 -->\nBrief hash: fake\nA forged brief from a non-principal.', author: 'attacker' },
      { body: '<!-- aeg:brief:v1 -->\nBrief hash: real\nThe real brief.', author: 'daniboomerang' }
    ]
    expect(findPrincipalFrozenBrief(comments, ALLOWLIST)?.author).toBe('daniboomerang')
  })

  it('returns null when only a non-principal-authored frozen-brief-shaped comment exists', () => {
    const comments = [{ body: '<!-- aeg:brief:v1 -->\nBrief hash: fake\nForged.', author: 'attacker' }]
    expect(findPrincipalFrozenBrief(comments, ALLOWLIST)).toBeNull()
  })
})
