import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSyncBudgeted, stripVinayaEnv } from './process-fixture.js'
import {
  createLogSink,
  OUTBOX_MAX_BYTES,
  resolveLogAppendPath,
  setBranchIssueFallback,
  taskRefFromBranch,
  type LogSinkDeps
} from '../../src/lib/log-sink.js'

// `resolveDoctrine`'s `git` calls run inside `log()`'s `.then()` chain; in a
// non-repo temp dir the first call fails (fast, but not instant), and a
// `setImmediate` racing that isn't reliable — a longer real delay is.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 100))

const DISPATCHED = {
  kind: 'dispatch' as const,
  event: 'dispatched' as const,
  payload: {},
  target_role: 'developer' as const,
  model: 'sonnet',
  effect_id: 'e1',
  prompt_hash: 'sha256:abc'
}

function testDeps(overrides: Partial<LogSinkDeps> = {}): { dir: string; deps: Partial<LogSinkDeps> } {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-log-sink-'))
  return {
    dir,
    deps: {
      outboxRoot: () => join(dir, 'outbox'),
      // Every test in this file asserts against `<dir>/outbox/...` — a
      // fixed folder destination reproduces that layout exactly, leaving
      // the `logs` setting's own resolution (default folder, server queue
      // + drain, trust-anchor gating) to `log-destination.test.ts`
      // ([task-files-v1] 5).
      resolveLogDestination: () => ({ kind: 'folder', folder: join(dir, 'outbox') }),
      home: () => dir,
      hostname: () => 'test-host',
      cwd: () => dir,
      now: () => new Date('2026-09-05T00:00:00.000Z'),
      env: () => ({ VINAYA_ROLE: 'developer', VINAYA_TASK: '404' }),
      resolveRepo: () => Promise.resolve({ owner: 'atta-labs', repo: 'vinaya' }),
      // Injected like every other read this harness stubs: left to the real
      // default, a test running inside this repository's own task worktree
      // would shell out to `git`/`gh` and attribute its fixture events to
      // whatever task the checkout happens to be on.
      resolveBranchIssue: () => Promise.resolve(null),
      vinayaVersion: () => '0.24.1',
      stderr: () => {},
      ...overrides
    }
  }
}

describe('log-sink — a valid line', () => {
  it('appends one ndjson line whose meta/subject are filled from the injected environment', async () => {
    const { dir, deps } = testDeps()
    const { log } = createLogSink(deps)
    log(DISPATCHED)
    await flush()
    const path = join(dir, 'outbox', 'atta-labs-vinaya', '404.ndjson')
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]!)
    expect(parsed.subject.role).toBe('developer')
    expect(parsed.subject.issue).toBe(404)
    expect(parsed.meta.repo).toBe('atta-labs/vinaya')
    expect(parsed.meta.host).toBe('cli')
  })

  it("defaults meta.lineage.run to this sink's own runId when VINAYA_RUN is unset (task-log-v1 task 6, O1: 'linked to the current run')", async () => {
    const { dir, deps } = testDeps()
    const { log, runId } = createLogSink(deps)
    log(DISPATCHED)
    await flush()
    const path = join(dir, 'outbox', 'atta-labs-vinaya', '404.ndjson')
    const parsed = JSON.parse(readFileSync(path, 'utf8').trim())
    expect(parsed.meta.lineage.run).toBe(runId)
    expect(parsed.meta.run_id).toBe(runId)
  })

  it("honors an explicit VINAYA_RUN over this process's own runId — a caller that structurally knows a broader run identity (e.g. a loop_id) still wins", async () => {
    const { dir, deps } = testDeps({
      env: () => ({ VINAYA_ROLE: 'developer', VINAYA_TASK: '404', VINAYA_RUN: 'loop-abc' })
    })
    const { log } = createLogSink(deps)
    log(DISPATCHED)
    await flush()
    const path = join(dir, 'outbox', 'atta-labs-vinaya', '404.ndjson')
    const parsed = JSON.parse(readFileSync(path, 'utf8').trim())
    expect(parsed.meta.lineage.run).toBe('loop-abc')
  })

  it('two calls in the same millisecond each carry a distinct, correctly-assigned seq', async () => {
    // `seq` is assigned synchronously at call time (call order), not at
    // write time — two overlapping async appends are not guaranteed to
    // land in that order, which is exactly why a reader sorts by `seq`
    // instead of trusting file position (spec §19's `(run_id, seq)` key).
    const { dir, deps } = testDeps()
    const { log } = createLogSink(deps)
    log(DISPATCHED)
    log(DISPATCHED)
    await flush()
    const path = join(dir, 'outbox', 'atta-labs-vinaya', '404.ndjson')
    const lines = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    const seqs = lines.map((l) => l.meta.seq).sort((a, b) => a - b)
    expect(seqs).toEqual([0, 1])
  })
})

describe('log-sink — defeat cases', () => {
  it('refuses an invalid payload without writing anything', async () => {
    const { dir, deps } = testDeps()
    const { log } = createLogSink(deps)
    log({ ...DISPATCHED, extraKey: 'not allowed' } as never)
    await flush()
    expect(() => statSync(join(dir, 'outbox'))).toThrow()
  })

  it('refuses a symlinked outbox target — writes nothing', async () => {
    const { dir, deps } = testDeps()
    const outboxDir = join(dir, 'outbox', 'atta-labs-vinaya')
    const elsewhere = join(dir, 'elsewhere.ndjson')
    writeFileSync(elsewhere, 'pre-existing\n')
    mkdirSync(outboxDir, { recursive: true })
    symlinkSync(elsewhere, join(outboxDir, '404.ndjson'))

    const { log } = createLogSink(deps)
    log(DISPATCHED)
    await flush()
    expect(readFileSync(elsewhere, 'utf8')).toBe('pre-existing\n')
  })

  it('rotates the file to .1.ndjson once it is at the cap, then appends fresh', async () => {
    const { dir, deps } = testDeps()
    const outboxDir = join(dir, 'outbox', 'atta-labs-vinaya')
    mkdirSync(outboxDir, { recursive: true })
    const target = join(outboxDir, '404.ndjson')
    writeFileSync(target, 'x'.repeat(OUTBOX_MAX_BYTES + 1))

    const { log } = createLogSink(deps)
    log(DISPATCHED)
    await flush()
    const rotated = readFileSync(join(outboxDir, '404.1.ndjson'), 'utf8')
    expect(rotated.length).toBe(OUTBOX_MAX_BYTES + 1)
    const fresh = readFileSync(target, 'utf8').trim().split('\n')
    expect(fresh).toHaveLength(1)
  })

  it('reports dropped identities via one stderr line when rotation overwrites an existing .1.ndjson backup', async () => {
    const { dir, deps } = testDeps()
    const outboxDir = join(dir, 'outbox', 'atta-labs-vinaya')
    mkdirSync(outboxDir, { recursive: true })
    const target = join(outboxDir, '404.ndjson')
    const backup = join(outboxDir, '404.1.ndjson')
    const existingLine = JSON.stringify({
      meta: {
        schema: 1,
        ts: '2026-09-05T00:00:00.000Z',
        run_id: 'priorRun',
        seq: 7,
        repo: null,
        vinaya: '0.0.0',
        doctrine: 'unknown',
        host: 'cli',
        machine: 'deadbeef'
      },
      subject: { issue: 404, role: 'developer' },
      kind: 'forge_write',
      event: 'validated',
      payload: {},
      op: 'issue.comment',
      target: { issue: 404 }
    })
    writeFileSync(backup, `${existingLine}\n`)
    writeFileSync(target, 'x'.repeat(OUTBOX_MAX_BYTES + 1))

    const messages: string[] = []
    const { log } = createLogSink({ ...deps, stderr: (m) => messages.push(m) })
    log(DISPATCHED)
    await flush()

    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('1 record(s) permanently lost')
    expect(messages[0]).toContain('priorRun:7')
  })

  it('reports nothing on the first-ever rotation — there is no prior backup to lose', async () => {
    const { dir, deps } = testDeps()
    const outboxDir = join(dir, 'outbox', 'atta-labs-vinaya')
    mkdirSync(outboxDir, { recursive: true })
    const target = join(outboxDir, '404.ndjson')
    writeFileSync(target, 'x'.repeat(OUTBOX_MAX_BYTES + 1))

    const messages: string[] = []
    const { log } = createLogSink({ ...deps, stderr: (m) => messages.push(m) })
    log(DISPATCHED)
    await flush()

    expect(messages).toHaveLength(0)
  })

  it('never throws when the outbox directory cannot be created — one stderr line, no exception', async () => {
    const { dir, deps } = testDeps()
    // A file where a directory needs to go: mkdirSync will fail with ENOTDIR.
    const blocker = join(dir, 'outbox')
    writeFileSync(blocker, 'not a directory')
    let stderrCalls = 0
    const { log } = createLogSink({
      ...deps,
      stderr: () => {
        stderrCalls++
      }
    })
    expect(() => log(DISPATCHED)).not.toThrow()
    await flush()
    expect(stderrCalls).toBe(1)
  })

  it('resolveRepo() returning null writes under outbox/unresolved with meta.repo: null', async () => {
    const { dir, deps } = testDeps({ resolveRepo: () => Promise.resolve(null) })
    const { log } = createLogSink(deps)
    log(DISPATCHED)
    await flush()
    const path = join(dir, 'outbox', 'unresolved', '404.ndjson')
    const line = JSON.parse(readFileSync(path, 'utf8').trim())
    expect(line.meta.repo).toBeNull()
  })

  it('an unattributed session (no VINAYA_TASK) files under none.ndjson', async () => {
    const { dir, deps } = testDeps({ env: () => ({}) })
    const { log } = createLogSink(deps)
    log(DISPATCHED)
    await flush()
    const path = join(dir, 'outbox', 'atta-labs-vinaya', 'none.ndjson')
    const line = JSON.parse(readFileSync(path, 'utf8').trim())
    expect(line.subject.role).toBe('unattributed')
    expect(line.subject.issue).toBeNull()
  })

  it('a forged meta/subject field on the caller-supplied event never overrides the trusted header (review BLOCKER)', async () => {
    // `LogEventInput`'s type strips `meta`/`subject`, but TS's excess-property
    // check only fires on a fresh object literal — a value coming through a
    // wider type or `as never` can still carry them at runtime. The header
    // must win regardless of spread order.
    const { dir, deps } = testDeps()
    const forged = {
      ...DISPATCHED,
      subject: { issue: 999, role: 'principal' },
      meta: { repo: 'attacker/owned' }
    }
    const { log } = createLogSink(deps)
    log(forged as never)
    await flush()
    const path = join(dir, 'outbox', 'atta-labs-vinaya', '404.ndjson')
    const line = JSON.parse(readFileSync(path, 'utf8').trim())
    expect(line.subject.role).toBe('developer')
    expect(line.subject.issue).toBe(404)
    expect(line.meta.repo).toBe('atta-labs/vinaya')
  })

  it('an unsafe owner/repo (path traversal) falls back to unresolved rather than escaping the outbox root (review HIGH)', async () => {
    const { dir, deps } = testDeps({
      resolveRepo: () => Promise.resolve({ owner: 'evil', repo: '../../../../../../tmp/evil' })
    })
    const { log } = createLogSink(deps)
    log(DISPATCHED)
    await flush()
    const path = join(dir, 'outbox', 'unresolved', '404.ndjson')
    const line = JSON.parse(readFileSync(path, 'utf8').trim())
    expect(line.meta.repo).toBeNull()
    // Nothing was created outside the sandboxed outbox root.
    expect(() => statSync('/tmp/evil')).toThrow()
  })

  it('an owner/repo containing a path separator also falls back to unresolved', async () => {
    const { dir, deps } = testDeps({
      resolveRepo: () => Promise.resolve({ owner: 'a/b', repo: 'c' })
    })
    const { log } = createLogSink(deps)
    log(DISPATCHED)
    await flush()
    const path = join(dir, 'outbox', 'unresolved', '404.ndjson')
    const line = JSON.parse(readFileSync(path, 'utf8').trim())
    expect(line.meta.repo).toBeNull()
  })
})

describe('log-sink — the Issue a branch names (log-quality-v1 1, O1/O3)', () => {
  it('parses the two branch shapes this doctrine addresses a task by, and nothing else', () => {
    expect(taskRefFromBranch('task/issue-792')).toEqual({ kind: 'issue', issue: 792 })
    expect(taskRefFromBranch('task/log-quality-v1/1')).toEqual({
      kind: 'tranche',
      tranche: 'log-quality-v1',
      taskId: '1'
    })
    expect(taskRefFromBranch('main')).toBeNull()
    expect(taskRefFromBranch('feature/task/issue-1')).toBeNull()
    expect(taskRefFromBranch('task/issue-abc')).toBeNull()
    expect(taskRefFromBranch('task/a/b/c')).toBeNull()
  })

  it('refuses a tranche segment that is not a plain slug — a branch name never reaches gh argv unchecked', () => {
    expect(taskRefFromBranch('task/--label=x/1')).toBeNull()
    expect(taskRefFromBranch('task/ semi colon/1')).toBeNull()
  })

  it('refuses a digit run no Issue number can be — an unbounded parse would drop every event this process logs', () => {
    // `Number('9'.repeat(400))` is `Infinity` and a 20-digit run is a
    // non-integer float; either one fails `subject.issue: z.number().int()`
    // inside `log()`, which refuses the WHOLE event — and the resolved
    // value is cached, so every later event in that process is refused too.
    expect(taskRefFromBranch(`task/issue-${'9'.repeat(400)}`)).toBeNull()
    expect(taskRefFromBranch('task/issue-99999999999999999999999')).toBeNull()
    expect(taskRefFromBranch('task/issue-0')).toBeNull()
    expect(taskRefFromBranch(`task/issue-${Number.MAX_SAFE_INTEGER}`)).toEqual({
      kind: 'issue',
      issue: Number.MAX_SAFE_INTEGER
    })
  })

  it('fills subject.issue from the branch when the process carries no VINAYA_TASK', async () => {
    const { dir, deps } = testDeps({ env: () => ({}), resolveBranchIssue: () => Promise.resolve(792) })
    const { log } = createLogSink(deps)
    log(DISPATCHED)
    await flush()
    const line = JSON.parse(readFileSync(join(dir, 'outbox', 'atta-labs-vinaya', '792.ndjson'), 'utf8').trim())
    expect(line.subject.issue).toBe(792)
    // The branch is not an environment correlation: naming the issue never
    // strengthens the claim about who attributed the event.
    expect(line.meta.provenance).toBe('unavailable')
  })

  it('leaves subject.issue null when the branch names no resolvable task — never a guessed number', async () => {
    const { dir, deps } = testDeps({ env: () => ({}), resolveBranchIssue: () => Promise.resolve(null) })
    const { log } = createLogSink(deps)
    log(DISPATCHED)
    await flush()
    const line = JSON.parse(readFileSync(join(dir, 'outbox', 'atta-labs-vinaya', 'none.ndjson'), 'utf8').trim())
    expect(line.subject.issue).toBeNull()
  })

  it('O3: an event that already names its task and role is unchanged, and the branch is never consulted', async () => {
    let calls = 0
    const { dir, deps } = testDeps({
      resolveBranchIssue: () => {
        calls += 1
        return Promise.resolve(999)
      }
    })
    const { log } = createLogSink(deps)
    log(DISPATCHED)
    await flush()
    const line = JSON.parse(readFileSync(join(dir, 'outbox', 'atta-labs-vinaya', '404.ndjson'), 'utf8').trim())
    expect(line.subject.issue).toBe(404)
    expect(line.subject.role).toBe('developer')
    expect(calls).toBe(0)
  })

  it('resolves the branch at most once per process, however many events it logs', async () => {
    let calls = 0
    const { dir, deps } = testDeps({
      env: () => ({}),
      resolveBranchIssue: () => {
        calls += 1
        return Promise.resolve(792)
      }
    })
    const { log } = createLogSink(deps)
    log(DISPATCHED)
    log(DISPATCHED)
    log(DISPATCHED)
    await flush()
    const lines = readFileSync(join(dir, 'outbox', 'atta-labs-vinaya', '792.ndjson'), 'utf8')
      .trim()
      .split('\n')
    expect(lines).toHaveLength(3)
    expect(lines.map((l) => JSON.parse(l).meta.seq)).toEqual([0, 1, 2])
    expect(calls).toBe(1)
  })

  it('a failed lookup never drops the event — the line lands with issue null', async () => {
    const { dir, deps } = testDeps({
      env: () => ({}),
      resolveBranchIssue: () => Promise.reject(new Error('gh: not authenticated'))
    })
    const { log } = createLogSink(deps)
    log(DISPATCHED)
    await flush()
    const line = JSON.parse(readFileSync(join(dir, 'outbox', 'atta-labs-vinaya', 'none.ndjson'), 'utf8').trim())
    expect(line.subject.issue).toBeNull()
    expect(line.kind).toBe('dispatch')
  })
})

describe('log-sink — the test marker (log-quality-v1 1, O2)', () => {
  it('marks every event produced with AEG_LOG_TEST set, and delivers it exactly where an unmarked one goes', async () => {
    const { dir, deps } = testDeps({
      env: () => ({ VINAYA_ROLE: 'developer', VINAYA_TASK: '404', AEG_LOG_TEST: '1' })
    })
    const { log } = createLogSink(deps)
    log(DISPATCHED)
    await flush()
    // Same path an unmarked event lands at: a label, not a switch.
    const line = JSON.parse(readFileSync(join(dir, 'outbox', 'atta-labs-vinaya', '404.ndjson'), 'utf8').trim())
    expect(line.meta.test).toBe(true)
    expect(line.subject.issue).toBe(404)
  })

  it('leaves the marker off an event from a process that is not a test run', async () => {
    const { dir, deps } = testDeps()
    const { log } = createLogSink(deps)
    log(DISPATCHED)
    await flush()
    const line = JSON.parse(readFileSync(join(dir, 'outbox', 'atta-labs-vinaya', '404.ndjson'), 'utf8').trim())
    expect('test' in line.meta).toBe(false)
  })

  it('marks a test run that never loaded the preload — the shape git runs the pre-push hook in', async () => {
    // Bun resolves `bunfig.toml` from the process's working directory
    // alone, so `apps/cli`'s `[test] preload` does not load for a run
    // started at the repository root — which is exactly how git runs the
    // pre-push hook, the biggest producer of real server traffic there is.
    // `NODE_ENV=test` is what the runner sets for itself and every child it
    // spawns in BOTH invocation shapes, so the marker no longer depends on
    // which `bunfig.toml` was found.
    const { dir, deps } = testDeps({
      env: () => ({ VINAYA_ROLE: 'developer', VINAYA_TASK: '404', NODE_ENV: 'test' })
    })
    const { log } = createLogSink(deps)
    log(DISPATCHED)
    await flush()
    const line = JSON.parse(readFileSync(join(dir, 'outbox', 'atta-labs-vinaya', '404.ndjson'), 'utf8').trim())
    expect(line.meta.test).toBe(true)
  })

  it('leaves the marker off a real run, whatever else its environment declares', async () => {
    const { dir, deps } = testDeps({
      env: () => ({ VINAYA_ROLE: 'developer', VINAYA_TASK: '404', NODE_ENV: 'production' })
    })
    const { log } = createLogSink(deps)
    log(DISPATCHED)
    await flush()
    const line = JSON.parse(readFileSync(join(dir, 'outbox', 'atta-labs-vinaya', '404.ndjson'), 'utf8').trim())
    expect('test' in line.meta).toBe(false)
  })

  it('a run started at the repository root carries the marker even when NODE_ENV is already taken', () => {
    // The runner sets `NODE_ENV=test` only when nothing already exported it,
    // so on a machine whose shell (or direnv) exports `NODE_ENV=development`
    // that signal is simply absent — and the pre-push hook's own run starts
    // at the worktree root, where `apps/cli/bunfig.toml` never loads. Both
    // `bunfig.toml` files now declare the marker preload, which is what
    // covers that shape; this runs the real runner from the real root to
    // prove it, since only a child can observe which config was resolved.
    const repoRoot = new URL('../../../..', import.meta.url).pathname
    // `./`-prefixed, and named `.probe.ts` rather than `.test.ts`: the runner
    // treats it as a path instead of a filter, and the repository's own
    // discovery and shard lists never collect it.
    const probe = './apps/cli/tests/fixtures/log-marker/root-cwd-marker.probe.ts'
    const childEnv: NodeJS.ProcessEnv = { ...stripVinayaEnv(), NODE_ENV: 'development' }
    // This test process is itself marked (the preload ran), so the marker has
    // to be cleared for the child or it would prove nothing.
    delete childEnv.AEG_LOG_TEST
    const run = spawnSyncBudgeted(
      'bun',
      ['test', probe],
      { encoding: 'utf8', cwd: repoRoot, env: childEnv },
      60_000,
      'root-cwd marker probe'
    )
    expect(`${run.stdout}${run.stderr}`).toContain('1 pass')
    expect(run.status).toBe(0)
  }, 120_000)

  // Last in the file on purpose: importing the preload RUNS it, setting the
  // marker on this process for good.
  it('the preload marks every child a test process spawns, whatever bunfig was loaded', async () => {
    await import('./test-env-preload.js')
    expect(process.env.AEG_LOG_TEST).toBe('1')
  })
})

describe('log-sink — what the branch lookup costs, and when (log-quality-v1 1, O1)', () => {
  it('never reads the branch for a process that records nothing — no git, no gh, no forge spend', async () => {
    let calls = 0
    const { deps } = testDeps({
      env: () => ({}),
      resolveLogDestination: () => ({ kind: 'none', reason: 'no log server is configured' }),
      resolveBranchIssue: () => {
        calls += 1
        return Promise.resolve(792)
      }
    })
    const { log } = createLogSink(deps)
    log(DISPATCHED)
    await flush()
    expect(calls).toBe(0)
  })

  it('holds call order even when only some events wait for the lookup', async () => {
    // The mixed case the shared context alone no longer covers: the first
    // event has no task and waits for a slow branch lookup, the second
    // names its own task and would otherwise overtake it.
    let env: NodeJS.ProcessEnv = {}
    const { dir, deps } = testDeps({
      env: () => env,
      resolveBranchIssue: () => new Promise((resolve) => setTimeout(() => resolve(404), 50))
    })
    const { log } = createLogSink(deps)
    log(DISPATCHED)
    env = { VINAYA_TASK: '404' }
    log(DISPATCHED)
    await flush()
    const lines = readFileSync(join(dir, 'outbox', 'atta-labs-vinaya', '404.ndjson'), 'utf8')
      .trim()
      .split('\n')
    expect(lines.map((l) => JSON.parse(l).meta.seq)).toEqual([0, 1])
  })

  it("reads the branch of the sink's own cwd, confirms what it named, and refuses what the forge denies", () => {
    // The real `resolveBranchIssue` against a real checkout, with a stub
    // `gh` — every other case here injects the dep, so nothing else proves
    // the `git` read itself, which directory it reads, or that the number a
    // branch names is confirmed before an event is filed under it. Run in a
    // child so the stub's `PATH` never reaches another test file.
    type ForgeAnswer = 'confirms' | 'denies' | 'cannot-be-asked'
    const probeOnce = (forge: ForgeAnswer): { verified: number | null; landedIn: string[] } => {
      const scratch = mkdtempSync(join(tmpdir(), 'vinaya-branch-probe-'))
      const repoDir = join(scratch, 'repo')
      const binDir = join(scratch, 'bin')
      const outbox = join(scratch, 'outbox')
      mkdirSync(repoDir)
      mkdirSync(binDir)
      const git = (...args: string[]): void => {
        const r = spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' })
        if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
      }
      git('init', '--initial-branch=main')
      git('config', 'user.email', 'test@example.com')
      git('config', 'user.name', 'Test')
      writeFileSync(join(repoDir, 'a.txt'), 'a')
      git('add', 'a.txt')
      git('commit', '-m', 'init')
      git('checkout', '-b', 'task/issue-321')
      // Stands in for the forge: `gh issue view 321 --json number --repo …`.
      // A denial and an unreachable forge both exit non-zero — `gh`'s own
      // message is the only thing that tells them apart, so each stub writes
      // the real one.
      const ghScript = {
        confirms: '#!/bin/sh\necho \'{"number":321}\'\n',
        denies: '#!/bin/sh\necho "GraphQL: Could not resolve to an Issue with the number of 321." 1>&2\nexit 1\n',
        'cannot-be-asked': '#!/bin/sh\necho "gh: authentication required" 1>&2\nexit 4\n'
      }[forge]
      writeFileSync(join(binDir, 'gh'), ghScript, { mode: 0o755 })

      const sinkModule = new URL('../../src/lib/log-sink.ts', import.meta.url).pathname
      const probe = join(scratch, 'probe.ts')
      writeFileSync(
        probe,
        `import { createLogSink, resolveBranchIssue } from ${JSON.stringify(sinkModule)}\n` +
          "import { readdirSync } from 'node:fs'\n" +
          'const [repoDir, outbox] = process.argv.slice(2) as [string, string]\n' +
          'const verified = await resolveBranchIssue(repoDir, {})\n' +
          'const { log, drain } = createLogSink({\n' +
          '  cwd: () => repoDir,\n' +
          '  outboxRoot: () => outbox,\n' +
          '  home: () => repoDir,\n' +
          "  hostname: () => 'probe-host',\n" +
          '  env: () => ({}),\n' +
          "  now: () => new Date('2026-09-05T00:00:00.000Z'),\n" +
          "  resolveRepo: async () => ({ owner: 'atta-labs', repo: 'vinaya' }),\n" +
          "  resolveLogDestination: () => ({ kind: 'folder', folder: outbox }),\n" +
          "  vinayaVersion: () => '0.0.0',\n" +
          '  inputVersions: () => undefined,\n' +
          '  stderr: () => {}\n' +
          '})\n' +
          `log(${JSON.stringify(DISPATCHED)})\n` +
          'await drain()\n' +
          'const dir = outbox + "/atta-labs-vinaya"\n' +
          'console.log(JSON.stringify({ verified, landedIn: readdirSync(dir) }))\n'
      )
      const run = spawnSyncBudgeted(
        'bun',
        [probe, repoDir, outbox],
        { encoding: 'utf8', env: { ...stripVinayaEnv(), PATH: `${binDir}:${process.env.PATH ?? ''}` } },
        60_000,
        'branch-confirmation probe'
      )
      if (run.status !== 0) throw new Error(`probe failed: ${run.stderr}`)
      return JSON.parse(run.stdout.trim().split('\n').pop() as string)
    }

    // The forge confirms the number the branch named: the read answers it,
    // and the sink files the event under it — from the SINK's own cwd, not
    // the process's (this test process sits on another branch entirely).
    const confirmed = probeOnce('confirms')
    expect(confirmed.verified).toBe(321)
    expect(confirmed.landedIn).toEqual(['321.ndjson'])

    // The forge DENIES the number: the field stays empty rather than filing
    // this process's telemetry under a number a branch name invented.
    const denied = probeOnce('denies')
    expect(denied.verified).toBeNull()
    expect(denied.landedIn).toEqual(['none.ndjson'])

    // The forge cannot be asked at all — no credential, no network, no `gh`.
    // Silence is not denial: the branch's own plain claim stands, which is
    // the objective's promise for a local pre-push run on a task branch.
    const unreachable = probeOnce('cannot-be-asked')
    expect(unreachable.verified).toBe(321)
    expect(unreachable.landedIn).toEqual(['321.ndjson'])
  }, 120_000)
})

describe('log-sink — the append path spends nothing when nothing is recorded (log-quality-v1 1, O1)', () => {
  it('reads no branch for a `none` destination, the same rule log() applies', async () => {
    let calls = 0
    const path = await resolveLogAppendPath({ owner: 'atta-labs', repo: 'vinaya' }, null, {
      env: () => ({}),
      outboxRoot: () => '/queue',
      resolveLogDestination: () => ({ kind: 'none', reason: 'no log server is configured' }),
      resolveBranchIssue: () => {
        calls += 1
        return Promise.resolve(792)
      }
    })
    // A `vinaya dispatch` on a machine with no `logs` setting, or a CI job
    // deliberately holding no delivery credential, must spend no `git` read
    // and above all no credentialed `gh` call to fill a field no event carries.
    expect(calls).toBe(0)
    expect(path).toBe('/queue/atta-labs-vinaya/none.ndjson')
  })

  it('asks the forge about the repository the event is FILED under', async () => {
    const asked: (string | null)[] = []
    await resolveLogAppendPath({ owner: 'atta-labs', repo: 'vinaya' }, null, {
      env: () => ({}),
      outboxRoot: () => '/queue',
      resolveLogDestination: () => ({ kind: 'folder', folder: '/srv/logs' }),
      resolveBranchIssue: (repo) => {
        asked.push(repo)
        return Promise.resolve(792)
      }
    })
    // `meta.repo` and the outbox directory come from the resolved repository
    // (whose first source is `AEG_REPO`), so a number confirmed against some
    // other repository — whatever this directory's git remote happens to name
    // — would be filed where it was never confirmed.
    expect(asked).toEqual(['atta-labs/vinaya'])
  })
})

describe('log-sink — CI has no branch checked out (log-quality-v1 1, O1)', () => {
  it('reads the head ref CI reports when git answers a detached HEAD, and confirms it like any other', () => {
    // `actions/checkout` on a `pull_request` event lands on the merge commit
    // in detached HEAD, where `rev-parse --abbrev-ref HEAD` answers the
    // literal `HEAD`. Without the head-ref read, every CI event stays
    // `issue: null` — half of what this fallback exists for.
    const scratch = mkdtempSync(join(tmpdir(), 'vinaya-detached-probe-'))
    const repoDir = join(scratch, 'repo')
    const binDir = join(scratch, 'bin')
    mkdirSync(repoDir)
    mkdirSync(binDir)
    const git = (...args: string[]): void => {
      const r = spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' })
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
    }
    git('init', '--initial-branch=main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    writeFileSync(join(repoDir, 'a.txt'), 'a')
    git('add', 'a.txt')
    git('commit', '-m', 'init')
    const head = spawnSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
    git('checkout', '--detach', head)
    writeFileSync(join(binDir, 'gh'), '#!/bin/sh\necho \'{"number":321}\'\n', { mode: 0o755 })

    const sinkModule = new URL('../../src/lib/log-sink.ts', import.meta.url).pathname
    const probe = join(scratch, 'probe.ts')
    writeFileSync(
      probe,
      `import { resolveBranchIssue } from ${JSON.stringify(sinkModule)}\n` +
        'const repoDir = process.argv[2] as string\n' +
        "const withHeadRef = await resolveBranchIssue(repoDir, { GITHUB_HEAD_REF: 'task/issue-321' })\n" +
        'const withoutHeadRef = await resolveBranchIssue(repoDir, {})\n' +
        "const notATask = await resolveBranchIssue(repoDir, { GITHUB_HEAD_REF: 'main' })\n" +
        'console.log(JSON.stringify({ withHeadRef, withoutHeadRef, notATask }))\n'
    )
    const run = spawnSyncBudgeted(
      'bun',
      [probe, repoDir],
      { encoding: 'utf8', env: { ...stripVinayaEnv(), PATH: `${binDir}:${process.env.PATH ?? ''}` } },
      60_000,
      'detached-HEAD probe'
    )
    if (run.status !== 0) throw new Error(`probe failed: ${run.stderr}`)
    const answer = JSON.parse(run.stdout.trim().split('\n').pop() as string)
    expect(answer.withHeadRef).toBe(321)
    // No head ref to read — a detached HEAD names no task, and nothing is guessed.
    expect(answer.withoutHeadRef).toBeNull()
    // A head ref that is not a task branch is not a task, same as locally.
    expect(answer.notATask).toBeNull()
  }, 120_000)
})

describe('log-sink — one read per process, not per sink (log-quality-v1 1, O1)', () => {
  it("a second sink reading the same directory reuses the first one's read; another directory reads for itself", () => {
    // The REAL read, in a child, with a counting `gh` on `PATH`: the shape a
    // process dispatching task-less roles takes is several sinks over one
    // checkout, and each used to pay its own `git` read and `gh` round trip.
    // An injected reader is deliberately NOT shared across sinks, so this can
    // only be proven against the real one.
    const scratch = mkdtempSync(join(tmpdir(), 'vinaya-shared-read-'))
    const binDir = join(scratch, 'bin')
    const calls = join(scratch, 'gh-calls')
    mkdirSync(binDir)
    const repoOn = (name: string, branch: string): string => {
      const dir = join(scratch, name)
      mkdirSync(dir)
      const git = (...args: string[]): void => {
        const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
        if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
      }
      git('init', '--initial-branch=main')
      git('config', 'user.email', 'test@example.com')
      git('config', 'user.name', 'Test')
      writeFileSync(join(dir, 'a.txt'), 'a')
      git('add', 'a.txt')
      git('commit', '-m', 'init')
      git('checkout', '-b', branch)
      return dir
    }
    const first = repoOn('first', 'task/issue-321')
    const second = repoOn('second', 'task/issue-654')
    writeFileSync(join(binDir, 'gh'), `#!/bin/sh\necho "$3" >> ${JSON.stringify(calls)}\necho "{\\"number\\":$3}"\n`, {
      mode: 0o755
    })

    const sinkModule = new URL('../../src/lib/log-sink.ts', import.meta.url).pathname
    const probe = join(scratch, 'probe.ts')
    writeFileSync(
      probe,
      `import { createLogSink } from ${JSON.stringify(sinkModule)}\n` +
        'const [first, second, outbox] = process.argv.slice(2) as [string, string, string]\n' +
        'const sinkFor = (cwd: string) =>\n' +
        '  createLogSink({\n' +
        '    cwd: () => cwd,\n' +
        '    outboxRoot: () => outbox,\n' +
        '    home: () => cwd,\n' +
        "    hostname: () => 'probe-host',\n" +
        '    env: () => ({}),\n' +
        "    now: () => new Date('2026-09-05T00:00:00.000Z'),\n" +
        "    resolveRepo: async () => ({ owner: 'atta-labs', repo: 'vinaya' }),\n" +
        "    resolveLogDestination: () => ({ kind: 'folder', folder: outbox }),\n" +
        "    vinayaVersion: () => '0.0.0',\n" +
        '    inputVersions: () => undefined,\n' +
        '    stderr: () => {}\n' +
        '  })\n' +
        'const a = sinkFor(first)\n' +
        'const b = sinkFor(first)\n' +
        'const c = sinkFor(second)\n' +
        `a.log(${JSON.stringify(DISPATCHED)})\n` +
        `b.log(${JSON.stringify(DISPATCHED)})\n` +
        `c.log(${JSON.stringify(DISPATCHED)})\n` +
        'await Promise.all([a.drain(), b.drain(), c.drain()])\n' +
        "const { readdirSync } = await import('node:fs')\n" +
        'const dir = outbox + "/atta-labs-vinaya"\n' +
        'console.log(JSON.stringify({ landedIn: readdirSync(dir).sort() }))\n'
    )
    const outbox = join(scratch, 'outbox')
    const run = spawnSyncBudgeted(
      'bun',
      [probe, first, second, outbox],
      { encoding: 'utf8', env: { ...stripVinayaEnv(), PATH: `${binDir}:${process.env.PATH ?? ''}` } },
      60_000,
      'shared-read probe'
    )
    if (run.status !== 0) throw new Error(`probe failed: ${run.stderr}`)
    const answer = JSON.parse(run.stdout.trim().split('\n').pop() as string)
    // Two sinks over the first checkout, one over the second: three events,
    // two files, and exactly one forge confirmation per DIRECTORY.
    expect(answer.landedIn).toEqual(['321.ndjson', '654.ndjson'])
    expect(readFileSync(calls, 'utf8').trim().split('\n').sort()).toEqual(['321', '654'])
  }, 120_000)
})

describe('log-sink — a process that serves several tasks (log-quality-v1 1, O1)', () => {
  it('never reads the branch once the fallback is off, and keeps issue null', async () => {
    let calls = 0
    const { dir, deps } = testDeps({
      env: () => ({ VINAYA_ROLE: 'developer' }),
      resolveBranchIssue: () => {
        calls += 1
        return Promise.resolve(792)
      }
    })
    setBranchIssueFallback(false)
    try {
      const { log } = createLogSink(deps)
      log(DISPATCHED)
      await flush()
      const line = JSON.parse(readFileSync(join(dir, 'outbox', 'atta-labs-vinaya', 'none.ndjson'), 'utf8').trim())
      expect(line.subject.issue).toBeNull()
      expect(calls).toBe(0)
    } finally {
      setBranchIssueFallback(true)
    }
  })

  it('the append path a caller polls is off too, so the two still name the same file', async () => {
    setBranchIssueFallback(false)
    try {
      const path = await resolveLogAppendPath({ owner: 'atta-labs', repo: 'vinaya' }, null, {
        env: () => ({}),
        outboxRoot: () => '/tmp/vinaya-test-outbox',
        resolveLogDestination: () => ({ kind: 'server', url: 'https://example.invalid' }),
        resolveBranchIssue: () => Promise.resolve(792)
      })
      expect(path.endsWith('none.ndjson')).toBe(true)
    } finally {
      setBranchIssueFallback(true)
    }
  })
})

describe('log-sink — the append path mirrors what log() writes (log-quality-v1 1, O1)', () => {
  it('names the branch-derived file a task-less process actually appends to', async () => {
    const { dir, deps } = testDeps({ env: () => ({}), resolveBranchIssue: () => Promise.resolve(792) })
    const { log } = createLogSink(deps)
    log(DISPATCHED)
    await flush()
    // The file `log()` really wrote, and the path a caller polling for its
    // own line (or granting a sandbox exactly one file) resolves.
    const written = join(dir, 'outbox', 'atta-labs-vinaya', '792.ndjson')
    expect(readFileSync(written, 'utf8').trim().length).toBeGreaterThan(0)
    const polled = await resolveLogAppendPath({ owner: 'atta-labs', repo: 'vinaya' }, null, {
      env: () => ({}),
      outboxRoot: () => join(dir, 'outbox'),
      resolveLogDestination: () => ({ kind: 'folder', folder: join(dir, 'outbox') }),
      resolveBranchIssue: () => Promise.resolve(792)
    })
    expect(polled).toBe(written)
  })

  it('leaves a caller-named issue alone, and never reads a branch for one', async () => {
    let calls = 0
    const polled = await resolveLogAppendPath({ owner: 'atta-labs', repo: 'vinaya' }, 404, {
      env: () => ({}),
      outboxRoot: () => '/tmp/vinaya-test-outbox',
      resolveLogDestination: () => ({ kind: 'folder', folder: '/tmp/vinaya-test-outbox' }),
      resolveBranchIssue: () => {
        calls += 1
        return Promise.resolve(792)
      }
    })
    expect(polled.endsWith('404.ndjson')).toBe(true)
    expect(calls).toBe(0)
  })
})

describe('log-sink — the branch read outlives nothing (log-quality-v1 1, O1)', () => {
  it('answers null and kills a git that hangs, rather than holding the process open', async () => {
    // Run in a CHILD: the probe needs a hanging `git` first on `PATH`, and
    // a `PATH` mutation in this process would reach every other test file
    // sharing it. Without the child's own `timeout` option the call sits
    // for the full 30s, long past the deadline the caller already answered
    // at, and the process cannot exit while it runs.
    const binDir = mkdtempSync(join(tmpdir(), 'vinaya-hanging-git-'))
    writeFileSync(join(binDir, 'git'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 })
    const sinkModule = new URL('../../src/lib/log-sink.ts', import.meta.url).pathname
    const probe = join(binDir, 'probe.ts')
    writeFileSync(
      probe,
      `import { resolveBranchIssue } from ${JSON.stringify(sinkModule)}\n` +
        'const started = Date.now()\n' +
        'const issue = await resolveBranchIssue(process.argv[2] as string)\n' +
        'console.log(JSON.stringify({ issue, ms: Date.now() - started }))\n'
    )
    const started = Date.now()
    const run = spawnSyncBudgeted(
      'bun',
      [probe, binDir],
      { encoding: 'utf8', env: { ...stripVinayaEnv(), PATH: `${binDir}:${process.env.PATH ?? ''}` } },
      25_000,
      'branch-read probe'
    )
    const elapsed = Date.now() - started
    expect(run.status).toBe(0)
    const answer = JSON.parse(run.stdout.trim().split('\n').pop() as string)
    expect(answer.issue).toBeNull()
    expect(answer.ms).toBeLessThan(10_000)
    // The child exits once the read is answered — it is not still waiting
    // on a `git` nobody needs any more.
    expect(elapsed).toBeLessThan(20_000)
  }, 40_000)
})
