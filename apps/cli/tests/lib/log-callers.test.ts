import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/**
 * The sink's callers, checked against the real source tree — a passing
 * assertion here is a fact about the tree, not a belief about it.
 *
 *  - No file other than `apps/cli/src/lib/log-sink.ts` appends to the outbox,
 *    and the few that touch the outbox root for another purpose are named in
 *    an allowlist with the category of write they perform: truncating what
 *    the webhook drain delivered (`OUTBOX_TRUNCATE_ALLOWLIST`), writing a held
 *    verdict or pause state beside the log file (`OUTBOX_HELD_VERDICT_ALLOWLIST`),
 *    appending a batch (`OUTBOX_APPEND_ALLOWLIST`), and the files that only
 *    mention the outbox in prose or write somewhere else
 *    (`OUTBOX_RESUME_RECORD_ALLOWLIST`, `OUTBOX_PROSE_MENTION_ALLOWLIST`).
 *  - No file outside `CALLER_ALLOWLIST` imports the sink. Callers that only
 *    read the outbox path, or resolve the destination, are on it too; being
 *    on it says a file may import the sink, not which events it may emit.
 *  - Every `kind`/`event` pair the schema declares has a producer boundary
 *    that really emits it (`PRODUCER_BOUNDARIES`), or is named in
 *    `LOG_COVERAGE_EXEMPTIONS`.
 *  - Each event family has one row in `FAMILY_OWNERS`: the file or few files
 *    that may emit it. A file that emits a family outside its row fails, and
 *    so does a row naming a file that no longer emits it.
 */

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')
const SINK_PATH = 'apps/cli/src/lib/log-sink.ts'
const DISPATCH_PATH = 'apps/cli/src/lib/dispatch.ts'
const DEV_REVIEW_LOOP_PATH = 'apps/cli/src/lib/dev-review-loop.ts'
const DEV_REVIEW_LOOP_REVIEWER_DISPATCH_PATH = 'apps/cli/src/lib/dev-review-loop/reviewer-dispatch.ts'
const DEV_REVIEW_LOOP_PUBLICATION_PATH = 'apps/cli/src/lib/dev-review-loop/publication.ts'
const DEV_REVIEW_LOOP_PAUSE_RESUME_PATH = 'apps/cli/src/lib/dev-review-loop/pause-resume.ts'
const DEV_REVIEW_LOOP_JOURNAL_HISTORY_PATH = 'apps/cli/src/lib/dev-review-loop/journal-history.ts'
const LOG_SYNC_FOLDER_SOURCE_PATH = 'apps/cli/src/lib/log-sync-folder-source.ts'
const TASK_TOOLS_RESUME_PATH = 'apps/cli/src/lib/task-tools/resume.ts'
const TASK_TOOLS_CANCEL_PATH = 'apps/cli/src/lib/task-tools/cancel.ts'
const RUNNER_PATH = 'apps/cli/src/checks/runner.ts'
/**
 * The webhook destination is the sink's own delivery mechanism for a
 * `logs.url` server destination, not a second kind of caller: it reads the
 * same outbox, re-validates and re-redacts the same way, and truncates exactly
 * the lines the endpoint confirmed with a 2xx.
 */
const LOG_WEBHOOK_DRAIN_LIB_PATH = 'apps/cli/src/lib/log-webhook-drain.ts'
const EFFECTS_PATH = 'apps/cli/src/lib/effects.ts'
const BROKER_PATH = 'apps/cli/src/lib/broker.ts'
const SCHEMA_PATH = 'packages/aeg-core/src/log/schema.ts'
const ASSESS_ROUND_PATH = 'packages/aeg-core/src/dev-review-loop/assess-round.ts'
const FUTURE_CALLER_ALLOWLIST = new Set<string>([])
/**
 * `vinaya doctor` reports whether the configured destination actually works
 * (`apps/cli/specs/log.md` § `vinaya doctor` reports whether the destination
 * works), which means resolving the destination the way the sink itself does
 * rather than reading `logs` a second time — including bounding the
 * trust-anchor read with the sink's own deadline, so the two degrade alike
 * instead of doctor reporting an anchored destination the sink abandoned.
 * What it imports is the PURE decision function, BOTH of the sink's deadlines
 * (the per-event one and the longer once-per-process destination-read one it
 * bounds the anchor read by), the pure `describeFolderFallback` renderer so its
 * `[logs]` finding names a folder fallback in the sink's own words, and a
 * type — never `log()`, and never a sink instance: doctor produces no event, it
 * only asks where one would go. That narrower claim is asserted below rather
 * than assumed, so this entry cannot quietly widen into a second producer.
 */
const DOCTOR_PATH = 'apps/cli/src/commands/doctor.ts'
/**
 * `vinaya log send` delivers a repository's locally-held events to the
 * configured server, once. Like `DOCTOR_PATH` it is NOT a producer — it calls
 * no `log()` and builds no sink — it imports the sink's pure destination
 * resolution and outbox-path helpers plus the drain, to move a folder's events
 * into the retry queue and deliver every queue the SAME way a live event does.
 * It performs no raw outbox write of its own: every write goes through the
 * sink's own `appendHardenedLine`, so it never appears on the outbox-write
 * check below.
 */
const LOG_SEND_PATH = 'apps/cli/src/commands/log-send.ts'
/**
 * `vinaya log selftest` proves delivery end to end. Like `DOCTOR_PATH`
 * and `LOG_SEND_PATH` it is NOT a producer — it calls no `log()` and builds no
 * sink. It imports the sink's own unattended destination resolution
 * (`resolveUnattendedLogDestination`/`resolveUnattendedServerSetting`, so the
 * self-test resolves exactly as the loop does), the `logsCredentialMissing`
 * predicate, the `ResolvedLogDestination` type and `describeFolderFallback`,
 * and sends its one marked event through the server's ingest contract
 * directly. Same "imports the sink's pure helpers, never `log()`" shape.
 */
const LOG_SELFTEST_PATH = 'apps/cli/src/commands/log-selftest.ts'
/**
 * The writer of a consumer's own declared events: it checks one event
 * against `logs.events` and calls `log()` once — a `custom` line, or the
 * `operation` refusal naming why none was written. It never touches the
 * outbox path itself, so it joins `CALLER_ALLOWLIST` alone.
 */
const LOG_CUSTOM_PATH = 'apps/cli/src/lib/log-custom.ts'
/**
 * `vinaya log emit <event>` is `LOG_CUSTOM_PATH`'s
 * `emitCustomEvent` for a caller that is not Vinaya code at all — a script, a
 * CI step, another agent runtime. Like `LOG_SEND_PATH` and `LOG_SELFTEST_PATH`
 * it is NOT a producer of its own: the one `log()` call any successful
 * invocation makes happens inside `emitCustomEvent`, already allowlisted
 * above. It separately resolves the destination it just recorded toward, the
 * SAME way a live event does, importing the sink's pure `resolveLogDestinationFrom`,
 * `withDeadline`, `LOG_DESTINATION_ANCHOR_DEADLINE_MS` and the
 * `ResolvedLogDestination` type, plus `drainLogSink` to wait for its own write
 * to land before the process exits. Same "imports the sink's pure helpers,
 * never `log()` directly" shape as `LOG_SEND_PATH`/`LOG_SELFTEST_PATH`.
 */
const LOG_EMIT_PATH = 'apps/cli/src/commands/log-emit.ts'
/**
 * The CLI's one `cli_command` event at process exit: the entry script registers
 * the handler (and hands it `logSync`), and `cli-operation-log.ts` builds the
 * event, importing only the sink's types. Neither touches the outbox path
 * itself, so both join `CALLER_ALLOWLIST` alone.
 */
const CLI_ENTRY_PATH = 'apps/cli/src/index.ts'
const CLI_OPERATION_LOG_PATH = 'apps/cli/src/lib/cli-operation-log.ts'
/**
 * `vinaya sync` fills the local cache from this
 * repository's configured destination. Like `DOCTOR_PATH`, `LOG_SEND_PATH`
 * and `LOG_SELFTEST_PATH` it is NOT a producer — it calls no `log()` and
 * builds no sink. It imports the sink's pure `resolveLogDestinationFrom`
 * (the SAME attended/unattended decision `LOG_SEND_PATH` uses, never
 * forced), `logsCredentialMissing`, `withDeadline` and its
 * `LOG_DESTINATION_ANCHOR_DEADLINE_MS` bound, and the `ResolvedLogDestination`
 * type, to resolve where to read from — never where to write to.
 */
const LOG_SYNC_PATH = 'apps/cli/src/lib/log-sync.ts'
/** Exactly what `DOCTOR_PATH` is allowed to take from the sink module (sorted). */
const DOCTOR_SINK_IMPORTS = [
  'FolderFallbackRecord',
  'LOG_CONTEXT_LOOKUP_DEADLINE_MS',
  'LOG_DESTINATION_ANCHOR_DEADLINE_MS',
  'ResolvedLogDestination',
  'describeFolderFallback',
  'readFolderFallbackState',
  'resolveLogDestinationFrom',
  'withDeadline'
]
const CALLER_ALLOWLIST = new Set([
  ...FUTURE_CALLER_ALLOWLIST,
  LOG_WEBHOOK_DRAIN_LIB_PATH,
  DISPATCH_PATH,
  DEV_REVIEW_LOOP_PATH,
  DEV_REVIEW_LOOP_PAUSE_RESUME_PATH,
  DEV_REVIEW_LOOP_JOURNAL_HISTORY_PATH,
  LOG_SYNC_FOLDER_SOURCE_PATH,
  TASK_TOOLS_RESUME_PATH,
  TASK_TOOLS_CANCEL_PATH,
  RUNNER_PATH,
  EFFECTS_PATH,
  BROKER_PATH,
  DOCTOR_PATH,
  LOG_SEND_PATH,
  LOG_SELFTEST_PATH,
  LOG_CUSTOM_PATH,
  LOG_EMIT_PATH,
  CLI_ENTRY_PATH,
  CLI_OPERATION_LOG_PATH,
  LOG_SYNC_PATH
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
 * `dispatch.ts` durably records a run's vendor resume identifier under
 * `~/.vinaya/dispatch-resume/`, so an operator can answer a stopped agent with
 * `--resume <id>` instead of losing the session. That is a SIBLING of the
 * outbox under the same machine-local home, never the outbox itself — this
 * file names the outbox in prose because it polls it for its own log lines,
 * and the check below matches a file that merely mentions `outbox` and
 * separately calls a write. It cannot tell where the write points, so the
 * exemption is stated here rather than the check silently widened.
 *
 * `resume.ts` durably claims one request per escalation under
 * `~/.vinaya/task-resume/` — the identical sibling-of-the-outbox shape, named
 * in prose only because it reads the outbox root to derive the pause's own
 * control-store path, never to write there.
 */
const OUTBOX_RESUME_RECORD_ALLOWLIST = new Set([DISPATCH_PATH, TASK_TOOLS_RESUME_PATH])
const CONFIG_PATH = 'apps/cli/src/lib/config.ts'
const WORKER_BOUNDARY_PATH = 'apps/cli/src/lib/worker-boundary.ts'
/**
 * `worker-boundary.ts` names `outboxPathFor`'s own file in prose (the exact
 * literal path `dispatch.ts` grants a confined dispatch — see
 * `writableFiles`'s own doc comment), and separately calls `writeFileSync` to
 * write its OWN generated Seatbelt profile to a scratch temp dir, never to
 * the outbox itself. Same shape as `OUTBOX_RESUME_RECORD_ALLOWLIST`, above.
 */
const RUN_PATHS_PATH = 'apps/cli/src/lib/run-paths.ts'
const LOOP_LOG_PATH = 'apps/cli/src/lib/loop-log.ts'
/**
 * Every run file lives in one configured directory; the telemetry outbox stays
 * where it was. Both files below name the outbox in prose precisely to record
 * that they do NOT write there:
 *
 *   - `run-paths.ts` writes nothing at all — it is a pure path module. Its
 *     only match on this check's own write-call list is the word
 *     `writeFileSync` inside a doc comment explaining why the repo resolver
 *     is synchronous.
 *   - `loop-log.ts` really does `openSync`, but onto the task's own
 *     `output/driver.log`; its single mention of the outbox is the sentence
 *     saying the driver log deliberately lives nowhere near it.
 *
 * `log-sync-folder-source.ts` also really does call `openSync`, but always
 * `O_RDONLY`, to read a stream's own live or rotated file — never to append or
 * truncate the outbox path itself.
 *
 * Same shape as `OUTBOX_RESUME_RECORD_ALLOWLIST` and the entries above: the
 * check cannot tell where a write points, so the exemption is stated here
 * rather than the check silently widened.
 */
const OUTBOX_PROSE_MENTION_ALLOWLIST = new Set([
  CONFIG_PATH,
  WORKER_BOUNDARY_PATH,
  RUN_PATHS_PATH,
  LOOP_LOG_PATH,
  LOG_SYNC_FOLDER_SOURCE_PATH
])

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

describe('log-callers — the sink callers', () => {
  const files = allSourceFiles()
  expect(files.length).toBeGreaterThan(0)

  it('no file other than the sink (or the webhook drain, or a held-verdict writer) references the outbox alongside a write call', () => {
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

  it('doctor takes the destination decision from the sink and nothing else — never a producer', () => {
    const abs = files.find(([rel]) => rel === DOCTOR_PATH)?.[1]
    expect(abs, `${DOCTOR_PATH} not found by the scan — fix the walker, not this assertion`).toBeDefined()
    const content = readFileSync(abs as string, 'utf8')
    const clause = /import\s*\{([^}]*)\}\s*from\s+['"][^'"]*\/log-sink(?:\.js)?['"]/.exec(content)
    expect(
      clause,
      `${DOCTOR_PATH} must import from the sink by name, so this assertion can read what it took`
    ).not.toBeNull()
    const imported = ((clause as RegExpExecArray)[1] as string)
      .split(',')
      .map((part) => part.replace(/^\s*type\s+/, '').trim())
      .filter((part) => part.length > 0)
      .sort()
    expect(imported).toEqual(DOCTOR_SINK_IMPORTS)
  })

  it('the still-future allowlist entries name no file that exists yet — those chokepoints land in a later task', () => {
    const existing = files.map(([rel]) => rel)
    for (const allowed of FUTURE_CALLER_ALLOWLIST) {
      expect(existing).not.toContain(allowed)
    }
  })

  it('the dispatch allowlist entry names a file that exists', () => {
    const existing = files.map(([rel]) => rel)
    expect(existing).toContain(DISPATCH_PATH)
  })

  it('the dev-review-loop allowlist entry names a file that exists', () => {
    const existing = files.map(([rel]) => rel)
    expect(existing).toContain(DEV_REVIEW_LOOP_PATH)
  })

  it('the three dev-review-loop split-module allowlist entries name files that exist', () => {
    const existing = files.map(([rel]) => rel)
    expect(existing).toContain(DEV_REVIEW_LOOP_REVIEWER_DISPATCH_PATH)
    expect(existing).toContain(DEV_REVIEW_LOOP_PUBLICATION_PATH)
    expect(existing).toContain(DEV_REVIEW_LOOP_PAUSE_RESUME_PATH)
  })

  it('the tracker-posting and artifact sources are gone, not merely reduced', () => {
    const existing = new Set(files.map(([rel]) => rel))
    expect(existing.has('apps/cli/src/lib/log-flush.ts')).toBe(false)
    expect(existing.has('apps/cli/src/lib/log-artifact.ts')).toBe(false)
    expect(existing.has('apps/cli/src/commands/log.ts')).toBe(false)
    expect(existing.has('packages/aeg-core/src/log/artifact.ts')).toBe(false)
  })
})

/**
 * A command never calls another command through a child process, which
 * `apps/cli/specs/surface.md`'s "the rule" forbids as much as an in-process
 * call would. Not a whole-tree ban on ever spawning the CLI entry — `index.ts`'s
 * own author-repo self-defer and `pr-report.ts`'s isolated `check --all` run
 * are unrelated, legitimate uses of the same mechanism this scan does not
 * (and should not) flag — only a `log` subcommand run through the CLI entry,
 * and the `vinaya` binary itself.
 */
describe('log-callers — no command calls another through a child process', () => {
  const files = allSourceFiles()

  it('no source file under apps/cli/src spawns `vinaya` as a binary, or its own CLI entry to run a `log` subcommand, as a subprocess', () => {
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
 * Every task entry / producer boundary `apps/cli/specs/log.md` ("The families
 * shipped so far") documents maps to the `LogEventSchema` kind/event pairs it
 * is required to emit on every supported exit — checked against the real
 * source tree in BOTH directions, never a hand-trusted table alone:
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
 * `forge_write`'s three events are the one family named in
 * `LOG_COVERAGE_EXEMPTIONS` explicitly rather than silently passing (a
 * hand-trusted table that forgot to require them) or silently failing (this
 * file demanding a producer no caller needs).
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
    name: 'devReviewLoop driver — resume, cancel, unpushed-work resume, a failed reviewer report, liveness heartbeat and exit',
    files: [DEV_REVIEW_LOOP_PATH],
    requires: [
      { kind: 'dev_review_loop', event: 'resumed' },
      { kind: 'dev_review_loop', event: 'unpushed_work_resume' },
      { kind: 'dev_review_loop', event: 'cancelled' },
      { kind: 'dev_review_loop', event: 'infrastructure_retry' },
      // The driver's own liveness pair.
      { kind: 'dev_review_loop', event: 'driver_heartbeat' },
      { kind: 'dev_review_loop', event: 'driver_exited' },
      { kind: 'role_attempt', event: 'attempted' }
    ]
  },
  {
    name: 'runChecks — one gate `summary` per run, a `checked` observation per check that did not pass',
    files: [RUNNER_PATH],
    requires: [
      { kind: 'gate', event: 'summary' },
      { kind: 'gate', event: 'checked' }
    ]
  },
  {
    name: 'EffectExecutor — one final `verified` observation per idempotent external write',
    files: [EFFECTS_PATH],
    requires: [{ kind: 'effect', event: 'verified' }]
  },
  {
    name: 'broker — authenticate*Invocation / requestEffect',
    files: [BROKER_PATH],
    requires: [{ kind: 'operation', event: 'completed' }]
  },
  {
    name: 'emitCustomEvent — a declared event recorded, or its refusal',
    files: [LOG_CUSTOM_PATH],
    requires: [
      { kind: 'custom', event: 'recorded' },
      { kind: 'operation', event: 'completed' }
    ]
  },
  {
    name: 'task-tools cancel/resume handlers',
    files: [TASK_TOOLS_CANCEL_PATH, TASK_TOOLS_RESUME_PATH],
    requires: [{ kind: 'operation', event: 'completed' }]
  },
  {
    name: 'pause-resume — a human handoff raised at the escalation record write, resolved at the resolution record',
    files: [DEV_REVIEW_LOOP_PAUSE_RESUME_PATH],
    requires: [
      { kind: 'handoff', event: 'raised' },
      { kind: 'handoff', event: 'resolved' }
    ]
  }
]

/**
 * A kind/event pair no real caller emits — named explicitly so this file
 * neither silently passes nor silently fails on it. `forge_write`'s three
 * events have no producer: logs never reach a tracker or a code host. The
 * schema keeps the family so an old outbox line still parses
 * (`apps/cli/specs/log.md` § the envelope) — this exemption is what lets the
 * schema stay honest about its own history without a coverage check demanding
 * a producer that does not exist.
 */
const LOG_COVERAGE_EXEMPTIONS: RequiredEvent[] = [
  // `effect` `attempted`/`observed` stay in the schema so a line stored
  // before a write recorded one final event still reads; nothing emits them.
  { kind: 'effect', event: 'attempted' },
  { kind: 'effect', event: 'observed' },
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
  { exportName: 'EffectEventSchema', kind: 'effect' },
  { exportName: 'CustomEventSchema', kind: 'custom' }
]

describe('log coverage — every schema event maps to a producer boundary', () => {
  const schemaSource = readFileSync(join(REPO_ROOT, SCHEMA_PATH), 'utf8')
  const allDeclaredEvents = FAMILY_EXPORTS.flatMap(({ exportName, kind }) =>
    familyEventsFromSchema(schemaSource, exportName, kind)
  )

  it('sanity: the schema really does declare 32 kind/event pairs across 10 families today', () => {
    // A change to this number is a real schema change (a family or event
    // added/removed) — update it alongside PRODUCER_BOUNDARIES /
    // LOG_COVERAGE_EXEMPTIONS in the same diff, never silently.
    expect(allDeclaredEvents.length).toBe(32)
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

/**
 * Per-family ownership. Every event family the schema declares has one row in
 * `FAMILY_OWNERS`: the file or few files that may emit it. A file emits a
 * family when it calls the sink's logging function (`log`/`logSync`, however
 * the file reached it: an import, a sink built with `createLogSink`, or an
 * injected dependency) or a family emitter with an event of that family. The
 * walk reads the TypeScript syntax tree, so a string, comment or object that
 * merely carries a family's name is never an emission. A family whose events
 * go through a wrapper that hides the name is owned by the file holding that
 * wrapper, named in `FAMILY_EMITTERS`.
 */
const FAMILY_OWNERS: Record<string, readonly string[]> = {
  dispatch: [DISPATCH_PATH],
  role_attempt: [DISPATCH_PATH, DEV_REVIEW_LOOP_PATH],
  usage: [DISPATCH_PATH],
  dev_review_loop: [DEV_REVIEW_LOOP_PATH],
  gate: [RUNNER_PATH],
  effect: [EFFECTS_PATH],
  handoff: [DEV_REVIEW_LOOP_PAUSE_RESUME_PATH],
  custom: [LOG_CUSTOM_PATH],
  operation: [
    DISPATCH_PATH,
    BROKER_PATH,
    LOG_CUSTOM_PATH,
    TASK_TOOLS_RESUME_PATH,
    TASK_TOOLS_CANCEL_PATH,
    CLI_OPERATION_LOG_PATH
  ],
  // The schema keeps `forge_write` so an old line still parses; no file emits it.
  forge_write: []
}

/** A function that logs a whole batch of one family's events; calling it is an emission of that family. */
const FAMILY_EMITTERS: ReadonlyMap<string, string> = new Map([['logEvents', 'dev_review_loop']])

/** Names a sink function goes by at a call site: the sink's own, the aliases the producers import it as, and the parameter names it is injected under. */
const SINK_CALL_NAMES = new Set([
  'log',
  'logSync',
  'defaultLog',
  'defaultLogEvent',
  'logEvent',
  'logFn',
  'logEffectEvent',
  'emit'
])

type Emission = { file: string; family: string }

function importsSink(sf: ts.SourceFile): boolean {
  return sf.statements.some(
    (s) =>
      ts.isImportDeclaration(s) &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      /\/log-sink(?:\.js)?$/.test(s.moduleSpecifier.text)
  )
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text
  return null
}

/** The family a string-literal `kind` property (`'x'` or `'x' as const`) of an object literal names, if it is a declared family. */
function kindFamilyOf(obj: ts.ObjectLiteralExpression, families: ReadonlySet<string>): string | null {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop) || !(ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) continue
    if (prop.name.text !== 'kind') continue
    let value: ts.Expression = prop.initializer
    while (ts.isAsExpression(value) || ts.isParenthesizedExpression(value)) value = value.expression
    if (ts.isStringLiteralLike(value) && families.has(value.text)) return value.text
  }
  return null
}

/** How many declarations an event passed by name is followed through: the variable, then the local function that built it. */
const MAX_FOLLOWED_DECLARATIONS = 2

/**
 * Every declared family an argument expression carries: object literals in it with a `kind`, and — when it is a name or a call to a function this file declares — the same in what that declaration builds. Only the argument itself is followed, never names inside what it was built from, so an input that happens to carry a family's name is not an event.
 */
function familiesOfExpression(
  node: ts.Node,
  declarations: ReadonlyMap<string, ts.Node>,
  families: ReadonlySet<string>,
  out: Set<string>,
  followed = 0
): void {
  const collect = (n: ts.Node): void => {
    if (ts.isObjectLiteralExpression(n)) {
      const family = kindFamilyOf(n, families)
      if (family !== null) out.add(family)
    }
    ts.forEachChild(n, collect)
  }
  collect(node)
  const name = ts.isIdentifier(node)
    ? node.text
    : ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      ? node.expression.text
      : null
  const declared = name === null ? undefined : declarations.get(name)
  if (declared !== undefined && followed < MAX_FOLLOWED_DECLARATIONS) {
    familiesOfExpression(declared, declarations, families, out, followed + 1)
  }
}

/** Variables and functions a file declares at any depth, by name — the places an event passed by name is built. */
function declarationsOf(sf: ts.SourceFile): Map<string, ts.Node> {
  const out = new Map<string, ts.Node>()
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined)
      out.set(n.name.text, n.initializer)
    if (ts.isFunctionDeclaration(n) && n.name !== undefined && n.body !== undefined) out.set(n.name.text, n.body)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

/** The families a source text emits through the sink, read from its syntax tree. */
function emissionsOf(rel: string, source: string, families: ReadonlySet<string>): Emission[] {
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true)
  const sinkFile = importsSink(sf)
  const declarations = declarationsOf(sf)
  const found = new Set<string>()
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n)
      const emitterFamily = name === null ? undefined : FAMILY_EMITTERS.get(name)
      if (emitterFamily !== undefined && sinkFile) found.add(emitterFamily)
      if (name !== null && SINK_CALL_NAMES.has(name) && sinkFile) {
        for (const arg of n.arguments) familiesOfExpression(arg, declarations, families, found)
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return [...found].sort().map((family) => ({ file: rel, family }))
}

/** What a table violation reads like: a file emitting a family it does not own, or a row naming a file that does not emit that family. */
function ownershipViolations(
  owners: Readonly<Record<string, readonly string[]>>,
  emissions: readonly Emission[],
  existingFiles: ReadonlySet<string>
): string[] {
  const violations: string[] = []
  for (const { file, family } of emissions) {
    if (file === SINK_PATH) continue
    if (!(owners[family] ?? []).includes(file))
      violations.push(`${file} emits the ${family} family but is not one of its owners`)
  }
  const emitted = new Set(emissions.map((e) => `${e.file}\0${e.family}`))
  for (const [family, files] of Object.entries(owners)) {
    for (const file of files) {
      if (!existingFiles.has(file)) violations.push(`${family} names ${file}, which does not exist`)
      else if (!emitted.has(`${file}\0${family}`)) violations.push(`${family} names ${file}, which no longer emits it`)
    }
  }
  return violations
}

describe('log-callers — each family is emitted only from its owning files', () => {
  const schemaSource = readFileSync(join(REPO_ROOT, SCHEMA_PATH), 'utf8')
  const declaredFamilies = new Set(FAMILY_EXPORTS.map((f) => f.kind))
  const files = allSourceFiles()
  const existing = new Set(files.map(([rel]) => rel))
  const emissions = files.flatMap(([rel, abs]) => emissionsOf(rel, readFileSync(abs, 'utf8'), declaredFamilies))

  it('the table has one row for every family the schema declares, and no other', () => {
    expect(schemaSource.length).toBeGreaterThan(0)
    expect(Object.keys(FAMILY_OWNERS).sort()).toEqual([...declaredFamilies].sort())
  })

  it('every emission in the source tree is from an owner of its family, and every row names a file that still emits it', () => {
    expect(ownershipViolations(FAMILY_OWNERS, emissions, existing)).toEqual([])
  })

  it('an emission from a file outside its row fails, naming the file and the family', () => {
    const planted: Emission[] = [...emissions, { file: RUNNER_PATH, family: 'handoff' }]
    expect(ownershipViolations(FAMILY_OWNERS, planted, existing)).toEqual([
      `${RUNNER_PATH} emits the handoff family but is not one of its owners`
    ])
  })

  it('a row naming a file that no longer emits its family fails', () => {
    const owners = { ...FAMILY_OWNERS, gate: [RUNNER_PATH, EFFECTS_PATH] }
    expect(ownershipViolations(owners, emissions, existing)).toEqual([
      `gate names ${EFFECTS_PATH}, which no longer emits it`
    ])
  })

  it('a row naming a file that does not exist fails', () => {
    const owners = { ...FAMILY_OWNERS, gate: [RUNNER_PATH, 'apps/cli/src/lib/not-a-file.ts'] }
    expect(ownershipViolations(owners, emissions, existing)).toEqual([
      'gate names apps/cli/src/lib/not-a-file.ts, which does not exist'
    ])
  })

  it('reads calls from the syntax tree: a name in a string, comment or plain object is not an emission', () => {
    const source = [
      "import { log } from './log-sink.js'",
      "// log({ kind: 'gate', event: 'summary' })",
      'const text = "log({ kind: \'gate\' })"',
      "const ordinary = { kind: 'gate', event: 'x' }",
      'export function f() { return [text, ordinary] }'
    ].join('\n')
    expect(emissionsOf('apps/cli/src/lib/x.ts', source, declaredFamilies)).toEqual([])
  })

  it('finds a call to the sink with an event literal, an event named by a variable, and one built by a local function', () => {
    const source = [
      "import { log, logSync as sync } from './log-sink.js'",
      "export function a() { log({ kind: 'gate', event: 'summary', payload: {} }) }",
      "export function b() { const e = { kind: 'effect' as const, event: 'verified' }; log(e) }",
      "function build() { return { kind: 'operation', event: 'completed' } }",
      'export function c(deps: { logSync: (e: unknown) => void }) { deps.logSync(build()) }'
    ].join('\n')
    expect(emissionsOf('apps/cli/src/lib/x.ts', source, declaredFamilies).map((e) => e.family)).toEqual([
      'effect',
      'gate',
      'operation'
    ])
  })
})
