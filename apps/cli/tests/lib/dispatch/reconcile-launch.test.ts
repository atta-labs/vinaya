import { describe, expect, it } from 'vitest'
import {
  classifyChildLiveness,
  reconcileLaunch,
  type ReconcileLaunchDeps
} from '../../../src/lib/dev-review-loop/developer-dispatch'
import type { LaunchRecord, ParsedLaunch, ProcessSnapshot } from '../../../src/lib/dispatch'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const THIS_HOST = 'test-host'

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * Issue #660, O3 — this process's OWN environment, when it is itself a
 * dispatched Developer/Reviewer session, carries `VINAYA_RUNTIME_DIR`
 * (checked before `$HOME` by `resolveRuntimeDirUncached`). Spreading
 * `...process.env` into a fixture's real subprocess hands it THIS machine's
 * real, shared runtime directory regardless of the fixture's own isolated
 * `$HOME` — confirmed live: this file's own hardcoded task `44` collided
 * with a stale launch record from an earlier leaked run of this exact file.
 * Same fix `dev-review-loop.test.ts`'s `fixtureChildEnv` already applies;
 * `VINAYA_RUN_ID` alone (the prior, narrower strip) was not enough.
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

/**
 * Issue #660, O3 round 3 (reviewer F2) — this file's own doc comment above
 * claimed "the same fix `dev-review-loop.test.ts`'s `fixtureChildEnv`
 * already applies", but only the env-stripping half was ported: both real
 * `execFileSync` fixtures below (the orphan and reaper scripts) ran with no
 * timeout, so a genuine lock/epoch collision with another fixture or task
 * run hung synchronously forever with zero diagnostic. Kept below this
 * file's own `it(..., 15_000)` bound so a real hang is caught here, with the
 * child's own captured output, before the test framework's bare timeout.
 */
const SUBPROCESS_BUDGET_MS = 6_000

function runFixtureScript(scriptPath: string, cwd: string, env: NodeJS.ProcessEnv): void {
  try {
    execFileSync('bun', [scriptPath], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      timeout: SUBPROCESS_BUDGET_MS,
      killSignal: 'SIGKILL'
    })
  } catch (e) {
    const err = e as { signal?: string | null; stdout?: Buffer | string; stderr?: Buffer | string }
    if (err.signal) {
      throw new Error(
        `reconcile-launch.test.ts subprocess killed by ${err.signal} after exceeding its ${SUBPROCESS_BUDGET_MS}ms budget ` +
          `(script: ${scriptPath})\n--- stdout ---\n${err.stdout ?? ''}\n--- stderr ---\n${err.stderr ?? ''}`
      )
    }
    throw e
  }
}

const PROMPT_FILE_CONTENT = 'do the thing'

/** A launch record with sensible defaults; individual cases override only what they exercise. */
function record(overrides: Partial<LaunchRecord> = {}): LaunchRecord {
  return {
    runId: 'run-1',
    role: 'developer',
    agent: 'claude',
    repo: { owner: 'acme', repo: 'widgets' },
    task: 42,
    pr: null,
    round: 1,
    attempt: 1,
    effectId: 'eff-1',
    dispatcherPid: 1000,
    childPid: 2000,
    childStartedAt: null,
    childCommand: null,
    host: THIS_HOST,
    startedAt: '2026-09-14T00:00:00.000Z',
    status: 'completed',
    resumeId: 'sess-1',
    boundAt: '2026-09-14T00:00:01.000Z',
    finishedAt: '2026-09-14T00:00:02.000Z',
    failureReason: null,
    ...overrides
  }
}

/**
 * Deps whose pid-liveness answer, hostname, and process-snapshot answer are
 * fixed per case. `isAlive` drives BOTH `isPidAlive` (probed for the
 * dispatcher pid by `classifyChildLiveness`) and whether `getProcessSnapshot`
 * finds anything at all at the queried (child) pid — `snapshot` names what it
 * finds when it does, defaulting to a child still parented to `record()`'s
 * own default `dispatcherPid` (1000) so every pre-existing "live" case here
 * keeps meaning what it always meant.
 */
function deps(
  isAlive: boolean,
  host = THIS_HOST,
  snapshot: ProcessSnapshot = { ppid: 1000, startedAt: null, command: null }
): ReconcileLaunchDeps {
  return {
    isPidAlive: () => isAlive,
    hostname: () => host,
    getProcessSnapshot: () => (isAlive ? snapshot : null),
    terminateChild: () => {}
  }
}

describe('reconcileLaunch (O3) — no prior launch', () => {
  it('an absent record is nothing to reconcile — dispatch fresh', () => {
    const out = reconcileLaunch({ status: 'absent' }, { requireContinuity: true }, deps(false))
    expect(out.kind).toBe('none')
  })

  it('a corrupt record with continuity required pauses explicitly — never a silent fresh start', () => {
    const out = reconcileLaunch({ status: 'corrupt', reason: 'torn write' }, { requireContinuity: true }, deps(false))
    expect(out.kind).toBe('pause')
    if (out.kind === 'pause') expect(out.detail).toContain('corrupt')
  })

  it('a corrupt record with continuity NOT required is just nothing to reconcile', () => {
    const out = reconcileLaunch({ status: 'corrupt', reason: 'torn' }, { requireContinuity: false }, deps(false))
    expect(out.kind).toBe('none')
  })
})

describe('reconcileLaunch (O3) — a live launch is found by identity', () => {
  it('crash between spawn and session binding: the child pid is still alive on this host, so the launch is LIVE — found by identity, never spawned again', () => {
    // The exact fault: the driver died after spawn wrote the child pid but
    // before any session id was bound (resumeId null, status still launched).
    // Recovery must find the still-live child rather than start a duplicate.
    const parsed: ParsedLaunch = {
      status: 'ok',
      record: record({ status: 'launched', resumeId: null, boundAt: null, finishedAt: null, childPid: 2000 })
    }
    const out = reconcileLaunch(parsed, { requireContinuity: true }, deps(true))
    expect(out.kind).toBe('live')
    if (out.kind === 'live') expect(out.record.childPid).toBe(2000)
  })

  it('a launch recorded on a DIFFERENT host is never treated as live — its pid cannot be probed here', () => {
    const parsed: ParsedLaunch = { status: 'ok', record: record({ status: 'launched', resumeId: null }) }
    // isPidAlive would say true, but the record's host is not ours.
    const out = reconcileLaunch(parsed, { requireContinuity: true }, deps(true, 'some-other-host'))
    expect(out.kind).not.toBe('live')
  })

  it('a null child pid (a launch that never spawned) is never live', () => {
    const parsed: ParsedLaunch = {
      status: 'ok',
      record: record({ status: 'interrupted', childPid: null, resumeId: 'sess-1' })
    }
    const out = reconcileLaunch(parsed, { requireContinuity: true }, deps(true))
    expect(out.kind).not.toBe('live')
  })

  it('a live pid with a live recorded parent still returns live — no regression on the duplicate-worker guard', () => {
    const parsed: ParsedLaunch = {
      status: 'ok',
      record: record({ status: 'launched', resumeId: null, dispatcherPid: 1000, childPid: 2000 })
    }
    const out = reconcileLaunch(
      parsed,
      { requireContinuity: true },
      deps(true, THIS_HOST, { ppid: 1000, startedAt: null, command: null })
    )
    expect(out.kind).toBe('live')
  })
})

describe('reconcileLaunch (O2, Issue #605) — an orphaned child is a takeover, never live', () => {
  it('a live pid whose PPID is 1 (reparented to init) never reads live — the driver that spawned it is gone', () => {
    const parsed: ParsedLaunch = {
      status: 'ok',
      record: record({ status: 'launched', dispatcherPid: 1000, childPid: 2000, resumeId: 'sess-mid' })
    }
    const out = reconcileLaunch(
      parsed,
      { requireContinuity: true },
      deps(true, THIS_HOST, { ppid: 1, startedAt: null, command: null })
    )
    expect(out.kind).not.toBe('live')
    // Continuity was required and a session was already bound before the
    // driver died — the orphan is a TAKEOVER (resume that exact session),
    // never a block and never a silent fresh start.
    expect(out.kind).toBe('resume')
    if (out.kind === 'resume') expect(out.resumeId).toBe('sess-mid')
  })

  it('`classifyChildLiveness` names the orphan case directly, for the recovery wrapper to reap', () => {
    const rec = record({ status: 'launched', dispatcherPid: 1000, childPid: 2000 })
    const liveness = classifyChildLiveness(rec, deps(true, THIS_HOST, { ppid: 1, startedAt: null, command: null }))
    expect(liveness).toBe('orphaned')
  })

  it('a reparented child whose OWN recorded dispatcher pid no longer answers is also orphaned, not live', () => {
    const parsed: ParsedLaunch = {
      status: 'ok',
      record: record({ status: 'launched', dispatcherPid: 1000, childPid: 2000, resumeId: null })
    }
    // The child still shows its old dispatcher as parent (ppid matches),
    // but that dispatcher pid itself no longer answers a liveness probe —
    // still never live.
    const out = reconcileLaunch(
      parsed,
      { requireContinuity: true },
      {
        isPidAlive: () => false,
        hostname: () => THIS_HOST,
        getProcessSnapshot: () => ({ ppid: 1000, startedAt: null, command: null }),
        terminateChild: () => {}
      }
    )
    expect(out.kind).not.toBe('live')
  })
})

describe("reconcileLaunch (O3, Issue #605) — a recycled pid is never treated as this launch's child", () => {
  it('a live pid whose recorded start time no longer matches is a DIFFERENT process — never live, never touched', () => {
    const parsed: ParsedLaunch = {
      status: 'ok',
      record: record({
        status: 'launched',
        dispatcherPid: 1000,
        childPid: 2000,
        childStartedAt: 'Mon Sep 14 10:00:00 2026',
        childCommand: 'claude',
        resumeId: null
      })
    }
    // Same pid, same live parent — but the OS has recycled it: a different
    // process now answers at that pid, with a different start time.
    const out = reconcileLaunch(
      parsed,
      { requireContinuity: true },
      deps(true, THIS_HOST, { ppid: 1000, startedAt: 'Tue Sep 15 09:00:00 2026', command: 'claude' })
    )
    expect(out.kind).not.toBe('live')
  })

  it("a live pid whose recorded command no longer matches is likewise never this launch's child", () => {
    const rec = record({
      status: 'launched',
      dispatcherPid: 1000,
      childPid: 2000,
      childStartedAt: null,
      childCommand: 'claude'
    })
    const liveness = classifyChildLiveness(
      rec,
      deps(true, THIS_HOST, { ppid: 1000, startedAt: null, command: 'some-unrelated-process' })
    )
    expect(liveness).toBe('not-ours')
  })

  it('round 3 security review, MEDIUM: a captured field the LIVE snapshot cannot read back is never trusted as a match — fail closed, not silently skipped', () => {
    // The record captured a real start time at spawn time (`childStartedAt`
    // non-null) — but the live re-snapshot's own `ps` read of that field
    // came back empty (a transient failure, a permissions hiccup, a race),
    // never itself proof this is the same process. Before the fix, a `null`
    // on either side skipped the comparison entirely and fell through to a
    // bare ppid+liveness match — exactly the gap a recycled pid could hide
    // behind whenever the live read happened to come back partial.
    const rec = record({
      status: 'launched',
      dispatcherPid: 1000,
      childPid: 2000,
      childStartedAt: 'Mon Sep 14 10:00:00 2026',
      childCommand: null
    })
    const liveness = classifyChildLiveness(rec, deps(true, THIS_HOST, { ppid: 1000, startedAt: null, command: null }))
    expect(liveness).toBe('not-ours')
  })

  it('round 3 security review, MEDIUM: same fail-closed rule for a captured command the live snapshot cannot read back', () => {
    const rec = record({
      status: 'launched',
      dispatcherPid: 1000,
      childPid: 2000,
      childStartedAt: null,
      childCommand: 'claude'
    })
    const liveness = classifyChildLiveness(rec, deps(true, THIS_HOST, { ppid: 1000, startedAt: null, command: null }))
    expect(liveness).toBe('not-ours')
  })

  it('with no identity ever recorded (a pre-this-task record), a live pid with a live parent is still trusted as live', () => {
    // Backward compatibility: `childStartedAt`/`childCommand` are `null` on
    // any launch record written before this task — there is nothing to
    // compare, so identity is never the reason a genuinely live launch on a
    // live host stops being found.
    const rec = record({
      status: 'launched',
      dispatcherPid: 1000,
      childPid: 2000,
      childStartedAt: null,
      childCommand: null
    })
    const liveness = classifyChildLiveness(
      rec,
      deps(true, THIS_HOST, { ppid: 1000, startedAt: 'whatever', command: 'whatever' })
    )
    expect(liveness).toBe('live')
  })
})

describe('reconcileLaunch (O3) — required continuity resumes the exact session', () => {
  it('a finished launch with a bound session resumes THAT exact session', () => {
    const parsed: ParsedLaunch = { status: 'ok', record: record({ status: 'completed', resumeId: 'sess-1' }) }
    const out = reconcileLaunch(parsed, { requireContinuity: true, artifactsPresent: true }, deps(false))
    expect(out.kind).toBe('resume')
    if (out.kind === 'resume') expect(out.resumeId).toBe('sess-1')
  })

  it('an INTERRUPTED launch whose session was bound before the interruption still resumes that exact session (O1 ↔ O3)', () => {
    const parsed: ParsedLaunch = {
      status: 'ok',
      record: record({ status: 'interrupted', failureReason: 'timeout', resumeId: 'sess-mid' })
    }
    const out = reconcileLaunch(parsed, { requireContinuity: true }, deps(false))
    expect(out.kind).toBe('resume')
    if (out.kind === 'resume') expect(out.resumeId).toBe('sess-mid')
  })
})

describe('reconcileLaunch (O3) — an unavailable session pauses explicitly', () => {
  it('expired/gone session: an interrupted launch whose session was never bound cannot be resumed — pause explicitly', () => {
    // The honest "there is no session to resume" case — a fresh session would
    // silently lose the worker's continuity, so recovery pauses instead.
    const parsed: ParsedLaunch = {
      status: 'ok',
      record: record({ status: 'interrupted', failureReason: 'crash', resumeId: null, boundAt: null })
    }
    const out = reconcileLaunch(parsed, { requireContinuity: true }, deps(false))
    expect(out.kind).toBe('pause')
    if (out.kind === 'pause') {
      expect(out.reason).toBe('infrastructure')
      expect(out.detail).toContain('cannot resume the exact session')
    }
  })
})

describe('reconcileLaunch (O3) — a reviewer is never resumed for continuity', () => {
  it('with continuity NOT required, a finished launch is finished — never a resume, even with a session on record', () => {
    const parsed: ParsedLaunch = { status: 'ok', record: record({ status: 'completed', resumeId: 'sess-1' }) }
    const out = reconcileLaunch(parsed, { requireContinuity: false, artifactsPresent: true }, deps(false))
    expect(out.kind).toBe('finished')
    if (out.kind === 'finished') expect(out.outcome.status).toBe('completed')
  })

  it('a finished launch with no artifacts is classified incomplete by the normalizer, exit code notwithstanding', () => {
    const parsed: ParsedLaunch = { status: 'ok', record: record({ status: 'completed', resumeId: 'sess-1' }) }
    const out = reconcileLaunch(parsed, { requireContinuity: false, artifactsPresent: false }, deps(false))
    expect(out.kind).toBe('finished')
    if (out.kind === 'finished') expect(out.outcome.status).toBe('incomplete')
  })
})

describe("recoverDeveloperLaunch (O2, Issue #605, code review, MAJOR) — the reap step goes through ReconcileLaunchDeps, never dispatch.ts's terminateChildWithGrace directly", () => {
  it('reaps a genuinely orphaned child through the INJECTED terminateChild — not a hardcoded real signal', () => {
    // Proves the seam, not just the pure classifier: builds a REAL orphan
    // (a subprocess that spawns a long-lived child via `dispatchRole`, writes
    // the launch record, then exits — reparenting its child to init, exactly
    // O2's "driver died without reaching shutdown" case) and calls
    // `recoverDeveloperLaunch` with a `terminateChild` SPY that never sends a
    // real signal. Before this fix, `recoverDeveloperLaunch` called
    // `dispatch.ts`'s `terminateChildWithGrace` directly, ignoring whatever
    // `terminateChild` a test injected — so a spy here would have been
    // provably bypassed: the real process would have died anyway. This test
    // fails on that old code (the process would already be gone by the time
    // it checks) and passes only when the reap genuinely routes through
    // `deps.terminateChild`.
    const home = tempDir('vinaya-reconcile-home-')
    const cwd = tempDir('vinaya-reconcile-cwd-')
    const binDir = tempDir('vinaya-reconcile-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    // O3 (Issue #670) — bounded to 30s rather than an unbounded wait: this
    // test's own `finally` below kills it well inside that window, but a
    // teardown that never runs still cannot leave this process burning a
    // core for hours. Same bound `dispatch.test.ts`'s own
    // `writeIdentityStableFakeBinary` now carries.
    writeFileSync(
      join(binDir, 'claude'),
      `#!${process.execPath}\nprocess.stdin.resume()\nsetTimeout(() => process.exit(0), 30000)\nawait new Promise(() => {})\n`
    )
    chmodSync(join(binDir, 'claude'), 0o755)

    const dispatchLib = join(CLI_ROOT, 'src', 'lib', 'dispatch.ts')
    const orphanScript = join(cwd, 'make-orphan.ts')
    writeFileSync(
      orphanScript,
      [
        `import { dispatchRole, readLaunchRecord } from ${JSON.stringify(dispatchLib)}`,
        `import { writeFileSync as writeFileSyncOrphan } from 'node:fs'`,
        `const opts = { promptFile: ${JSON.stringify(promptFile)}, task: 44 }`,
        `void dispatchRole('developer', 'claude', 'p', opts)`,
        // Round 2 review, MINOR — records the observed pid to the outer
        // test's pid file the INSTANT the launch record carries one, inside
        // the poll loop itself, rather than only after `waitForChildPid`
        // returns. A genuinely raced record write (the real child already
        // spawned, but the record naming its pid lands just past the poll
        // window) can still make the whole wait throw with no pid ever
        // observed here — a fixture-level race no poll loop closes for
        // free — but this at least captures the pid the moment it becomes
        // visible, never only after the function's own return.
        `const pidFile = ${JSON.stringify(join(cwd, 'orphan-pid.txt'))}`,
        'async function waitForChildPid(timeoutMs) {',
        '  const start = Date.now()',
        '  while (Date.now() - start < timeoutMs) {',
        `    const parsed = readLaunchRecord('developer', 'claude', null, 44)`,
        "    if (parsed.status === 'ok' && parsed.record.childPid !== null) {",
        '      writeFileSyncOrphan(pidFile, String(parsed.record.childPid))',
        '      return',
        '    }',
        '    await new Promise((r) => setTimeout(r, 50))',
        '  }',
        `  throw new Error('timed out waiting for the launch record to carry a childPid')`,
        '}',
        'await waitForChildPid(5000)',
        // Exit WITHOUT terminating the child — this process's own death is
        // what reparents it to init, the orphan condition under test.
        'process.exit(0)'
      ].join('\n')
    )
    // `stripVinayaEnv` (this file's own O3 fix, above) supersedes the
    // narrower `VINAYA_RUN_ID`/`VINAYA_RUNTIME_DIR`-only deletes an earlier
    // version of this fixture used — merged from origin/main's independent
    // issue-657 O5 fix, same root cause (a `VINAYA_RUNTIME_DIR` inherited
    // from the calling shell silently redirects this fixture's real launch
    // record to the operator's actual, non-isolated `~/.vinaya`).
    const spawnEnv: NodeJS.ProcessEnv = stripVinayaEnv({
      ...process.env,
      HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ''}`
    })
    const orphanPidPath = join(cwd, 'orphan-pid.txt')
    // Round 2 review, MINOR — this call itself is now wrapped: the script
    // writes `orphanPidPath` the moment it observes a childPid (above), so
    // even a non-zero exit here (the in-script 5s wait throwing) does not
    // skip reading whatever pid the script already captured before dying.
    // Only the genuine race where NO pid was ever observed within the
    // window (the real child spawned, but the launch record's own write
    // landed even later than that) still has nothing to read here — a
    // fixture-level race, not a swallowed error. Issue #660, O3 round 3
    // (reviewer F2) — the budget/timeout/diagnostic is layered on top of
    // that pre-existing swallow: only a genuine `SIGKILL`-by-budget (real
    // lock contention) throws here; a plain non-zero exit (the in-script
    // timeout) still falls through to the pid-file read below, unchanged.
    try {
      execFileSync('bun', [orphanScript], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: spawnEnv,
        timeout: SUBPROCESS_BUDGET_MS,
        killSignal: 'SIGKILL'
      })
    } catch (e) {
      const err = e as { signal?: string | null; stdout?: Buffer | string; stderr?: Buffer | string }
      if (err.signal) {
        throw new Error(
          `reconcile-launch.test.ts orphan-script subprocess killed by ${err.signal} after exceeding its ${SUBPROCESS_BUDGET_MS}ms budget\n` +
            `--- stdout ---\n${err.stdout ?? ''}\n--- stderr ---\n${err.stderr ?? ''}`
        )
      }
      // Non-zero exit is expected on a timeout throw; the pid file (if the
      // script got far enough to write one) is still read below.
    }

    // issue-657, O5 — a real, deliberately-orphaned process now exists
    // (the whole point of this test). Everything from here on is wrapped in
    // `try`/`finally` so a genuinely alive `orphanPid` is killed no matter
    // what happens next — an assertion failure, a throw inside the reaper
    // script, `execFileSync` itself throwing on a non-zero exit — never left
    // to survive this test the way this file's own #605 incident did before
    // this fix (found live: a confined agent for a fake task left running
    // for two hours after a test like this one failed mid-way through).
    const orphanPidRaw = existsSync(orphanPidPath) ? readFileSync(orphanPidPath, 'utf8').trim() : ''
    const orphanPid = orphanPidRaw.length > 0 ? Number(orphanPidRaw) : null

    try {
      const developerDispatchLib = join(CLI_ROOT, 'src', 'lib', 'dev-review-loop', 'developer-dispatch.ts')
      const reaperScript = join(cwd, 'reap-attempt.ts')
      const resultPath = join(cwd, 'result.json')
      writeFileSync(
        reaperScript,
        [
          `import { writeFileSync } from 'node:fs'`,
          `import { execFileSync } from 'node:child_process'`,
          `import { hostname } from 'node:os'`,
          `import { recoverDeveloperLaunch } from ${JSON.stringify(developerDispatchLib)}`,
          `import { readLaunchRecord, getProcessSnapshot } from ${JSON.stringify(dispatchLib)}`,
          `const before = readLaunchRecord('developer', 'claude', null, 44)`,
          `const childPid = before.status === 'ok' ? before.record.childPid : null`,
          'let spyCalledWith = null',
          'const deps = {',
          '  isPidAlive: (pid) => { try { process.kill(pid, 0); return true } catch { return false } },',
          '  hostname: () => hostname(),',
          '  getProcessSnapshot,',
          '  terminateChild: (pid) => { spyCalledWith = pid }',
          '}',
          `const out = recoverDeveloperLaunch(44, 'claude', null, {}, deps)`,
          'let stillAlive = false',
          'if (childPid !== null) {',
          `  try { execFileSync('ps', ['-p', String(childPid)], { stdio: ['ignore', 'ignore', 'ignore'] }); stillAlive = true } catch { stillAlive = false }`,
          '}',
          `writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ childPid, spyCalledWith, stillAlive, kind: out.kind }))`,
          'process.exit(0)'
        ].join('\n')
      )
      runFixtureScript(reaperScript, cwd, spawnEnv)

      const result = JSON.parse(readFileSync(resultPath, 'utf8')) as {
        childPid: number
        spyCalledWith: number | null
        stillAlive: boolean
        kind: string
      }
      // The injected spy — not a real signal — is what actually reaped it.
      expect(result.spyCalledWith).toBe(result.childPid)
      // Because the spy is a no-op, the real process must still be alive: proof
      // the call was routed through `deps.terminateChild`, not a hardcoded
      // `terminateChildWithGrace` the test's own spy could never intercept.
      expect(result.stillAlive).toBe(true)
      // With no session ever bound, continuity required, and the record still
      // reading 'launched': pause explicitly once the (fake) reap has run.
      expect(result.kind).toBe('pause')
    } finally {
      // The one real kill this test performs — unconditional, regardless of
      // how the `try` block above exited. O1 (Issue #670): the pid AND its
      // process group both — the group kill (`-pid`) is a no-op (`ESRCH`)
      // whenever the vendor was never a group leader itself, and the real
      // cleanup on any path where it was. Guarded on `> 0` the same way
      // `worker-boundary.test.ts`'s `spawnConfinedSync` already is.
      if (orphanPid !== null && orphanPid > 0) {
        try {
          process.kill(orphanPid, 'SIGKILL')
        } catch {
          // ESRCH — already gone.
        }
        try {
          process.kill(-orphanPid, 'SIGKILL')
        } catch {
          // ESRCH — never its own group leader, or already gone.
        }
      }
      rmSync(home, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
      rmSync(binDir, { recursive: true, force: true })
    }
  }, 15_000)
})
