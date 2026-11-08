/**
 * `dispatchRole`'s spawn/timeout/attribution behavior (task 3,
 * `vinaya-log-v1`, Issue #406) — exercised through the real `vinaya dispatch`
 * CLI entry point (`execFileSync('bun', [INDEX, ...])`, same discipline as
 * `apps/cli/tests/commands/issue.test.ts`'s fake `gh`), never by importing
 * `dispatchRole` in-process: `harness/processes/vinaya-strict/integration/config/compose.ts`'s
 * `GLOBAL_VINAYA_HOME` is a module-level constant frozen at first import from
 * whatever `HOME` happens to be, and `@attalabs/aeg-forge-state`'s
 * `resolveRepo()` caches its result for the process lifetime — an in-process
 * `bun:test` run sharing either with another test file in the same run could
 * silently pollute the real developer machine's own `~/.vinaya/outbox/` or
 * read a stale cached repo. A fresh subprocess per test sidesteps both: a
 * scratch `HOME`, and a scratch, non-git `cwd` so `resolveRepo()` resolves
 * `null` (the `unresolved/` outbox bucket) every time.
 */

import { programCommandLine } from '../../../tools/programs.js'
import { afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { execFileSync, execSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readdirSync, statSync } from 'node:fs'
import {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_REVIEWER_TIMEOUT_MS,
  parseClaudeModel,
  parseClaudeResumeId,
  parseClaudeUsage,
  renderClaudeEvent,
  HEARTBEAT_INTERVAL_MS,
  MAX_TEE_BYTES,
  openOutputTee,
  timeoutWarningLeadMs,
  resolveDispatchTimeoutMs,
  colourAgentLine,
  colourEnabled,
  colourLoopLine
} from '../../../loops/dev-review/dispatch/dispatch.js'
import {
  claimLaunchAttribution,
  createEngineLogSink,
  launchUsageEvents,
  withDispatchUsage
} from '../../../bin/run-engine'
import {
  CLI_ROOT,
  INDEX,
  pathWithoutRealVendors,
  collectLaunchedChildren,
  killLaunchedChild,
  stripVinayaEnv,
  runDispatch,
  runScriptWithBudget,
  spawnBudgeted,
  writeFakeBinary,
  writeIdentityStableFakeBinary,
  outboxLines,
  PROMPT_FILE_CONTENT,
  SESSION_ID,
  transcriptLine,
  plantTranscript,
  readArgv,
  withoutTurnResultFlag,
  RESUME_VENDOR_FIXTURES,
  teeDirOf,
  readWhenReady
} from './dispatch-fixtures.js'

const tempDirs: string[] = []
afterEach(() => {
  // O1: unconditional — runs whether the test above passed, failed, or hit
  // its own subprocess budget, since `afterEach` fires regardless of how the
  // test body exited.
  for (const dir of tempDirs.splice(0)) {
    for (const child of collectLaunchedChildren(dir)) killLaunchedChild(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(prefix: string): string {
  // The real path: macOS reaches its temporary directory through a symlink, and
  // tests that compare paths must see the same spelling the product resolves to.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  tempDirs.push(dir)
  return dir
}

describe('dispatchRole — a successful dispatch', () => {
  it('starts the child with attribution on its env, hashes the prompt, and parses printed usage', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const envOut = join(cwd, 'env.out')
    const stdinOut = join(cwd, 'stdin.out')
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\nenv > "${envOut}"\ncat > "${stdinOut}"\necho '{"usage":{"input_tokens":11,"output_tokens":22}}'\nexit 0\n`
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    // `--task` is given (to confirm `VINAYA_TASK` propagates) but no `gh` is
    // provided on PATH and `cwd` is not a git repo, so `dispatchCommand`'s
    // trailing `flushOutbox` call (task 3, `#482`, O1) refuses locally —
    // safely, before any network call (confirmed live: `gh issue comment`
    // outside a git repo fails on repo resolution alone). That refusal is
    // deliberate here — a SUCCEEDING flush would truncate the very outbox
    // lines this test reads below — but never reaches this process's own
    // exit code any more: `flushOutbox` never calls `process.exit`, and
    // `dispatchCommand` catches its thrown `LogFlushError` and logs it to
    // stderr, non-fatally, exactly as its own doc comment promises. `--task`'s
    // effect on env attribution and the log lines themselves is this test's
    // concern, not the flush (see `apps/cli/tests/commands/dispatch.test.ts`
    // for that).
    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile, '--task', '9001'],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(0)

    const env = readFileSync(envOut, 'utf8')
    expect(env).toMatch(/^VINAYA_ROLE=developer$/m)
    expect(env).toMatch(/^VINAYA_TASK=9001$/m)
    expect(env).toMatch(/^VINAYA_RUN_ID=.+$/m)

    expect(readFileSync(stdinOut, 'utf8')).toBe(PROMPT_FILE_CONTENT)

    const lines = outboxLines(home, 9001) as Array<Record<string, unknown>>
    const dispatched = lines.find((l) => l.event === 'dispatched')
    const outcome = lines.find((l) => l.event === 'outcome_received')
    for (const line of lines) {
      expect(line.meta).toMatchObject({
        work: { change: null, revision: null },
        lineage: { attempt: 1, parent: null },
        provenance: 'parent_attributed'
      })
    }
    expect(dispatched).toBeDefined()
    expect((dispatched as { prompt_hash: string }).prompt_hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(outcome).toBeDefined()
    expect((outcome as { usage: { input: number; output: number } }).usage).toEqual({ input: 11, output: 22 })
    expect((outcome as { target_role: string }).target_role).toBe('developer')
    // O2: the vendor name is never recorded in this field — the defect this
    // task closes. No `--model` was given here, so the placeholder for "the
    // vendor's own default ran" is recorded instead of `'claude'`.
    expect((outcome as { model: string }).model).toBe('default')
  })

  for (const explicitPr of [true, false]) {
    it(`attributes every launcher family across repeated attempts with ${explicitPr ? 'an explicit' : 'an inherited'} pull request`, () => {
      const home = tempDir('vinaya-header-home-')
      const cwd = tempDir('vinaya-header-cwd-')
      const binDir = tempDir('vinaya-header-bin-')
      const envOut = join(cwd, 'env.out')
      writeFakeBinary(
        binDir,
        'claude',
        `#!/bin/sh\nprintf 'VINAYA_PR=%s\\nVINAYA_ATTEMPT=%s\\n' "\${VINAYA_PR-}" "\${VINAYA_ATTEMPT-}" > "${envOut}"\ncat > /dev/null\necho '{"usage":{"input_tokens":11,"output_tokens":22}}'\nexit 0\n`
      )
      const promptFile = join(cwd, 'prompt.txt')
      writeFileSync(promptFile, PROMPT_FILE_CONTENT)
      for (let attempt = 1; attempt <= 2; attempt++) {
        const result = runDispatch(
          [
            'developer',
            '--agent',
            'claude',
            '--prompt-file',
            promptFile,
            '--task',
            '9001',
            ...(explicitPr ? ['--pr', '977'] : [])
          ],
          cwd,
          home,
          `${binDir}:${pathWithoutRealVendors()}`,
          { VINAYA_PR: '978' }
        )
        expect(result.status).toBe(0)
        const lines = outboxLines(home, 9001) as Array<{
          kind: string
          attempt?: number
          meta: { work: { change: string }; lineage: { attempt: number }; provenance: string }
        }>
        const current = lines.filter((line) => line.meta.lineage.attempt === attempt)
        expect(new Set(current.map((line) => line.kind))).toEqual(new Set(['dispatch', 'role_attempt', 'usage']))
        for (const line of current) {
          expect(line.meta.work.change).toBe(explicitPr ? '977' : '978')
          expect(line.meta.provenance).toBe('parent_attributed')
          if (line.kind === 'role_attempt') expect(line.attempt).toBe(attempt)
        }
        expect(current.length).toBe(4)
        expect(lines.length).toBe(attempt * 4)
        const childEnv = readFileSync(envOut, 'utf8')
        expect(childEnv).toBe('VINAYA_PR=978\nVINAYA_ATTEMPT=\n')
      }
    })
  }

  // O1/O3: the value a dispatched role reads to recognize its OWN driver. The
  // regression it closes: a Developer ran `ps`, found the `vinaya task run`
  // process that had launched it, read two runs racing on one branch, and
  // stopped before its first step. The driver is this launching process — not
  // the vendor CLI it spawns — so the assertion compares the value the child
  // received against the launch record's own `dispatcherPid`, which the driver
  // wrote about ITSELF (`process.pid`) before spawning anything. Run for a
  // code-reviewer as well as a developer: the value is set beside the attribution
  // every role already receives, never only the developer's.
  for (const [role, task] of [
    ['developer', 9101],
    ['code-reviewer', 9102]
  ] as const) {
    it(`tells a dispatched ${role} its own driver's pid, equal to the driver's own`, () => {
      const home = tempDir('vinaya-dispatch-home-')
      const cwd = tempDir('vinaya-dispatch-cwd-')
      const binDir = tempDir('vinaya-dispatch-bin-')
      const driverPidOut = join(cwd, 'driver-pid.out')
      // Reads back exactly one environment value and nothing else — and
      // drains stdin, the way every other fake vendor in this file does,
      // because a real vendor reads its prompt from there. The first version
      // of this fixture exited without reading it and the dispatch came back
      // non-zero on the Linux CI runner (`Test (apps/cli, shard 2)`) while
      // passing on the authoring macOS host — the one structural difference
      // from this file's long-passing sibling fixture, which drains it.
      writeFakeBinary(
        binDir,
        'claude',
        `#!/bin/sh\ncat > /dev/null\nprintf '%s' "$VINAYA_DRIVER_PID" > "${driverPidOut}"\nexit 0\n`
      )
      const promptFile = join(cwd, 'prompt.txt')
      writeFileSync(promptFile, PROMPT_FILE_CONTENT)

      const r = runDispatch(
        [role, '--agent', 'claude', '--prompt-file', promptFile, '--task', String(task)],
        cwd,
        home,
        `${binDir}:${pathWithoutRealVendors()}`
      )
      // Named rather than asserted bare: a non-zero status here is always a
      // dispatch that refused or died, and its own stderr says which.
      if (r.status !== 0) {
        throw new Error(`vinaya dispatch exited ${r.status}\n--- stderr ---\n${r.stderr}\n--- stdout ---\n${r.stdout}`)
      }

      const received = readFileSync(driverPidOut, 'utf8')
      expect(received).toMatch(/^[0-9]+$/)

      const record = JSON.parse(
        readFileSync(
          join(
            home,
            '.vinaya',
            'runtime',
            'unresolved',
            'tasks-execution',
            String(task),
            'sessions',
            `${role}-claude.json`
          ),
          'utf8'
        )
      ) as { dispatcherPid: number }
      expect(Number.parseInt(received, 10)).toBe(record.dispatcherPid)
    })
  }

  it('Codex gives a normal stdin/JSONL dispatch workspace-write access', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const argvOut = join(cwd, 'argv.out')
    const stdinOut = join(cwd, 'stdin.out')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    writeFakeBinary(
      binDir,
      'codex',
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${argvOut}"\ncat > "${stdinOut}"\nprintf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'\n`
    )

    const r = runDispatch(
      ['developer', '--agent', 'codex', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )

    expect(r.status).toBe(0)
    expect(withoutTurnResultFlag(readArgv(argvOut), '--output-schema')).toEqual([
      'exec',
      '--sandbox',
      'workspace-write',
      '--strict-config',
      '--dangerously-bypass-hook-trust',
      '--skip-git-repo-check',
      '--json',
      '-'
    ])
    expect(readFileSync(stdinOut, 'utf8')).toBe(PROMPT_FILE_CONTENT)
  })
})

describe('dispatchRole — a crashing child', () => {
  it('logs dispatch_failed with reason crash on a non-zero exit', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    writeFakeBinary(binDir, 'claude', '#!/bin/sh\ncat > /dev/null\nexit 7\n')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(1)

    const lines = outboxLines(home, 'none') as Array<Record<string, unknown>>
    const failed = lines.find((l) => l.event === 'dispatch_failed')
    expect(failed).toBeDefined()
    // The `dispatch_failed` log event's own `reason` field is validated
    // against `@attalabs/aeg-core`'s schema (out of this task's surface) and
    // keeps reporting the real event class unchanged — `DispatchHandle`'s
    // own, CLI-local `failureReason` is where the finer `'unbound'`
    // distinction lives (Issue #636, O5; see the describe block below).
    expect((failed as { reason: string }).reason).toBe('crash')
  })
})

describe("dispatchRole — Issue #636, O5: a child that exits without ever binding a session is named 'unbound', not 'crash'/'timeout'", () => {
  it('a non-zero exit with no session ever reported returns failureReason "unbound", and says so on stderr', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    // Never prints a `session_id`-bearing line at all — the exact
    // "sandbox-exec whose vendor output stayed at 0 bytes" shape the brief's
    // motivating incident measured.
    writeFakeBinary(binDir, 'claude', '#!/bin/sh\ncat > /dev/null\nexit 7\n')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile, '--json'],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(1)

    const parsed = JSON.parse(r.stdout) as { data: { failureReason: string | null } }
    expect(parsed.data.failureReason).toBe('unbound')
    expect(r.stderr).toMatch(/without ever producing a working vendor session — failing now as 'unbound'/)
  })

  it('a crash AFTER the vendor bound a session still reports failureReason "crash", never "unbound"', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' '{"type":"system","subtype":"init","session_id":"bound-session-1"}'\nexit 7\n`
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile, '--json'],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(1)

    const parsed = JSON.parse(r.stdout) as { data: { failureReason: string | null } }
    expect(parsed.data.failureReason).toBe('crash')
  })
})

describe("dispatchRole — [task-operator-v1]/Issue #662, O2: a child that could not reach the vendor's backend is named 'connection-failed'", () => {
  it("a non-zero exit after a bound session AND a confirmed-live api_retry marker reports failureReason 'connection-failed', never 'crash'", () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    // The exact shape confirmed live against claude CLI 2.1.197 with
    // ANTHROPIC_BASE_URL pointed at an unreachable host — a bound session,
    // one or more api_retry lines, then the process gives up non-zero.
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh
cat > /dev/null
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"bound-session-1"}'
printf '%s\\n' '{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":500,"error_status":null,"error":"unknown","session_id":"bound-session-1"}'
exit 7
`
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile, '--json'],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(1)

    const parsed = JSON.parse(r.stdout) as { data: { failureReason: string | null } }
    expect(parsed.data.failureReason).toBe('connection-failed')
  })

  it('a non-zero exit with an api_retry marker but NO bound session still reports "unbound" — there is no exact session to resume', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh
cat > /dev/null
printf '%s\\n' '{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":500,"error_status":null,"error":"unknown","session_id":null}'
exit 7
`
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile, '--json'],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(1)

    const parsed = JSON.parse(r.stdout) as { data: { failureReason: string | null } }
    expect(parsed.data.failureReason).toBe('unbound')
  })
})

describe('dispatchRole — no matching binary on PATH', () => {
  it('refuses by name before any spawn attempt, logging only dispatch_failed', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const emptyBinDir = tempDir('vinaya-dispatch-empty-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    // `which` itself must resolve (from a real system dir) so this exercises
    // "claude absent from PATH", not "which itself missing" — same refused
    // outcome either way, but for the right reason.
    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${emptyBinDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(1)

    const lines = outboxLines(home, 'none') as Array<Record<string, unknown>>
    // A refused attempt now also logs its own
    // `role_attempt`/`usage` lines alongside the pre-existing
    // `dispatch_failed` — three lines, one per family, for one attempt.
    // `log()` writes each asynchronously (`log-sink.ts`'s own
    // `resolveRepo().then(...)`), so the three calls' lines can land in
    // either order — never asserted on position.
    expect(lines).toHaveLength(3)
    const dispatchLine = lines.find((l) => l.kind === 'dispatch')
    expect(dispatchLine?.event).toBe('dispatch_failed')
    expect((dispatchLine as { reason: string }).reason).toBe('refused')
    expect(lines.find((l) => l.kind === 'role_attempt')).toMatchObject({ outcome: 'capability_refused' })
    expect(lines.find((l) => l.kind === 'usage')).toMatchObject({ units: { input: null, output: null, cache: null } })
  })
})

describe('dispatchRole — a task continued on another agent', () => {
  it('records each dispatch’s own model on its dispatch and usage events across an agent switch', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    writeFakeBinary(
      binDir,
      'codex',
      `#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":4}}'\n`
    )
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\ncat > /dev/null\necho '{"usage":{"input_tokens":11,"output_tokens":22}}'\nexit 0\n`
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    const path = `${binDir}:${pathWithoutRealVendors()}`

    for (const [agent, model] of [
      ['codex', 'gpt-5.6-terra'],
      ['claude', 'claude-opus-5-5']
    ] as const) {
      const r = runDispatch(
        ['developer', '--agent', agent, '--model', model, '--prompt-file', promptFile, '--task', '9001'],
        cwd,
        home,
        path
      )
      expect(r.status).toBe(0)
    }

    const lines = outboxLines(home, 9001) as Array<Record<string, unknown>>
    for (const [agent, model] of [
      ['codex', 'gpt-5.6-terra'],
      ['claude', 'claude-opus-5-5']
    ] as const) {
      const ofAgent = lines.filter((l) => (l.model as string | undefined)?.includes(model))
      expect(
        ofAgent.some((l) => l.kind === 'dispatch'),
        `${agent} dispatch event`
      ).toBe(true)
      expect(
        ofAgent.some((l) => l.kind === 'usage'),
        `${agent} usage event`
      ).toBe(true)
    }
    // Each dispatch's usage event names its own model, not the other's.
    expect(
      lines
        .filter((l) => l.kind === 'usage')
        .map((l) => l.model)
        .sort()
    ).toEqual(
      expect.arrayContaining([expect.stringContaining('claude-opus-5-5'), expect.stringContaining('gpt-5.6-terra')])
    )
  })
})

describe('dispatchRole — present but not executable', () => {
  it('refuses the same way as absent, never spawning', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    const p = join(binDir, 'claude')
    writeFileSync(p, '#!/bin/sh\nexit 0\n')
    chmodSync(p, 0o644) // present, not executable

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(1)
    const lines = outboxLines(home, 'none') as Array<Record<string, unknown>>
    expect(lines).toHaveLength(3)
    const dispatchLine = lines.find((l) => l.kind === 'dispatch')
    expect((dispatchLine as { reason: string }).reason).toBe('refused')
    expect(lines.find((l) => l.kind === 'role_attempt')).toMatchObject({ outcome: 'capability_refused' })
  })
})

describe('dispatchRole — timeout ceiling', () => {
  it('uses reviewerTimeoutMs for reviewers while a Developer keeps timeoutMs', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    writeFakeBinary(binDir, 'claude', '#!/bin/sh\ncat > /dev/null\nexec sleep 2\n')
    writeFileSync(
      join(cwd, 'vinaya.config.json'),
      JSON.stringify({ dispatch: { timeoutMs: 5000, reviewerTimeoutMs: 1000, killGraceMs: 100 } })
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    const path = `${binDir}:${pathWithoutRealVendors()}`

    const reviewer = runDispatch(['code-reviewer', '--agent', 'claude', '--prompt-file', promptFile], cwd, home, path)
    expect(reviewer.status).toBe(1)
    expect(
      (outboxLines(home, 'none') as Array<Record<string, unknown>>).some(
        (line) => line.event === 'dispatch_failed' && line.reason === 'timeout'
      )
    ).toBe(true)

    const developer = runDispatch(['developer', '--agent', 'claude', '--prompt-file', promptFile], cwd, home, path)
    expect(developer.status).toBe(0)
  }, 10_000)

  it('defaults both reviewer roles to twenty minutes without changing the Developer default', () => {
    expect(DEFAULT_REVIEWER_TIMEOUT_MS).toBe(1_200_000)
    expect(resolveDispatchTimeoutMs('code-reviewer', undefined)).toBe(DEFAULT_REVIEWER_TIMEOUT_MS)
    expect(resolveDispatchTimeoutMs('security', undefined)).toBe(DEFAULT_REVIEWER_TIMEOUT_MS)
    expect(resolveDispatchTimeoutMs('developer', undefined)).toBe(DEFAULT_TIMEOUT_MS)
  })

  it('SIGTERMs a child that ignores it, then SIGKILLs after the grace window, and the pid is actually gone', () => {
    // `killGraceMs` (task-run-v1 20, O2): the escalation this test proves —
    // SIGTERM ignored, SIGKILL follows once the grace window elapses — does
    // not need the real 5000ms production default to be observed, only a
    // real, non-zero window the child can be caught inside. Configuring it
    // down to 200ms cuts this test's real wall time by ~4.8s without
    // faking any of the process signalling it exercises.
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const pidFile = join(cwd, 'pid')
    writeFakeBinary(binDir, 'claude', `#!/bin/sh\necho $$ > "${pidFile}"\ntrap '' TERM\ncat > /dev/null &\nsleep 30\n`)
    // 2500ms, not a shorter value: the shell itself needs real wall time —
    // under this bun:test file's own contention from other subprocess-heavy
    // tests, more than 1000ms — to start and reach its own `trap` statement
    // before `SIGTERM` arrives. A too-short ceiling kills the shell via
    // SIGTERM's default disposition before it ever traps the signal,
    // producing a false pass for the wrong reason (found live, authoring
    // this test: 300ms failed consistently, 1000ms failed intermittently
    // under full-suite contention).
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify({ dispatch: { timeoutMs: 2500, killGraceMs: 200 } }))
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(1)

    const lines = outboxLines(home, 'none') as Array<Record<string, unknown>>
    const failed = lines.find((l) => l.event === 'dispatch_failed')
    expect((failed as { reason: string }).reason).toBe('timeout')

    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(() => process.kill(pid, 0)).toThrow()
  }, 10_000)

  it('reports timeout even when the child exits cleanly on SIGTERM alone (no SIGKILL needed)', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    writeFakeBinary(binDir, 'claude', `#!/bin/sh\ncat > /dev/null &\ntrap 'exit 0' TERM\nsleep 30\n`)
    // Same startup-latency reasoning as the test above: the shell needs
    // real wall time, under this file's own subprocess contention, to
    // reach its own `trap` before `SIGTERM` arrives. killGraceMs: 200 (same
    // reasoning as the escalation test above) — the child exits cleanly on
    // SIGTERM alone here, so the grace window is never actually consumed
    // by a SIGKILL, but a small one still keeps this test from paying the
    // production default while the parent's own escalation timer is armed.
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify({ dispatch: { timeoutMs: 2500, killGraceMs: 200 } }))
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(1)
    const lines = outboxLines(home, 'none') as Array<Record<string, unknown>>
    const failed = lines.find((l) => l.event === 'dispatch_failed')
    expect((failed as { reason: string }).reason).toBe('timeout')
  }, 10_000)

  // O10 — a run's token record survives the manner of its death: the parent
  // captures usage from the accumulated stdout AT THE MOMENT it ends the
  // child, not only on a clean exit.
  it('a killed child still leaves real usage figures in the dispatch_failed line, not a hardcoded null', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    // Prints a complete stream-json usage line BEFORE going unresponsive —
    // the exact shape `parseClaudeUsage` reads. `stdout` is unbuffered on a
    // bare `echo`, so this line reaches the parent's `stdoutBuf` well before
    // the timeout ceiling fires.
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\necho '{"usage":{"input_tokens":184327,"output_tokens":22190,"cache_read_input_tokens":500}}'\ntrap '' TERM\ncat > /dev/null &\nsleep 30\n`
    )
    // killGraceMs: 200 — same reasoning as the escalation test above; this
    // test's own concern (usage survives the kill) needs only that a
    // SIGKILL eventually happens, not the production-sized window before it.
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify({ dispatch: { timeoutMs: 2500, killGraceMs: 200 } }))
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(1)

    const lines = outboxLines(home, 'none') as Array<Record<string, unknown>>
    const failed = lines.find((l) => l.event === 'dispatch_failed') as
      | { reason: string; usage: { input: number; output: number } | null }
      | undefined
    expect(failed?.reason).toBe('timeout')
    expect(failed?.usage).toEqual({ input: 184327, output: 22190 })

    // The richer `usage` family event survives the
    // kill exactly the same way — including the cache breakout the
    // pre-existing `dispatch` family's own usage field has no room for.
    const usageEvent = lines.find((l) => l.kind === 'usage') as
      | { units: { input: number | null; output: number | null; cache: number | null }; unknown_reason: string | null }
      | undefined
    expect(usageEvent?.units).toEqual({ input: 184327, output: 22190, cache: 500 })
    expect(usageEvent?.unknown_reason).toBeNull()
    expect(lines.find((l) => l.kind === 'role_attempt')).toMatchObject({ outcome: 'timed_out' })
  }, 10_000)
})

describe('dispatchRole — transcript usage fallback', () => {
  const initLine = JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION_ID })

  it('a clean exit with no usage line records the transcript totals as the claude-transcript source', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    plantTranscript(join(home, '.claude'), SESSION_ID, [
      transcriptLine('m1', 100, 20, 30, 40),
      transcriptLine('m1', 100, 20, 30, 40),
      transcriptLine('m2', 1, 2, 3, 4)
    ])
    writeFakeBinary(binDir, 'claude', `#!/bin/sh\ncat > /dev/null\necho '${initLine}'\nexit 0\n`)
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(0)
    const usageEvents = (outboxLines(home, 'none') as Array<Record<string, unknown>>).filter((l) => l.kind === 'usage')
    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0]).toMatchObject({
      source: 'claude-transcript',
      semantics: 'cumulative',
      units: { input: 101, output: 22, cache: 77 },
      unknown_reason: null
    })
  }, 20_000)

  it('a killed dispatch still records the usage its transcript holds so far', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    plantTranscript(join(home, '.claude'), SESSION_ID, [transcriptLine('m1', 7, 8, 9, 10)])
    writeFakeBinary(binDir, 'claude', `#!/bin/sh\necho '${initLine}'\ntrap '' TERM\ncat > /dev/null &\nsleep 30\n`)
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify({ dispatch: { timeoutMs: 2500, killGraceMs: 200 } }))
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(1)
    const lines = outboxLines(home, 'none') as Array<Record<string, unknown>>
    expect(lines.find((l) => l.event === 'dispatch_failed')).toMatchObject({ reason: 'timeout' })
    expect(lines.find((l) => l.kind === 'usage')).toMatchObject({
      source: 'claude-transcript',
      units: { input: 7, output: 8, cache: 19 },
      unknown_reason: null
    })
  }, 20_000)

  it('with neither a stream usage line nor a transcript the units are unknown and the reason names both', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    writeFakeBinary(binDir, 'claude', `#!/bin/sh\ncat > /dev/null\necho '${initLine}'\nexit 0\n`)
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(0)
    const usage = (outboxLines(home, 'none') as Array<Record<string, unknown>>).find((l) => l.kind === 'usage') as {
      source: string
      units: Record<string, unknown>
      unknown_reason: string
    }
    expect(usage.source).toBe('claude')
    expect(usage.units).toEqual({ input: null, output: null, cache: null })
    expect(usage.unknown_reason).toContain('claude emitted no stream-json line')
    expect(usage.unknown_reason).toContain('session transcript')
  }, 20_000)
})

// O4 — the Vinaya log's `usage` event is the record of a turn's token use now
// that a pull-request body carries no token table. Nothing in the collection
// path reads a PR body, so a clean dispatch still lands real figures: this
// pins that end to end, against a fake role whose stdout carries exactly the
// stream-json shape `parseClaudeUsage` reads.
describe("dispatchRole — a dispatched role's usage event survives the PR-body token table's retirement", () => {
  it('a clean dispatch emits one usage event carrying the real input/output/cache figures', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\ncat > /dev/null\necho '{"usage":{"input_tokens":91442,"output_tokens":7318,"cache_creation_input_tokens":40,"cache_read_input_tokens":60}}'\nexit 0\n`
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(0)

    const lines = outboxLines(home, 'none') as Array<Record<string, unknown>>
    const usageEvents = lines.filter((l) => l.kind === 'usage')
    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0]).toMatchObject({
      event: 'observed',
      // Both Anthropic cache fields sum into one figure — see `parseUsageDetail`.
      units: { input: 91442, output: 7318, cache: 100 },
      unknown_reason: null
    })
    // The turn itself is a clean one, so no failure path supplied these numbers.
    expect(lines.find((l) => l.event === 'dispatch_failed')).toBeUndefined()
    expect(lines.find((l) => l.event === 'outcome_received')).toBeDefined()
  })
})

describe('dispatchRole — stderr content never decides the outcome', () => {
  it('a child that writes to stderr but exits 0 is still outcome_received, not a failure', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    writeFakeBinary(binDir, 'claude', `#!/bin/sh\ncat > /dev/null\necho 'noisy warning' 1>&2\necho '{}'\nexit 0\n`)
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(0)
    const lines = outboxLines(home, 'none') as Array<Record<string, unknown>>
    expect(lines.find((l) => l.event === 'outcome_received')).toBeDefined()
    expect(lines.find((l) => l.event === 'dispatch_failed')).toBeUndefined()
  })
})

describe('dispatchRole — usage is read from the end of the stream', () => {
  /** Runs one in-process `dispatchRole` against the given fake `claude` and returns its handle. */
  function dispatchHandle(fakeClaude: string): {
    usage: { input: number; output: number } | null
    cacheUsage: { read: number; creation: number } | null
  } {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    writeFakeBinary(binDir, 'claude', fakeClaude)
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    const handleOut = join(cwd, 'handle.json')
    const dispatchLib = join(
      CLI_ROOT,
      '..',
      '..',
      'harness',
      'processes',
      'vinaya-strict',
      'loops',
      'dev-review',
      'dispatch',
      'dispatch.ts'
    )
    const script = join(cwd, 'one-dispatch.ts')
    writeFileSync(
      script,
      [
        `import { writeFileSync } from 'node:fs'`,
        `import { dispatchRole } from ${JSON.stringify(dispatchLib)}`,
        `const handle = await dispatchRole('developer', 'claude', 'p', { promptFile: ${JSON.stringify(promptFile)} })`,
        `writeFileSync(${JSON.stringify(handleOut)}, JSON.stringify({ usage: handle.usage, cacheUsage: handle.cacheUsage ?? null }))`
      ].join('\n')
    )
    runScriptWithBudget(
      script,
      cwd,
      stripVinayaEnv({ ...process.env, HOME: home, PATH: `${binDir}:${pathWithoutRealVendors()}` })
    )
    return JSON.parse(readFileSync(handleOut, 'utf8'))
  }

  const USAGE_LINE =
    '{"type":"result","usage":{"input_tokens":12,"output_tokens":34,"cache_read_input_tokens":560,"cache_creation_input_tokens":78}}'

  it('a stream longer than the capture limit still reports the usage on its last line', () => {
    // 12,000 lines of 100 padding characters each: about 1,400,000 bytes
    // printed before the terminal usage line.
    const pad = 'x'.repeat(100)
    const handle = dispatchHandle(
      `#!/bin/sh\ncat > /dev/null\nyes '{"type":"assistant","pad":"${pad}"}' | head -n 12000\necho '${USAGE_LINE}'\nexit 0\n`
    )
    expect(handle.usage).toEqual({ input: 12, output: 34 })
    expect(handle.cacheUsage).toEqual({ read: 560, creation: 78 })
  })

  it('a short stream reports its usage as before', () => {
    const handle = dispatchHandle(`#!/bin/sh\ncat > /dev/null\necho '${USAGE_LINE}'\nexit 0\n`)
    expect(handle.usage).toEqual({ input: 12, output: 34 })
    expect(handle.cacheUsage).toEqual({ read: 560, creation: 78 })
  })
})

describe('dispatchRole — two dispatches in the same process', () => {
  it('each gets its own run_id via its own createLogSink call, with no shared mutable state', () => {
    // Calls `dispatchRole` twice from ONE dedicated subprocess (not two CLI
    // invocations) — the defeat case is about within-process state, which a
    // separate `bun dispatch` invocation per call would not exercise at all.
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    writeFakeBinary(binDir, 'claude', `#!/bin/sh\ncat > /dev/null\necho '{}'\nexit 0\n`)
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const dispatchLib = join(
      CLI_ROOT,
      '..',
      '..',
      'harness',
      'processes',
      'vinaya-strict',
      'loops',
      'dev-review',
      'dispatch',
      'dispatch.ts'
    )
    const script = join(cwd, 'two-dispatches.ts')
    writeFileSync(
      script,
      [
        `import { dispatchRole } from ${JSON.stringify(dispatchLib)}`,
        `const opts = { promptFile: ${JSON.stringify(promptFile)} }`,
        `await dispatchRole('developer', 'claude', 'p', opts)`,
        `await dispatchRole('developer', 'claude', 'p', opts)`
      ].join('\n')
    )

    // Strip an inherited `VINAYA_RUN_ID`: this test's own process can
    // itself be running inside a `vinaya dispatch` call (a nested dev-loop
    // invocation, or — found live — this very test suite run from inside
    // an agent session that `vinaya dispatch developer` started), which
    // sets `VINAYA_RUN_ID` in ITS OWN env for its own bookkeeping. Spreading
    // `...process.env` unfiltered would leak that value into the spawned
    // script, and `createLogSink`'s `VINAYA_RUN_ID || randomUUID()` would
    // then have both calls inherit the SAME id instead of minting two
    // distinct ones — collapsing the exact invariant this test exists to
    // prove, for a reason that has nothing to do with `dispatchRole` itself.
    const spawnEnv: NodeJS.ProcessEnv = stripVinayaEnv({
      ...process.env,
      HOME: home,
      PATH: `${binDir}:${pathWithoutRealVendors()}`
    })

    runScriptWithBudget(script, cwd, spawnEnv)

    // Each call's own `dispatched`/`role_attempt`/`usage`/`outcome_received`
    // quartet (added alongside dispatched/outcome_received) legitimately shares
    // ONE run_id (one `createLogSink()` call per `dispatchRole` invocation)
    // — the invariant under test is exactly two DISTINCT run_ids (one per
    // call), not that every line's run_id is unique.
    const lines = outboxLines(home, 'none') as Array<{ meta: { run_id: string } }>
    expect(lines.length).toBe(8)
    const runIds = new Set(lines.map((l) => l.meta.run_id))
    expect(runIds.size).toBe(2)
  })
})

describe("dispatchRole — child identity settles across the vendor's own exec hop (O3, Issue #605, code review)", () => {
  it('records the SETTLED process identity, not the shebang launcher it started as', () => {
    // A real npm-installed vendor CLI shebangs `#!/usr/bin/env node`: the
    // kernel's own shebang-triggered exec lands on `env`, and `env` THEN
    // performs its own, second, user-space exec into `node` — the same
    // process, but a different `comm`, landing some time after `spawn()`
    // already returned. Modeled here with a `/bin/sh` launcher that sleeps
    // briefly before `exec`-ing into the identity-stable leaf binary, so a
    // read taken the instant `spawn()` returns is guaranteed to still see
    // `sh`, not the process that survives.
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    const finalBinary = writeIdentityStableFakeBinary(binDir, 'claude-final')
    writeFakeBinary(binDir, 'claude', `#!/bin/sh\nsleep 0.3\nexec "${finalBinary}"\n`)

    const dispatchLib = join(
      CLI_ROOT,
      '..',
      '..',
      'harness',
      'processes',
      'vinaya-strict',
      'loops',
      'dev-review',
      'dispatch',
      'dispatch.ts'
    )
    const script = join(cwd, 'settle-identity.ts')
    const resultPath = join(cwd, 'result.json')
    writeFileSync(
      script,
      [
        `import { writeFileSync } from 'node:fs'`,
        `import { execFileSync } from 'node:child_process'`,
        `import { dispatchRole, readLaunchRecord } from ${JSON.stringify(dispatchLib)}`,
        `const opts = { promptFile: ${JSON.stringify(promptFile)}, task: 43 }`,
        // Fire-and-forget, exactly as the shutdown tests above do: the
        // child never exits on its own (`await new Promise(() => {})`).
        `void dispatchRole('developer', 'claude', 'p', opts)`,
        'async function waitForChildCommand(timeoutMs) {',
        '  const start = Date.now()',
        '  while (Date.now() - start < timeoutMs) {',
        `    const parsed = readLaunchRecord('developer', 'claude', null, 43)`,
        `    if (parsed.status === 'ok' && parsed.record.childCommand !== null) return parsed.record`,
        '    await new Promise((r) => setTimeout(r, 50))',
        '  }',
        `  throw new Error('timed out waiting for the launch record to carry a childCommand')`,
        '}',
        'const record = await waitForChildCommand(5000)',
        // Ground truth, via a FRESH `ps` read on the child's own pid, taken
        // well after the shell's own 0.3s exec hop has certainly landed —
        // never the same read `captureSettledChildSnapshot` itself took.
        `const groundTruth = execFileSync('ps', ['-p', String(record.childPid), '-o', 'comm='], { encoding: 'utf8' }).trim()`,
        `execFileSync('kill', ['-TERM', String(record.childPid)])`,
        `writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ childCommand: record.childCommand, groundTruth }))`,
        'process.exit(0)'
      ].join('\n')
    )

    const spawnEnv: NodeJS.ProcessEnv = stripVinayaEnv({
      ...process.env,
      HOME: home,
      PATH: `${binDir}:${pathWithoutRealVendors()}`
    })
    runScriptWithBudget(script, cwd, spawnEnv)

    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as { childCommand: string | null; groundTruth: string }
    // The launcher's own identity ('sh') must never be what gets recorded.
    expect(result.childCommand).not.toBe('sh')
    expect(result.childCommand).not.toBeNull()
    // The recorded identity must match the SETTLED process, confirmed by an
    // independent, later `ps` read on the same pid.
    expect(result.childCommand).toBe(result.groundTruth)
  }, 10_000)
})

describe('terminateLaunchedChildOnShutdown — driver shutdown termination (O1, Issue #605)', () => {
  it("terminates the dispatched child and marks the launch record 'interrupted', leaving no orphan", () => {
    // Exercises `terminateLaunchedChildOnShutdown` directly, the way
    // `dev-review-loop.ts`'s own SIGTERM/SIGINT handler calls it — from a
    // dedicated script subprocess (the "two dispatches" pattern above),
    // never by importing `dispatch.ts` into THIS test process (whose
    // `GLOBAL_VINAYA_HOME` is frozen at first import from the real `HOME`).
    // A real OS signal is never sent to this test's own process here:
    // `dev-review-loop.ts`'s handler wiring is a thin, one-line call into
    // this exact function, so what needs proving is the function's own
    // behavior, not Node's signal-delivery machinery.
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    // Identity-stable (round 5, CI flake fix — see the helper's own doc
    // comment) and, like `sleep`, terminates on a plain `SIGTERM` with no
    // grandchild left behind to reparent.
    writeIdentityStableFakeBinary(binDir, 'claude')

    const dispatchLib = join(
      CLI_ROOT,
      '..',
      '..',
      'harness',
      'processes',
      'vinaya-strict',
      'loops',
      'dev-review',
      'dispatch',
      'dispatch.ts'
    )
    const script = join(cwd, 'shutdown-terminate.ts')
    const resultPath = join(cwd, 'result.json')
    writeFileSync(
      script,
      [
        `import { writeFileSync } from 'node:fs'`,
        `import { execFileSync } from 'node:child_process'`,
        `import { dispatchRole, readLaunchRecord, terminateLaunchedChildOnShutdown } from ${JSON.stringify(dispatchLib)}`,
        `const opts = { promptFile: ${JSON.stringify(promptFile)}, task: 42 }`,
        // Fire-and-forget: this promise settles only once the child exits,
        // which (absent our own termination below) would not happen until
        // its own 30s sleep — never awaited here.
        `void dispatchRole('developer', 'claude', 'p', opts)`,
        'async function waitForChildPid(timeoutMs) {',
        '  const start = Date.now()',
        '  while (Date.now() - start < timeoutMs) {',
        `    const parsed = readLaunchRecord('developer', 'claude', null, 42)`,
        `    if (parsed.status === 'ok' && parsed.record.childPid !== null) return`,
        '    await new Promise((r) => setTimeout(r, 50))',
        '  }',
        `  throw new Error('timed out waiting for the launch record to carry a childPid')`,
        '}',
        'await waitForChildPid(5000)',
        `const before = readLaunchRecord('developer', 'claude', null, 42)`,
        `const childPid = before.status === 'ok' ? before.record.childPid : null`,
        // The call under test — synchronous, and (like the real SIGTERM
        // handler) never yielding to the event loop before the process
        // below reads the record back and exits.
        `terminateLaunchedChildOnShutdown('developer', 'claude', null, 42)`,
        `const after = readLaunchRecord('developer', 'claude', null, 42)`,
        // Real OS ground truth, via a fresh `ps` invocation — never
        // `process.kill(childPid, 0)` from THIS SAME process, which still
        // holds `dispatchRole`'s own (never-awaited, never-reaped)
        // `ChildProcess` handle open on `childPid`: that keeps reporting the
        // pid "alive" by this process's own bookkeeping for a beat after the
        // kernel has already reaped it, a same-process artifact with no
        // bearing on whether an orphan actually persists on the system.
        //
        // O4: reads the STAT column, not just whether the pid still has a
        // `ps` entry at all. Bun 1.2.14's synchronous `ps -p` call ran while
        // its own spin gave this fire-and-forget child's internal SIGCHLD
        // handling a chance to run first, so the entry was usually already
        // gone by the time this check ran. On Bun 1.4.2 that spin is gone,
        // so `ps -p` can find the child still present as a genuine kernel
        // zombie (`Z`) — terminated, exited, but not yet reaped by this
        // process's own never-awaited `ChildProcess` handle. A zombie is
        // dead, not an orphan; only a real, still-running state (anything
        // else `ps` reports) counts as still alive.
        'let childAlive = false',
        'if (childPid !== null) {',
        `  try { const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(childPid)], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); childAlive = stat.length > 0 && !stat.startsWith('Z') } catch { childAlive = false }`,
        '}',
        `writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ before, after, childAlive }))`,
        'process.exit(0)'
      ].join('\n')
    )

    const spawnEnv: NodeJS.ProcessEnv = stripVinayaEnv({
      ...process.env,
      HOME: home,
      PATH: `${binDir}:${pathWithoutRealVendors()}`
    })
    runScriptWithBudget(script, cwd, spawnEnv)

    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as {
      before: { status: string; record: { status: string; childPid: number } }
      after: { status: string; record: { status: string; failureReason: string | null; finishedAt: string | null } }
      childAlive: boolean
    }
    expect(result.before.record.status).toBe('launched')
    // O1: no orphan left behind.
    expect(result.childAlive).toBe(false)
    // O1: no stale `'launched'` record for the next start to misread as live.
    expect(result.after.record.status).toBe('interrupted')
    expect(result.after.record.failureReason).toBe('signal')
    expect(result.after.record.finishedAt).not.toBeNull()
  }, 10_000)

  it('round 4 security review, HIGH: never signals a pid whose recorded identity no longer matches — a stale record naming a recycled pid is left untouched', () => {
    // Simulates the exact scenario the finding named: the on-disk record
    // still names a real, live pid (our own spawned child, standing in for
    // "the OS has since recycled this number"), but its captured identity
    // (`childStartedAt`) no longer matches — exactly what recovery's own
    // `classifyChildLiveness` already refuses to treat as a match.
    // `terminateLaunchedChildOnShutdown` must refuse identically: no signal
    // sent, the child left running, the record still patched to
    // `'interrupted'` (there is nothing of THIS launch's own left to
    // terminate, accounted for all the same).
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    writeIdentityStableFakeBinary(binDir, 'claude')

    const dispatchLib = join(
      CLI_ROOT,
      '..',
      '..',
      'harness',
      'processes',
      'vinaya-strict',
      'loops',
      'dev-review',
      'dispatch',
      'dispatch.ts'
    )
    const script = join(cwd, 'shutdown-terminate-identity-mismatch.ts')
    const resultPath = join(cwd, 'result-identity-mismatch.json')
    const recordPath = join(
      home,
      '.vinaya',
      'runtime',
      'unresolved',
      'tasks-execution',
      '42',
      'sessions',
      'developer-claude.json'
    )
    writeFileSync(
      script,
      [
        `import { writeFileSync, readFileSync } from 'node:fs'`,
        `import { execFileSync } from 'node:child_process'`,
        `import { dispatchRole, readLaunchRecord, terminateLaunchedChildOnShutdown } from ${JSON.stringify(dispatchLib)}`,
        `const opts = { promptFile: ${JSON.stringify(promptFile)}, task: 42 }`,
        `void dispatchRole('developer', 'claude', 'p', opts)`,
        'async function waitForChildPid(timeoutMs) {',
        '  const start = Date.now()',
        '  while (Date.now() - start < timeoutMs) {',
        `    const parsed = readLaunchRecord('developer', 'claude', null, 42)`,
        `    if (parsed.status === 'ok' && parsed.record.childPid !== null) return`,
        '    await new Promise((r) => setTimeout(r, 50))',
        '  }',
        `  throw new Error('timed out waiting for the launch record to carry a childPid')`,
        '}',
        'await waitForChildPid(5000)',
        // Corrupt the record's own captured identity in place, on disk —
        // the real childPid is untouched (still our real sleeping child),
        // only what the record CLAIMS about it changes, exactly as a stale
        // record from an earlier, differently-identified process would read.
        `const raw = JSON.parse(readFileSync(${JSON.stringify(recordPath)}, 'utf8'))`,
        `raw.childStartedAt = 'Mon Jan 1 00:00:00 2024'`,
        `writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(raw, null, 2))`,
        `const before = readLaunchRecord('developer', 'claude', null, 42)`,
        `const childPid = before.status === 'ok' ? before.record.childPid : null`,
        `terminateLaunchedChildOnShutdown('developer', 'claude', null, 42)`,
        `const after = readLaunchRecord('developer', 'claude', null, 42)`,
        // O4: STAT-aware — a kernel zombie is dead, not still alive; see the
        // first shutdown test's own doc comment above for why this changed.
        'let childAlive = false',
        'if (childPid !== null) {',
        `  try { const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(childPid)], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); childAlive = stat.length > 0 && !stat.startsWith('Z') } catch { childAlive = false }`,
        '}',
        // Clean up the real child ourselves — the function under test must
        // NOT have done this, which is exactly what this test proves.
        "if (childPid !== null) { try { process.kill(childPid, 'SIGKILL') } catch {} }",
        `writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ before, after, childAlive }))`,
        'process.exit(0)'
      ].join('\n')
    )

    const spawnEnv: NodeJS.ProcessEnv = stripVinayaEnv({
      ...process.env,
      HOME: home,
      PATH: `${binDir}:${pathWithoutRealVendors()}`
    })
    runScriptWithBudget(script, cwd, spawnEnv)

    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as {
      before: { record: { status: string; childStartedAt: string } }
      after: { record: { status: string; failureReason: string | null } }
      childAlive: boolean
    }
    expect(result.before.record.childStartedAt).toBe('Mon Jan 1 00:00:00 2024')
    // The real point: identity mismatched, so the real child was NEVER signaled.
    expect(result.childAlive).toBe(true)
    // The record is still accounted for — nothing of THIS launch's own is
    // left in flight, even though the pid it once named turned out not to
    // be a match any more.
    expect(result.after.record.status).toBe('interrupted')
    expect(result.after.record.failureReason).toBe('signal')
  }, 10_000)

  it("round 3 review, MAJOR/HIGH: terminates a REVIEWER's dispatched child too — the driver now calls this for every in-flight role, not developer only", () => {
    // Same mechanism, same proof — `terminateLaunchedChildOnShutdown` takes
    // `role` as a plain parameter with no developer-specific logic inside
    // it; `dev-review-loop.ts`'s own SIGTERM/SIGINT handlers now call it for
    // `'code-reviewer'`/`'security'` too (both dispatched concurrently via
    // `Promise.all`, exactly as capable of being orphaned mid-round as the
    // developer's own launch).
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    writeIdentityStableFakeBinary(binDir, 'claude')

    const dispatchLib = join(
      CLI_ROOT,
      '..',
      '..',
      'harness',
      'processes',
      'vinaya-strict',
      'loops',
      'dev-review',
      'dispatch',
      'dispatch.ts'
    )
    const script = join(cwd, 'shutdown-terminate-reviewer.ts')
    const resultPath = join(cwd, 'result-reviewer.json')
    writeFileSync(
      script,
      [
        `import { writeFileSync } from 'node:fs'`,
        `import { execFileSync } from 'node:child_process'`,
        `import { dispatchRole, readLaunchRecord, terminateLaunchedChildOnShutdown } from ${JSON.stringify(dispatchLib)}`,
        `const opts = { promptFile: ${JSON.stringify(promptFile)}, task: 42 }`,
        `void dispatchRole('code-reviewer', 'claude', 'p', opts)`,
        'async function waitForChildPid(timeoutMs) {',
        '  const start = Date.now()',
        '  while (Date.now() - start < timeoutMs) {',
        `    const parsed = readLaunchRecord('code-reviewer', 'claude', null, 42)`,
        `    if (parsed.status === 'ok' && parsed.record.childPid !== null) return`,
        '    await new Promise((r) => setTimeout(r, 50))',
        '  }',
        `  throw new Error('timed out waiting for the launch record to carry a childPid')`,
        '}',
        'await waitForChildPid(5000)',
        `const before = readLaunchRecord('code-reviewer', 'claude', null, 42)`,
        `const childPid = before.status === 'ok' ? before.record.childPid : null`,
        `terminateLaunchedChildOnShutdown('code-reviewer', 'claude', null, 42)`,
        `const after = readLaunchRecord('code-reviewer', 'claude', null, 42)`,
        // O4: STAT-aware — a kernel zombie is dead, not still alive; see the
        // first shutdown test's own doc comment above for why this changed.
        'let childAlive = false',
        'if (childPid !== null) {',
        `  try { const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(childPid)], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); childAlive = stat.length > 0 && !stat.startsWith('Z') } catch { childAlive = false }`,
        '}',
        `writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ before, after, childAlive }))`,
        'process.exit(0)'
      ].join('\n')
    )

    const spawnEnv: NodeJS.ProcessEnv = stripVinayaEnv({
      ...process.env,
      HOME: home,
      PATH: `${binDir}:${pathWithoutRealVendors()}`
    })
    runScriptWithBudget(script, cwd, spawnEnv)

    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as {
      before: { record: { status: string } }
      after: { record: { status: string; failureReason: string | null } }
      childAlive: boolean
    }
    expect(result.before.record.status).toBe('launched')
    expect(result.childAlive).toBe(false)
    expect(result.after.record.status).toBe('interrupted')
    expect(result.after.record.failureReason).toBe('signal')
  }, 10_000)

  it("a launch record that already read 'completed' or 'interrupted' is left untouched — nothing left to terminate", () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    writeFakeBinary(binDir, 'claude', `#!/bin/sh\ncat > /dev/null\nprintf '%s' '{}'\nexit 0\n`)

    // A real, already-completed dispatch through the ordinary CLI path.
    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile, '--task', '43'],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(0)

    const dispatchLib = join(
      CLI_ROOT,
      '..',
      '..',
      'harness',
      'processes',
      'vinaya-strict',
      'loops',
      'dev-review',
      'dispatch',
      'dispatch.ts'
    )
    const script = join(cwd, 'shutdown-terminate-noop.ts')
    const resultPath = join(cwd, 'result-noop.json')
    writeFileSync(
      script,
      [
        `import { writeFileSync } from 'node:fs'`,
        `import { readLaunchRecord, terminateLaunchedChildOnShutdown } from ${JSON.stringify(dispatchLib)}`,
        `const before = readLaunchRecord('developer', 'claude', null, 43)`,
        `terminateLaunchedChildOnShutdown('developer', 'claude', null, 43)`,
        `const after = readLaunchRecord('developer', 'claude', null, 43)`,
        `writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ before, after }))`
      ].join('\n')
    )
    runScriptWithBudget(script, cwd, stripVinayaEnv({ ...process.env, HOME: home }))

    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as {
      before: { record: { status: string; finishedAt: string } }
      after: { record: { status: string; finishedAt: string } }
    }
    expect(result.before.record.status).toBe('completed')
    // Untouched: same status, same `finishedAt` — never re-patched to `interrupted`.
    expect(result.after.record.status).toBe('completed')
    expect(result.after.record.finishedAt).toBe(result.before.record.finishedAt)
  })
})

describe('dispatchRole — a shared run_id (a nested dispatch inheriting VINAYA_RUN_ID)', () => {
  it('correlates each of two concurrent dispatches by effect_id, not run_id alone (code-review finding, PR #441)', async () => {
    // A dispatched role's own `vinaya dispatch` call inherits its parent's
    // `VINAYA_RUN_ID` via the child's env (by design — no loop feature
    // needed, reachable today) — `createLogSink`'s `runId = deps.env().
    // VINAYA_RUN_ID || randomUUID()` then picks that inherited value
    // straight back up, so two concurrent dispatches CAN legitimately
    // share one run_id. Simulated here by exporting `VINAYA_RUN_ID` before
    // both calls, rather than actually nesting a real child dispatch.
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\ncat > /dev/null\necho '{"usage":{"input_tokens":11,"output_tokens":22}}'\nexit 0\n`
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const dispatchLib = join(
      CLI_ROOT,
      '..',
      '..',
      'harness',
      'processes',
      'vinaya-strict',
      'loops',
      'dev-review',
      'dispatch',
      'dispatch.ts'
    )
    const script = join(cwd, 'shared-run-id.ts')
    writeFileSync(
      script,
      [
        `import { dispatchRole } from ${JSON.stringify(dispatchLib)}`,
        `process.env.VINAYA_RUN_ID = 'shared-run-id-fixture'`,
        `const opts = { promptFile: ${JSON.stringify(promptFile)} }`,
        // Concurrent, not sequential — this is what makes a shared
        // run_id's two 'dispatched'/'outcome_received' pairs actually
        // race for the same (run_id, kind, event) match window.
        'await Promise.all([',
        `  dispatchRole('developer', 'claude', 'p', opts),`,
        `  dispatchRole('code-reviewer', 'claude', 'p', opts)`,
        '])'
      ].join('\n')
    )

    runScriptWithBudget(
      script,
      cwd,
      stripVinayaEnv({ ...process.env, HOME: home, PATH: `${binDir}:${pathWithoutRealVendors()}` })
    )

    const lines = outboxLines(home, 'none') as Array<{
      kind: string
      meta: { run_id: string }
      effect_id?: string
      event: string
      target_role?: string
    }>
    // Two concurrent dispatches, each now a `dispatched`/`role_attempt`/
    // `usage`/`outcome_received` quartet — eight lines.
    expect(lines.length).toBe(8)

    // Both calls really did share one run_id — the scenario under test,
    // not a fixture that accidentally avoided it.
    const runIds = new Set(lines.map((l) => l.meta.run_id))
    expect(runIds).toEqual(new Set(['shared-run-id-fixture']))

    // Despite the shared run_id, every `dispatch`/`role_attempt` line is
    // unambiguously attributable to its own call via effect_id — exactly
    // two distinct effect_ids, each carrying exactly one 'dispatched', one
    // 'attempted', and one 'outcome_received' line, agreeing on which role
    // they belong to (never a 'developer' line and a 'code-reviewer' line
    // sharing one effect_id). `usage` lines carry no `effect_id` at all
    // (`log/schema.ts`'s `usage` family) — excluded from this grouping,
    // never silently bucketed under an `undefined` key.
    const attributable = lines.filter((l) => l.kind !== 'usage')
    const byEffectId = new Map<string, typeof attributable>()
    for (const line of attributable) {
      const group = byEffectId.get(line.effect_id as string) ?? []
      group.push(line)
      byEffectId.set(line.effect_id as string, group)
    }
    expect(byEffectId.size).toBe(2)
    for (const group of byEffectId.values()) {
      expect(group.map((l) => l.event).sort()).toEqual(['attempted', 'dispatched', 'outcome_received'])
    }
    const dispatchLines = lines.filter((l) => l.kind === 'dispatch')
    expect(new Set(dispatchLines.map((l) => l.target_role))).toEqual(new Set(['developer', 'code-reviewer']))
  }, 10_000)
})

describe('dispatchRole — resume identifier (round-trip, per vendor)', () => {
  for (const fixture of RESUME_VENDOR_FIXTURES) {
    it(`${fixture.agent}: a successful dispatch returns resumeId, and --resume <id> reaches the child as that vendor's own resume argv`, () => {
      const synthId = '11111111-1111-1111-1111-111111111111'
      const home = tempDir('vinaya-dispatch-home-')
      const cwd = tempDir('vinaya-dispatch-cwd-')
      const binDir = tempDir('vinaya-dispatch-bin-')
      const argvOut = join(cwd, 'argv.out')
      const promptFile = join(cwd, 'prompt.txt')
      writeFileSync(promptFile, PROMPT_FILE_CONTENT)
      const path = `${binDir}:${pathWithoutRealVendors()}`

      // First dispatch: no `--resume` — the fake binary ignores its argv and
      // prints the vendor's real first-dispatch shape carrying `synthId`.
      writeFakeBinary(
        binDir,
        fixture.agent,
        `#!/bin/sh\ncat > /dev/null\nprintf '%s' '${fixture.firstStdout(synthId)}'\nexit 0\n`
      )
      const first = runDispatch(
        ['developer', '--agent', fixture.agent, '--prompt-file', promptFile, '--json'],
        cwd,
        home,
        path
      )
      expect(first.status).toBe(0)
      expect((JSON.parse(first.stdout) as { data: { resumeId: string | null } }).data.resumeId).toBe(synthId)

      // Second dispatch: `--resume <synthId>` — the fake binary now records
      // its own argv, one element per line, so the exact resume shape is
      // checkable rather than merely "some flag we hoped for."
      writeFakeBinary(
        binDir,
        fixture.agent,
        `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${argvOut}"\ncat > /dev/null\nprintf '%s' '${fixture.firstStdout(synthId)}'\nexit 0\n`
      )
      const second = runDispatch(
        ['developer', '--agent', fixture.agent, '--prompt-file', promptFile, '--resume', synthId, '--json'],
        cwd,
        home,
        path
      )
      expect(second.status).toBe(0)
      // O1 (#543): claude alone gets a trailing `--settings <path>` pair
      // (see the dedicated O1 describe block below) — stripped here so this
      // test keeps asserting the vendor-specific resume shape it always has.
      const actualArgv = readArgv(argvOut)
      if (fixture.agent === 'claude') {
        expect(actualArgv.slice(-2, -1)).toEqual(['--settings'])
        expect(withoutTurnResultFlag(actualArgv.slice(0, -2), '--json-schema')).toEqual(fixture.resumeArgv(synthId))
      } else if (fixture.agent === 'codex') {
        expect(withoutTurnResultFlag(actualArgv, '--output-schema')).toEqual(fixture.resumeArgv(synthId))
      } else {
        expect(actualArgv).toEqual(fixture.resumeArgv(synthId))
      }
    })
  }
})

/**
 * O8 (Issue #454). Answering a stopped agent goes through the resume path
 * that already exists (`--resume <id> --prompt-file <answer>`) — the gap
 * this closes is that the id it needs was never recorded anywhere a later,
 * separate invocation could find it, only printed to the window that ran
 * the dispatch that produced it.
 */
describe('dispatchRole — resume state durably recorded (O8)', () => {
  it('a successful dispatch with a resume id writes a record a later invocation can find, keyed by role/vendor/task, overwritten by the next run', () => {
    const synthId1 = '22222222-2222-2222-2222-222222222222'
    const synthId2 = '33333333-3333-3333-3333-333333333333'
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    const path = `${binDir}:${pathWithoutRealVendors()}`
    const recordPath = join(
      home,
      '.vinaya',
      'runtime',
      'unresolved',
      'tasks-execution',
      '454',
      'sessions',
      'developer-claude.json'
    )

    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\ncat > /dev/null\nprintf '%s' '{"session_id":"${synthId1}","usage":{"input_tokens":1,"output_tokens":1}}'\nexit 0\n`
    )
    // `--task` makes `dispatchCommand` also try `flushOutbox` with no `gh`
    // on PATH outside a git repo — refused locally, the same deliberate
    // shape the first `dispatchRole` describe block above documents, caught
    // non-fatally so it never reaches this process's own exit code. The
    // resume record is written by `dispatchRole` itself, before that flush
    // step ever runs, so it exists regardless.
    const first = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile, '--task', '454'],
      cwd,
      home,
      path
    )
    expect(first.status).toBe(0)

    const record1 = JSON.parse(readFileSync(recordPath, 'utf8')) as {
      resumeId: string
      role: string
      agent: string
      task: number | null
      pr: number | null
    }
    expect(record1.resumeId).toBe(synthId1)
    expect(record1.role).toBe('developer')
    expect(record1.agent).toBe('claude')
    expect(record1.task).toBe(454)
    expect(record1.pr).toBeNull()

    // Owner-only, matching the tee file's own permission discipline.
    expect(statSync(recordPath).mode & 0o777).toBe(0o600)

    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\ncat > /dev/null\nprintf '%s' '{"session_id":"${synthId2}","usage":{"input_tokens":1,"output_tokens":1}}'\nexit 0\n`
    )
    const second = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile, '--task', '454'],
      cwd,
      home,
      path
    )
    expect(second.status).toBe(0)

    // Overwritten, not appended — only the latest session is resumable.
    const record2 = JSON.parse(readFileSync(recordPath, 'utf8')) as { resumeId: string }
    expect(record2.resumeId).toBe(synthId2)
  })

  it('a dispatch with neither --task nor --pr records the id under an "unscoped" key', () => {
    const synthId = '44444444-4444-4444-4444-444444444444'
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    const path = `${binDir}:${pathWithoutRealVendors()}`

    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\ncat > /dev/null\nprintf '%s' '{"session_id":"${synthId}","usage":{"input_tokens":1,"output_tokens":1}}'\nexit 0\n`
    )
    const result = runDispatch(['developer', '--agent', 'claude', '--prompt-file', promptFile], cwd, home, path)
    expect(result.status).toBe(0)

    const recordPath = join(
      home,
      '.vinaya',
      'runtime',
      'unresolved',
      'tasks-execution',
      'unscoped',
      'sessions',
      'developer-claude.json'
    )
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as { resumeId: string; task: number | null }
    expect(record.resumeId).toBe(synthId)
    expect(record.task).toBeNull()
  })

  it('two different repos dispatching the same task number get two distinct records, keyed by repo (O5, #456)', () => {
    const synthIdA = '55555555-5555-5555-5555-555555555555'
    const synthIdB = '66666666-6666-6666-6666-666666666666'
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    const path = `${binDir}:${pathWithoutRealVendors()}`

    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\ncat > /dev/null\nprintf '%s' '{"session_id":"${synthIdA}","usage":{"input_tokens":1,"output_tokens":1}}'\nexit 0\n`
    )
    runDispatch(['developer', '--agent', 'claude', '--prompt-file', promptFile, '--task', '9'], cwd, home, path, {
      AEG_REPO: 'acme/tranche-a'
    })

    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\ncat > /dev/null\nprintf '%s' '{"session_id":"${synthIdB}","usage":{"input_tokens":1,"output_tokens":1}}'\nexit 0\n`
    )
    runDispatch(['developer', '--agent', 'claude', '--prompt-file', promptFile, '--task', '9'], cwd, home, path, {
      AEG_REPO: 'acme/tranche-b'
    })

    // Same tranche-local-looking task number (9), two different repos —
    // this is the live bug O5 closes: before the repo segment existed, the
    // second dispatch's record would have overwritten the first's.
    const recordA = JSON.parse(
      readFileSync(
        join(home, '.vinaya', 'runtime', 'acme-tranche-a', 'tasks-execution', '9', 'sessions', 'developer-claude.json'),
        'utf8'
      )
    ) as { resumeId: string }
    const recordB = JSON.parse(
      readFileSync(
        join(home, '.vinaya', 'runtime', 'acme-tranche-b', 'tasks-execution', '9', 'sessions', 'developer-claude.json'),
        'utf8'
      )
    ) as { resumeId: string }
    expect(recordA.resumeId).toBe(synthIdA)
    expect(recordB.resumeId).toBe(synthIdB)
  })

  it('an unsafe AEG_REPO value falls back to the unresolved bucket rather than escaping it (O5, #456)', () => {
    const synthId = '77777777-7777-7777-7777-777777777777'
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    const path = `${binDir}:${pathWithoutRealVendors()}`

    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\ncat > /dev/null\nprintf '%s' '{"session_id":"${synthId}","usage":{"input_tokens":1,"output_tokens":1}}'\nexit 0\n`
    )
    runDispatch(['developer', '--agent', 'claude', '--prompt-file', promptFile, '--task', '9'], cwd, home, path, {
      AEG_REPO: 'acme/../../../etc'
    })

    const recordPath = join(
      home,
      '.vinaya',
      'runtime',
      'unresolved',
      'tasks-execution',
      '9',
      'sessions',
      'developer-claude.json'
    )
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as { resumeId: string }
    expect(record.resumeId).toBe(synthId)
    expect(existsSync(join(home, '.vinaya', 'runtime', 'etc'))).toBe(false)
  })

  it('a crashing child that never reported a session keeps its interrupted intent record, with no session to resume (O1) — named unbound, not crash (Issue #636, O5)', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    const path = `${binDir}:${pathWithoutRealVendors()}`

    // Crashes before printing any `session_id` at all — the "failed attempts
    // can lose session identity" defect this task closes: the intent record
    // now PERSISTS (O1, launch intent written before spawn, never deleted on
    // an interrupt), marked `interrupted`, but with `resumeId: null` because
    // the vendor never reported one — the honest "there is genuinely no
    // session to resume" case, distinct from "no launch ever happened."
    //
    // Issue #636, O5: this exact case — exited, never bound a session — is
    // named `'unbound'`, not the generic `'crash'` every other non-zero exit
    // gets, so recovery can tell "the vendor never came up at all" apart from
    // "the vendor did real work, then died."
    writeFakeBinary(binDir, 'claude', '#!/bin/sh\ncat > /dev/null\nexit 7\n')
    const result = runDispatch(['developer', '--agent', 'claude', '--prompt-file', promptFile], cwd, home, path)
    expect(result.status).toBe(1)

    const recordPath = join(
      home,
      '.vinaya',
      'runtime',
      'unresolved',
      'tasks-execution',
      'unscoped',
      'sessions',
      'developer-claude.json'
    )
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as {
      status: string
      failureReason: string | null
      resumeId: string | null
    }
    expect(record.status).toBe('interrupted')
    expect(record.failureReason).toBe('unbound')
    // No session was ever bound — `readResumeRecord`'s own compat view returns
    // null for exactly this, so the loop still starts fresh rather than
    // resuming a session that never existed.
    expect(record.resumeId).toBeNull()
  })

  it('a crash AFTER the vendor reported its session keeps that session on the interrupted record — session identity survives the interruption (O1)', () => {
    const synthId = '88888888-8888-8888-8888-888888888888'
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    const path = `${binDir}:${pathWithoutRealVendors()}`

    // The vendor prints its session id (bound mid-stream), then exits non-zero
    // — before this task an interrupted attempt wrote no record at all and the
    // session was lost; now the bound session survives on the interrupted
    // record so recovery can resume the exact session.
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' '{"type":"system","subtype":"init","session_id":"${synthId}"}'\nexit 7\n`
    )
    const result = runDispatch(['developer', '--agent', 'claude', '--prompt-file', promptFile], cwd, home, path)
    expect(result.status).toBe(1)

    const recordPath = join(
      home,
      '.vinaya',
      'runtime',
      'unresolved',
      'tasks-execution',
      'unscoped',
      'sessions',
      'developer-claude.json'
    )
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as {
      status: string
      failureReason: string | null
      resumeId: string | null
    }
    expect(record.status).toBe('interrupted')
    expect(record.failureReason).toBe('crash')
    expect(record.resumeId).toBe(synthId)
  })
})

/** A credential-shaped GitHub token for the tee and role-log redaction cases, built from parts so no source line carries the literal. */
const FAKE_GITHUB_TOKEN = ['ghp', '0123456789abcdefghijklmnopqrstuvwxyz'].join('_')

describe('dispatch observability (#450)', () => {
  it('the shipped default deadline is four hours, not one', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(14_400_000)
    // The regression this pins: a one-hour default killed a dispatched agent
    // that had made five commits and was still working.
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(3_600_000)
  })

  it('warns before the deadline, never after it, and never at the deadline itself', () => {
    // Capped lead for a long run: four hours warns five minutes out.
    expect(timeoutWarningLeadMs(14_400_000)).toBe(300_000)
    // Short runs fall back to half the budget, so the warning still lands
    // while there is time to act rather than as the kill arrives.
    expect(timeoutWarningLeadMs(60_000)).toBe(30_000)
    expect(timeoutWarningLeadMs(1_000)).toBe(500)
    // The invariant that matters, across the whole range: strictly inside the
    // budget, so a warning is never scheduled at or past the SIGTERM.
    for (const budget of [1_000, 60_000, 600_000, 3_600_000, 14_400_000]) {
      const lead = timeoutWarningLeadMs(budget)
      expect(lead).toBeGreaterThan(0)
      expect(lead).toBeLessThan(budget)
    }
  })

  it('the heartbeat interval is short enough to distinguish working from hung', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(60_000)
    expect(HEARTBEAT_INTERVAL_MS).toBeGreaterThan(0)
  })

  it('tees child output to a readable file keyed by the run, and reads back what was written', async () => {
    const effectId = `test-${randomUUID()}`
    const tee = openOutputTee(effectId)
    expect(tee.path).not.toBeNull()
    expect(tee.path as string).toContain(effectId)

    tee.write(Buffer.from('first chunk\n'))
    tee.write(Buffer.from('second chunk\n'))
    tee.end()

    // The point of the tee is that a human can read it WHILE the run is alive,
    // so the bytes must actually reach the file rather than sit in a buffer.
    // `createWriteStream` flushes on the event loop, so this polls with an
    // await — a synchronous spin would block the very flush it waits for,
    // which is exactly how this test first failed.
    const deadline = Date.now() + 3000
    let contents = ''
    while (Date.now() < deadline) {
      try {
        contents = readFileSync(tee.path as string, 'utf8')
        if (contents.includes('second chunk')) break
      } catch {
        // not created yet
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(contents).toContain('first chunk')
    expect(contents).toContain('second chunk')
    rmSync(tee.path as string, { force: true })
  })

  it('refuses a traversal id outright, writing no file anywhere', () => {
    // The previous version of this test passed a traversal string and asserted
    // only that it did not throw — which is true of a function that happily
    // writes outside its directory. Assert the containment the name claims.
    // One real tee first, purely to learn where this process's own output
    // directory actually is (it resolves against the real repository this
    // checkout belongs to — see `teeDirOf`).
    const probe = openOutputTee(`test-${randomUUID()}`)
    probe.end()
    const teeDir = teeDirOf(probe.path as string)
    rmSync(probe.path as string, { force: true })

    const before = existsSync(teeDir) ? readdirSync(teeDir) : []
    for (const bad of ['nested/../../escape-attempt', '../escape', 'a/b', '', '.']) {
      const tee = openOutputTee(bad)
      expect(tee.path).toBeNull()
      tee.write(Buffer.from('must not be written'))
      tee.end()
    }
    const after = existsSync(teeDir) ? readdirSync(teeDir) : []
    expect(after).toEqual(before)
  })

  it('redacts credentials before they reach the file', async () => {
    const effectId = `test-${randomUUID()}`
    const tee = openOutputTee(effectId)
    // Exactly what a dispatched agent prints when it runs `env` or `gh auth token`.
    tee.write(Buffer.from(`GITHUB_TOKEN=${FAKE_GITHUB_TOKEN}\n`))
    tee.write(Buffer.from('Authorization: Bearer sk-secret-value-here\n'))
    tee.write(Buffer.from('harmless line\n'))
    tee.end()

    const contents = await readWhenReady(tee.path as string, 'harmless line')
    expect(contents).toContain('harmless line')
    expect(contents).not.toContain(FAKE_GITHUB_TOKEN)
    expect(contents).not.toContain('sk-secret-value-here')
    rmSync(tee.path as string, { force: true })
  })

  it('creates the log owner-only, inside an owner-only directory', async () => {
    const effectId = `test-${randomUUID()}`
    const tee = openOutputTee(effectId)
    tee.write(Buffer.from('x\n'))
    tee.end()
    await readWhenReady(tee.path as string, 'x')
    expect(statSync(tee.path as string).mode & 0o777).toBe(0o600)
    expect(statSync(teeDirOf(tee.path as string)).mode & 0o777).toBe(0o700)
    rmSync(tee.path as string, { force: true })
  })

  it('stops writing at the size cap instead of growing without bound', async () => {
    const effectId = `test-${randomUUID()}`
    const tee = openOutputTee(effectId)
    const chunk = Buffer.from(`${'y'.repeat(64 * 1024)}\n`)
    for (let i = 0; i < Math.ceil(MAX_TEE_BYTES / chunk.length) + 8; i++) tee.write(chunk)
    tee.end()
    await readWhenReady(tee.path as string, 'y')
    // Bounded by the cap. Slack is one chunk (the write that crosses the cap
    // is allowed to complete) plus the carry tail flushed at `end`.
    expect(statSync(tee.path as string).size).toBeLessThanOrEqual(MAX_TEE_BYTES + chunk.length + 512)
    // And it really did stop: without a cap this would be ~9 chunks larger.
    expect(statSync(tee.path as string).size).toBeLessThan(chunk.length * (Math.ceil(MAX_TEE_BYTES / chunk.length) + 8))
    rmSync(tee.path as string, { force: true })
  })
})

/**
 * The wiring, not the units. Every test above this block exercises
 * `openOutputTee`/`timeoutWarningLeadMs` directly; this one drives a REAL
 * `vinaya dispatch` against a fake vendor and asserts that the tee is
 * actually connected to the child's streams, lands under the run's own HOME,
 * and scrubs what the child printed. A unit test of the tee cannot catch the
 * tee being wired to nothing.
 */
describe('dispatch observability — wired through a real run (#450)', () => {
  it("tees the child's real output to HOME, redacted, and names the file on stderr", () => {
    const home = tempDir('vinaya-tee-home-')
    const cwd = tempDir('vinaya-tee-cwd-')
    const binDir = tempDir('vinaya-tee-bin-')
    // A vendor that prints a credential on stdout and a line on stderr —
    // exactly the shape of a coding agent running `env` mid-task.
    writeFakeBinary(
      binDir,
      'claude',
      '#!/bin/sh\ncat > /dev/null\n' +
        `echo 'GITHUB_TOKEN=${FAKE_GITHUB_TOKEN}'\n` +
        "echo 'diagnostic line on stderr' >&2\n" +
        'echo \'{"usage":{"input_tokens":1,"output_tokens":2}}\'\nexit 0\n'
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    // `spawnSync`, not the `runDispatch` helper above: that helper returns
    // `stderr: ''` on a successful run (`execFileSync` yields stdout only),
    // and the operator lines this test is about are written to stderr.
    const r = spawnBudgeted(
      [
        ...(programCommandLine(['dispatch']) as string[]),
        'developer',
        '--agent',
        'claude',
        '--prompt-file',
        promptFile
      ],
      {
        encoding: 'utf8',
        cwd,
        env: stripVinayaEnv({ ...process.env, HOME: home, PATH: `${binDir}:${pathWithoutRealVendors()}` })
      },
      'vinaya dispatch'
    )
    expect(r.status).toBe(0)

    // The normal lifecycle view names only the short start action; the
    // dispatch identifier and tee path remain confined to the raw file.
    expect(r.stderr).toMatch(/\d\d:\d\d:\d\d {2}> Developer {3}started/)
    expect(r.stderr).not.toContain('output teed to')

    const teeDir = join(home, '.vinaya', 'runtime', 'unresolved', 'tasks-execution', 'unscoped', 'output')
    const logs = readdirSync(teeDir)
    expect(logs).toHaveLength(1)
    const contents = readFileSync(join(teeDir, logs[0] as string), 'utf8')

    // Wired to BOTH streams — stderr was discarded entirely before this task.
    expect(contents).toContain('diagnostic line on stderr')
    // And scrubbed on the way: the child printed a token, the file has none.
    expect(contents).not.toContain(FAKE_GITHUB_TOKEN)
    expect(contents).toContain('GITHUB_TOKEN=')

    expect(statSync(join(teeDir, logs[0] as string)).mode & 0o777).toBe(0o600)
  })
})

describe('dispatch role log — redaction (round 2 review, SECURITY HIGH)', () => {
  it('never writes a token-shaped string from a rendered agent event to the role log', () => {
    const home = tempDir('vinaya-rolelog-home-')
    const cwd = tempDir('vinaya-rolelog-cwd-')
    const binDir = tempDir('vinaya-rolelog-bin-')
    const roleLogPath = join(cwd, 'role.log')
    // A `stream-json` line whose rendered text is exactly what a dispatched
    // agent's own tool output can echo — a real credential value, not a
    // synthetic marker — the same shape `openOutputTee`'s own redaction test
    // above exercises for the tee, now for `appendRoleLine`'s separate sink.
    const assistantLine = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: `GITHUB_TOKEN=${FAKE_GITHUB_TOKEN}` }]
      }
    })
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\ncat > /dev/null\necho '${assistantLine}'\necho '{"usage":{"input_tokens":1,"output_tokens":2}}'\nexit 0\n`
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile, '--role-log-path', roleLogPath],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(0)

    const contents = readFileSync(roleLogPath, 'utf8')
    expect(contents).toContain('Developer')
    expect(contents).toContain('GITHUB_TOKEN=')
    expect(contents).not.toContain(FAKE_GITHUB_TOKEN)
  })
})

describe('dispatch role log — each agent’s stream through its translator', () => {
  function dispatchLog(agent: 'codex', stream: string): string {
    const home = tempDir('vinaya-narr-home-')
    const cwd = tempDir('vinaya-narr-cwd-')
    const binDir = tempDir('vinaya-narr-bin-')
    const roleLogPath = join(cwd, 'role.log')
    const streamFile = join(binDir, 'stream.jsonl')
    writeFileSync(streamFile, stream)
    writeFakeBinary(binDir, agent, `#!/bin/sh\ncat > /dev/null\ncat '${streamFile}'\nexit 0\n`)
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    const r = runDispatch(
      ['developer', '--agent', agent, '--prompt-file', promptFile, '--role-log-path', roleLogPath],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(0)
    return readFileSync(roleLogPath, 'utf8')
  }

  it('a recorded Codex stream reaches the file as plain actions with real marks and detail lines', () => {
    const fixture = readFileSync(
      join(
        import.meta.dir,
        '../../../../../kernel/adapters/agents/fixtures/loop-narration/codex-developer-stream.jsonl'
      ),
      'utf8'
    )
    const contents = dispatchLog('codex', fixture)
    expect(contents).not.toMatch(/item\.(started|completed)|turn\.(started|completed)/)
    expect(contents).toMatch(/ {2}x Developer {3}Failed /m)
    expect(contents).toMatch(/ {2}· exit 1$/m)
    expect(contents).toMatch(/ {2}\+ Developer {3}Finished /m)
    expect(contents).toMatch(/ {2}> Developer {3}Reporting /m)
  })
})

/**
 * Role-prefixed, per-role-coloured terminal output (Issue #491, O1/O2/O3).
 * `colourEnabled`/`colourAgentLine`/`colourLoopLine` are exported for
 * exactly this reason — asserting the TTY/`NO_COLOR` predicate and the
 * per-role prefix needs no real vendor process, just a fixture stream.
 */
describe('terminal colour — role prefix and TTY/NO_COLOR gating (#491)', () => {
  const priorNoColor = process.env.NO_COLOR
  afterEach(() => {
    if (priorNoColor === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = priorNoColor
  })

  const ROLES = ['planner', 'developer', 'code-reviewer', 'security', 'principal', 'archivist', 'architect'] as const

  // Built via `new RegExp` rather than a `/\x1b.../` literal — a regex
  // LITERAL containing a raw control-character escape trips
  // `lint/suspicious/noControlCharactersInRegex`; a pattern built from a
  // string at runtime does not, and asserts exactly the same bytes.
  const ANSI_ESC = '\x1b'
  const ANSI_CODE_RE = new RegExp(`${ANSI_ESC}\\[\\d+m`)
  const ANSI_CODE_RE_G = new RegExp(`${ANSI_ESC}\\[\\d+m`, 'g')
  const ANSI_RESET_STR = `${ANSI_ESC}[0m`
  const ANSI_RESET_RE_G = new RegExp(`${ANSI_ESC}\\[0m`, 'g')
  const ANSI_ANY_RE = new RegExp(`${ANSI_ESC}\\[`)

  it('colourEnabled is true only on a live TTY with NO_COLOR unset', () => {
    delete process.env.NO_COLOR
    expect(colourEnabled({ isTTY: true })).toBe(true)
    expect(colourEnabled({ isTTY: false })).toBe(false)
    expect(colourEnabled({})).toBe(false)
    // Presence alone disables it (https://no-color.org) — even an empty value.
    process.env.NO_COLOR = ''
    expect(colourEnabled({ isTTY: true })).toBe(false)
    process.env.NO_COLOR = '1'
    expect(colourEnabled({ isTTY: true })).toBe(false)
  })

  for (const role of ROLES) {
    it(`colourAgentLine prefixes and colours a ${role} fixture line on a TTY, and gives every role a different colour`, () => {
      delete process.env.NO_COLOR
      const line = colourAgentLine(role, 'reading the brief', { isTTY: true })
      expect(line).toContain(
        ` ${role === 'code-reviewer' ? 'Code review' : role.charAt(0).toUpperCase() + role.slice(1)}   reading the brief`
      )
      expect(line).toMatch(ANSI_CODE_RE)
      expect(line.endsWith(ANSI_RESET_STR)).toBe(true)
      // Every other role's own line carries a DIFFERENT colour code — the
      // reader is separating roles at a glance, not reading the same code
      // for two different speakers.
      for (const other of ROLES) {
        if (other === role) continue
        const otherLine = colourAgentLine(other, 'reading the brief', { isTTY: true })
        const code = (s: string) => s.match(ANSI_CODE_RE)?.[0]
        expect(code(otherLine)).not.toBe(code(line))
      }
    })
  }

  it('colourAgentLine carries the prefix with NO escape codes off a TTY or under NO_COLOR', () => {
    delete process.env.NO_COLOR
    const plain = colourAgentLine('code-reviewer', 'reading the brief', { isTTY: false })
    expect(plain).toMatch(/^\d\d:\d\d:\d\d {2}> Code review {3}reading the brief$/)
    expect(plain).not.toMatch(ANSI_ANY_RE)

    process.env.NO_COLOR = '1'
    const noColour = colourAgentLine('code-reviewer', 'reading the brief', { isTTY: true })
    expect(noColour).toMatch(/^\d\d:\d\d:\d\d {2}▸ Code review {3}reading the brief$/)
    expect(noColour).not.toMatch(ANSI_ANY_RE)
  })

  it("colourLoopLine restyles the loop's own already-role-named text without stacking a second prefix", () => {
    delete process.env.NO_COLOR
    const text = '[vinaya dispatch abc-123] developer via claude: still running — 60s elapsed (ceiling 14400s)'
    const coloured = colourLoopLine(text, { isTTY: true })
    expect(coloured).toContain(text)
    expect(coloured).toMatch(ANSI_CODE_RE)
    expect(coloured.endsWith(ANSI_RESET_STR)).toBe(true)
    // No `[role]`-shaped prefix ADDED beyond the text's own existing naming.
    expect(coloured.replace(ANSI_CODE_RE_G, '').replace(ANSI_RESET_RE_G, '')).toBe(text)

    const plain = colourLoopLine(text, { isTTY: false })
    expect(plain).toBe(text)
  })

  it('a real dispatch (non-TTY, as every spawned child always is) writes the `[role]` prefix with no escape codes to stderr, and the dispatch-output tee stays byte-identical to the raw agent line — no prefix, no colour', () => {
    const home = tempDir('vinaya-colour-home-')
    const cwd = tempDir('vinaya-colour-cwd-')
    const binDir = tempDir('vinaya-colour-bin-')
    const rawEvent = '{"type":"assistant","message":{"content":[{"type":"text","text":"hello world"}]}}'
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\ncat > /dev/null\necho '${rawEvent}'\n` +
        'echo \'{"usage":{"input_tokens":1,"output_tokens":2}}\'\nexit 0\n'
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)

    const r = spawnBudgeted(
      [
        ...(programCommandLine(['dispatch']) as string[]),
        'developer',
        '--agent',
        'claude',
        '--prompt-file',
        promptFile
      ],
      {
        encoding: 'utf8',
        cwd,
        env: stripVinayaEnv({ ...process.env, HOME: home, PATH: `${binDir}:${pathWithoutRealVendors()}` })
      },
      'vinaya dispatch'
    )
    expect(r.status).toBe(0)

    // O1: the rendered line carries the role prefix even off a TTY (only
    // colour is TTY-gated, never the prefix) — and no escape sequence, since
    // `execFileSync`/`spawnSync` pipes are never a live terminal.
    expect(r.stderr).toMatch(/\d\d:\d\d:\d\d {2}> Developer {3}Writing\n {2}· hello world/)
    expect(r.stderr).not.toMatch(ANSI_ANY_RE)

    // O2: lifecycle output shares the renderer and does not expose the
    // dispatch id or raw-output path in its normal line.
    expect(r.stderr).toMatch(/\d\d:\d\d:\d\d {2}> Developer {3}started/)
    expect(r.stderr).not.toContain('[vinaya dispatch')

    // O3: the tee file never sees the rendered/prefixed stderr lines at
    // all — it tees the child's raw stdout/stderr chunks — so it carries the
    // exact bytes the fake agent printed, byte-identical to before this task.
    const teeDir = join(home, '.vinaya', 'runtime', 'unresolved', 'tasks-execution', 'unscoped', 'output')
    const logs = readdirSync(teeDir)
    expect(logs).toHaveLength(1)
    const teeContents = readFileSync(join(teeDir, logs[0] as string), 'utf8')
    expect(teeContents).toContain(rawEvent)
    expect(teeContents).not.toContain('[developer]')
    expect(teeContents).not.toMatch(ANSI_ANY_RE)
  })
})

/**
 * Streaming the agent's own output (Issue #447, O5). The cause is
 * vendor-agnostic — the child is spawned on pipes, sees no TTY, and every
 * vendor falls back to a buffered mode that prints nothing until exit — so
 * these cover the rendering contract each vendor plugs into, plus the two
 * parsers that had to learn to read a stream's terminal event instead of one
 * whole blob.
 */
describe('dispatch streaming output (#447 O5)', () => {
  it('renders an assistant turn as the text a human reads', () => {
    const line = renderClaudeEvent({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '  Reading the brief.  ' }] }
    })
    expect(line).toBe('Reading the brief.')
  })

  it('renders a tool call with the one field naming what it acted on', () => {
    expect(
      renderClaudeEvent({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.ts' } }] }
      })
    ).toBe('⚙ Edit: src/a.ts')
    expect(
      renderClaudeEvent({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'bun test' } }] }
      })
    ).toBe('⚙ Bash: bun test')
  })

  it('never renders a tool result, which is bulk already captured verbatim in the tee', () => {
    const line = renderClaudeEvent({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'x'.repeat(50_000) }] }
    })
    expect(line).toBeNull()
  })

  it('truncates a very long subject rather than flooding the terminal', () => {
    const long = `src/${'a'.repeat(400)}.ts`
    const line = renderClaudeEvent({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: long } }] }
    }) as string
    expect(line.length).toBeLessThan(140)
    expect(line.endsWith('...')).toBe(true)
  })

  it('renders nothing for an event that carries nothing worth showing', () => {
    expect(renderClaudeEvent({ type: 'rate_limit_event', rate_limit_info: {} })).toBeNull()
    expect(renderClaudeEvent({ type: 'system', subtype: 'hook_started' })).toBeNull()
  })

  it("reads usage from a stream's terminal event, and still from a single whole-blob payload", () => {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', message: { content: [] } }),
      JSON.stringify({ stop_reason: 'end_turn', usage: { input_tokens: 11, output_tokens: 22 } })
    ].join('\n')
    expect(parseClaudeUsage(stream)).toEqual({ input: 11, output: 22 })
    // The pre-streaming form is one line, so it must keep working — the
    // change reads both rather than trading one for the other.
    expect(parseClaudeUsage(JSON.stringify({ usage: { input_tokens: 3, output_tokens: 4 } }))).toEqual({
      input: 3,
      output: 4
    })
    expect(parseClaudeUsage('not json at all')).toBeNull()
  })

  it("reads claude's genuine model receipt from modelUsage's own key, distinct from the requested alias (O2, #456)", () => {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({
        stop_reason: 'end_turn',
        usage: { input_tokens: 11, output_tokens: 22 },
        modelUsage: { 'claude-sonnet-5': { canonicalModel: 'claude-sonnet-5' } }
      })
    ].join('\n')
    expect(parseClaudeModel(stream)).toBe('claude-sonnet-5')
    // No `modelUsage` field at all — no receipt to read.
    expect(parseClaudeModel(JSON.stringify({ usage: { input_tokens: 3, output_tokens: 4 } }))).toBeNull()
    expect(parseClaudeModel('not json at all')).toBeNull()
  })

  it("reads the resume id from a stream's terminal event, and still from a whole-blob payload", () => {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'early-and-ignored' }),
      JSON.stringify({ stop_reason: 'end_turn', session_id: 'the-real-one' })
    ].join('\n')
    expect(parseClaudeResumeId(stream)).toBe('the-real-one')
    expect(parseClaudeResumeId(JSON.stringify({ session_id: 'single-blob' }))).toBe('single-blob')
    expect(parseClaudeResumeId('')).toBeNull()
  })
})

/**
 * O2 (Issue #670) — the host-wide proof, run last so it observes every
 * fixture above's own teardown, not just the one test it happens to follow.
 * Same idiom `checks/runner.test.ts` already established for its own
 * process-group tests (`ps -eo pid,command | grep … | grep -v grep || true`)
 * — `-eo` lists every process on the host, not just this test process's own
 * children, so a vendor that reparented to the service manager after its own
 * script died is still caught here. Every fake vendor binary in this file
 * lives under a `tempDir('vinaya-dispatch-bin-')` directory, so its own
 * path — and therefore its `ps` command line — always carries that literal
 * substring; a `--settings <path>` flag (`writeDispatchSettings`) on an
 * unattended fixture additionally carries the fake task's own run folder, on
 * the SAME command line, for the same reason. Bounded (`timeout`/
 * `killSignal`) so a hung `ps`/`grep` cannot itself hang this file's own run
 * — matching this file's own `stripVinayaEnv`+kill-budget discipline
 * (`process-fixture-coverage.test.ts`).
 *
 * The proof is against pids NEW since `beforeAll`, never a bare host-wide
 * zero-count: this machine runs several agents concurrently, each in its own
 * worktree sharing the same real host — an unrelated sibling's own
 * in-flight `vinaya-dispatch-bin-` fixture, alive before this file's first
 * test ever ran, is not a regression this file introduced and must never
 * fail this proof (found live: a sibling worktree's own fixture, started
 * independently, made a bare `ps -eo` scan fail with no leak on this file's
 * own part at all). Snapshotting the baseline first and asserting "nothing
 * new" keeps 100% of the sensitivity to a real leak from this file's own
 * fixtures while dropping the false positive from noise this file never
 * controlled.
 */
function vendorProcessSurvivors(): string[] {
  const out = execSync('ps -eo pid,command | grep "vinaya-dispatch-bin-" | grep -v grep || true', {
    encoding: 'utf8',
    timeout: 5_000,
    killSignal: 'SIGKILL'
  }).trim()
  if (out.length === 0) return []
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

let preExistingVendorSurvivors: Set<string> = new Set()
beforeAll(() => {
  preExistingVendorSurvivors = new Set(vendorProcessSurvivors())
})

describe('process hygiene (Issue #670) — the file leaves no fake vendor process behind', () => {
  it('no NEW process — beyond whatever the host already carried before this file ran — still carries a vinaya-dispatch-bin- path in its command line', () => {
    const newSurvivors = vendorProcessSurvivors().filter((line) => !preExistingVendorSurvivors.has(line))
    expect(newSurvivors).toEqual([])
  })
})

describe('dispatchRole — an agent usage limit is its own outcome, never a crash', () => {
  it('a claude child that prints a rejected limit event and exits non-zero logs usage_limit with agent and reset', () => {
    const home = tempDir('vinaya-dispatch-home-')
    const cwd = tempDir('vinaya-dispatch-cwd-')
    const binDir = tempDir('vinaya-dispatch-bin-')
    writeFakeBinary(
      binDir,
      'claude',
      `#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' '{"type":"system","subtype":"init","session_id":"s-limit"}'\nprintf '%s\\n' '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1789783200,"rateLimitType":"seven_day","isUsingOverage":false}}'\nprintf '%s\\n' '{"type":"result","is_error":true,"result":"You have hit your weekly limit"}'\nexit 1\n`
    )
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, PROMPT_FILE_CONTENT)
    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile, '--json'],
      cwd,
      home,
      `${binDir}:${pathWithoutRealVendors()}`
    )
    expect(r.status).toBe(1)
    const parsed = JSON.parse(r.stdout) as { data: { failureReason: string | null } }
    expect(parsed.data.failureReason).toBe('usage-limit')
    const lines = outboxLines(home, 'none') as Array<Record<string, unknown>>
    const failed = lines.find((l) => l.event === 'dispatch_failed')
    expect(failed?.reason).toBe('usage_limit')
    expect(failed?.usage_limit).toEqual({ agent: 'claude', reset_at: new Date(1789783200 * 1000).toISOString() })
  })
})

describe('dispatch usage envelopes match between runners', () => {
  for (const agent of ['claude', 'codex'] as const)
    for (const role of ['developer', 'code-reviewer', 'security'] as const)
      it(`${agent} ${role} preserves fields and order when a fresh driver continues the next round`, async () => {
        const home = tempDir('dispatch-parity-home-')
        const cwd = tempDir('dispatch-parity-cwd-')
        const bin = tempDir('dispatch-parity-bin-')
        const prompt = join(cwd, 'prompt.txt')
        writeFileSync(prompt, 'Review the task')
        const events =
          agent === 'claude'
            ? [
                { type: 'system', subtype: 'init', session_id: 'parity-session', model: 'parity-model' },
                {
                  type: 'result',
                  usage: {
                    input_tokens: 101,
                    output_tokens: 17,
                    cache_read_input_tokens: 5,
                    cache_creation_input_tokens: 1
                  }
                }
              ]
            : [
                { type: 'thread.started', thread_id: 'parity-thread' },
                { type: 'turn.completed', usage: { input_tokens: 101, output_tokens: 17, cached_input_tokens: 6 } }
              ]
        const stdout = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
        const script = `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(stdout)}))\n`
        writeFakeBinary(bin, agent, script)
        const runDir = join(cwd, 'engine-run')
        const folder = join(cwd, 'engine-logs')
        const family = (row: any) => row.kind === 'usage' || (row.kind === 'role_attempt' && row.actor === agent)
        const comparable = (row: any) => {
          const { meta, subject, effect_id, duration_ms, ...fields } = row
          expect(typeof effect_id === 'string' || row.kind === 'usage').toBe(true)
          return { ...fields, subject, provenance: meta.provenance, attemptLineage: meta.lineage.attempt }
        }
        for (const round of [1, 2]) {
          const result = runDispatch(
            [
              role,
              '--agent',
              agent,
              '--model',
              'parity-model',
              '--task',
              '9001',
              '--round',
              String(round),
              '--prompt-file',
              prompt
            ],
            cwd,
            home,
            `${bin}:${pathWithoutRealVendors()}`,
            { VINAYA_LOG_FOLDER_ONLY: '1' }
          )
          expect(result.status, result.stderr).toBe(0)
          const standalone = (outboxLines(home, 9001) as any[]).filter(family)
          const sink = createEngineLogSink({
            env: () => ({
              VINAYA_ROLE: 'operator',
              VINAYA_TASK: '9001',
              VINAYA_RUNTIME: agent,
              VINAYA_LOG_FOLDER_ONLY: '1'
            }),
            cwd: () => cwd,
            home: () => home,
            readConfig: () => null,
            resolveRepo: async () => null,
            resolveBranchIssue: async () => null,
            resolveLogDestination: () => ({ kind: 'folder', folder }),
            unresolvedLogDestination: () => ({ kind: 'folder', folder })
          })
          const launchRole = role === 'code-reviewer' ? 'reviewer' : role
          const attribution = claimLaunchAttribution(runDir, 'resumed-thread', launchRole, round)
          const launcherRole = role === 'security' ? 'security-reviewer' : role
          const wrapped = withDispatchUsage(
            () => {
              const child = spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(stdout)})`], {
                cwd,
                env: { ...stripVinayaEnv(process.env), HOME: home },
                stdio: ['ignore', 'pipe', 'pipe']
              })
              const budget = setTimeout(() => child.kill('SIGKILL'), 2000)
              child.once('close', () => clearTimeout(budget))
              return child
            },
            join(cwd, 'generated'),
            agent,
            (launch) => {
              for (const event of launchUsageEvents(launch, agent, `launch-${role}-${round}`, 'parity-model'))
                sink.log(event as never, launch.attribution)
            },
            Date.now,
            () => attribution
          )
          const child = wrapped('fixture', ['--settings', join(cwd, 'generated', launcherRole, 'settings.json')], {
            cwd,
            env: { CODEX_HOME: agent === 'codex' ? join(cwd, 'generated', launcherRole) : undefined }
          })
          await new Promise<void>((resolve) => child.on('close', () => resolve()))
          await sink.drain()
          const engine = readFileSync(join(folder, 'unresolved', '9001.ndjson'), 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
            .filter(family)
          expect(engine.map(comparable)).toEqual(standalone.map(comparable))
          expect(engine.filter((row) => row.kind === 'role_attempt').map((row) => row.attempt)).toEqual(
            Array.from({ length: round }, (_, index) => index + 1)
          )
        }
      })
})
