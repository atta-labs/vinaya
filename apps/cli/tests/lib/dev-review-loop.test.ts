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
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  appendFinalFlushFailureNote,
  assertValidLoopEvent,
  buildReexecArgs,
  CONFIDENCE_PROMPT_LINE,
  describeConfidencePauseDetail,
  describeObjectivesEdit,
  deriveVerdictPauseDetail,
  developerRoundMarker,
  DRIVER_OWNED_PATHS,
  extractObjectivesSection,
  filterPrincipalRulings,
  findLatestPrincipalObjectivesEdit,
  findPrincipalFrozenBrief,
  NO_SOURCE_REVISION,
  type ObjectivesEditSource,
  parseObjectivesEditComment,
  sanitizeUncaughtErrorForPublicPause,
  parseRoundResponseFindingIds,
  renderDeveloperRoundComment,
  renderReviewerPrompt,
  type ReviewerPromptFacts,
  routeCompletionEvents,
  describeSkippedRoundEndFlush,
  resolveRoundEndFlushTarget
} from '../../src/lib/dev-review-loop.js'
import type { VinayaConfig } from '../../src/lib/config.js'
import { MAX_INFRASTRUCTURE_RETRIES } from '../../src/lib/dev-review-loop/round-assess.js'
import {
  deriveCodeReviewVerdict,
  renderCodeReviewComment,
  renderSecurityComment
} from '../../src/commands/review-post.js'
import { spliceObjectivesSection } from '../../src/commands/issue-objectives.js'
import {
  checkReviewGate,
  DEFAULT_REVIEW_POLICY,
  objectivesOf,
  objectivesVersion,
  policyDigest,
  renderObjectives,
  type Objective,
  type DevReviewLoopEventInput
} from '@attalabs/aeg-core'

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX = join(CLI_ROOT, 'src', 'index.ts')

/**
 * `checkReviewGate` resolves `DEFAULT_REVIEW_POLICY`'s digest whenever a
 * test omits its own `policy` field (every "passes" fixture below that
 * doesn't test a custom policy). `isBoundToPolicy` no longer grandfathers a
 * digest it cannot parse as real hex (`#478` round 4, security MEDIUM) — the
 * `'p'.repeat(64)` placeholder these fixtures used is not valid hex, so the
 * reader treats it as "no line at all" and it must now match for real.
 */
const DEFAULT_POLICY_DIGEST = policyDigest(DEFAULT_REVIEW_POLICY)

const TASK = 9001
const BRANCH = `task/dev-review-loop-v1/${TASK}`
const HEAD_SHA = 'a'.repeat(40)
const BASE_SHA = 'b'.repeat(40)
/** A local worktree head that never equals `HEAD_SHA` — simulates one that has moved on since it was pushed (`#561` round 2 review, MAJOR). */
const DIVERGED_LOCAL_HEAD_SHA = 'c'.repeat(40)

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

/** Same as `writeFakeClaude`, plus one line under `$HOME/.dev-invocations` per developer-role invocation — a fixture asserting the evidence report never triggers a resumed developer turn needs a real per-round count, not just the boolean `.fake-dev-invoked` touch every other fixture already uses. */
function writeFakeClaudeCountingDevInvocations(dir: string): void {
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
    echo "invocation" >> "$HOME/.dev-invocations"
    echo '{"session_id":"dev-session-1","usage":{"input_tokens":10,"output_tokens":5}}'
    ;;
esac
exit 0
`
  )
}

/** Same as `writeFakeClaude`, plus touching `$HOME/.reviewer-dispatch-started` the instant a reviewer/security role starts, before doing any of its own work — the concurrency fixture's rendezvous signal that reviewer dispatch has genuinely begun. */
function writeFakeClaudeMarkingReviewerDispatchStart(dir: string): void {
  writeFakeBinary(
    dir,
    'claude',
    `#!/bin/sh
touch "$HOME/.fake-dev-invoked" 2>/dev/null
cat > /dev/null
WORKROOT="$HOME/.vinaya/outbox/dev-review-loop/$VINAYA_TASK"
case "$VINAYA_ROLE" in
  code-reviewer)
    touch "$HOME/.reviewer-dispatch-started"
    WD="$WORKROOT/round-$VINAYA_ROUND-reviewer-work"
    mkdir -p "$WD"
    : > "$WD/findings.txt"
    printf 'O1|MET|done.\\n' > "$WD/objectives.txt"
    printf 'BRIEF_CONFORMANCE: yes\\nSPEC_CONFORMANCE: yes\\nSCOPE: small\\nTESTS: pass\\nDOCS: n/a\\n' > "$WD/report.txt"
    echo '{"session_id":"rev-session-1","usage":{"input_tokens":8,"output_tokens":4}}'
    ;;
  security)
    touch "$HOME/.reviewer-dispatch-started"
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
 * Same as `writeFakeGh`, except the evidence report's own
 * `pr view <n> --json body -q .body` call (distinguished from the plain
 * `--json body` call other loop paths make, by checking `-q .body` too)
 * blocks — polling every `0.05`s, up to `2`s — until
 * `$HOME/.reviewer-dispatch-started` exists, writing
 * `$HOME/.evidence-report-gh-timed-out` if it never does. See the fixture's
 * own doc comment for why this proves concurrency rather than racing on a
 * bare sleep.
 */
function writeFakeGhRendezvousOnEvidenceBodyFetch(dir: string): void {
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
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "labels" ]; then
  printf '%s\n' '{"labels":[{"name":"vinaya/tranche:x"}]}'
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
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "body" ] && [ "$6" = "-q" ] && [ "$7" = ".body" ]; then
  i=0
  while [ ! -f "$HOME/.reviewer-dispatch-started" ] && [ "$i" -lt 40 ]; do
    sleep 0.05
    i=$((i + 1))
  done
  if [ ! -f "$HOME/.reviewer-dispatch-started" ]; then
    touch "$HOME/.evidence-report-gh-timed-out"
  fi
  echo '{"body":"Closes #${TASK}"}'
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
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "labels" ]; then
  printf '%s\n' '{"labels":[{"name":"vinaya/tranche:x"}]}'
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
 * Same as `writeFakeGh`, except `gh issue comment` actually succeeds and
 * writes to the shared posted-comments dir — for a fixture whose own pause
 * is legitimately posted on the Issue (no PR exists yet to carry it) rather
 * than the log flush's best-effort, allowed-to-fail write `writeFakeGh`
 * otherwise models.
 */
function writeFakeGhWithWorkingIssueComment(dir: string): void {
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
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "labels" ]; then
  printf '%s\n' '{"labels":[{"name":"vinaya/tranche:x"}]}'
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
echo "unhandled fake gh call in working-issue-comment scenario: $*" >&2
exit 1
`
  )
}

/** Same as `writeFakeGh`, plus every call's own arguments appended to `$HOME/.fake-gh-call-log` before any handling — a fixture asserting the driver's own evidence report actually fetches the live body needs a real, positive trace of that `gh pr view … -q .body` call, not merely a passing run. */
function writeFakeGhWithCallLog(dir: string): void {
  writeFakeBinary(
    dir,
    'gh',
    `#!/bin/sh
echo "$*" >> "$HOME/.fake-gh-call-log"
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
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "labels" ]; then
  printf '%s\n' '{"labels":[{"name":"vinaya/tranche:x"}]}'
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
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "labels" ]; then
  printf '%s\n' '{"labels":[{"name":"vinaya/tranche:x"}]}'
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
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "labels" ]; then
  printf '%s\n' '{"labels":[{"name":"vinaya/tranche:x"}]}'
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
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "labels" ]; then
  printf '%s\n' '{"labels":[{"name":"vinaya/tranche:x"}]}'
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
/**
 * O6: identical to `writeFakeGhCrashOnSecondPost`'s own crash
 * trigger (`publishRound`'s second comment post fails), except the failure
 * fires exactly ONCE — a marker file (`$HOME/.gh-crash-used`) flips it back
 * to healthy immediately after — so the driver's own best-effort pause
 * comment, posted moments later from inside the NEW catch this fixes,
 * lands normally. Isolates "the crash itself is now a clean pause" from
 * the pre-existing, separate fact that `postMarkedComment`/`refuse` hard-
 * exits the process on ITS OWN posting failure (`forge-write.ts`) — a real
 * gap, but a different one than this task's own Surface names.
 */
function writeFakeGhCrashOnceThenHealthy(dir: string): void {
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
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "labels" ]; then
  printf '%s\n' '{"labels":[{"name":"vinaya/tranche:x"}]}'
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
  if [ "$N" = "1" ] && [ ! -f "$HOME/.gh-crash-used" ]; then
    touch "$HOME/.gh-crash-used"
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

function setUpCrashMidPublishThenHealthy(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaude(binDir)
  writeFakeGhCrashOnceThenHealthy(binDir)
  writeFakeGit(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

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
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "labels" ]; then
  printf '%s\n' '{"labels":[{"name":"vinaya/tranche:x"}]}'
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

/**
 * O10 (`task-run-v1` 21, `#541`): identical to `writeFakeGhCrashOnSecondPost`
 * except `gh issue comment` — the log flush's own forge write — SUCCEEDS
 * instead of the shared fixture's deliberate failure, recording each posted
 * body under `$HOME/.fake-gh-posted-issue-comments/`. Every other test in
 * this file relies on that call failing ("log flush not under test") so
 * flush attempts stay silent no-ops; this ONE scenario needs the opposite —
 * a flush that can actually succeed — to observe, deterministically, that
 * the loop's own outbox reaches the forge even when this run ends via an
 * uncaught throw rather than a decided `pause`/`publish`.
 */
function writeFakeGhCrashOnSecondPostFlushSucceeds(dir: string): void {
  writeFakeBinary(
    dir,
    'gh',
    `#!/bin/sh
STATE_DIR="$HOME/.fake-gh-posted-comments"
ISSUE_STATE_DIR="$HOME/.fake-gh-posted-issue-comments"
mkdir -p "$STATE_DIR" "$ISSUE_STATE_DIR"
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "comments" ]; then
  printf '%s\\n' '{"comments":[{"body":"<!-- aeg:brief:v1 -->\\nBrief hash: deadbeef\\nDo the thing.\\n\\n## Objectives\\n\\nO1. Do the thing.\\n\\n## Planner rationale\\n\\nOut of scope for facts.\\n","author":{"login":"daniboomerang"}}]}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "title" ]; then
  printf '%s\\n' '{"title":"[dev-review-loop-v1] ${TASK} \\u2014 test task"}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "labels" ]; then
  printf '%s\n' '{"labels":[{"name":"vinaya/tranche:x"}]}'
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
  N=$(ls "$ISSUE_STATE_DIR"/comment-*.md 2>/dev/null | wc -l | tr -d ' ')
  BODY_FILE="$5"
  cp "$BODY_FILE" "$ISSUE_STATE_DIR/comment-$((N + 1)).md"
  echo "https://github.com/example/repo/issues/${TASK}#issuecomment-$((N + 1))"
  exit 0
fi
echo "unhandled fake gh call: $*" >&2
exit 1
`
  )
}

function setUpCrashMidPublishFlushSucceeds(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaude(binDir)
  writeFakeGhCrashOnSecondPostFlushSucceeds(binDir)
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
    // never happened. Fixed: `result: 'merged_ready'` is held until
    // `publishRound` returns without throwing, so a crash here never logs
    // THAT — even though O10's own crash-recovery fix (task-run-v1 21,
    // `#541`) now DOES log its own `journal_finalized` here, with
    // `result: 'stopped'`, so `loop_started` still gets a terminal event to
    // pair with (see the O10 test below) — the two must never be confused.
    const journalFinalizedLines = outboxLines(home).filter((l) => l.event === 'journal_finalized')
    expect(journalFinalizedLines.some((l) => l.result === 'merged_ready')).toBe(false)
  }, 20000)

  it("O10 (task-run-v1 21, #541): still flushes the outbox to the forge on the way out, even though this run ends via an uncaught throw — task-log-v1 8 (#626, O1): only once a target is configured, never to the task's own Issue", () => {
    const { home, cwd, path } = setUpCrashMidPublishFlushSucceeds()
    // task-log-v1 8 (Issue #626, O1): the round-end flush no longer
    // defaults to the task's own Issue — it is a no-op unless
    // `logPublish` names a target. The fake `gh issue comment` stub
    // doesn't discriminate by issue number, so any distinct number proves
    // the same crash-survival guarantee at its new, configured home.
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify({ logPublish: { issue: TASK + 1 } }))
    const r = runLoop(home, cwd, path)
    expect(r.status).not.toBe(0)

    // Every explicit `d.flushOutbox(task)` call site inside the round loop
    // itself runs BEFORE `publishRound` throws (round 1's own gate/verdicts
    // processing) — so a post reaching the Issue here can only be the ONE
    // flush this run never explicitly asked for: the `finally` wrapping the
    // whole loop body, which now runs on every exit, including this one.
    const issueDir = join(home, '.fake-gh-posted-issue-comments')
    const posted = existsSync(issueDir) ? readdirSync(issueDir).filter((f) => f.startsWith('comment-')) : []
    expect(posted.length).toBeGreaterThan(0)

    const body = readFileSync(join(issueDir, posted[0] as string), 'utf8')
    expect(body).toMatch(/^<!-- aeg:log:/)
  }, 20000)

  it('task-log-v1 8 (Issue #626, O1): with no logPublish configured, the round-end flush posts nowhere, even on the same uncaught-throw exit path O10 guarantees for a configured target', () => {
    const { home, cwd, path } = setUpCrashMidPublishFlushSucceeds()
    const r = runLoop(home, cwd, path)
    expect(r.status).not.toBe(0)

    const issueDir = join(home, '.fake-gh-posted-issue-comments')
    const posted = existsSync(issueDir) ? readdirSync(issueDir).filter((f) => f.startsWith('comment-')) : []
    expect(posted).toHaveLength(0)
  }, 20000)

  // `#548` v3, O2: this exact scenario — a genuinely uncaught throw mid-round,
  // never a decided `pause`/`publish` — is the fixture the brief asks for.
  // The role log is the one trace left inside this task's Surface (the forge
  // journal event needs an out-of-surface `packages/aeg-core` schema change
  // and belongs to task-log-v1 instead, per the Principal's ruling on #548).
  it('O2 (#548 v3): an uncaught error mid-loop leaves a driver_exited trace in the role log', () => {
    const { home, cwd, path } = setUpCrashMidPublish()
    const r = runLoop(home, cwd, path)
    expect(r.status).not.toBe(0)

    const roleLog = readFileSync(join(home, '.vinaya', 'loops', 'unresolved', `${TASK}.log`), 'utf8')
    expect(roleLog).toMatch(/^\[dev-review-loop\] driver_exited: reason=error last_decision=\S+$/m)
  }, 20000)

  // O6: the SAME uncaught-error scenario, now proven to be a
  // clean, decided pause — never a raw crash the process merely survives by
  // accident. The driver lock is deliberately left in place (never cleared)
  // for this reason: `task status` (O2) reads a live lock as `running`
  // before it ever consults the pause-state file, so a cleared lock here
  // would make the process's own death indistinguishable from a genuine,
  // settled pause a Principal decided — exactly the ambiguity O5's
  // dead-lock takeover exists to resolve for whichever of the two actually
  // happened. Uses the "crashes once, then recovers" gh fixture rather than
  // the persistent one above — the driver's OWN pause-comment post, moments
  // later, must land on a healthy `gh`, not re-trigger the same fault a
  // second time (that second fault is real too, but it is `forge-write.ts`'s
  // own `refuse`-hard-exits-the-process design, a separate gap outside this
  // task's Surface).
  it('O6: the SAME crash is a decided pause(infrastructure) — the lock stays in place, a real pause-state and PR comment exist, nothing is thrown', () => {
    const { home, cwd, path } = setUpCrashMidPublishThenHealthy()
    const r = runLoop(home, cwd, path)
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/paused \(infrastructure\)/)

    // The lock is NEVER cleared for this reason — still on disk, still
    // naming a real pid, proving this run's own `finally` deliberately
    // skipped `clearDriverLock` rather than the process merely not having
    // reached it yet (this run already returned, `spawnSync` already
    // exited).
    const lock = JSON.parse(readFileSync(driverLockPath(home), 'utf8')) as { pid: number; startedAt: string }
    expect(typeof lock.pid).toBe('number')

    const pauseState = JSON.parse(
      readFileSync(join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'pause-state.json'), 'utf8')
    ) as Record<string, unknown>
    expect(pauseState.reason).toBe('infrastructure')

    const posted = postedCommentFiles(home).map((f) => readFileSync(join(home, '.fake-gh-posted-comments', f), 'utf8'))
    expect(posted.some((body) => /^<!-- aeg:loop:paused:infrastructure -->$/m.test(body))).toBe(true)
  }, 20000)
})

/**
 * O6 — a static enumeration, not a behavioral one: every
 * `return { finalDecision` (a real exit from `devReviewLoop`) and every
 * `d.exitProcess(` call in the source names its own decision kind, so the
 * loop's own exit sites are countable by inspection. Only two kinds may
 * ever be the reason the FUNCTION resolves without a lock left behind:
 * `publish`, and the re-exec hand-off (`exitProcess`, the literal process
 * boundary — a real hand-off to a child process, not a decision this
 * process makes about its own work). Every `pause`-shaped return is
 * legitimate (see the two classes above) but is never counted as one of
 * the "the process really ends" sites the fixture names — a pause return
 * still ends THIS invocation's own async call (there is no infinite
 * retry loop in this codebase), but the two sanctioned reasons the loop
 * itself decides to stop being the source of new work are publish and an
 * explicit stop (`d.exitProcess` on a clean re-exec hand-off, or the
 * DeveloperStopSignal path posting an explicit refusal/escalation).
 */
describe('devReviewLoop — the loop’s exit sites (O6)', () => {
  it('exactly one exitProcess call site exists — the re-exec hand-off — never a bare process.exit sprinkled elsewhere', () => {
    const source = readFileSync(join(import.meta.dir, '..', '..', 'src', 'lib', 'dev-review-loop.ts'), 'utf8')
    const exitProcessCalls = source.match(/\bd\.exitProcess\(/g) ?? []
    expect(exitProcessCalls).toHaveLength(1)
  })

  it('the outer round-loop catch no longer re-throws — it is a `return`, same as every other decided exit', () => {
    const source = readFileSync(join(import.meta.dir, '..', '..', 'src', 'lib', 'dev-review-loop.ts'), 'utf8')
    // Located via `recordDriverExited('error')` — unique to THIS catch —
    // rather than a `catch (err) {`-anchored regex: several OTHER catches in
    // this file (control-store-v1 task 6, `#556`: `resolveEscalation`'s own
    // resume/cancel error handling) also re-throw an unrecognized error by
    // design, and ANY regex starting from a `catch (err) {` literal and
    // lazily searching forward will eventually reach this same unique marker
    // regardless of which catch it started at — a loose pattern can never
    // reliably isolate this ONE block. Plain string indexing does.
    const markerIndex = source.indexOf("recordDriverExited('error')")
    expect(markerIndex).toBeGreaterThan(-1)
    const catchStart = source.lastIndexOf('catch (err) {', markerIndex)
    expect(catchStart).toBeGreaterThan(-1)
    const catchEnd = source.indexOf('\n    }\n\n    // eslint-disable-next-line no-constant-condition', markerIndex)
    expect(catchEnd).toBeGreaterThan(markerIndex)
    const body = source.slice(catchStart, catchEnd)
    expect(body).not.toMatch(/^\s*throw err\s*$/m)
    expect(body).toMatch(/return \{ finalDecision: decision, prNumber, task \}/)
  })

  // Round 2 review, BLOCKER: the outer catch used to wrap only the
  // `runRoundLoop()` call — round 1's own fresh-dispatch entry (a real forge
  // read, `fetchFrozenBrief`, sitting BEFORE that call) still crashed
  // uncaught on failure. Proves the widened `try` now covers it too: no
  // frozen brief on the Issue is exactly the failure `fetchFrozenBrief`
  // itself throws for, and it must now become a decided pause, never an
  // uncaught exit, with the driver never even reaching `dispatchDeveloper`.
  function writeFakeGhNoFrozenBrief(dir: string): void {
    writeFakeBinary(
      dir,
      'gh',
      `#!/bin/sh
STATE_DIR="$HOME/.fake-gh-posted-comments"
mkdir -p "$STATE_DIR"
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "comments" ]; then
  echo '{"comments":[]}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "title" ]; then
  printf '%s\\n' '{"title":"[dev-review-loop-v1] ${TASK} \\u2014 test task"}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "labels" ]; then
  printf '%s\n' '{"labels":[{"name":"vinaya/tranche:x"}]}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  echo '[]'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  echo "https://github.com/example/repo/pull/-1#issuecomment-1"
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
  N=$(ls "$STATE_DIR"/comment-*.md 2>/dev/null | wc -l | tr -d ' ')
  BODY_FILE="$5"
  cp "$BODY_FILE" "$STATE_DIR/comment-$((N + 1)).md"
  echo "https://github.com/example/repo/issues/$3#issuecomment-$((N + 1))"
  exit 0
fi
echo "unhandled fake gh call: $*" >&2
exit 1
`
    )
  }

  function setUpNoFrozenBrief(): { home: string; cwd: string; path: string } {
    const home = tempDir('vinaya-drl-home-')
    const cwd = tempDir('vinaya-drl-cwd-')
    const binDir = tempDir('vinaya-drl-bin-')
    writeFakeClaude(binDir)
    writeFakeGhNoFrozenBrief(binDir)
    writeFakeGit(binDir)
    return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
  }

  it("a forge-read failure in round 1's own fresh-dispatch entry (fetchFrozenBrief, before runRoundLoop even starts) is a decided pause too — never an uncaught crash, and no developer is ever dispatched", () => {
    const { home, cwd, path } = setUpNoFrozenBrief()
    const r = runLoop(home, cwd, path)
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/paused \(infrastructure\)/)
    expect(existsSync(join(home, '.fake-dev-invoked'))).toBe(false)

    const pauseState = JSON.parse(
      readFileSync(join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'pause-state.json'), 'utf8')
    ) as Record<string, unknown>
    expect(pauseState.reason).toBe('infrastructure')
    expect(String(pauseState.detail)).toMatch(/carries no principal-authored, frozen/)

    // O6: the lock is deliberately left in place for this reason — the same
    // "process stays alive" discipline every other infrastructure/
    // stale_driver pause now gets.
    const lock = JSON.parse(readFileSync(driverLockPath(home), 'utf8')) as { pid: number }
    expect(typeof lock.pid).toBe('number')
  }, 20000)

  // A `git` failure on `rev-parse origin/main` is the driver's own SETUP,
  // run before round 1's fresh-dispatch entry even starts (this file's own
  // `baseHeadAtStart` read) — it must reach the same widened `try` any other
  // setup-phase failure does, never propagate straight out of
  // `devReviewLoop` uncaught with no pause/lock left behind.
  function writeFakeGitFailingRevParseOriginMain(dir: string): void {
    writeFakeBinary(
      dir,
      'git',
      `#!/bin/sh
if [ "$1" = "rev-parse" ] && [ "$2" = "origin/main" ]; then
  echo "fatal: ambiguous argument 'origin/main': unknown revision or path not in the working tree." >&2
  exit 128
fi
if [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then
  echo "$PWD"
  exit 0
fi
exit 1
`
    )
  }

  function setUpFailingGitSetupRead(): { home: string; cwd: string; path: string } {
    const home = tempDir('vinaya-drl-home-')
    const cwd = tempDir('vinaya-drl-cwd-')
    const binDir = tempDir('vinaya-drl-bin-')
    writeFakeClaude(binDir)
    writeFakeGhNoFrozenBrief(binDir)
    writeFakeGitFailingRevParseOriginMain(binDir)
    return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
  }

  it("a git read failure in the driver's own SETUP (git rev-parse origin/main, before round 1's fresh-dispatch entry) is a decided pause — never an uncaught crash, and no developer is ever dispatched", () => {
    const { home, cwd, path } = setUpFailingGitSetupRead()
    const r = runLoop(home, cwd, path)
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/paused \(infrastructure\)/)
    expect(existsSync(join(home, '.fake-dev-invoked'))).toBe(false)

    const pauseState = JSON.parse(
      readFileSync(join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'pause-state.json'), 'utf8')
    ) as Record<string, unknown>
    expect(pauseState.reason).toBe('infrastructure')

    // O6: the lock stays in place — the process is alive, holding it,
    // exactly as it does for every other infrastructure pause.
    const lock = JSON.parse(readFileSync(driverLockPath(home), 'utf8')) as { pid: number }
    expect(typeof lock.pid).toBe('number')
  }, 20000)
})

/**
 * Round 2 review, BLOCKER (task-run-v1 21, `#541`, O9): `issue view --json
 * comments` dynamically replays whatever `issue comment` has actually
 * posted to `$HOME/.fake-gh-posted-issue-comments` — the static-brief-only
 * variant every OTHER scenario in this file uses is fine for those (none
 * of them need a SECOND run to see what a FIRST run flushed), but this
 * scenario's whole point is that a reattach reconstructs history from
 * exactly those flushed lines. `pr comment`'s crash-on-the-second-post
 * logic is unchanged from `writeFakeGhCrashOnSecondPostFlushSucceeds` —
 * this fixture is that one, plus the dynamic Issue-comment replay.
 */
function writeFakeGhCrashOnceThenReattach(dir: string): void {
  writeFakeBinary(
    dir,
    'gh',
    `#!/bin/sh
STATE_DIR="$HOME/.fake-gh-posted-comments"
ISSUE_STATE_DIR="$HOME/.fake-gh-posted-issue-comments"
mkdir -p "$STATE_DIR" "$ISSUE_STATE_DIR"
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "comments" ]; then
  FAKE_GH_STATE="$ISSUE_STATE_DIR" bun -e '
    const fs = require("fs")
    const dir = process.env.FAKE_GH_STATE
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.startsWith("comment-")).sort((a, b) => Number(a.match(/\\d+/)[0]) - Number(b.match(/\\d+/)[0]))
      : []
    const flushed = files.map((f) => fs.readFileSync(dir + "/" + f, "utf8"))
    const brief = "<!-- aeg:brief:v1 -->\\nBrief hash: deadbeef\\nDo the thing.\\n\\n## Objectives\\n\\nO1. Do the thing.\\n\\n## Planner rationale\\n\\nOut of scope for facts.\\n"
    const bodies = [brief, ...flushed]
    console.log(JSON.stringify({ comments: bodies.map((body) => ({ body, author: { login: "daniboomerang" } })) }))
  '
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "title" ]; then
  printf '%s\\n' '{"title":"[dev-review-loop-v1] ${TASK} \\u2014 test task"}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "labels" ]; then
  printf '%s\n' '{"labels":[{"name":"vinaya/tranche:x"}]}'
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
  N=$(ls "$ISSUE_STATE_DIR"/comment-*.md 2>/dev/null | wc -l | tr -d ' ')
  BODY_FILE="$5"
  cp "$BODY_FILE" "$ISSUE_STATE_DIR/comment-$((N + 1)).md"
  echo "https://github.com/example/repo/issues/${TASK}#issuecomment-$((N + 1))"
  exit 0
fi
echo "unhandled fake gh call: $*" >&2
exit 1
`
  )
}

/** Same as \`writeFakeGhCrashOnceThenReattach\`, minus the crash-on-second-post logic — every \`pr comment\` succeeds. Swapped in mid-test, after the crash has already happened once, so round 2's own posts don't hit the same count-based trigger. */
function writeFakeGhReattachSucceeds(dir: string): void {
  writeFakeBinary(
    dir,
    'gh',
    `#!/bin/sh
STATE_DIR="$HOME/.fake-gh-posted-comments"
ISSUE_STATE_DIR="$HOME/.fake-gh-posted-issue-comments"
mkdir -p "$STATE_DIR" "$ISSUE_STATE_DIR"
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "comments" ]; then
  FAKE_GH_STATE="$ISSUE_STATE_DIR" bun -e '
    const fs = require("fs")
    const dir = process.env.FAKE_GH_STATE
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.startsWith("comment-")).sort((a, b) => Number(a.match(/\\d+/)[0]) - Number(b.match(/\\d+/)[0]))
      : []
    const flushed = files.map((f) => fs.readFileSync(dir + "/" + f, "utf8"))
    const brief = "<!-- aeg:brief:v1 -->\\nBrief hash: deadbeef\\nDo the thing.\\n\\n## Objectives\\n\\nO1. Do the thing.\\n\\n## Planner rationale\\n\\nOut of scope for facts.\\n"
    const bodies = [brief, ...flushed]
    console.log(JSON.stringify({ comments: bodies.map((body) => ({ body, author: { login: "daniboomerang" } })) }))
  '
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "title" ]; then
  printf '%s\\n' '{"title":"[dev-review-loop-v1] ${TASK} \\u2014 test task"}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "labels" ]; then
  printf '%s\n' '{"labels":[{"name":"vinaya/tranche:x"}]}'
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
  echo '{"id":1,"name":"ci","status":"completed","conclusion":"success"}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
  N=$(ls "$ISSUE_STATE_DIR"/comment-*.md 2>/dev/null | wc -l | tr -d ' ')
  BODY_FILE="$5"
  cp "$BODY_FILE" "$ISSUE_STATE_DIR/comment-$((N + 1)).md"
  echo "https://github.com/example/repo/issues/${TASK}#issuecomment-$((N + 1))"
  exit 0
fi
echo "unhandled fake gh call: $*" >&2
exit 1
`
  )
}

describe('devReviewLoop — O9 (task-run-v1 21, #541, round 2 review BLOCKER): a crash between a green round_ended and journal_finalized never resets numbering on reattach', () => {
  it('round 2 dispatches directly (never round 1 again), and the eventual published table still lists round 1', () => {
    const home = tempDir('vinaya-drl-home-')
    const cwd = tempDir('vinaya-drl-cwd-')
    const binDir = tempDir('vinaya-drl-bin-')
    writeFakeClaude(binDir)
    writeFakeGhCrashOnceThenReattach(binDir)
    writeFakeGit(binDir)
    const path = `${binDir}:${pathWithoutRealVendors()}`
    // task-log-v1 8 (Issue #626, O1): the round-end flush no longer
    // defaults to the task's own Issue — this fixture's fake `gh` doesn't
    // discriminate by issue number for either the read or the write, so any
    // distinct number reproduces the SAME crash-recovery/reattach story at
    // its new, configured home.
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify({ logPublish: { issue: TASK + 1 } }))

    // Round 1: gate green, reviewers clean, `round_ended(outcome: 'green')`
    // logs — then `publishRound` crashes posting the security verdict,
    // before the REAL `journal_finalized` (the one `publishRound` itself
    // would trigger) is ever reached. O10's own crash-recovery fix (above)
    // still logs its OWN `journal_finalized`, but with `result: 'stopped'`
    // — never `'merged_ready'`, which only the real publish path can ever
    // write — so it must never be mistaken for a genuine completion. The
    // flush actually succeeds in THIS fixture (unlike most others in this
    // file), so both lines have already left the local outbox by the time
    // `runLoop` returns — read them back from what was flushed to the
    // Issue instead of the local file.
    const r1 = runLoop(home, cwd, path)
    expect(r1.status).not.toBe(0)
    const issueDir = join(home, '.fake-gh-posted-issue-comments')
    const flushedAfterCrash = readdirSync(issueDir)
      .filter((f) => f.startsWith('comment-'))
      .flatMap((f) => readFileSync(join(issueDir, f), 'utf8').split('\n').filter(Boolean))
      .flatMap((line) => {
        try {
          return [JSON.parse(line)]
        } catch {
          return []
        }
      })
    expect(flushedAfterCrash.some((l) => l.event === 'round_ended' && l.outcome === 'green')).toBe(true)
    expect(flushedAfterCrash.some((l) => l.event === 'journal_finalized' && l.result === 'merged_ready')).toBe(false)

    // Swap to a `gh` with no crash logic — round 2's own posts must succeed
    // — then reattach with a plain `--task`, exactly as an operator
    // re-running the same command after the crash would. Round ≥ 2's
    // confidence gate reads a file the developer would normally write; an
    // ATTACH never dispatches the developer at all (the code is already on
    // the remote), so it's pre-seeded here exactly as
    // `setUpAttachRecoversHeldRound`'s own round-2 fixtures do.
    writeFakeGhReattachSucceeds(binDir)
    const worktreeDir = join(cwd, '.worktrees', BRANCH)
    mkdirSync(worktreeDir, { recursive: true })
    writeFileSync(join(worktreeDir, '.vinaya-confidence'), 'CONFIDENCE: 90 — same code, already reviewed clean once\n')
    const r2 = runLoop(home, cwd, path)
    expect(r2.status).toBe(0)
    expect(r2.stdout).toMatch(/publish/)

    // The bug this test guards: round 2 must be a NEW round on the SAME
    // code, never round 1 redone. `writeFakeClaude` organizes reviewer
    // work directories by `$VINAYA_ROUND` — round 2's own directories only
    // exist if the driver genuinely advanced past round 1's own numbering.
    const drlRoot = join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK))
    expect(existsSync(join(drlRoot, 'round-2-reviewer-work'))).toBe(true)
    expect(existsSync(join(drlRoot, 'round-2-security-work'))).toBe(true)

    // The published summary — round 2's real, live computation — still
    // names round 1, reconstructed from what round 1 actually flushed
    // before it crashed, never dropped just because it never got to
    // publish (Origin, PR #536).
    const files = postedCommentFiles(home)
    const summaryFile = files[files.length - 1] as string
    const summary = readFileSync(join(home, '.fake-gh-posted-comments', summaryFile), 'utf8')
    expect(summary).toMatch(/^\| 1 \|/m)
    expect(summary).toMatch(/^\| 2 \|/m)
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
if [ "$1" = "-C" ] && [ "$3" = "rev-parse" ] && [ "$4" = "HEAD" ]; then
  echo "${HEAD_SHA}"
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

/** Same as `writeFakeGit`, except `-C <dir> rev-parse HEAD` answers `DIVERGED_LOCAL_HEAD_SHA`, never `HEAD_SHA` — simulates a local worktree that has moved on since it was pushed (`#561` round 2 review, MAJOR). */
function writeFakeGitWorktreeHeadDiverged(dir: string): void {
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
if [ "$1" = "-C" ] && [ "$3" = "rev-parse" ] && [ "$4" = "HEAD" ]; then
  echo "${DIVERGED_LOCAL_HEAD_SHA}"
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

function runCancel(home: string, cwd: string, path: string, pr: number): CliResult {
  return runDevReviewLoopArgs(home, cwd, path, ['--cancel', String(pr), '--agent', 'claude'])
}

/**
 * Round 6 fix, live-reproduced on the declared supported host (Darwin):
 * every fixture in this file signals through `$HOME` (`.fake-dev-invoked`,
 * `.dev-invocations`, `.reviewer-dispatch-started`, `.fake-gh-posted-
 * comments`, …) — this suite is entirely about LOOP LOGIC (round
 * assessment, publish/pause/resume), never about the isolation boundary
 * itself (that is `worker-boundary.test.ts`'s own, dedicated, real
 * `sandbox-exec` coverage). Task 3 (`#560`)'s round-2 fix made
 * `requireWorkerIsolation` default `true` on Darwin — the correct O3
 * behavior for a real dispatch, but it means a Developer/Reviewer dispatch
 * from this suite is confined for real, on this one host, and its
 * confined `allowedDir` (the worktree/repo-root fallback) is a DIFFERENT
 * directory from `$HOME`: every fixture's `$HOME`-based signal silently
 * fails to write, and the loop waits forever for state that can never
 * arrive. Writing (or merging into) `cwd`'s own `vinaya.config.json` here
 * — the SAME repo-local config `loadConfig()` already resolves everything
 * else from — opts these loop-logic fixtures out of a feature they were
 * never designed to exercise, without touching the two existing scenarios
 * that already write their own `cwd`-local config for an unrelated key
 * (`logPublish`).
 */
function disableIsolationForFixture(cwd: string): void {
  const path = join(cwd, 'vinaya.config.json')
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  if (existing.dispatch?.requireWorkerIsolation !== undefined) return
  writeFileSync(
    path,
    JSON.stringify({ ...existing, dispatch: { ...existing.dispatch, requireWorkerIsolation: false } })
  )
}

function runDevReviewLoopArgs(
  home: string,
  cwd: string,
  path: string,
  args: string[],
  extraEnv: Record<string, string> = {}
): CliResult {
  disableIsolationForFixture(cwd)
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
    // One more than before: the driver now posts the round
    // marker comment itself, ahead of both reviewer verdicts — the
    // Developer's turn never posts one any more (O1).
    expect(firstRunFiles).toHaveLength(4)

    const [roundCommentFile, reviewerFile, securityFile, summaryFile] = firstRunFiles
    const roundCommentPosted = readFileSync(join(home, '.fake-gh-posted-comments', roundCommentFile as string), 'utf8')
    expect(roundCommentPosted).toMatch(/^<!-- aeg:developer:round-1 -->$/m)
    expect(roundCommentPosted).toMatch(new RegExp(`^Head: ${HEAD_SHA}$`, 'm'))

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

  it('runs the evidence report in-process, from the driver, with no developer resume for it', () => {
    // Every `gh` call this run makes is appended to `.fake-gh-call-log`
    // before `writeFakeGh`'s own handling — proves `runEvidenceReport`
    // actually fetches the PR's live body (the first half of the same
    // fetch-then-splice sequence `vinaya pr report --push` runs) once the
    // head's CI is green, in the SAME round as both reviewer dispatches —
    // never a `vinaya pr report --push` subprocess (there is no such
    // invocation for this fake `gh`/`git` PATH to answer, and none appears
    // in the log).
    const home = tempDir('vinaya-drl-home-')
    const cwd = tempDir('vinaya-drl-cwd-')
    const binDir = tempDir('vinaya-drl-bin-')
    writeFakeClaudeCountingDevInvocations(binDir)
    writeFakeGhWithCallLog(binDir)
    writeFakeGit(binDir)
    const path = `${binDir}:${pathWithoutRealVendors()}`

    const r = runLoop(home, cwd, path)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/publish/)

    const callLog = readFileSync(join(home, '.fake-gh-call-log'), 'utf8')
    expect(callLog).toMatch(/pr view 123 --json body -q \.body/)

    // Exactly one developer turn for this round-1-clean scenario — the
    // evidence report never triggers a second, resumed developer turn: the
    // Developer's own turn ended at the push (O1), and the driver runs the
    // report itself from there, never waiting on or resuming the Developer.
    const devInvocations = readFileSync(join(home, '.dev-invocations'), 'utf8').trim().split('\n').filter(Boolean)
    expect(devInvocations).toHaveLength(1)
  }, 20000)

  it('runs the evidence report concurrently with reviewer dispatch, never serialized ahead of it', () => {
    // Rendezvous, not a sleep-and-hope timing race: the evidence report's
    // OWN `gh pr view … -q .body` fetch (`defaultRunEvidenceReport`'s first
    // step) blocks in the fake `gh` below until a marker file the fake
    // `claude` writes the instant a reviewer/security role starts exists —
    // proving that call was still in flight when reviewer dispatch began,
    // the two genuinely overlapping rather than one completing before the
    // other starts. A regression that serializes the report AHEAD of
    // reviewer dispatch (the shape this task's own Boundary names: sessions
    // idling twice waiting on the report before reviewers ever saw a green
    // head) reproduces as a real deadlock here — reviewer dispatch can never
    // start until the blocked `gh` call returns, and the blocked call can
    // never return until reviewer dispatch starts — bounded below so the
    // test fails fast (`.evidence-report-gh-timed-out`) instead of hanging.
    const home = tempDir('vinaya-drl-home-')
    const cwd = tempDir('vinaya-drl-cwd-')
    const binDir = tempDir('vinaya-drl-bin-')
    writeFakeClaudeMarkingReviewerDispatchStart(binDir)
    writeFakeGhRendezvousOnEvidenceBodyFetch(binDir)
    writeFakeGit(binDir)
    const path = `${binDir}:${pathWithoutRealVendors()}`

    const r = runLoop(home, cwd, path)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/publish/)

    expect(existsSync(join(home, '.reviewer-dispatch-started'))).toBe(true)
    expect(existsSync(join(home, '.evidence-report-gh-timed-out'))).toBe(false)
  }, 20000)
})

/**
 * Same as `writeFakeClaude`, plus — for both reviewer roles only — writing
 * the role's own `$PWD` to `cwd.txt` and the content of a
 * `candidate-marker.txt` file found at that `$PWD` to
 * `candidate-marker-seen.txt`, both inside the role's own work directory.
 * `#561`'s own wiring fixture: proves
 * `dispatchReviewer` actually hands each reviewer a real, distinct `cwd`
 * (never before this task — `dispatchRole`'s `spawn` call carried none at
 * all) whose content traces back to the one shared candidate both roles
 * were dispatched against.
 */
function writeFakeClaudeCapturingReviewerCwd(dir: string): void {
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
    pwd > "$WD/cwd.txt"
    cat "$(pwd)/candidate-marker.txt" > "$WD/candidate-marker-seen.txt" 2>/dev/null || true
    : > "$WD/findings.txt"
    printf 'O1|MET|done.\\n' > "$WD/objectives.txt"
    printf 'BRIEF_CONFORMANCE: yes\\nSPEC_CONFORMANCE: yes\\nSCOPE: small\\nTESTS: pass\\nDOCS: n/a\\n' > "$WD/report.txt"
    echo '{"session_id":"rev-session-1","usage":{"input_tokens":8,"output_tokens":4}}'
    ;;
  security)
    WD="$WORKROOT/round-$VINAYA_ROUND-security-work"
    mkdir -p "$WD"
    pwd > "$WD/cwd.txt"
    cat "$(pwd)/candidate-marker.txt" > "$WD/candidate-marker-seen.txt" 2>/dev/null || true
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

describe('devReviewLoop — reviewers inspect one immutable candidate with isolated scratch space (#561)', () => {
  it('both reviewers this round dispatch against the SAME candidate content, from separate scratch directories, cleaned up once the round publishes (O1/O2/O3)', () => {
    const home = tempDir('vinaya-drl-home-')
    const cwd = tempDir('vinaya-drl-cwd-')
    const binDir = tempDir('vinaya-drl-bin-')
    writeFakeClaudeCapturingReviewerCwd(binDir)
    writeFakeGh(binDir)
    writeFakeGit(binDir)
    const path = `${binDir}:${pathWithoutRealVendors()}`

    // Seeds the developer's own local worktree with content this task's
    // snapshot mechanism copies from — the same `.worktrees/<branch>` path
    // `worktreePathForBranch()` already resolves, and the same convention a
    // real developer's pushed worktree already satisfies by the time
    // reviewers dispatch.
    const worktreeDir = join(cwd, '.worktrees', BRANCH)
    mkdirSync(worktreeDir, { recursive: true })
    writeFileSync(join(worktreeDir, 'candidate-marker.txt'), 'candidate content for round 1\n')

    const r = runLoop(home, cwd, path)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/publish/)

    const taskDir = join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK))
    const reviewerCwd = readFileSync(join(taskDir, 'round-1-reviewer-work', 'cwd.txt'), 'utf8').trim()
    const securityCwd = readFileSync(join(taskDir, 'round-1-security-work', 'cwd.txt'), 'utf8').trim()

    // O1/O2: distinct scratch directories, never the shared candidate
    // itself and never each other's.
    expect(reviewerCwd).not.toBe(securityCwd)
    expect(reviewerCwd).toMatch(/round-1-reviewer-scratch$/)
    expect(securityCwd).toMatch(/round-1-security-scratch$/)

    // O1: both reviewers read the identical candidate content.
    expect(readFileSync(join(taskDir, 'round-1-reviewer-work', 'candidate-marker-seen.txt'), 'utf8')).toBe(
      'candidate content for round 1\n'
    )
    expect(readFileSync(join(taskDir, 'round-1-security-work', 'candidate-marker-seen.txt'), 'utf8')).toBe(
      'candidate content for round 1\n'
    )

    // O3: the round's candidate and both scratch copies are gone once the
    // round published — nothing left over for a human, or the next round,
    // to find.
    expect(existsSync(join(taskDir, 'round-1-candidate'))).toBe(false)
    expect(existsSync(reviewerCwd)).toBe(false)
    expect(existsSync(securityCwd)).toBe(false)
  }, 20000)

  it('restart cleanliness: a candidate/scratch directory left by a crashed prior run is gone before this run dispatches anything (O3)', () => {
    const { home, cwd, path } = setUp()
    const taskDir = join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK))
    const staleCandidate = join(taskDir, 'round-9-candidate')
    mkdirSync(staleCandidate, { recursive: true })
    writeFileSync(join(staleCandidate, 'leftover.txt'), 'from a crashed prior run')
    const staleScratch = join(taskDir, 'round-9-reviewer-scratch')
    mkdirSync(staleScratch, { recursive: true })

    const r = runLoop(home, cwd, path)
    expect(r.status).toBe(0)
    expect(existsSync(staleCandidate)).toBe(false)
    expect(existsSync(staleScratch)).toBe(false)
  }, 20000)

  it("a local worktree whose own head has diverged from the round's resolved candidate sha is never copied — no candidate, no scratch cwd (round 2 review, MAJOR)", () => {
    const home = tempDir('vinaya-drl-home-')
    const cwd = tempDir('vinaya-drl-cwd-')
    const binDir = tempDir('vinaya-drl-bin-')
    writeFakeClaudeCapturingReviewerCwd(binDir)
    writeFakeGh(binDir)
    writeFakeGitWorktreeHeadDiverged(binDir)
    const path = `${binDir}:${pathWithoutRealVendors()}`

    // The local worktree exists and carries content, but `git -C <dir>
    // rev-parse HEAD` (faked above) answers a sha that is NOT this round's
    // resolved head — the exact "pushed, then moved on locally" case.
    const worktreeDir = join(cwd, '.worktrees', BRANCH)
    mkdirSync(worktreeDir, { recursive: true })
    writeFileSync(join(worktreeDir, 'candidate-marker.txt'), 'stale local content\n')

    const r = runLoop(home, cwd, path)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/publish/)

    const taskDir = join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK))
    // No candidate was ever built from the diverged worktree.
    expect(existsSync(join(taskDir, 'round-1-candidate'))).toBe(false)
    expect(existsSync(join(taskDir, 'round-1-reviewer-scratch'))).toBe(false)
    expect(existsSync(join(taskDir, 'round-1-security-scratch'))).toBe(false)
    // Reviewers dispatched with no `cwd` override at all — never handed the
    // stale worktree's own content as a substitute.
    const reviewerCwd = readFileSync(join(taskDir, 'round-1-reviewer-work', 'cwd.txt'), 'utf8').trim()
    expect(reviewerCwd).not.toMatch(/round-1-reviewer-scratch$/)
    // The fake reviewer's `cat "$(pwd)/candidate-marker.txt" > ... || true`
    // still creates its target file via shell redirection even when `cat`
    // itself fails — so the assertion is an EMPTY file, never a missing one.
    expect(readFileSync(join(taskDir, 'round-1-reviewer-work', 'candidate-marker-seen.txt'), 'utf8')).toBe('')
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
    // One more than before: the driver posts the round
    // marker comment itself before the escalation is even discovered — see
    // `devReviewLoop — round 1 clean, ends on publish`'s own O2 fixture.
    expect(pausedFiles).toHaveLength(2)
    const roundCommentPosted = readFileSync(join(home, '.fake-gh-posted-comments', pausedFiles[0] as string), 'utf8')
    expect(roundCommentPosted).toMatch(/^<!-- aeg:developer:round-1 -->$/m)
    const pauseComment = readFileSync(join(home, '.fake-gh-posted-comments', pausedFiles[1] as string), 'utf8')
    expect(pauseComment).toMatch(/^<!-- aeg:loop:paused:escalation -->$/m)
    expect(pauseComment).toMatch(/vinaya dev-review-loop --resume 123/)
    expect(pauseComment).not.toMatch(/^VERDICT:/m)
    // O1 ([task-log-v1] 9, Issue #631): `assessRound`'s own `'escalation'`
    // decision (a reviewer's ESCALATE verdict) carries no `detail` at all —
    // the driver narrates it from the same verdicts it already dispatched,
    // naming WHICH role escalated, so the comment alone states what fired.
    expect(pauseComment).toContain('reviewer returned ESCALATE this round')

    const pauseState = JSON.parse(
      readFileSync(join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'pause-state.json'), 'utf8')
    ) as Record<string, unknown>
    expect(pauseState.round).toBe(1)
    expect(pauseState.reason).toBe('escalation')
    expect(pauseState.detail).toContain('reviewer returned ESCALATE this round')

    // Seed a Principal ruling comment on the PR — the same shape
    // `filterPrincipalRulings`'s own unit tests use — before resuming. Named
    // `comment-3.md`: `comment-1.md`/`comment-2.md` are now the round
    // comment and the pause comment above.
    writeFileSync(
      join(home, '.fake-gh-posted-comments', 'comment-3.md'),
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

    // O11 (task-run-v1 21, #541, round 2 review MAJOR): the ruling-resume
    // prompt names the task/branch/worktree/head context AND the exact
    // command expected — not just "push fixes" in prose.
    expect(devPrompts).toMatch(new RegExp(`^Resuming task Issue #${TASK}\\.$`, 'm'))
    expect(devPrompts).toMatch(new RegExp(`^Branch: \`${BRANCH}\`$`, 'm'))
    expect(devPrompts).toMatch(/^Worktree: `.*\.worktrees\//m)
    expect(devPrompts).toMatch(/^Remote head: [0-9a-f]{40}$/m)
    expect(devPrompts).toMatch(/`git push`/)

    // Published: the two verdicts and the summary, appended after the round
    // comment, the pause comment, and the seeded ruling. No SECOND round
    // comment: the resumed round dispatches reviewers on the SAME head
    // (round 1, `HEAD_SHA` unchanged in this fixture), so the driver's own
    // `postForgeEffectOnce` key from before the pause is reused rather than
    // posted again.
    const allComments = postedCommentFiles(home)
    expect(allComments).toHaveLength(6)
  }, 20000)
})

// --- control-store-v1 task 6, #556: escalation record, resolution replay, cancel ---

function escalationRecordPath(home: string, task: number, round: number, head: string): string {
  return join(home, '.vinaya', 'control-store', String(task), 'escalation', `${task}-${round}-${head}.json`)
}

function resolutionRecordPath(home: string, task: number, round: number, head: string): string {
  return join(home, '.vinaya', 'control-store', String(task), 'resolution', `${task}-${round}-${head}.json`)
}

/** Every `epoch-NNNNNN.json` ownership claim on disk for `task`, sorted — used to prove a replayed/refused resolution attempt never bumps the shared epoch (code review, round 2, HIGH). */
function ownershipEpochFiles(home: string, task: number): string[] {
  const dir = join(home, '.vinaya', 'control-store', String(task), 'ownership')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => /^epoch-\d+\.json$/.test(f))
    .sort()
}

function seedRuling(home: string, commentName: string): void {
  writeFileSync(
    join(home, '.fake-gh-posted-comments', commentName),
    `<!-- aeg:principal:ruling:${TASK}-1 -->\nGo ahead.\n`
  )
}

describe('devReviewLoop — escalation record persisted at pause (O1)', () => {
  it('writes a durable escalation record carrying run identity, reason, and attempted recovery, with no chat history needed to read it back', () => {
    const { home, cwd, path } = setUpPauseResume()

    const paused = runLoop(home, cwd, path)
    expect(paused.status).not.toBe(0)

    const recordPath = escalationRecordPath(home, TASK, 1, HEAD_SHA)
    expect(existsSync(recordPath)).toBe(true)
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>
    expect(record.kind).toBe('escalation')
    expect(record.task).toBe(TASK)
    expect(record.round).toBe(1)
    expect(record.head).toBe(HEAD_SHA)
    expect(record.branch).toBe(BRANCH)
    expect(record.pr).toBe(123)
    expect(record.reason).toBe('escalation')
    expect(typeof record.runId).toBe('string')
    expect((record.runId as string).length).toBeGreaterThan(0)
    expect(typeof record.pid).toBe('number')
    expect(typeof record.host).toBe('string')
    expect(record.recipient).toBe('principal')
    expect(typeof record.attemptedRecovery).toBe('string')
    expect((record.attemptedRecovery as string).length).toBeGreaterThan(0)
  }, 20000)
})

describe('devReviewLoop — resolution consumed once, replay refused (O2)', () => {
  it('a second --resume against the SAME already-resolved pause is refused, never re-dispatching', () => {
    const { home, cwd, path } = setUpPauseResume()

    const paused = runLoop(home, cwd, path)
    expect(paused.status).not.toBe(0)

    seedRuling(home, 'comment-3.md')

    const resumed = runResume(home, cwd, path, 123)
    expect(resumed.status).toBe(0)
    expect(resumed.stdout).toMatch(/publish/)

    const resolutionPath = resolutionRecordPath(home, TASK, 1, HEAD_SHA)
    expect(existsSync(resolutionPath)).toBe(true)
    const resolution = JSON.parse(readFileSync(resolutionPath, 'utf8')) as Record<string, unknown>
    expect(resolution.decision).toBe('resume')

    // Replay: the SAME PR, the SAME pause instance already consumed above —
    // refused rather than silently re-dispatching a second time.
    const replayed = runResume(home, cwd, path, 123)
    expect(replayed.status).not.toBe(0)
    expect(replayed.stderr).toMatch(/already has a consumed resolution|replay refused/)
  }, 20000)
})

describe('devReviewLoop — --cancel (O3)', () => {
  it('refuses to cancel with no Principal ruling authenticating it', () => {
    const { home, cwd, path } = setUpPauseResume()

    const paused = runLoop(home, cwd, path)
    expect(paused.status).not.toBe(0)

    const cancelled = runCancel(home, cwd, path, 123)
    expect(cancelled.status).not.toBe(0)
    expect(cancelled.stderr).toMatch(/no Principal ruling comment yet/)
  }, 20000)

  it('cancels a paused run once — durable, and a second cancel is refused as a replay', () => {
    const { home, cwd, path } = setUpPauseResume()

    const paused = runLoop(home, cwd, path)
    expect(paused.status).not.toBe(0)

    seedRuling(home, 'comment-3.md')

    const cancelled = runCancel(home, cwd, path, 123)
    expect(cancelled.status).toBe(0)
    expect(cancelled.stdout).toMatch(/cancelled/)

    const resolutionPath = resolutionRecordPath(home, TASK, 1, HEAD_SHA)
    expect(existsSync(resolutionPath)).toBe(true)
    const resolution = JSON.parse(readFileSync(resolutionPath, 'utf8')) as Record<string, unknown>
    expect(resolution.decision).toBe('cancel')

    // Idempotent: a second --cancel against the SAME already-cancelled
    // escalation is refused as a replay, never a second transition.
    const cancelledAgain = runCancel(home, cwd, path, 123)
    expect(cancelledAgain.status).not.toBe(0)
    expect(cancelledAgain.stderr).toMatch(/already has a consumed resolution|replay refused/)

    // A cancelled pause never goes on to resume — the SAME escalation's
    // resolution is already consumed, by the cancel above.
    const resumeAfterCancel = runResume(home, cwd, path, 123)
    expect(resumeAfterCancel.status).not.toBe(0)
    expect(resumeAfterCancel.stderr).toMatch(/already has a consumed resolution|replay refused/)
  }, 20000)

  it('a replayed cancel is refused WITHOUT bumping the task epoch (code review, round 2, HIGH)', () => {
    const { home, cwd, path } = setUpPauseResume()

    const paused = runLoop(home, cwd, path)
    expect(paused.status).not.toBe(0)

    seedRuling(home, 'comment-3.md')

    const cancelled = runCancel(home, cwd, path, 123)
    expect(cancelled.status).toBe(0)
    const epochsAfterFirstCancel = ownershipEpochFiles(home, TASK)
    expect(epochsAfterFirstCancel.length).toBeGreaterThan(0)

    // A duplicate/replayed cancel against the SAME already-consumed
    // escalation must be refused before it ever claims a new epoch — a
    // replayed decision must not move state it was already consumed for.
    const cancelledAgain = runCancel(home, cwd, path, 123)
    expect(cancelledAgain.status).not.toBe(0)
    expect(cancelledAgain.stderr).toMatch(/already has a consumed resolution|replay refused/)
    expect(ownershipEpochFiles(home, TASK)).toEqual(epochsAfterFirstCancel)
  }, 20000)
})

describe('devReviewLoop — --cancel refuses a mismatched --agent (code review, round 2, MAJOR)', () => {
  it('refuses to terminate under an --agent that does not match the run’s actual dispatched agent', () => {
    const { home, cwd, path } = setUpPauseResume()

    // `runLoop` always dispatches under `--agent claude` (its own fixed
    // helper) — the escalation record persists that as the run's real
    // agent at pause time.
    const paused = runLoop(home, cwd, path)
    expect(paused.status).not.toBe(0)

    seedRuling(home, 'comment-3.md')

    const escalation = JSON.parse(readFileSync(escalationRecordPath(home, TASK, 1, HEAD_SHA), 'utf8')) as Record<
      string,
      unknown
    >
    expect(escalation.agent).toBe('claude')

    const mismatched = runDevReviewLoopArgs(home, cwd, path, ['--cancel', '123', '--agent', 'codex'])
    expect(mismatched.status).not.toBe(0)
    expect(mismatched.stderr).toMatch(/dispatched under agent 'claude', not 'codex'/)

    // Refused before ever consuming the resolution — a correctly-agented
    // cancel afterward still succeeds against the SAME still-open pause.
    expect(existsSync(resolutionRecordPath(home, TASK, 1, HEAD_SHA))).toBe(false)
    const cancelled = runCancel(home, cwd, path, 123)
    expect(cancelled.status).toBe(0)
    expect(cancelled.stdout).toMatch(/cancelled/)
  }, 20000)
})

describe('devReviewLoop — resolveEscalation’s WrongTargetResolutionError/StaleEscalationError, above the storage level (code review, round 2, MINOR)', () => {
  it('refuses a --resume whose escalation record was never written (StaleEscalationError)', () => {
    const { home, cwd, path } = setUpPauseResume()

    const paused = runLoop(home, cwd, path)
    expect(paused.status).not.toBe(0)

    seedRuling(home, 'comment-3.md')

    const recordPath = escalationRecordPath(home, TASK, 1, HEAD_SHA)
    expect(existsSync(recordPath)).toBe(true)
    rmSync(recordPath)

    const resumed = runResume(home, cwd, path, 123)
    expect(resumed.status).not.toBe(0)
    expect(resumed.stderr).toMatch(/is stale/)
    expect(resumed.stderr).toMatch(/no escalation record was ever written/)
  }, 20000)

  it('refuses a --cancel whose escalation record names a different PR (WrongTargetResolutionError)', () => {
    const { home, cwd, path } = setUpPauseResume()

    const paused = runLoop(home, cwd, path)
    expect(paused.status).not.toBe(0)

    seedRuling(home, 'comment-3.md')

    const recordPath = escalationRecordPath(home, TASK, 1, HEAD_SHA)
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>
    record.pr = 999
    writeFileSync(recordPath, JSON.stringify(record))

    const cancelled = runCancel(home, cwd, path, 123)
    expect(cancelled.status).not.toBe(0)
    expect(cancelled.stderr).toMatch(/names PR 999, not PR 123/)
  }, 20000)
})

// --- task-run-v1 15, O8: --resume accepts a moved head once a ruling exists ---

/** Same as `writeFakeGit`, except `ls-remote` answers a NEW head sha once `$HOME/.fix-pushed-after-pause` exists — the developer pushing a fix while this loop was paused, out of band, before `--resume` ever runs. */
function writeFakeGitHeadMovesAfterPause(dir: string): void {
  writeFakeBinary(
    dir,
    'git',
    `#!/bin/sh
if [ "$1" = "ls-remote" ]; then
  if [ -f "$HOME/.fake-dev-invoked" ]; then
    if [ -f "$HOME/.fix-pushed-after-pause" ]; then
      echo "${'f'.repeat(40)}	refs/heads/${BRANCH}"
    else
      echo "${HEAD_SHA}	refs/heads/${BRANCH}"
    fi
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

function setUpPauseResumeHeadMoves(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudePauseThenResumeScenario(binDir)
  writeFakeGh(binDir)
  writeFakeGitHeadMovesAfterPause(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — O8 (task-run-v1 task 15): --resume accepts a moved head after a ruling', () => {
  it('never refuses a moved head once a ruling exists — dispatches reviewers directly (no re-dispatched developer) and publishes', () => {
    const { home, cwd, path } = setUpPauseResumeHeadMoves()

    const paused = runLoop(home, cwd, path)
    expect(paused.status).not.toBe(0)
    expect(paused.stdout).toMatch(/paused \(escalation\)/)

    // Seed a Principal ruling, THEN simulate the developer pushing a fix
    // out of band, before --resume ever runs — "a ruling followed by a fix
    // push," the exact normal case O8 names.
    writeFileSync(
      join(home, '.fake-gh-posted-comments', 'comment-2.md'),
      `<!-- aeg:principal:ruling:${TASK}-1 -->\nGo ahead and fix it.\n`
    )
    writeFileSync(join(home, '.fix-pushed-after-pause'), '')

    const resumed = runResume(home, cwd, path, 123)
    expect(resumed.status).toBe(0)
    expect(resumed.stdout).toMatch(/publish/)

    // No developer re-dispatch on the resumed run — dev-prompts.txt carries
    // only round 1's original brief prompt (written before the pause),
    // never a "Principal ruling on this pause" entry, which only the
    // SAME-head resume path (the sibling describe block above) ever writes.
    const devPromptsPath = join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'dev-prompts.txt')
    if (existsSync(devPromptsPath)) {
      expect(readFileSync(devPromptsPath, 'utf8')).not.toMatch(/Principal ruling on this pause/)
    }
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

    // O11 (task-run-v1 21, #541, round 2 review MAJOR): the round-findings
    // resume prompt names the task/branch/worktree/head context AND the
    // exact command expected — not just "push fixes" in prose.
    expect(round2Prompt).toMatch(new RegExp(`^Resuming task Issue #${TASK}\\.$`, 'm'))
    expect(round2Prompt).toMatch(new RegExp(`^Branch: \`${BRANCH}\`$`, 'm'))
    expect(round2Prompt).toMatch(/^Worktree: `.*\.worktrees\//m)
    expect(round2Prompt).toMatch(/^Remote head: [0-9a-f]{40}$/m)
    expect(round2Prompt).toMatch(/`git push`/)

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

    // The round's real BLOCKER survives into the
    // durable `verdicts_read` event's own `findings` array — not just the
    // rendered comment — carrying its real, uncapped severity, which scale
    // it's read against, and that it counted as blocking under this repo's
    // default policy (BLOCKER threshold).
    const round1VerdictsRead = outboxLines(home).find(
      (l) => l.kind === 'dev_review_loop' && l.event === 'verdicts_read' && (l as { round: number }).round === 1
    ) as { findings: Array<Record<string, unknown>> } | undefined
    expect(round1VerdictsRead?.findings).toEqual([
      { id: 'F1', severity: 'BLOCKER', severity_scale: 'code-review', policy_treatment: 'blocking' }
    ])

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
    printf 'BRIEF_CONFORMANCE: yes\\nSPEC_CONFORMANCE: yes\\nSCOPE: small\\nTESTS: pass\\nDOCS: n/a\\nFINDING_IDS: F1\\n' > "$WD/report.txt"
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

    // The driver now also posts a round marker comment for
    // each of the two rounds before their findings are even compared — the
    // pause comment is the LAST one posted, not necessarily `comment-1.md`.
    const postedFiles = postedCommentFiles(home)
    const pauseComment = readFileSync(
      join(home, '.fake-gh-posted-comments', postedFiles[postedFiles.length - 1] as string),
      'utf8'
    )
    expect(pauseComment).toMatch(/^<!-- aeg:loop:paused:no_progress -->$/m)
    // O1 ([task-log-v1] 9, Issue #631): `assessRound`'s own generic
    // `'no_progress'` decision (two consecutive rounds resolving no finding)
    // carries no `detail` at all — the driver narrates it from the round's
    // own `findings_compared` event, so the comment alone states what
    // the driver observed, not just the bare reason name.
    expect(pauseComment).toContain('no finding was marked resolved this round')
    expect(pauseComment).toContain('two consecutive rounds with no forward motion')

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

  // O2 ([task-log-v1] 9, Issue #631): the SAME pause, but with a configured
  // `logPublish` target so the driver's own final flush actually attempts a
  // forge post — `writeFakeGh` (the default stub every scenario above this
  // one uses) deliberately fails every `gh issue comment` call, exactly the
  // shape a real round-end flush failure takes. Before this task the flush
  // ran AFTER the comment was already posted, so a failure here reached
  // only stderr; now it is flushed first, and a failure is folded into the
  // pause's own `detail`.
  it('a final flush that fails before this pause is folded into the posted detail, never only reaching stderr', () => {
    const { home, cwd, path } = setUpNoProgress()
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify({ logPublish: { issue: TASK + 1 } }))
    const r = runLoop(home, cwd, path)
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/paused \(no_progress\)/)

    const postedFiles = postedCommentFiles(home)
    const pauseComment = readFileSync(
      join(home, '.fake-gh-posted-comments', postedFiles[postedFiles.length - 1] as string),
      'utf8'
    )
    expect(pauseComment).toContain('the final outbox flush before this pause failed')

    const pauseState = JSON.parse(
      readFileSync(join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'pause-state.json'), 'utf8')
    ) as Record<string, unknown>
    expect(pauseState.detail).toContain('the final outbox flush before this pause failed')
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

    // Two comments: the round marker (posted before either
    // reviewer even dispatches) and the pause. Never a verdict.
    const pausedFiles = postedCommentFiles(home)
    expect(pausedFiles).toHaveLength(2)
    const pauseComment = readFileSync(join(home, '.fake-gh-posted-comments', pausedFiles[1] as string), 'utf8')
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

/**
 * Same as `writeFakeGh`, except the mechanical check-run named `ci` answers
 * with TWO runs: an older `failure`, superseded by a newer `success` — the
 * exact shape PR #600 hit (`driver-lifecycle-v1` task 2, `#607`, O1). If the
 * driver's pause decision reads only the deduped, newest-per-name run, the
 * gate reads green off this alone; a regression that fell back to reading
 * the raw (undeduped) list would read this head as red and never reach round
 * 1's reviewer dispatch at all.
 */
function writeFakeGhSupersededCiFailure(dir: string): void {
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
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "labels" ]; then
  printf '%s\n' '{"labels":[{"name":"vinaya/tranche:x"}]}'
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
  printf '%s\\n' '{"id":1,"name":"ci","status":"completed","conclusion":"failure","started_at":"2026-09-14T10:00:00Z"}'
  printf '%s\\n' '{"id":2,"name":"ci","status":"completed","conclusion":"success","started_at":"2026-09-14T10:05:00Z"}'
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

function setUpSupersededCiFailure(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudeReviewerWritesNothingScenario(binDir)
  writeFakeGhSupersededCiFailure(binDir)
  writeFakeGit(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — a superseded check-run failure never pauses a healthy PR (driver-lifecycle-v1 task 2, #607, O1)', () => {
  it('reads the gate green off the newer, deduped run and reaches round 1 reviewer dispatch — never a CI-red retry', () => {
    const { home, cwd, path } = setUpSupersededCiFailure()
    const r = runLoop(home, cwd, path)
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/paused \(infrastructure\)/)

    // The gate never read red: round 1's developer is dispatched exactly
    // once — there is no second, CI-red-retry dev-prompt file — and the
    // eventual pause is the reviewer-infrastructure case (security wrote
    // nothing), never the gate-red case. A regression that fell back to the
    // raw, undeduped check-run list would instead resume the developer with
    // a "CI is red" prompt and never reach this point.
    expect(existsSync(join(home, '.dev-prompt-2.txt'))).toBe(false)

    const pauseState = JSON.parse(
      readFileSync(join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'pause-state.json'), 'utf8')
    ) as Record<string, unknown>
    expect(pauseState.round).toBe(1)
    expect(pauseState.reason).toBe('infrastructure')
    expect(pauseState.detail).toMatch(/security/)
    expect(pauseState.detail).not.toMatch(/failing check-run/)
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
    printf 'this is not a valid finding line at all, token=ghp_abcdefghijklmnopqrstuvwxyz012345\\n' > "$WD/findings.txt"
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

    // Two comments: the round marker and the pause.
    const pausedFiles = postedCommentFiles(home)
    expect(pausedFiles).toHaveLength(2)
    const pauseComment = readFileSync(join(home, '.fake-gh-posted-comments', pausedFiles[1] as string), 'utf8')
    expect(pauseComment).toMatch(/^<!-- aeg:loop:paused:infrastructure -->$/m)
    // Names the file, the line (inside the parse error's own message), and
    // the reviewer's session id — O6's three required facts.
    expect(pauseComment).toMatch(/findings\.txt/)
    expect(pauseComment).toMatch(/line 1/)
    expect(pauseComment).toMatch(/sec-session-garbage/)
    expect(pauseComment).not.toMatch(/^VERDICT:/m)

    // This pause reaches `postPauseComment` from `ReviewerReportParseFailure`'s
    // own message, never from the outer crash catch — a distinct call site
    // that must sanitize too. The garbage line above embeds a
    // credential-shaped token; it must never reach the PUBLIC pause comment
    // un-redacted, even though it DOES reach the reviewer's own retry prompt
    // and the machine-local pause-state.json.
    expect(pauseComment).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345')
    expect(pauseComment).toContain('<redacted>')

    // An invalid report is a failure observation,
    // never something indistinguishable from a clean round: no `verdicts_read`
    // was ever logged for this round (the throw happened before `assessRound`
    // saw a `verdicts` observation), but a `role_attempt` line names the
    // security role's own failed attempt explicitly.
    const events = outboxLines(home)
    expect(events.some((e) => e.event === 'verdicts_read')).toBe(false)
    // `dispatchRole`'s own per-attempt `role_attempt` lines (developer,
    // both reviewer attempts) are ALSO present now
    // — this is the additional one dev-review-loop.ts logs for the
    // security role's own invalid report, distinguished by its outcome.
    const failureAttempt = events.find((e) => e.kind === 'role_attempt' && e.outcome === 'incomplete') as
      | { effect_id: string; duration_ms: number }
      | undefined
    expect(failureAttempt).toMatchObject({ actor: 'security', outcome: 'incomplete', usage: null })

    // Round 2 review, MAJOR (fixed): this failure's own `effect_id` must be
    // the SAME id the failing security attempt's own `dispatch` line(s)
    // carry — never a freshly minted, unjoinable one — and its `duration_ms`
    // must be that one attempt's own duration, not the whole round's.
    const securityDispatchOutcomeLines = events.filter(
      (e) =>
        e.kind === 'dispatch' && (e as { target_role?: string }).target_role === 'security' && e.event !== 'dispatched'
    ) as Array<{ effect_id: string; duration_ms: number }>
    const matching = securityDispatchOutcomeLines.find((l) => l.effect_id === failureAttempt?.effect_id)
    expect(matching).toBeDefined()
    expect(failureAttempt?.duration_ms).toBe(matching?.duration_ms)
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

    // Two comments: the round marker and the pause.
    const pausedFiles = postedCommentFiles(home)
    expect(pausedFiles).toHaveLength(2)
    const pauseComment = readFileSync(join(home, '.fake-gh-posted-comments', pausedFiles[1] as string), 'utf8')
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
    // A reviewer never declines an objective — NOT MET is a
    // verified fact, and an out-of-lens objective is MET, never NOT MET with
    // an out-of-scope note.
    expect(reviewerPrompt).toMatch(/NOT MET means you verified the objective is not met — never a decline/)
    expect(reviewerPrompt).toMatch(/never NOT MET with an out-of-scope note/)

    const invocations = readFileSync(join(home, '.security-invocations'), 'utf8').trim().split('\n').filter(Boolean)
    expect(invocations).toHaveLength(2)

    // index 1: index 0 is the round marker comment the
    // driver now posts before either reviewer dispatches.
    const pausedFiles = postedCommentFiles(home)
    const pauseComment = readFileSync(join(home, '.fake-gh-posted-comments', pausedFiles[1] as string), 'utf8')
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
PROMPT="$(cat)"
touch "$HOME/.fake-dev-invoked" 2>/dev/null
N=$(ls "$HOME"/.dev-prompt-*.txt 2>/dev/null | wc -l | tr -d ' ')
printf '%s' "$PROMPT" > "$HOME/.dev-prompt-$((N + 1)).txt"
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
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "labels" ]; then
  printf '%s\n' '{"labels":[{"name":"vinaya/tranche:x"}]}'
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

/**
 * Same as `writeFakeGhAlwaysRedCi`, plus `pr view --json body` (O5, `#595`)
 * — `--resume`'s very first read (`fetchPrBody`, to derive the task from
 * `Closes #N`) has no answer in the plain fixture, which never resumes.
 */
function writeFakeGhAlwaysRedCiResumable(dir: string): void {
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
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "labels" ]; then
  printf '%s\n' '{"labels":[{"name":"vinaya/tranche:x"}]}'
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
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "body" ]; then
  printf '%s\\n' '{"body":"Closes #${TASK}"}'
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

function setUpNeverPushesResumable(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudeNeverPushes(binDir)
  writeFakeGhAlwaysRedCiResumable(binDir)
  writeFakeGit(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
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

    // O3 (`driver-lifecycle-v1` task 2, `#607`): the pause detail names the
    // exact run the pause was built from (its id), not just the check name
    // — the evidence behind the pause is auditable after the fact.
    expect(pauseComment).toMatch(/Vinaya CI \(run 1\)/)

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
    expect(pauseState.detail).toMatch(/Vinaya CI \(run 1\)/)

    // O11 (task-run-v1 21, #541): the gate-red retry prompt — round 1's own
    // fresh dispatch is `.dev-prompt-1.txt`; every dispatch after it is a
    // resume, and each one names the task/branch/worktree/head plus the
    // exact command to run, not just "fix and push".
    const gateRedPrompt = readFileSync(join(home, '.dev-prompt-2.txt'), 'utf8')
    expect(gateRedPrompt).toMatch(new RegExp(`^Resuming task Issue #${TASK}\\.$`, 'm'))
    expect(gateRedPrompt).toMatch(new RegExp(`^Branch: \`${BRANCH}\`$`, 'm'))
    expect(gateRedPrompt).toMatch(new RegExp(`^Worktree: \`.*\\.worktrees/${BRANCH}\`$`, 'm'))
    expect(gateRedPrompt).toMatch(/^Remote head: [0-9a-f]{40}$/m)
    expect(gateRedPrompt).toMatch(/CI is red on the last head/)
    expect(gateRedPrompt).toMatch(/`git push`/)
  }, 20000)
})

// --- control-store-v1 task 4 (#554): the loop recovers budgets and held
// results from control state, not from optional event history -------------

function controlStoreLoopStatePath(home: string): string {
  return join(home, '.vinaya', 'control-store', String(TASK), 'loop-state.json')
}

function writeControlStoreLoopState(home: string, record: Record<string, unknown>): void {
  const path = controlStoreLoopStatePath(home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(record), 'utf8')
}

describe('devReviewLoop — control-store-v1 task 4 (#554, O2): mechanical-retry budgets survive a restart, never reset', () => {
  it('a fresh process seeded with a prior stall count from the control store pauses after one fewer turn than a genuinely fresh one would', () => {
    const { home, cwd, path } = setUpNeverPushes()

    // Simulates a driver that stalled once, then died (a kill, a crash) —
    // the control-store record a REAL in-flight process would already have
    // written the instant it incremented `gateStalledStreak`
    // (`persistCurrentLoopState`, called right there, never only once a
    // pause eventually fires).
    writeControlStoreLoopState(home, {
      version: 1,
      kind: 'loop_state',
      task: TASK,
      round: 1,
      phase: 'dispatch_developer',
      pauseReason: null,
      budgets: { mechanicalRetries: 1, reviewRounds: 1, infrastructureRetries: 0 },
      heldResult: null,
      deliveredFindings: null,
      recordedAt: new Date().toISOString()
    })

    const r = runDevReviewLoopArgs(home, cwd, path, ['--task', String(TASK), '--agent', 'claude'], {
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_MAX_ATTEMPTS: '2',
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_INTERVAL_MS: '10'
    })
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/paused \(infrastructure\)/)

    // A genuinely fresh process needs THREE developer turns before this
    // bound (round 1's own entry, then two stalled retries —
    // `MAX_GATE_STALLED_TURNS`). Seeded at 1 already, this run needed only
    // ONE retry after its own entry turn — the seed carried over rather
    // than resetting to 0.
    const prompts = readdirSync(home).filter((f) => /^\.dev-prompt-\d+\.txt$/.test(f))
    expect(prompts).toHaveLength(2)

    const persisted = JSON.parse(readFileSync(controlStoreLoopStatePath(home), 'utf8')) as {
      phase: string
      pauseReason: string
      budgets: { mechanicalRetries: number; infrastructureRetries: number }
    }
    expect(persisted.budgets.mechanicalRetries).toBe(2)
    expect(persisted.budgets.infrastructureRetries).toBe(1)
    expect(persisted.phase).toBe('pause')
    expect(persisted.pauseReason).toBe('infrastructure')
  }, 20000)
})

describe('devReviewLoop — control-store-v1 task 4 (#554, O3): a delivered-findings identity in the control store prevents a second redelivery, even with no local marker file', () => {
  it('reads as no_progress and dispatches nobody, purely from the control-store record — the local round-<k>-attach-redelivered marker never exists in this fixture', () => {
    const { home, cwd, path } = setUpAttachRecoversHeldRound()

    const heldDir = join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK))
    mkdirSync(heldDir, { recursive: true })
    writeFileSync(
      join(heldDir, 'round-1-reviewer.md'),
      `VERDICT: REQUEST CHANGES\n\nJudged head: ${HEAD_SHA}\n\nStill there.\n`
    )
    writeFileSync(join(heldDir, 'round-1-security.md'), `VERDICT: FAIL\n\nJudged head: ${HEAD_SHA}\n\nStill there.\n`)

    // No `round-1-attach-redelivered` marker on disk — this machine's local
    // side file is exactly what a different host, or a cleaned outbox,
    // would be missing. The control store alone carries the fact that
    // round 1's findings were already delivered on this exact head.
    writeControlStoreLoopState(home, {
      version: 1,
      kind: 'loop_state',
      task: TASK,
      round: 1,
      phase: 'dispatch_developer',
      pauseReason: null,
      budgets: { mechanicalRetries: 0, reviewRounds: 1, infrastructureRetries: 0 },
      heldResult: { round: 1, head: HEAD_SHA },
      deliveredFindings: { round: 1, head: HEAD_SHA },
      recordedAt: new Date().toISOString()
    })

    const r = runLoop(home, cwd, path)
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/paused \(no_progress\)/)

    expect(existsSync(join(home, '.dev-invocations'))).toBe(false)
    expect(existsSync(join(heldDir, 'round-2-reviewer-work'))).toBe(false)
    expect(existsSync(join(heldDir, 'round-2-security-work'))).toBe(false)
    expect(
      existsSync(join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'round-1-attach-redelivered'))
    ).toBe(false)

    // O3 ([task-log-v1] 9, Issue #631): the mirror of the sibling fixture
    // above — here the CONTROL STORE is what actually held, and the local
    // marker never existed, so the comment must name it the other way
    // around.
    const postedFiles = postedCommentFiles(home)
    const pauseComment = readFileSync(
      join(home, '.fake-gh-posted-comments', postedFiles[postedFiles.length - 1] as string),
      'utf8'
    )
    expect(pauseComment).toContain('local marker file absent')
    expect(pauseComment).toContain('control-store delivered-findings identity matched')
  }, 20000)
})

describe('devReviewLoop — control-store-v1 task 4 (#554, O1/O3): round numbering recovers from the control store alone when both the local held files AND the forge-flushed journal are missing', () => {
  it('dispatches round 2 directly with neither a held-verdict file nor any outbox/forge event history to reconstruct it from', () => {
    const { home, cwd, path } = setUpAttachRecoversHeldRound()

    // Deliberately nothing else: no `round-1-reviewer.md`/`round-1-security.md`
    // (the local held-verdict recovery this task's own O1 says recovery must
    // stop depending on alone), and no outbox NDJSON / forge-flushed
    // `dev_review_loop` comments either (`writeFakeGhAttach`'s own `pr view
    // --json comments` replays only what this run itself posts, starting
    // empty) — the task's optional event history is entirely absent. Only
    // the control store's own round-2 record survives.
    writeControlStoreLoopState(home, {
      version: 1,
      kind: 'loop_state',
      task: TASK,
      round: 2,
      phase: 'dispatch_reviewers',
      pauseReason: null,
      budgets: { mechanicalRetries: 0, reviewRounds: 2, infrastructureRetries: 0 },
      heldResult: null,
      deliveredFindings: { round: 1, head: HEAD_SHA },
      recordedAt: new Date().toISOString()
    })

    const worktreeDir = join(cwd, '.worktrees', BRANCH)
    mkdirSync(worktreeDir, { recursive: true })
    writeFileSync(join(worktreeDir, '.vinaya-confidence'), 'CONFIDENCE: 90 — recovered from control state\n')

    const r = runLoop(home, cwd, path)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/publish/)

    // Reviewers ran at round 2 — never a reset to round 1 for want of the
    // held files or the journal this task's optional telemetry would
    // otherwise have supplied.
    const heldDir = join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK))
    expect(existsSync(join(heldDir, 'round-2-reviewer-work'))).toBe(true)
    expect(existsSync(join(heldDir, 'round-2-security-work'))).toBe(true)
    expect(existsSync(join(heldDir, 'round-1-reviewer-work'))).toBe(false)
    expect(existsSync(join(home, '.dev-invocations'))).toBe(false)
  }, 20000)
})

describe('devReviewLoop — control-store-v1 task 4 (#554, round 2 review, BLOCKER): a corrupt loop-state record decides a pause, never an uncaught crash', () => {
  it('exits non-zero with a decided infrastructure pause, dispatching no developer at all', () => {
    // Reuses `setUpStopBeforePush`'s own `gh`/`git` fixture — it answers `pr
    // list` with none open (this scenario's own `prNumber` sentinel, `-1`,
    // never resolves before the corrupt check fires) and its `gh issue
    // comment` actually succeeds, unlike the plain `writeFakeGh` most other
    // fixtures use (which deliberately refuses issue comments as "log flush
    // not under test" — `postMarkedComment`'s own hard-refusal-with-
    // `process.exit` on that failure would otherwise mask the very
    // assertion this test exists to make). The developer fake it wires
    // (`writeFakeClaudeNoPushEver`) is never invoked here: the corrupt
    // record is refused before the frozen-brief fetch or any dispatch.
    const { home, cwd, path } = setUpStopBeforePush()

    // Torn JSON — `readLoopState`/`parseLoopStateRecord` read this as
    // `'corrupt'`, never `'absent'`. Before the fix, the resulting throw sat
    // BEFORE `devReviewLoop`'s own `try` block even started, so it escaped
    // as an unhandled rejection instead of reaching the outer `catch` that
    // decides every other setup failure on this path.
    const loopStatePath = controlStoreLoopStatePath(home)
    mkdirSync(dirname(loopStatePath), { recursive: true })
    writeFileSync(loopStatePath, '{"version":1,"kind":"loop_state"', 'utf8')

    const r = runLoop(home, cwd, path)

    // A decided pause, not a crash: a real uncaught exception would print a
    // stack trace and/or an "unhandled" message, never this driver's own
    // `paused (<reason>)` summary line.
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/paused \(infrastructure\)/)
    expect(r.stdout).not.toMatch(/unhandled|Unhandled/)

    // No developer ever dispatched — the corrupt record is refused before
    // any real work starts, and before the frozen brief is ever fetched.
    expect(existsSync(join(home, '.dev-invocations'))).toBe(false)
    expect(existsSync(join(home, '.fake-dev-invoked'))).toBe(false)

    // A real pause comment landed on the task Issue (no PR exists yet) —
    // the corrupt-record throw reached the SAME pause bookkeeping every
    // other setup failure on this path does, not a silent, comment-less exit.
    const posted = postedCommentFiles(home)
    const pauseFiles = posted.filter((f) =>
      readFileSync(join(home, '.fake-gh-posted-comments', f), 'utf8').includes('aeg:loop:paused:infrastructure')
    )
    expect(pauseFiles).toHaveLength(1)
    const body = readFileSync(join(home, '.fake-gh-posted-comments', pauseFiles[0] as string), 'utf8')
    expect(body).toMatch(/control-store loop-state record is corrupt/)
  }, 20000)
})

describe('devReviewLoop — control-store-v1 task 4 (round 3 review, BLOCKER): a real filesystem read fault on loop-state.json decides a pause too, never an uncaught crash', () => {
  it('exits non-zero with a decided infrastructure pause, dispatching no developer at all', () => {
    const { home, cwd, path } = setUpStopBeforePush()

    // The loop-state record's own path is itself a directory, not a file —
    // `readFileSync` throws `EISDIR`, a real fs fault distinct from the
    // torn-JSON case above (something readable but unparseable) and from
    // `ENOENT` (never written). Before the fix, `readIfExists`
    // (`packages/aeg-core/src/control-store/local.ts`) rethrew this raw, and
    // nothing between it and `recoverLoopState` caught it — the exact
    // "escapes uncaught instead of a decided pause" failure class the
    // BLOCKER test above already covers for malformed JSON, reopened here
    // through a different trigger (permission denied, an unreadable special
    // file, an EIO would all take the same path in production).
    const loopStatePath = controlStoreLoopStatePath(home)
    mkdirSync(loopStatePath, { recursive: true })

    const r = runLoop(home, cwd, path)

    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/paused \(infrastructure\)/)
    expect(r.stdout).not.toMatch(/unhandled|Unhandled/)
    expect(existsSync(join(home, '.dev-invocations'))).toBe(false)
    expect(existsSync(join(home, '.fake-dev-invoked'))).toBe(false)

    const posted = postedCommentFiles(home)
    const pauseFiles = posted.filter((f) =>
      readFileSync(join(home, '.fake-gh-posted-comments', f), 'utf8').includes('aeg:loop:paused:infrastructure')
    )
    expect(pauseFiles).toHaveLength(1)
    const body = readFileSync(join(home, '.fake-gh-posted-comments', pauseFiles[0] as string), 'utf8')
    expect(body).toMatch(/control-store loop-state record is corrupt/)
  }, 20000)
})

describe('devReviewLoop — control-store-v1 task 4 (round 2 review, security HIGH): refusing a corrupt loop-state record never self-heals its infrastructure-retry count to zero', () => {
  it('persists MAX_INFRASTRUCTURE_RETRIES, not 0, to both the control store and the pause-state file', () => {
    const { home, cwd, path } = setUpStopBeforePush()

    // Same torn-JSON fixture as the BLOCKER test above — `recoverLoopState`
    // reads this as `'corrupt'`, and the refusal thrown inside the `try`
    // block is caught by the outer catch, which persists whatever
    // `infrastructureRetries` this process is holding at that moment.
    const loopStatePath = controlStoreLoopStatePath(home)
    mkdirSync(dirname(loopStatePath), { recursive: true })
    writeFileSync(loopStatePath, '{"version":1,"kind":"loop_state"', 'utf8')

    const r = runLoop(home, cwd, path)
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/paused \(infrastructure\)/)

    // Before the fix, the fresh-start seed read `'corrupt'` as `0` — the
    // same default `'absent'` gets — so refusing an untrustworthy record
    // immediately overwrote it with a clean, zeroed one: a corrupted record
    // "healed" itself to a low count on the very next attach, discarding
    // whatever real count it carried instead of preserving the conservative
    // treatment `--resume`'s own corrupt handling already applies. The
    // outer catch's own `infrastructureRetries += 1` (every infrastructure
    // pause counts itself) lands on top of the `MAX_INFRASTRUCTURE_RETRIES`
    // seed, so the persisted value is AT LEAST the bound, never exactly `0`.
    const persisted = JSON.parse(readFileSync(loopStatePath, 'utf8')) as {
      budgets: { infrastructureRetries: number }
    }
    expect(persisted.budgets.infrastructureRetries).toBeGreaterThanOrEqual(MAX_INFRASTRUCTURE_RETRIES)

    const pauseState = JSON.parse(
      readFileSync(join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'pause-state.json'), 'utf8')
    ) as { infrastructureRetries: number }
    expect(pauseState.infrastructureRetries).toBeGreaterThanOrEqual(MAX_INFRASTRUCTURE_RETRIES)
  }, 20000)
})

describe('devReviewLoop — control-store-v1 task 4 (round 2 review, security HIGH): --resume floors its infrastructure-retry bound against the pause-state file, not the control store alone', () => {
  it('refuses a bare-command resume once the pause-state file alone already reflects the bound, even with the control-store record absent', () => {
    const { home, cwd, path } = setUpNeverPushesResumable()
    const paused = runDevReviewLoopArgs(home, cwd, path, ['--task', String(TASK), '--agent', 'claude'], {
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_MAX_ATTEMPTS: '2',
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_INTERVAL_MS: '10',
      VINAYA_DEV_REVIEW_LOOP_GH_RETRY_BACKOFF_MS: '1'
    })
    expect(paused.status).not.toBe(0)
    expect(paused.stdout).toMatch(/paused \(infrastructure\)/)

    // Simulates a `persistLoopState` write that has been silently failing
    // for this task's whole life (an unwritable control-store directory, a
    // hand-cleaned one) while `writePauseState`'s own plain `writeFileSync`
    // — a different write path — kept landing: the control store reads
    // `'absent'`, but the pause-state file alone already carries a count at
    // the bound.
    const pauseStatePath = join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'pause-state.json')
    const pauseState = JSON.parse(readFileSync(pauseStatePath, 'utf8')) as Record<string, unknown>
    pauseState.infrastructureRetries = MAX_INFRASTRUCTURE_RETRIES
    writeFileSync(pauseStatePath, JSON.stringify(pauseState), 'utf8')
    rmSync(controlStoreLoopStatePath(home), { force: true })

    // Before the fix, `infrastructureRetriesSoFar` came from the
    // control-store read alone: `'absent'` read as `0`, well under the
    // bound, so this resumed on the bare command exactly like the O5 test
    // above, with `bareInfrastructureResume` true and `d.fetchRulings`
    // never even called — exactly the silently-reset-to-a-clean-slate hole
    // the security finding named. With the fix, the pause-state floor pins
    // `infrastructureRetriesSoFar` at the bound, `bareInfrastructureResume`
    // is false, and the code takes the "fetch rulings for real" branch —
    // this fixture (built for the never-a-real-PR bare-resume case) answers
    // that particular `gh pr view <n> --json comments` call with nothing
    // wired, so the resume fails fetching rulings rather than finding zero
    // of them; either failure proves the SAME thing this test asserts: the
    // bare-command path was refused.
    const resumed = runDevReviewLoopArgs(home, cwd, path, ['--resume', '123', '--agent', 'claude'], {
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_MAX_ATTEMPTS: '2',
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_INTERVAL_MS: '10',
      VINAYA_DEV_REVIEW_LOOP_GH_RETRY_BACKOFF_MS: '1'
    })
    expect(resumed.status).not.toBe(0)
    expect(resumed.stdout).not.toMatch(/paused \(infrastructure\)/)
    expect(resumed.stderr).toMatch(/fetchRulings/)
  }, 30000)
})

describe('devReviewLoop — control-store-v1 task 4 (round 3 review, MAJOR): a resumed process floors its own in-memory infrastructure-retry count against pause-state.json too', () => {
  it('never regresses the persisted count after a further pause, even with the control-store record absent going in', () => {
    const { home, cwd, path } = setUpNeverPushesResumable()
    const paused = runDevReviewLoopArgs(home, cwd, path, ['--task', String(TASK), '--agent', 'claude'], {
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_MAX_ATTEMPTS: '2',
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_INTERVAL_MS: '10',
      VINAYA_DEV_REVIEW_LOOP_GH_RETRY_BACKOFF_MS: '1'
    })
    expect(paused.status).not.toBe(0)
    expect(paused.stdout).toMatch(/paused \(infrastructure\)/)

    // Simulates a `persistLoopState` write that has been silently failing
    // since well before this resume: the control-store record is gone
    // entirely, while `pause-state.json` — a different, simpler write path —
    // already carries a real prior count of `3`, still comfortably under
    // `MAX_INFRASTRUCTURE_RETRIES` (`5`), so the resume GATE check
    // (`infrastructureRetriesSoFar`, already floored against this same file
    // since the security-HIGH fix) grants the bare-command resume cleanly —
    // this test is entirely about what happens to the IN-PROCESS seed once
    // that resumed process actually starts running, not about the gate.
    const pauseStatePath = join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'pause-state.json')
    const pauseState = JSON.parse(readFileSync(pauseStatePath, 'utf8')) as Record<string, unknown>
    pauseState.infrastructureRetries = 3
    writeFileSync(pauseStatePath, JSON.stringify(pauseState), 'utf8')
    rmSync(controlStoreLoopStatePath(home), { force: true })

    // The SAME always-red CI stalls this resumed process again — one more
    // genuine infrastructure pause, which persists whatever the in-process
    // `infrastructureRetries` variable was seeded at, plus one.
    const resumed = runDevReviewLoopArgs(home, cwd, path, ['--resume', '123', '--agent', 'claude'], {
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_MAX_ATTEMPTS: '2',
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_INTERVAL_MS: '10',
      VINAYA_DEV_REVIEW_LOOP_GH_RETRY_BACKOFF_MS: '1'
    })
    expect(resumed.status).not.toBe(0)
    expect(resumed.stdout).toMatch(/paused \(infrastructure\)/)

    // Before the fix, the in-process seed read the (now-absent)
    // control-store alone: `0`, incremented once by this pause, persisted as
    // `1` — silently regressing the true count from `3` down to `1`, even
    // though `pause-state.json` itself already said `3` going in. With the
    // fix, the seed floors against `resumeFrom.infrastructureRetries` (`3`),
    // so this pause can only ever advance it to `4` or more, never back down.
    const persisted = JSON.parse(readFileSync(controlStoreLoopStatePath(home), 'utf8')) as {
      budgets: { infrastructureRetries: number }
    }
    expect(persisted.budgets.infrastructureRetries).toBeGreaterThanOrEqual(4)

    const newPauseState = JSON.parse(readFileSync(pauseStatePath, 'utf8')) as { infrastructureRetries: number }
    expect(newPauseState.infrastructureRetries).toBeGreaterThanOrEqual(4)
  }, 30000)
})

/**
 * Same as `writeFakeGhAlwaysRedCi`, except the mechanical check-run named
 * `Vinaya CI` answers with TWO runs: an older `success`, superseded by a
 * newer `failure` (driver-lifecycle-v1 task 2, `#607`, O2 — the reverse of
 * the O1 fixture above). A genuinely failing CURRENT check must still pause
 * the loop exactly as a single failing run does — supersession only ever
 * suppresses a stale failure, never a live one.
 */
function writeFakeGhSupersededSuccessThenCurrentFailure(dir: string): void {
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
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "labels" ]; then
  printf '%s\n' '{"labels":[{"name":"vinaya/tranche:x"}]}'
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
  printf '%s\\n' '{"id":1,"name":"Vinaya CI","status":"completed","conclusion":"success","started_at":"2026-09-14T10:00:00Z"}'
  printf '%s\\n' '{"id":2,"name":"Vinaya CI","status":"completed","conclusion":"failure","started_at":"2026-09-14T10:05:00Z"}'
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

function setUpNeverPushesSupersededSuccessThenCurrentFailure(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudeNeverPushes(binDir)
  writeFakeGhSupersededSuccessThenCurrentFailure(binDir)
  writeFakeGit(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — a genuinely failing current check-run still pauses, even beside a superseded success (driver-lifecycle-v1 task 2, #607, O2)', () => {
  it('pauses with the same reason and detail shape as a single failing run, naming the CURRENT failing check', () => {
    const { home, cwd, path } = setUpNeverPushesSupersededSuccessThenCurrentFailure()
    const r = runDevReviewLoopArgs(home, cwd, path, ['--task', String(TASK), '--agent', 'claude'], {
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_MAX_ATTEMPTS: '2',
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_INTERVAL_MS: '10'
    })
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/paused \(infrastructure\)/)

    const pauseState = JSON.parse(
      readFileSync(join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'pause-state.json'), 'utf8')
    ) as Record<string, unknown>
    expect(pauseState.reason).toBe('infrastructure')
    expect(pauseState.detail).toMatch(/head .* unchanged/)
    // Same shape as the single-failing-run case above: the surviving,
    // CURRENT failure (run 2) is named — never the superseded success (run
    // 1), and never a bare check name with no run identity to audit it
    // against (O3, `#607`).
    expect(pauseState.detail).toMatch(/Vinaya CI \(run 2, started 2026-09-14T10:05:00Z\)/)
    expect(pauseState.detail).not.toMatch(/run 1/)

    const gateRedPrompt = readFileSync(join(home, '.dev-prompt-2.txt'), 'utf8')
    expect(gateRedPrompt).toMatch(/CI is red on the last head/)
    expect(gateRedPrompt).toMatch(/Vinaya CI \(run 2, started 2026-09-14T10:05:00Z\)/)
  }, 20000)
})

/**
 * O1 (`#595`): `token-report` is just one more mechanical check-run name —
 * the driver never special-cases it. A blank/dash-only token row fails it
 * exactly like any other red check, and the SAME gate-red-retry machinery
 * every other red-CI fixture in this file already exercises applies: one
 * developer resume, the driver stays alive, and once the row is fixed (the
 * marker file below stands in for "the developer re-ran `vinaya pr report`
 * and pushed") the round goes green and the loop runs to completion.
 */
function writeFakeClaudeTokenReportFix(dir: string): void {
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
    N=$(ls "$HOME"/.dev-prompt-*.txt 2>/dev/null | wc -l | tr -d ' ')
    N=$((N + 1))
    printf '%s' "$PROMPT" > "$HOME/.dev-prompt-$N.txt"
    if [ "$N" -ge 2 ]; then
      touch "$HOME/.token-report-fixed"
    fi
    echo '{"session_id":"dev-session-1","usage":{"input_tokens":10,"output_tokens":5}}'
    ;;
esac
exit 0
`
  )
}

/** Same as \`writeFakeGit\`, except \`ls-remote\` answers a NEW head once \`.token-report-fixed\` exists — the fixture's stand-in for "the developer fixed the row and pushed." */
function writeFakeGitTokenReportFix(dir: string): void {
  writeFakeBinary(
    dir,
    'git',
    `#!/bin/sh
if [ "$1" = "ls-remote" ]; then
  if [ -f "$HOME/.token-report-fixed" ]; then
    echo "${'c'.repeat(40)}	refs/heads/${BRANCH}"
  elif [ -f "$HOME/.fake-dev-invoked" ]; then
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

/** Same as \`writeFakeGh\`, except \`gh api …/check-runs\` answers \`token-report: failure\` until \`.token-report-fixed\` exists, then \`success\` — never the review gate's own name, and never any OTHER check name (isolating this one). */
function writeFakeGhTokenReportRedThenGreen(dir: string): void {
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
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "labels" ]; then
  printf '%s\n' '{"labels":[{"name":"vinaya/tranche:x"}]}'
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
  if [ -f "$HOME/.token-report-fixed" ]; then
    echo '{"id":1,"name":"token-report","status":"completed","conclusion":"success"}'
  else
    echo '{"id":1,"name":"token-report","status":"completed","conclusion":"failure"}'
  fi
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

function setUpTokenReportRedThenGreen(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudeTokenReportFix(binDir)
  writeFakeGhTokenReportRedThenGreen(binDir)
  writeFakeGitTokenReportFix(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — O1 (#595): a blank/dash-only token-report row never ends the driver', () => {
  it('yields one developer resume naming token-report, then a live driver that runs to publish once the row is fixed', () => {
    const { home, cwd, path } = setUpTokenReportRedThenGreen()
    const r = runDevReviewLoopArgs(home, cwd, path, ['--task', String(TASK), '--agent', 'claude'], {
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_MAX_ATTEMPTS: '20',
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_INTERVAL_MS: '10'
    })
    // A live driver that ran to completion — never a crash, never an exit
    // on the way there.
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/publish/)
    expect(r.stderr).not.toMatch(/Uncaught|TypeError|at Object\./)

    // Exactly one developer resume for the red gate: round 1's own fresh
    // dispatch is `.dev-prompt-1.txt`, and the ONE gate-red retry that
    // names the failing check is `.dev-prompt-2.txt` — never a third (the
    // fix lands on that very turn).
    expect(existsSync(join(home, '.dev-prompt-2.txt'))).toBe(true)
    expect(existsSync(join(home, '.dev-prompt-3.txt'))).toBe(false)
    const resumePrompt = readFileSync(join(home, '.dev-prompt-2.txt'), 'utf8')
    expect(resumePrompt).toMatch(/token-report/)
    expect(resumePrompt).toMatch(/`git push`/)

    // Never a pause of any kind — this run reaches a clean publish.
    expect(existsSync(join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'pause-state.json'))).toBe(false)
  }, 20000)
})

describe('devReviewLoop — O4 (#595): a re-exec child whose own first gate read is red stays alive and pauses, never exits', () => {
  it('the parent hands off mid-round-1, and the child — CI red on its own first read — ends bounded-paused, never crashed', () => {
    const home = tempDir('vinaya-drl-home-')
    const cwd = tempDir('vinaya-drl-cwd-')
    const binDir = tempDir('vinaya-drl-bin-')
    writeFakeClaudeBaseMovesAfterFirstTurn(binDir)
    writeFakeGhAlwaysRedCi(binDir)
    writeFakeGitBaseMovesWithSuccessfulPull(binDir)
    const path = `${binDir}:${pathWithoutRealVendors()}`

    const r = runDevReviewLoopArgs(home, cwd, path, ['--task', String(TASK), '--agent', 'claude'], {
      VINAYA_DEV_REVIEW_LOOP_PR_POLL_MAX_ATTEMPTS: '5',
      VINAYA_DEV_REVIEW_LOOP_PR_POLL_INTERVAL_MS: '5',
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_MAX_ATTEMPTS: '5',
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_INTERVAL_MS: '5'
    })

    // The re-exec (the parent's own hand-off) really happened.
    expect(existsSync(join(home, '.git-pull-called'))).toBe(true)

    // The CHILD process — the one that actually ends this run — is alive
    // and reached a DECIDED pause, never an uncaught crash: a real exit
    // code this harness itself set (`d.exitProcess`/the pause-return path),
    // never a bare stack trace, and never the parent's own re-exec exit
    // code masquerading as success.
    expect(r.status).not.toBe(0)
    expect(r.stderr).not.toMatch(/Uncaught|TypeError|ReferenceError|at Object\./)
    expect(r.stdout).toMatch(/paused \(infrastructure\)/)
    // Never `stale_driver` — the staleness was absorbed by the re-exec
    // itself; what pauses the CHILD is its own red gate, a different fact.
    expect(r.stdout).not.toMatch(/paused \(stale_driver\)/)

    const pauseState = JSON.parse(
      readFileSync(join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'pause-state.json'), 'utf8')
    ) as Record<string, unknown>
    expect(pauseState.reason).toBe('infrastructure')
  }, 30000)
})

describe('devReviewLoop — O5 (#595): an infrastructure pause resumes on the bare command, no Principal ruling needed', () => {
  it('--resume continues past an infrastructure pause with zero ruling comments ever posted', () => {
    const { home, cwd, path } = setUpNeverPushesResumable()
    const paused = runDevReviewLoopArgs(home, cwd, path, ['--task', String(TASK), '--agent', 'claude'], {
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_MAX_ATTEMPTS: '2',
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_INTERVAL_MS: '10',
      VINAYA_DEV_REVIEW_LOOP_GH_RETRY_BACKOFF_MS: '1'
    })
    expect(paused.status).not.toBe(0)
    expect(paused.stdout).toMatch(/paused \(infrastructure\)/)

    const pauseState = JSON.parse(
      readFileSync(join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'pause-state.json'), 'utf8')
    ) as Record<string, unknown>
    expect(pauseState.reason).toBe('infrastructure')

    // Every other pause reason requires a Principal ruling comment before
    // `--resume` will proceed at all (`devReviewLoop --resume: PR #<n>
    // carries no Principal ruling comment yet`) — this run posts NONE, ever,
    // and `--resume` must still continue rather than throw that error.
    expect(postedCommentFiles(home).length).toBeGreaterThan(0)
    for (const f of postedCommentFiles(home)) {
      expect(readFileSync(join(home, '.fake-gh-posted-comments', f), 'utf8')).not.toMatch(/aeg:principal:ruling/)
    }

    const resumed = runDevReviewLoopArgs(home, cwd, path, ['--resume', '123', '--agent', 'claude'], {
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_MAX_ATTEMPTS: '2',
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_INTERVAL_MS: '10',
      VINAYA_DEV_REVIEW_LOOP_GH_RETRY_BACKOFF_MS: '1'
    })
    expect(resumed.stderr).not.toMatch(/carries no Principal ruling comment yet/)
    // Still stuck on the exact same never-fixed red gate — resumes straight
    // back into the same bounded infrastructure pause, never a crash.
    expect(resumed.status).not.toBe(0)
    expect(resumed.stdout).toMatch(/paused \(infrastructure\)/)
  }, 30000)
})

/**
 * O4: CI itself reads green (`conclusion: success`) — the ONLY
 * reason the gate reads red here is the PR body's own `Premise:` pin, which
 * names a symbol `pinned.ts` no longer contains (the fixture's stand-in for
 * "the head deleted it"). Isolates the premise path from the plain
 * CI-red path the test above already covers.
 */
function writeFakeGhStalePremiseGreenCi(dir: string): void {
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
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "labels" ]; then
  printf '%s\n' '{"labels":[{"name":"vinaya/tranche:x"}]}'
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
  printf '%s\\n' '{"body":"**Premise:**\\n- pinned.ts contains: OLD_SYMBOL\\n\\nCloses #${TASK}"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "mergeable" ]; then
  echo '{"mergeable":"MERGEABLE"}'
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

function setUpStalePremise(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudeNeverPushes(binDir)
  writeFakeGhStalePremiseGreenCi(binDir)
  writeFakeGit(binDir)
  // The premise's own pin target — `reassertPrBodyPremise`'s default file
  // reader resolves paths relative to `process.cwd()` (the driver's real
  // cwd, `cwd` here), no git needed (this dir is deliberately non-git, same
  // as `setUp`'s own). Never contains `OLD_SYMBOL` — the fixture's stand-in
  // for "the head deleted it since the brief was authored."
  writeFileSync(join(cwd, 'pinned.ts'), 'export const CURRENT_SYMBOL = 1\n')
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — a stale Premise pin pauses like a red gate, never a driver exit (O4)', () => {
  it('produces one developer resume naming the failing premise line, then the SAME bounded infrastructure pause — never an uncaught exit', () => {
    const { home, cwd, path } = setUpStalePremise()
    const r = runDevReviewLoopArgs(home, cwd, path, ['--task', String(TASK), '--agent', 'claude'], {
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_MAX_ATTEMPTS: '2',
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_INTERVAL_MS: '10'
    })
    // A clean, decided pause — never an uncaught crash. `not.toBe(0)` is the
    // SAME non-zero a clean pause always exits with (a pause is not success),
    // distinguished from a genuine crash by everything below: a real
    // `paused (infrastructure)` decision, a real pause-state file, a real
    // marked PR comment — none of which a raw uncaught exception leaves
    // behind coherently.
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/paused \(infrastructure\)/)

    // The developer's SECOND turn (the first resume — round 1's own fresh
    // push-and-open dispatch is `.dev-prompt-1.txt`) is where the premise
    // failure first reaches it: one resume, naming the exact failing line,
    // never a bare "CI is red" with nothing underneath.
    const premisePrompt = readFileSync(join(home, '.dev-prompt-2.txt'), 'utf8')
    expect(premisePrompt).toMatch(/CI is red on the last head/)
    expect(premisePrompt).toMatch(/dispatch-gate premise:/)
    expect(premisePrompt).toMatch(/pinned\.ts/)
    expect(premisePrompt).toMatch(/OLD_SYMBOL/)
    expect(premisePrompt).toMatch(/`git push`/)

    const pauseState = JSON.parse(
      readFileSync(join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'pause-state.json'), 'utf8')
    ) as Record<string, unknown>
    expect(pauseState.reason).toBe('infrastructure')

    const pauseComment = readFileSync(join(home, '.fake-gh-posted-comments', 'comment-1.md'), 'utf8')
    expect(pauseComment).toMatch(/^<!-- aeg:loop:paused:infrastructure -->$/m)
    expect(pauseComment).toMatch(/dispatch-gate premise:/)
  }, 20000)
})

// --- O2 (#543): unpushed-work resume, then no_push, distinct from a genuinely idle stall ---

/**
 * Same as `writeFakeGit`, except `-C <worktree> status --porcelain` reports
 * one dirty file and `-C <worktree> rev-list --count @{u}..HEAD` reports one
 * commit ahead — a developer turn that did REAL, uncommitted-or-unpushed
 * work, never the "did nothing at all" case `writeFakeGit`'s own bare
 * `exit 1` fallback already covers.
 */
function writeFakeGitDirtyWorktree(dir: string): void {
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
if [ "$1" = "-C" ] && [ "$3" = "status" ]; then
  echo " M smoke.ts"
  exit 0
fi
if [ "$1" = "-C" ] && [ "$3" = "rev-list" ]; then
  echo "1"
  exit 0
fi
exit 1
`
  )
}

function setUpNeverPushesDirty(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudeNeverPushes(binDir)
  writeFakeGhAlwaysRedCi(binDir)
  writeFakeGitDirtyWorktree(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — O2 (#543): unpushed real work is resumed once, then no_push — never folded into the generic infrastructure stall', () => {
  it('resumes once with a commit-and-push instruction, records the resume comment, then pauses (no_push) naming the branch and the dirty file', () => {
    const { home, cwd, path } = setUpNeverPushesDirty()
    const r = runDevReviewLoopArgs(home, cwd, path, ['--task', String(TASK), '--agent', 'claude'], {
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_MAX_ATTEMPTS: '2',
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_INTERVAL_MS: '10'
    })
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/paused \(no_push\)/)

    const pauseState = JSON.parse(
      readFileSync(join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'pause-state.json'), 'utf8')
    ) as Record<string, unknown>
    expect(pauseState.reason).toBe('no_push')
    expect(pauseState.detail).toMatch(new RegExp(`branch ${BRANCH}`))
    expect(pauseState.detail).toMatch(/smoke\.ts/)

    // Exactly one resume for this: round 1's own fresh dispatch is
    // `.dev-prompt-1.txt`, the gate-red retry that discovers the dirty
    // worktree is `.dev-prompt-2.txt`, and the ONE commit-and-push resume
    // this triggers is `.dev-prompt-3.txt` — never a fourth.
    expect(existsSync(join(home, '.dev-prompt-3.txt'))).toBe(true)
    expect(existsSync(join(home, '.dev-prompt-4.txt'))).toBe(false)
    const commitAndPushPrompt = readFileSync(join(home, '.dev-prompt-3.txt'), 'utf8')
    expect(commitAndPushPrompt).toMatch(/uncommitted changes.*local commits ahead/)
    expect(commitAndPushPrompt).toMatch(/`git push`/)

    // The resume itself is recorded, once, as a marked PR comment.
    const posted = readdirSync(join(home, '.fake-gh-posted-comments')).map((f) =>
      readFileSync(join(home, '.fake-gh-posted-comments', f), 'utf8')
    )
    const resumeComment = posted.find((c) => c.startsWith('<!-- aeg:loop:unpushed-work-resume -->'))
    expect(resumeComment).toBeDefined()
    expect(resumeComment as string).toMatch(/unpushed_work_resume/)
    expect(resumeComment as string).toMatch(/smoke\.ts/)

    // Round 2 review, MAJOR: the resume must ALSO land in the real
    // `dev_review_loop` journal, not only the marked PR comment above — a
    // real `unpushed_work_resume` event, readable the same way every other
    // driver-logged event in this suite is (`outboxLines`).
    const resumeEvent = outboxLines(home).find((l) => l.event === 'unpushed_work_resume') as
      | Record<string, unknown>
      | undefined
    expect(resumeEvent).toBeDefined()
    expect(resumeEvent?.kind).toBe('dev_review_loop')
    expect(resumeEvent?.branch).toBe(BRANCH)
    expect(resumeEvent?.detail as string).toMatch(/smoke\.ts/)
  }, 20000)
})

// --- O2 (#595): the loop's own control files are never unpushed work ---

/** `git -C <worktree> status --porcelain` reporting ONLY the loop's own two control files as untracked — never real work. */
function writeFakeGitControlFilesOnly(dir: string): void {
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
if [ "$1" = "-C" ] && [ "$3" = "status" ]; then
  printf '%s\\n' '?? .vinaya-confidence'
  printf '%s\\n' '?? .vinaya-round-response'
  exit 0
fi
if [ "$1" = "-C" ] && [ "$3" = "rev-list" ]; then
  echo "0"
  exit 0
fi
exit 1
`
  )
}

/** Same as \`writeFakeGitDirtyWorktree\`, plus the loop's own two control files alongside the real dirty one — proves the pause detail names only the real file, never the control files too. */
function writeFakeGitDirtyWorktreeWithControlFiles(dir: string): void {
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
if [ "$1" = "-C" ] && [ "$3" = "status" ]; then
  printf '%s\\n' ' M smoke.ts'
  printf '%s\\n' '?? .vinaya-confidence'
  printf '%s\\n' '?? .vinaya-round-response'
  exit 0
fi
if [ "$1" = "-C" ] && [ "$3" = "rev-list" ]; then
  echo "1"
  exit 0
fi
exit 1
`
  )
}

function setUpNeverPushesControlFilesOnly(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudeNeverPushes(binDir)
  writeFakeGhAlwaysRedCi(binDir)
  writeFakeGitControlFilesOnly(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

function setUpNeverPushesDirtyWithControlFiles(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudeNeverPushes(binDir)
  writeFakeGhAlwaysRedCi(binDir)
  writeFakeGitDirtyWorktreeWithControlFiles(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe("devReviewLoop — O2 (#595): the loop's own control files are never unpushed work", () => {
  it('a worktree dirty ONLY in .vinaya-confidence/.vinaya-round-response reads clean — never a no_push pause', () => {
    const { home, cwd, path } = setUpNeverPushesControlFilesOnly()
    const r = runDevReviewLoopArgs(home, cwd, path, ['--task', String(TASK), '--agent', 'claude'], {
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_MAX_ATTEMPTS: '2',
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_INTERVAL_MS: '10'
    })
    expect(r.status).not.toBe(0)
    // Same generic bound a plain, genuinely-clean stall hits — never the
    // no_push-specific pause, and never a resume for "unpushed work" that
    // was never real.
    expect(r.stdout).toMatch(/paused \(infrastructure\)/)
    expect(r.stdout).not.toMatch(/paused \(no_push\)/)

    const pauseState = JSON.parse(
      readFileSync(join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'pause-state.json'), 'utf8')
    ) as Record<string, unknown>
    expect(pauseState.reason).toBe('infrastructure')

    const commentsDir = join(home, '.fake-gh-posted-comments')
    for (const f of readdirSync(commentsDir)) {
      expect(readFileSync(join(commentsDir, f), 'utf8')).not.toMatch(/aeg:loop:unpushed-work-resume/)
    }
  }, 20000)

  it('one dirty file alongside the two control files still reads as unpushed — no_push, naming only the real file', () => {
    const { home, cwd, path } = setUpNeverPushesDirtyWithControlFiles()
    const r = runDevReviewLoopArgs(home, cwd, path, ['--task', String(TASK), '--agent', 'claude'], {
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_MAX_ATTEMPTS: '2',
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_INTERVAL_MS: '10'
    })
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/paused \(no_push\)/)

    const pauseState = JSON.parse(
      readFileSync(join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'pause-state.json'), 'utf8')
    ) as Record<string, unknown>
    expect(pauseState.reason).toBe('no_push')
    expect(pauseState.detail).toMatch(/smoke\.ts/)
    expect(pauseState.detail).not.toMatch(/\.vinaya-confidence/)
    expect(pauseState.detail).not.toMatch(/\.vinaya-round-response/)
  }, 20000)
})

// --- O3 (#543): a reviewer report missing finding ids is sent back once, never no_progress ---

/**
 * The code-reviewer writes one BLOCKER finding on EVERY dispatch this
 * round, but never a `FINDING_IDS:` line — persistently uncitable, so the
 * driver's own one resend (into a fresh work directory, its path read back
 * out of the prompt it receives, exactly as a real dispatched reviewer
 * would) still doesn't produce one. Counts its own dispatches to
 * `$HOME/.reviewer-dispatch-count` so the test can assert there were
 * exactly two (the original attempt plus the one resend — never a third).
 * Security stays clean throughout (empty findings.txt — trivially cited).
 */
function writeFakeClaudeUncitableScenario(dir: string): void {
  writeFakeBinary(
    dir,
    'claude',
    `#!/bin/sh
touch "$HOME/.fake-dev-invoked" 2>/dev/null
PROMPT="$(cat)"
case "$VINAYA_ROLE" in
  code-reviewer)
    N=$(cat "$HOME/.reviewer-dispatch-count" 2>/dev/null || echo 0)
    echo $((N + 1)) > "$HOME/.reviewer-dispatch-count"
    WD=$(printf '%s\\n' "$PROMPT" | grep -o '[^ ]*reviewer-work[^ ]*/findings.txt' | head -1 | sed 's|/findings.txt$||')
    mkdir -p "$WD"
    printf '%s\\n' 'BLOCKER|smoke.ts:1|deliberate, never cited' > "$WD/findings.txt"
    printf 'O1|MET|done.\\n' > "$WD/objectives.txt"
    printf 'BRIEF_CONFORMANCE: yes\\nSPEC_CONFORMANCE: yes\\nSCOPE: small\\nTESTS: pass\\nDOCS: n/a\\n' > "$WD/report.txt"
    echo '{"session_id":"rev-session-'"$N"'","usage":{"input_tokens":8,"output_tokens":4}}'
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

function setUpUncitable(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudeUncitableScenario(binDir)
  writeFakeGh(binDir)
  writeFakeGit(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — O3 (#543): a reviewer report missing finding ids is resent once, then report_uncitable — never no_progress', () => {
  it("resends once into a fresh work directory, records report_uncitable, and still dispatches the developer on this round's real BLOCKER — never stalls", () => {
    const { home, cwd, path } = setUpUncitable()
    const r = runLoop(home, cwd, path)
    expect(r.status).not.toBe(0)
    // A real, un-cited BLOCKER still drives changes_requested → dispatch the
    // developer — this pauses only because this fixture's fake developer
    // never actually pushes a round-2 fix, the SAME `infrastructure`/
    // gate-stall bound every other single-round fixture in this file hits,
    // never `no_progress` (there is no PRIOR round to compare zero-resolved
    // against yet, and this round's own citation gap must never manufacture
    // one).
    expect(r.stdout).not.toMatch(/paused \(no_progress\)/)

    // Exactly two code-reviewer dispatches this round: the original, then
    // the one resend — never a third.
    expect(readFileSync(join(home, '.reviewer-dispatch-count'), 'utf8').trim()).toBe('2')

    const posted = readdirSync(join(home, '.fake-gh-posted-comments')).map((f) =>
      readFileSync(join(home, '.fake-gh-posted-comments', f), 'utf8')
    )
    const uncitableComment = posted.find((c) => c.startsWith('<!-- aeg:loop:report-uncitable -->'))
    expect(uncitableComment).toBeDefined()
    expect(uncitableComment as string).toMatch(/report_uncitable: reviewer/)
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
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "labels" ]; then
  printf '%s\n' '{"labels":[{"name":"vinaya/tranche:x"}]}'
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
    printf '%s' "$PROMPT" > "$HOME/.dev-prompt-full.txt"
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

    // O11 (task-run-v1 21, #541): a resumed prompt's own first line is now
    // this run's task/branch/worktree/head context block, not the
    // instruction itself — that instruction still follows it, further down
    // the same prompt.
    expect(firstLine).toMatch(/^Resuming task Issue #\d+\.$/)
    const fullPrompt = readFileSync(join(home, '.dev-prompt-full.txt'), 'utf8')
    expect(fullPrompt).toMatch(new RegExp(`^Resuming task Issue #${TASK}\\.$`, 'm'))
    expect(fullPrompt).toMatch(new RegExp(`^Branch: \`${BRANCH}\`$`, 'm'))
    expect(fullPrompt).toMatch(new RegExp(`^Worktree: \`.*\\.worktrees/${BRANCH}\`$`, 'm'))
    expect(fullPrompt).toMatch(/^Remote head: [0-9a-f]{40}$/m)
    expect(fullPrompt).toMatch(/already exists with no open pull request/)
  }, 20000)
})

// --- task-run-v1 3 (#482), O4: attach recovers a held REQUEST-CHANGES round from disk ---

const HELD_JUDGED_HEAD = 'c'.repeat(40)

function heldVerdictText(verdictLine: string): string {
  return `${verdictLine}\n\nJudged head: ${HELD_JUDGED_HEAD}\n\nFound something on the prior head.\n`
}

/**
 * Round 2's reviewers both come back clean — this fixture is testing that
 * round 1's held REQUEST-CHANGES pair on disk is what moves the driver
 * straight to round 2 reviewers on attach, never a second round of real
 * findings. The developer role, if ever invoked, records the fact instead
 * of behaving like a real turn — this scenario asserts it never runs.
 */
function writeFakeClaudeAttachRecoversHeldRound(dir: string): void {
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
    echo "developer dispatched: round=$VINAYA_ROUND" >> "$HOME/.dev-invocations"
    echo '{"session_id":"dev-session-unexpected","usage":{"input_tokens":10,"output_tokens":5}}'
    ;;
esac
exit 0
`
  )
}

function setUpAttachRecoversHeldRound(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudeAttachRecoversHeldRound(binDir)
  writeFakeGhAttach(binDir)
  writeFakeGitAttach(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — attach recovers a held REQUEST-CHANGES round from disk (O4, task-run-v1 3, #482)', () => {
  it('a moved head dispatches round 2 reviewers directly — never redelivers round 1s held findings to the developer', () => {
    const { home, cwd, path } = setUpAttachRecoversHeldRound()

    // Round 1's held verdicts, still on disk — never posted (REQUEST
    // CHANGES/FAIL never reach `publishRound`) — judged against a head
    // this fixture's `git` fake no longer answers as the branch's current
    // one (`HEAD_SHA`, from `writeFakeGitAttach`'s `ls-remote`).
    const heldDir = join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK))
    mkdirSync(heldDir, { recursive: true })
    writeFileSync(join(heldDir, 'round-1-reviewer.md'), heldVerdictText('VERDICT: REQUEST CHANGES'))
    writeFileSync(join(heldDir, 'round-1-security.md'), heldVerdictText('VERDICT: FAIL'))

    // The developer's own last turn — the one that pushed the fix moving
    // the head away from round 1's judged sha — is what would realistically
    // leave this file behind; pre-seeded here so round 2's confidence gate
    // (round >= 2) reads a real value instead of asking a developer this
    // attach must never dispatch.
    const worktreeDir = join(cwd, '.worktrees', BRANCH)
    mkdirSync(worktreeDir, { recursive: true })
    writeFileSync(join(worktreeDir, '.vinaya-confidence'), 'CONFIDENCE: 90 — fixed round 1s blocker\n')

    const r = runLoop(home, cwd, path)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/publish/)

    // No developer dispatch at all — round 1's held findings were never
    // redelivered, and round 2 never needed to ask for confidence either
    // (the pre-seeded file already answered it).
    expect(existsSync(join(home, '.dev-invocations'))).toBe(false)

    // Reviewers really did run, at round 2 — the recovered round, not a
    // reset-to-round-1 re-review of the exact same (already-fixed) head.
    expect(existsSync(join(heldDir, 'round-2-reviewer-work'))).toBe(true)
    expect(existsSync(join(heldDir, 'round-2-security-work'))).toBe(true)
  }, 20000)
})

describe('devReviewLoop — a second attach on the same unchanged head reads as no_progress, not another redelivery (O4, task-run-v1 3, #482)', () => {
  it('pauses on no_progress and dispatches nobody — never a third redelivery of round 1s findings', () => {
    const { home, cwd, path } = setUpAttachRecoversHeldRound()

    // Head UNCHANGED this time — round 1's judged sha matches the fake
    // git's own current head (`writeFakeGitAttach`'s `ls-remote`).
    const heldDir = join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK))
    mkdirSync(heldDir, { recursive: true })
    writeFileSync(
      join(heldDir, 'round-1-reviewer.md'),
      `VERDICT: REQUEST CHANGES\n\nJudged head: ${HEAD_SHA}\n\nStill there.\n`
    )
    writeFileSync(join(heldDir, 'round-1-security.md'), `VERDICT: FAIL\n\nJudged head: ${HEAD_SHA}\n\nStill there.\n`)
    // A prior attach already redelivered round 1's findings once, on this
    // exact head, with no developer push in between — this run is the
    // second one in a row, which O4 reads as no_progress rather than
    // trying a third time.
    writeFileSync(join(heldDir, 'round-1-attach-redelivered'), new Date().toISOString())

    const r = runLoop(home, cwd, path)
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/paused \(no_progress\)/)

    expect(existsSync(join(home, '.dev-invocations'))).toBe(false)
    expect(existsSync(join(heldDir, 'round-2-reviewer-work'))).toBe(false)
    expect(existsSync(join(heldDir, 'round-2-security-work'))).toBe(false)

    // O3 ([task-log-v1] 9, Issue #631): this pause is decided by an OR of
    // two independent guard inputs (the local marker file this fixture
    // wrote, and a control-store delivered-findings identity this fixture
    // never wrote) — the comment now names which one actually held, rather
    // than reading identically regardless.
    const postedFiles = postedCommentFiles(home)
    const pauseComment = readFileSync(
      join(home, '.fake-gh-posted-comments', postedFiles[postedFiles.length - 1] as string),
      'utf8'
    )
    expect(pauseComment).toContain('local marker file present')
    expect(pauseComment).toContain('control-store delivered-findings identity absent')
  }, 20000)
})

describe('devReviewLoop — the driver composes the round comment from a citation the developer left in its outbox, never posted itself', () => {
  it('reads FINDING_IDS from .vinaya-round-response, cites them in the round-2 marker comment, and clears the file', () => {
    const { home, cwd, path } = setUpAttachRecoversHeldRound()

    // Round 1's held findings, same shape the sibling fixture above seeds —
    // this attach resumes straight to round 2 without dispatching a fresh
    // developer turn of its own.
    const heldDir = join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK))
    mkdirSync(heldDir, { recursive: true })
    writeFileSync(join(heldDir, 'round-1-reviewer.md'), heldVerdictText('VERDICT: REQUEST CHANGES'))
    writeFileSync(join(heldDir, 'round-1-security.md'), heldVerdictText('VERDICT: FAIL'))

    // The Developer's own last turn (the one that pushed the fix, ending at
    // the push per O1) is what would realistically leave both of these
    // behind: a confidence answer for round 2's gate, and — the outbox
    // record this objective is about — a citation of which findings it
    // addressed, for the driver to read and compose the round comment from
    // instead of the Developer posting one itself.
    const worktreeDir = join(cwd, '.worktrees', BRANCH)
    mkdirSync(worktreeDir, { recursive: true })
    writeFileSync(join(worktreeDir, '.vinaya-confidence'), 'CONFIDENCE: 90 — fixed round 1s blocker\n')
    writeFileSync(join(worktreeDir, '.vinaya-round-response'), 'FINDING_IDS: F1,F2\n')

    const r = runLoop(home, cwd, path)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/publish/)

    // No developer dispatch at all — the citation came from the outbox
    // file, never from a comment the Developer itself posted or a turn the
    // driver had to resume for it.
    expect(existsSync(join(home, '.dev-invocations'))).toBe(false)

    // The FIRST posted comment is the driver's own round-2 marker, carrying
    // the citation it read from the outbox file — composed and posted by
    // the driver, ahead of either reviewer verdict.
    const files = postedCommentFiles(home)
    const roundCommentPosted = readFileSync(join(home, '.fake-gh-posted-comments', files[0] as string), 'utf8')
    expect(roundCommentPosted).toMatch(/^<!-- aeg:developer:round-2 -->$/m)
    expect(roundCommentPosted).toMatch(/^FINDING_IDS: F1,F2$/m)

    // Read once, then cleared — a second attach on the same round must
    // never redeliver a stale citation from a prior round.
    expect(existsSync(join(worktreeDir, '.vinaya-round-response'))).toBe(false)
  }, 20000)
})

/** A schema-valid `dev_review_loop` NDJSON line — the shape `journal-reconstruction.ts` (`@attalabs/aeg-core`) requires to accept it. */
function loopEventLine(fields: Record<string, unknown>, seq: number): string {
  return JSON.stringify({
    meta: {
      schema: 1,
      ts: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
      run_id: 'prior-run-1',
      seq,
      repo: null,
      vinaya: '0.0.0-test',
      doctrine: 'test',
      host: 'cli',
      machine: 'test-machine'
    },
    subject: { issue: TASK, role: 'unattributed' },
    kind: 'dev_review_loop',
    loop_id: 'prior-loop-1',
    payload: {},
    ...fields
  })
}

/**
 * O9 (task-run-v1 21, `#541`): round 1 genuinely concluded
 * `changes_requested` — logged in full to the local outbox — but the
 * process then died before ever flushing those lines to the forge AND
 * before (or after) any held-verdict `.md` file survived to disk. Unlike
 * the `setUpAttachRecoversHeldRound` scenarios above, there is deliberately
 * no `round-1-reviewer.md`/`round-1-security.md` here — the ONLY signal
 * this attach has that round 1 ever happened is the raw log line, which is
 * exactly the gap `latestHeldRequestChanges` (O4, task 3) cannot close on
 * its own: a held-verdict file is one specific crash window; the durable
 * log is the task's complete record, per O9.
 */
function writeRound1LoopHistory(home: string): void {
  const outboxDir = join(home, '.vinaya', 'outbox', 'unresolved')
  mkdirSync(outboxDir, { recursive: true })
  const lines = [
    loopEventLine(
      {
        event: 'loop_started',
        task: TASK,
        policy: { max_rounds: 3, reviewers: ['code-reviewer', 'security'], models: {} }
      },
      0
    ),
    loopEventLine({ event: 'round_started', round: 1, base_head: BASE_SHA }, 1),
    loopEventLine({ event: 'gate_result_read', round: 1, head: HELD_JUDGED_HEAD, green: true }, 2),
    loopEventLine({ event: 'verdicts_read', round: 1, head: HELD_JUDGED_HEAD, all_approve: false, blockers: 1 }, 3),
    loopEventLine({ event: 'findings_compared', round: 1, open: ['F1'], resolved: [], new: ['F1'], recurring: [] }, 4),
    loopEventLine(
      {
        event: 'round_ended',
        round: 1,
        base_head: BASE_SHA,
        head: HELD_JUDGED_HEAD,
        files_changed: 2,
        insertions: 5,
        deletions: 1,
        wall_ms: 1000,
        outcome: 'changes_requested'
      },
      5
    )
  ]
  writeFileSync(join(outboxDir, `${TASK}.ndjson`), `${lines.join('\n')}\n`, 'utf8')
}

describe('devReviewLoop — O9 (task-run-v1 21, #541): attach reconstructs round numbering and the journal from the outbox alone, with no held-verdict file', () => {
  it('dispatches round 2 directly (never redelivers round 1) and publishes a two-row journal covering both rounds', () => {
    const { home, cwd, path } = setUpAttachRecoversHeldRound()

    writeRound1LoopHistory(home)

    const worktreeDir = join(cwd, '.worktrees', BRANCH)
    mkdirSync(worktreeDir, { recursive: true })
    writeFileSync(join(worktreeDir, '.vinaya-confidence'), 'CONFIDENCE: 90 — fixed round 1s blocker\n')

    const r = runLoop(home, cwd, path)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/publish/)

    // Round advanced to 2 from the outbox's own round_ended alone — no
    // held-verdict file ever existed for this attach to read instead.
    const heldDir = join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK))
    expect(existsSync(join(heldDir, 'round-2-reviewer-work'))).toBe(true)
    expect(existsSync(join(heldDir, 'round-2-security-work'))).toBe(true)
    expect(existsSync(join(home, '.dev-invocations'))).toBe(false)

    // The published summary names both rounds — round 1's reconstructed
    // from the outbox, round 2 computed live by this run — never fewer
    // rows than the real rounds this task actually ran (Origin, PR #536).
    const files = postedCommentFiles(home)
    const summaryFile = files[files.length - 1] as string
    const summary = readFileSync(join(home, '.fake-gh-posted-comments', summaryFile), 'utf8')
    expect(summary).toMatch(/^\| 1 \|/m)
    expect(summary).toMatch(/^\| 2 \|/m)
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
  writeFakeGhWithWorkingIssueComment(binDir)
  writeFakeGit(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — the pull-request poll gives up naming what it waited for (O3, task-run-v1 13, #508)', () => {
  it('names branch, local head (unknown), remote head (none), and pull-request absence, after resuming once — a decided pause(infrastructure), never an uncaught crash (O6)', () => {
    const { home, cwd, path } = setUpNoPushEver()

    const r = runDevReviewLoopArgs(home, cwd, path, ['--task', String(TASK), '--agent', 'claude'], {
      VINAYA_DEV_REVIEW_LOOP_PR_POLL_MAX_ATTEMPTS: '2',
      VINAYA_DEV_REVIEW_LOOP_PR_POLL_INTERVAL_MS: '5'
    })
    expect(r.status).not.toBe(0)
    // O6: the round-1 poll-giveup throw now reaches the SAME
    // outer catch every other in-loop failure does — a decided
    // `pause(infrastructure)`, never a re-thrown crash. The rich
    // branch/head/pull-request message this poll timeout names is no
    // longer printed to stdout/stderr (nothing throws there to print it);
    // it lands in full in the pause's own LOCAL `detail` (never posted
    // anywhere — machine-local outbox only).
    expect(r.stdout).toMatch(/paused \(infrastructure\)/)

    const pauseState = JSON.parse(
      readFileSync(join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'pause-state.json'), 'utf8')
    ) as Record<string, unknown>
    expect(pauseState.reason).toBe('infrastructure')
    const detail = String(pauseState.detail)
    expect(detail).toMatch(new RegExp(`branch: ${BRANCH.replace(/\//g, '\\/')}`))
    expect(detail).toMatch(/local head: \(worktree not found/)
    expect(detail).toMatch(/remote head: \(no head on origin\)/)
    expect(detail).toMatch(/pull request: none open/)

    // Security review, MEDIUM: the PUBLIC PR comment gets a SEPARATELY
    // sanitized detail — first line only. The full multi-line
    // branch/head/pull-request breakdown above is a local-only fact; the
    // public thread only ever sees the poll's own one-line headline.
    const posted = postedCommentFiles(home).map((f) => readFileSync(join(home, '.fake-gh-posted-comments', f), 'utf8'))
    const pauseComment = posted.find((body) => /^<!-- aeg:loop:paused:infrastructure -->$/m.test(body))
    expect(pauseComment).toBeDefined()
    expect(pauseComment).toContain('no open PR appeared within the poll budget')
    expect(pauseComment).not.toMatch(/local head:/)
    expect(pauseComment).not.toMatch(/pull request: none open/)
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
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "labels" ]; then
  printf '%s\n' '{"labels":[{"name":"vinaya/tranche:x"}]}'
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

/**
 * Same shape as `setUpStopBeforePush`, except the developer's own stop
 * comment embeds a credential-shaped token and a path naming a different
 * local user — the raw text `postIssuePauseComment` receives as `detail`
 * before this scenario asserts what actually reaches the public comment.
 */
function setUpStopBeforePushWithCredential(): { home: string; cwd: string; path: string } {
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
  printf '%s\\n' '{"comments":[{"body":"<!-- aeg:brief:v1 -->\\nBrief hash: deadbeef\\nDo the thing.\\n\\n## Objectives\\n\\nO1. Do the thing.\\n","author":{"login":"daniboomerang"}},{"body":"<!-- aeg:developer:stop -->\\nCould not read '\\''/Users/someone-else/config.json'\\'' — token=ghp_abcdefghijklmnopqrstuvwxyz012345 rejected.","author":{"login":"daniboomerang"}}]}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "title" ]; then
  printf '%s\\n' '{"title":"[dev-review-loop-v1] ${TASK} \\u2014 test task"}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "labels" ]; then
  printf '%s\n' '{"labels":[{"name":"vinaya/tranche:x"}]}'
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
echo "unhandled fake gh call in stop-before-push-with-credential scenario: $*" >&2
exit 1
`
  )
  writeFakeGit(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — the no-push-stop escalation comment is sanitized too (O9)', () => {
  it('redacts the credential and the different-user path from the developer stop comment before it reaches the public Issue comment', () => {
    const { home, cwd, path } = setUpStopBeforePushWithCredential()

    const r = runLoop(home, cwd, path)
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/paused \(escalation\)/)

    const posted = postedCommentFiles(home)
    const pauseFiles = posted.filter((f) =>
      readFileSync(join(home, '.fake-gh-posted-comments', f), 'utf8').includes('aeg:loop:paused:escalation')
    )
    expect(pauseFiles).toHaveLength(1)
    const body = readFileSync(join(home, '.fake-gh-posted-comments', pauseFiles[0] as string), 'utf8')

    // The raw secret and the other user's path never reach the public
    // comment — proof that `postIssuePauseComment` actually sanitizes this
    // call site, not merely that it compiles and posts something.
    expect(body).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345')
    expect(body).not.toContain('someone-else')
    expect(body).toContain('<redacted>')
    expect(body).toContain('~/config.json')
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
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "labels" ]; then
  printf '%s\n' '{"labels":[{"name":"vinaya/tranche:x"}]}'
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

    // `comment-1.md` is now the round marker comment, posted
    // before either reviewer dispatches; the pause is `comment-2.md`.
    const pauseComment = readFileSync(join(home, '.fake-gh-posted-comments', 'comment-2.md'), 'utf8')
    expect(pauseComment).toMatch(/^<!-- aeg:loop:paused:stale_driver -->$/m)
    expect(pauseComment).toMatch(new RegExp(`base moved from ${BASE_SHA} to ${'e'.repeat(40)}`))
  }, 20000)
})

// --- task-run-v1 15, O7: a moved base re-execs in place, reattaching to the same task, rather than pausing outright ---

/** Same as `writeFakeGitBaseMoves`, plus a `pull --ff-only origin main` that succeeds (touching a marker file so the test can prove the pull path was actually taken) rather than being unhandled. */
function writeFakeGitBaseMovesWithSuccessfulPull(dir: string): void {
  writeFakeBinary(
    dir,
    'git',
    `#!/bin/sh
if [ "$1" = "pull" ]; then
  touch "$HOME/.git-pull-called" 2>/dev/null
  exit 0
fi
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

describe('devReviewLoop — O7 (task-run-v1 task 15): a moved base re-execs in place instead of pausing', () => {
  it('pulls the default branch, re-execs onto the same task, and never pauses stale_driver', () => {
    const home = tempDir('vinaya-drl-home-')
    const cwd = tempDir('vinaya-drl-cwd-')
    const binDir = tempDir('vinaya-drl-bin-')
    writeFakeClaudeBaseMovesAfterFirstTurn(binDir)
    writeFakeGh(binDir)
    writeFakeGitBaseMovesWithSuccessfulPull(binDir)
    const path = `${binDir}:${pathWithoutRealVendors()}`

    // The re-exec attaches to the same task in a genuinely fresh process
    // (the whole point of O7 — a stale in-memory driver must not keep
    // running), so the polls that fresh process makes finding the
    // already-open PR/gate need the same fast-poll overrides any other
    // fixture exercising real polling in test time already uses.
    runDevReviewLoopArgs(home, cwd, path, ['--task', String(TASK), '--agent', 'claude'], {
      VINAYA_DEV_REVIEW_LOOP_PR_POLL_MAX_ATTEMPTS: '5',
      VINAYA_DEV_REVIEW_LOOP_PR_POLL_INTERVAL_MS: '5',
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_MAX_ATTEMPTS: '5',
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_INTERVAL_MS: '5'
    })

    // The pull path was actually taken — proof the re-exec attempt ran at all.
    expect(existsSync(join(home, '.git-pull-called'))).toBe(true)

    // Never the stale_driver pause anywhere this run's own comments landed —
    // the re-exec absorbed the staleness instead of handing it to a human.
    const commentsDir = join(home, '.fake-gh-posted-comments')
    if (existsSync(commentsDir)) {
      for (const file of readdirSync(commentsDir)) {
        expect(readFileSync(join(commentsDir, file), 'utf8')).not.toMatch(/aeg:loop:paused:stale_driver/)
      }
    }
  }, 30000)
})

/**
 * Same as `writeFakeClaudeBaseMovesAfterFirstTurn` for the developer's own
 * first turn (touches `.base-moved` so `checkStaleDriver` fires once the
 * re-exec'd child re-reads `origin/main`), but — unlike that fixture, which
 * never runs past the stale-driver pause it's used to test — a reviewer
 * role here answers exactly like the clean-round fixture (`writeFakeClaude`)
 * so the CHILD process (the one that actually takes over) can run a genuine
 * round to completion and publish, proving the takeover is real rather than
 * merely started.
 */
function writeFakeClaudeBaseMovesThenCleanReview(dir: string): void {
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
    touch "$HOME/.base-moved" 2>/dev/null
    echo '{"session_id":"dev-session-1","usage":{"input_tokens":10,"output_tokens":5}}'
    ;;
esac
exit 0
`
  )
}

describe('devReviewLoop — O1 (#548): the re-exec hands its lock to the child instead of refusing it', () => {
  it('clears the parent’s own live lock before spawning, so the child starts and publishes instead of dying to its own parent’s lock', () => {
    const home = tempDir('vinaya-drl-home-')
    const cwd = tempDir('vinaya-drl-cwd-')
    const binDir = tempDir('vinaya-drl-bin-')
    writeFakeClaudeBaseMovesThenCleanReview(binDir)
    writeFakeGh(binDir)
    writeFakeGitBaseMovesWithSuccessfulPull(binDir)
    const path = `${binDir}:${pathWithoutRealVendors()}`

    // Found live, PR #547: without the fix, the parent's own lock (written
    // at its own entry, still on disk and still live — the parent is
    // blocked in `spawnSync`, not exited) refuses the child outright, and
    // BOTH processes exit quietly with no pause, no publish, nothing posted.
    const r = runDevReviewLoopArgs(home, cwd, path, ['--task', String(TASK), '--agent', 'claude'], {
      VINAYA_DEV_REVIEW_LOOP_PR_POLL_MAX_ATTEMPTS: '5',
      VINAYA_DEV_REVIEW_LOOP_PR_POLL_INTERVAL_MS: '5',
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_MAX_ATTEMPTS: '5',
      VINAYA_DEV_REVIEW_LOOP_GATE_POLL_INTERVAL_MS: '5'
    })

    expect(existsSync(join(home, '.git-pull-called'))).toBe(true)
    expect(r.stderr).not.toMatch(/refuses to start/)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/publish/)
    // The child cleared its own lock on its own normal exit.
    expect(existsSync(driverLockPath(home))).toBe(false)
  }, 30000)
})

describe('buildReexecArgs (pure) — O7 re-exec carries the original --json intent through the restart (task-run-v1 21, #541, round 2 review MINOR)', () => {
  it('carries --json through a --task re-exec when the original invocation had it', () => {
    expect(buildReexecArgs({ task: 9001, agent: 'claude', json: true }, 9001)).toEqual([
      'dev-review-loop',
      '--task',
      '9001',
      '--agent',
      'claude',
      '--json'
    ])
  })

  it('omits --json entirely when the original invocation did not carry it', () => {
    expect(buildReexecArgs({ task: 9001, agent: 'claude' }, 9001)).toEqual([
      'dev-review-loop',
      '--task',
      '9001',
      '--agent',
      'claude'
    ])
  })

  it('carries --json through a --resume re-exec too, same as --task', () => {
    expect(buildReexecArgs({ resumePr: 42, agent: 'codex', json: true }, 9001)).toEqual([
      'dev-review-loop',
      '--resume',
      '42',
      '--agent',
      'codex',
      '--json'
    ])
  })
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
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "labels" ]; then
  printf '%s\n' '{"labels":[{"name":"vinaya/tranche:x"}]}'
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

    // O11 (task-run-v1 21, #541, round 2 review MAJOR): the conflict-retry
    // resume prompt names the task/branch/worktree/head context AND the
    // exact commands expected, not just "merge or rebase" in prose.
    expect(conflictPrompt).toMatch(new RegExp(`^Resuming task Issue #${TASK}\\.$`, 'm'))
    expect(conflictPrompt).toMatch(new RegExp(`^Branch: \`${BRANCH}\`$`, 'm'))
    expect(conflictPrompt).toMatch(/^Worktree: `.*\.worktrees\//m)
    expect(conflictPrompt).toMatch(/^Remote head: [0-9a-f]{40}$/m)
    expect(conflictPrompt).toMatch(/`git merge origin\/main`/)
    expect(conflictPrompt).toMatch(/`git push`/)
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
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "labels" ]; then
  printf '%s\n' '{"labels":[{"name":"vinaya/tranche:x"}]}'
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

    // Two posted comments — the round marker (posted before
    // the mismatch is even detected) and the pause — never a reviewer or
    // security verdict: `verdicts` (in-memory only at the mismatch check) is
    // never written to disk, so nothing was ever held for round 1 to publish.
    const posted = postedCommentFiles(home)
    expect(posted).toHaveLength(2)
    const pauseComment = readFileSync(join(home, '.fake-gh-posted-comments', posted[1] as string), 'utf8')
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

    // Two posted comments — the round marker (posted before
    // the mismatch is even detected) and the pause — never a reviewer or
    // security verdict: `verdicts` (in-memory only at the mismatch check) is
    // never written to disk, so nothing was ever held for round 1 to publish.
    const posted = postedCommentFiles(home)
    expect(posted).toHaveLength(2)
    const pauseComment = readFileSync(join(home, '.fake-gh-posted-comments', posted[1] as string), 'utf8')
    expect(pauseComment).toMatch(/^<!-- aeg:loop:paused:ruling_posted -->$/m)
    expect(pauseComment).not.toMatch(/^VERDICT:/m)

    const roundDir = join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK))
    expect(existsSync(join(roundDir, 'round-1-reviewer.md'))).toBe(false)
    expect(existsSync(join(roundDir, 'round-1-security.md'))).toBe(false)
  }, 20000)
})

// --- a frozen-brief supersede lands mid-round (review-validity-v1 task 4, #478, O1/O2) ---

/**
 * Same as `writeFakeGh`, except the frozen brief's OWN comment list grows a
 * second, principal-authored `<!-- aeg:brief:v2 -->` supersede between
 * dispatch and the driver's own re-assessment — the analogous mid-round
 * change to `writeFakeGhObjectivesChangedMidRound`'s objectives edit and
 * `writeFakeGhRulingPostedMidRound`'s ruling, but for the manifest's
 * `briefHash` field instead. `## Objectives` stays byte-identical across
 * both versions on purpose — only the brief's own prose changes — so
 * `objectivesVersion` binds cleanly and the driver's `else if
 * (!binding.briefHash)` branch is the one that actually fires, not the
 * earlier objectives check. A counter file under `$HOME` tells the early
 * (dispatch-time, v1-only) calls apart from the later (re-assessment,
 * v1+v2) ones — the SAME `gh issue view --json comments` endpoint backs
 * both `resolveIssueObjectives` and `fetchFrozenBrief`, so the threshold
 * must clear every call either one makes before the driver's own
 * post-reviewers re-check: the round-1 developer dispatch's own
 * `fetchFrozenBrief`, the reviewer-dispatch facts' `resolveIssueObjectives`
 * and its own `fetchFrozenBrief` (the manifest's dispatch-time
 * `briefContentAtDispatch`), and the re-assessment's own
 * `resolveIssueObjectives` — five calls total before the re-assessment's
 * own `fetchFrozenBrief` is the one that must see v2.
 */
function writeFakeGhBriefSupersededMidRound(dir: string): void {
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
  BRIEF_V1='{"body":"<!-- aeg:brief:v1 -->\\nBrief hash: deadbeef\\nDo the thing.\\n\\n## Objectives\\n\\nO1. Do the thing.\\n\\n## Planner rationale\\n\\nOut of scope for facts.\\n","author":{"login":"daniboomerang"}}'
  if [ "$N" -ge 5 ]; then
    BRIEF_V2='{"body":"<!-- aeg:brief:v2 -->\\nBrief hash: supersededhash\\nSupersedes: https://github.com/example/repo/issues/${TASK}#issuecomment-1 \\u2014 clarified scope mid-round.\\nDo the thing, revised.\\n\\n## Objectives\\n\\nO1. Do the thing.\\n\\n## Planner rationale\\n\\nOut of scope for facts.\\n","author":{"login":"daniboomerang"}}'
    printf '%s\\n' "{\\"comments\\":[$BRIEF_V1,$BRIEF_V2]}"
  else
    printf '%s\\n' "{\\"comments\\":[$BRIEF_V1]}"
  fi
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "title" ]; then
  printf '%s\\n' '{"title":"[dev-review-loop-v1] ${TASK} \\u2014 test task"}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "labels" ]; then
  printf '%s\n' '{"labels":[{"name":"vinaya/tranche:x"}]}'
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
echo "unhandled fake gh call in brief-superseded scenario: $*" >&2
exit 1
`
  )
}

function setUpBriefSupersededMidRound(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaude(binDir)
  writeFakeGhBriefSupersededMidRound(binDir)
  writeFakeGit(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

describe('devReviewLoop — a frozen-brief supersede lands between reviewer dispatch and assessment (review-validity-v1 task 4, #478, O1/O2)', () => {
  it('discards the round instead of holding or publishing, and pauses naming both brief hashes', () => {
    const { home, cwd, path } = setUpBriefSupersededMidRound()

    const r = runLoop(home, cwd, path)
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/paused \(brief_superseded\)/)

    const pauseState = JSON.parse(
      readFileSync(join(home, '.vinaya', 'outbox', 'dev-review-loop', String(TASK), 'pause-state.json'), 'utf8')
    ) as Record<string, unknown>
    expect(pauseState.reason).toBe('brief_superseded')
    expect(pauseState.detail).toMatch(/brief hash moved from [0-9a-f]+ to [0-9a-f]+/)

    // Two posted comments — the round marker (posted before
    // the mismatch is even detected) and the pause — never a reviewer or
    // security verdict: `verdicts` (in-memory only at the mismatch check) is
    // never written to disk, so nothing was ever held for round 1 to publish.
    const posted = postedCommentFiles(home)
    expect(posted).toHaveLength(2)
    const pauseComment = readFileSync(join(home, '.fake-gh-posted-comments', posted[1] as string), 'utf8')
    expect(pauseComment).toMatch(/^<!-- aeg:loop:paused:brief_superseded -->$/m)
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

describe('CONFIDENCE_PROMPT_LINE (pure) — O11 (task-run-v1 21, #541, round 2 review MAJOR)', () => {
  it('names the exact command expected, not just the required file format', () => {
    expect(CONFIDENCE_PROMPT_LINE).toMatch(/`echo '.*' > \.vinaya-confidence`/)
  })

  it('the confidence re-ask prompt (dispatched via dispatchDeveloper, which always prepends the resume-context block on a resume) still carries this same command, since it is appended verbatim', () => {
    const reaskPrompt = `Your last reply did not include a valid confidence line.\n\n${CONFIDENCE_PROMPT_LINE}`
    expect(reaskPrompt).toMatch(/`echo '.*' > \.vinaya-confidence`/)
  })
})

describe('assertValidLoopEvent (pure) — O6 (#595): a malformed emitted event is refused at emit time, field named', () => {
  it('passes every well-formed event this loop actually emits, across one full round’s worth of shapes', () => {
    const loopId = 'loop-1'
    const events: DevReviewLoopEventInput[] = [
      {
        kind: 'dev_review_loop',
        payload: {},
        event: 'loop_started',
        loop_id: loopId,
        task: TASK,
        policy: { max_rounds: 3, reviewers: ['code-reviewer', 'security'], models: {} }
      },
      { kind: 'dev_review_loop', payload: {}, event: 'round_started', loop_id: loopId, round: 1, base_head: BASE_SHA },
      {
        kind: 'dev_review_loop',
        payload: {},
        event: 'gate_result_read',
        loop_id: loopId,
        round: 1,
        head: HEAD_SHA,
        green: true
      },
      {
        kind: 'dev_review_loop',
        payload: {},
        event: 'verdicts_read',
        loop_id: loopId,
        round: 1,
        head: HEAD_SHA,
        all_approve: true,
        blockers: 0,
        findings: []
      },
      {
        kind: 'dev_review_loop',
        payload: {},
        event: 'findings_compared',
        loop_id: loopId,
        round: 1,
        open: [],
        resolved: [],
        new: [],
        recurring: []
      },
      {
        kind: 'dev_review_loop',
        payload: {},
        event: 'stop_condition_met',
        loop_id: loopId,
        round: 1,
        condition: 'green'
      },
      {
        kind: 'dev_review_loop',
        payload: {},
        event: 'round_ended',
        loop_id: loopId,
        round: 1,
        base_head: BASE_SHA,
        head: HEAD_SHA,
        files_changed: 1,
        insertions: 1,
        deletions: 0,
        wall_ms: 10,
        outcome: 'green'
      },
      {
        kind: 'dev_review_loop',
        payload: {},
        event: 'journal_finalized',
        loop_id: loopId,
        rounds: 1,
        total_wall_ms: 10,
        time_to_green_ms: 10,
        files_changed_total: 1,
        final_head: HEAD_SHA,
        result: 'merged_ready'
      }
    ]
    for (const e of events) expect(() => assertValidLoopEvent(e)).not.toThrow()
  })

  it('refuses a malformed event, naming the exact field that fails its schema', () => {
    const malformed = {
      kind: 'dev_review_loop',
      payload: {},
      event: 'round_started',
      loop_id: 'loop-1',
      round: 'not-a-number',
      base_head: BASE_SHA
    } as unknown as DevReviewLoopEventInput
    expect(() => assertValidLoopEvent(malformed)).toThrow(/round/)
  })

  it('refuses an event carrying an extra, unrecognized field — every schema here is .strict()', () => {
    const malformed = {
      kind: 'dev_review_loop',
      payload: {},
      event: 'round_started',
      loop_id: 'loop-1',
      round: 1,
      base_head: BASE_SHA,
      unexpected_field: 'x'
    } as unknown as DevReviewLoopEventInput
    expect(() => assertValidLoopEvent(malformed)).toThrow(/unexpected_field/)
  })
})

describe('sanitizeUncaughtErrorForPublicPause (pure) — security review, MEDIUM', () => {
  it('takes only the first line — a multi-line stderr dump collapses to its own headline', () => {
    const err = new Error('short headline\nline two with a stack frame\nline three')
    expect(sanitizeUncaughtErrorForPublicPause(err)).toBe('short headline')
  })

  it("redacts this process's own $HOME to ~ — the common shape a leaked local path takes", () => {
    const home = process.env.HOME
    if (!home) return // nothing to redact on a host with no $HOME set
    const err = new Error(`ENOENT: no such file or directory, open '${home}/secret-project/config.json'`)
    const result = sanitizeUncaughtErrorForPublicPause(err)
    expect(result).not.toContain(home)
    expect(result).toContain('~/secret-project/config.json')
  })

  it('caps the length — a runaway message never balloons the public pause comment', () => {
    const err = new Error('x'.repeat(1000))
    const result = sanitizeUncaughtErrorForPublicPause(err)
    expect(result.length).toBeLessThan(320)
    expect(result.endsWith('…')).toBe(true)
  })

  it('a non-Error thrown value is stringified the same way', () => {
    expect(sanitizeUncaughtErrorForPublicPause('a plain string throw')).toBe('a plain string throw')
  })

  // The redactions the sanitizer adds — a path naming a DIFFERENT user, a
  // URL-embedded credential, a well-known credential shape, this machine's
  // hostname — had no direct test coverage of their own.
  it("redacts a filesystem path naming a DIFFERENT user than this process's own $HOME", () => {
    const err = new Error("ENOENT: no such file or directory, open '/Users/someone-else/config.json'")
    const result = sanitizeUncaughtErrorForPublicPause(err)
    expect(result).not.toContain('someone-else')
    expect(result).toContain('~/config.json')
  })

  it('redacts a credential embedded as a URL userinfo segment', () => {
    const err = new Error(
      "fatal: unable to access 'https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz012345@github.com/atta-labs/vinaya.git/': The requested URL returned error: 403"
    )
    const result = sanitizeUncaughtErrorForPublicPause(err)
    expect(result).not.toContain('x-access-token')
    expect(result).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345')
    expect(result).toContain('://<redacted>@github.com')
  })

  it('redacts a well-known credential shape even outside a URL', () => {
    const err = new Error('gh: request failed, token=ghp_abcdefghijklmnopqrstuvwxyz012345 rejected')
    const result = sanitizeUncaughtErrorForPublicPause(err)
    expect(result).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345')
    expect(result).toContain('<redacted>')
  })

  it("redacts this machine's own hostname", () => {
    const host = hostname()
    if (!host) return // nothing to redact on a host that reports none
    const err = new Error(`connect ECONNREFUSED ${host}:443`)
    const result = sanitizeUncaughtErrorForPublicPause(err)
    expect(result).not.toContain(host)
    expect(result).toContain('<host>:443')
  })
})

// --- the developer's round-response outbox file ---------------------------

describe('parseRoundResponseFindingIds / renderDeveloperRoundComment / developerRoundMarker (pure)', () => {
  it('parses a FINDING_IDS: line into its comma-separated ids', () => {
    expect(parseRoundResponseFindingIds('FINDING_IDS: F1,F2,F3\n')).toEqual(['F1', 'F2', 'F3'])
  })

  it('is case-insensitive and tolerates surrounding whitespace, matching the reviewer-side grammar', () => {
    expect(parseRoundResponseFindingIds('finding_ids:  F1 , F2 \n')).toEqual(['F1', 'F2'])
  })

  it('is [] for null content — a Developer that never wrote the file at all', () => {
    expect(parseRoundResponseFindingIds(null)).toEqual([])
  })

  it('is [] for content with no FINDING_IDS: line — never a throw, never a stall (O2: no round is judged no_progress for this)', () => {
    expect(parseRoundResponseFindingIds('some unrelated note\n')).toEqual([])
  })

  it('is [] for an empty FINDING_IDS: value', () => {
    expect(parseRoundResponseFindingIds('FINDING_IDS: \n')).toEqual([])
  })

  it('renderDeveloperRoundComment carries Head: first, no FINDING_IDS: line when there is nothing to cite', () => {
    const body = renderDeveloperRoundComment('a'.repeat(40), [])
    expect(body).toBe(`Head: ${'a'.repeat(40)}`)
  })

  it('renderDeveloperRoundComment appends FINDING_IDS: only when ids were cited — the outbox-only citation path (O2)', () => {
    const body = renderDeveloperRoundComment('a'.repeat(40), ['F1', 'F2'])
    expect(body).toBe(`Head: ${'a'.repeat(40)}\nFINDING_IDS: F1,F2`)
  })

  it("developerRoundMarker matches the SAME regex @attalabs/aeg-core's parseDeveloperRoundMarker reads", () => {
    expect(developerRoundMarker(3)).toBe('<!-- aeg:developer:round-3 -->')
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

describe('describeConfidencePauseDetail (pure) — [task-log-v1] 9, Issue #631, O1/O3', () => {
  it('names the absent case — no confidence line on the re-asked turn', () => {
    expect(describeConfidencePauseDetail('absent')).toContain('no confidence line was found on the re-asked turn')
  })

  it('names the reported-but-low case, including the developer-supplied reason when present', () => {
    const detail = describeConfidencePauseDetail({ value: 35, reason: 'flaky test environment' })
    expect(detail).toContain('confidence reported at 35')
    expect(detail).toContain('(flaky test environment)')
    expect(detail).toContain('below the required 50 threshold')
  })

  it('omits the parenthetical when no reason was supplied', () => {
    const detail = describeConfidencePauseDetail({ value: 20 })
    expect(detail).toContain('confidence reported at 20')
    expect(detail).not.toContain('()')
  })
})

describe('deriveVerdictPauseDetail (pure) — [task-log-v1] 9, Issue #631, O1/O3', () => {
  const findingsComparedEvent = (
    overrides: Partial<{ open: string[]; resolved: string[]; new: string[]; recurring: string[] }>
  ) =>
    ({
      event: 'findings_compared',
      round: 2,
      open: [],
      resolved: [],
      new: [],
      recurring: [],
      ...overrides
    }) as unknown as DevReviewLoopEventInput

  it('names the escalating role(s) for reason escalation', () => {
    expect(deriveVerdictPauseDetail('escalation', [], true, false)).toBe('reviewer returned ESCALATE this round')
    expect(deriveVerdictPauseDetail('escalation', [], false, true)).toBe('security returned ESCALATE this round')
    expect(deriveVerdictPauseDetail('escalation', [], true, true)).toBe(
      'reviewer and security returned ESCALATE this round'
    )
  })

  it('names the reappearing finding ids for reason reappearance, read from the round’s own findings_compared event', () => {
    const events = [findingsComparedEvent({ recurring: ['F1', 'F3'] })]
    const detail = deriveVerdictPauseDetail('reappearance', events, false, false)
    expect(detail).toContain('F1, F3')
    expect(detail).toContain('reappeared after being marked resolved')
  })

  it('narrates the no_progress case from the same findings_compared event, never inventing a fact assessRound did not already compute', () => {
    const events = [findingsComparedEvent({ open: ['F1'] })]
    const detail = deriveVerdictPauseDetail('no_progress', events, false, false)
    expect(detail).toContain('no finding was marked resolved this round')
    expect(detail).toContain('two consecutive rounds with no forward motion')
  })

  it('returns undefined when no findings_compared event is present at all — never fabricates one', () => {
    expect(deriveVerdictPauseDetail('reappearance', [], false, false)).toBeUndefined()
  })

  it('returns undefined for max_rounds — that reason already carries its own detail from assessRound, so the call site never even calls this for it', () => {
    expect(deriveVerdictPauseDetail('max_rounds', [], false, false)).toBeUndefined()
  })
})

describe('appendFinalFlushFailureNote (pure) — [task-log-v1] 9, Issue #631, O2: a failed final flush is folded into detail, never swallowed', () => {
  it('appends the note when no detail existed yet', () => {
    const detail = appendFinalFlushFailureNote(undefined, 'gh: rate limited')
    expect(detail).toContain('the final outbox flush before this pause failed')
    expect(detail).toContain('gh: rate limited')
  })

  it('appends the note onto an existing detail, never replacing it', () => {
    const detail = appendFinalFlushFailureNote('round 4 findings delivered again', 'gh: rate limited')
    expect(detail).toContain('round 4 findings delivered again')
    expect(detail).toContain('the final outbox flush before this pause failed')
    expect(detail).toContain('gh: rate limited')
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
    resolvedObjectives: [{ id: 'O1', text: 'Do the thing.' }],
    rulings: [],
    ciConclusion: 'green',
    revision: 'b'.repeat(40),
    manifest: {
      headSha: 'a'.repeat(40),
      baseSha: 'e'.repeat(40),
      briefHash: 'c'.repeat(64),
      objectivesVersion: null,
      rulingOrdinal: 0,
      policyDigest: 'd'.repeat(64)
    }
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

      briefHash: null,

      policyDigest: DEFAULT_POLICY_DIGEST,
      baseSha: null,
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

      briefHash: null,

      policyDigest: DEFAULT_POLICY_DIGEST,
      baseSha: null,
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

      briefHash: null,

      policyDigest: 'p'.repeat(64),
      baseSha: null,
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

      briefHash: null,

      policyDigest: 'p'.repeat(64),
      baseSha: null,
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
  const THIS_REPO_POLICY = { codeReviewThreshold: 'MAJOR' as const, securityThreshold: 'HIGH' as const, maxRounds: 3 }

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

      briefHash: null,

      policyDigest: 'p'.repeat(64),
      baseSha: null,
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

      briefHash: null,

      policyDigest: 'p'.repeat(64),
      baseSha: null,
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
    expect(
      deriveCodeReviewVerdict(findings, { codeReviewThreshold: 'BLOCKER', securityThreshold: 'HIGH', maxRounds: 3 })
    ).toBe('APPROVE')

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

      briefHash: null,

      policyDigest: DEFAULT_POLICY_DIGEST,
      baseSha: null,
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

      briefHash: null,

      policyDigest: DEFAULT_POLICY_DIGEST,
      baseSha: null,
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

      briefHash: null,

      policyDigest: DEFAULT_POLICY_DIGEST,
      baseSha: null,
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

      briefHash: null,

      policyDigest: DEFAULT_POLICY_DIGEST,
      baseSha: null,
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

      briefHash: null,

      policyDigest: 'p'.repeat(64),
      baseSha: null,
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

      briefHash: null,

      policyDigest: 'p'.repeat(64),
      baseSha: null,
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
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "labels" ]; then
  printf '%s\n' '{"labels":[{"name":"vinaya/tranche:x"}]}'
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

describe('resolveRoundEndFlushTarget / describeSkippedRoundEndFlush (pure) — task-log-v1 8, Issue #626, O1: the round-end flush never defaults to the task Issue', () => {
  it('is null — no publish — when logPublish is unconfigured, the ordinary default for every existing repo', () => {
    expect(resolveRoundEndFlushTarget(null, TASK)).toBeNull()
    expect(describeSkippedRoundEndFlush(null, TASK)).toBeNull()
  })

  it('resolves a configured issue distinct from the task being flushed', () => {
    const config = { logPublish: { issue: TASK + 1 } } as VinayaConfig
    expect(resolveRoundEndFlushTarget(config, TASK)).toEqual({ issue: TASK + 1 })
    expect(describeSkippedRoundEndFlush(config, TASK)).toBeNull()
  })

  it('resolves a configured pr target unconditionally — a pr number is never compared against the task Issue', () => {
    const config = { logPublish: { pr: TASK } } as VinayaConfig
    expect(resolveRoundEndFlushTarget(config, TASK)).toEqual({ pr: TASK })
  })

  it("refuses a configured issue equal to the task's own Issue — the loss is named, not swallowed", () => {
    const config = { logPublish: { issue: TASK } } as VinayaConfig
    expect(resolveRoundEndFlushTarget(config, TASK)).toBeNull()
    const reason = describeSkippedRoundEndFlush(config, TASK)
    expect(reason).not.toBeNull()
    expect(reason).toContain(`#${TASK}`)
    expect(reason).toContain("this task's own Issue")
  })
})
