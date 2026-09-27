import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'bun:test'

/**
 * `vinaya task status` end-to-end, against a `gh` stub on `PATH` and a
 * scratch `$HOME` for the outbox — the Sizing story from `#515`'s
 * rationale: "a fake forge with three task Issues and an outbox with one
 * running pid, one pause record, one published effect marker prints three
 * lines in the three states; the single-task form prints the resume
 * command."
 */

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX = join(CLI_ROOT, 'src', 'index.ts')

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

type CliResult = { status: number; stdout: string; stderr: string }

/**
 * Issue #660, O3 — this process's OWN environment, when it is itself a
 * dispatched Developer/Reviewer session, carries `VINAYA_RUNTIME_DIR`
 * (checked before `$HOME` by `resolveRuntimeDirUncached`). Spreading
 * `...process.env` into this fixture's real subprocess hands it THIS
 * machine's real, shared runtime directory regardless of the fixture's own
 * isolated `$HOME` (`setUp()`'s own `env.HOME`) — the same leak already
 * fixed in `dev-review-loop.test.ts`, `dispatch.test.ts` and others. Caught
 * live: adding this file to `prePush.alwaysRun` (Issue #660, O2 round 2
 * review) made it run, unconditionally, in a dispatched session's own real
 * environment, where the driver-lock lookup below silently read the wrong
 * (real, shared) tree and reported "no driver" for a pid this fixture had
 * genuinely started.
 */
function stripVinayaEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  for (const key of Object.keys(out)) {
    if (key.startsWith('VINAYA_')) delete out[key]
  }
  // Left in place, a leaked GITHUB_ACTIONS makes a spawned child's own
  // log() resolve its destination to 'none' (log-sink.ts's
  // resolveLogDestinationFrom) instead of the folder/server a test expects
  // — the same leak #721 fixed for the in-process loop harness.
  delete out.GITHUB_ACTIONS
  return out
}

function runCli(args: string[], env: Record<string, string | undefined>): CliResult {
  try {
    const stdout = execFileSync('bun', [INDEX, ...args], {
      cwd: CLI_ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...stripVinayaEnv(process.env), ...env },
      timeout: 18_000,
      killSignal: 'SIGKILL'
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string; signal?: string | null }
    if (err.signal) {
      throw new Error(
        `vinaya task status subprocess killed by ${err.signal} after exceeding its budget (args: ${args.join(' ')})\n` +
          `--- stdout ---\n${err.stdout ?? ''}\n--- stderr ---\n${err.stderr ?? ''}`
      )
    }
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

/** Drops the shared trust-anchor helper's own stdout warning (`config.ts`'s `loadTrustAnchorConfig`) — a `gh` stub on `PATH` never resolves it, and the line belongs to that helper, not to this command's contract (`review-status.test.ts`'s own identical convention). */
function withoutTrustAnchorWarning(stdout: string): string {
  return stdout
    .split('\n')
    .filter((l) => !l.startsWith('⚠ could not read the trust-anchor config'))
    .join('\n')
}

/**
 * The table's own rows as cell arrays — the header first, then one per task.
 * The pipes are what make the output markdown wherever it is pasted and the
 * column padding is presentation (`renderTaskStatusTable` pads to the widest
 * cell); the cells are the contract. The markdown separator, the history
 * sentence and the read footer are lines ABOUT the table rather than rows of
 * it, and are asserted through `outputLines` instead.
 */
function tableCells(stdout: string): string[][] {
  return outputLines(stdout)
    .filter((line) => line.startsWith('|') && !/^\|[\s|-]+\|$/.test(line))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim())
    )
}

/** A timestamp this many minutes before now — what a run's control record carries while it sits in a phase, so the fixture asserts a real elapsed time rather than a frozen date drifting further out every day. */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}

function outputLines(stdout: string): string[] {
  return withoutTrustAnchorWarning(stdout)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
}

function principalComment(body: string) {
  return { body, author: { login: 'daniboomerang' } }
}

function frozenBriefComment(): { body: string; author: { login: string } } {
  return principalComment('<!-- aeg:brief:v1 -->\nBrief hash: deadbeef\n\nA brief body.')
}

const ISSUES = [
  { number: 601, title: '[demo] 1 — Running task', labels: [{ name: 'vinaya/tranche:demo' }] },
  { number: 602, title: '[demo] 2 — Paused task', labels: [{ name: 'vinaya/tranche:demo' }] },
  { number: 603, title: '[demo] 3 — Published task', labels: [{ name: 'vinaya/tranche:demo' }] },
  // O4: an open tranche task whose brief is NOT frozen yet — planned, never
  // started. The stub returns it an ordinary (non-frozen) comment, so it lists
  // as `not started` beside the others rather than being omitted.
  { number: 606, title: '[demo] 4 — Planned task, brief not frozen', labels: [{ name: 'vinaya/tranche:demo' }] },
  // O2: a backlog Issue — no `vinaya/tranche:*` label at all.
  // 604 carries an outbox dir (a real dispatched task) and is expected to
  // list; 605 carries none and must be pre-filtered before ever costing an
  // `issue view` call (the stub below fails loudly if 605 is ever fetched).
  { number: 604, title: 'A backlog bug that grew into a real task', labels: [] },
  { number: 605, title: 'An ordinary open Issue, never dispatched', labels: [] }
]

/**
 * Three merged task pull requests — the history the typical-time column is
 * computed from. Three is exactly the minimum number of past intervals the
 * reader answers at all, so a fixture with two would (correctly) report no
 * typical time.
 */
const MERGED_TASK_PRS = [
  { number: 801, headRefName: 'task/demo/past-1', mergedAt: '2026-09-20T12:00:00.000Z' },
  { number: 802, headRefName: 'task/demo/past-2', mergedAt: '2026-09-21T12:00:00.000Z' },
  { number: 803, headRefName: 'task/demo/past-3', mergedAt: '2026-09-22T12:00:00.000Z' },
  // Not a task branch — carries no round markers and is no task's history.
  { number: 804, headRefName: 'changeset-release/main', mergedAt: '2026-09-23T12:00:00.000Z' }
]

/** One past round: its marker, then its two verdicts six minutes later — a six-minute reviewing interval. */
const MERGED_PR_COMMENTS = [
  { ...principalComment('<!-- aeg:developer:round-1 -->\nHead: abc123'), createdAt: '2026-09-20T10:00:00.000Z' },
  { ...principalComment('VERDICT: APPROVE\n\nJudged head: abc123'), createdAt: '2026-09-20T10:06:00.000Z' },
  { ...principalComment('VERDICT: PASS\n\nJudged head: abc123'), createdAt: '2026-09-20T10:06:00.000Z' }
]

/**
 * The published summary table the confidence column reads for a run that has
 * published — the shape `renderSummary` actually posts for the common case: ONE
 * round, whose confidence cell is the not-asked glyph, because round 1 is never
 * asked for a confidence at all. A fixture claiming a round-1 percentage would
 * assert against a table the loop can never write.
 */
const PUBLISHED_SUMMARY_COMMENTS = [
  {
    ...principalComment(
      '| round | blocker | major | minor | critical | high | medium | low | confidence | outcome |\n' +
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n' +
        '| 1 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | — | green |'
    ),
    createdAt: '2026-09-22T12:00:00.000Z'
  }
]

const PR_BY_BRANCH: Record<string, number> = {
  'task/demo/1': 701,
  'task/demo/2': 702,
  'task/demo/3': 703,
  'task/issue-604': 704
}

/** A pull request's own head, shaped like a real sha so the table's abbreviation is the first seven characters of something a command could resolve. */
function headOf(pr: number): string {
  return `${pr}${'a'.repeat(37)}`
}

function checkRun(name: string, status: string, conclusion: string | null) {
  return { __typename: 'CheckRun', name, status, conclusion, startedAt: '2026-09-22T12:00:00Z' }
}

/**
 * What the forge reports on each task pull request's own head — the one payload
 * `task-status.ts`'s single `gh pr view` read per pull request asks for
 * (`headRefOid`, `statusCheckRollup` and `comments` together).
 *
 * One of each state the table has a word for: a suite still running (701), a
 * failed one (702), a green head whose review gate passed and whose verdicts
 * both judged that head (703 — the merge-ready row), and a green head with no
 * gate check reported yet (704).
 */
const PR_ROLLUP: Record<number, ReturnType<typeof checkRun>[]> = {
  701: [checkRun('Build, lint & typecheck', 'IN_PROGRESS', null)],
  702: [checkRun('Build, lint & typecheck', 'COMPLETED', 'FAILURE')],
  703: [
    checkRun('Build, lint & typecheck', 'COMPLETED', 'SUCCESS'),
    checkRun('vinaya review gate', 'COMPLETED', 'SUCCESS')
  ],
  704: [checkRun('Build, lint & typecheck', 'COMPLETED', 'SUCCESS')]
}

/** Both verdicts on 703's own head — principal-authored, and bound to the head the gate went green on. */
const PR_703_VERDICTS = [
  principalComment(`VERDICT: APPROVE\n\nJudged head: ${headOf(703)}\n`),
  principalComment(`VERDICT: PASS\n\nJudged head: ${headOf(703)}\n`)
]

function stubGh(home: string): string {
  const dir = join(home, 'fake-forge')
  mkdirSync(dir, { recursive: true })
  const gh = join(dir, 'gh')
  const prCases = Object.entries(PR_BY_BRANCH)
    .map(
      ([branch, number]) =>
        `    ${branch}) cat <<'JSON'\n${JSON.stringify([{ number, headRefName: branch }])}\nJSON\n    ;;`
    )
    .join('\n')
  // One `gh pr view` payload per task pull request, carrying the three fields
  // the status read asks for together — the same single read production makes.
  const prViewCases = Object.values(PR_BY_BRANCH)
    .map((pr) => {
      const comments = [
        ...(pr === 703 ? [...PUBLISHED_SUMMARY_COMMENTS, ...PR_703_VERDICTS] : []),
        ...(pr === 703 ? [] : MERGED_PR_COMMENTS)
      ]
      const payload = { headRefOid: headOf(pr), statusCheckRollup: PR_ROLLUP[pr] ?? [], comments }
      return `    ${pr}) cat <<'JSON'\n${JSON.stringify(payload)}\nJSON\n    ;;`
    })
    .join('\n')
  const script = `#!/bin/sh
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  cat <<'JSON'
${JSON.stringify(ISSUES)}
JSON
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  case "$3" in
    605)
      echo "gh stub: issue view unexpectedly called for Issue 605 (no outbox dir — must be pre-filtered, O2)" >&2
      exit 1
      ;;
    606)
      cat <<'JSON'
${JSON.stringify({ comments: [principalComment('just an ordinary reply, no frozen brief')] })}
JSON
      ;;
    *)
      cat <<'JSON'
${JSON.stringify({ comments: [frozenBriefComment()] })}
JSON
      ;;
  esac
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  case "$4" in
    merged) cat <<'JSON'
${JSON.stringify(MERGED_TASK_PRS)}
JSON
    ;;
${prCases}
    *) echo '[]' ;;
  esac
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  case "$3" in
${prViewCases}
    *) cat <<'JSON'
${JSON.stringify({ comments: MERGED_PR_COMMENTS })}
JSON
    ;;
  esac
  exit 0
fi
echo "gh stub: unhandled: $*" >&2
exit 1
`
  writeFileSync(gh, script)
  chmodSync(gh, 0o755)
  return dir
}

/**
 * Pinned so the runtime directory these fixtures write into is deterministic.
 * Without it, `run-paths.ts` resolves the repo from `git remote get-url
 * origin` in whatever checkout the test runs from, and the fixture and the
 * CLI under test would disagree about the directory on a fork or a rename.
 */
const FIXTURE_REPO_SEGMENT = 'acme-widget'

function setUp(): { home: string; env: Record<string, string> } {
  const home = tempDir('vinaya-task-status-home-')
  const forgeDir = stubGh(home)
  return {
    home,
    env: { HOME: home, PATH: `${forgeDir}:${process.env.PATH ?? ''}`, AEG_REPO: 'acme/widget' }
  }
}

/** The task's own run folder — `run-paths.ts`'s layout, written out by hand so these fixtures assert against literal strings rather than the code under test. */
function taskRunDir(home: string, task: number): string {
  return join(home, '.vinaya', 'runtime', FIXTURE_REPO_SEGMENT, 'tasks-execution', String(task))
}

/**
 * Places a fixture file by the same classification production uses: the
 * driver lock at the task folder's root, a held verdict in its own round's
 * folder, and the pause state and effect markers in `control/`.
 */
function writeRunFile(home: string, task: number, name: string, content: unknown): void {
  const held = /^round-(\d+)-(reviewer|security)\.md$/.exec(name)
  const dir = held
    ? join(taskRunDir(home, task), 'rounds', held[1] as string)
    : name === 'driver.pid.json'
      ? taskRunDir(home, task)
      : join(taskRunDir(home, task), 'control')
  const file = held ? `${held[2]}.md` : name
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), typeof content === 'string' ? content : JSON.stringify(content), 'utf8')
}

/**
 * A published round in the control store's own layout — both verdict effects at
 * `verified` under `<task>/control/effect/<key>.json`, plus the `loop_state`
 * record whose `round` bounds the shared `newestPublishedRound` reader. The
 * shape a clean publish leaves behind; retires the old flat
 * `control/effect-<key>.json` markers this task removed.
 */
function writePublishedRound(home: string, task: number, round: number, recordedAt = minutesAgo(2)): void {
  const control = join(taskRunDir(home, task), 'control')
  mkdirSync(control, { recursive: true })
  writeFileSync(
    join(control, 'loop-state.json'),
    JSON.stringify({
      version: 1,
      kind: 'loop_state',
      task,
      round,
      phase: 'publish',
      pauseReason: null,
      budgets: { mechanicalRetries: 0, reviewRounds: round, infrastructureRetries: 0 },
      heldResult: null,
      deliveredFindings: null,
      recordedAt
    })
  )
  const effectDir = join(control, 'effect')
  mkdirSync(effectDir, { recursive: true })
  for (const role of ['reviewer', 'security'] as const) {
    const key = `${round}-${role}-verdict`
    writeFileSync(
      join(effectDir, `${key}.json`),
      JSON.stringify({
        version: 1,
        kind: 'effect',
        task,
        key,
        operation: 'pr-comment',
        target: 'pr:703',
        inputVersion: round,
        payloadDigest: 'digest',
        status: 'verified',
        url: 'https://example.test/comment',
        recordedAt: '2026-09-10T00:00:00.000Z'
      })
    )
  }
}

/** The loop's own control record for a task mid-run: which round, which phase, and when it entered it. */
function writeLoopState(
  home: string,
  task: number,
  opts: { round: number; phase: string; minutesInPhase: number }
): void {
  const control = join(taskRunDir(home, task), 'control')
  mkdirSync(control, { recursive: true })
  writeFileSync(
    join(control, 'loop-state.json'),
    JSON.stringify({
      version: 1,
      kind: 'loop_state',
      task,
      round: opts.round,
      phase: opts.phase,
      pauseReason: opts.phase === 'pause' ? 'escalation' : null,
      budgets: { mechanicalRetries: 0, reviewRounds: opts.round, infrastructureRetries: 0 },
      heldResult: null,
      deliveredFindings: null,
      recordedAt: minutesAgo(opts.minutesInPhase)
    })
  )
}

/** The developer's own confidence statement for a round, at the path the loop's confidence prompt names for it. */
function writeStatedConfidence(home: string, task: number, round: number, body: string): void {
  const dir = join(taskRunDir(home, task), 'rounds', String(round), 'developer')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.vinaya-confidence'), body)
}

describe('vinaya task status — router wiring', () => {
  it("the 'task' router names 'status' among its expected subcommands", () => {
    const r = runCli(['task', 'bogus'], {})
    expect(r.status).toBe(2)
    expect(r.stderr).toContain("Unknown 'task' subcommand")
    expect(r.stderr).toContain('status')
  })
})

describe('vinaya task status (O1/O3 — the list form)', () => {
  it('prints one line per open task, each in its derived state — a planned task as not started (O4)', () => {
    const { home, env } = setUp()
    writeRunFile(home, 601, 'driver.pid.json', { pid: process.pid, startedAt: '2026-09-10T00:00:00.000Z' })
    writeRunFile(home, 602, 'pause-state.json', {
      task: 602,
      round: 1,
      head: 'abc123',
      branch: 'task/demo/2',
      prNumber: 702,
      reason: 'escalation',
      pausedAt: '2026-09-10T00:00:00.000Z'
    })
    writePublishedRound(home, 603, 1)

    // The driver clears the statement file at gate-green, before it persists a
    // `dispatch_reviewers` decision, so a `stated` figure only ever coexists
    // with `developing` — pairing it with `reviewing` would assert a state the
    // loop cannot produce.
    writeLoopState(home, 601, { round: 2, phase: 'dispatch_developer', minutesInPhase: 7 })
    writeStatedConfidence(home, 601, 2, 'CONFIDENCE: 90 — fixed the reported issue\n')
    writeLoopState(home, 602, { round: 1, phase: 'pause', minutesInPhase: 40 })
    // A live run actually IN the reviewing phase — the one shape a typical time
    // from history applies to, since history is only ever compared against a
    // phase a run is currently in.
    writeRunFile(home, 604, 'driver.pid.json', { pid: process.pid, startedAt: '2026-09-10T00:00:00.000Z' })
    writeLoopState(home, 604, { round: 3, phase: 'dispatch_reviewers', minutesInPhase: 4 })

    const r = runCli(['task', 'status'], env)

    expect(tableCells(r.stdout).slice(0, 6)).toEqual([
      [
        'task',
        'issue',
        'pr',
        'state',
        'round',
        'phase',
        'in phase',
        'confidence',
        'typical (history)',
        'head',
        'ci',
        'code review',
        'security',
        'gate'
      ],
      [
        '[demo] 1',
        '#601',
        '#701',
        `running (pid ${process.pid})`,
        '2',
        'developing',
        '7m',
        // The developer's own statement, for a round whose review has not
        // completed — marked, so it never reads as a round's outcome.
        '90% (round 2, stated)',
        // The fixture's merged pull requests carry reviewing intervals only, so
        // `developing` has no history to compare against (O4).
        '—',
        // Its own pull request's head, its suite still running, and no verdict
        // or gate conclusion on that head yet.
        '701aaaa',
        'running',
        '—',
        '—',
        '—'
      ],
      [
        '[demo] 2',
        '#602',
        '#702',
        'paused (escalation)',
        '1',
        'paused',
        '40m',
        '—',
        '—',
        '702aaaa',
        'red',
        '—',
        '—',
        '—'
      ],
      // A one-round published run: its summary's own round-1 cell is the
      // not-asked glyph, so the column reads as no record rather than telling a
      // reader the developer skipped a statement nothing ever requested. The
      // phase is marked last-recorded — nothing is publishing any more. Its
      // head is green, gated and approved — the merge-ready shape.
      [
        '[demo] 3',
        '#603',
        '#703',
        'published',
        '1',
        'publishing (last recorded)',
        '2m',
        '—',
        '—',
        '703aaaa',
        'green',
        'approve',
        'pass',
        'green'
      ],
      // O4: the planned task (brief not frozen) lists as not started, never
      // omitted — and every fact it has no record for reads as one dash, its
      // pull-request columns included: there is no pull request to read.
      ['[demo] 4', '#606', '—', 'not started', '—', '—', '—', '—', '—', '—', '—', '—', '—', '—'],
      // Three merged task pull requests of history, each a six-minute reviewing
      // interval — history, never a claim about this run.
      [
        '[backlog] 604',
        '#604',
        '#704',
        `running (pid ${process.pid})`,
        '3',
        'reviewing',
        '4m',
        '—',
        '6m (n=3)',
        '704aaaa',
        'green',
        '—',
        '—',
        '—'
      ]
    ])
    expect(withoutTrustAnchorWarning(r.stdout)).toContain('history, not a prediction')
    expect(r.status).toBe(0)
  })

  it('prints no driver for a frozen task with nothing in the outbox, and not started for a planned one', () => {
    const { env } = setUp()
    const r = runCli(['task', 'status'], env)
    expect(tableCells(r.stdout)).toEqual([
      [
        'task',
        'issue',
        'pr',
        'state',
        'round',
        'phase',
        'in phase',
        'confidence',
        'typical (history)',
        'head',
        'ci',
        'code review',
        'security',
        'gate'
      ],
      ['[demo] 1', '#601', '#701', 'no driver', '—', '—', '—', '—', '—', '701aaaa', 'running', '—', '—', '—'],
      ['[demo] 2', '#602', '#702', 'no driver', '—', '—', '—', '—', '—', '702aaaa', 'red', '—', '—', '—'],
      [
        '[demo] 3',
        '#603',
        '#703',
        'no driver',
        '—',
        '—',
        '—',
        '—',
        '—',
        '703aaaa',
        'green',
        'approve',
        'pass',
        'green'
      ],
      ['[demo] 4', '#606', '—', 'not started', '—', '—', '—', '—', '—', '—', '—', '—', '—', '—']
    ])
    // No row is in a phase, so no row carries a typical time — and the
    // history sentence is not printed at all (O4).
    expect(withoutTrustAnchorWarning(r.stdout)).not.toContain('history, not a prediction')
    expect(r.status).toBe(0)
  })

  // O2: a backlog Issue with a frozen brief and a driver lock
  // renders one row, right alongside the tranche-labeled ones — same shape,
  // `[backlog]` in place of a tranche slug and the Issue number as its id.
  // Issue 605 (no outbox dir at all) never appears — the pre-filter never
  // even asks the forge about it (the stub fails loudly if it does).
  it('lists a frozen backlog task beside tranche tasks — one row like a tranche task, in its derived state', () => {
    const { home, env } = setUp()
    writeRunFile(home, 601, 'driver.pid.json', { pid: process.pid, startedAt: '2026-09-10T00:00:00.000Z' })
    writeRunFile(home, 602, 'pause-state.json', {
      task: 602,
      round: 1,
      head: 'abc123',
      branch: 'task/demo/2',
      prNumber: 702,
      reason: 'escalation',
      pausedAt: '2026-09-10T00:00:00.000Z'
    })
    writePublishedRound(home, 603, 1)
    writeRunFile(home, 604, 'driver.pid.json', { pid: process.pid, startedAt: '2026-09-10T00:00:00.000Z' })

    const r = runCli(['task', 'status'], env)

    expect(tableCells(r.stdout).map((cells) => [cells[0], cells[1], cells[2], cells[3]])).toEqual([
      ['task', 'issue', 'pr', 'state'],
      ['[demo] 1', '#601', '#701', `running (pid ${process.pid})`],
      ['[demo] 2', '#602', '#702', 'paused (escalation)'],
      ['[demo] 3', '#603', '#703', 'published'],
      ['[demo] 4', '#606', '—', 'not started'],
      ['[backlog] 604', '#604', '#704', `running (pid ${process.pid})`]
    ])
    expect(r.status).toBe(0)
  })

  it('--json returns the same fields in the schema-1 envelope', () => {
    const { home, env } = setUp()
    writeRunFile(home, 601, 'driver.pid.json', { pid: process.pid, startedAt: '2026-09-10T00:00:00.000Z' })

    writeLoopState(home, 601, { round: 2, phase: 'dispatch_developer', minutesInPhase: 3 })

    const r = runCli(['task', 'status', '--json'], env)
    const parsed = JSON.parse(withoutTrustAnchorWarning(r.stdout)) as {
      schema: number
      data: { tasks: Array<Record<string, unknown>> }
    }
    expect(parsed.schema).toBe(1)
    // Three frozen tranche tasks plus the planned one (O4) — the planned task
    // carries the structured `not_started` state in the JSON envelope too.
    expect(parsed.data.tasks).toHaveLength(4)
    expect(parsed.data.tasks[0]).toEqual({
      tranche: 'demo',
      id: '1',
      issue: 601,
      pr: { number: 701 },
      state: { kind: 'running', pid: process.pid, startedAt: '2026-09-10T00:00:00.000Z' },
      round: 2,
      phase: 'developing',
      recordedPhase: 'dispatch_developer',
      minutesInPhase: 3,
      phaseIsCurrent: true,
      lastConfidence: null,
      lastConfidenceUnread: false,
      // Every past interval this fixture's history carries is a REVIEWING one;
      // developing has none, so this phase reports no typical time (O4).
      phaseHistory: null,
      // The pull-request facts the table's own head/CI/verdict/gate columns
      // render, carried in the envelope too — one forge read per pull request.
      prFacts: {
        head: `701${'a'.repeat(37)}`,
        ci: 'running',
        gate: null,
        codeReview: null,
        security: null
      }
    })
    expect(parsed.data.tasks[3]).toEqual({
      tranche: 'demo',
      id: '4',
      issue: 606,
      pr: null,
      state: { kind: 'not_started' },
      round: null,
      phase: null,
      recordedPhase: null,
      minutesInPhase: null,
      phaseIsCurrent: null,
      lastConfidence: null,
      lastConfidenceUnread: false,
      phaseHistory: null,
      // No pull request, so nothing was read and nothing is claimed.
      prFacts: null
    })
  })
})

describe('vinaya task status <tranche> <n> (O2 — the single-task form)', () => {
  it('prints the resume command for a paused task', () => {
    const { home, env } = setUp()
    writeRunFile(home, 602, 'pause-state.json', {
      task: 602,
      round: 1,
      head: 'abc123',
      branch: 'task/demo/2',
      prNumber: 702,
      reason: 'escalation',
      pausedAt: '2026-09-10T00:00:00.000Z'
    })
    writeRunFile(home, 602, 'round-1-reviewer.md', 'VERDICT: REQUEST CHANGES\n\nJudged head: abc123\n')
    writeRunFile(home, 602, 'round-1-security.md', 'VERDICT: PASS\n\nJudged head: abc123\n')
    writeLoopState(home, 602, { round: 1, phase: 'pause', minutesInPhase: 40 })

    const r = runCli(['task', 'status', 'demo', '2'], env)

    expect(tableCells(r.stdout)).toEqual([
      [
        'task',
        'issue',
        'pr',
        'state',
        'round',
        'phase',
        'in phase',
        'confidence',
        'typical (history)',
        'head',
        'ci',
        'code review',
        'security',
        'gate'
      ],
      [
        '[demo] 2',
        '#602',
        '#702',
        'paused (escalation)',
        '1',
        'paused',
        '40m',
        '—',
        '—',
        '702aaaa',
        'red',
        '—',
        '—',
        '—'
      ]
    ])
    // The verdict lines and the resume command are printed under the table,
    // never as rows of it.
    expect(outputLines(r.stdout)).toContain('reviewer (round 1): VERDICT: REQUEST CHANGES')
    expect(outputLines(r.stdout)).toContain('security (round 1): VERDICT: PASS')
    expect(outputLines(r.stdout)).toContain('Resume with: vinaya dev-review-loop --resume 702')
    expect(r.status).toBe(0)
  })

  it("marks a resumed-then-stopped task's phase as last recorded, even though its stale pause record still names it paused", () => {
    const { home, env } = setUp()
    // The exact shape a task that paused at round 1, resumed, and then died
    // mid-round leaves behind: the pause record is never cleared on resume, so
    // the state reads `paused` while the control record names round 2 and the
    // phase the run was actually working in.
    writeRunFile(home, 602, 'pause-state.json', {
      task: 602,
      round: 1,
      head: 'abc123',
      branch: 'task/demo/2',
      prNumber: 702,
      reason: 'escalation',
      pausedAt: '2026-09-10T00:00:00.000Z'
    })
    writeLoopState(home, 602, { round: 2, phase: 'dispatch_developer', minutesInPhase: 90 })

    const r = runCli(['task', 'status', 'demo', '2'], env)

    const row = tableCells(r.stdout)[1] as string[]
    expect(row.slice(4, 7)).toEqual(['2', 'developing (last recorded)', '90m'])
    expect(r.status).toBe(0)
  })

  it('prints no resume line for a published task', () => {
    const { home, env } = setUp()
    writePublishedRound(home, 603, 1)

    const r = runCli(['task', 'status', 'demo', '3'], env)

    expect(tableCells(r.stdout)).toEqual([
      [
        'task',
        'issue',
        'pr',
        'state',
        'round',
        'phase',
        'in phase',
        'confidence',
        'typical (history)',
        'head',
        'ci',
        'code review',
        'security',
        'gate'
      ],
      [
        '[demo] 3',
        '#603',
        '#703',
        'published',
        '1',
        'publishing (last recorded)',
        '2m',
        '—',
        '—',
        '703aaaa',
        'green',
        'approve',
        'pass',
        'green'
      ]
    ])
    expect(r.status).toBe(0)
  })

  it('reads a planned task (brief not frozen) as not started, never a no-brief refusal (O4)', () => {
    const { env } = setUp()
    const r = runCli(['task', 'status', 'demo', '4'], env)
    expect(tableCells(r.stdout)).toEqual([
      [
        'task',
        'issue',
        'pr',
        'state',
        'round',
        'phase',
        'in phase',
        'confidence',
        'typical (history)',
        'head',
        'ci',
        'code review',
        'security',
        'gate'
      ],
      ['[demo] 4', '#606', '—', 'not started', '—', '—', '—', '—', '—', '—', '—', '—', '—', '—']
    ])
    expect(r.status).toBe(0)
  })

  it('refuses naming the task when it is not an open task Issue', () => {
    const { env } = setUp()
    const r = runCli(['task', 'status', 'demo', '99'], env)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('task 99 in tranche `demo` is not an open task Issue')
  })

  it('refuses with usage on a lone tranche argument', () => {
    const { env } = setUp()
    const r = runCli(['task', 'status', 'demo'], env)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('Usage: vinaya task status')
  })
})

// task-run-v1 task 15, O6: `--follow` tails the task's per-run driver log
// live — argv refusals here, the tail-read wiring proven with a bounded
// (timeout-killed, `tail -f` is never expected to exit on its own) run below.
describe('vinaya task status --follow (task-run-v1 task 15, O6)', () => {
  it('refuses with usage when --follow is given with no tranche/n and no --issue', () => {
    const { env } = setUp()
    const r = runCli(['task', 'status', '--follow'], env)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('Usage: vinaya task status')
  })

  it('refuses a non-numeric --issue value', () => {
    const { env } = setUp()
    const r = runCli(['task', 'status', '--issue', 'nope', '--follow'], env)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('--issue must be numeric')
  })

  it('refuses naming the task when the <tranche> <n> form does not resolve to an open task Issue', () => {
    const { env } = setUp()
    const r = runCli(['task', 'status', 'demo', '99', '--follow'], env)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('task 99 in tranche `demo` is not an open task Issue')
  })

  it("--issue <n> --follow prints the log file's existing content, then keeps running (killed by timeout, same as a real tail -f)", () => {
    const { home, env } = setUp()
    const logPath = join(taskRunDir(home, 521), 'output', 'driver.log')
    mkdirSync(dirname(logPath), { recursive: true })
    writeFileSync(
      logPath,
      '=== run started 2026-09-12T00:00:00.000Z role=dev-review-loop pid=1 ===\n[developer] hello\n'
    )

    let caught: { stdout?: string } | null = null
    try {
      execFileSync('bun', [INDEX, 'task', 'status', '--issue', '521', '--follow'], {
        cwd: CLI_ROOT,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...stripVinayaEnv(process.env), ...env },
        timeout: 1500,
        killSignal: 'SIGKILL'
      })
    } catch (e) {
      caught = e as { stdout?: string }
    }
    expect(caught).not.toBeNull()
    expect(String(caught?.stdout ?? '')).toContain('[developer] hello')
  })
})
