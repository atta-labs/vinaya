/**
 * The fixtures the standalone driver's split test files share: fake `claude`, `gh` and `git` binaries, the
 * whole-CLI subprocess runners and the run-folder paths. Each test file registers its own cleanup hooks; this
 * module holds no state that outlives one test.
 */

import { it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FAKE_CLAUDE_PROBE_ANSWER } from '../../../../../../../apps/cli/tests/lib/dispatch/fake-sandbox-probe.js'
import { checkReviewGate, DEFAULT_REVIEW_POLICY, policyDigest } from '@attalabs/aeg-core'

export const CLI_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'apps',
  'cli'
)
export const INDEX = join(CLI_ROOT, 'src', 'index.ts')

/**
 * `checkReviewGate` resolves `DEFAULT_REVIEW_POLICY`'s digest whenever a
 * test omits its own `policy` field (every "passes" fixture below that
 * doesn't test a custom policy). `isBoundToPolicy` no longer grandfathers a
 * digest it cannot parse as real hex (`#478` round 4, security MEDIUM) — the
 * `'p'.repeat(64)` placeholder these fixtures used is not valid hex, so the
 * reader treats it as "no line at all" and it must now match for real.
 */
export const DEFAULT_POLICY_DIGEST = policyDigest(DEFAULT_REVIEW_POLICY)

/** The default branch's `vinaya.config.json` every fixture's `gh` stub serves for `api repos/<owner>/<repo>/contents/vinaya.config.json`, base64-encoded as the contents API's `--jq .content` returns it. */
export const PRINCIPALS_CONFIG_B64 = Buffer.from(JSON.stringify({ principals: ['daniboomerang'] })).toString('base64')

export const TASK = 9001

/**
 * Where a fixture's driver writes every file this task's run produces.
 *
 * `unresolved` is the repo segment `run-paths.ts`'s `defaultRuntimeDir`
 * falls back to, and these fixtures run in a temporary directory with no
 * git origin to resolve — the same reason the outbox helper below already
 * reads from an `unresolved` directory. Built by hand here, never by
 * importing `runPath`, so the layout this task establishes is asserted
 * against literal strings rather than against the function under test.
 */
export function taskRunDir(home: string, task: number = TASK): string {
  return join(home, '.vinaya', 'runtime', 'unresolved', 'tasks-execution', String(task))
}

/** The task's control records — the ownership epochs, escalations, resolutions, loop state and pause state. */
export function controlDir(home: string, task: number = TASK): string {
  return join(taskRunDir(home, task), 'control')
}

/** One round's own folder: its held verdicts, reviewer work directories, and its read-only candidate and scratch copies. */
export function roundDir(home: string, round: number, task: number = TASK): string {
  return join(taskRunDir(home, task), 'rounds', String(round))
}

/** That round's own Developer folder — the confidence and round-response files' absolute path, outside the worktree (`task-files-v1` 2, #649). */
export function developerDir(home: string, round: number, task: number = TASK): string {
  return join(roundDir(home, round, task), 'developer')
}

export const BRANCH = `task/dev-review-loop-v1/${TASK}`
export const HEAD_SHA = 'a'.repeat(40)
export const BASE_SHA = 'b'.repeat(40)

/** Same exclusion `dispatch.test.ts` uses — this authoring machine has real claude/codex/gemini installed. */
export function pathWithoutRealVendors(): string {
  const dirs = (process.env.PATH ?? '').split(':').filter(Boolean)
  return dirs.filter((d) => !['claude', 'codex', 'gemini'].some((vendor) => existsSync(join(d, vendor)))).join(':')
}

export const tempDirs: string[] = []

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/**
 * A fake Developer's last stream line: Claude's terminal `result` event
 * carrying the turn result as `structured_output` (what `--json-schema`
 * yields), `completed` at confidence 90 and citing every handoff id the
 * prompt (`$PROMPT`) lists for it to cite.
 */
export const FAKE_DEVELOPER_TURN_RESULT = `IDS=$(printf '%s\\n' "$PROMPT" | grep -oE '^- R[0-9]+-(CR|SEC)-[0-9]+(:|$)' | sed -e 's/^- //' -e 's/:$//' | sort -u | sed -e 's/.*/"&"/' | paste -sd, -)
    echo '{"type":"result","subtype":"success","is_error":false,"session_id":"dev-session-1","usage":{"input_tokens":10,"output_tokens":5},"structured_output":{"turnResult":{"schemaVersion":1,"status":"completed","summary":"fixture turn","confidence":90,"confidenceExplanation":"the fixture work is done","addressedFindingIds":['"$IDS"'],"sourceUses":[],"reportedChecks":null}}}'`

/**
 * A fake reviewer binary's whole stream: one `result` event whose
 * `structured_output` is a ReviewResult bound to the head and manifest digest
 * the prompt names, as a real reviewer is told to return it. `fields` are the
 * result's own JSON fields after its bindings. It also leaves
 * `$HOME/.fake-<role>-round-<n>`, so a test can see which rounds were reviewed.
 */
export function fakeReviewResultShell(
  role: 'code-reviewer' | 'security-reviewer',
  session: string,
  fields: string
): string {
  return `HEAD_SHA="$(printf '%s\\n' "$PROMPT" | sed -n 's/.*headSha \\([0-9a-f]*\\).*/\\1/p' | tail -n 1)"
    DIGEST="$(printf '%s\\n' "$PROMPT" | sed -n 's/.*manifestDigest \\([0-9a-f]*\\).*/\\1/p' | tail -n 1)"
    touch "$HOME/.fake-${role}-round-$VINAYA_ROUND" 2>/dev/null
    echo '{"type":"result","subtype":"success","session_id":"${session}","usage":{"input_tokens":8,"output_tokens":4},"structured_output":{"reviewResult":{"schemaVersion":1,"role":"${role}","headSha":"'"$HEAD_SHA"'","manifestDigest":"'"$DIGEST"'",${fields}}}}'`
}

export const FAKE_OBJECTIVES_MET = '"objectiveResults":[{"id":"O1","status":"MET","evidence":"done"}]'
export const FAKE_CLEAN_CODE_REVIEW = `"status":"completed","summary":"Conforms to the brief.","findings":[],${FAKE_OBJECTIVES_MET}`
export const FAKE_CLEAN_SECURITY_REVIEW = `"status":"completed","summary":"none found — atta-labs/secret-scan passed","findings":[],${FAKE_OBJECTIVES_MET}`
export const FAKE_ESCALATED_CODE_REVIEW =
  '"status":"blocked","summary":"needs a call nobody made.","blocker":{"kind":"scope_unclear","detail":"escalated as authority"}'

export function writeFakeBinary(dir: string, name: string, script: string): void {
  const p = join(dir, name)
  // A fake `claude` answers the Linux sandbox probe before doing anything else.
  writeFileSync(p, name === 'claude' ? script.replace(/^(#![^\n]*\n)/, `$1${FAKE_CLAUDE_PROBE_ANSWER}`) : script)
  chmodSync(p, 0o755)
  if (name === 'claude') {
    // The real-process loop fixture substitutes a fake vendor binary. Mark
    // Claude's Linux sandbox prerequisites as available too, so dispatch
    // reaches that binary under the now-required unattended boundary. These
    // stubs are never invoked by the fake vendor.
    for (const tool of ['bwrap', 'socat']) {
      const toolPath = join(dir, tool)
      writeFileSync(toolPath, '#!/bin/sh\nexit 0\n')
      chmodSync(toolPath, 0o755)
    }
  }
}

export function writeFakeClaude(dir: string): void {
  writeFakeBinary(
    dir,
    'claude',
    `#!/bin/sh
touch "$HOME/.fake-dev-invoked" 2>/dev/null
PROMPT="$(cat)"
WORKROOT="$HOME/.vinaya/runtime/unresolved/tasks-execution/$VINAYA_TASK"
case "$VINAYA_ROLE" in
  code-reviewer)
    ${fakeReviewResultShell('code-reviewer', 'rev-session-1', FAKE_CLEAN_CODE_REVIEW)}
    ;;
  security)
    ${fakeReviewResultShell('security-reviewer', 'sec-session-1', FAKE_CLEAN_SECURITY_REVIEW)}
    ;;
  *)
    ${FAKE_DEVELOPER_TURN_RESULT}
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
export function writeFakeGh(dir: string): void {
  writeFakeBinary(
    dir,
    'gh',
    `#!/bin/sh
if [ "$1" = "api" ] && [ "\${2#*contents/vinaya.config.json}" != "$2" ]; then
  # Every fixture's principalAllowlist()/reviewPolicy() call reaches
  # loadTrustAnchorConfig() with no injected fetcher (it runs inside this
  # spawned driver subprocess, past any in-process seam), so the stub serves
  # the default branch's vinaya.config.json naming the Principal, base64 as
  # the contents API returns it — the configured path every Principal-deciding
  # reader now requires.
  echo '${PRINCIPALS_CONFIG_B64}'
  exit 0
fi
STATE_DIR="$HOME/.fake-gh-posted-comments"
mkdir -p "$STATE_DIR"
if [ "$1" = "api" ] && case "$2" in repos/*/issues/*/comments*) true ;; *) false ;; esac; then
  "$0" issue view 0 --json comments | bun -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(JSON.stringify(j.comments.map((c) => ({ body: c.body, html_url: c.url ?? "", user: c.author ?? null }))))'
  exit 0
fi
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
if [ "$1" = "api" ] && [ "\${2#*actions/runs}" != "$2" ]; then
  exit 0 # no workflow runs: the CI reading rests on the check-runs alone
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
 * Same as `writeFakeGh`, except `gh api …/check-runs` answers with TWO
 * check-runs: a real mechanical one (`Vinaya CI`, success) and the review
 * gate's own (`vinaya review gate`, FAILURE — as it always reads before any
 * verdict has posted). review-validity-v1 task 5 (`#488`, O1): the gate must
 * exclude the review gate's own check-run by name and read this head as
 * green off `Vinaya CI` alone, never red because of the review gate.
 */
export function writeFakeGhReviewGateOwnCheckFails(dir: string): void {
  writeFakeBinary(
    dir,
    'gh',
    `#!/bin/sh
if [ "$1" = "api" ] && [ "\${2#*contents/vinaya.config.json}" != "$2" ]; then
  # Every fixture's principalAllowlist()/reviewPolicy() call reaches
  # loadTrustAnchorConfig() with no injected fetcher (it runs inside this
  # spawned driver subprocess, past any in-process seam), so the stub serves
  # the default branch's vinaya.config.json naming the Principal, base64 as
  # the contents API returns it — the configured path every Principal-deciding
  # reader now requires.
  echo '${PRINCIPALS_CONFIG_B64}'
  exit 0
fi
STATE_DIR="$HOME/.fake-gh-posted-comments"
mkdir -p "$STATE_DIR"
if [ "$1" = "api" ] && case "$2" in repos/*/issues/*/comments*) true ;; *) false ;; esac; then
  "$0" issue view 0 --json comments | bun -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(JSON.stringify(j.comments.map((c) => ({ body: c.body, html_url: c.url ?? "", user: c.author ?? null }))))'
  exit 0
fi
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
if [ "$1" = "api" ] && [ "\${2#*actions/runs}" != "$2" ]; then
  exit 0 # no workflow runs: the CI reading rests on the check-runs alone
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

export function setUpReviewGateOwnCheckFails(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaude(binDir)
  writeFakeGhReviewGateOwnCheckFails(binDir)
  writeFakeGit(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

/**
 * `[task-operator-v1]`/Issue #662, O1: every fixture below whose own `gh
 * pr comment` fails PERSISTENTLY (never recovers) now also fails the
 * driver's own eventual pause-comment post — retried with backoff
 * (`pause-resume.ts`'s `postWithRetry`) for up to `PAUSE_COMMENT_RETRY_ATTEMPTS`
 * real-time attempts before giving up. `VINAYA_DEV_REVIEW_LOOP_PAUSE_COMMENT_RETRY_ATTEMPTS: '1'`
 * restores the pre-O1 single-attempt timing these crash-scenario tests were
 * written against — the retry behavior itself is covered by its own
 * dedicated fixtures, below.
 */
export const NO_PAUSE_COMMENT_RETRY_ENV = { VINAYA_DEV_REVIEW_LOOP_PAUSE_COMMENT_RETRY_ATTEMPTS: '1' }

export function runLoopNoPauseCommentRetry(home: string, cwd: string, path: string): CliResult {
  return runDevReviewLoopArgs(
    home,
    cwd,
    path,
    ['--task', String(TASK), '--agent', 'claude'],
    NO_PAUSE_COMMENT_RETRY_ENV
  )
}

/**
 * Round 2 review, BLOCKER (task-run-v1 21, `#541`, O9); reconstruction source
 * updated by [task-files-v1] 4 (Issue #651): the reattach rebuilds round
 * numbering from the pull request's own principal-authored developer round
 * marker (`pr view --json comments`, replayed from `$HOME/.fake-gh-posted-
 * comments`), never from a log line — the local outbox this test separately
 * reads (`outboxLines`) to ASSERT the telemetry the run logged (a green
 * `round_ended`, never a `merged_ready`) is never consulted by the recovery
 * itself. `pr comment`'s crash-on-the-second-post logic is unchanged from
 * `writeFakeGhCrashOnSecondPostFlushSucceeds` — this fixture is that one.
 */
export function writeFakeGhCrashOnceThenReattach(dir: string): void {
  writeFakeBinary(
    dir,
    'gh',
    `#!/bin/sh
if [ "$1" = "api" ] && [ "\${2#*contents/vinaya.config.json}" != "$2" ]; then
  # Every fixture's principalAllowlist()/reviewPolicy() call reaches
  # loadTrustAnchorConfig() with no injected fetcher (it runs inside this
  # spawned driver subprocess, past any in-process seam), so the stub serves
  # the default branch's vinaya.config.json naming the Principal, base64 as
  # the contents API returns it — the configured path every Principal-deciding
  # reader now requires.
  echo '${PRINCIPALS_CONFIG_B64}'
  exit 0
fi
STATE_DIR="$HOME/.fake-gh-posted-comments"
ISSUE_STATE_DIR="$HOME/.fake-gh-posted-issue-comments"
mkdir -p "$STATE_DIR" "$ISSUE_STATE_DIR"
if [ "$1" = "api" ] && case "$2" in repos/*/issues/*/comments*) true ;; *) false ;; esac; then
  "$0" issue view 0 --json comments | bun -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(JSON.stringify(j.comments.map((c) => ({ body: c.body, html_url: c.url ?? "", user: c.author ?? null }))))'
  exit 0
fi
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
if [ "$1" = "api" ] && [ "\${2#*actions/runs}" != "$2" ]; then
  exit 0 # no workflow runs: the CI reading rests on the check-runs alone
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
export function writeFakeGhReattachSucceeds(dir: string): void {
  writeFakeBinary(
    dir,
    'gh',
    `#!/bin/sh
if [ "$1" = "api" ] && [ "\${2#*contents/vinaya.config.json}" != "$2" ]; then
  # Every fixture's principalAllowlist()/reviewPolicy() call reaches
  # loadTrustAnchorConfig() with no injected fetcher (it runs inside this
  # spawned driver subprocess, past any in-process seam), so the stub serves
  # the default branch's vinaya.config.json naming the Principal, base64 as
  # the contents API returns it — the configured path every Principal-deciding
  # reader now requires.
  echo '${PRINCIPALS_CONFIG_B64}'
  exit 0
fi
STATE_DIR="$HOME/.fake-gh-posted-comments"
ISSUE_STATE_DIR="$HOME/.fake-gh-posted-issue-comments"
mkdir -p "$STATE_DIR" "$ISSUE_STATE_DIR"
if [ "$1" = "api" ] && case "$2" in repos/*/issues/*/comments*) true ;; *) false ;; esac; then
  "$0" issue view 0 --json comments | bun -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(JSON.stringify(j.comments.map((c) => ({ body: c.body, html_url: c.url ?? "", user: c.author ?? null }))))'
  exit 0
fi
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
if [ "$1" = "api" ] && [ "\${2#*actions/runs}" != "$2" ]; then
  exit 0 # no workflow runs: the CI reading rests on the check-runs alone
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
export function writeFakeGit(dir: string): void {
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
if [ "$1" = "merge-base" ]; then
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
if [ "$1" = "worktree" ] && [ "$2" = "add" ]; then
  # O1: the loop creates the task's own worktree at
  # start, before the first Developer dispatch — succeed without touching
  # real disk; nothing in this fixture reads the directory's own contents.
  exit 0
fi
if [ "$1" = "config" ]; then
  exit 0
fi
if [ "$1" = "fetch" ]; then
  exit 0
fi
if [ "$1" = "-C" ] && [ "$3" = "branch" ] && [ "$4" = "-u" ]; then
  # Principal ruling 1: after the commit-free ref push below creates the
  # remote branch, the loop sets the worktree's own upstream directly
  # (\`git -C <worktree> branch -u origin/<branch>\`) — succeed without
  # touching real disk.
  exit 0
fi
if [ "$1" = "-C" ] && [ "$3" = "push" ]; then
  # The Developer's own later publish push (\`publishRound\`/
  # \`developer-publication.ts\`) still runs FROM the worktree with an
  # explicit refspec — record it and succeed.
  echo "$@" >> "$HOME/.fake-git-pushes"
  exit 0
fi
if [ "$1" = "push" ]; then
  # Principal ruling 1: the loop creates the remote task branch with a
  # commit-free, \`--no-verify\`'d ref push (\`git push --no-verify origin
  # origin/main:refs/heads/<branch>\`), never \`git -C <worktree> push -u
  # origin HEAD\` — record it and succeed.
  echo "$@" >> "$HOME/.fake-git-pushes"
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

export type CliResult = { status: number; stdout: string; stderr: string }

export function runLoop(home: string, cwd: string, path: string, budgetMs: number = SUBPROCESS_BUDGET_MS): CliResult {
  return runDevReviewLoopArgs(home, cwd, path, ['--task', String(TASK), '--agent', 'claude'], {}, budgetMs)
}

export function runResume(home: string, cwd: string, path: string, pr: number): CliResult {
  return runDevReviewLoopArgs(home, cwd, path, ['--resume', String(pr), '--agent', 'claude'])
}

export function runCancel(home: string, cwd: string, path: string, pr: number): CliResult {
  return runDevReviewLoopArgs(home, cwd, path, ['--cancel', String(pr), '--agent', 'claude'])
}

/**
 * Issue #660, O3 — this process's OWN environment, when it is itself a
 * dispatched Developer/Reviewer session (or a pre-push hook run from one's
 * shell), carries `VINAYA_RUNTIME_DIR` (`run-paths.ts`'s `RUNTIME_DIR_ENV_KEY`)
 * pointed at this MACHINE's real, shared runtime directory — checked first,
 * unconditionally, ahead of `$HOME`, by `resolveRuntimeDirUncached`. Spreading
 * `...process.env` into a spawned fixture's own env therefore hands that
 * SAME real shared directory to every fixture's driver subprocess, no
 * matter how carefully `home` above is isolated — the exact incident this
 * task closes: two task runs and a full suite, each dispatched the same
 * way, all racing the SAME real `driver.pid.json` and control-store files.
 * `VINAYA_TASK`/`VINAYA_ROUND`/`VINAYA_RUN`/`VINAYA_RUN_ID`/`VINAYA_UNATTENDED`/
 * `VINAYA_ROLE` are stripped alongside it on the same principle — none of
 * them should ever be decided by this OUTER process's own identity rather
 * than the fixture's own `--task`/`--resume` argument and isolated `$HOME`.
 * Same discipline `remote-base.ts`'s `cleanGitEnv` already applies to `GIT_*`
 * for an analogous inherited-env collision.
 *
 * `AEG_REPO` is stripped alongside every `VINAYA_*` key for the same root
 * cause, merged from origin/main's independent issue-657 O5 fix: every
 * fixture in this file relies on the driver resolving its runtime directory
 * under the `unresolved` repo segment (the fake `git` binary answers no real
 * remote, so `resolveRepoSync` finds none) — `writeFakeClaude`'s own
 * `$HOME/.vinaya/runtime/unresolved/tasks-execution/…` path, and this file's
 * own `taskRunDir` helper, both hardcode that assumption. A real `AEG_REPO`
 * inherited from the calling shell's own environment (set when this file's
 * own suite runs inside a real dispatched session) silently resolves a REAL
 * repo segment instead, the same class of collision `VINAYA_RUNTIME_DIR`
 * causes. Found live: a driver leaked exactly this way blocked a later run
 * in this same suite with "a driver is already running", and left real
 * files under the operator's own home directory this suite never created a
 * temp dir for and therefore never cleans up.
 */
/**
 * O1 (issue-709 profile): every fixture whose fake `gh` answers "not ready"
 * on a first check exercises the loop's real PR/gate poll retry, whose
 * production interval is `15` real seconds per attempt — whole multiples of
 * it for a fixture that needs more than one poll, paid for no behaviour this
 * suite is actually asserting on (the retry COUNT is the behaviour under
 * test; the wall-clock gap between attempts never is). Applied to every
 * fixture's child environment, ahead of `extraEnv`, so an individual
 * fixture's own explicit override (several already set one, to drive a
 * specific attempt-count scenario) still wins.
 */
export const DEFAULT_FAST_POLL_ENV: Record<string, string> = {
  VINAYA_DEV_REVIEW_LOOP_PR_POLL_INTERVAL_MS: '5',
  VINAYA_DEV_REVIEW_LOOP_GATE_POLL_INTERVAL_MS: '5',
  // Every fixture in this file carries no real forge
  // identity by design (`AEG_REPO` deleted above, the fake `git` binary
  // answers no remote) — the driver's own dispatch-readiness gate
  // (`dev-review-loop.ts`'s `checkTaskDispatchReadiness`) shells out to
  // `check-dispatch-readiness.ts`/`verify-dispatch.ts`, which read the live
  // forge over real HTTPS (never through the fake `gh` stand-in — the same
  // `@octokit/graphql` route `brief-render.test.ts`'s own doc comment
  // already names as unstubbable this way), so every fixture here would
  // otherwise refuse (or time out) before ever reaching the developer
  // dispatch it means to exercise. A fixture testing the gate itself
  // overrides this back via its own `extraEnv`.
  VINAYA_DEV_REVIEW_LOOP_FAKE_DISPATCH_READINESS: '1'
}

export function fixtureChildEnv(home: string, path: string, extraEnv: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('VINAYA_')) delete env[key]
  }
  delete env.AEG_REPO
  // Left in place, a leaked GITHUB_ACTIONS (an Actions runner sets one for
  // the whole job) makes the child's own log() resolve its destination to
  // 'none' (log-sink.ts's resolveLogDestinationFrom's CI branch — no
  // logs.url is configured for these fixtures), so every fixture here that
  // polls outboxLines() for a landed event times out on a CI runner while
  // passing on a laptop — the same leak #721 fixed for the in-process loop
  // harness's withWorldEnv.
  delete env.GITHUB_ACTIONS
  return {
    ...env,
    HOME: home,
    PATH: path,
    GITHUB_REPOSITORY: FIXTURE_GITHUB_REPOSITORY,
    ...DEFAULT_FAST_POLL_ENV,
    ...extraEnv
  }
}

/**
 * #668: `trustAnchorRepo()` (`config.ts`) checks `GITHUB_REPOSITORY` before
 * ever touching `git` — setting it here gives the trust-anchor read (only)
 * a deterministic, fake identity, without going anywhere near the fake
 * `git` binary's own `remote get-url origin` (unanswered, on purpose: every
 * fixture in this file relies on THAT call finding no remote, so
 * `resolveRepoSync` — a SEPARATE reader, `AEG_REPO` then `git remote`,
 * never `GITHUB_REPOSITORY` — keeps resolving the `unresolved` repo
 * segment every fixture's own `$HOME/.vinaya/runtime/unresolved/…` path
 * hardcodes). A real `GITHUB_REPOSITORY` leaking in from whatever host
 * runs this suite (an Actions runner sets one for the whole job) would
 * otherwise let a fixture's trust-anchor read resolve the HOST's own real
 * repository — masking exactly the "no forge identity in the environment"
 * host this task's fixtures must still pass on.
 */
export const FIXTURE_GITHUB_REPOSITORY = 'vinaya-fixture-owner/vinaya-fixture-repo'

/**
 * Generous on a quiet host (these fixtures only ever talk to the fake,
 * near-instant `claude`/`gh`/`git` stand-ins on `$PATH`, never the network)
 * and, not coincidentally, below the smallest per-test `it(..., N)` bound
 * used anywhere in this file (20000ms) — so a genuinely stuck subprocess
 * (the real, load-bearing case: lock contention on a path another fixture
 * or another concurrent task run still holds) is caught HERE, with the
 * child's own captured output, before the test framework's own outer
 * timeout can kill the whole run with no diagnostic at all.
 */
// Scenarios marked `it.skipIf(process.platform === 'darwin')` dispatch a fake
// developer or reviewer that signals through `$HOME`. The worker sandbox is
// always on where it is supported, so on macOS that dispatch is confined for
// real and cannot write there; the boundary has its own live coverage in
// `dispatch/worker-boundary.test.ts`, and these scenarios run on Linux CI.
export const SUBPROCESS_BUDGET_MS = 40_000

export function runDevReviewLoopArgs(
  home: string,
  cwd: string,
  path: string,
  args: string[],
  extraEnv: Record<string, string> = {},
  budgetMs: number = SUBPROCESS_BUDGET_MS
): CliResult {
  // `spawnSync` (never `execFileSync`) — it hands back stdout AND stderr on
  // BOTH the success and the non-zero-exit path; `execFileSync` only
  // surfaces piped stderr via the thrown error, so a passing run's own
  // stderr (task 7, #498: the stale-takeover line prints there even on a
  // clean publish) would otherwise be silently discarded.
  const r = spawnSync('bun', [INDEX, 'dev-review-loop', ...args], {
    encoding: 'utf8',
    cwd,
    env: fixtureChildEnv(home, path, extraEnv),
    timeout: budgetMs,
    killSignal: 'SIGKILL'
  })
  if (r.signal) {
    throw new Error(
      `dev-review-loop subprocess killed by ${r.signal} after exceeding its ${budgetMs}ms budget ` +
        `(args: ${args.join(' ')})\n--- stdout ---\n${r.stdout ?? ''}\n--- stderr ---\n${r.stderr ?? ''}`
    )
  }
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

export function postedCommentFiles(home: string): string[] {
  const dir = join(home, '.fake-gh-posted-comments')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.startsWith('comment-'))
    .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
}

export function outboxLines(home: string): Array<Record<string, unknown>> {
  // [task-files-v1] 5, O1: the default `logs` destination is now a folder
  // under this repository's own `runtimeDir` — `<runtimeDir>/logs/<repo>/
  // <task>.ndjson` — never the machine-global `~/.vinaya/outbox/` these
  // fixtures resolve to `unresolved` (no git origin in the scratch `cwd`).
  const p = join(home, '.vinaya', 'runtime', 'unresolved', 'logs', 'unresolved', `${TASK}.ndjson`)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

export function setUp(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-') // deliberately non-git — see writeFakeGit's doc comment
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaude(binDir)
  writeFakeGh(binDir)
  writeFakeGit(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

// --- pause and --resume (O2) ------------------------------------------------

/**
 * Code-reviewer escalates on round 1 (`ESCALATE: authority`) — `assessRound`
 * turns that into `pause{reason:'escalation'}` before any verdict is ever
 * held or posted. `$HOME/.escalated-once` distinguishes the two SEPARATE
 * `runDevReviewLoopArgs` invocations this scenario needs (same `$HOME`
 * across both): the first attempt escalates; the second — after `--resume`
 * reads a since-posted Principal ruling — reviews clean and publishes.
 */
export function writeFakeClaudePauseThenResumeScenario(dir: string): void {
  writeFakeBinary(
    dir,
    'claude',
    `#!/bin/sh
touch "$HOME/.fake-dev-invoked" 2>/dev/null
PROMPT="$(cat)"
WORKROOT="$HOME/.vinaya/runtime/unresolved/tasks-execution/$VINAYA_TASK"
case "$VINAYA_ROLE" in
  code-reviewer)
    if [ -f "$HOME/.escalated-once" ]; then
      ${fakeReviewResultShell('code-reviewer', 'rev-session-1', FAKE_CLEAN_CODE_REVIEW)}
    else
      touch "$HOME/.escalated-once"
      ${fakeReviewResultShell('code-reviewer', 'rev-session-1', FAKE_ESCALATED_CODE_REVIEW)}
    fi
    ;;
  security)
    ${fakeReviewResultShell('security-reviewer', 'sec-session-1', FAKE_CLEAN_SECURITY_REVIEW)}
    ;;
  *)
    mkdir -p "$WORKROOT"
    printf '%s\\n---\\n' "$PROMPT" >> "$WORKROOT/dev-prompts.txt"
    ${FAKE_DEVELOPER_TURN_RESULT}
    ;;
esac
exit 0
`
  )
}

export function driverLockPath(home: string): string {
  return join(taskRunDir(home), 'driver.pid.json')
}

export function writeDriverLockFixture(home: string, lock: { pid: number; startedAt: string }): void {
  const path = driverLockPath(home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(lock), 'utf8')
}

/** A pid that has definitely already exited — `spawnSync` blocks until the child is gone before returning its pid. */
export function deadPid(): number {
  const r = spawnSync('true', [])
  if (typeof r.pid !== 'number') throw new Error('spawnSync did not report a pid')
  return r.pid
}

export function setUpPauseResume(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudePauseThenResumeScenario(binDir)
  writeFakeGh(binDir)
  writeFakeGit(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

// --- O1 (`[task-operator-v1]`/Issue #662): the pause comment post itself is retried with backoff, and a run that exhausts every attempt still exits cleanly, resumable ---

/** Same as `writeFakeGh`, except the PAUSE comment's own post (the second `pr comment` call — the first is the round marker) fails exactly ONCE, then succeeds on retry. */
export function writeFakeGhPauseCommentFailsOnce(dir: string): void {
  writeFakeBinary(
    dir,
    'gh',
    `#!/bin/sh
if [ "$1" = "api" ] && [ "\${2#*contents/vinaya.config.json}" != "$2" ]; then
  # Served with \`principals\`, as \`writeFakeGh\`'s note explains.
  echo '${PRINCIPALS_CONFIG_B64}'
  exit 0
fi
STATE_DIR="$HOME/.fake-gh-posted-comments"
mkdir -p "$STATE_DIR"
if [ "$1" = "api" ] && case "$2" in repos/*/issues/*/comments*) true ;; *) false ;; esac; then
  "$0" issue view 0 --json comments | bun -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(JSON.stringify(j.comments.map((c) => ({ body: c.body, html_url: c.url ?? "", user: c.author ?? null }))))'
  exit 0
fi
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
  if [ "$N" = "1" ] && [ ! -f "$HOME/.pause-comment-failed-once" ]; then
    touch "$HOME/.pause-comment-failed-once" 2>/dev/null
    echo "fake gh: simulated transient failure on the pause comment post" >&2
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
if [ "$1" = "api" ] && [ "\${2#*actions/runs}" != "$2" ]; then
  exit 0 # no workflow runs: the CI reading rests on the check-runs alone
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

/** Same as \`writeFakeGhPauseCommentFailsOnce\`, except the pause comment's own post NEVER succeeds — every attempt fails, exhausting the retry bound. */
export function writeFakeGhPauseCommentNeverSucceeds(dir: string): void {
  writeFakeBinary(
    dir,
    'gh',
    `#!/bin/sh
if [ "$1" = "api" ] && [ "\${2#*contents/vinaya.config.json}" != "$2" ]; then
  # Served with \`principals\`, as \`writeFakeGh\`'s note explains.
  echo '${PRINCIPALS_CONFIG_B64}'
  exit 0
fi
STATE_DIR="$HOME/.fake-gh-posted-comments"
mkdir -p "$STATE_DIR"
if [ "$1" = "api" ] && case "$2" in repos/*/issues/*/comments*) true ;; *) false ;; esac; then
  "$0" issue view 0 --json comments | bun -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(JSON.stringify(j.comments.map((c) => ({ body: c.body, html_url: c.url ?? "", user: c.author ?? null }))))'
  exit 0
fi
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
    echo "fake gh: simulated persistent failure on the pause comment post" >&2
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
if [ "$1" = "api" ] && [ "\${2#*actions/runs}" != "$2" ]; then
  exit 0 # no workflow runs: the CI reading rests on the check-runs alone
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

export const FAST_PAUSE_RETRY_ENV = {
  VINAYA_DEV_REVIEW_LOOP_PAUSE_COMMENT_RETRY_ATTEMPTS: '3',
  VINAYA_DEV_REVIEW_LOOP_PAUSE_COMMENT_RETRY_BACKOFF_MS: '5'
}

// --- control-store-v1 task 6, #556: escalation record, resolution replay, cancel ---

export function escalationRecordPath(home: string, task: number, round: number, head: string): string {
  return join(controlDir(home, task), 'escalation', `${task}-${round}-${head}.json`)
}

export function resolutionRecordPath(home: string, task: number, round: number, head: string): string {
  return join(controlDir(home, task), 'resolution', `${task}-${round}-${head}.json`)
}

/** Every `epoch-NNNNNN.json` ownership claim on disk for `task`, sorted — used to prove a replayed/refused resolution attempt never bumps the shared epoch (code review, round 2, HIGH). */
export function ownershipEpochFiles(home: string, task: number): string[] {
  const dir = join(controlDir(home, task), 'ownership')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => /^epoch-\d+\.json$/.test(f))
    .sort()
}

export function seedRuling(home: string, commentName: string): void {
  writeFileSync(
    join(home, '.fake-gh-posted-comments', commentName),
    `<!-- aeg:principal:ruling:${TASK}-1 -->\nGo ahead.\n`
  )
}

// --- round 2: a genuine resume, not just a clean round 1 -------------------

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
export function writeFakeClaudeReviewerWritesNothingScenario(dir: string): void {
  writeFakeBinary(
    dir,
    'claude',
    `#!/bin/sh
touch "$HOME/.fake-dev-invoked" 2>/dev/null
PROMPT="$(cat)"
WORKROOT="$HOME/.vinaya/runtime/unresolved/tasks-execution/$VINAYA_TASK"
case "$VINAYA_ROLE" in
  code-reviewer)
    ${fakeReviewResultShell('code-reviewer', 'rev-session-1', FAKE_CLEAN_CODE_REVIEW)}
    ;;
  security)
    echo "invocation" >> "$HOME/.security-invocations"
    echo '{"session_id":"sec-session-1","usage":{"input_tokens":8,"output_tokens":4}}'
    ;;
  *)
    ${FAKE_DEVELOPER_TURN_RESULT}
    ;;
esac
exit 0
`
  )
}

/**
 * Same as `writeFakeGh`, except the mechanical check-run named `ci` answers
 * with TWO runs: an older `failure`, superseded by a newer `success` — the
 * exact shape PR #600 hit (`driver-lifecycle-v1` task 2, `#607`, O1). If the
 * driver's pause decision reads only the deduped, newest-per-name run, the
 * gate reads green off this alone; a regression that fell back to reading
 * the raw (undeduped) list would read this head as red and never reach round
 * 1's reviewer dispatch at all.
 */
export function writeFakeGhSupersededCiFailure(dir: string): void {
  writeFakeBinary(
    dir,
    'gh',
    `#!/bin/sh
if [ "$1" = "api" ] && [ "\${2#*contents/vinaya.config.json}" != "$2" ]; then
  # Every fixture's principalAllowlist()/reviewPolicy() call reaches
  # loadTrustAnchorConfig() with no injected fetcher (it runs inside this
  # spawned driver subprocess, past any in-process seam), so the stub serves
  # the default branch's vinaya.config.json naming the Principal, base64 as
  # the contents API returns it — the configured path every Principal-deciding
  # reader now requires.
  echo '${PRINCIPALS_CONFIG_B64}'
  exit 0
fi
STATE_DIR="$HOME/.fake-gh-posted-comments"
mkdir -p "$STATE_DIR"
if [ "$1" = "api" ] && case "$2" in repos/*/issues/*/comments*) true ;; *) false ;; esac; then
  "$0" issue view 0 --json comments | bun -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(JSON.stringify(j.comments.map((c) => ({ body: c.body, html_url: c.url ?? "", user: c.author ?? null }))))'
  exit 0
fi
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
if [ "$1" = "api" ] && [ "\${2#*actions/runs}" != "$2" ]; then
  exit 0 # no workflow runs: the CI reading rests on the check-runs alone
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

export function setUpSupersededCiFailure(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudeReviewerWritesNothingScenario(binDir)
  writeFakeGhSupersededCiFailure(binDir)
  writeFakeGit(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

// --- a result the controller rejects is infrastructure, never an uncaught
// throw ---

/**
 * Security returns a schema-valid ReviewResult whose objective result names
 * an id the brief never had — a credential-shaped one — on BOTH the first
 * dispatch and the retry. The controller rejects it as no review, retries
 * once, and turns it into the same `infrastructure` pause a missing result
 * gets — never a crash, and never the rejected value un-redacted in public.
 */
export function writeFakeClaudeReviewerWritesGarbageFindingsScenario(dir: string): void {
  writeFakeBinary(
    dir,
    'claude',
    `#!/bin/sh
touch "$HOME/.fake-dev-invoked" 2>/dev/null
PROMPT="$(cat)"
WORKROOT="$HOME/.vinaya/runtime/unresolved/tasks-execution/$VINAYA_TASK"
case "$VINAYA_ROLE" in
  code-reviewer)
    ${fakeReviewResultShell('code-reviewer', 'rev-session-1', FAKE_CLEAN_CODE_REVIEW)}
    ;;
  security)
    ${fakeReviewResultShell(
      'security-reviewer',
      'sec-session-garbage',
      '"status":"completed","summary":"none found — atta-labs/secret-scan passed","findings":[],"objectiveResults":[{"id":"token=ghp_abcdefghijklmnopqrstuvwxyz012345","status":"MET","evidence":"done"}]'
    )}
    echo "invocation" >> "$HOME/.security-invocations"
    ;;
  *)
    ${FAKE_DEVELOPER_TURN_RESULT}
    ;;
esac
exit 0
`
  )
}

export function setUpReviewerWritesGarbageFindings(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudeReviewerWritesGarbageFindingsScenario(binDir)
  writeFakeGh(binDir)
  writeFakeGit(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

// --- O2/O3: a red gate that the developer never fixes pauses, bounded ------

/**
 * The developer role only — reviewers are never reached in this scenario
 * (the mechanical gate never turns green). Marks `$HOME/.fake-dev-invoked`
 * (the same signal `writeFakeGit`'s `ls-remote` and `writeFakeGh`'s `pr
 * list` gate on) and otherwise does nothing — in particular, it never
 * touches the branch head, simulating a developer turn that produces no
 * push at all.
 */
export function writeFakeClaudeNeverPushes(dir: string): void {
  writeFakeBinary(
    dir,
    'claude',
    `#!/bin/sh
PROMPT="$(cat)"
touch "$HOME/.fake-dev-invoked" 2>/dev/null
N=$(ls "$HOME"/.dev-prompt-*.txt 2>/dev/null | wc -l | tr -d ' ')
printf '%s' "$PROMPT" > "$HOME/.dev-prompt-$((N + 1)).txt"
${FAKE_DEVELOPER_TURN_RESULT}
exit 0
`
  )
}

/** Same as \`writeFakeGh\`, except the mechanical check-run always reads red — this scenario's gate never turns green. */
export function writeFakeGhAlwaysRedCi(dir: string): void {
  writeFakeBinary(
    dir,
    'gh',
    `#!/bin/sh
if [ "$1" = "api" ] && [ "\${2#*contents/vinaya.config.json}" != "$2" ]; then
  # Every fixture's principalAllowlist()/reviewPolicy() call reaches
  # loadTrustAnchorConfig() with no injected fetcher (it runs inside this
  # spawned driver subprocess, past any in-process seam), so the stub serves
  # the default branch's vinaya.config.json naming the Principal, base64 as
  # the contents API returns it — the configured path every Principal-deciding
  # reader now requires.
  echo '${PRINCIPALS_CONFIG_B64}'
  exit 0
fi
STATE_DIR="$HOME/.fake-gh-posted-comments"
mkdir -p "$STATE_DIR"
if [ "$1" = "api" ] && case "$2" in repos/*/issues/*/comments*) true ;; *) false ;; esac; then
  "$0" issue view 0 --json comments | bun -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(JSON.stringify(j.comments.map((c) => ({ body: c.body, html_url: c.url ?? "", user: c.author ?? null }))))'
  exit 0
fi
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
if [ "$1" = "api" ] && [ "\${2#*actions/runs}" != "$2" ]; then
  exit 0 # no workflow runs: the CI reading rests on the check-runs alone
fi
if [ "$1" = "api" ] && [ "\${2#*check-runs}" != "$2" ]; then
  echo '{"id":1,"name":"Vinaya CI","status":"completed","conclusion":"failure"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "comments" ]; then
  echo '{"comments":[]}'
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
 * Same as `writeFakeGhAlwaysRedCi`, except the mechanical check-run named
 * `Vinaya CI` answers with TWO runs: an older `success`, superseded by a
 * newer `failure` (driver-lifecycle-v1 task 2, `#607`, O2 — the reverse of
 * the O1 fixture above). A genuinely failing CURRENT check must still pause
 * the loop exactly as a single failing run does — supersession only ever
 * suppresses a stale failure, never a live one.
 */
export function writeFakeGhSupersededSuccessThenCurrentFailure(dir: string): void {
  writeFakeBinary(
    dir,
    'gh',
    `#!/bin/sh
if [ "$1" = "api" ] && [ "\${2#*contents/vinaya.config.json}" != "$2" ]; then
  # Every fixture's principalAllowlist()/reviewPolicy() call reaches
  # loadTrustAnchorConfig() with no injected fetcher (it runs inside this
  # spawned driver subprocess, past any in-process seam), so the stub serves
  # the default branch's vinaya.config.json naming the Principal, base64 as
  # the contents API returns it — the configured path every Principal-deciding
  # reader now requires.
  echo '${PRINCIPALS_CONFIG_B64}'
  exit 0
fi
STATE_DIR="$HOME/.fake-gh-posted-comments"
mkdir -p "$STATE_DIR"
if [ "$1" = "api" ] && case "$2" in repos/*/issues/*/comments*) true ;; *) false ;; esac; then
  "$0" issue view 0 --json comments | bun -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(JSON.stringify(j.comments.map((c) => ({ body: c.body, html_url: c.url ?? "", user: c.author ?? null }))))'
  exit 0
fi
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
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "comments" ]; then
  echo '{"comments":[]}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "mergeable" ]; then
  echo '{"mergeable":"MERGEABLE"}'
  exit 0
fi
if [ "$1" = "api" ] && [ "\${2#*actions/runs}" != "$2" ]; then
  exit 0 # no workflow runs: the CI reading rests on the check-runs alone
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

export function setUpNeverPushesSupersededSuccessThenCurrentFailure(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudeNeverPushes(binDir)
  writeFakeGhSupersededSuccessThenCurrentFailure(binDir)
  writeFakeGit(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

// --- task-run-v1 13 (#508), O8: a base that moves past this driver's own code pauses `stale_driver` ---

/** Pushes and opens the PR on its one turn, and ALSO flips `.base-moved` — standing in for a separate PR merging into the base, touching the driver's own code, while this loop was running. */
export function writeFakeClaudeBaseMovesAfterFirstTurn(dir: string): void {
  writeFakeBinary(
    dir,
    'claude',
    `#!/bin/sh
PROMPT="$(cat)"
touch "$HOME/.fake-dev-invoked" 2>/dev/null
touch "$HOME/.base-moved" 2>/dev/null
${FAKE_DEVELOPER_TURN_RESULT}
exit 0
`
  )
}

// --- task-run-v1 15, O7: a moved base re-execs in place, reattaching to the same task, rather than pausing outright ---

/** Same as `writeFakeGitBaseMoves`, plus a `pull --ff-only origin main` that succeeds (touching a marker file so the test can prove the pull path was actually taken) rather than being unhandled. */
export function writeFakeGitBaseMovesWithSuccessfulPull(dir: string): void {
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
if [ "$1" = "merge-base" ]; then
  echo "${BASE_SHA}"
  exit 0
fi
if [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then
  echo "$PWD"
  exit 0
fi
if [ "$1" = "worktree" ] && [ "$2" = "add" ]; then
  # O1: the loop creates the task's own worktree at
  # start, before the first Developer dispatch — succeed without touching
  # real disk; nothing in this fixture reads the directory's own contents.
  exit 0
fi
if [ "$1" = "config" ]; then
  exit 0
fi
if [ "$1" = "fetch" ]; then
  exit 0
fi
if [ "$1" = "-C" ] && [ "$3" = "branch" ] && [ "$4" = "-u" ]; then
  # Principal ruling 1: after the commit-free ref push below creates the
  # remote branch, the loop sets the worktree's own upstream directly
  # (\`git -C <worktree> branch -u origin/<branch>\`) — succeed without
  # touching real disk.
  exit 0
fi
if [ "$1" = "-C" ] && [ "$3" = "push" ]; then
  # The Developer's own later publish push (\`publishRound\`/
  # \`developer-publication.ts\`) still runs FROM the worktree with an
  # explicit refspec — record it and succeed.
  echo "$@" >> "$HOME/.fake-git-pushes"
  exit 0
fi
if [ "$1" = "push" ]; then
  # Principal ruling 1: the loop creates the remote task branch with a
  # commit-free, \`--no-verify\`'d ref push (\`git push --no-verify origin
  # origin/main:refs/heads/<branch>\`), never \`git -C <worktree> push -u
  # origin HEAD\` — record it and succeed.
  echo "$@" >> "$HOME/.fake-git-pushes"
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
export function writeFakeClaudeBaseMovesThenCleanReview(dir: string): void {
  writeFakeBinary(
    dir,
    'claude',
    `#!/bin/sh
touch "$HOME/.fake-dev-invoked" 2>/dev/null
PROMPT="$(cat)"
WORKROOT="$HOME/.vinaya/runtime/unresolved/tasks-execution/$VINAYA_TASK"
case "$VINAYA_ROLE" in
  code-reviewer)
    ${fakeReviewResultShell('code-reviewer', 'rev-session-1', FAKE_CLEAN_CODE_REVIEW)}
    ;;
  security)
    ${fakeReviewResultShell('security-reviewer', 'sec-session-1', FAKE_CLEAN_SECURITY_REVIEW)}
    ;;
  *)
    touch "$HOME/.base-moved" 2>/dev/null
    ${FAKE_DEVELOPER_TURN_RESULT}
    ;;
esac
exit 0
`
  )
}

// --- O4 (Issue #662): a --resume-started run's own stale-driver re-exec never re-authenticates the ruling it already consumed ---

/**
 * Combines three scenarios already covered separately elsewhere in this
 * file — `writeFakeClaudePauseThenResumeScenario` (escalate, then `--resume`
 * past a Principal ruling), `writeFakeClaudeResumeScenario` (a real round 2,
 * forced by a round-1 BLOCKER), and `writeFakeClaudeBaseMovesAfterFirstTurn`
 * (touch a marker so the git fake reports a moved base) — into the one
 * sequence the origin incident actually hit: `--resume` authenticates a
 * ruling once, round 1 (the ruling round) redispatches the developer and
 * gets reviewed, and ONLY THEN — between round 1 concluding
 * `changes_requested` and round 2's own developer dispatch — does the base
 * move past this driver's own code. `$HOME/.round1-reviewed` is touched by
 * the code-reviewer's SECOND invocation (the post-resume one), so the base
 * only moves once round 1 has a held REQUEST-CHANGES verdict to recover
 * from — not before, which would re-litigate round 1 itself rather than
 * proving the driver reaches its NEXT developer turn.
 */
export function writeFakeClaudeResumeThenStaleDriverScenario(dir: string): void {
  writeFakeBinary(
    dir,
    'claude',
    `#!/bin/sh
touch "$HOME/.fake-dev-invoked" 2>/dev/null
PROMPT="$(cat)"
WORKROOT="$HOME/.vinaya/runtime/unresolved/tasks-execution/$VINAYA_TASK"
case "$VINAYA_ROLE" in
  code-reviewer)
    if [ ! -f "$HOME/.escalated-once" ]; then
      touch "$HOME/.escalated-once" 2>/dev/null
      ${fakeReviewResultShell('code-reviewer', `rev-session-'"$VINAYA_ROUND"'`, FAKE_ESCALATED_CODE_REVIEW)}
      exit 0
    fi
    if [ ! -f "$HOME/.round1-reviewed" ]; then
      touch "$HOME/.round1-reviewed" 2>/dev/null
      ${fakeReviewResultShell(
        'code-reviewer',
        `rev-session-'"$VINAYA_ROUND"'`,
        `"status":"completed","summary":"One blocker.","findings":[{"severity":"BLOCKER","file":"smoke.ts","line":1,"description":"deliberate round-1 blocker to force round 2"}],${FAKE_OBJECTIVES_MET}`
      )}
    else
      ${fakeReviewResultShell('code-reviewer', `rev-session-'"$VINAYA_ROUND"'`, FAKE_CLEAN_CODE_REVIEW)}
    fi
    ;;
  security)
    ${fakeReviewResultShell('security-reviewer', `sec-session-'"$VINAYA_ROUND"'`, FAKE_CLEAN_SECURITY_REVIEW)}
    ;;
  *)
    ${FAKE_DEVELOPER_TURN_RESULT}
    ;;
esac
exit 0
`
  )
}

/** Same as \`writeFakeGitBaseMovesWithSuccessfulPull\`, except keyed on \`$HOME/.round1-reviewed\` (round 1's own held verdict exists) rather than \`$HOME/.fake-dev-invoked\` (the developer's bare first turn) — the base must move only once there is a real prior round to recover, not before. */
export function writeFakeGitResumeStaleDriverPull(dir: string): void {
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
  if [ -f "$HOME/.round1-reviewed" ]; then
    echo "${'c'.repeat(40)}"
  else
    echo "${BASE_SHA}"
  fi
  exit 0
fi
if [ "$1" = "merge-base" ]; then
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
if [ "$1" = "worktree" ] && [ "$2" = "add" ]; then
  # O1: the loop creates the task's own worktree at
  # start, before the first Developer dispatch — succeed without touching
  # real disk; nothing in this fixture reads the directory's own contents.
  exit 0
fi
if [ "$1" = "config" ]; then
  exit 0
fi
if [ "$1" = "fetch" ]; then
  exit 0
fi
if [ "$1" = "-C" ] && [ "$3" = "branch" ] && [ "$4" = "-u" ]; then
  # Principal ruling 1: after the commit-free ref push below creates the
  # remote branch, the loop sets the worktree's own upstream directly
  # (\`git -C <worktree> branch -u origin/<branch>\`) — succeed without
  # touching real disk.
  exit 0
fi
if [ "$1" = "-C" ] && [ "$3" = "push" ]; then
  # The Developer's own later publish push (\`publishRound\`/
  # \`developer-publication.ts\`) still runs FROM the worktree with an
  # explicit refspec — record it and succeed.
  echo "$@" >> "$HOME/.fake-git-pushes"
  exit 0
fi
if [ "$1" = "push" ]; then
  # Principal ruling 1: the loop creates the remote task branch with a
  # commit-free, \`--no-verify\`'d ref push (\`git push --no-verify origin
  # origin/main:refs/heads/<branch>\`), never \`git -C <worktree> push -u
  # origin HEAD\` — record it and succeed.
  echo "$@" >> "$HOME/.fake-git-pushes"
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

export function setUpResumeThenStaleDriver(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaudeResumeThenStaleDriverScenario(binDir)
  writeFakeGh(binDir)
  writeFakeGitResumeStaleDriverPull(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

export const FAST_POLL_ENV = {
  VINAYA_DEV_REVIEW_LOOP_PR_POLL_MAX_ATTEMPTS: '5',
  VINAYA_DEV_REVIEW_LOOP_PR_POLL_INTERVAL_MS: '5',
  VINAYA_DEV_REVIEW_LOOP_GATE_POLL_MAX_ATTEMPTS: '5',
  VINAYA_DEV_REVIEW_LOOP_GATE_POLL_INTERVAL_MS: '5'
}

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
export function writeFakeGhCiGreenReviewGateRed(dir: string): void {
  writeFakeBinary(
    dir,
    'gh',
    `#!/bin/sh
if [ "$1" = "api" ] && [ "\${2#*contents/vinaya.config.json}" != "$2" ]; then
  # Every fixture's principalAllowlist()/reviewPolicy() call reaches
  # loadTrustAnchorConfig() with no injected fetcher (it runs inside this
  # spawned driver subprocess, past any in-process seam), so the stub serves
  # the default branch's vinaya.config.json naming the Principal, base64 as
  # the contents API returns it — the configured path every Principal-deciding
  # reader now requires.
  echo '${PRINCIPALS_CONFIG_B64}'
  exit 0
fi
STATE_DIR="$HOME/.fake-gh-posted-comments"
mkdir -p "$STATE_DIR"
if [ "$1" = "api" ] && case "$2" in repos/*/issues/*/comments*) true ;; *) false ;; esac; then
  "$0" issue view 0 --json comments | bun -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(JSON.stringify(j.comments.map((c) => ({ body: c.body, html_url: c.url ?? "", user: c.author ?? null }))))'
  exit 0
fi
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
if [ "$1" = "api" ] && [ "\${2#*actions/runs}" != "$2" ]; then
  exit 0 # no workflow runs: the CI reading rests on the check-runs alone
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

export function setUpPrincipalOwedRedReviewGate(): { home: string; cwd: string; path: string } {
  const home = tempDir('vinaya-drl-home-')
  const cwd = tempDir('vinaya-drl-cwd-')
  const binDir = tempDir('vinaya-drl-bin-')
  writeFakeClaude(binDir)
  writeFakeGhCiGreenReviewGateRed(binDir)
  writeFakeGit(binDir)
  return { home, cwd, path: `${binDir}:${pathWithoutRealVendors()}` }
}

/**
 * Same as `writeFakeGh`, except `gh issue view <blockedIssue> --json state`
 * — the one call the driver's own start-of-run sweep makes for a seeded,
 * unrelated task folder — blocks until `.fake-dev-invoked` exists (bounded,
 * so a genuine regression fails fast instead of hanging the whole test)
 * before answering `CLOSED`. Every other call behaves exactly as
 * `writeFakeGh`'s own.
 */
export function writeFakeGhSweepBlocksUntilDevInvoked(dir: string, blockedIssue: number): void {
  writeFakeBinary(
    dir,
    'gh',
    `#!/bin/sh
if [ "$1" = "api" ] && [ "\${2#*contents/vinaya.config.json}" != "$2" ]; then
  echo '${PRINCIPALS_CONFIG_B64}'
  exit 0
fi
STATE_DIR="$HOME/.fake-gh-posted-comments"
mkdir -p "$STATE_DIR"
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$3" = "${blockedIssue}" ] && [ "$4" = "--repo" ] && [ "$6" = "--json" ] && [ "$7" = "state" ]; then
  i=0
  while [ ! -f "$HOME/.fake-dev-invoked" ] && [ "$i" -lt 100 ]; do
    sleep 0.05
    i=$((i + 1))
  done
  if [ ! -f "$HOME/.fake-dev-invoked" ]; then
    touch "$HOME/.sweep-blocked-dispatch"
  fi
  echo '{"state":"CLOSED"}'
  exit 0
fi
if [ "$1" = "api" ] && case "$2" in repos/*/issues/*/comments*) true ;; *) false ;; esac; then
  "$0" issue view 0 --json comments | bun -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(JSON.stringify(j.comments.map((c) => ({ body: c.body, html_url: c.url ?? "", user: c.author ?? null }))))'
  exit 0
fi
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
if [ "$1" = "api" ] && [ "\${2#*actions/runs}" != "$2" ]; then
  exit 0 # no workflow runs: the CI reading rests on the check-runs alone
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
 * Same as `writeFakeGh`, except `gh issue view <revivedIssue> --json state`
 * answers `CLOSED` on its first call and `OPEN` on every call after — the
 * shape of a task revived (its Issue reopened) in the interval between the
 * sweep's first classification and its immediately-pre-removal recheck —
 * and `--json labels` for the same Issue answers with no `tranche` label,
 * so its branch derivation needs no further `--json title` call. Every
 * other call behaves exactly as `writeFakeGh`'s own.
 */
export function writeFakeGhSweepRevivedBetweenChecks(dir: string, revivedIssue: number): void {
  writeFakeBinary(
    dir,
    'gh',
    `#!/bin/sh
if [ "$1" = "api" ] && [ "\${2#*contents/vinaya.config.json}" != "$2" ]; then
  echo '${PRINCIPALS_CONFIG_B64}'
  exit 0
fi
STATE_DIR="$HOME/.fake-gh-posted-comments"
mkdir -p "$STATE_DIR"
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$3" = "${revivedIssue}" ] && [ "$4" = "--repo" ] && [ "$6" = "--json" ] && [ "$7" = "state" ]; then
  COUNT_FILE="$HOME/.sweep-${revivedIssue}-state-calls"
  N=0
  if [ -f "$COUNT_FILE" ]; then N=$(cat "$COUNT_FILE"); fi
  N=$((N + 1))
  echo "$N" > "$COUNT_FILE"
  if [ "$N" -eq 1 ]; then
    echo '{"state":"CLOSED"}'
  else
    echo '{"state":"OPEN"}'
  fi
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$3" = "${revivedIssue}" ] && [ "$4" = "--json" ] && [ "$5" = "labels" ]; then
  echo '{"labels":[]}'
  exit 0
fi
if [ "$1" = "api" ] && case "$2" in repos/*/issues/*/comments*) true ;; *) false ;; esac; then
  "$0" issue view 0 --json comments | bun -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(JSON.stringify(j.comments.map((c) => ({ body: c.body, html_url: c.url ?? "", user: c.author ?? null }))))'
  exit 0
fi
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
if [ "$1" = "api" ] && [ "\${2#*actions/runs}" != "$2" ]; then
  exit 0 # no workflow runs: the CI reading rests on the check-runs alone
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

// Issue #697: the start-of-run sweep no longer runs synchronously ahead of
// the run's own narration and the first dispatch — it is started, narrated
// as it goes, and never awaited before dispatch; a folder it finds
// `finished` is re-classified immediately before removal so a revival in
// the interval is never deleted on a stale answer.
/**
 * The sweep reads each Issue in the repository its folder belongs to and keeps the folder when none resolves, so the
 * two sweep fixtures below give the loop a resolvable repository (`AEG_REPO`) — and so a run directory under that
 * repository's own segment, not the `unresolved` one every other fixture here hardcodes.
 */
export const SWEEP_FIXTURE_REPO = 'sweep-owner/sweep-repo'

/** The fake `claude` writes a reviewer's report under the run directory, so it must name the same repo segment the loop now resolves. */
export function writeFakeClaudeForSweepRepo(binDir: string): void {
  writeFakeClaude(binDir)
  const claude = join(binDir, 'claude')
  writeFileSync(
    claude,
    readFileSync(claude, 'utf8').replaceAll('runtime/unresolved/', 'runtime/sweep-owner-sweep-repo/')
  )
}

export function sweepRunDir(home: string, task: number = TASK): string {
  return taskRunDir(home, task).replace(`${join('runtime', 'unresolved')}`, join('runtime', 'sweep-owner-sweep-repo'))
}

export function runLoopWithRepo(
  home: string,
  cwd: string,
  path: string,
  budgetMs: number = SUBPROCESS_BUDGET_MS
): CliResult {
  return runDevReviewLoopArgs(
    home,
    cwd,
    path,
    ['--task', String(TASK), '--agent', 'claude'],
    { AEG_REPO: SWEEP_FIXTURE_REPO },
    budgetMs
  )
}
