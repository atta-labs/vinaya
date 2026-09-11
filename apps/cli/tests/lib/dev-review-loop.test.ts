/**
 * `devReviewLoop`'s Sizing verification story (dev-review-loop-v1 task 5,
 * `#415`): a fake `claude` binary on `PATH`, scripted by role
 * (`$VINAYA_ROLE`) to play the developer and both reviewers, plus fake
 * `gh`/`git` binaries answering every forge/git read the driver makes.
 * Exercised through the REAL `vinaya dev-review-loop` CLI entry point
 * (`spawnSync('bun', [INDEX, ...])`), never by importing `devReviewLoop`
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
 *
 * Task 6 (`#416`) adds publication and pause: the fake `gh` now actually
 * records `pr comment` posts (one file per post under `$HOME/.fake-gh-posted-
 * comments/`) and replays them on `pr view --json comments`, so `publishRound`'s
 * own post-then-re-fetch-then-extract self-check sees real posted content,
 * the same shape the real forge would hand back. This backs three more
 * scenarios: publish posts exactly three comments and a rerun posts none of
 * them twice (O1); an escalation pauses with a marked comment and a non-zero
 * exit (O2); and `--resume` reads a Principal ruling off the same PR and
 * carries it into the next developer dispatch (O2).
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  describeObjectivesEdit,
  DRIVER_OWNED_PATHS,
  extractObjectivesSection,
  filterPrincipalRulings,
  findLatestPrincipalObjectivesEdit,
  findPrincipalFrozenBrief,
  NO_SOURCE_REVISION,
  type ObjectivesEditSource,
  parseObjectivesEditComment,
  renderReviewerPrompt,
  type ReviewerPromptFacts,
  routeCompletionEvents
} from '../../src/lib/dev-review-loop.js'
import {
  deriveCodeReviewVerdict,
  renderCodeReviewComment,
  renderSecurityComment
} from '../../src/commands/review-post.js'
import { spliceObjectivesSection } from '../../src/commands/issue-objectives.js'
import {
  checkReviewGate,
  objectivesOf,
  objectivesVersion,
  renderObjectives,
  type Objective,
  type DevReviewLoopEventInput
} from '@attalabs/aeg-core'

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
touch "$HOME/.fake-dev-invoked" 2>/dev/null
cat > /dev/null
WORKROOT="$HOME/.vinaya/outbox/dev-review-loop/$VINAYA_TASK"
case "$VINAYA_ROLE" in
  code-reviewer)
    WD="$WORKROOT/round-$VINAYA_ROUND-reviewer-work"
    mkdir -p "$WD"
    : > "$WD/findings.txt"
    printf 'O1|MET|done.\\n' > "$WD/objectives.txt"
    printf 'BRIEF_CONFORMANCE: yes\\nSPEC_CONFORMANCE: yes\\nSCOPE: small\\nTESTS: pass\\nDOCS: n/a\\n' > "$WD/report.txt"
    echo '{"session_id":"rev-session-1","usage":{"input_tokens":8,"output_tokens":4}}'
    ;;
  security)
    WD="$WORKROOT/round-$VINAYA_ROUND-security-work"
    mkdir -p "$WD"
    : > "$WD/findings.txt"
    printf 'O1|MET|done.\\n' > "$WD/objectives.txt"
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

/**
 * Answers exactly the `gh` calls this scenario makes; anything else is an
 * explicit test failure, not a silent pass. `pr comment` and the dynamic
 * half of `pr view --json comments` exist for task 6's publication step:
 * each posted comment is saved as its own file under `$FAKE_GH_STATE`, and
 * a `pr view --json comments` read replays them in post order — so
 * `publishRound`'s own post-then-re-fetch-then-extract self-check sees
 * exactly what it just posted, the same way the real forge would.
 */
function writeFakeGh(dir: string): void {
  writeFakeBinary(
    dir,
    'gh',
    `#!/bin/sh
STATE_DIR="$HOME/.fake-gh-posted-comments"
mkdir -p "$STATE_DIR"
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "comments" ]; then
  printf '%s\\n' '{"comments":[{"body":"<!-- aeg:brief:v1 -->\\nBrief hash: deadbeef\\nDo the thing.\\n\\n## Objectives\\n\\nO1. Do the thing.\\n\\n## Planner rationale\\n\\nOut of scope for facts.\\n","author":{"login":"daniboomerang"}}]}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "title" ]; then
  printf '%s\\n' '{"title":"[dev-review-loop-v1] ${TASK} \\u2014 test task"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  if [ -f "$HOME/.fake-dev-invoked" ]; then
    echo '[{"number":123,"headRefName":"${BRANCH}"}]'
  else
    echo '[]'
  fi
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  N=$(ls "$STATE_DIR"/comment-*.md 2>/dev/null | wc -l | tr -d ' ')
  BODY_FILE="$5"
  cp "$BODY_FILE" "$STATE_DIR/comment-$((N + 1)).md"
  echo "https://github.com/example/repo/pull/$3#issuecomment-$((N + 1))"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "body" ]; then
  echo '{"body":"Closes #${TASK}"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "mergeable" ]; then
  echo '{"mergeable":"MERGEABLE"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "comments" ]; then
  FAKE_GH_STATE="$STATE_DIR" bun -e '
    const fs = require("fs")
    const dir = process.env.FAKE_GH_STATE
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("comment-"))
      .sort((a, b) => Number(a.match(/\\d+/)[0]) - Number(b.match(/\\d+/)[0]))
    const bodies = files.map((f) => fs.readFileSync(dir + "/" + f, "utf8"))
    console.log(JSON.stringify({ comments: bodies.map((body) => ({ body, author: { login: "daniboomerang" } })) }))
  '
  exit 0
fi
if [ "$1" = "api" ] && [ "\${2#*check-runs}" != "$2" ]; then
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

/**
 * Same as `writeFakeGh`, except the THIRD `gh issue view --json comments`
 * call in a run — the dispatch_reviewers branch's own re-resolution after
 * both reviewers finish (O3) — answers with an extra principal-authored
 * `<!-- aeg:objectives:v1 -->` edit comment appended, so the version it
 * reads back differs from the one it read before dispatching (the first two
 * calls: `fetchFrozenBrief` for the round-1 developer dispatch, then
 * `resolveIssueObjectives` for the reviewer-dispatch facts). A counter file
 * under `$HOME` — this fixture's only stateful read — tells the two apart.
 */
function writeFakeGhObjectivesChangedMidRound(dir: string): void {
  writeFakeBinary(
    dir,
    'gh',
    `#!/bin/sh
STATE_DIR="$HOME/.fake-gh-posted-comments"
mkdir -p "$STATE_DIR"
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "comments" ]; then
  COUNTER_FILE="$HOME/.fake-gh-issue-comments-calls"
  N=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)
  N=$((N + 1))
  echo "$N" > "$COUNTER_FILE"
  BRIEF_COMMENT='{"body":"<!-- aeg:brief:v1 -->\\nBrief hash: deadbeef\\nDo the thing.\\n\\n## Objectives\\n\\nO1. Do the thing.\\n\\n## Planner rationale\\n\\nOut of scope for facts.\\n","author":{"login":"daniboomerang"}}'
  if [ "$N" -ge 3 ]; then
    EDIT_COMMENT='{"body":"<!-- aeg:objectives:v1 -->\\nPrevious:\\nO1. Do the thing.\\n\\nNow:\\nO1. Do the thing.\\nO2. Also do this.\\n\\nReason: mid-round change\\nVersion: midroundversion","author":{"login":"daniboomerang"}}'
    printf '%s\\n' "{\\"comments\\":[$BRIEF_COMMENT,$EDIT_COMMENT]}"
  else
    printf '%s\\n' "{\\"comments\\":[$BRIEF_COMMENT]}"
  fi
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "title" ]; then
  printf '%s\\n' '{"title":"[dev-review-loop-v1] ${TASK} \\u2014 test task"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  if [ -f "$HOME/.fake-dev-invoked" ]; then
    echo '[{"number":123,"headRefName":"${BRANCH}"}]'
  else
    echo '[]'
  fi
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  N=$(ls "$STATE_DIR"/comment-*.md 2>/dev/null | wc -l | tr -d ' ')
  BODY_FILE="$5"
  cp "$BODY_FILE" "$STATE_DIR/comment-$((N + 1)).md"
  echo "https://github.com/example/repo/pull/$3#issuecomment-$((N + 1))"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "body" ]; then
  echo '{"body":"Closes #${TASK}"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "mergeable" ]; then
  echo '{"mergeable":"MERGEABLE"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "comments" ]; then
  FAKE_GH_STATE="$STATE_DIR" bun -e '
    const fs = require("fs")
    const dir = process.env.FAKE_GH_STATE
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("comment-"))
      .sort((a, b) => Number(a.match(/\\d+/)[0]) - Number(b.match(/\\d+/)[0]))
    const bodies = files.map((f) => fs.readFileSync(dir + "/" + f, "utf8"))
    console.log(JSON.stringify({ comments: bodies.map((body) => ({ body, author: { login: "daniboomerang" } })) }))
  '
  exit 0
fi
if [ "$1" = "api" ] && [ "\${2#*check-runs}" != "$2" ]; then
  echo '{"id":1,"name":"ci","status":"completed","conclusion":"success"}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
  echo "fake gh: refusing issue comment (log flush not under test)" >&2
  exit 1
fi
echo "unhandled fake gh call: $*" >&2
exit 1
`
  )
}

/**
 * Same as `writeFakeGh`, except the THIRD `gh pr view --json comments` call
 * in a run — `fetchRulings` and `fetchNewestRulingOrdinal` both run at
 * reviewer-dispatch time (calls 1 and 2, both answering "no rulings yet"),
 * then the dispatch_reviewers branch's own re-resolution after both
 * reviewers finish (O3, call 3) answers with a principal-authored ruling
 * comment now present, so the ordinal it reads back (1) differs from the
 * one it read before dispatching (0). A counter file under `$HOME` — this
 * fixture's only stateful read — tells the calls apart; nothing is ever
 * actually posted in this scenario, so the real posted-comment replay
 * machinery `writeFakeGh` uses for `pr view --json comments` is unneeded
 * here.
 */
function writeFakeGhRulingPostedMidRound(dir: string): void {
  writeFakeBinary(
    dir,
    'gh',
    `#!/bin/sh
STATE_DIR="$HOME/.fake-gh-posted-comments"
mkdir -p "$STATE_DIR"
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "comments" ]; then
  printf '%s\\n' '{"comments":[{"body":"<!-- aeg:brief:v1 -->\\nBrief hash: deadbeef\\nDo the thing.\\n\\n## Objectives\\n\\nO1. Do the thing.\\n\\n## Planner rationale\\n\\nOut of scope for facts.\\n","author":{"login":"daniboomerang"}}]}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "title" ]; then
  printf '%s\\n' '{"title":"[dev-review-loop-v1] ${TASK} \\u2014 test task"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  if [ -f "$HOME/.fake-dev-invoked" ]; then
    echo '[{"number":123,"headRefName":"${BRANCH}"}]'
  else
    echo '[]'
  fi
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  N=$(ls "$STATE_DIR"/comment-*.md 2>/dev/null | wc -l | tr -d ' ')
  BODY_FILE="$5"
  cp "$BODY_FILE" "$STATE_DIR/comment-$((N + 1)).md"
  echo "https://github.com/example/repo/pull/$3#issuecomment-$((N + 1))"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "body" ]; then
  echo '{"body":"Closes #${TASK}"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "mergeable" ]; then
  echo '{"mergeable":"MERGEABLE"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "comments" ]; then
  COUNTER_FILE="$HOME/.fake-gh-pr-comments-calls"
  N=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)
  N=$((N + 1))
  echo "$N" > "$COUNTER_FILE"
  if [ "$N" -ge 3 ]; then
    printf '%s\\n' '{"comments":[{"body":"<!-- aeg:principal:ruling:123-1 -->\\nHold off on this approach.","author":{"login":"daniboomerang"}}]}'
  else
    printf '%s\\n' '{"comments":[]}'
  fi
  exit 0
fi
if [ "$1" = "api" ] && [ "\${2#*check-runs}" != "$2" ]; then
  echo '{"id":1,"name":"ci","status":"completed","conclusion":"success"}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
  echo "fake gh: refusing issue comment (log flush not under test)" >&2
  exit 1
fi
echo "unhandled fake gh call: $*" >&2
exit 1
`
  )
}

/**
 * Same as `writeFakeGh`, except `gh api …/check-runs` answers with TWO
 * check-runs: a real mechanical one (`Vinaya CI`, success) and the review
 * gate's own (`vinaya review gate`, FAILURE — as it always reads before any
 * verdict has posted). review-validity-v1 task 5 (`#488`, O1): the gate must
 * exclude the review gate's own check-run by name and read this head as
 * green off `Vinaya CI` alone, never red because of the review gate.
 */
function writeFakeGhReviewGateOwnCheckFails(dir: string): void {
  writeFakeBinary(
    dir,
    'gh',
    `#!/bin/sh
STATE_DIR="$HOME/.fake-gh-posted-comments"
mkdir -p "$STATE_DIR"
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "comments" ]; then
  printf '%s\\n' '{"comments":[{"body":"<!-- aeg:brief:v1 -->\\nBrief hash: deadbeef\\nDo the thing.\\n\\n## Objectives\\n\\nO1. Do the thing.\\n\\n## Planner rationale\\n\\nOut of scope for facts.\\n","author":{"login":"daniboomerang"}}]}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "title" ]; then
  printf '%s\\n' '{"title":"[dev-review-loop-v1] ${TASK} \\u2014 test task"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  if [ -f "$HOME/.fake-dev-invoked" ]; then
    echo '[{"number":123,"headRefName":"${BRANCH}"}]'
  else
    echo '[]'
  fi
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  N=$(ls "$STATE_DIR"/comment-*.md 2>/dev/null | wc -l | tr -d ' ')
  BODY_FILE="$5"
  cp "$BODY_FILE" "$STATE_DIR/comment-$((N + 1)).md"
  echo "https://github.com/example/repo/pull/$3#issuecomment-$((N + 1))"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "body" ]; then
  echo '{"body":"Closes #${TASK}"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "mergeable" ]; then
  echo '{"mergeable":"MERGEABLE"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "comments" ]; then
  FAKE_GH_STATE="$STATE_DIR" bun -e '
    const fs = require("fs")
    const dir = process.env.FAKE_GH_STATE
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("comment-"))
      .sort((a, b) => Number(a.match(/\\d+/)[0]) - Number(b.match(/\\d+/)[0]))
    const bodies = files.map((f) => fs.readFileSync(dir + "/" + f, "utf8"))
    console.log(JSON.stringify({ comments: bodies.map((body) => ({ body, author: { login: "daniboomerang" } })) }))
  '
  exit 0
fi
if [ "$1" = "api" ] && [ "\${2#*check-runs}" != "$2" ]; then
  printf '%s\\n%s\\n' \\
    '{"id":1,"name":"Vinaya CI","status":"completed","conclusion":"success"}' \\
    '{"id":2,"name":"vinaya review gate","status":"completed","conclusion":"failure"}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
  echo "fake gh: refusing issue comment (log flush not under test)" >&2
  exit 1
fi
echo "unhandled fake gh call: $*" >&2
exit 1
`
  )
}

function setUpReviewGateOwnCheckFails(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaude(binDir)
  writeFakeGhReviewGateOwnCheckFails(binDir)
  writeFakeGit(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — the mechanical gate excludes the review gate’s own check-run (O1)', () => {
  it('reads green and publishes off a real CI success, even though "vinaya review gate" itself reads failure', () => {
    const { home, cwd, path } = setUpReviewGateOwnCheckFails()
    const r = runLoop(home, cwd, path)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/publish/)

    const loopEvents = outboxLines(home)
      .filter((l) => l.kind === 'dev_review_loop')
      .map((l) => l.event)
    // A red gate would have dispatched the developer again instead of the
    // reviewers — `gate_result_read` with `green: true` proves the review
    // gate's own failing check-run was excluded, not merely tolerated.
    const gateRead = outboxLines(home).find((l) => l.event === 'gate_result_read') as
      | Record<string, unknown>
      | undefined
    expect(gateRead?.green).toBe(true)
    expect(loopEvents).toContain('verdicts_read')
  }, 20000)
})

/**
 * Same as `writeFakeGh`, except the SECOND `pr comment` post of a publish
 * (the security verdict, right after the reviewer verdict lands) fails —
 * simulating a crash partway through `publishRound` (regression test, PR
 * #459: a crash mid-publish must not leave the durable log claiming
 * `merged_ready` for a run that never actually finished publishing).
 */
function writeFakeGhCrashOnSecondPost(dir: string): void {
  writeFakeBinary(
    dir,
    'gh',
    `#!/bin/sh
STATE_DIR="$HOME/.fake-gh-posted-comments"
mkdir -p "$STATE_DIR"
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "comments" ]; then
  printf '%s\\n' '{"comments":[{"body":"<!-- aeg:brief:v1 -->\\nBrief hash: deadbeef\\nDo the thing.\\n\\n## Objectives\\n\\nO1. Do the thing.\\n\\n## Planner rationale\\n\\nOut of scope for facts.\\n","author":{"login":"daniboomerang"}}]}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "title" ]; then
  printf '%s\\n' '{"title":"[dev-review-loop-v1] ${TASK} \\u2014 test task"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  if [ -f "$HOME/.fake-dev-invoked" ]; then
    echo '[{"number":123,"headRefName":"${BRANCH}"}]'
  else
    echo '[]'
  fi
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  N=$(ls "$STATE_DIR"/comment-*.md 2>/dev/null | wc -l | tr -d ' ')
  if [ "$N" = "1" ]; then
    echo "fake gh: simulated crash on the second publish post" >&2
    exit 1
  fi
  BODY_FILE="$5"
  cp "$BODY_FILE" "$STATE_DIR/comment-$((N + 1)).md"
  echo "https://github.com/example/repo/pull/$3#issuecomment-$((N + 1))"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "body" ]; then
  echo '{"body":"Closes #${TASK}"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "mergeable" ]; then
  echo '{"mergeable":"MERGEABLE"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "comments" ]; then
  FAKE_GH_STATE="$STATE_DIR" bun -e '
    const fs = require("fs")
    const dir = process.env.FAKE_GH_STATE
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("comment-"))
      .sort((a, b) => Number(a.match(/\\d+/)[0]) - Number(b.match(/\\d+/)[0]))
    const bodies = files.map((f) => fs.readFileSync(dir + "/" + f, "utf8"))
    console.log(JSON.stringify({ comments: bodies.map((body) => ({ body, author: { login: "daniboomerang" } })) }))
  '
  exit 0
fi
if [ "$1" = "api" ] && [ "\${2#*check-runs}" != "$2" ]; then
  echo '{"id":1,"name":"ci","status":"completed","conclusion":"success"}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
  echo "fake gh: refusing issue comment (log flush not under test)" >&2
  exit 1
fi
echo "unhandled fake gh call: $*" >&2
exit 1
`
  )
}

function setUpCrashMidPublish(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaude(binDir)
  writeFakeGhCrashOnSecondPost(binDir)
  writeFakeGit(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — a crash mid-publish never logs merged_ready (regression, PR #459 MAJOR)', () => {
  it('posts the reviewer verdict, crashes on the security verdict, and the outbox never claims merged_ready', () => {
    const { home, cwd, path } = setUpCrashMidPublish()
    const r = runLoop(home, cwd, path)
    expect(r.status).not.toBe(0)

    // Exactly one post landed — the crash hit the second, before the third
    // (the summary) was ever attempted.
    expect(postedCommentFiles(home)).toHaveLength(1)

    // The regression: `journal_finalized`/`merged_ready` was logged in the
    // SAME breath as the round outcome, before `publishRound` ever ran, so a
    // crash here still left the durable log asserting a completion that
    // never happened. Fixed: the event is held until `publishRound` returns
    // without throwing, so a crash here means it never logs at all.
    const journalFinalizedLines = outboxLines(home).filter((l) => l.event === 'journal_finalized')
    expect(journalFinalizedLines).toHaveLength(0)
  }, 20000)
})

/**
 * Answers exactly the `git` calls `resolveHead`/`fetchCiConclusion`'s stats
 * path makes; a non-git scratch `cwd` makes every OTHER git call
 * (repo/doctrine resolution) fail cleanly on its own, same as
 * \`dispatch.test.ts\`'s own non-git-cwd trick.
 *
 * `ls-remote` answers empty (branch not found — `resolveHead` throws) until
 * `$HOME/.fake-dev-invoked` exists (review-validity-v1 task 5, `#488`, O4):
 * the round-1 entry check needs a real "this branch doesn't exist yet" for
 * every scenario's genuinely-fresh dispatch to still exercise the fresh path
 * rather than always reading as a remote branch with no open PR.
 */
function writeFakeGit(dir: string): void {
  writeFakeBinary(
    dir,
    'git',
    `#!/bin/sh
if [ "$1" = "ls-remote" ]; then
  if [ -f "$HOME/.fake-dev-invoked" ]; then
    echo "${HEAD_SHA}	refs/heads/${BRANCH}"
  fi
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
  return runDevReviewLoopArgs(home, cwd, path, ['--task', String(TASK), '--agent', 'claude'])
}

function runResume(home: string, cwd: string, path: string, pr: number): CliResult {
  return runDevReviewLoopArgs(home, cwd, path, ['--resume', String(pr), '--agent', 'claude'])
}

function runDevReviewLoopArgs(
  home: string,
  cwd: string,
  path: string,
  args: string[],
  extraEnv: Record<string, string> = {}
): CliResult {
  // `spawnSync` (never `execFileSync`) — it hands back stdout AND stderr on
  // BOTH the success and the non-zero-exit path; `execFileSync` only
  // surfaces piped stderr via the thrown error, so a passing run's own
  // stderr (task 7, #498: the stale-takeover line prints there even on a
  // clean publish) would otherwise be silently discarded.
  const r = spawnSync('bun', [INDEX, 'dev-review-loop', ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, HOME: home, PATH: path, ...extraEnv }
  })
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function postedCommentFiles(home: string): string[] {
  const dir = join(home, '.fake-gh-posted-comments')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.startsWith('comment-'))
    .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
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
    // O2: the held verdict carries the version it judged and a MET/NOT MET
    // line per objective — no more hardcoded `objectivesVersion: null`.
    const expectedVersion = objectivesVersion([{ id: 'O1', text: 'Do the thing.' }])
    expect(reviewerVerdict).toMatch(new RegExp(`^Objectives version: ${expectedVersion}$`, 'm'))
    expect(reviewerVerdict).toMatch(/^O1: MET — done\.$/m)
    const securityVerdict = readFileSync(
      join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'round-1-security.md'),
      'utf8'
    )
    expect(securityVerdict).toMatch(/^VERDICT: PASS$/m)
    expect(securityVerdict).toMatch(new RegExp(`^Objectives version: ${expectedVersion}$`, 'm'))
    expect(securityVerdict).toMatch(/^O1: MET — done\.$/m)
  }, 20000)

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
  }, 20000)

  it('publishes the two verdicts then the summary, in order, self-verified — and a rerun posts nothing twice (O1)', () => {
    const { home, cwd, path } = setUp()
    const r1 = runLoop(home, cwd, path)
    expect(r1.status).toBe(0)
    expect(r1.stdout).toMatch(/publish/)

    const firstRunFiles = postedCommentFiles(home)
    expect(firstRunFiles).toHaveLength(3)

    const [reviewerFile, securityFile, summaryFile] = firstRunFiles
    const reviewerPosted = readFileSync(join(home, '.fake-gh-posted-comments', reviewerFile as string), 'utf8')
    expect(reviewerPosted).toMatch(/^VERDICT: APPROVE$/m)
    expect(reviewerPosted).toMatch(new RegExp(`^Judged head: ${HEAD_SHA}$`, 'm'))

    const securityPosted = readFileSync(join(home, '.fake-gh-posted-comments', securityFile as string), 'utf8')
    expect(securityPosted).toMatch(/^VERDICT: PASS$/m)

    const summaryPosted = readFileSync(join(home, '.fake-gh-posted-comments', summaryFile as string), 'utf8')
    expect(summaryPosted).toMatch(/\| round \|/)
    expect(summaryPosted).not.toMatch(/^VERDICT:/m)
    expect(summaryPosted).not.toMatch(/^Judged head:/m)

    // Same deterministic fixture, same $HOME: a rerun reaches round 1 clean
    // → publish again, but `postForgeEffectOnce`'s effect records from the
    // first run make it post nothing a second time.
    const r2 = runLoop(home, cwd, path)
    expect(r2.status).toBe(0)
    expect(r2.stdout).toMatch(/publish/)
    expect(postedCommentFiles(home)).toEqual(firstRunFiles)
  }, 20000)
})

// --- pause and --resume (O2) ------------------------------------------------

/**
 * Code-reviewer escalates on round 1 (`ESCALATE: authority`) — `assessRound`
 * turns that into `pause{reason:'escalation'}` before any verdict is ever
 * held or posted. `$HOME/.escalated-once` distinguishes the two SEPARATE
 * `runDevReviewLoopArgs` invocations this scenario needs (same `$HOME`
 * across both): the first attempt escalates; the second — after `--resume`
 * reads a since-posted Principal ruling — reviews clean and publishes.
 */
function writeFakeClaudePauseThenResumeScenario(dir: string): void {
  writeFakeBinary(
    dir,
    'claude',
    `#!/bin/sh
touch "$HOME/.fake-dev-invoked" 2>/dev/null
PROMPT="$(cat)"
WORKROOT="$HOME/.vinaya/outbox/dev-review-loop/$VINAYA_TASK"
case "$VINAYA_ROLE" in
  code-reviewer)
    WD="$WORKROOT/round-$VINAYA_ROUND-reviewer-work"
    mkdir -p "$WD"
    if [ -f "$HOME/.escalated-once" ]; then
      : > "$WD/findings.txt"
      printf 'O1|MET|done.\\n' > "$WD/objectives.txt"
      printf 'BRIEF_CONFORMANCE: yes\\nSPEC_CONFORMANCE: yes\\nSCOPE: small\\nTESTS: pass\\nDOCS: n/a\\n' > "$WD/report.txt"
    else
      touch "$HOME/.escalated-once"
      : > "$WD/findings.txt"
      printf 'ESCALATE: authority\\nSUMMARY: needs a call nobody made.\\n' > "$WD/report.txt"
    fi
    echo '{"session_id":"rev-session-1","usage":{"input_tokens":8,"output_tokens":4}}'
    ;;
  security)
    WD="$WORKROOT/round-$VINAYA_ROUND-security-work"
    mkdir -p "$WD"
    : > "$WD/findings.txt"
    printf 'O1|MET|done.\\n' > "$WD/objectives.txt"
    printf 'CONFIG_SCAN: clean\\nSECRETS: none found\\n' > "$WD/report.txt"
    echo '{"session_id":"sec-session-1","usage":{"input_tokens":8,"output_tokens":4}}'
    ;;
  *)
    mkdir -p "$WORKROOT"
    printf '%s\\n---\\n' "$PROMPT" >> "$WORKROOT/dev-prompts.txt"
    echo '{"session_id":"dev-session-1","usage":{"input_tokens":10,"output_tokens":5}}'
    ;;
esac
exit 0
`
  )
}

function driverLockPath(home: string): string {
  return join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'driver.pid.json')
}

function writeDriverLockFixture(home: string, lock: { pid: number; startedAt: string }): void {
  const path = driverLockPath(home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(lock), 'utf8')
}

/** A pid that has definitely already exited — `spawnSync` blocks until the child is gone before returning its pid. */
function deadPid(): number {
  const r = spawnSync('true', [])
  if (typeof r.pid !== 'number') throw new Error('spawnSync did not report a pid')
  return r.pid
}

describe('devReviewLoop — one driver per task (review-validity-v1 task 7, #498)', () => {
  it('O1: refuses to start, naming the live pid and start time, dispatching nothing', () => {
    const { home, cwd, path } = setUp()
    const startedAt = '2026-09-10T00:00:00.000Z'
    writeDriverLockFixture(home, { pid: process.pid, startedAt })

    const r = runLoop(home, cwd, path)

    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('vinaya dev-review-loop:')
    expect(r.stderr).toContain('refuses to start')
    expect(r.stderr).toContain(String(process.pid))
    expect(r.stderr).toContain(startedAt)
    // Nothing dispatched: the fake claude binary's own invocation marker never appears.
    expect(existsSync(join(home, '.fake-dev-invoked'))).toBe(false)
  })

  it('O2: a dead pid record is treated as absent — takes over, runs, and clears the lock on exit', () => {
    const { home, cwd, path } = setUp()
    const startedAt = '2026-09-10T00:00:00.000Z'
    const stalePid = deadPid()
    writeDriverLockFixture(home, { pid: stalePid, startedAt })

    const r = runLoop(home, cwd, path)

    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/publish/)
    // O3: the stale takeover is visible on stderr, naming the stale pid and start time.
    expect(r.stderr).toContain('vinaya dev-review-loop:')
    expect(r.stderr).toContain('no longer alive')
    expect(r.stderr).toContain(String(stalePid))
    expect(r.stderr).toContain(startedAt)
    // O2: cleared on the normal-exit path, same as every other exit.
    expect(existsSync(driverLockPath(home))).toBe(false)
  })
})

function setUpPauseResume(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudePauseThenResumeScenario(binDir)
  writeFakeGh(binDir)
  writeFakeGit(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — escalation pauses, --resume continues after a ruling', () => {
  it('pauses with a marked comment and a non-zero exit, then --resume publishes after a ruling', () => {
    const { home, cwd, path } = setUpPauseResume()

    const paused = runLoop(home, cwd, path)
    expect(paused.status).not.toBe(0)
    expect(paused.stdout).toMatch(/paused \(escalation\)/)

    const pausedFiles = postedCommentFiles(home)
    expect(pausedFiles).toHaveLength(1)
    const pauseComment = readFileSync(join(home, '.fake-gh-posted-comments', pausedFiles[0] as string), 'utf8')
    expect(pauseComment).toMatch(/^<!-- aeg:loop:paused:escalation -->$/m)
    expect(pauseComment).toMatch(/vinaya dev-review-loop --resume 123/)
    expect(pauseComment).not.toMatch(/^VERDICT:/m)

    const pauseState = JSON.parse(
      readFileSync(join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'pause-state.json'), 'utf8')
    ) as Record<string, unknown>
    expect(pauseState.round).toBe(1)
    expect(pauseState.reason).toBe('escalation')

    // Seed a Principal ruling comment on the PR — the same shape
    // `filterPrincipalRulings`'s own unit tests use — before resuming.
    writeFileSync(
      join(home, '.fake-gh-posted-comments', 'comment-2.md'),
      `<!-- aeg:principal:ruling:${TASK}-1 -->\nGo ahead and fix it.\n`
    )

    const resumed = runResume(home, cwd, path, 123)
    expect(resumed.status).toBe(0)
    expect(resumed.stdout).toMatch(/publish/)

    const devPrompts = readFileSync(
      join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'dev-prompts.txt'),
      'utf8'
    )
    expect(devPrompts).toMatch(/Principal ruling on this pause/)
    expect(devPrompts).toMatch(/Go ahead and fix it\./)

    // Published: the two verdicts and the summary, appended after the pause
    // comment and the seeded ruling.
    const allComments = postedCommentFiles(home)
    expect(allComments).toHaveLength(5)
  }, 20000)
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
touch "$HOME/.fake-dev-invoked" 2>/dev/null
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
    printf 'O1|MET|done.\\n' > "$WD/objectives.txt"
    printf 'BRIEF_CONFORMANCE: yes\\nSPEC_CONFORMANCE: yes\\nSCOPE: small\\nTESTS: pass\\nDOCS: n/a\\n' > "$WD/report.txt"
    echo '{"session_id":"rev-session-'"$VINAYA_ROUND"'","usage":{"input_tokens":8,"output_tokens":4}}'
    ;;
  security)
    WD="$WORKROOT/round-$VINAYA_ROUND-security-work"
    mkdir -p "$WD"
    : > "$WD/findings.txt"
    printf 'O1|MET|done.\\n' > "$WD/objectives.txt"
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
  }, 20000)
})

// --- no_progress pause still logs its completion event (regression, PR #459 MAJOR) ---

/**
 * The reviewer reports the SAME unresolved blocker on round 1 and round 2
 * (security stays clean throughout) — `assessRound` turns two consecutive
 * changes-requested rounds that resolve nothing into `pause{reason:
 * 'no_progress'}`. Round 2 needs a confidence line ≥50 (`round >= 2` asks
 * for one) so the loop reaches the reviewers at all, rather than pausing on
 * `confidence` first.
 */
function writeFakeClaudeNoProgressScenario(dir: string): void {
  writeFakeBinary(
    dir,
    'claude',
    `#!/bin/sh
touch "$HOME/.fake-dev-invoked" 2>/dev/null
cat > /dev/null
WORKROOT="$HOME/.vinaya/outbox/dev-review-loop/$VINAYA_TASK"
case "$VINAYA_ROLE" in
  code-reviewer)
    WD="$WORKROOT/round-$VINAYA_ROUND-reviewer-work"
    mkdir -p "$WD"
    printf 'BLOCKER|smoke.ts:1|persistent blocker, never resolved\\n' > "$WD/findings.txt"
    printf 'O1|MET|done.\\n' > "$WD/objectives.txt"
    printf 'BRIEF_CONFORMANCE: yes\\nSPEC_CONFORMANCE: yes\\nSCOPE: small\\nTESTS: pass\\nDOCS: n/a\\n' > "$WD/report.txt"
    echo '{"session_id":"rev-session-'"$VINAYA_ROUND"'","usage":{"input_tokens":8,"output_tokens":4}}'
    ;;
  security)
    WD="$WORKROOT/round-$VINAYA_ROUND-security-work"
    mkdir -p "$WD"
    : > "$WD/findings.txt"
    printf 'O1|MET|done.\\n' > "$WD/objectives.txt"
    printf 'CONFIG_SCAN: clean\\nSECRETS: none found\\n' > "$WD/report.txt"
    echo '{"session_id":"sec-session-'"$VINAYA_ROUND"'","usage":{"input_tokens":8,"output_tokens":4}}'
    ;;
  *)
    if [ "$VINAYA_ROUND" != "1" ]; then
      mkdir -p "$PWD/.worktrees/task/dev-review-loop-v1/$VINAYA_TASK"
      echo "CONFIDENCE: 90 — still trying" > "$PWD/.worktrees/task/dev-review-loop-v1/$VINAYA_TASK/.vinaya-confidence"
    fi
    echo '{"session_id":"dev-session-1","usage":{"input_tokens":10,"output_tokens":5}}'
    ;;
esac
exit 0
`
  )
}

function setUpNoProgress(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudeNoProgressScenario(binDir)
  writeFakeGh(binDir)
  writeFakeGit(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — a paused loop for reason no_progress still logs its completion event', () => {
  it('pauses on no_progress after two rounds resolve nothing, and journal_finalized is not dropped', () => {
    const { home, cwd, path } = setUpNoProgress()
    const r = runLoop(home, cwd, path)
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/paused \(no_progress\)/)

    const pauseComment = readFileSync(join(home, '.fake-gh-posted-comments', 'comment-1.md'), 'utf8')
    expect(pauseComment).toMatch(/^<!-- aeg:loop:paused:no_progress -->$/m)

    // The regression: this event was captured into `pendingCompletionEvents`
    // by the `dispatch_reviewers` branch's unconditional filter, and only
    // the `publish` branch ever flushed that variable — so a `pause` never
    // logged it, permanently, on every successful run. Fixed:
    // `routeCompletionEvents` only defers for a `publish` decision.
    const journalFinalized = outboxLines(home).find((l) => l.event === 'journal_finalized') as
      | Record<string, unknown>
      | undefined
    expect(journalFinalized).toBeDefined()
    expect(journalFinalized?.result).toBe('stopped')
  }, 20000)
})

// --- a reviewer that writes nothing is infrastructure, never approval (O1/O2) ---

/**
 * Security never writes anything to its own work directory, on either the
 * first dispatch or the retry (task `review-validity-v1` 1, `#475`, O1/O2) —
 * the exact "clean exit, no files" shape the origin finding describes:
 * `dev-review-loop.ts`'s prior report reader defaulted a missing file to an
 * empty string and read that as APPROVE/PASS. Each invocation appends a line
 * to `$HOME/.security-invocations` so the test can prove genuinely TWO fresh
 * dispatches happened (one attempt, one retry), never a single call read
 * twice or a resumed session. The code-reviewer half stays clean throughout —
 * this scenario isolates the failure to one role, the way `Promise.all`
 * actually runs them.
 */
function writeFakeClaudeReviewerWritesNothingScenario(dir: string): void {
  writeFakeBinary(
    dir,
    'claude',
    `#!/bin/sh
touch "$HOME/.fake-dev-invoked" 2>/dev/null
cat > /dev/null
WORKROOT="$HOME/.vinaya/outbox/dev-review-loop/$VINAYA_TASK"
case "$VINAYA_ROLE" in
  code-reviewer)
    WD="$WORKROOT/round-$VINAYA_ROUND-reviewer-work"
    mkdir -p "$WD"
    : > "$WD/findings.txt"
    printf 'O1|MET|done.\\n' > "$WD/objectives.txt"
    printf 'BRIEF_CONFORMANCE: yes\\nSPEC_CONFORMANCE: yes\\nSCOPE: small\\nTESTS: pass\\nDOCS: n/a\\n' > "$WD/report.txt"
    echo '{"session_id":"rev-session-1","usage":{"input_tokens":8,"output_tokens":4}}'
    ;;
  security)
    echo "invocation" >> "$HOME/.security-invocations"
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

function setUpReviewerWritesNothing(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudeReviewerWritesNothingScenario(binDir)
  writeFakeGh(binDir)
  writeFakeGit(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — a reviewer that wrote nothing cast no verdict (O1/O2)', () => {
  it('retries once into a fresh work directory, then pauses naming the role and the missing artifacts — nothing held or published', () => {
    const { home, cwd, path } = setUpReviewerWritesNothing()
    const r = runLoop(home, cwd, path)
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/paused \(infrastructure\)/)

    // Two genuinely separate dispatches for the failing role — one attempt,
    // one fresh retry — never the same call read twice.
    const invocations = readFileSync(join(home, '.security-invocations'), 'utf8').trim().split('\n').filter(Boolean)
    expect(invocations).toHaveLength(2)

    // The retry used a genuinely fresh directory — the first attempt's own
    // directory is never reused or resumed.
    const drlRoot = join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK))
    expect(existsSync(join(drlRoot, 'round-1-security-work'))).toBe(true)
    expect(existsSync(join(drlRoot, 'round-1-security-work-retry1'))).toBe(true)

    // Nothing held or published for this round: no security verdict file
    // ever got written, and the round never advanced past 1. The code-review
    // role finishes clean well before security's own retry exhausts — its
    // held verdict must not survive on disk either (round 1 review finding,
    // BLOCKER, PR #489: `writeHeldVerdict` used to run inside `dispatchReviewer`
    // itself, so the succeeding role's file was already written by the time
    // `Promise.all` rejected on its sibling).
    expect(existsSync(join(drlRoot, 'round-1-reviewer.md'))).toBe(false)
    expect(existsSync(join(drlRoot, 'round-1-security.md'))).toBe(false)
    const pauseState = JSON.parse(readFileSync(join(drlRoot, 'pause-state.json'), 'utf8')) as Record<string, unknown>
    expect(pauseState.round).toBe(1)
    expect(pauseState.reason).toBe('infrastructure')

    // One comment only — the pause — never a verdict.
    const pausedFiles = postedCommentFiles(home)
    expect(pausedFiles).toHaveLength(1)
    const pauseComment = readFileSync(join(home, '.fake-gh-posted-comments', pausedFiles[0] as string), 'utf8')
    expect(pauseComment).toMatch(/^<!-- aeg:loop:paused:infrastructure -->$/m)
    expect(pauseComment).toMatch(/security/)
    expect(pauseComment).toMatch(/findings\.txt/)
    expect(pauseComment).toMatch(/report\.txt/)
    expect(pauseComment).not.toMatch(/^VERDICT:/m)

    // O5 (review-validity-v1 task 5, `#488`; regression, PR #489 round 2,
    // MAJOR): this pause used to build its `Decision` by hand and skip the
    // log entirely — zero `dev_review_loop` events for the round.
    // `driverDecidedPauseEvents` now logs the same four events every other
    // pause reason gets (this task's own declared Surface excludes
    // `packages/aeg-core`, so this is driver-built, reusing the schema's
    // existing `'principal_stop'`/`'principal_item'` values, never a new
    // schema value — see that function's own doc comment).
    const loopEvents = outboxLines(home)
      .filter((l) => l.kind === 'dev_review_loop')
      .map((l) => l.event)
    expect(loopEvents).toEqual([
      'loop_started',
      'round_started',
      'gate_result_read',
      'stop_condition_met',
      'paused',
      'round_ended',
      'journal_finalized'
    ])
    const stop = outboxLines(home).find((l) => l.event === 'stop_condition_met') as Record<string, unknown>
    expect(stop.condition).toBe('principal_stop')
    const journalFinalized = outboxLines(home).find((l) => l.event === 'journal_finalized') as Record<string, unknown>
    expect(journalFinalized.result).toBe('stopped')
  }, 20000)
})

// --- a findings.txt that still does not parse is infrastructure, never an
// uncaught throw (review-validity-v1 task 8, #506, O6) ---

/**
 * Security writes a genuinely unparseable `findings.txt` line — no `|` at
 * all, so neither a severity nor a location nor a description can be read
 * off it — on BOTH the first dispatch and the retry. The prior behaviour
 * (before O6) let `parseFindingsFile`'s thrown `FindingsParseError`
 * propagate straight out of `buildVerdictFromReport` uncaught, crashing the
 * whole driver process; this scenario proves it is now caught, retried
 * once, and turned into the same `infrastructure` pause a missing artifact
 * gets — never a crash.
 */
function writeFakeClaudeReviewerWritesGarbageFindingsScenario(dir: string): void {
  writeFakeBinary(
    dir,
    'claude',
    `#!/bin/sh
touch "$HOME/.fake-dev-invoked" 2>/dev/null
cat > /dev/null
WORKROOT="$HOME/.vinaya/outbox/dev-review-loop/$VINAYA_TASK"
case "$VINAYA_ROLE" in
  code-reviewer)
    WD="$WORKROOT/round-$VINAYA_ROUND-reviewer-work"
    mkdir -p "$WD"
    : > "$WD/findings.txt"
    printf 'O1|MET|done.\\n' > "$WD/objectives.txt"
    printf 'BRIEF_CONFORMANCE: yes\\nSPEC_CONFORMANCE: yes\\nSCOPE: small\\nTESTS: pass\\nDOCS: n/a\\n' > "$WD/report.txt"
    echo '{"session_id":"rev-session-1","usage":{"input_tokens":8,"output_tokens":4}}'
    ;;
  security)
    ATTEMPT=$(cat "$HOME/.security-invocations" 2>/dev/null | wc -l | tr -d ' ')
    WD="$WORKROOT/round-$VINAYA_ROUND-security-work"
    if [ "$ATTEMPT" != "0" ]; then
      WD="$WORKROOT/round-$VINAYA_ROUND-security-work-retry1"
    fi
    mkdir -p "$WD"
    printf 'this is not a valid finding line at all\\n' > "$WD/findings.txt"
    printf 'O1|MET|done.\\n' > "$WD/objectives.txt"
    printf 'CONFIG_SCAN: clean\\nSECRETS: none found\\n' > "$WD/report.txt"
    echo "invocation" >> "$HOME/.security-invocations"
    echo '{"session_id":"sec-session-garbage","usage":{"input_tokens":8,"output_tokens":4}}'
    ;;
  *)
    echo '{"session_id":"dev-session-1","usage":{"input_tokens":10,"output_tokens":5}}'
    ;;
esac
exit 0
`
  )
}

function setUpReviewerWritesGarbageFindings(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudeReviewerWritesGarbageFindingsScenario(binDir)
  writeFakeGh(binDir)
  writeFakeGit(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — a findings.txt line that still does not parse is an infrastructure pause (review-validity-v1 task 8, #506, O6)', () => {
  it('retries once into a fresh work directory, then pauses naming the file, the line, and the reviewer session id — never an uncaught throw', () => {
    const { home, cwd, path } = setUpReviewerWritesGarbageFindings()
    const r = runLoop(home, cwd, path)
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/paused \(infrastructure\)/)

    // Two genuinely separate dispatches — one attempt, one fresh retry.
    const invocations = readFileSync(join(home, '.security-invocations'), 'utf8').trim().split('\n').filter(Boolean)
    expect(invocations).toHaveLength(2)

    const drlRoot = join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK))
    const pauseState = JSON.parse(readFileSync(join(drlRoot, 'pause-state.json'), 'utf8')) as Record<string, unknown>
    expect(pauseState.round).toBe(1)
    expect(pauseState.reason).toBe('infrastructure')

    const pausedFiles = postedCommentFiles(home)
    expect(pausedFiles).toHaveLength(1)
    const pauseComment = readFileSync(join(home, '.fake-gh-posted-comments', pausedFiles[0] as string), 'utf8')
    expect(pauseComment).toMatch(/^<!-- aeg:loop:paused:infrastructure -->$/m)
    // Names the file, the line (inside the parse error's own message), and
    // the reviewer's session id — O6's three required facts.
    expect(pauseComment).toMatch(/findings\.txt/)
    expect(pauseComment).toMatch(/line 1/)
    expect(pauseComment).toMatch(/sec-session-garbage/)
    expect(pauseComment).not.toMatch(/^VERDICT:/m)
  }, 20000)
})

// --- a report.txt missing SECRETS is infrastructure, never a fabricated
// clean claim (review-validity-v1 12, #526 round 2, security HIGH) ---

/**
 * Security writes a complete, parseable report on BOTH attempts — except it
 * never writes a `SECRETS:` line. Before this fix, `buildVerdictFromReport`
 * defaulted a missing `SECRETS` key to the literal "none found" — a CLEAN
 * self-attestation `security.md` requires evidence for — so a reviewer
 * session that crashed or forgot the line got its verdict rendered as if it
 * had actually checked. This proves it is now the same one-retry-then-pause
 * treatment `findings.txt`/`objectives.txt` already get, never a silently
 * fabricated clean claim.
 */
function writeFakeClaudeSecurityOmitsSecretsScenario(dir: string): void {
  writeFakeBinary(
    dir,
    'claude',
    `#!/bin/sh
touch "$HOME/.fake-dev-invoked" 2>/dev/null
cat > /dev/null
WORKROOT="$HOME/.vinaya/outbox/dev-review-loop/$VINAYA_TASK"
case "$VINAYA_ROLE" in
  code-reviewer)
    WD="$WORKROOT/round-$VINAYA_ROUND-reviewer-work"
    mkdir -p "$WD"
    : > "$WD/findings.txt"
    printf 'O1|MET|done.\\n' > "$WD/objectives.txt"
    printf 'BRIEF_CONFORMANCE: yes\\nSPEC_CONFORMANCE: yes\\nSCOPE: small\\nTESTS: pass\\nDOCS: n/a\\n' > "$WD/report.txt"
    echo '{"session_id":"rev-session-1","usage":{"input_tokens":8,"output_tokens":4}}'
    ;;
  security)
    ATTEMPT=$(cat "$HOME/.security-invocations" 2>/dev/null | wc -l | tr -d ' ')
    WD="$WORKROOT/round-$VINAYA_ROUND-security-work"
    if [ "$ATTEMPT" != "0" ]; then
      WD="$WORKROOT/round-$VINAYA_ROUND-security-work-retry1"
    fi
    mkdir -p "$WD"
    : > "$WD/findings.txt"
    printf 'O1|MET|done.\\n' > "$WD/objectives.txt"
    printf 'CONFIG_SCAN: clean\\n' > "$WD/report.txt"
    echo "invocation" >> "$HOME/.security-invocations"
    echo '{"session_id":"sec-session-no-secrets","usage":{"input_tokens":8,"output_tokens":4}}'
    ;;
  *)
    echo '{"session_id":"dev-session-1","usage":{"input_tokens":10,"output_tokens":5}}'
    ;;
esac
exit 0
`
  )
}

function setUpSecurityOmitsSecrets(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudeSecurityOmitsSecretsScenario(binDir)
  writeFakeGh(binDir)
  writeFakeGit(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — a report.txt missing SECRETS is an infrastructure pause, never a fabricated clean claim (review-validity-v1 12, #526 round 2)', () => {
  it('retries once into a fresh work directory, then pauses naming report.txt and the reviewer session id — never a silent "none found"', () => {
    const { home, cwd, path } = setUpSecurityOmitsSecrets()
    const r = runLoop(home, cwd, path)
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/paused \(infrastructure\)/)

    const invocations = readFileSync(join(home, '.security-invocations'), 'utf8').trim().split('\n').filter(Boolean)
    expect(invocations).toHaveLength(2)

    const pausedFiles = postedCommentFiles(home)
    expect(pausedFiles).toHaveLength(1)
    const pauseComment = readFileSync(join(home, '.fake-gh-posted-comments', pausedFiles[0] as string), 'utf8')
    expect(pauseComment).toMatch(/^<!-- aeg:loop:paused:infrastructure -->$/m)
    expect(pauseComment).toMatch(/report\.txt/)
    expect(pauseComment).toMatch(/sec-session-no-secrets/)
    expect(pauseComment).not.toMatch(/^VERDICT:/m)
    expect(pauseComment).not.toMatch(/SECRETS: none found/)
  }, 20000)
})

// --- an empty findings file is still a clean verdict (O1, contrast case) ---
//
// Already proven by 'devReviewLoop — round 1 clean, ends on publish', above:
// both roles there write an EMPTY findings.txt (`: > "$WD/findings.txt"`, a
// real, existing, zero-byte file) and the loop still reaches `publish` with
// `VERDICT: APPROVE`/`VERDICT: PASS` — the exact contrast the Traps to avoid
// section requires: empty is clean, absent (this section, above) is not.

// --- the objectives file, when the task carries objectives (O3) -----------

/**
 * Security writes `findings.txt` and `report.txt` — a real, complete-looking
 * report — but never `objectives.txt`, on either attempt, even though this
 * suite's shared `writeFakeGh` brief carries a real `## Objectives` section
 * (task `review-validity-v1` 1, `#475`, O3). This is the same infrastructure
 * outcome as the findings/report case, above — a task with objectives that
 * gets no answer on them is not a clean, silently-vacuous APPROVE. The
 * code-reviewer half captures its own received prompt so the test can
 * confirm the prompt itself named `objectives.txt` — O3's other half: the
 * ask, not just the enforcement.
 */
function writeFakeClaudeMissingObjectivesScenario(dir: string): void {
  writeFakeBinary(
    dir,
    'claude',
    `#!/bin/sh
touch "$HOME/.fake-dev-invoked" 2>/dev/null
PROMPT="$(cat)"
WORKROOT="$HOME/.vinaya/outbox/dev-review-loop/$VINAYA_TASK"
case "$VINAYA_ROLE" in
  code-reviewer)
    WD="$WORKROOT/round-$VINAYA_ROUND-reviewer-work"
    mkdir -p "$WD"
    printf '%s' "$PROMPT" > "$WORKROOT/round-$VINAYA_ROUND-reviewer-prompt.txt"
    : > "$WD/findings.txt"
    printf 'O1|MET|done.\\n' > "$WD/objectives.txt"
    printf 'BRIEF_CONFORMANCE: yes\\nSPEC_CONFORMANCE: yes\\nSCOPE: small\\nTESTS: pass\\nDOCS: n/a\\n' > "$WD/report.txt"
    echo '{"session_id":"rev-session-1","usage":{"input_tokens":8,"output_tokens":4}}'
    ;;
  security)
    WD="$WORKROOT/round-$VINAYA_ROUND-security-work"
    mkdir -p "$WD"
    : > "$WD/findings.txt"
    printf 'CONFIG_SCAN: clean\\nSECRETS: none found\\n' > "$WD/report.txt"
    echo "invocation" >> "$HOME/.security-invocations"
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

function setUpMissingObjectives(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudeMissingObjectivesScenario(binDir)
  writeFakeGh(binDir)
  writeFakeGit(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — the reviewer prompt names the objectives file, and omitting it is the O1 infrastructure outcome (O3)', () => {
  it('names objectives.txt in the prompt when the task carries objectives, and pauses as infrastructure when security omits it', () => {
    const { home, cwd, path } = setUpMissingObjectives()
    const r = runLoop(home, cwd, path)
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/paused \(infrastructure\)/)

    const reviewerPrompt = readFileSync(
      join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'round-1-reviewer-prompt.txt'),
      'utf8'
    )
    expect(reviewerPrompt).toMatch(/objectives\.txt/)
    expect(reviewerPrompt).toMatch(/O<n>\|MET\|<evidence>/)
    // O6 (review-validity-v1 task 8, #506): the prompt states the bare-word
    // status rule and that `|` never appears in a description.
    expect(reviewerPrompt).toMatch(/bare leading word/)
    expect(reviewerPrompt).toMatch(/`\|` never appears in a description/)

    const invocations = readFileSync(join(home, '.security-invocations'), 'utf8').trim().split('\n').filter(Boolean)
    expect(invocations).toHaveLength(2)

    const pausedFiles = postedCommentFiles(home)
    const pauseComment = readFileSync(join(home, '.fake-gh-posted-comments', pausedFiles[0] as string), 'utf8')
    expect(pauseComment).toMatch(/^<!-- aeg:loop:paused:infrastructure -->$/m)
    expect(pauseComment).toMatch(/security/)
    expect(pauseComment).toMatch(/objectives\.txt/)

    // The code-reviewer half finishes clean, well before security's own
    // retry exhausts — its held verdict must not survive on disk either
    // (round 1 review finding, BLOCKER, PR #489).
    const drlRoot = join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK))
    expect(existsSync(join(drlRoot, 'round-1-reviewer.md'))).toBe(false)
    expect(existsSync(join(drlRoot, 'round-1-security.md'))).toBe(false)
  }, 20000)
})

// --- O2/O3: a red gate that the developer never fixes pauses, bounded ------

/**
 * The developer role only — reviewers are never reached in this scenario
 * (the mechanical gate never turns green). Marks `$HOME/.fake-dev-invoked`
 * (the same signal `writeFakeGit`'s `ls-remote` and `writeFakeGh`'s `pr
 * list` gate on) and otherwise does nothing — in particular, it never
 * touches the branch head, simulating a developer turn that produces no
 * push at all.
 */
function writeFakeClaudeNeverPushes(dir: string): void {
  writeFakeBinary(
    dir,
    'claude',
    `#!/bin/sh
cat > /dev/null
touch "$HOME/.fake-dev-invoked" 2>/dev/null
echo '{"session_id":"dev-session-1","usage":{"input_tokens":10,"output_tokens":5}}'
exit 0
`
  )
}

/** Same as \`writeFakeGh\`, except the mechanical check-run always reads red — this scenario's gate never turns green. */
function writeFakeGhAlwaysRedCi(dir: string): void {
  writeFakeBinary(
    dir,
    'gh',
    `#!/bin/sh
STATE_DIR="$HOME/.fake-gh-posted-comments"
mkdir -p "$STATE_DIR"
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "comments" ]; then
  printf '%s\\n' '{"comments":[{"body":"<!-- aeg:brief:v1 -->\\nBrief hash: deadbeef\\nDo the thing.\\n\\n## Objectives\\n\\nO1. Do the thing.\\n","author":{"login":"daniboomerang"}}]}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "title" ]; then
  printf '%s\\n' '{"title":"[dev-review-loop-v1] ${TASK} \\u2014 test task"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  if [ -f "$HOME/.fake-dev-invoked" ]; then
    echo '[{"number":123,"headRefName":"${BRANCH}"}]'
  else
    echo '[]'
  fi
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  N=$(ls "$STATE_DIR"/comment-*.md 2>/dev/null | wc -l | tr -d ' ')
  BODY_FILE="$5"
  cp "$BODY_FILE" "$STATE_DIR/comment-$((N + 1)).md"
  echo "https://github.com/example/repo/pull/$3#issuecomment-$((N + 1))"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "mergeable" ]; then
  echo '{"mergeable":"MERGEABLE"}'
  exit 0
fi
if [ "$1" = "api" ] && [ "\${2#*check-runs}" != "$2" ]; then
  echo '{"id":1,"name":"Vinaya CI","status":"completed","conclusion":"failure"}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
  echo "fake gh: refusing issue comment (log flush not under test)" >&2
  exit 1
fi
echo "unhandled fake gh call: $*" >&2
exit 1
`
  )
}

function setUpNeverPushes(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudeNeverPushes(binDir)
  writeFakeGhAlwaysRedCi(binDir)
  writeFakeGit(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — a red gate the developer never fixes pauses, bounded (O2/O3)', () => {
  it('waits for the head to change, never re-reads a tight loop, and pauses naming the head and the failing check after the bound', () => {
    const { home, cwd, path } = setUpNeverPushes()
    const r = runDevReviewLoopArgs(home, cwd, path, ['--task', String(TASK), '--agent', 'claude'], {
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_MAX_ATTEMPTS: '2',
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_INTERVAL_MS: '10'
    })
    expect(r.status).not.toBe(0)
    // Driver-decided, same as the reviewer-infrastructure pause (O5) — this
    // task's own declared Surface excludes `packages/aeg-core`, so a
    // genuinely new `PauseReason` isn't available; the bound reuses
    // `'infrastructure'`, distinguished from the reviewer case by its detail
    // text (the head and the failing check-run, never a role/artifact).
    expect(r.stdout).toMatch(/paused \(infrastructure\)/)

    // O3: the developer was told which check-run actually failed, never a
    // bare "CI is red" and never the review gate's own name.
    const pauseComment = readFileSync(join(home, '.fake-gh-posted-comments', 'comment-1.md'), 'utf8')
    expect(pauseComment).toMatch(/^<!-- aeg:loop:paused:infrastructure -->$/m)
    expect(pauseComment).toMatch(/Vinaya CI/)
    expect(pauseComment).not.toMatch(/review gate/i)

    // O2: the driver's own bounded events for this pause — `stop_condition_met`
    // fires exactly once (at the bound), never once per stalled turn.
    const loopEvents = outboxLines(home)
      .filter((l) => l.kind === 'dev_review_loop')
      .map((l) => l.event)
    expect(loopEvents.filter((e) => e === 'stop_condition_met')).toHaveLength(1)
    expect(loopEvents.filter((e) => e === 'paused')).toHaveLength(1)
    const stop = outboxLines(home).find((l) => l.event === 'stop_condition_met') as Record<string, unknown>
    expect(stop.condition).toBe('principal_stop')

    const pauseState = JSON.parse(
      readFileSync(join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'pause-state.json'), 'utf8')
    ) as Record<string, unknown>
    expect(pauseState.reason).toBe('infrastructure')
    expect(pauseState.detail).toMatch(/head .* unchanged/)
  }, 20000)
})

// --- O4: round-1 entry attaches to an open PR, resuming the recorded session ---

/**
 * The developer role records every invocation as `<hasResume>:<resumeId>`
 * to `$HOME/.dev-invocations` — round 1's OWN dispatch never happens in the
 * attach case (O4), so the FIRST line this file ever gets is round 2's
 * resumed dispatch, and it must carry the id `readResumeRecord` reads back
 * from the pre-seeded durable record, never a fresh session.
 */
function writeFakeClaudeAttachScenario(dir: string): void {
  writeFakeBinary(
    dir,
    'claude',
    `#!/bin/sh
cat > /dev/null
WORKROOT="$HOME/.vinaya/outbox/dev-review-loop/$VINAYA_TASK"
HAS_RESUME=0
RESUME_ID=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-r" ]; then HAS_RESUME=1; RESUME_ID="$a"; fi
  prev="$a"
done
case "$VINAYA_ROLE" in
  code-reviewer)
    WD="$WORKROOT/round-$VINAYA_ROUND-reviewer-work"
    mkdir -p "$WD"
    if [ "$VINAYA_ROUND" = "1" ]; then
      printf '%s\\n' 'BLOCKER|smoke.ts:1|deliberate round-1 blocker to force round 2' > "$WD/findings.txt"
    else
      : > "$WD/findings.txt"
    fi
    printf 'O1|MET|done.\\n' > "$WD/objectives.txt"
    printf 'BRIEF_CONFORMANCE: yes\\nSPEC_CONFORMANCE: yes\\nSCOPE: small\\nTESTS: pass\\nDOCS: n/a\\n' > "$WD/report.txt"
    echo '{"session_id":"rev-session-'"$VINAYA_ROUND"'","usage":{"input_tokens":8,"output_tokens":4}}'
    ;;
  security)
    WD="$WORKROOT/round-$VINAYA_ROUND-security-work"
    mkdir -p "$WD"
    : > "$WD/findings.txt"
    printf 'O1|MET|done.\\n' > "$WD/objectives.txt"
    printf 'CONFIG_SCAN: clean\\nSECRETS: none found\\n' > "$WD/report.txt"
    echo '{"session_id":"sec-session-'"$VINAYA_ROUND"'","usage":{"input_tokens":8,"output_tokens":4}}'
    ;;
  *)
    echo "$HAS_RESUME:$RESUME_ID" >> "$HOME/.dev-invocations"
    mkdir -p "$WORKROOT"
    if [ "$VINAYA_ROUND" != "1" ]; then
      mkdir -p "$PWD/.worktrees/task/dev-review-loop-v1/$VINAYA_TASK"
      echo "CONFIDENCE: 90 — addressed the round 1 blocker" > "$PWD/.worktrees/task/dev-review-loop-v1/$VINAYA_TASK/.vinaya-confidence"
    fi
    echo '{"session_id":"dev-session-fresh","usage":{"input_tokens":10,"output_tokens":5}}'
    ;;
esac
exit 0
`
  )
}

/** `pr list` answers the open PR unconditionally, from the very first call — a real attach, never gated on a prior dispatch. */
function writeFakeGhAttach(dir: string): void {
  writeFakeBinary(
    dir,
    'gh',
    `#!/bin/sh
STATE_DIR="$HOME/.fake-gh-posted-comments"
mkdir -p "$STATE_DIR"
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "comments" ]; then
  printf '%s\\n' '{"comments":[{"body":"<!-- aeg:brief:v1 -->\\nBrief hash: deadbeef\\nDo the thing.\\n\\n## Objectives\\n\\nO1. Do the thing.\\n","author":{"login":"daniboomerang"}}]}'
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
if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  N=$(ls "$STATE_DIR"/comment-*.md 2>/dev/null | wc -l | tr -d ' ')
  BODY_FILE="$5"
  cp "$BODY_FILE" "$STATE_DIR/comment-$((N + 1)).md"
  echo "https://github.com/example/repo/pull/$3#issuecomment-$((N + 1))"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "body" ]; then
  echo '{"body":"Closes #${TASK}"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "mergeable" ]; then
  echo '{"mergeable":"MERGEABLE"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "comments" ]; then
  FAKE_GH_STATE="$STATE_DIR" bun -e '
    const fs = require("fs")
    const dir = process.env.FAKE_GH_STATE
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("comment-"))
      .sort((a, b) => Number(a.match(/\\d+/)[0]) - Number(b.match(/\\d+/)[0]))
    const bodies = files.map((f) => fs.readFileSync(dir + "/" + f, "utf8"))
    console.log(JSON.stringify({ comments: bodies.map((body) => ({ body, author: { login: "daniboomerang" } })) }))
  '
  exit 0
fi
if [ "$1" = "api" ] && [ "\${2#*check-runs}" != "$2" ]; then
  echo '{"id":1,"name":"Vinaya CI","status":"completed","conclusion":"success"}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
  echo "fake gh: refusing issue comment (log flush not under test)" >&2
  exit 1
fi
echo "unhandled fake gh call: $*" >&2
exit 1
`
  )
}

/** `ls-remote` answers the real head unconditionally — the branch already exists remotely, the whole premise of attach. */
function writeFakeGitAttach(dir: string): void {
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

function setUpAttach(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudeAttachScenario(binDir)
  writeFakeGhAttach(binDir)
  writeFakeGitAttach(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — round 1 entry attaches to an open PR, resuming the recorded session (O4)', () => {
  it('starts no developer on round 1, then resumes the pre-recorded session (never fresh) when round 2 needs one', () => {
    const { home, cwd, path } = setUpAttach()

    // Pre-seed the durable resume record `readResumeRecord` must read on
    // attach — the loop never dispatches a developer of its own on round 1
    // to produce one; it has to come from a prior, already-recorded session.
    // `resolveRepo()` resolves `null` in this non-git scratch `cwd`, so the
    // record lives under the deterministic `unresolved` repo segment
    // (`dispatch.ts`'s own `resumeRecordPathFor`).
    const resumeDir = join(home, '.vinaya', 'dispatch-resume', 'unresolved')
    mkdirSync(resumeDir, { recursive: true })
    writeFileSync(
      join(resumeDir, `developer-claude-issue${TASK}.json`),
      JSON.stringify({
        resumeId: 'seeded-session-42',
        role: 'developer',
        agent: 'claude',
        repo: null,
        task: TASK,
        pr: null,
        round: null,
        effectId: 'seed',
        capturedAt: new Date().toISOString()
      })
    )

    const r = runLoop(home, cwd, path)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/publish/)

    // Round 1 never dispatched a developer at all — attach skips straight to
    // the gate. The only line in this file is round 2's resumed dispatch.
    const invocations = readFileSync(join(home, '.dev-invocations'), 'utf8').trim().split('\n').filter(Boolean)
    expect(invocations).toHaveLength(1)
    expect(invocations[0]).toBe('1:seeded-session-42')
  }, 20000)
})

// --- O4: a remote branch with no open PR resumes once to open it -----------

/**
 * The developer role records `<hasResume>:<resumeId>:<promptFirstLine>` to
 * `$HOME/.dev-invocations`, then touches `$HOME/.fake-dev-invoked` (making
 * `writeFakeGh`'s `pr list` start answering the PR, exactly as if this
 * dispatch had really just run `pr create`) and otherwise behaves like the
 * clean round-1 fixture.
 */
function writeFakeClaudeRemoteBranchNoPrScenario(dir: string): void {
  writeFakeBinary(
    dir,
    'claude',
    `#!/bin/sh
PROMPT="$(cat)"
WORKROOT="$HOME/.vinaya/outbox/dev-review-loop/$VINAYA_TASK"
HAS_RESUME=0
RESUME_ID=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-r" ]; then HAS_RESUME=1; RESUME_ID="$a"; fi
  prev="$a"
done
case "$VINAYA_ROLE" in
  code-reviewer)
    WD="$WORKROOT/round-$VINAYA_ROUND-reviewer-work"
    mkdir -p "$WD"
    : > "$WD/findings.txt"
    printf 'O1|MET|done.\\n' > "$WD/objectives.txt"
    printf 'BRIEF_CONFORMANCE: yes\\nSPEC_CONFORMANCE: yes\\nSCOPE: small\\nTESTS: pass\\nDOCS: n/a\\n' > "$WD/report.txt"
    echo '{"session_id":"rev-session-1","usage":{"input_tokens":8,"output_tokens":4}}'
    ;;
  security)
    WD="$WORKROOT/round-$VINAYA_ROUND-security-work"
    mkdir -p "$WD"
    : > "$WD/findings.txt"
    printf 'O1|MET|done.\\n' > "$WD/objectives.txt"
    printf 'CONFIG_SCAN: clean\\nSECRETS: none found\\n' > "$WD/report.txt"
    echo '{"session_id":"sec-session-1","usage":{"input_tokens":8,"output_tokens":4}}'
    ;;
  *)
    FIRST_LINE=$(printf '%s' "$PROMPT" | head -n 1)
    echo "$HAS_RESUME:$RESUME_ID:$FIRST_LINE" >> "$HOME/.dev-invocations"
    touch "$HOME/.fake-dev-invoked"
    echo '{"session_id":"dev-session-fresh","usage":{"input_tokens":10,"output_tokens":5}}'
    ;;
esac
exit 0
`
  )
}

function setUpRemoteBranchNoPr(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudeRemoteBranchNoPrScenario(binDir)
  writeFakeGh(binDir) // gates `pr list` on `.fake-dev-invoked` — starts empty
  writeFakeGitAttach(binDir) // `ls-remote` answers unconditionally — the branch already exists
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — a remote branch with no open PR resumes the recorded session once to open it (O4)', () => {
  it('never starts a fresh developer — resumes the pre-recorded session with the pr-create instruction, then waits for the PR', () => {
    const { home, cwd, path } = setUpRemoteBranchNoPr()

    const resumeDir = join(home, '.vinaya', 'dispatch-resume', 'unresolved')
    mkdirSync(resumeDir, { recursive: true })
    writeFileSync(
      join(resumeDir, `developer-claude-issue${TASK}.json`),
      JSON.stringify({
        resumeId: 'seeded-session-7',
        role: 'developer',
        agent: 'claude',
        repo: null,
        task: TASK,
        pr: null,
        round: null,
        effectId: 'seed',
        capturedAt: new Date().toISOString()
      })
    )

    const r = runLoop(home, cwd, path)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/publish/)

    const invocations = readFileSync(join(home, '.dev-invocations'), 'utf8').trim().split('\n').filter(Boolean)
    // Exactly one developer dispatch to open the PR — never a second, fresh one.
    expect(invocations).toHaveLength(1)
    const [hasResume, resumeId, firstLine] = (invocations[0] as string).split(':')
    expect(hasResume).toBe('1')
    expect(resumeId).toBe('seeded-session-7')
    expect(firstLine).toMatch(/already exists with no open pull request/)
  }, 20000)
})

// --- task-run-v1 13 (#508): the developer's first turn ends with no push at all, resumed once (O2/O3) ---

/**
 * The first (fresh) developer dispatch does nothing — no push, no PR — and
 * never touches `.fake-dev-invoked`. A SECOND (resumed) dispatch behaves
 * like the clean round-1 fixture: it touches the marker (making
 * `writeFakeGit`'s `ls-remote` and `writeFakeGh`'s `pr list` start
 * answering, exactly as if this dispatch had really just pushed and opened
 * the PR). Each developer invocation's `$HAS_RESUME` flag is appended to
 * `.dev-invocations` and its full prompt is saved to `.dev-prompt-<n>.txt`
 * (never colon-split off one recorded line — this scenario's own prompt
 * text carries a colon in its first line).
 */
function writeFakeClaudeNoPushThenResumeScenario(dir: string): void {
  writeFakeBinary(
    dir,
    'claude',
    `#!/bin/sh
PROMPT="$(cat)"
HAS_RESUME=0
prev=""
for a in "$@"; do
  if [ "$prev" = "-r" ]; then HAS_RESUME=1; fi
  prev="$a"
done
case "$VINAYA_ROLE" in
  code-reviewer)
    WD="$HOME/.vinaya/outbox/dev-review-loop/$VINAYA_TASK/round-$VINAYA_ROUND-reviewer-work"
    mkdir -p "$WD"
    : > "$WD/findings.txt"
    printf 'O1|MET|done.\\n' > "$WD/objectives.txt"
    printf 'BRIEF_CONFORMANCE: yes\\nSPEC_CONFORMANCE: yes\\nSCOPE: small\\nTESTS: pass\\nDOCS: n/a\\n' > "$WD/report.txt"
    echo '{"session_id":"rev-session-1","usage":{"input_tokens":8,"output_tokens":4}}'
    ;;
  security)
    WD="$HOME/.vinaya/outbox/dev-review-loop/$VINAYA_TASK/round-$VINAYA_ROUND-security-work"
    mkdir -p "$WD"
    : > "$WD/findings.txt"
    printf 'O1|MET|done.\\n' > "$WD/objectives.txt"
    printf 'CONFIG_SCAN: clean\\nSECRETS: none found\\n' > "$WD/report.txt"
    echo '{"session_id":"sec-session-1","usage":{"input_tokens":8,"output_tokens":4}}'
    ;;
  *)
    echo "$HAS_RESUME" >> "$HOME/.dev-invocations"
    COUNT=$(wc -l < "$HOME/.dev-invocations" | tr -d ' ')
    printf '%s' "$PROMPT" > "$HOME/.dev-prompt-$COUNT.txt"
    if [ "$HAS_RESUME" = "1" ]; then
      touch "$HOME/.fake-dev-invoked"
    fi
    echo '{"session_id":"dev-session-fresh","usage":{"input_tokens":10,"output_tokens":5}}'
    ;;
esac
exit 0
`
  )
}

function setUpNoPushThenResume(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudeNoPushThenResumeScenario(binDir)
  writeFakeGh(binDir)
  writeFakeGit(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe("devReviewLoop — the developer's first turn ends with no push at all, resumed once (O2, task-run-v1 13, #508)", () => {
  it('resumes once with the push-and-open instructions before ever polling, then publishes once the resumed turn actually pushes', () => {
    const { home, cwd, path } = setUpNoPushThenResume()

    const r = runLoop(home, cwd, path)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/publish/)

    const invocations = readFileSync(join(home, '.dev-invocations'), 'utf8').trim().split('\n').filter(Boolean)
    // Exactly two developer turns: the fresh brief, then ONE resume — never
    // a second resume for this (Traps to avoid).
    expect(invocations).toEqual(['0', '1'])

    const resumedPrompt = readFileSync(join(home, '.dev-prompt-2.txt'), 'utf8')
    expect(resumedPrompt).toMatch(/push and the pull-request open are foreground steps/i)
    expect(resumedPrompt).toMatch(/git push/)
    expect(resumedPrompt).toMatch(/pr create/)
  }, 20000)
})

/** Never touches `.fake-dev-invoked`, ever, on any invocation — a developer whose branch never reaches the remote no matter how many turns it gets. */
function writeFakeClaudeNoPushEver(dir: string): void {
  writeFakeBinary(
    dir,
    'claude',
    `#!/bin/sh
cat > /dev/null
echo '{"session_id":"dev-session-1","usage":{"input_tokens":10,"output_tokens":5}}'
exit 0
`
  )
}

function setUpNoPushEver(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudeNoPushEver(binDir)
  writeFakeGh(binDir)
  writeFakeGit(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — the pull-request poll gives up naming what it waited for (O3, task-run-v1 13, #508)', () => {
  it('names branch, local head (unknown), remote head (none), and pull-request absence, after resuming once', () => {
    const { home, cwd, path } = setUpNoPushEver()

    const r = runDevReviewLoopArgs(home, cwd, path, ['--task', String(TASK), '--agent', 'claude'], {
      VINAYA_DEV_REVIEW_LOOP_PR_POLL_MAX_ATTEMPTS: '2',
      VINAYA_DEV_REVIEW_LOOP_PR_POLL_INTERVAL_MS: '5'
    })
    expect(r.status).not.toBe(0)
    const output = r.stdout + r.stderr
    expect(output).toMatch(new RegExp(`branch: ${BRANCH.replace(/\//g, '\\/')}`))
    expect(output).toMatch(/local head: \(worktree not found/)
    expect(output).toMatch(/remote head: \(no head on origin\)/)
    expect(output).toMatch(/pull request: none open/)
  }, 20000)
})

// --- task-run-v1 13 (#508), O9: a refusal/escalation before any push ends the loop at once ---

/** Never pushes, ever — and posts nothing itself; the STOP marker is seeded directly on the fake gh's Issue-comments response (below), standing in for a developer that posted one before ending its turn. */
function setUpStopBeforePush(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudeNoPushEver(binDir)
  writeFakeBinary(
    binDir,
    'gh',
    `#!/bin/sh
STATE_DIR="$HOME/.fake-gh-posted-comments"
mkdir -p "$STATE_DIR"
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "comments" ]; then
  printf '%s\\n' '{"comments":[{"body":"<!-- aeg:brief:v1 -->\\nBrief hash: deadbeef\\nDo the thing.\\n\\n## Objectives\\n\\nO1. Do the thing.\\n","author":{"login":"daniboomerang"}},{"body":"<!-- aeg:developer:stop -->\\nEntry gate refused: brief is missing tier/scope/stop-conditions.","author":{"login":"daniboomerang"}}]}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "title" ]; then
  printf '%s\\n' '{"title":"[dev-review-loop-v1] ${TASK} \\u2014 test task"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  echo '[]'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
  N=$(ls "$STATE_DIR"/comment-*.md 2>/dev/null | wc -l | tr -d ' ')
  BODY_FILE="$5"
  cp "$BODY_FILE" "$STATE_DIR/comment-$((N + 1)).md"
  echo "https://github.com/example/repo/issues/$3#issuecomment-$((N + 1))"
  exit 0
fi
echo "unhandled fake gh call in stop-before-push scenario: $*" >&2
exit 1
`
  )
  writeFakeGit(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — a refusal/escalation posted before any push ends the loop at once (O9, task-run-v1 13, #508)', () => {
  it('never enters the pull-request poll, posts on the Issue (no PR exists yet), and exits non-zero', () => {
    const { home, cwd, path } = setUpStopBeforePush()

    const r = runLoop(home, cwd, path)
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/paused \(escalation\)/)

    // Exactly one developer turn — the fresh brief — never a resume: O9
    // short-circuits before O2's own resume-once logic ever runs.
    expect(existsSync(join(home, '.dev-invocations'))).toBe(false)

    // `postedCommentFiles` also picks up this scenario's own working `gh
    // issue comment` (needed for the real Issue-posted pause — there is no
    // PR yet) being incidentally reused by the driver's own best-effort log
    // flush; isolate this test's own pause comment by its marker rather than
    // asserting a bare count.
    const posted = postedCommentFiles(home)
    const pauseFiles = posted.filter((f) =>
      readFileSync(join(home, '.fake-gh-posted-comments', f), 'utf8').includes('aeg:loop:paused:escalation')
    )
    expect(pauseFiles).toHaveLength(1)
    const body = readFileSync(join(home, '.fake-gh-posted-comments', pauseFiles[0] as string), 'utf8')
    expect(body).toMatch(/^<!-- aeg:loop:paused:escalation -->$/m)
    expect(body).toMatch(/brief is missing tier\/scope\/stop-conditions/)
    expect(body).toMatch(/vinaya task run/)
  }, 20000)
})

// --- task-run-v1 13 (#508), O4/O6: mergeability blocks reviewer dispatch ---

/**
 * Pushes and opens the PR normally on the FIRST (fresh) developer call —
 * exactly like `writeFakeClaude`'s own round-1 fixture. Every developer
 * call's `$HAS_RESUME` flag and full prompt are recorded (never colon-split
 * — this scenario's conflict prompt carries no colon in its first line, but
 * the convention is kept consistent with the O2 fixture above). Reviewer
 * roles record their own invocation too — this test asserts that marker is
 * NEVER created, since a conflicting head must never reach a reviewer
 * dispatch at all.
 */
function writeFakeClaudeConflictScenario(dir: string): void {
  writeFakeBinary(
    dir,
    'claude',
    `#!/bin/sh
PROMPT="$(cat)"
HAS_RESUME=0
prev=""
for a in "$@"; do
  if [ "$prev" = "-r" ]; then HAS_RESUME=1; fi
  prev="$a"
done
case "$VINAYA_ROLE" in
  code-reviewer|security)
    touch "$HOME/.reviewer-invoked"
    WD="$HOME/.vinaya/outbox/dev-review-loop/$VINAYA_TASK/round-$VINAYA_ROUND-$VINAYA_ROLE-work"
    mkdir -p "$WD"
    : > "$WD/findings.txt"
    printf 'O1|MET|done.\\n' > "$WD/objectives.txt"
    printf 'BRIEF_CONFORMANCE: yes\\nSPEC_CONFORMANCE: yes\\nSCOPE: small\\nTESTS: pass\\nDOCS: n/a\\n' > "$WD/report.txt"
    echo '{"session_id":"rev-session-1","usage":{"input_tokens":8,"output_tokens":4}}'
    ;;
  *)
    echo "$HAS_RESUME" >> "$HOME/.dev-invocations"
    COUNT=$(wc -l < "$HOME/.dev-invocations" | tr -d ' ')
    printf '%s' "$PROMPT" > "$HOME/.dev-prompt-$COUNT.txt"
    touch "$HOME/.fake-dev-invoked"
    echo '{"session_id":"dev-session-fresh","usage":{"input_tokens":10,"output_tokens":5}}'
    ;;
esac
exit 0
`
  )
}

/** Same as \`writeFakeGh\`, except \`pr view --json mergeable\` always answers \`CONFLICTING\` — this scenario's head never resolves. */
function writeFakeGhAlwaysConflicting(dir: string): void {
  writeFakeBinary(
    dir,
    'gh',
    `#!/bin/sh
STATE_DIR="$HOME/.fake-gh-posted-comments"
mkdir -p "$STATE_DIR"
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "comments" ]; then
  printf '%s\\n' '{"comments":[{"body":"<!-- aeg:brief:v1 -->\\nBrief hash: deadbeef\\nDo the thing.\\n\\n## Objectives\\n\\nO1. Do the thing.\\n","author":{"login":"daniboomerang"}}]}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "title" ]; then
  printf '%s\\n' '{"title":"[dev-review-loop-v1] ${TASK} \\u2014 test task"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  if [ -f "$HOME/.fake-dev-invoked" ]; then
    echo '[{"number":123,"headRefName":"${BRANCH}"}]'
  else
    echo '[]'
  fi
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  N=$(ls "$STATE_DIR"/comment-*.md 2>/dev/null | wc -l | tr -d ' ')
  BODY_FILE="$5"
  cp "$BODY_FILE" "$STATE_DIR/comment-$((N + 1)).md"
  echo "https://github.com/example/repo/pull/$3#issuecomment-$((N + 1))"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "mergeable" ]; then
  echo '{"mergeable":"CONFLICTING"}'
  exit 0
fi
if [ "$1" = "api" ] && [ "\${2#*check-runs}" != "$2" ]; then
  touch "$HOME/.ci-conclusion-checked"
  echo '{"id":1,"name":"ci","status":"completed","conclusion":"success"}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
  echo "fake gh: refusing issue comment (log flush not under test)" >&2
  exit 1
fi
echo "unhandled fake gh call in conflict scenario: $*" >&2
exit 1
`
  )
}

/** Same as \`writeFakeGit\`, plus a \`merge-tree\` that always reports one conflicting file. */
function writeFakeGitConflict(dir: string): void {
  writeFakeBinary(
    dir,
    'git',
    `#!/bin/sh
if [ "$1" = "ls-remote" ]; then
  if [ -f "$HOME/.fake-dev-invoked" ]; then
    echo "${HEAD_SHA}	refs/heads/${BRANCH}"
  fi
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
if [ "$1" = "merge-tree" ]; then
  echo "CONFLICT (content): Merge conflict in apps/cli/src/lib/dev-review-loop.ts"
  exit 1
fi
exit 1
`
  )
}

function setUpConflict(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudeConflictScenario(binDir)
  writeFakeGhAlwaysConflicting(binDir)
  writeFakeGitConflict(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — a conflicting head is sent back to the developer, never to a reviewer (O4/O6, task-run-v1 13, #508)', () => {
  it('reads mergeability before dispatching reviewers, names the conflicting file, and never starts a reviewer for this head', () => {
    const { home, cwd, path } = setUpConflict()

    const r = runDevReviewLoopArgs(home, cwd, path, ['--task', String(TASK), '--agent', 'claude'], {
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_MAX_ATTEMPTS: '2',
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_INTERVAL_MS: '10'
    })
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/paused \(infrastructure\)/)

    // No reviewer was ever dispatched — the conflict was caught before any
    // reviewer read this head.
    expect(existsSync(join(home, '.reviewer-invoked'))).toBe(false)

    // O4 (round 2 review, BLOCKER): CI is never waited on for a head that
    // starts this round already CONFLICTING — mergeability is checked
    // before `waitForGreenGate` ever calls `gh api .../check-runs`, not
    // after it, so this marker is never touched.
    expect(existsSync(join(home, '.ci-conclusion-checked'))).toBe(false)
    // Same fact, checked a second, more direct way: `gate_result_read` is
    // the one durable event a real `waitForGreenGate` call ever produces
    // (fed from its own `gate` observation into `assessRound`) — its
    // absence from the outbox is a code-level guarantee CI was never
    // waited on, independent of the shell marker above.
    expect(outboxLines(home).some((l) => l.event === 'gate_result_read')).toBe(false)

    // The fresh brief, then two conflict-retry dispatches (the bound) —
    // never a reviewer prompt anywhere in this file.
    const invocations = readFileSync(join(home, '.dev-invocations'), 'utf8').trim().split('\n').filter(Boolean)
    expect(invocations).toHaveLength(3)

    const conflictPrompt = readFileSync(join(home, '.dev-prompt-2.txt'), 'utf8')
    expect(conflictPrompt).toMatch(/behind the base in a way that conflicts/)
    expect(conflictPrompt).toMatch(/apps\/cli\/src\/lib\/dev-review-loop\.ts/)

    const pauseComment = readFileSync(join(home, '.fake-gh-posted-comments', 'comment-1.md'), 'utf8')
    expect(pauseComment).toMatch(/^<!-- aeg:loop:paused:infrastructure -->$/m)
    expect(pauseComment).toMatch(/conflict never resolved/)
    expect(pauseComment).toMatch(/apps\/cli\/src\/lib\/dev-review-loop\.ts/)
  }, 20000)
})

// --- task-run-v1 13 (#508), O8: a base that moves past this driver's own code pauses `stale_driver` ---

/** Pushes and opens the PR on its one turn, and ALSO flips `.base-moved` — standing in for a separate PR merging into the base, touching the driver's own code, while this loop was running. */
function writeFakeClaudeBaseMovesAfterFirstTurn(dir: string): void {
  writeFakeBinary(
    dir,
    'claude',
    `#!/bin/sh
cat > /dev/null
touch "$HOME/.fake-dev-invoked" 2>/dev/null
touch "$HOME/.base-moved" 2>/dev/null
echo '{"session_id":"dev-session-1","usage":{"input_tokens":10,"output_tokens":5}}'
exit 0
`
  )
}

/** Same as \`writeFakeGit\`, except \`rev-parse origin/main\` answers a NEW sha once \`.base-moved\` exists, and \`log\` reports one commit in that range. */
function writeFakeGitBaseMoves(dir: string): void {
  writeFakeBinary(
    dir,
    'git',
    `#!/bin/sh
if [ "$1" = "ls-remote" ]; then
  if [ -f "$HOME/.fake-dev-invoked" ]; then
    echo "${HEAD_SHA}	refs/heads/${BRANCH}"
  fi
  exit 0
fi
if [ "$1" = "rev-parse" ] && [ "$2" = "origin/main" ]; then
  if [ -f "$HOME/.base-moved" ]; then
    echo "${'c'.repeat(40)}"
  else
    echo "${BASE_SHA}"
  fi
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
if [ "$1" = "log" ]; then
  echo "dddddddddd Fix(cli): something touching the driver"
  exit 0
fi
exit 1
`
  )
}

function setUpBaseMoves(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudeBaseMovesAfterFirstTurn(binDir)
  writeFakeGh(binDir)
  writeFakeGitBaseMoves(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — a base that moves past this driver’s own code pauses stale_driver (O8, task-run-v1 13, #508)', () => {
  it('names both shas and pauses before this round’s own gate/reviewer logic ever runs', () => {
    const { home, cwd, path } = setUpBaseMoves()

    const r = runLoop(home, cwd, path)
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/paused \(stale_driver\)/)

    const pauseComment = readFileSync(join(home, '.fake-gh-posted-comments', 'comment-1.md'), 'utf8')
    expect(pauseComment).toMatch(/^<!-- aeg:loop:paused:stale_driver -->$/m)
    expect(pauseComment).toMatch(new RegExp(`base moved from ${BASE_SHA} to ${'c'.repeat(40)}`))
    expect(pauseComment).toMatch(/touching this driver's own code/)
  }, 20000)
})

/** Same as \`writeFakeGit\`, except \`rev-parse origin/main\` answers a NEW sha once \`.reviewers-ran\` exists (not \`.fake-dev-invoked\` — the base moves WHILE reviewers are working, not before the developer's own first turn), and \`log\` reports one commit in that range. */
function writeFakeGitBaseMovesDuringReview(dir: string): void {
  writeFakeBinary(
    dir,
    'git',
    `#!/bin/sh
if [ "$1" = "ls-remote" ]; then
  if [ -f "$HOME/.fake-dev-invoked" ]; then
    echo "${HEAD_SHA}	refs/heads/${BRANCH}"
  fi
  exit 0
fi
if [ "$1" = "rev-parse" ] && [ "$2" = "origin/main" ]; then
  if [ -f "$HOME/.reviewers-ran" ]; then
    echo "${'e'.repeat(40)}"
  else
    echo "${BASE_SHA}"
  fi
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
if [ "$1" = "log" ]; then
  echo "ffffffffff Fix(cli): something touching the driver"
  exit 0
fi
exit 1
`
  )
}

function setUpStaleDriverDuringReview(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudeConflictAtPublishScenario(binDir)
  writeFakeGh(binDir)
  writeFakeGitBaseMovesDuringReview(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — a base that moves past this driver’s own code WHILE reviewers were working pauses stale_driver before publish (O8, task-run-v1 13, #508)', () => {
  it('catches staleness at the dispatch_reviewers → publish transition, not only at round entry', () => {
    const { home, cwd, path } = setUpStaleDriverDuringReview()

    const r = runLoop(home, cwd, path)
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/paused \(stale_driver\)/)
    // Never reached publish — both reviewers ran (clean), but the round
    // never posted a verdict comment or a publish summary.
    expect(r.stdout).not.toMatch(/publish/)

    const pauseComment = readFileSync(join(home, '.fake-gh-posted-comments', 'comment-1.md'), 'utf8')
    expect(pauseComment).toMatch(/^<!-- aeg:loop:paused:stale_driver -->$/m)
    expect(pauseComment).toMatch(new RegExp(`base moved from ${BASE_SHA} to ${'e'.repeat(40)}`))
  }, 20000)
})

// --- review-validity-v1 12 (#526), O8 round 2: the split must not narrow stale_driver's own coverage ---

describe('DRIVER_OWNED_PATHS covers every dev-review-loop/*.ts split module (review-validity-v1 12, #526 round 2)', () => {
  it('names the dev-review-loop/ directory, not only the old single composition-root file', () => {
    const splitModules = [
      'gate-reading.ts',
      'reviewer-dispatch.ts',
      'round-assess.ts',
      'publication.ts',
      'pause-resume.ts',
      'developer-dispatch.ts'
    ]
    for (const m of splitModules) {
      const modulePath = `apps/cli/src/lib/dev-review-loop/${m}`
      expect(DRIVER_OWNED_PATHS.some((p) => modulePath === p || modulePath.startsWith(p))).toBe(true)
    }
  })
})

// --- task-run-v1 13 (#508), O5: a clean head falls into conflict while reviewers worked ---

/** Standard round-1 push/open, then clean verdicts from both reviewer roles — each touches `.reviewers-ran` right after writing its own verdict, so the SECOND mergeability read (at publish) can answer differently from the first (before either reviewer ran). */
function writeFakeClaudeConflictAtPublishScenario(dir: string): void {
  writeFakeBinary(
    dir,
    'claude',
    `#!/bin/sh
PROMPT="$(cat)"
HAS_RESUME=0
prev=""
for a in "$@"; do
  if [ "$prev" = "-r" ]; then HAS_RESUME=1; fi
  prev="$a"
done
case "$VINAYA_ROLE" in
  code-reviewer)
    WD="$HOME/.vinaya/outbox/dev-review-loop/$VINAYA_TASK/round-$VINAYA_ROUND-reviewer-work"
    mkdir -p "$WD"
    : > "$WD/findings.txt"
    printf 'O1|MET|done.\\n' > "$WD/objectives.txt"
    printf 'BRIEF_CONFORMANCE: yes\\nSPEC_CONFORMANCE: yes\\nSCOPE: small\\nTESTS: pass\\nDOCS: n/a\\n' > "$WD/report.txt"
    touch "$HOME/.reviewers-ran"
    echo '{"session_id":"rev-session-1","usage":{"input_tokens":8,"output_tokens":4}}'
    ;;
  security)
    WD="$HOME/.vinaya/outbox/dev-review-loop/$VINAYA_TASK/round-$VINAYA_ROUND-security-work"
    mkdir -p "$WD"
    : > "$WD/findings.txt"
    printf 'O1|MET|done.\\n' > "$WD/objectives.txt"
    printf 'CONFIG_SCAN: clean\\nSECRETS: none found\\n' > "$WD/report.txt"
    touch "$HOME/.reviewers-ran"
    echo '{"session_id":"sec-session-1","usage":{"input_tokens":8,"output_tokens":4}}'
    ;;
  *)
    echo "$HAS_RESUME" >> "$HOME/.dev-invocations"
    COUNT=$(wc -l < "$HOME/.dev-invocations" | tr -d ' ')
    printf '%s' "$PROMPT" > "$HOME/.dev-prompt-$COUNT.txt"
    touch "$HOME/.fake-dev-invoked"
    echo '{"session_id":"dev-session-fresh","usage":{"input_tokens":10,"output_tokens":5}}'
    ;;
esac
exit 0
`
  )
}

/** Same as \`writeFakeGh\`, except \`pr view --json mergeable\` answers MERGEABLE until \`.reviewers-ran\` exists, then CONFLICTING — a clean head at round entry that falls into conflict while reviewers were working. */
function writeFakeGhConflictAtPublish(dir: string): void {
  writeFakeBinary(
    dir,
    'gh',
    `#!/bin/sh
STATE_DIR="$HOME/.fake-gh-posted-comments"
mkdir -p "$STATE_DIR"
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "comments" ]; then
  printf '%s\\n' '{"comments":[{"body":"<!-- aeg:brief:v1 -->\\nBrief hash: deadbeef\\nDo the thing.\\n\\n## Objectives\\n\\nO1. Do the thing.\\n","author":{"login":"daniboomerang"}}]}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "title" ]; then
  printf '%s\\n' '{"title":"[dev-review-loop-v1] ${TASK} \\u2014 test task"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  if [ -f "$HOME/.fake-dev-invoked" ]; then
    echo '[{"number":123,"headRefName":"${BRANCH}"}]'
  else
    echo '[]'
  fi
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  N=$(ls "$STATE_DIR"/comment-*.md 2>/dev/null | wc -l | tr -d ' ')
  BODY_FILE="$5"
  cp "$BODY_FILE" "$STATE_DIR/comment-$((N + 1)).md"
  echo "https://github.com/example/repo/pull/$3#issuecomment-$((N + 1))"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "body" ]; then
  echo '{"body":"Closes #${TASK}"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "comments" ]; then
  FAKE_GH_STATE="$STATE_DIR" bun -e '
    const fs = require("fs")
    const dir = process.env.FAKE_GH_STATE
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("comment-"))
      .sort((a, b) => Number(a.match(/\\d+/)[0]) - Number(b.match(/\\d+/)[0]))
    const bodies = files.map((f) => fs.readFileSync(dir + "/" + f, "utf8"))
    console.log(JSON.stringify({ comments: bodies.map((body) => ({ body, author: { login: "daniboomerang" } })) }))
  '
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "mergeable" ]; then
  if [ -f "$HOME/.reviewers-ran" ]; then
    echo '{"mergeable":"CONFLICTING"}'
  else
    echo '{"mergeable":"MERGEABLE"}'
  fi
  exit 0
fi
if [ "$1" = "api" ] && [ "\${2#*check-runs}" != "$2" ]; then
  echo '{"id":1,"name":"ci","status":"completed","conclusion":"success"}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
  echo "fake gh: refusing issue comment (log flush not under test)" >&2
  exit 1
fi
echo "unhandled fake gh call in conflict-at-publish scenario: $*" >&2
exit 1
`
  )
}

function setUpConflictAtPublish(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudeConflictAtPublishScenario(binDir)
  writeFakeGhConflictAtPublish(binDir)
  writeFakeGitConflict(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — a clean head falls into conflict while reviewers worked (O5, task-run-v1 13, #508)', () => {
  it('discards the held verdicts, never publishes, and resumes the developer to resolve', () => {
    const { home, cwd, path } = setUpConflictAtPublish()

    const r = runDevReviewLoopArgs(home, cwd, path, ['--task', String(TASK), '--agent', 'claude'], {
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_MAX_ATTEMPTS: '2',
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_INTERVAL_MS: '10'
    })
    expect(r.status).not.toBe(0)
    expect(r.stdout).not.toMatch(/publish/)
    expect(r.stdout).toMatch(/paused \(infrastructure\)/)

    // Both reviewers genuinely ran (mergeability was clean when THEY were
    // dispatched) — but their held verdicts must not survive the conflict
    // discovered right before publish.
    const drlRoot = join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK))
    expect(existsSync(join(drlRoot, 'round-1-reviewer.md'))).toBe(false)
    expect(existsSync(join(drlRoot, 'round-1-security.md'))).toBe(false)

    const conflictPrompt = readFileSync(join(home, '.dev-prompt-2.txt'), 'utf8')
    expect(conflictPrompt).toMatch(/behind the base in a way that conflicts/)
  }, 20000)
})

// --- task-run-v1 13 (#508), O7: UNKNOWN is polled, never read as clean or conflicting ---

/** Standard round-1 clean flow (push, open, green gate, clean reviewers) — mergeability is what varies (fake gh, below). */
function writeFakeClaudeUnknownMergeable(dir: string): void {
  writeFakeBinary(
    dir,
    'claude',
    `#!/bin/sh
cat > /dev/null
touch "$HOME/.fake-dev-invoked" 2>/dev/null
case "$VINAYA_ROLE" in
  code-reviewer)
    WD="$HOME/.vinaya/outbox/dev-review-loop/$VINAYA_TASK/round-$VINAYA_ROUND-reviewer-work"
    mkdir -p "$WD"
    : > "$WD/findings.txt"
    printf 'O1|MET|done.\\n' > "$WD/objectives.txt"
    printf 'BRIEF_CONFORMANCE: yes\\nSPEC_CONFORMANCE: yes\\nSCOPE: small\\nTESTS: pass\\nDOCS: n/a\\n' > "$WD/report.txt"
    echo '{"session_id":"rev-session-1","usage":{"input_tokens":8,"output_tokens":4}}'
    ;;
  security)
    WD="$HOME/.vinaya/outbox/dev-review-loop/$VINAYA_TASK/round-$VINAYA_ROUND-security-work"
    mkdir -p "$WD"
    : > "$WD/findings.txt"
    printf 'O1|MET|done.\\n' > "$WD/objectives.txt"
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

/** Same as \`writeFakeGh\`, except \`pr view --json mergeable\` answers UNKNOWN a bounded number of times (counted in \`.mergeable-reads\`), then MERGEABLE — proving the poll consumes more than one attempt without ever treating UNKNOWN as a final answer either way. */
function writeFakeGhUnknownThenMergeable(dir: string): void {
  writeFakeBinary(
    dir,
    'gh',
    `#!/bin/sh
STATE_DIR="$HOME/.fake-gh-posted-comments"
mkdir -p "$STATE_DIR"
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "comments" ]; then
  printf '%s\\n' '{"comments":[{"body":"<!-- aeg:brief:v1 -->\\nBrief hash: deadbeef\\nDo the thing.\\n\\n## Objectives\\n\\nO1. Do the thing.\\n","author":{"login":"daniboomerang"}}]}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "title" ]; then
  printf '%s\\n' '{"title":"[dev-review-loop-v1] ${TASK} \\u2014 test task"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  if [ -f "$HOME/.fake-dev-invoked" ]; then
    echo '[{"number":123,"headRefName":"${BRANCH}"}]'
  else
    echo '[]'
  fi
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  N=$(ls "$STATE_DIR"/comment-*.md 2>/dev/null | wc -l | tr -d ' ')
  BODY_FILE="$5"
  cp "$BODY_FILE" "$STATE_DIR/comment-$((N + 1)).md"
  echo "https://github.com/example/repo/pull/$3#issuecomment-$((N + 1))"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "body" ]; then
  echo '{"body":"Closes #${TASK}"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "comments" ]; then
  FAKE_GH_STATE="$STATE_DIR" bun -e '
    const fs = require("fs")
    const dir = process.env.FAKE_GH_STATE
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("comment-"))
      .sort((a, b) => Number(a.match(/\\d+/)[0]) - Number(b.match(/\\d+/)[0]))
    const bodies = files.map((f) => fs.readFileSync(dir + "/" + f, "utf8"))
    console.log(JSON.stringify({ comments: bodies.map((body) => ({ body, author: { login: "daniboomerang" } })) }))
  '
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "mergeable" ]; then
  COUNT_FILE="$HOME/.mergeable-reads"
  N=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)
  N=$((N + 1))
  echo "$N" > "$COUNT_FILE"
  if [ "$N" -lt 3 ]; then
    echo '{"mergeable":"UNKNOWN"}'
  else
    echo '{"mergeable":"MERGEABLE"}'
  fi
  exit 0
fi
if [ "$1" = "api" ] && [ "\${2#*check-runs}" != "$2" ]; then
  echo '{"id":1,"name":"ci","status":"completed","conclusion":"success"}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
  echo "fake gh: refusing issue comment (log flush not under test)" >&2
  exit 1
fi
echo "unhandled fake gh call in unknown-mergeable scenario: $*" >&2
exit 1
`
  )
}

function setUpUnknownMergeable(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudeUnknownMergeable(binDir)
  writeFakeGhUnknownThenMergeable(binDir)
  writeFakeGit(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — an UNKNOWN mergeable answer is polled, never read as clean or conflicting (O7, task-run-v1 13, #508)', () => {
  it('keeps polling through UNKNOWN and publishes once it resolves MERGEABLE', () => {
    const { home, cwd, path } = setUpUnknownMergeable()

    const r = runDevReviewLoopArgs(home, cwd, path, ['--task', String(TASK), '--agent', 'claude'], {
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_MAX_ATTEMPTS: '5',
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_INTERVAL_MS: '5'
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/publish/)

    // Genuinely polled more than once before resolving — never treated the
    // first (UNKNOWN) read as a final answer.
    const reads = Number(readFileSync(join(home, '.mergeable-reads'), 'utf8').trim())
    expect(reads).toBeGreaterThanOrEqual(3)
  }, 20000)
})

// --- objectives version changes mid-round (review-validity-v1 task 2, #476, O3) ---

function setUpObjectivesChangedMidRound(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaude(binDir)
  writeFakeGhObjectivesChangedMidRound(binDir)
  writeFakeGit(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — an objectives edit lands between reviewer dispatch and assessment (O3)', () => {
  it('discards the round instead of holding or publishing, and pauses naming both versions and the superseding command', () => {
    const { home, cwd, path } = setUpObjectivesChangedMidRound()

    const r = runLoop(home, cwd, path)
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/paused \(objectives_changed\)/)

    const pauseState = JSON.parse(
      readFileSync(join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'pause-state.json'), 'utf8')
    ) as Record<string, unknown>
    expect(pauseState.reason).toBe('objectives_changed')
    expect(pauseState.detail).toMatch(/objectives moved from .+ to midroundversion/)
    expect(pauseState.detail).toMatch(
      /vinaya issue objectives edit 9001 --add "Also do this\." --reason "mid-round change"/
    )

    // Exactly one posted comment — the pause — never a reviewer or security
    // verdict: `verdicts` (in-memory only at the mismatch check) is never
    // written to disk, so nothing was ever held for round 1 to publish.
    const posted = postedCommentFiles(home)
    expect(posted).toHaveLength(1)
    const pauseComment = readFileSync(join(home, '.fake-gh-posted-comments', posted[0] as string), 'utf8')
    expect(pauseComment).toMatch(/^<!-- aeg:loop:paused:objectives_changed -->$/m)
    expect(pauseComment).not.toMatch(/^VERDICT:/m)

    const roundDir = join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK))
    expect(existsSync(join(roundDir, 'round-1-reviewer.md'))).toBe(false)
    expect(existsSync(join(roundDir, 'round-1-security.md'))).toBe(false)
  }, 20000)
})

// --- a ruling lands mid-round (review-validity-v1 task 3, #477, O3) -------

function setUpRulingPostedMidRound(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaude(binDir)
  writeFakeGhRulingPostedMidRound(binDir)
  writeFakeGit(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — a ruling lands between reviewer dispatch and assessment (review-validity-v1 task 3, #477, O3)', () => {
  it('discards the round instead of holding or publishing, and pauses naming the ruling', () => {
    const { home, cwd, path } = setUpRulingPostedMidRound()

    const r = runLoop(home, cwd, path)
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/paused \(ruling_posted\)/)

    const pauseState = JSON.parse(
      readFileSync(join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'pause-state.json'), 'utf8')
    ) as Record<string, unknown>
    expect(pauseState.reason).toBe('ruling_posted')
    expect(pauseState.detail).toMatch(/ruling ordinal moved from 0 to 1/)
    expect(pauseState.detail).toMatch(/ruling 123-1/)

    // Exactly one posted comment — the pause — never a reviewer or security
    // verdict: `verdicts` (in-memory only at the mismatch check) is never
    // written to disk, so nothing was ever held for round 1 to publish.
    const posted = postedCommentFiles(home)
    expect(posted).toHaveLength(1)
    const pauseComment = readFileSync(join(home, '.fake-gh-posted-comments', posted[0] as string), 'utf8')
    expect(pauseComment).toMatch(/^<!-- aeg:loop:paused:ruling_posted -->$/m)
    expect(pauseComment).not.toMatch(/^VERDICT:/m)

    const roundDir = join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK))
    expect(existsSync(join(roundDir, 'round-1-reviewer.md'))).toBe(false)
    expect(existsSync(join(roundDir, 'round-1-security.md'))).toBe(false)
  }, 20000)
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

describe('routeCompletionEvents (pure) — regression, PR #459 MAJOR', () => {
  const journalFinalized = { event: 'journal_finalized', result: 'stopped' } as unknown as DevReviewLoopEventInput
  const roundEnded = { event: 'round_ended', outcome: 'changes_requested' } as unknown as DevReviewLoopEventInput
  const events = [roundEnded, journalFinalized]

  it("defers journal_finalized for a 'publish' decision, until publishRound confirms it", () => {
    const routed = routeCompletionEvents(events, 'publish')
    expect(routed.toLogNow).toEqual([roundEnded])
    expect(routed.toDeferUntilPublish).toEqual([journalFinalized])
  })

  // The bug: every one of these decisions ends the run right there — there
  // is no later publish step for its `journal_finalized` to wait on. The
  // prior fix filtered it out of `logEvents` unconditionally and only the
  // `publish` branch ever flushed the held-back copy, so a `pause` decision
  // captured its completion event and then never logged it, permanently.
  for (const decisionType of ['pause', 'dispatch_developer', 'ask_confidence', 'dispatch_reviewers'] as const) {
    it(`logs journal_finalized immediately for a '${decisionType}' decision (never dropped)`, () => {
      const routed = routeCompletionEvents(events, decisionType)
      expect(routed.toLogNow).toEqual(events)
      expect(routed.toDeferUntilPublish).toEqual([])
    })
  }

  // The three pause reasons the regression silently dropped on every
  // successful run — `assessVerdicts`'s `reappearance`/`no_progress`/
  // `max_rounds` sites all produce a `pause` decision (see `Decision` in
  // `packages/aeg-core/src/dev-review-loop/types.ts`: `reason` is not part
  // of what `routeCompletionEvents` branches on) — so the `'pause'` case in
  // the loop above covers all three by construction. The end-to-end test
  // below ('a paused loop for reason no_progress still logs its completion
  // event') is the concrete proof for one of them through the real driver.

  // `routeCompletionEvents` only decides WHEN a `merged_ready` event becomes
  // eligible to log (after `publishRound` returns without throwing) — it
  // cannot itself prove the crash-mid-publish property, since that lives in
  // `devReviewLoop`'s unguarded sequencing: a throw from `publishRound`
  // propagates out before `await logEvents(pendingCompletionEvents)` is ever
  // reached. See 'a crash mid-publish never logs merged_ready', below, for
  // the real, end-to-end proof of that.
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

  it('picks the newest version among several principal-authored frozen-brief comments, never the first posted (task-run-v1 task 4, #483, O3)', () => {
    const comments = [
      { body: '<!-- aeg:brief:v1 -->\nBrief hash: abc\nfirst version', author: 'daniboomerang' },
      {
        body: '<!-- aeg:brief:v2 -->\nBrief hash: def\nSupersedes: url — wrong tier\nsecond version',
        author: 'daniboomerang'
      }
    ]
    const found = findPrincipalFrozenBrief(comments, ALLOWLIST)
    expect(found?.body.split('\n')[0]).toBe('<!-- aeg:brief:v2 -->')
  })
})

describe('renderReviewerPrompt (pure) — task 4, #483, O2', () => {
  const BASE_FACTS: ReviewerPromptFacts = {
    objectives: 'O1. Do the thing.',
    objectivesVersion: null,
    rulings: [],
    rulingOrdinal: 0,
    head: 'a'.repeat(40),
    ciConclusion: 'green',
    revision: 'b'.repeat(40)
  }

  it('names the revision as its own fact line', () => {
    const rendered = renderReviewerPrompt(BASE_FACTS)
    expect(rendered).toContain(`BRIEF REVISION: ${'b'.repeat(40)}`)
  })

  it('names the NO_SOURCE_REVISION sentinel for a pre-task-4 brief, rather than omitting the fact', () => {
    const rendered = renderReviewerPrompt({ ...BASE_FACTS, revision: NO_SOURCE_REVISION })
    expect(rendered).toContain(`BRIEF REVISION: ${NO_SOURCE_REVISION}`)
  })
})

// --- objectives source resolution (review-validity-v1 task 2, #476, O1) ----

describe('findLatestPrincipalObjectivesEdit (pure)', () => {
  const ALLOWLIST = ['daniboomerang']

  it('picks the highest marker index, regardless of comment array order', () => {
    const comments = [
      {
        body: '<!-- aeg:objectives:v2 -->\nPrevious:\nO1. A.\n\nNow:\nO1. B.\n\nReason: r\nVersion: v2',
        author: 'daniboomerang'
      },
      {
        body: '<!-- aeg:objectives:v1 -->\nPrevious:\nO1. A.\n\nNow:\nO1. A.\n\nReason: r\nVersion: v1',
        author: 'daniboomerang'
      }
    ]
    expect(findLatestPrincipalObjectivesEdit(comments, ALLOWLIST)?.body).toMatch(/Version: v2/)
  })

  it('ignores a non-principal-authored edit-shaped comment', () => {
    const comments = [
      {
        body: '<!-- aeg:objectives:v1 -->\nPrevious:\nO1. A.\n\nNow:\nO1. B.\n\nReason: r\nVersion: fake',
        author: 'attacker'
      }
    ]
    expect(findLatestPrincipalObjectivesEdit(comments, ALLOWLIST)).toBeNull()
  })

  it('returns null when no comment carries the marker at all', () => {
    expect(
      findLatestPrincipalObjectivesEdit([{ body: 'Just chatting.', author: 'daniboomerang' }], ALLOWLIST)
    ).toBeNull()
  })
})

describe('parseObjectivesEditComment (pure)', () => {
  it('parses Previous:/Now:/Reason:/Version: into the post-edit list and version', () => {
    const body = [
      '<!-- aeg:objectives:v1 -->',
      'Previous:',
      'O1. Do the thing.',
      '',
      'Now:',
      'O1. Do the thing.',
      'O2. Also do this.',
      '',
      'Reason: needed a second outcome',
      'Version: deadbeef'
    ].join('\n')
    expect(parseObjectivesEditComment(body)).toEqual({
      previous: [{ id: 'O1', text: 'Do the thing.' }],
      now: [
        { id: 'O1', text: 'Do the thing.' },
        { id: 'O2', text: 'Also do this.' }
      ],
      reason: 'needed a second outcome',
      version: 'deadbeef'
    })
  })

  it('returns null on a comment missing the Version: line', () => {
    const body = ['<!-- aeg:objectives:v1 -->', 'Previous:', 'O1. A.', '', 'Now:', 'O1. B.', '', 'Reason: r'].join('\n')
    expect(parseObjectivesEditComment(body)).toBeNull()
  })
})

describe('describeObjectivesEdit (pure)', () => {
  const ISSUE = 476

  it('reconstructs --add from a Now: list one longer than Previous:, same prefix', () => {
    const edit: ObjectivesEditSource = {
      previous: [{ id: 'O1', text: 'Do the thing.' }],
      now: [
        { id: 'O1', text: 'Do the thing.' },
        { id: 'O2', text: 'Also do this.' }
      ],
      reason: 'needed a second outcome'
    }
    expect(describeObjectivesEdit(ISSUE, edit)).toBe(
      `vinaya issue objectives edit ${ISSUE} --add "Also do this." --reason "needed a second outcome"`
    )
  })

  it('reconstructs --drop from a Now: list one shorter than Previous:', () => {
    const edit: ObjectivesEditSource = {
      previous: [
        { id: 'O1', text: 'Do the thing.' },
        { id: 'O2', text: 'Also do this.' }
      ],
      now: [{ id: 'O1', text: 'Do the thing.' }],
      reason: 'no longer needed'
    }
    expect(describeObjectivesEdit(ISSUE, edit)).toBe(
      `vinaya issue objectives edit ${ISSUE} --drop O2 --reason "no longer needed"`
    )
  })

  it('reconstructs --replace from a same-length list with one changed sentence', () => {
    const edit: ObjectivesEditSource = {
      previous: [{ id: 'O1', text: 'Do the thing.' }],
      now: [{ id: 'O1', text: 'Do the other thing.' }],
      reason: 'scope changed'
    }
    expect(describeObjectivesEdit(ISSUE, edit)).toBe(
      `vinaya issue objectives edit ${ISSUE} --replace O1 "Do the other thing." --reason "scope changed"`
    )
  })
})

/**
 * O1's own acceptance test: the version the loop's `resolveIssueObjectives`
 * would compute from an objectives-edit comment must equal the version the
 * merge gate computes from the SAME post-edit Issue body — proven here by
 * exercising the identical shared primitives both sides call
 * (`objectivesOf`/`objectivesVersion`, `@attalabs/aeg-core`) over one body,
 * never by importing the gate's own private `resolveObjectivesVersion`
 * (`apps/cli/src/checks/bin/check-review-gate.ts`, out of this task's
 * declared Surface). `spliceObjectivesSection`/`renderObjectives` are the
 * exact functions `issueObjectivesEditCommand` itself uses to write the new
 * live body and the `Version:` line — so this reproduces its own derivation,
 * not a parallel one.
 */
describe('objectives version — loop and gate agree (O1)', () => {
  it('the edit comment Version: line equals objectivesVersion(objectivesOf(<the live body the edit just wrote>))', () => {
    const originalBody = '## Objectives\n\nO1. Do the thing.\n'
    const previous = (objectivesOf(originalBody) as { ok: true; objectives: Objective[] }).objectives

    const updated: Objective[] = [...previous, { id: 'O2', text: 'Also do this.' }]
    // The exact write `issueObjectivesEditCommand` performs to the Issue body.
    const newBody = spliceObjectivesSection(originalBody, renderObjectives(updated))
    // The exact value it writes into the edit-audit comment's `Version:` line.
    const commentVersion = objectivesVersion(updated)

    // What the merge gate computes on its own next live-body read.
    const gateVersion = objectivesVersion((objectivesOf(newBody) as { ok: true; objectives: Objective[] }).objectives)

    expect(commentVersion).toBe(gateVersion)

    // And what `parseObjectivesEditComment` (the loop's own reader) recovers
    // from the rendered comment is that same value.
    const commentBody = [
      '<!-- aeg:objectives:v1 -->',
      'Previous:',
      previous.map((o) => `${o.id}. ${o.text}`).join('\n'),
      '',
      'Now:',
      updated.map((o) => `${o.id}. ${o.text}`).join('\n'),
      '',
      'Reason: needed a second outcome',
      `Version: ${commentVersion}`
    ].join('\n')
    expect(parseObjectivesEditComment(commentBody)?.version).toBe(gateVersion)
  })
})

/**
 * O2's own acceptance test: a loop-published verdict — rendered by the SAME
 * `renderCodeReviewComment`/`renderSecurityComment` `buildVerdictFromReport`
 * calls, now carrying a real `objectivesVersion` instead of the old
 * hardcoded `null` — is accepted by the merge gate's own `checkReviewGate`
 * evaluator when the current objectives version matches. Calling the real
 * gate function directly (`@attalabs/aeg-core`), not a re-derivation of its
 * logic.
 */
describe('a loop-published verdict passes the merge gate (O2)', () => {
  const HEAD = 'c'.repeat(40)
  const VERSION = objectivesVersion([{ id: 'O1', text: 'Do the thing.' }])
  const TOKENS = { taskId: '476', model: 'claude', tokensIn: '8', tokensOut: '4', cost: '—', sessionId: 's1' }

  it('checkReviewGate passes when both rendered verdicts carry the current objectives version', () => {
    const reviewerComment = renderCodeReviewComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'APPROVE',
      briefConformance: 'yes',
      specConformance: 'yes',
      findings: [],
      scope: 'small',
      scopeEvidence: null,
      tests: 'pass',
      docs: 'n/a',
      objectivesVersion: VERSION,
      rulingOrdinal: 0,
      objectiveResults: [{ id: 'O1', status: 'MET', evidence: 'done' }]
    })
    const securityComment = renderSecurityComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'PASS',
      findings: [],
      configScan: 'clean',
      secrets: 'none found',
      secretsEvidence: null,
      objectivesVersion: VERSION,
      rulingOrdinal: 0,
      objectiveResults: [{ id: 'O1', status: 'MET', evidence: 'done' }]
    })

    const result = checkReviewGate({
      comments: [
        { body: reviewerComment, author: 'daniboomerang' },
        { body: securityComment, author: 'daniboomerang' }
      ],
      labels: [],
      waiverLabelActor: null,
      headSha: HEAD,
      mechanicalChecks: [{ name: 'Vinaya CI', bucket: 'pass' }],
      principalAllowlist: ['daniboomerang'],
      objectivesVersion: VERSION,
      rulingOrdinal: 0
    })

    expect(result.verdict).toBe('pass')
  })

  it('checkReviewGate fails, naming the version mismatch, when the Issue objectives moved since the verdict', () => {
    const reviewerComment = renderCodeReviewComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'APPROVE',
      briefConformance: 'yes',
      specConformance: 'yes',
      findings: [],
      scope: 'small',
      scopeEvidence: null,
      tests: 'pass',
      docs: 'n/a',
      objectivesVersion: VERSION,
      rulingOrdinal: 0,
      objectiveResults: [{ id: 'O1', status: 'MET', evidence: 'done' }]
    })
    const securityComment = renderSecurityComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'PASS',
      findings: [],
      configScan: 'clean',
      secrets: 'none found',
      secretsEvidence: null,
      objectivesVersion: VERSION,
      rulingOrdinal: 0,
      objectiveResults: [{ id: 'O1', status: 'MET', evidence: 'done' }]
    })

    const result = checkReviewGate({
      comments: [
        { body: reviewerComment, author: 'daniboomerang' },
        { body: securityComment, author: 'daniboomerang' }
      ],
      labels: [],
      waiverLabelActor: null,
      headSha: HEAD,
      mechanicalChecks: [{ name: 'Vinaya CI', bucket: 'pass' }],
      principalAllowlist: ['daniboomerang'],
      objectivesVersion: 'a-newer-version-entirely',
      rulingOrdinal: 0
    })

    expect(result.verdict).toBe('fail')
    expect(result.reason).toMatch(/objectives version/)
  })
})

/**
 * Which severities block is repository policy (`review-validity-v1` task 8,
 * `#506`, O2/O4): the loop's own derivation (`deriveCodeReviewVerdict`, the
 * same function `buildVerdictFromReport` calls) and the merge gate's own
 * evaluation (`checkReviewGate`) must agree on the SAME findings under the
 * SAME policy — this repository's own configured MAJOR/HIGH.
 */
describe('a loop-published verdict agrees with the merge gate under policy (review-validity-v1 task 8, #506, O2/O4)', () => {
  const HEAD = 'e'.repeat(40)
  const TOKENS = { taskId: '506', model: 'claude', tokensIn: '8', tokensOut: '4', cost: '—', sessionId: 's1' }
  const THIS_REPO_POLICY = { codeReviewThreshold: 'MAJOR' as const, securityThreshold: 'HIGH' as const }

  it("a MAJOR finding drives REQUEST_CHANGES at the loop (never reaches a clean round to publish) under this repo's MAJOR/HIGH policy", () => {
    const findings = [{ severity: 'MAJOR', location: 'a.ts:1', description: 'off-by-one' }]
    expect(deriveCodeReviewVerdict(findings, THIS_REPO_POLICY)).toBe('REQUEST_CHANGES')
  })

  it('the SAME finding, rendered as a (hand-typed-bypass) APPROVE comment, is read as not clean by checkReviewGate under the identical policy — the two never disagree', () => {
    const reviewerComment = renderCodeReviewComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'APPROVE',
      briefConformance: 'yes',
      specConformance: 'yes',
      findings: [{ severity: 'MAJOR', location: 'a.ts:1', description: 'off-by-one' }],
      scope: 'small',
      scopeEvidence: null,
      tests: 'pass',
      docs: 'n/a',
      objectivesVersion: null,
      rulingOrdinal: 0,
      objectiveResults: null
    })
    const securityComment = renderSecurityComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'PASS',
      findings: [],
      configScan: 'clean',
      secrets: 'none found',
      secretsEvidence: null,
      objectivesVersion: null,
      rulingOrdinal: 0,
      objectiveResults: null
    })

    const result = checkReviewGate({
      comments: [
        { body: reviewerComment, author: 'daniboomerang' },
        { body: securityComment, author: 'daniboomerang' }
      ],
      labels: [],
      waiverLabelActor: null,
      headSha: HEAD,
      mechanicalChecks: [{ name: 'Vinaya CI', bucket: 'pass' }],
      principalAllowlist: ['daniboomerang'],
      objectivesVersion: null,
      rulingOrdinal: 0,
      policy: THIS_REPO_POLICY
    })

    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain('never overrides policy')
  })

  it('the identical MAJOR-carrying comment passes under the DEFAULT (BLOCKER) policy — the gate and the default-policy derivation agree too', () => {
    const findings = [{ severity: 'MAJOR', location: 'a.ts:1', description: 'off-by-one' }]
    expect(deriveCodeReviewVerdict(findings, { codeReviewThreshold: 'BLOCKER', securityThreshold: 'HIGH' })).toBe(
      'APPROVE'
    )

    const reviewerComment = renderCodeReviewComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'APPROVE',
      briefConformance: 'yes',
      specConformance: 'yes',
      findings: [{ severity: 'MAJOR', location: 'a.ts:1', description: 'off-by-one' }],
      scope: 'small',
      scopeEvidence: null,
      tests: 'pass',
      docs: 'n/a',
      objectivesVersion: null,
      rulingOrdinal: 0,
      objectiveResults: null
    })
    const securityComment = renderSecurityComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'PASS',
      findings: [],
      configScan: 'clean',
      secrets: 'none found',
      secretsEvidence: null,
      objectivesVersion: null,
      rulingOrdinal: 0,
      objectiveResults: null
    })

    const result = checkReviewGate({
      comments: [
        { body: reviewerComment, author: 'daniboomerang' },
        { body: securityComment, author: 'daniboomerang' }
      ],
      labels: [],
      waiverLabelActor: null,
      headSha: HEAD,
      mechanicalChecks: [{ name: 'Vinaya CI', bucket: 'pass' }],
      principalAllowlist: ['daniboomerang'],
      objectivesVersion: null,
      rulingOrdinal: 0
      // policy omitted — defaults to BLOCKER/HIGH.
    })

    expect(result.verdict).toBe('pass')
  })
})

/**
 * The ruling-ordinal mirror of the objectives-version acceptance test above
 * (review-validity-v1 task 3, `#477`, O1/O2): a loop-published verdict —
 * rendered by the same `renderCodeReviewComment`/`renderSecurityComment`
 * `buildVerdictFromReport` calls, now carrying a real `rulingOrdinal`
 * instead of the field not existing at all — is accepted by the merge
 * gate's own `checkReviewGate` evaluator when the current newest ruling
 * ordinal matches, and refused, naming the newer ruling, when it doesn't.
 */
describe('a loop-published verdict is bound to the newest ruling ordinal (review-validity-v1 task 3, #477, O2)', () => {
  const HEAD = 'd'.repeat(40)
  const TOKENS = { taskId: '477', model: 'claude', tokensIn: '8', tokensOut: '4', cost: '—', sessionId: 's1' }

  it('checkReviewGate passes when both rendered verdicts carry the current newest ruling ordinal', () => {
    const reviewerComment = renderCodeReviewComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'APPROVE',
      briefConformance: 'yes',
      specConformance: 'yes',
      findings: [],
      scope: 'small',
      scopeEvidence: null,
      tests: 'pass',
      docs: 'n/a',
      objectivesVersion: null,
      rulingOrdinal: 1,
      objectiveResults: null
    })
    const securityComment = renderSecurityComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'PASS',
      findings: [],
      configScan: 'clean',
      secrets: 'none found',
      secretsEvidence: null,
      objectivesVersion: null,
      rulingOrdinal: 1,
      objectiveResults: null
    })

    const result = checkReviewGate({
      comments: [
        { body: reviewerComment, author: 'daniboomerang' },
        { body: securityComment, author: 'daniboomerang' }
      ],
      labels: [],
      waiverLabelActor: null,
      headSha: HEAD,
      mechanicalChecks: [{ name: 'Vinaya CI', bucket: 'pass' }],
      principalAllowlist: ['daniboomerang'],
      objectivesVersion: null,
      rulingOrdinal: 1
    })

    expect(result.verdict).toBe('pass')
  })

  it('checkReviewGate fails, naming the newer ruling, when a ruling posted after the verdict was cast', () => {
    const reviewerComment = renderCodeReviewComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'APPROVE',
      briefConformance: 'yes',
      specConformance: 'yes',
      findings: [],
      scope: 'small',
      scopeEvidence: null,
      tests: 'pass',
      docs: 'n/a',
      objectivesVersion: null,
      rulingOrdinal: 1,
      objectiveResults: null
    })
    const securityComment = renderSecurityComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'PASS',
      findings: [],
      configScan: 'clean',
      secrets: 'none found',
      secretsEvidence: null,
      objectivesVersion: null,
      rulingOrdinal: 1,
      objectiveResults: null
    })

    const result = checkReviewGate({
      comments: [
        { body: reviewerComment, author: 'daniboomerang' },
        { body: securityComment, author: 'daniboomerang' }
      ],
      labels: [],
      waiverLabelActor: null,
      headSha: HEAD,
      mechanicalChecks: [{ name: 'Vinaya CI', bucket: 'pass' }],
      principalAllowlist: ['daniboomerang'],
      objectivesVersion: null,
      rulingOrdinal: 2
    })

    expect(result.verdict).toBe('fail')
    expect(result.reason).toMatch(/ruling ordinal/)
    expect(result.reason).toContain('ruling 2')
  })
})

/**
 * Same as `writeFakeGh`, except the mechanical check-runs answer models a
 * real principal-owed scenario (review-validity-v1 11, O1/O2/O3): the
 * bundled `vinaya check --all --diff-only` job reads `success` — exactly
 * what `isRunFailed` (apps/cli/src/commands/check.ts) produces when the
 * only red is `test-plan`'s `principalOwed` failure and every error it
 * reported is `pending: true` — while a SEPARATE `vinaya review gate` run
 * reads `failure`, modeling O2's merge-time enforcement of the same unticked
 * `[principal]` box. `fetchMechanicalCheckRuns` (gate-reading.ts) already
 * excludes `REVIEW_GATE_CHECK_RUN_NAME` unconditionally, by name, regardless
 * of why it is red — so the loop's own CI reader must see ONLY the first
 * line and read this head as green.
 */
function writeFakeGhCiGreenReviewGateRed(dir: string): void {
  writeFakeBinary(
    dir,
    'gh',
    `#!/bin/sh
STATE_DIR="$HOME/.fake-gh-posted-comments"
mkdir -p "$STATE_DIR"
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "comments" ]; then
  printf '%s\\n' '{"comments":[{"body":"<!-- aeg:brief:v1 -->\\nBrief hash: deadbeef\\nDo the thing.\\n\\n## Objectives\\n\\nO1. Do the thing.\\n\\n## Planner rationale\\n\\nOut of scope for facts.\\n","author":{"login":"daniboomerang"}}]}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "title" ]; then
  printf '%s\\n' '{"title":"[dev-review-loop-v1] ${TASK} \\u2014 test task"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  if [ -f "$HOME/.fake-dev-invoked" ]; then
    echo '[{"number":123,"headRefName":"${BRANCH}"}]'
  else
    echo '[]'
  fi
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  N=$(ls "$STATE_DIR"/comment-*.md 2>/dev/null | wc -l | tr -d ' ')
  BODY_FILE="$5"
  cp "$BODY_FILE" "$STATE_DIR/comment-$((N + 1)).md"
  echo "https://github.com/example/repo/pull/$3#issuecomment-$((N + 1))"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "body" ]; then
  echo '{"body":"Closes #${TASK}"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "mergeable" ]; then
  echo '{"mergeable":"MERGEABLE"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "comments" ]; then
  FAKE_GH_STATE="$STATE_DIR" bun -e '
    const fs = require("fs")
    const dir = process.env.FAKE_GH_STATE
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("comment-"))
      .sort((a, b) => Number(a.match(/\\d+/)[0]) - Number(b.match(/\\d+/)[0]))
    const bodies = files.map((f) => fs.readFileSync(dir + "/" + f, "utf8"))
    console.log(JSON.stringify({ comments: bodies.map((body) => ({ body, author: { login: "daniboomerang" } })) }))
  '
  exit 0
fi
if [ "$1" = "api" ] && [ "\${2#*check-runs}" != "$2" ]; then
  printf '%s\\n' '{"id":1,"name":"vinaya check --all --diff-only","status":"completed","conclusion":"success"}'
  printf '%s\\n' '{"id":2,"name":"vinaya review gate","status":"completed","conclusion":"failure"}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
  echo "fake gh: refusing issue comment (log flush not under test)" >&2
  exit 1
fi
echo "unhandled fake gh call: $*" >&2
exit 1
`
  )
}

function setUpPrincipalOwedRedReviewGate(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaude(binDir)
  writeFakeGhCiGreenReviewGateRed(binDir)
  writeFakeGit(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — a principal-owed red never redispatches the developer (review-validity-v1 11, O3)', () => {
  it('dispatches both reviewers off the green mechanical gate, even with review-gate itself red', () => {
    const { home, cwd, path } = setUpPrincipalOwedRedReviewGate()
    const r = runLoop(home, cwd, path)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/publish/)

    // Proof reviewers (not the developer) were dispatched off round 1: the
    // held-verdict files only the dispatch_reviewers branch writes exist.
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

    // Proof the gate itself read green, and no second gate/developer round
    // happened first — a red-gate retry would insert a second
    // gate_result_read/round_started pair before verdicts_read.
    const loopEvents = outboxLines(home)
      .filter((l) => l.kind === 'dev_review_loop')
      .map((l) => l.event)
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
    const gateResult = outboxLines(home).find((l) => l.event === 'gate_result_read') as Record<string, unknown>
    expect(gateResult.green).toBe(true)
  }, 20000)
})
