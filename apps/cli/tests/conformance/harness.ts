import { beforeAll, describe, expect, it } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireOwnership,
  consumeResolutionOnce,
  defaultControlStoreDeps,
  type EscalationInput,
  writeEscalation
} from '@attalabs/aeg-core'
import { ReplayedResolutionError, writePauseState } from '../../src/lib/dev-review-loop/pause-resume.js'
import { tasksExecutionRoot } from '../../src/lib/run-paths.js'
import { createTaskCancelHandler } from '../../src/lib/task-tools/cancel.js'
import { createTaskResumeHandler, type ResumeClaimStore, type ResumeRecord } from '../../src/lib/task-tools/resume.js'
import {
  createTaskToolsMcpServer,
  defaultTaskToolHandlers,
  dispatchToolCall,
  type TaskToolHandlers
} from '../../src/lib/task-tools/server.js'
import { spawnSyncBudgeted, stripVinayaEnv } from '../lib/process-fixture'

/**
 * Part 2 (O2): the nine two-runtime fixture scenarios shared verbatim by
 * `claude.test.ts` and `codex.test.ts` — the SAME assertions run against
 * each adapter's own registered invocation, so "same expectations on both
 * adapters" is a property of shared code, not two hand-copied files that
 * could silently drift apart.
 *
 * Two drive modes, both genuinely "through the registered tools":
 *  - spawn: a REAL child process, the exact command the calling adapter
 *    registers, driven over real stdio JSON-RPC (`SpawnRpcClient`) — used
 *    for `task_start` and every `task_escalation_read` scenario, neither of
 *    which needs a forge credential (`task_escalation_read`'s `{ issue }`
 *    ref resolves with no `gh` call at all — `handlers.ts`'s own
 *    `resolveIssueForRef` doc comment).
 *  - in-process: the real `createTaskToolsMcpServer`/`handleLine` (real
 *    JSON-RPC framing, the real router and catalog validation), with
 *    `task_resume`/`task_cancel` substituted for the SAME dependency-
 *    injected handlers `resume.test.ts`/`cancel.test.ts` already prove
 *    correct in isolation — this suite proves they behave identically when
 *    reached through the shared protocol surface, not their own internals
 *    again. `runtimeDir()`/`gh` are not overridable without either a real
 *    subprocess (spawn mode) or dependency injection (this module's own
 *    established repo convention — no test mutates `process.env.HOME`
 *    in-process anywhere in this codebase).
 */

// --- repo/bin resolution (same shape protocol.test.ts already uses) --------

export const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')
export const CLI_ROOT = join(REPO_ROOT, 'apps', 'cli')
export const ABS_BIN = join(CLI_ROOT, 'dist', 'index.js')

/**
 * `dist/index.js` is never built by the `test-cli` CI job itself — no shard
 * downloads the `build` job's artifact or reruns the build; a spawn-mode
 * scenario here only ever sees it because SOME other file in the SAME shard
 * happens to build it as its own fixture side effect first (the ONLY
 * existing precedent, `tests/commands/dispatch-task.test.ts`'s own
 * `beforeAll`). Since a shard's file list is an explicit, hand-edited
 * assignment (`ci-shards/shard-<n>.txt`) with no guarantee that file and this
 * one ever land in the same shard again, this suite builds its OWN copy
 * before spawning anything — the same `Bun.spawnSync` call that file uses,
 * not a second build mechanism. Idempotent and cheap (a few seconds) rather
 * than "assume a shard-mate already did it."
 */
export function ensureCliBuilt(): void {
  // Issue #660, O3 (round 5 review, BLOCKER) — bounded by an explicit
  // budget that throws with the child's own captured stdout/stderr on
  // expiry, rather than a bare timeout.
  const build = spawnSyncBudgeted(
    'bun',
    ['run', '--cwd', CLI_ROOT, 'build'],
    { encoding: 'utf8' },
    100_000,
    'apps/cli build'
  )
  if (build.status !== 0) {
    throw new Error(`apps/cli build failed:\n${build.stderr}`)
  }
}

export type ServerInvocation = { command: string; args: string[] }

// --- a minimal real JSON-RPC stdio client (spawn mode) ----------------------

type RpcResult = { result?: Record<string, unknown>; error?: { code: number; message: string } }

export class SpawnRpcClient {
  private proc: ChildProcess
  private stdin: NodeJS.WritableStream
  private buffer = ''
  private stderrBuf = ''
  private pending = new Map<number, (value: RpcResult) => void>()
  private nextId = 1

  constructor(invocation: ServerInvocation, env: Record<string, string>, cwd: string) {
    // `pipe`, not `ignore` (Issue #660, O3 round 4, security MEDIUM) — a
    // hung/crashed server's own stderr is the diagnostic a bare request
    // timeout otherwise discards entirely. `env` arrives already stripped
    // AND deliberately re-populated by the caller (`buildSandbox` strips
    // ambient VINAYA_* first, then sets its own VINAYA_RUNTIME_DIR/
    // VINAYA_MCP_CALLER/etc. on top) — stripping again here would remove
    // those deliberate overrides right back out, so this constructor
    // trusts its caller rather than re-stripping.
    this.proc = spawn(invocation.command, invocation.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.stdin = this.proc.stdin!
    const stdout = this.proc.stdout!
    stdout.setEncoding('utf8')
    stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      let idx = this.buffer.indexOf('\n')
      while (idx !== -1) {
        const line = this.buffer.slice(0, idx).trim()
        this.buffer = this.buffer.slice(idx + 1)
        if (line.length > 0) {
          const msg = JSON.parse(line) as { id?: number } & RpcResult
          if (typeof msg.id === 'number') {
            const resolve = this.pending.get(msg.id)
            if (resolve) {
              this.pending.delete(msg.id)
              resolve({ result: msg.result, error: msg.error })
            }
          }
        }
        idx = this.buffer.indexOf('\n')
      }
    })
    const stderr = this.proc.stderr!
    stderr.setEncoding('utf8')
    stderr.on('data', (chunk: string) => {
      this.stderrBuf += chunk
    })
  }

  request(method: string, params?: unknown): Promise<RpcResult> {
    const id = this.nextId++
    const line = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
    return new Promise<RpcResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // A stuck server under real lock contention (the exact O3 collision
        // this fixture's own env-strip fix above closes) never answers — kill
        // it rather than leaving a dangling process, and surface its own
        // captured output rather than a bare "timeout" with nothing to
        // diagnose it by.
        this.proc.kill('SIGKILL')
        reject(
          new Error(
            `timeout waiting for ${method} (id ${id}) after 15000ms\n` +
              `--- stdout (unconsumed buffer) ---\n${this.buffer}\n--- stderr ---\n${this.stderrBuf}`
          )
        )
      }, 15_000)
      this.pending.set(id, (value) => {
        clearTimeout(timer)
        resolve(value)
      })
      this.stdin.write(line)
    })
  }

  async callTool(name: string, args: unknown): Promise<{ isError: boolean; structured: Record<string, unknown> }> {
    const res = await this.request('tools/call', { name, arguments: args })
    const result = res.result as { isError?: boolean; structuredContent?: Record<string, unknown> }
    return { isError: Boolean(result?.isError), structured: result?.structuredContent ?? {} }
  }

  close(): void {
    try {
      this.stdin.end()
    } catch {
      // ignore
    }
    this.proc.kill('SIGKILL')
  }
}

// --- sandbox: HOME, fake gh, recording launcher, isolated runtime dir ------

export type Sandbox = {
  sandbox: string
  runtimeDir: string
  launchFile: string
  env: Record<string, string>
  cleanup: () => void
}

export function buildSandbox(): Sandbox {
  const sandbox = mkdtempSync(join(tmpdir(), 'vinaya-conformance-'))
  const binDir = join(sandbox, 'bin')
  const home = join(sandbox, 'home')
  const runtimeDir = join(sandbox, 'runtime')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(runtimeDir, { recursive: true })
  const launchFile = join(sandbox, 'launches.log')

  // `task_start` (O1) now confirms its launch alive on the task's own driver
  // lock before reporting `started: true`, resolved through the SAME
  // `{tranche, id}` → Issue read `task_resume`/`task_status` already use —
  // so this fake `gh` must answer `gatherTaskStatusList()`'s three calls for
  // `conformance/1` (issue list, a frozen-brief comment, an open-PR lookup),
  // the same contract `tests/commands/task-status.test.ts`'s own stub
  // satisfies, not just the bare `issue list` the launch path used to need.
  const gh = join(binDir, 'gh')
  writeFileSync(
    gh,
    `#!/bin/sh
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  cat <<'JSON'
[{"number":9301,"title":"[conformance] 1 — Clean result fixture task","labels":[{"name":"vinaya/tranche:conformance"}]}]
JSON
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  cat <<'JSON'
{"comments":[{"body":"<!-- aeg:brief:v1 -->\\nBrief hash: deadbeef\\n\\nA brief body.","author":{"login":"daniboomerang"}}]}
JSON
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  echo '[]'
  exit 0
fi
echo "gh stub: unhandled: $*" >&2
exit 1
`,
    { mode: 0o755 }
  )
  chmodSync(gh, 0o755)

  // The recording launcher for `conformance/1` also writes that task's own
  // driver lock (Issue #9301, the fake `gh` above's own mapping) and stays
  // alive briefly under the SAME pid (`exec`, not a backgrounded subshell) —
  // the observable `task_start`'s own confirm-wait polls for before it will
  // ever report `started: true`.
  const launcher = join(binDir, 'record-launch')
  writeFileSync(
    launcher,
    `#!/bin/sh
echo "launch $*" >> "$VINAYA_TEST_LAUNCH_FILE"
issue=""
case "$3 $4" in
  "conformance 1") issue=9301 ;;
esac
if [ -n "$issue" ]; then
  dir="$VINAYA_RUNTIME_DIR/tasks-execution/$issue"
  mkdir -p "$dir"
  echo "{\\"pid\\": $$, \\"startedAt\\": \\"2026-01-01T00:00:00.000Z\\"}" > "$dir/driver.pid.json"
  exec sleep 3
fi
`,
    { mode: 0o755 }
  )
  chmodSync(launcher, 0o755)

  const env: Record<string, string> = {
    ...stripVinayaEnv(process.env),
    HOME: home,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    AEG_REPO: 'attalabs/vinaya',
    VINAYA_MCP_CALLER: 'operator-1',
    VINAYA_RUNTIME_DIR: runtimeDir,
    VINAYA_TASK_RUN_COMMAND: launcher,
    VINAYA_TEST_LAUNCH_FILE: launchFile
  }

  return {
    sandbox,
    runtimeDir,
    launchFile,
    env,
    cleanup: () => rmSync(sandbox, { recursive: true, force: true })
  }
}

export async function launchCountFor(launchFile: string, id: string): Promise<number> {
  for (let i = 0; i < 40; i++) {
    try {
      // The recorded line is `launch task run <tranche> <id> --agent
      // <agent>` — matched on the `<id> --agent` segment, since `<id>` alone
      // no longer ends the line now that O2 always appends `--agent <agent>`.
      const lines = readFileSync(launchFile, 'utf8')
        .split('\n')
        .filter((l) => l.includes(`serve ${id}`) || l.includes(`${id} --agent`))
      if (lines.length > 0) return lines.length
    } catch {
      // not written yet
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  return 0
}

// --- disk fixtures: pause state + durable escalation records ---------------

export const ISSUE_MECHANICAL = 9101
export const ISSUE_RETRIES = 9102
export const ISSUE_FRESH = 9103
export const ISSUE_INPUT_CHANGE = 9104
export const ISSUE_HANDOFF = 9105
export const PR = 9500

export function writePauseFixture(
  runtimeDir: string,
  overrides: Partial<Parameters<typeof writePauseState>[1]> & { task: number }
): void {
  writePauseState(runtimeDir, {
    round: 1,
    head: 'headsha1',
    branch: 'task/conformance/1',
    prNumber: PR,
    reason: 'escalation',
    pausedAt: '2026-01-01T00:00:00.000Z',
    escalationId: `${overrides.task}-1-headsha1`,
    ...overrides
  })
}

export function writeEscalationFixture(
  runtimeDir: string,
  task: number,
  overrides: Partial<EscalationInput> = {}
): void {
  const controlStoreDeps = defaultControlStoreDeps(() => tasksExecutionRoot(runtimeDir))
  const acquired = acquireOwnership(controlStoreDeps, task, 'test-fixture')
  if (!acquired.acquired) throw new Error('fixture: could not acquire epoch')
  writeEscalation(controlStoreDeps, task, acquired.epoch, {
    escalationId: `${task}-1-headsha1`,
    round: 1,
    head: 'headsha1',
    branch: 'task/conformance/1',
    pr: PR,
    runId: 'run-1',
    pid: 12345,
    host: 'test-host',
    agent: 'claude',
    reason: 'escalation',
    attemptedRecovery: 'none',
    requestedDecision: 'resume or cancel',
    recipient: 'principal',
    briefHash: 'brief-hash-1',
    objectivesVersion: 'objectives-v1',
    rulingOrdinal: 0,
    policyDigest: 'digest-1',
    recordedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  })
}

// --- in-process server (task_resume/task_cancel, dependency-injected) ------

function memClaimStore(): { store: ResumeClaimStore; map: Map<string, ResumeRecord> } {
  const map = new Map<string, ResumeRecord>()
  return {
    map,
    store: {
      claim(record) {
        const existing = map.get(record.escalationId)
        if (existing) return { claimed: false, record: existing }
        map.set(record.escalationId, record)
        return { claimed: true, record }
      },
      release(escalationId) {
        map.delete(escalationId)
      }
    }
  }
}

async function handleOne(
  handlers: TaskToolHandlers,
  name: string,
  args: unknown
): Promise<{ isError: boolean; structured: Record<string, unknown> }> {
  const server = createTaskToolsMcpServer({
    serverVersion: 'conformance-test',
    handlers,
    callerContext: { caller: { id: 'operator-1' } }
  })
  const response = await server.handleLine(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  )
  const parsed = JSON.parse(response ?? '{}') as {
    result?: { isError?: boolean; structuredContent?: Record<string, unknown> }
  }
  return { isError: Boolean(parsed.result?.isError), structured: parsed.result?.structuredContent ?? {} }
}

// --- the nine scenarios, shared verbatim by both adapters -------------------

export function defineConformanceSuite(runtime: 'claude' | 'codex', invocation: ServerInvocation): void {
  describe(`task-tools conformance — ${runtime} adapter, nine scenarios`, () => {
    beforeAll(() => {
      ensureCliBuilt()
    }, 120_000)

    it('Clean result — task_start launches exactly once and returns the durable run identity', async () => {
      const sb = buildSandbox()
      try {
        const client = new SpawnRpcClient(invocation, sb.env, REPO_ROOT)
        await client.request('initialize', {})
        const { isError, structured } = await client.callTool('task_start', { tranche: 'conformance', id: '1' })
        expect(isError).toBe(false)
        expect(structured.started).toBe(true)
        expect(structured.mode).toBe('attended')
        expect(structured.run).toEqual({ tranche: 'conformance', id: '1' })
        expect(typeof structured.requestId).toBe('string')
        expect(await launchCountFor(sb.launchFile, '1')).toBe(1)
        client.close()
      } finally {
        sb.cleanup()
      }
    })

    it('Invalid result — malformed input to every registered tool is refused before any effect', async () => {
      const CALLER = { caller: { id: 'operator-1' } }
      const cases: Array<[string, unknown]> = [
        ['task_status', { limit: -1 }],
        ['task_escalation_read', {}],
        ['task_resume', {}],
        ['task_cancel', { task: { issue: 1 } }],
        ['task_start', {}]
      ]
      for (const [name, input] of cases) {
        const result = await dispatchToolCall(defaultTaskToolHandlers, name, input, CALLER)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.error.kind).toBe('validation')
      }
    })

    it('Mechanical rejection — an infrastructure pause names the operator, never a review dispute', async () => {
      const sb = buildSandbox()
      try {
        writePauseFixture(sb.runtimeDir, {
          task: ISSUE_MECHANICAL,
          reason: 'infrastructure',
          detail: 'reviewer.md was never written for round 1'
        })
        const client = new SpawnRpcClient(invocation, sb.env, REPO_ROOT)
        await client.request('initialize', {})
        const { isError, structured } = await client.callTool('task_escalation_read', {
          task: { issue: ISSUE_MECHANICAL }
        })
        expect(isError).toBe(false)
        const items = structured.items as Array<Record<string, unknown>>
        expect(items).toHaveLength(1)
        expect(items[0]?.reason).toBe('infrastructure')
        expect(items[0]?.requestedAuthority).toBe('operator')
        expect(items[0]?.runIdentity).toBeNull()
        client.close()
      } finally {
        sb.cleanup()
      }
    })

    it('Bounded retries — a no_push pause reports the already-exhausted single bounded attempt', async () => {
      const sb = buildSandbox()
      try {
        writePauseFixture(sb.runtimeDir, {
          task: ISSUE_RETRIES,
          reason: 'no_push',
          detail: 'worktree task/conformance/1'
        })
        const client = new SpawnRpcClient(invocation, sb.env, REPO_ROOT)
        await client.request('initialize', {})
        const { isError, structured } = await client.callTool('task_escalation_read', {
          task: { issue: ISSUE_RETRIES }
        })
        expect(isError).toBe(false)
        const items = structured.items as Array<Record<string, unknown>>
        expect(items[0]?.reason).toBe('no_push')
        expect(items[0]?.requestedAuthority).toBe('operator')
        expect(items[0]?.attemptedRecovery).toContain('one foreground resume')
        client.close()
      } finally {
        sb.cleanup()
      }
    })

    it('Fresh reviews — every read is re-derived from current state, never a cached prior response', async () => {
      const sb = buildSandbox()
      try {
        writePauseFixture(sb.runtimeDir, {
          task: ISSUE_FRESH,
          round: 1,
          head: 'headsha1',
          escalationId: `${ISSUE_FRESH}-1-headsha1`
        })
        const client = new SpawnRpcClient(invocation, sb.env, REPO_ROOT)
        await client.request('initialize', {})

        const first = await client.callTool('task_escalation_read', { task: { issue: ISSUE_FRESH } })
        const firstItems = first.structured.items as Array<Record<string, unknown>>
        expect((firstItems[0]?.inputs as Record<string, unknown>)?.round).toBe(1)

        // The SAME live connection; the on-disk pause advances underneath it.
        writePauseFixture(sb.runtimeDir, {
          task: ISSUE_FRESH,
          round: 2,
          head: 'headsha2',
          escalationId: `${ISSUE_FRESH}-2-headsha2`
        })
        const second = await client.callTool('task_escalation_read', { task: { issue: ISSUE_FRESH } })
        const secondItems = second.structured.items as Array<Record<string, unknown>>
        expect((secondItems[0]?.inputs as Record<string, unknown>)?.round).toBe(2)

        client.close()
      } finally {
        sb.cleanup()
      }
    })

    it('Input change — an objectives_changed pause reports self-detected, safe-to-resume', async () => {
      const sb = buildSandbox()
      try {
        writePauseFixture(sb.runtimeDir, { task: ISSUE_INPUT_CHANGE, reason: 'objectives_changed' })
        const client = new SpawnRpcClient(invocation, sb.env, REPO_ROOT)
        await client.request('initialize', {})
        const { structured } = await client.callTool('task_escalation_read', { task: { issue: ISSUE_INPUT_CHANGE } })
        const items = structured.items as Array<Record<string, unknown>>
        const item = items[0] as Record<string, unknown>
        expect(item.reason).toBe('objectives_changed')
        expect(item.requestedAuthority).toBe('self')
        expect((item.permittedNextActions as string[]).some((a) => a.includes('re-read the current objectives'))).toBe(
          true
        )
        client.close()
      } finally {
        sb.cleanup()
      }
    })

    it('Human handoff — an escalation pause with a durable record names the principal, run identity and input versions', async () => {
      const sb = buildSandbox()
      try {
        writePauseFixture(sb.runtimeDir, {
          task: ISSUE_HANDOFF,
          reason: 'escalation',
          detail: 'security reviewer raised ESCALATE'
        })
        writeEscalationFixture(sb.runtimeDir, ISSUE_HANDOFF, { rulingOrdinal: 0 })
        const client = new SpawnRpcClient(invocation, sb.env, REPO_ROOT)
        await client.request('initialize', {})
        const { structured } = await client.callTool('task_escalation_read', { task: { issue: ISSUE_HANDOFF } })
        const items = structured.items as Array<Record<string, unknown>>
        expect(items[0]?.reason).toBe('escalation')
        expect(items[0]?.requestedAuthority).toBe('principal')
        expect(items[0]?.runIdentity).toEqual({ runId: 'run-1', pid: 12345, host: 'test-host' })
        expect(items[0]?.inputVersions).toEqual({
          briefHash: 'brief-hash-1',
          objectivesVersion: 'objectives-v1',
          rulingOrdinal: 0,
          policyDigest: 'digest-1'
        })
        client.close()
      } finally {
        sb.cleanup()
      }
    })

    it('Cancellation — an authenticated cancel confirms once; a replay reports the same truthful outcome, never an error', async () => {
      const sb = buildSandbox()
      const ISSUE = 9201
      const ESCALATION_ID = `${ISSUE}-1-headsha1`
      try {
        writePauseFixture(sb.runtimeDir, { task: ISSUE, escalationId: ESCALATION_ID })
        writeEscalationFixture(sb.runtimeDir, ISSUE, { host: 'test-host' })

        let calls = 0
        const cancelHandler = createTaskCancelHandler({
          runtimeDir: () => sb.runtimeDir,
          resolveIssueForRef: () => ISSUE,
          fetchRulings: () => ['LGTM, cancel.'],
          fetchNewestRulingOrdinal: () => 1,
          hostname: () => 'test-host',
          cancelDevReviewLoop: async () => {
            calls += 1
            if (calls === 1) return { task: ISSUE, escalationId: ESCALATION_ID, fencedEffectKeys: [] }
            throw new ReplayedResolutionError(ISSUE, ESCALATION_ID, {
              version: 1,
              kind: 'resolution',
              task: ISSUE,
              escalationId: ESCALATION_ID,
              decision: 'cancel',
              authenticatedBy: 'principal-1',
              authenticatedFrom: `${PR}-1`,
              consumedAt: '2026-01-01T00:00:00.000Z'
            })
          },
          log: () => {}
        })
        const handlers: TaskToolHandlers = {
          ...defaultTaskToolHandlers,
          task_cancel: (input, ctx) => cancelHandler(input, ctx)
        }

        const first = await handleOne(handlers, 'task_cancel', { task: { issue: ISSUE }, reason: 'superseded' })
        expect(first.isError).toBe(false)
        expect(first.structured.outcome).toBe('confirmed')

        const second = await handleOne(handlers, 'task_cancel', { task: { issue: ISSUE }, reason: 'superseded' })
        expect(second.isError).toBe(false)
        expect(second.structured.outcome).toBe('confirmed')
        expect(second.structured.authenticatedBy).toBe('principal-1')
      } finally {
        sb.cleanup()
      }
    })

    it('Recovery — a resolution already durably consumed replays as already_resumed, never a blind relaunch', async () => {
      const sb = buildSandbox()
      const ISSUE = 9202
      const ESCALATION_ID = `${ISSUE}-1-headsha1`
      try {
        writePauseFixture(sb.runtimeDir, { task: ISSUE, escalationId: ESCALATION_ID })
        writeEscalationFixture(sb.runtimeDir, ISSUE, { host: 'test-host' })

        // Simulate an EARLIER process's own successful resume: the durable
        // resolution is consumed before this scenario's own, freshly built
        // handler ever runs — the same durable record a real restart would
        // find on disk.
        const controlStoreDeps = defaultControlStoreDeps(() => tasksExecutionRoot(sb.runtimeDir))
        const acquired = acquireOwnership(controlStoreDeps, ISSUE, 'earlier-process')
        if (!acquired.acquired) throw new Error('fixture: could not acquire epoch')
        const consumed = consumeResolutionOnce(controlStoreDeps, ISSUE, acquired.epoch, {
          escalationId: ESCALATION_ID,
          decision: 'resume',
          authenticatedBy: 'principal-1',
          authenticatedFrom: `${PR}-1`,
          consumedAt: '2026-01-01T00:00:00.000Z'
        })
        expect(consumed.outcome).toBe('consumed')

        // A FRESH handler and claim store — no in-memory state carried over
        // from whatever process wrote the resolution above, the same as a
        // real process restart.
        const { store: freshStore } = memClaimStore()
        const launches: Array<{ pr: number; agent: string }> = []
        const resumeHandler = createTaskResumeHandler({
          runtimeDir: () => sb.runtimeDir,
          resolveIssueForRef: () => ISSUE,
          fetchRulings: () => ['LGTM, resume.'],
          fetchNewestRulingAuthor: () => 'principal-1',
          fetchNewestRulingOrdinal: () => 1,
          store: freshStore,
          launch: (target) => {
            launches.push(target)
            return Promise.resolve({ alive: true })
          },
          now: () => '2026-01-01T00:01:00.000Z',
          log: () => {}
        })
        const handlers: TaskToolHandlers = {
          ...defaultTaskToolHandlers,
          task_resume: (input, ctx) => resumeHandler(input, ctx)
        }

        const result = await handleOne(handlers, 'task_resume', { task: { issue: ISSUE } })
        expect(result.isError).toBe(false)
        expect(result.structured.outcome).toBe('already_resumed')
        expect(result.structured.authenticatedBy).toBe('principal-1')
        expect(launches).toHaveLength(0)
      } finally {
        sb.cleanup()
      }
    })
  })
}
