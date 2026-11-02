/**
 * The Vinaya branch-to-Issue reader the process gives every Log sink
 * (`harness/processes/vinaya-strict/integration/log/branch-issue.ts`), and the
 * sinks its factory builds with it (`log-sink-factory.ts`): which branch
 * shapes name a task, the real `git` read in a real checkout, the forge
 * confirmation through a stand-in `gh` on a child's `PATH`, the detached-HEAD
 * case CI checks out, the one read per process the factory's reader shares,
 * and the deadline the read never outlives.
 */
import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSyncBudgeted, stripVinayaEnv } from '../../../../../../apps/cli/tests/lib/process-fixture.js'
import { taskRefFromBranch } from '../../../integration/log/branch-issue.js'

const BRANCH_ISSUE_MODULE = join(import.meta.dir, '..', '..', '..', 'integration', 'log', 'branch-issue.ts')
const LOG_SINK_FACTORY_MODULE = join(import.meta.dir, '..', '..', '..', 'integration', 'log', 'log-sink-factory.ts')

const DISPATCHED = {
  kind: 'dispatch' as const,
  event: 'dispatched' as const,
  payload: {},
  target_role: 'developer' as const,
  model: 'sonnet',
  effect_id: 'e1',
  prompt_hash: 'sha256:abc'
}

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
})

describe('log-sink — what the branch lookup costs, and when (O1)', () => {
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

      const probe = join(scratch, 'probe.ts')
      writeFileSync(
        probe,
        `import { resolveBranchIssue } from ${JSON.stringify(BRANCH_ISSUE_MODULE)}\n` +
          `import { createVinayaLogSink } from ${JSON.stringify(LOG_SINK_FACTORY_MODULE)}\n` +
          "import { readdirSync } from 'node:fs'\n" +
          'const [repoDir, outbox] = process.argv.slice(2) as [string, string]\n' +
          'const verified = await resolveBranchIssue(repoDir, {})\n' +
          'const { log, drain } = createVinayaLogSink({\n' +
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
        { cwd: tmpdir(), encoding: 'utf8', env: { ...stripVinayaEnv(), PATH: `${binDir}:${process.env.PATH ?? ''}` } },
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

    const probe = join(scratch, 'probe.ts')
    writeFileSync(
      probe,
      `import { resolveBranchIssue } from ${JSON.stringify(BRANCH_ISSUE_MODULE)}\n` +
        'const repoDir = process.argv[2] as string\n' +
        "const withHeadRef = await resolveBranchIssue(repoDir, { GITHUB_HEAD_REF: 'task/issue-321' })\n" +
        'const withoutHeadRef = await resolveBranchIssue(repoDir, {})\n' +
        "const notATask = await resolveBranchIssue(repoDir, { GITHUB_HEAD_REF: 'main' })\n" +
        'console.log(JSON.stringify({ withHeadRef, withoutHeadRef, notATask }))\n'
    )
    const run = spawnSyncBudgeted(
      'bun',
      [probe, repoDir],
      { cwd: tmpdir(), encoding: 'utf8', env: { ...stripVinayaEnv(), PATH: `${binDir}:${process.env.PATH ?? ''}` } },
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

    const probe = join(scratch, 'probe.ts')
    writeFileSync(
      probe,
      `import { createVinayaLogSink } from ${JSON.stringify(LOG_SINK_FACTORY_MODULE)}\n` +
        'const [first, second, outbox] = process.argv.slice(2) as [string, string, string]\n' +
        'const sinkFor = (cwd: string) =>\n' +
        '  createVinayaLogSink({\n' +
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
      { cwd: tmpdir(), encoding: 'utf8', env: { ...stripVinayaEnv(), PATH: `${binDir}:${process.env.PATH ?? ''}` } },
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

describe('log-sink — the branch read outlives nothing (O1)', () => {
  it('answers null and kills a git that hangs, rather than holding the process open', async () => {
    // Run in a CHILD: the probe needs a hanging `git` first on `PATH`, and
    // a `PATH` mutation in this process would reach every other test file
    // sharing it. Without the child's own `timeout` option the call sits
    // for the full 30s, long past the deadline the caller already answered
    // at, and the process cannot exit while it runs.
    const binDir = mkdtempSync(join(tmpdir(), 'vinaya-hanging-git-'))
    writeFileSync(join(binDir, 'git'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 })
    const probe = join(binDir, 'probe.ts')
    writeFileSync(
      probe,
      `import { resolveBranchIssue } from ${JSON.stringify(BRANCH_ISSUE_MODULE)}\n` +
        'const started = Date.now()\n' +
        'const issue = await resolveBranchIssue(process.argv[2] as string)\n' +
        'console.log(JSON.stringify({ issue, ms: Date.now() - started }))\n'
    )
    const started = Date.now()
    const run = spawnSyncBudgeted(
      'bun',
      [probe, binDir],
      { cwd: tmpdir(), encoding: 'utf8', env: { ...stripVinayaEnv(), PATH: `${binDir}:${process.env.PATH ?? ''}` } },
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
