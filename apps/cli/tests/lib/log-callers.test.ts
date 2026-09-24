import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * O2: no file other than `apps/cli/src/lib/log-sink.ts` performs the
 * outbox append, and no file other than the named chokepoints calls
 * `log()`. Both are proved by walking the real source tree — a passing
 * assertion here is a fact about the tree, not a belief about it.
 *
 * Amended by task 2 (#405): `vinaya log flush` (`apps/cli/src/commands/log.ts`)
 * is the first real caller of either — it logs its own `forge_write` line
 * through `log()`, and it is the one file besides the sink allowed to touch
 * the outbox path directly, since truncation is a lifecycle half `log()`
 * itself never performs.
 *
 * Amended by task 3 (#406): `dispatchRole` (`apps/cli/src/lib/dispatch.ts`) —
 * NOT `dispatch-role.ts`, the earlier forward-looking guess this file's own
 * `FUTURE_CALLER_ALLOWLIST` once carried; the real Surface Map named
 * `dispatch.ts` — is the second real caller. It only reads the outbox (to
 * poll for its own lines actually landing before returning), never appends
 * or truncates, so it is not added to `OUTBOX_TRUNCATE_ALLOWLIST`.
 *
 * Amended by task 5 (#415): `devReviewLoop` (`apps/cli/src/lib/dev-review-loop.ts`)
 * is the third real caller, moved out of `FUTURE_CALLER_ALLOWLIST` now that
 * it exists. It reads the outbox the same way `dispatch.ts` does (polling
 * for its own log lines), and it separately WRITES under the outbox root —
 * but never the ndjson log file itself: `writeHeldVerdict` writes one
 * `<outboxRoot>/dev-review-loop/<task>/round-<n>-<role>.md` file per held
 * reviewer verdict, a third category next to log-sink's append and flush's
 * truncate. `OUTBOX_HELD_VERDICT_ALLOWLIST` names this explicitly rather
 * than silently widening `OUTBOX_TRUNCATE_ALLOWLIST` to cover a write it
 * does not describe.
 *
 * Amended by task 8 (`review-validity-v1`, `#506`, O8): the driver split
 * into `apps/cli/src/lib/dev-review-loop/`, one module per concern — a pure
 * move, no new write category. The under-outbox-root writes
 * `writeHeldVerdict` used to perform from inside `dev-review-loop.ts` itself
 * now run from three of those modules: `reviewer-dispatch.ts`
 * (`writeHeldVerdict`/`discardHeldVerdicts`), `publication.ts`
 * (`postForgeEffectOnce`'s effect-id bookkeeping), and `pause-resume.ts`
 * (pause state and the driver pid lock). Same allowlist, same reasoning,
 * now three paths instead of one.
 *
 * Amended by task 3 (`task-run-v1`, `#482`, O1/O2): the flush's own body —
 * the outbox truncate included — moved out of `apps/cli/src/commands/log.ts`
 * into `apps/cli/src/lib/log-flush.ts`'s `flushOutbox`, a real lib
 * chokepoint `devReviewLoop`'s round-end flush now calls in-process instead
 * of spawning a `vinaya log flush` subprocess. `FLUSH_PATH` (the command
 * file) drops out of both allowlists below — it no longer touches the
 * outbox or imports `log-sink.js` at all, only argv-parses and calls the
 * one lib function — and `LOG_FLUSH_LIB_PATH` takes its place in both.
 *
 * Amended by task 21 (`task-run-v1`, `#541`, O9): `journal-history.ts`
 * (`apps/cli/src/lib/dev-review-loop/`) imports `outboxPathFor` from
 * `log-sink.js` — never `log()` itself — to locate this machine's
 * still-unflushed outbox file for a task, reading it directly with
 * `readFileSync` rather than through the sink. Read-only, the same
 * "polls/reads, never appends or truncates" category `dispatch.ts` already
 * occupies in this allowlist, so it joins `CALLER_ALLOWLIST` alone, neither
 * truncate nor held-verdict allowlist.
 *
 * Amended by task-operator-v1 task 4 (#570): `resume.ts` and `cancel.ts`
 * (`apps/cli/src/lib/task-tools/`) each call `log()` once, emitting the
 * `operation`-family event their own handler's outcome resolves to (never a
 * write under the outbox root — the outbox truncate/held-verdict allowlists
 * are unaffected). Two real callers, not a single shared chokepoint, because
 * each handler owns its own outcome classification independently of the
 * other; both join `CALLER_ALLOWLIST` alone.
 *
 * Amended by #563: `runner.ts` (`apps/cli/src/checks/`)
 * is the `gate` family's own chokepoint — one `log()` call per check per
 * attempt, from `runOne`, plus a one-time `warmupLogSink()` call from
 * `runChecks` before dispatching a batch. Read-only against the outbox
 * itself (it never truncates or writes a held-verdict file), the same
 * "joins `CALLER_ALLOWLIST` alone" shape `journal-history.ts`/`resume.ts`/
 * `cancel.ts` already occupy above.
 *
 * Amended by task-log-v1 task 4 (#564): `log-artifact.ts`
 * (`apps/cli/src/lib/`) is a fourth write category, distinct from truncate
 * and held-verdict. Its export half reads every outbox file under the
 * outbox root and writes them, concatenated, to an UNRELATED destination
 * (a CI artifact file, never the outbox itself); its collect half APPENDS
 * an already-validated batch of records into the outbox for a target
 * Issue — before calling `flushOutbox` (already allowlisted) to publish
 * them. Neither truncates, and neither writes a held-verdict sibling file,
 * so `OUTBOX_APPEND_ALLOWLIST` is its own category rather than a stretch
 * of either existing one. It calls no `log()` of its own, so it does not
 * join `CALLER_ALLOWLIST`.
 *
 * Amended by `task-log-v1` 8 (Issue #626): `config.ts`
 * (`apps/cli/src/lib/config.ts`) documents the `logPublish` key's default
 * behavior in prose — "telemetry stays in the local, already-bounded
 * outbox" — the same "mentions `outbox`, separately calls a write" false
 * positive `OUTBOX_RESUME_RECORD_ALLOWLIST`'s own doc comment above already
 * describes: `config.ts`'s two `writeFileSync` calls write a resolved
 * config file and an unrelated store, never the outbox. `config.ts` never
 * imports `log-sink.js` either, so it is not a `CALLER_ALLOWLIST` member —
 * this exemption is scoped to the prose-mention check alone.
 *
 * Amended by task-log-v1 task 6 (#566, O1): `effects.ts`
 * (`EffectExecutor`) and `broker.ts` (`requestEffect`/`authenticate*Invocation`)
 * each call `log()` to emit the new `effect`/`operation` event families around
 * every real write, idempotent replay, and authorization outcome. Neither
 * touches the outbox path directly — both go through the sink's own append —
 * so they join `CALLER_ALLOWLIST` alone, the same "no truncate, no
 * held-verdict write" shape `journal-history.ts`/`resume.ts`/`cancel.ts`/
 * `runner.ts` already occupy above.
 *
 * Amended by task-files-v1 task 6 (O1): logs never reach a tracker or a code
 * host in any form, so the comment-posting flush and the artifact commands
 * are deleted outright, not merely reduced. `apps/cli/src/commands/log.ts`,
 * `apps/cli/src/lib/log-flush.ts` and `apps/cli/src/lib/log-artifact.ts` are
 * gone — `FLUSH_PATH`, `LOG_FLUSH_LIB_PATH` and `LOG_ARTIFACT_LIB_PATH`, and
 * every allowlist entry and test naming them, go with them.
 * `forge_write.validated/refused/written` — the flush's own line, logged
 * before it truncated what it posted — has no producer left at all now, so
 * it moves into `LOG_COVERAGE_EXEMPTIONS` alongside `handoff`, the same
 * "declared, not (or no longer) real" shape that entry already documents;
 * the schema keeps every `forge_write` operation so an old outbox/comment
 * line still parses (`apps/cli/specs/log.md` § the envelope). The webhook
 * destination survives as the one delivery mechanism a `logs.url` server
 * destination uses — renamed from `log-webhook-flush.ts`/`flushOutboxToWebhook`
 * to `log-webhook-drain.ts`/`drainOutboxToWebhook` now that there is no
 * sibling GitHub-comment flush left for "flush" to distinguish it from.
 */

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')
const SINK_PATH = 'apps/cli/src/lib/log-sink.ts'
const DISPATCH_PATH = 'apps/cli/src/lib/dispatch.ts'
const DEV_REVIEW_LOOP_PATH = 'apps/cli/src/lib/dev-review-loop.ts'
const DEV_REVIEW_LOOP_REVIEWER_DISPATCH_PATH = 'apps/cli/src/lib/dev-review-loop/reviewer-dispatch.ts'
const DEV_REVIEW_LOOP_PUBLICATION_PATH = 'apps/cli/src/lib/dev-review-loop/publication.ts'
const DEV_REVIEW_LOOP_PAUSE_RESUME_PATH = 'apps/cli/src/lib/dev-review-loop/pause-resume.ts'
const DEV_REVIEW_LOOP_JOURNAL_HISTORY_PATH = 'apps/cli/src/lib/dev-review-loop/journal-history.ts'
const TASK_TOOLS_RESUME_PATH = 'apps/cli/src/lib/task-tools/resume.ts'
const TASK_TOOLS_CANCEL_PATH = 'apps/cli/src/lib/task-tools/cancel.ts'
const RUNNER_PATH = 'apps/cli/src/checks/runner.ts'
/**
 * The webhook destination (`task-log-v1` 10, Issue #636) is the sink's own
 * delivery mechanism for a `logs.url` server destination, not a second kind
 * of caller: it reads the same outbox, re-validates and re-redacts the same
 * way, and truncates exactly the lines the endpoint confirmed with a 2xx.
 * Renamed from `log-webhook-flush.ts`/`flushOutboxToWebhook` to
 * `log-webhook-drain.ts`/`drainOutboxToWebhook` (task-files-v1 6, O1) now
 * that the tracker-posting flush it once stood alongside is deleted.
 */
const LOG_WEBHOOK_DRAIN_LIB_PATH = 'apps/cli/src/lib/log-webhook-drain.ts'
const EFFECTS_PATH = 'apps/cli/src/lib/effects.ts'
const BROKER_PATH = 'apps/cli/src/lib/broker.ts'
const SCHEMA_PATH = 'packages/aeg-core/src/log/schema.ts'
const ASSESS_ROUND_PATH = 'packages/aeg-core/src/dev-review-loop/assess-round.ts'
const FUTURE_CALLER_ALLOWLIST = new Set<string>([])
const CALLER_ALLOWLIST = new Set([
  ...FUTURE_CALLER_ALLOWLIST,
  LOG_WEBHOOK_DRAIN_LIB_PATH,
  DISPATCH_PATH,
  DEV_REVIEW_LOOP_PATH,
  DEV_REVIEW_LOOP_JOURNAL_HISTORY_PATH,
  TASK_TOOLS_RESUME_PATH,
  TASK_TOOLS_CANCEL_PATH,
  RUNNER_PATH,
  EFFECTS_PATH,
  BROKER_PATH
])
const OUTBOX_TRUNCATE_ALLOWLIST = new Set([LOG_WEBHOOK_DRAIN_LIB_PATH])
const OUTBOX_HELD_VERDICT_ALLOWLIST = new Set([
  DEV_REVIEW_LOOP_PATH,
  DEV_REVIEW_LOOP_REVIEWER_DISPATCH_PATH,
  DEV_REVIEW_LOOP_PUBLICATION_PATH,
  DEV_REVIEW_LOOP_PAUSE_RESUME_PATH
])
const OUTBOX_APPEND_ALLOWLIST = new Set<string>([])
/**
 * Amended by task 8 (#454, O8): `dispatch.ts` durably records a run's vendor
 * resume identifier under `~/.vinaya/dispatch-resume/`, so an operator can
 * answer a stopped agent with `--resume <id>` instead of losing the session.
 * That is a SIBLING of the outbox under the same machine-local home, never the
 * outbox itself — this file has always named the outbox in prose because it
 * polls it for its own log lines, and the check below matches a file that
 * merely mentions `outbox` and separately calls a write. It cannot tell where
 * the write points, so the exemption is stated here rather than the check
 * silently widened.
 *
 * Amended by task-operator-v1 task 4 (#570): `resume.ts` durably claims one
 * request per escalation under `~/.vinaya/task-resume/` — the identical
 * sibling-of-the-outbox shape as `dispatch.ts`'s own resume record above,
 * named in prose only because it reads the outbox root to derive the pause's
 * own control-store path, never to write there.
 */
const OUTBOX_RESUME_RECORD_ALLOWLIST = new Set([DISPATCH_PATH, TASK_TOOLS_RESUME_PATH])
const CONFIG_PATH = 'apps/cli/src/lib/config.ts'
const WORKER_BOUNDARY_PATH = 'apps/cli/src/lib/worker-boundary.ts'
/**
 * Amended by worker-isolation-v1 task 3 (#560, round 5 review, CRITICAL fix):
 * `worker-boundary.ts` names `outboxPathFor`'s own file in prose (the exact
 * literal path `dispatch.ts` grants a confined dispatch — see
 * `writableFiles`'s own doc comment), and separately calls `writeFileSync` to
 * write its OWN generated Seatbelt profile to a scratch temp dir, never to
 * the outbox itself. Same shape as `OUTBOX_RESUME_RECORD_ALLOWLIST`, above.
 */
const RUN_PATHS_PATH = 'apps/cli/src/lib/run-paths.ts'
const LOOP_LOG_PATH = 'apps/cli/src/lib/loop-log.ts'
/**
 * Amended by task-files-v1 task 1 (`#648`), which moved every run file into
 * one configured directory and left the telemetry outbox exactly where it
 * was. Both additions name the outbox in prose precisely to record that they
 * do NOT write there:
 *
 *   - `run-paths.ts` writes nothing at all — it is a pure path module. Its
 *     only match on this check's own write-call list is the word
 *     `writeFileSync` inside a doc comment explaining why the repo resolver
 *     is synchronous.
 *   - `loop-log.ts` really does `openSync`, but onto the task's own
 *     `output/driver.log`; its single mention of the outbox is the sentence
 *     saying the driver log deliberately lives nowhere near it.
 *
 * Same shape as `OUTBOX_RESUME_RECORD_ALLOWLIST` and the two entries above:
 * the check cannot tell where a write points, so the exemption is stated
 * here rather than the check silently widened.
 */
const OUTBOX_PROSE_MENTION_ALLOWLIST = new Set([CONFIG_PATH, WORKER_BOUNDARY_PATH, RUN_PATHS_PATH, LOOP_LOG_PATH])

function sourceFiles(dir: string, prefix: string): [string, string][] {
  const out: [string, string][] = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const abs = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.turbo') continue
    if (entry.isDirectory()) {
      out.push(...sourceFiles(abs, rel))
      continue
    }
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue
    out.push([rel, abs])
  }
  return out
}

/** Every non-test `.ts`/`.tsx` file under `apps/cli/src` and each `packages/<name>/src`, repo-relative. */
function allSourceFiles(): [string, string][] {
  const out: [string, string][] = [...sourceFiles(join(REPO_ROOT, 'apps/cli/src'), 'apps/cli/src')]
  const packagesDir = join(REPO_ROOT, 'packages')
  for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue
    out.push(...sourceFiles(join(packagesDir, pkg.name, 'src'), `packages/${pkg.name}/src`))
  }
  return out
}

const OUTBOX_WRITE_CALLS = ['openSync', 'appendFileSync', 'writeFileSync']

describe('log-callers — O2', () => {
  const files = allSourceFiles()
  expect(files.length).toBeGreaterThan(0)

  it('no file other than the sink (or the flush, or the held-verdict writer) references the outbox alongside a write call', () => {
    const offenders = files
      .filter(
        ([rel]) =>
          rel !== SINK_PATH &&
          !OUTBOX_TRUNCATE_ALLOWLIST.has(rel) &&
          !OUTBOX_HELD_VERDICT_ALLOWLIST.has(rel) &&
          !OUTBOX_RESUME_RECORD_ALLOWLIST.has(rel) &&
          !OUTBOX_APPEND_ALLOWLIST.has(rel) &&
          !OUTBOX_PROSE_MENTION_ALLOWLIST.has(rel)
      )
      .filter(([, abs]) => {
        const content = readFileSync(abs, 'utf8')
        return content.includes('outbox') && OUTBOX_WRITE_CALLS.some((call) => content.includes(call))
      })
      .map(([rel]) => rel)
    expect(offenders).toEqual([])
  })

  it('the sink itself really does perform the outbox append — the negative check above is not vacuous', () => {
    const sinkAbs = files.find(([rel]) => rel === SINK_PATH)?.[1]
    expect(sinkAbs, `${SINK_PATH} not found by the scan — fix the walker, not this assertion`).toBeDefined()
    const content = readFileSync(sinkAbs as string, 'utf8')
    expect(content.includes('outbox')).toBe(true)
    expect(OUTBOX_WRITE_CALLS.some((call) => content.includes(call))).toBe(true)
  })

  it('log() from log-sink is imported by no file outside the allowlist', () => {
    const importPattern = /from\s+['"][^'"]*\/log-sink(?:\.js)?['"]/
    const offenders = files
      .filter(([rel]) => rel !== SINK_PATH)
      .filter(([, abs]) => importPattern.test(readFileSync(abs, 'utf8')))
      .map(([rel]) => rel)
      .filter((rel) => !CALLER_ALLOWLIST.has(rel))
    expect(offenders).toEqual([])
  })

  it('the still-future allowlist entries name no file that exists yet — those chokepoints land in a later task', () => {
    const existing = files.map(([rel]) => rel)
    for (const allowed of FUTURE_CALLER_ALLOWLIST) {
      expect(existing).not.toContain(allowed)
    }
  })

  it('the dispatch allowlist entry does exist — task 3 is the landed caller, not a future one', () => {
    const existing = files.map(([rel]) => rel)
    expect(existing).toContain(DISPATCH_PATH)
  })

  it('the dev-review-loop allowlist entry does exist — task 5 is the landed caller, not a future one', () => {
    const existing = files.map(([rel]) => rel)
    expect(existing).toContain(DEV_REVIEW_LOOP_PATH)
  })

  it('the three dev-review-loop split-module allowlist entries do exist — task 8 is the landed split, not a future one', () => {
    const existing = files.map(([rel]) => rel)
    expect(existing).toContain(DEV_REVIEW_LOOP_REVIEWER_DISPATCH_PATH)
    expect(existing).toContain(DEV_REVIEW_LOOP_PUBLICATION_PATH)
    expect(existing).toContain(DEV_REVIEW_LOOP_PAUSE_RESUME_PATH)
  })

  it('log-flush.ts and log-artifact.ts are gone — the tracker-posting flush and the artifact commands are deleted, not merely reduced', () => {
    const existing = new Set(files.map(([rel]) => rel))
    expect(existing.has('apps/cli/src/lib/log-flush.ts')).toBe(false)
    expect(existing.has('apps/cli/src/lib/log-artifact.ts')).toBe(false)
    expect(existing.has('apps/cli/src/commands/log.ts')).toBe(false)
    expect(existing.has('packages/aeg-core/src/log/artifact.ts')).toBe(false)
  })
})

/**
 * task 3 (`task-run-v1`, `#482`, O2): `devReviewLoop`'s round-end flush used
 * to spawn `vinaya log flush --issue <task>` as a subprocess of its own CLI
 * entry (`execFileSync('bun', [cliEntry, 'log', 'flush', ...])`) — a
 * command calling a command through a child process, which
 * `apps/cli/specs/surface.md`'s "the rule" forbids as much as an in-process
 * call would. Not a whole-tree ban on ever spawning the CLI entry — `index.ts`'s
 * own author-repo self-defer and `pr-report.ts`'s isolated `check --all` run
 * are unrelated, legitimate uses of the same mechanism this scan does not
 * (and should not) flag — only the specific `log flush` subcommand shape
 * this task retired.
 */
describe('log-callers — O2 (task 3, #482): no internal subprocess flush', () => {
  const files = allSourceFiles()

  it('no source file under apps/cli/src spawns `vinaya` as a binary, or its own CLI entry to run `log flush`, as a subprocess', () => {
    // Array-literal argv shape only — a real spawn call, never a doc
    // comment's prose description of the anti-pattern (`doctor.ts` names
    // it, in backticks, as exactly what it does NOT do: `an
    // execFileSync('vinaya', …) here would hang this diagnostic`).
    const spawnsVinayaBinary = /(?:execFileSync|spawnSync|spawn)\(\s*['"]vinaya['"]\s*,\s*\[/
    const spawnsLogFlushSubcommand = /['"]log['"]\s*,\s*['"]flush['"]/
    const offenders = files
      .filter(([rel]) => rel.startsWith('apps/cli/src/'))
      .filter(([, abs]) => {
        const content = readFileSync(abs, 'utf8')
        return spawnsVinayaBinary.test(content) || spawnsLogFlushSubcommand.test(content)
      })
      .map(([rel]) => rel)
    expect(offenders).toEqual([])
  })
})

/**
 * O1 (task-log-v1 7, Issue #567): every task entry / producer boundary this
 * doctrine documents (`apps/cli/specs/log.md` "The families shipped so
 * far") maps to the `LogEventSchema` kind/event pairs it is required to
 * emit on every supported exit — checked against the real source tree in
 * BOTH directions, never a hand-trusted table alone:
 *
 *  - each `PRODUCER_BOUNDARIES` entry's own `requires` list is checked
 *    against that boundary's own named file(s) — a kind/event pair claimed
 *    here but missing an `event: '<name>'` literal in the file it names is
 *    a real coverage gap, not a passing belief;
 *  - every kind/event pair `packages/aeg-core/src/log/schema.ts` itself
 *    declares (derived from that file's own text, never a second hand-typed
 *    copy of it — `familyEventsFromSchema` below) is checked against the
 *    UNION of every boundary's `requires` list — a schema addition with no
 *    boundary claiming it, and no `LOG_COVERAGE_EXEMPTIONS` entry naming the
 *    gap explicitly, fails this file rather than silently shipping an
 *    uninstrumented event.
 *
 * `handoff` (`raised`/`resolved`) is the one family with zero real callers
 * anywhere in the tree today — declared, not yet real, the same
 * "declared here, enforced later" pattern this doctrine already applies to
 * `meta.lineage.attempt`/`meta.lineage.parent` (`apps/cli/specs/log.md`
 * "Attribution"). It is named in `LOG_COVERAGE_EXEMPTIONS` explicitly rather
 * than silently passing (a hand-trusted table that forgot to require it) or
 * silently failing (this file refusing to land until a task outside this
 * one's boundary wires a producer it was never asked to build).
 */

type RequiredEvent = { kind: string; event: string }
type ProducerBoundary = {
  name: string
  files: string[]
  requires: RequiredEvent[]
}

const PRODUCER_BOUNDARIES: ProducerBoundary[] = [
  {
    name: 'dispatchRole — every per-attempt exit path (pre-spawn refusal, spawn crash, timeout, clean exit)',
    files: [DISPATCH_PATH],
    requires: [
      { kind: 'dispatch', event: 'dispatched' },
      { kind: 'dispatch', event: 'outcome_received' },
      { kind: 'dispatch', event: 'dispatch_failed' },
      { kind: 'role_attempt', event: 'attempted' },
      { kind: 'usage', event: 'observed' }
    ]
  },
  {
    name: "assessRound's pure round-decision layer",
    files: [ASSESS_ROUND_PATH],
    requires: [
      { kind: 'dev_review_loop', event: 'loop_started' },
      { kind: 'dev_review_loop', event: 'round_started' },
      { kind: 'dev_review_loop', event: 'gate_result_read' },
      { kind: 'dev_review_loop', event: 'verdicts_read' },
      { kind: 'dev_review_loop', event: 'findings_compared' },
      { kind: 'dev_review_loop', event: 'stop_condition_met' },
      { kind: 'dev_review_loop', event: 'paused' },
      { kind: 'dev_review_loop', event: 'round_ended' },
      { kind: 'dev_review_loop', event: 'journal_finalized' }
    ]
  },
  {
    name: 'devReviewLoop driver — resume, cancel, unpushed-work resume, a failed reviewer report',
    files: [DEV_REVIEW_LOOP_PATH],
    requires: [
      { kind: 'dev_review_loop', event: 'resumed' },
      { kind: 'dev_review_loop', event: 'unpushed_work_resume' },
      { kind: 'dev_review_loop', event: 'cancelled' },
      { kind: 'dev_review_loop', event: 'infrastructure_retry' },
      { kind: 'role_attempt', event: 'attempted' }
    ]
  },
  {
    name: 'runOne — one gate `checked` observation per attempted check',
    files: [RUNNER_PATH],
    requires: [{ kind: 'gate', event: 'checked' }]
  },
  {
    name: 'EffectExecutor — attempted/observed/verified around every idempotent external write',
    files: [EFFECTS_PATH],
    requires: [
      { kind: 'effect', event: 'attempted' },
      { kind: 'effect', event: 'observed' },
      { kind: 'effect', event: 'verified' }
    ]
  },
  {
    name: 'broker — authenticate*Invocation / requestEffect',
    files: [BROKER_PATH],
    requires: [{ kind: 'operation', event: 'completed' }]
  },
  {
    name: 'task-tools cancel/resume handlers',
    files: [TASK_TOOLS_CANCEL_PATH, TASK_TOOLS_RESUME_PATH],
    requires: [{ kind: 'operation', event: 'completed' }]
  }
]

/**
 * A kind/event pair no real caller emits — named explicitly so this file
 * neither silently passes nor silently fails on it. `forge_write`'s three
 * events were `flushOutbox`'s own line, logged before it posted to a
 * tracker; that flush is deleted outright (task-files-v1 6, O1 — logs never
 * reach a tracker or a code host in any form), so no producer emits these
 * any more. The schema keeps the family so an old outbox/comment line still
 * parses (`apps/cli/specs/log.md` § the envelope) — this exemption is what
 * lets the schema stay honest about its own history without a coverage
 * check demanding a producer that no longer exists.
 */
const LOG_COVERAGE_EXEMPTIONS: RequiredEvent[] = [
  { kind: 'handoff', event: 'raised' },
  { kind: 'handoff', event: 'resolved' },
  { kind: 'forge_write', event: 'validated' },
  { kind: 'forge_write', event: 'refused' },
  { kind: 'forge_write', event: 'written' }
]

function pairKey(p: RequiredEvent): string {
  return `${p.kind}.${p.event}`
}

/** Every kind/event pair a boundary's own named file(s) do NOT actually contain a matching `event: '<name>'` literal for — the refusal this architecture test exists to raise. */
function missingFromBoundary(boundary: ProducerBoundary, byPath: ReadonlyMap<string, string>): RequiredEvent[] {
  const missing: RequiredEvent[] = []
  for (const required of boundary.requires) {
    const foundInAnyFile = boundary.files.some((rel) => {
      const content = byPath.get(rel)
      if (content === undefined) return false
      return new RegExp(`event:\\s*'${required.event}'`).test(content)
    })
    if (!foundInAnyFile) missing.push(required)
  }
  return missing
}

/**
 * Every `event: z.literal('<name>')` inside one family's own
 * `export const <exportName> = z.discriminatedUnion('event', [ ... ])`
 * block in `schema.ts`, paired with that family's own
 * `kind: z.literal('<expectedKind>')` declared just above it. Derived from
 * the real schema text — never a second, hand-typed copy of what
 * `schema.ts` already declares, so a family or event added there is caught
 * here without this file's own table ever being asked to notice by hand.
 */
function familyEventsFromSchema(schemaSource: string, exportName: string, expectedKind: string): RequiredEvent[] {
  const startMarker = `export const ${exportName} = z.discriminatedUnion('event', [`
  const start = schemaSource.indexOf(startMarker)
  if (start === -1) throw new Error(`log coverage: could not find ${exportName} in ${SCHEMA_PATH}`)
  const end = schemaSource.indexOf('\n])', start)
  if (end === -1) throw new Error(`log coverage: could not find the closing '])' for ${exportName}`)
  const body = schemaSource.slice(start, end)
  const nearby = schemaSource.slice(Math.max(0, start - 3000), start)
  if (!new RegExp(`kind: z\\.literal\\('${expectedKind}'\\)`).test(nearby)) {
    throw new Error(
      `log coverage: ${exportName}'s own shared object does not declare kind: z.literal('${expectedKind}') nearby — fix FAMILY_EXPORTS, not this assertion`
    )
  }
  const events: RequiredEvent[] = []
  const eventPattern = /event: z\.literal\('([a-z_]+)'\)/g
  let match: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
  while ((match = eventPattern.exec(body)) !== null) {
    events.push({ kind: expectedKind, event: match[1] as string })
  }
  return events
}

const FAMILY_EXPORTS: Array<{ exportName: string; kind: string }> = [
  { exportName: 'DispatchEventSchema', kind: 'dispatch' },
  { exportName: 'DevReviewLoopEventSchema', kind: 'dev_review_loop' },
  { exportName: 'ForgeWriteEventSchema', kind: 'forge_write' },
  { exportName: 'GateEventSchema', kind: 'gate' },
  { exportName: 'OperationEventSchema', kind: 'operation' },
  { exportName: 'UsageEventSchema', kind: 'usage' },
  { exportName: 'RoleAttemptEventSchema', kind: 'role_attempt' },
  { exportName: 'HandoffEventSchema', kind: 'handoff' },
  { exportName: 'EffectEventSchema', kind: 'effect' }
]

describe('log coverage — O1 (task-log-v1 7, Issue #567): every schema event maps to a producer boundary', () => {
  const schemaSource = readFileSync(join(REPO_ROOT, SCHEMA_PATH), 'utf8')
  const allDeclaredEvents = FAMILY_EXPORTS.flatMap(({ exportName, kind }) =>
    familyEventsFromSchema(schemaSource, exportName, kind)
  )

  it('sanity: the schema really does declare 28 kind/event pairs across 9 families today', () => {
    // A change to this number is a real schema change (a family or event
    // added/removed) — update it alongside PRODUCER_BOUNDARIES /
    // LOG_COVERAGE_EXEMPTIONS in the same diff, never silently.
    expect(allDeclaredEvents.length).toBe(28)
  })

  it('every declared kind/event pair is required by a producer boundary, or named in LOG_COVERAGE_EXEMPTIONS', () => {
    const claimed = new Set(PRODUCER_BOUNDARIES.flatMap((b) => b.requires).map(pairKey))
    const exempted = new Set(LOG_COVERAGE_EXEMPTIONS.map(pairKey))
    const uncovered = allDeclaredEvents.filter((e) => !claimed.has(pairKey(e)) && !exempted.has(pairKey(e)))
    expect(uncovered.map(pairKey)).toEqual([])
  })

  it('no LOG_COVERAGE_EXEMPTIONS entry names a pair the schema does not actually declare', () => {
    const declared = new Set(allDeclaredEvents.map(pairKey))
    const stale = LOG_COVERAGE_EXEMPTIONS.filter((e) => !declared.has(pairKey(e)))
    expect(stale.map(pairKey)).toEqual([])
  })

  it('every producer boundary really does emit every kind/event pair it claims, in its own named file(s)', () => {
    const files = allSourceFiles()
    const byPath = new Map(files.map(([rel, abs]) => [rel, readFileSync(abs, 'utf8')]))
    const offenders: string[] = []
    for (const boundary of PRODUCER_BOUNDARIES) {
      for (const m of missingFromBoundary(boundary, byPath)) offenders.push(`${boundary.name}: ${pairKey(m)}`)
    }
    expect(offenders).toEqual([])
  })

  it('refuses an uninstrumented path — the checker is not vacuous', () => {
    // Self-test: a boundary planted here on purpose, requiring an event its
    // own named file never emits, must be caught by the exact same
    // `missingFromBoundary` function the passing assertion above trusts —
    // proving a real gap in PRODUCER_BOUNDARIES would fail this file rather
    // than the check silently passing because it never runs the negative
    // case. This entry is never added to the real PRODUCER_BOUNDARIES list.
    const files = allSourceFiles()
    const byPath = new Map(files.map(([rel, abs]) => [rel, readFileSync(abs, 'utf8')]))
    const plantedUninstrumentedPath: ProducerBoundary = {
      name: 'planted uninstrumented path (self-test only — never a real boundary)',
      files: [RUNNER_PATH],
      requires: [{ kind: 'gate', event: 'this_event_is_never_emitted_by_runner_ts' }]
    }
    expect(missingFromBoundary(plantedUninstrumentedPath, byPath)).toEqual(plantedUninstrumentedPath.requires)
  })
})
