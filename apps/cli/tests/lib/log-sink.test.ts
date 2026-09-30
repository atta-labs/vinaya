import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSyncBudgeted, stripVinayaEnv } from './process-fixture.js'
import {
  createLogSink,
  folderFallbackStatePath,
  OUTBOX_MAX_BYTES,
  readFolderFallbackState,
  recordFolderFallback,
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

  it("writes schema 3: the work reference defaults to the task's Issue number as text, the flow to vinaya, everything else null", async () => {
    const { dir, deps } = testDeps()
    const { log } = createLogSink(deps)
    log(DISPATCHED)
    await flush()
    const parsed = JSON.parse(readFileSync(join(dir, 'outbox', 'atta-labs-vinaya', '404.ndjson'), 'utf8').trim())
    expect(parsed.meta.schema).toBe(3)
    expect(parsed.subject.issue).toBe(404)
    expect(parsed.meta.work).toEqual({ ref: '404', repo: 'atta-labs/vinaya', change: null, revision: null })
    expect(parsed.meta.flow).toEqual({ id: 'vinaya', version: null })
    expect(parsed.meta.runtime).toBeNull()
    expect(parsed.meta.source).toBeNull()
  })

  it('reads the work reference, flow, runtime and source from VINAYA_WORK_REF, VINAYA_FLOW, VINAYA_FLOW_VERSION, VINAYA_RUNTIME and VINAYA_SOURCE', async () => {
    const { dir, deps } = testDeps({
      env: () => ({
        VINAYA_ROLE: 'developer',
        VINAYA_TASK: '404',
        VINAYA_WORK_REF: 'ACME-17',
        VINAYA_FLOW: 'acme-release',
        VINAYA_FLOW_VERSION: '4',
        VINAYA_RUNTIME: 'codex',
        VINAYA_SOURCE: 'acme-ci'
      })
    })
    const { log } = createLogSink(deps)
    log(DISPATCHED)
    await flush()
    const parsed = JSON.parse(readFileSync(join(dir, 'outbox', 'atta-labs-vinaya', '404.ndjson'), 'utf8').trim())
    expect(parsed.meta.work.ref).toBe('ACME-17')
    expect(parsed.meta.flow).toEqual({ id: 'acme-release', version: '4' })
    expect(parsed.meta.runtime).toBe('codex')
    expect(parsed.meta.source).toBe('acme-ci')
    expect(parsed.subject.issue).toBe(404)
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

describe('log-sink — the Issue a branch names (O1, O2)', () => {
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

  it('O2: an event that already names its task and role is unchanged, and the branch is never consulted', async () => {
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

describe('log-sink — what the branch lookup costs, and when (O1)', () => {
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

describe('log-sink — the append path spends nothing when nothing is recorded (O1)', () => {
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

describe('log-sink — CI has no branch checked out (O1)', () => {
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

describe('log-sink — one read per process, not per sink (O1)', () => {
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

describe('log-sink — the trust-anchor config is cached per repository (O1, O3)', () => {
  it("logs from two repositories, each reading its own config once, neither served the other's", () => {
    // The REAL trust-anchor read, in a child, with a counting `gh` on `PATH`
    // that answers each repository its OWN `logs.url` — the exact shape a
    // `bun:test` runner takes when one file drives this repository's checkout
    // and a later file drives a fixture repository of its own. Before the
    // cache was keyed by repository root the first read filled a single slot
    // and the second repository was served the first's config; this proves it
    // is not, and that one repository still reads exactly once (O3).
    const scratch = mkdtempSync(join(tmpdir(), 'vinaya-anchor-perrepo-'))
    const binDir = join(scratch, 'bin')
    const calls = join(scratch, 'gh-calls')
    mkdirSync(binDir)
    const repoNamed = (name: string): string => {
      const dir = join(scratch, name)
      mkdirSync(dir)
      const git = (...args: string[]): void => {
        const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
        if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
      }
      git('init', '--initial-branch=main')
      git('config', 'user.email', 'test@example.com')
      git('config', 'user.name', 'Test')
      // A real remote so `trustAnchorRepoAsync` resolves `attalabs/<name>` from
      // it; the working tree carries NO `vinaya.config.json`, so the local
      // config is null and only the anchor read (the `gh` shim) decides the
      // destination.
      git('remote', 'add', 'origin', `https://github.com/attalabs/${name}.git`)
      writeFileSync(join(dir, 'a.txt'), 'a')
      git('add', 'a.txt')
      git('commit', '-m', 'init')
      return dir
    }
    const repoA = repoNamed('repo-a')
    const repoB = repoNamed('repo-b')
    // The shim reads which repository `gh api repos/attalabs/<name>/contents/…`
    // was asked for, records it (one line per real read), and answers that
    // repository its own `logs.url` as base64 `.content`.
    writeFileSync(
      join(binDir, 'gh'),
      '#!/bin/sh\n' +
        'case "$2" in\n' +
        '  *repo-a*) name=repo-a ;;\n' +
        '  *repo-b*) name=repo-b ;;\n' +
        '  *) exit 1 ;;\n' +
        'esac\n' +
        `echo "$name" >> ${JSON.stringify(calls)}\n` +
        'printf \'%s\' "{\\"logs\\":{\\"url\\":\\"https://$name.example/ingest\\"}}" | base64 | tr -d \'\\n\'\n' +
        'echo\n',
      { mode: 0o755 }
    )

    const sinkModule = new URL('../../src/lib/log-sink.ts', import.meta.url).pathname
    const probe = join(scratch, 'probe.ts')
    writeFileSync(
      probe,
      `import { resolveUnattendedServerSetting, resetTrustAnchorConfigMemo } from ${JSON.stringify(sinkModule)}\n` +
        'const [a, b] = process.argv.slice(2) as [string, string]\n' +
        'resetTrustAnchorConfigMemo()\n' +
        'process.chdir(a)\n' +
        'const a1 = await resolveUnattendedServerSetting()\n' +
        'const a2 = await resolveUnattendedServerSetting()\n' +
        'process.chdir(b)\n' +
        'const b1 = await resolveUnattendedServerSetting()\n' +
        'console.log(JSON.stringify({ a1: a1?.url ?? null, a2: a2?.url ?? null, b1: b1?.url ?? null }))\n'
    )
    // Clear the runner/AEG repo hints so `trustAnchorRepoAsync` resolves each
    // repository from ITS OWN git remote, not one process-wide slug.
    const probeEnv: NodeJS.ProcessEnv = { ...stripVinayaEnv(), PATH: `${binDir}:${process.env.PATH ?? ''}` }
    delete probeEnv.GITHUB_REPOSITORY
    delete probeEnv.AEG_REPO
    delete probeEnv.GH_TOKEN
    delete probeEnv.GITHUB_TOKEN
    const run = spawnSyncBudgeted(
      'bun',
      [probe, repoA, repoB],
      { encoding: 'utf8', env: probeEnv },
      60_000,
      'anchor-per-repo probe'
    )
    if (run.status !== 0) throw new Error(`probe failed: ${run.stderr}`)
    const answer = JSON.parse(run.stdout.trim().split('\n').pop() as string)
    // Each repository resolved its OWN url; the second read of repo-a reused
    // the first (same url, no extra call), and repo-b was never served repo-a's.
    expect(answer.a1).toBe('https://repo-a.example/ingest')
    expect(answer.a2).toBe('https://repo-a.example/ingest')
    expect(answer.b1).toBe('https://repo-b.example/ingest')
    // Exactly one real anchor read per repository: repo-a once despite two
    // resolutions (O3), repo-b once — never repo-a twice, never repo-b served
    // from repo-a's slot.
    expect(readFileSync(calls, 'utf8').trim().split('\n').sort()).toEqual(['repo-a', 'repo-b'])
  }, 120_000)
})

describe('log-sink — a process that serves several tasks (O1)', () => {
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
        outboxRoot: () => join(tmpdir(), 'vinaya-test-outbox'),
        resolveLogDestination: () => ({ kind: 'server', url: 'https://example.invalid' }),
        resolveBranchIssue: () => Promise.resolve(792)
      })
      expect(path.endsWith('none.ndjson')).toBe(true)
    } finally {
      setBranchIssueFallback(true)
    }
  })
})

describe('log-sink — the append path mirrors what log() writes (O1)', () => {
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
      outboxRoot: () => join(tmpdir(), 'vinaya-test-outbox'),
      resolveLogDestination: () => ({ kind: 'folder', folder: join(tmpdir(), 'vinaya-test-outbox') }),
      resolveBranchIssue: () => {
        calls += 1
        return Promise.resolve(792)
      }
    })
    expect(polled.endsWith('404.ndjson')).toBe(true)
    expect(calls).toBe(0)
  })
})

describe('log-sink — the branch read outlives nothing (O1)', () => {
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

describe('O3 — a folder fallback keeps its reason (driver.log + doctor state file)', () => {
  const REPO = { owner: 'acme', repo: 'widget' }

  it('folderFallbackStatePath keys by repo under the given root, `unresolved` for a null repo', () => {
    expect(folderFallbackStatePath(REPO, '/state')).toBe(join('/state', 'fallback', 'acme-widget.json'))
    expect(folderFallbackStatePath(null, '/state')).toBe(join('/state', 'fallback', 'unresolved.json'))
  })

  it('recordFolderFallback writes the reason to driver.log AND a readable state file', () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'vinaya-fallback-rt-'))
    const stateRoot = mkdtempSync(join(tmpdir(), 'vinaya-fallback-state-'))
    recordFolderFallback(
      REPO,
      648,
      { kind: 'anchor-unreadable', intendedUrl: 'https://logs.example.com/x' },
      new Date('2026-01-02T03:04:05.000Z'),
      runtimeDir,
      stateRoot
    )

    const driverLog = readFileSync(join(runtimeDir, 'tasks-execution', '648', 'output', 'driver.log'), 'utf8')
    expect(driverLog).toContain('[log] ')
    expect(driverLog).toContain('https://logs.example.com/x')
    expect(driverLog).toContain('could not be read')

    const record = readFolderFallbackState(REPO, stateRoot)
    expect(record?.kind).toBe('anchor-unreadable')
    expect(record?.at).toBe('2026-01-02T03:04:05.000Z')
    expect(record?.intendedUrl).toBe('https://logs.example.com/x')
    expect(record?.reason).toContain('could not be read')
  })

  it('records the state file even when no task is named (no driver.log to write to)', () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'vinaya-fallback-rt-'))
    const stateRoot = mkdtempSync(join(tmpdir(), 'vinaya-fallback-state-'))
    recordFolderFallback(
      REPO,
      null,
      { kind: 'anchor-mismatch', intendedUrl: 'https://logs.example.com/y' },
      new Date('2026-02-02T00:00:00.000Z'),
      runtimeDir,
      stateRoot
    )
    expect(existsSync(join(runtimeDir, 'tasks-execution'))).toBe(false)
    expect(readFolderFallbackState(REPO, stateRoot)?.kind).toBe('anchor-mismatch')
  })

  it('readFolderFallbackState is null for a missing or corrupt file', () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'vinaya-fallback-state-'))
    expect(readFolderFallbackState(REPO, stateRoot)).toBeNull()
    const path = folderFallbackStatePath(REPO, stateRoot)
    mkdirSync(join(stateRoot, 'fallback'), { recursive: true })
    writeFileSync(path, 'not json{')
    expect(readFolderFallbackState(REPO, stateRoot)).toBeNull()
  })

  it('the sink records the fallback once per process when a server was configured but refused', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vinaya-fallback-home-'))
    const rtDir = mkdtempSync(join(tmpdir(), 'vinaya-fallback-sinkrt-'))
    const folder = join(rtDir, 'logs') // dirname(folder) is the runtime dir
    const sink = createLogSink({
      outboxRoot: () => join(folder),
      home: () => home,
      hostname: () => 'test-host',
      cwd: () => rtDir,
      now: () => new Date('2026-03-03T03:03:03.000Z'),
      // The unattended fallback shape: a server was configured, the trust
      // anchor could not confirm it, events go to the default folder.
      resolveLogDestination: () => ({
        kind: 'folder',
        folder,
        fallbackReason: { kind: 'anchor-unreadable', intendedUrl: 'https://logs.example.com/z' }
      }),
      resolveRepo: async () => REPO,
      env: () => ({ VINAYA_TASK: '777' }),
      resolveBranchIssue: async () => null,
      stderr: () => {}
    })
    sink.log(DISPATCHED)
    sink.log(DISPATCHED)
    await flush()
    await sink.drain()

    // driver.log under the task's own runtime dir, named by the event's issue.
    const driverLog = readFileSync(join(rtDir, 'tasks-execution', '777', 'output', 'driver.log'), 'utf8')
    const lines = driverLog.split('\n').filter((l) => l.includes('[log] '))
    expect(lines.length).toBe(1) // once per process, not per event
    expect(driverLog).toContain('https://logs.example.com/z')

    // state file under the injected home's `.vinaya`, so doctor can report it.
    const record = readFolderFallbackState(REPO, join(home, '.vinaya'))
    expect(record?.kind).toBe('anchor-unreadable')
    expect(record?.intendedUrl).toBe('https://logs.example.com/z')
  })

  it('the sink does NOT record a fallback for an ordinary default folder (no server configured)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vinaya-nofallback-home-'))
    const rtDir = mkdtempSync(join(tmpdir(), 'vinaya-nofallback-rt-'))
    const folder = join(rtDir, 'logs')
    const sink = createLogSink({
      outboxRoot: () => folder,
      home: () => home,
      hostname: () => 'test-host',
      cwd: () => rtDir,
      resolveLogDestination: () => ({ kind: 'folder', folder }), // no fallbackReason
      resolveRepo: async () => REPO,
      env: () => ({ VINAYA_TASK: '777' }),
      resolveBranchIssue: async () => null,
      stderr: () => {}
    })
    sink.log(DISPATCHED)
    await flush()
    await sink.drain()
    expect(readFolderFallbackState(REPO, join(home, '.vinaya'))).toBeNull()
    expect(existsSync(join(rtDir, 'tasks-execution'))).toBe(false)
  })
})

describe('log-sink — the commit a gate event was checked at', () => {
  const GATE = {
    kind: 'gate' as const,
    event: 'checked' as const,
    check: 'fixture',
    check_version: '1',
    policy_version: null,
    input_fingerprint: 'f',
    outcome: 'pass' as const,
    payload: {}
  }
  const subjectsOf = (dir: string): Array<Record<string, unknown>> => {
    const folder = join(dir, 'outbox', 'atta-labs-vinaya')
    return readdirSync(folder)
      .flatMap((name) => readFileSync(join(folder, name), 'utf8').trim().split('\n'))
      .map((l) => JSON.parse(l).subject)
  }

  it("records the checkout's HEAD as subject.sha", async () => {
    const { dir, deps } = testDeps()
    const git = (...args: string[]): string => {
      const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
      return r.stdout.trim()
    }
    git('init', '--initial-branch=main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    writeFileSync(join(dir, 'a.txt'), 'a')
    git('add', 'a.txt')
    git('commit', '-m', 'init')
    const head = git('rev-parse', 'HEAD')
    expect(head).toMatch(/^[0-9a-f]{40}$/)
    const sink = createLogSink(deps)
    sink.log(GATE)
    sink.log(GATE)
    await sink.drain()
    const [first, second] = subjectsOf(dir)
    expect(first?.sha).toBe(head)
    expect(second?.sha).toBe(head)
  })

  it('omits subject.sha outside any git repository', async () => {
    const { dir, deps } = testDeps()
    const sink = createLogSink(deps)
    sink.log(GATE)
    await sink.drain()
    const [subject] = subjectsOf(dir)
    expect(subject).toBeDefined()
    expect('sha' in (subject ?? {})).toBe(false)
  })

  it('resolves the commit once for many gate events', async () => {
    let reads = 0
    const { dir, deps } = testDeps({
      resolveHeadSha: () => {
        reads++
        return Promise.resolve('b'.repeat(40))
      }
    })
    const sink = createLogSink(deps)
    for (let i = 0; i < 5; i++) sink.log(GATE)
    await sink.drain()
    expect(subjectsOf(dir)).toHaveLength(5)
    expect(reads).toBe(1)
  })

  it('never puts the commit on an event that is not a gate', async () => {
    const { dir, deps } = testDeps({ resolveHeadSha: () => Promise.resolve('a'.repeat(40)) })
    const sink = createLogSink(deps)
    sink.log(DISPATCHED)
    sink.log(GATE)
    await sink.drain()
    const [dispatch, gate] = subjectsOf(dir)
    expect('sha' in (dispatch ?? {})).toBe(false)
    expect(gate?.sha).toBe('a'.repeat(40))
  })
})
