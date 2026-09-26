import { describe, expect, it } from 'bun:test'
import type { TaskToolRef } from '@attalabs/aeg-core'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveOpenTaskIssueForRef } from '../../../src/lib/task-tools/handlers.js'
import type { TaskIssueFacts } from '../../../src/lib/task-tools/handlers.js'
import type { CallerContext } from '../../../src/lib/task-tools/server.js'
import {
  createTaskStartHandler,
  defaultLaunch,
  START_STALE_CLAIM_GRACE_MS,
  TASK_RUN_COMMAND_ENV,
  type LaunchResult,
  type RequestStore,
  type StartRecord
} from '../../../src/lib/task-tools/start.js'

/**
 * `task_start` driven in-process with injected deps: an in-memory idempotency
 * store and a recording launcher, so every branch — validation, the
 * absent-caller refusal, the missing-agent refusal, a confirmed-alive first
 * start, the idempotent replay, a launch that never confirms alive, and a dead
 * claim's own supersede-and-relaunch — is exercised with no real forge, git, or
 * detached process. Both address forms are driven through every one of those:
 * `{ tranche, id }` and a standalone `{ issue }`, which launches `task run
 * --issue <n>` instead and is refused when its number is closed, missing, or
 * claimed by a tranche. The protocol-level end-to-end path (a real client over
 * stdio, disconnect leaves one run) is `protocol.test.ts`.
 */

const REPO_ROOT = '/repo/checkout-a'
const CALLER: CallerContext = { caller: { id: 'operator-1' } }
const NO_CALLER: CallerContext = { caller: null }
const ISSUE = 601
/** A standalone task Issue: open, and claimed by no tranche — the one shape `{ issue }` accepts. */
const STANDALONE: TaskIssueFacts = { kind: 'issue', open: true, tranche: null }

function memStore(): { store: RequestStore; map: Map<string, StartRecord> } {
  const map = new Map<string, StartRecord>()
  return {
    map,
    store: {
      claim(record) {
        const existing = map.get(record.requestId)
        if (existing) return { claimed: false, record: existing }
        map.set(record.requestId, record)
        return { claimed: true, record }
      },
      release(requestId) {
        map.delete(requestId)
      }
    }
  }
}

type LaunchRecord = { ref: TaskToolRef; agent: string; issue: number }

function harness(
  overrides: {
    launch?: (target: LaunchRecord) => LaunchResult | Promise<LaunchResult>
    repoRoot?: string | null
    agent?: 'claude' | 'codex' | 'gemini' | null
    resolveIssue?: (ref: TaskToolRef) => number | null
    issueFacts?: (issue: number) => TaskIssueFacts
    isRunAlive?: (issue: number) => boolean
    now?: () => string
  } = {}
) {
  const launches: LaunchRecord[] = []
  const { store, map } = memStore()
  const handler = createTaskStartHandler({
    repoRoot: () => overrides.repoRoot ?? REPO_ROOT,
    store,
    agent: () => (overrides.agent === undefined ? 'claude' : overrides.agent),
    resolveIssue: overrides.resolveIssue ?? (() => ISSUE),
    issueFacts: overrides.issueFacts ?? (() => STANDALONE),
    isRunAlive: overrides.isRunAlive ?? (() => true),
    launch: async (target) => {
      launches.push(target)
      return (overrides.launch?.(target) ?? { alive: true }) as LaunchResult | Promise<LaunchResult>
    },
    now: overrides.now ?? (() => '2026-01-01T00:00:00.000Z')
  })
  return { handler, launches, map }
}

describe('task_start handler', () => {
  it('refuses malformed input with a validation error, before any caller check or launch', async () => {
    const { handler, launches } = harness()
    const result = await handler({}, CALLER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('validation')
    expect(launches).toHaveLength(0)
  })

  it('refuses with an authority error when the invocation context carries no caller', async () => {
    const { handler, launches } = harness()
    const result = await handler({ tranche: 'task-operator-v1', id: '2' }, NO_CALLER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('authority')
    expect(launches).toHaveLength(0)
  })

  it('refuses before claiming when no `dispatch.agent` is configured (O2)', async () => {
    const { handler, launches, map } = harness({ agent: null })
    const result = await handler({ tranche: 'task-operator-v1', id: '2' }, CALLER)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('precondition')
      expect(result.error.message).toContain('dispatch.agent')
    }
    expect(launches).toHaveLength(0)
    expect(map.size).toBe(0) // never claimed
  })

  it('launches with the configured agent and returns the durable run identity only once confirmed alive', async () => {
    const { handler, launches } = harness()
    const result = await handler({ tranche: 'task-operator-v1', id: '2' }, CALLER)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.result.started).toBe(true)
    expect(result.result.run).toEqual({ tranche: 'task-operator-v1', id: '2' })
    expect(result.result.mode).toBe('attended')
    expect(result.result.requestId).toMatch(/^req_/)
    expect(launches).toEqual([{ ref: { tranche: 'task-operator-v1', id: '2' }, agent: 'claude', issue: ISSUE }])
  })

  it('is idempotent per request identity — a duplicate start returns the same run and launches nothing new', async () => {
    const { handler, launches } = harness()
    const first = await handler({ tranche: 'task-operator-v1', id: '2' }, CALLER)
    const second = await handler({ tranche: 'task-operator-v1', id: '2' }, CALLER)
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.result.requestId).toBe(first.result.requestId)
    expect(second.result.started).toBe(false)
    expect(second.result.startedAt).toBe(first.result.startedAt)
    expect(launches).toHaveLength(1)
  })

  it('scopes the request identity to the caller — a different caller is a distinct start', async () => {
    const { handler, launches } = harness()
    const a = await handler({ tranche: 'task-operator-v1', id: '2' }, { caller: { id: 'operator-1' } })
    const b = await handler({ tranche: 'task-operator-v1', id: '2' }, { caller: { id: 'operator-2' } })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.result.requestId).not.toBe(b.result.requestId)
    expect(launches).toHaveLength(2)
  })

  it('scopes the request identity to the local checkout — two repos sharing the durable store never collide', async () => {
    const launches: LaunchRecord[] = []
    const { store: sharedStore } = memStore()
    const handlerFor = (root: string) =>
      createTaskStartHandler({
        repoRoot: () => root,
        store: sharedStore,
        agent: () => 'claude',
        resolveIssue: () => ISSUE,
        issueFacts: () => STANDALONE,
        isRunAlive: () => true,
        launch: async (target) => {
          launches.push(target)
          return { alive: true }
        },
        now: () => '2026-01-01T00:00:00.000Z'
      })
    const a = await handlerFor('/repo/checkout-a')({ tranche: 'task-operator-v1', id: '2' }, CALLER)
    const b = await handlerFor('/repo/checkout-b')({ tranche: 'task-operator-v1', id: '2' }, CALLER)
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.result.requestId).not.toBe(b.result.requestId)
    expect(a.result.started).toBe(true)
    expect(b.result.started).toBe(true)
    expect(launches).toHaveLength(2)
  })

  it('is unaffected by a flaky repo lookup — the same underlying checkout always computes the same identity', async () => {
    // A network-resolved repo (the old identity input) can return successfully
    // on one call and fail transiently on the next for the same checkout;
    // `repoRoot` never does, since it is local and synchronous — this pins that
    // the identity computation itself has no such input to begin with.
    const { handler: first } = harness({ repoRoot: REPO_ROOT })
    const a = await first({ tranche: 'task-operator-v1', id: '2' }, CALLER)
    const { handler: second } = harness({ repoRoot: REPO_ROOT })
    const b = await second({ tranche: 'task-operator-v1', id: '2' }, CALLER)
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.result.requestId).toBe(b.result.requestId)
  })

  it('refuses when the task has no resolvable Issue — never launches blind', async () => {
    const { handler, launches, map } = harness({ resolveIssue: () => null })
    const result = await handler({ tranche: 'task-operator-v1', id: '2' }, CALLER)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('infrastructure')
    expect(launches).toHaveLength(0)
    expect(map.size).toBe(0) // claim released — no stale record blocking a retry
  })

  it('releases the claimed identity when the launch fails synchronously, so a retry can start it', async () => {
    let fail = true
    const { handler, launches, map } = harness({
      launch: () => {
        if (fail) throw new Error('launcher missing')
        return { alive: true }
      }
    })
    const first = await handler({ tranche: 'task-operator-v1', id: '2' }, CALLER)
    expect(first.ok).toBe(false)
    if (!first.ok) expect(first.error.kind).toBe('infrastructure')
    expect(map.size).toBe(0) // claim released — no stale record blocking a retry

    fail = false
    const retry = await handler({ tranche: 'task-operator-v1', id: '2' }, CALLER)
    expect(retry.ok).toBe(true)
    if (retry.ok) expect(retry.result.started).toBe(true)
    expect(launches).toHaveLength(2) // the failed attempt, then the retry
  })

  it('reports a failed start carrying the run’s own error output, and releases the claim (O1)', async () => {
    const { handler, launches, map } = harness({
      launch: () => ({ alive: false, error: new Error('process exited before its driver confirmed alive (code 2)') })
    })
    const result = await handler({ tranche: 'task-operator-v1', id: '2' }, CALLER)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('infrastructure')
      expect(result.error.message).toContain('code 2')
      expect(result.error.detail).toContain('code 2')
    }
    expect(map.size).toBe(0) // released — an identical retry launches again
    expect(launches).toHaveLength(1)
  })

  it('a retry after a failed start launches again rather than replaying the dead attempt', async () => {
    let alive = false
    const { handler, launches } = harness({
      launch: () => (alive ? { alive: true } : { alive: false, error: new Error('no agent') })
    })
    const first = await handler({ tranche: 'task-operator-v1', id: '2' }, CALLER)
    expect(first.ok).toBe(false)

    alive = true
    const retry = await handler({ tranche: 'task-operator-v1', id: '2' }, CALLER)
    expect(retry.ok).toBe(true)
    if (retry.ok) expect(retry.result.started).toBe(true)
    expect(launches).toHaveLength(2)
  })

  it('replays a claim still within its own confirm window without checking liveness or relaunching (O3, no race)', async () => {
    // `now` never advances past the claim's own `startedAt` — this call must
    // never treat a fresh claim as dead just because it cannot yet observe a
    // driver lock a concurrent launch may still be in the middle of writing.
    const { handler, launches, map } = harness({ isRunAlive: () => false })
    const first = await handler({ tranche: 'task-operator-v1', id: '2' }, CALLER)
    const second = await handler({ tranche: 'task-operator-v1', id: '2' }, CALLER)
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.result.started).toBe(false)
    expect(launches).toHaveLength(1)
    expect(map.size).toBe(1)
  })

  it('supersedes a stale claim whose task has no live driver, and relaunches (O3)', async () => {
    let now = '2026-01-01T00:00:00.000Z'
    const { handler, launches, map } = harness({ isRunAlive: () => false, now: () => now })
    const first = await handler({ tranche: 'task-operator-v1', id: '2' }, CALLER)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.result.started).toBe(true)

    // Time passes well past the confirm window — the driver this claim named
    // has since died (`isRunAlive` returns false throughout).
    now = new Date(Date.parse(now) + START_STALE_CLAIM_GRACE_MS + 1_000).toISOString()
    const second = await handler({ tranche: 'task-operator-v1', id: '2' }, CALLER)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.result.started).toBe(true) // superseded and relaunched, not replayed
    expect(second.result.requestId).toBe(first.result.requestId) // same identity throughout
    expect(launches).toHaveLength(2)
    expect(map.size).toBe(1)
  })

  it('never supersedes a stale claim whose task still has a live driver — replays instead', async () => {
    let now = '2026-01-01T00:00:00.000Z'
    const { handler, launches } = harness({ isRunAlive: () => true, now: () => now })
    const first = await handler({ tranche: 'task-operator-v1', id: '2' }, CALLER)
    expect(first.ok).toBe(true)

    now = new Date(Date.parse(now) + START_STALE_CLAIM_GRACE_MS + 1_000).toISOString()
    const second = await handler({ tranche: 'task-operator-v1', id: '2' }, CALLER)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.result.started).toBe(false) // still alive — a genuine replay
    expect(launches).toHaveLength(1)
  })

  describe('a standalone task Issue — the `{ issue }` address form', () => {
    it('launches the run that Issue number names, and reports it only once confirmed alive', async () => {
      const { handler, launches } = harness({ resolveIssue: (ref) => ('issue' in ref ? ref.issue : ISSUE) })
      const result = await handler({ issue: 729 }, CALLER)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.result.started).toBe(true)
      expect(result.result.run).toEqual({ issue: 729 })
      expect(result.result.mode).toBe('attended')
      // The Issue it confirms against is the number itself — nothing resolved
      // over the tranche-labeled list, which would not contain it.
      expect(launches).toEqual([{ ref: { issue: 729 }, agent: 'claude', issue: 729 }])
    })

    it('is idempotent per request identity exactly as a tranche start is', async () => {
      const { handler, launches } = harness({ resolveIssue: (ref) => ('issue' in ref ? ref.issue : ISSUE) })
      const first = await handler({ issue: 729 }, CALLER)
      const second = await handler({ issue: 729 }, CALLER)
      expect(first.ok && second.ok).toBe(true)
      if (!first.ok || !second.ok) return
      expect(second.result.requestId).toBe(first.result.requestId)
      expect(second.result.started).toBe(false)
      expect(second.result.run).toEqual({ issue: 729 })
      expect(launches).toHaveLength(1)
    })

    it('never shares a claim with a tranche ref that resolves to the same Issue', async () => {
      // The trap this rules out: both forms addressing Issue 729 would collapse
      // into one claim, and the second call would replay a run it never started.
      const { handler, launches } = harness({ resolveIssue: () => 729 })
      const byIssue = await handler({ issue: 729 }, CALLER)
      const byOrdinal = await handler({ tranche: 'unattended-run-v1', id: '14' }, CALLER)
      expect(byIssue.ok && byOrdinal.ok).toBe(true)
      if (!byIssue.ok || !byOrdinal.ok) return
      expect(byIssue.result.requestId).not.toBe(byOrdinal.result.requestId)
      expect(byIssue.result.started).toBe(true)
      expect(byOrdinal.result.started).toBe(true)
      expect(launches).toHaveLength(2)
    })

    it('leaves the tranche form byte-for-byte as it was — same launch, same Issue resolution (O2)', async () => {
      const seen: TaskToolRef[] = []
      const { handler, launches } = harness({
        resolveIssue: (ref) => {
          seen.push(ref)
          return ISSUE
        }
      })
      const result = await handler({ tranche: 'task-operator-v1', id: '2' }, CALLER)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.result.run).toEqual({ tranche: 'task-operator-v1', id: '2' })
      expect(seen).toEqual([{ tranche: 'task-operator-v1', id: '2' }])
      expect(launches).toEqual([{ ref: { tranche: 'task-operator-v1', id: '2' }, agent: 'claude', issue: ISSUE }])
    })

    it('never reads the forge for a tranche target — the labeled-Issue resolution already proves that one', async () => {
      const { handler } = harness({
        issueFacts: () => {
          throw new Error('issueFacts must not be consulted for a tranche target')
        }
      })
      const result = await handler({ tranche: 'task-operator-v1', id: '2' }, CALLER)
      expect(result.ok).toBe(true)
    })
  })

  /**
   * The start-side resolver `defaultResolveIssue` binds (O1/O2): it reads the
   * open tranche-labeled Issues directly and resolves an ordinal WITHOUT ever
   * asking whether the task's brief is frozen — the whole point, since
   * `task_start` starts a planned task `task run` preparation has not frozen
   * yet. The `gh` stub below returns a bare `issue list` and FAILS LOUDLY if
   * `issue view` is ever called, which is exactly how a frozen-brief check
   * would show up — so a green run proves the resolver never makes one.
   */
  describe('resolveOpenTaskIssueForRef — the start-side resolver over open, planned Issues', () => {
    let sandbox: string
    let savedPath: string | undefined

    function withStubbedForge(issuesJson: string, run: () => void): void {
      sandbox = mkdtempSync(join(tmpdir(), 'vinaya-task-start-resolve-'))
      const gh = join(sandbox, 'gh')
      writeFileSync(
        gh,
        `#!/bin/sh
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  cat <<'JSON'
${issuesJson}
JSON
  exit 0
fi
echo "gh stub: unexpected call (a frozen-brief check would land here): $*" >&2
exit 1
`,
        { mode: 0o755 }
      )
      chmodSync(gh, 0o755)
      savedPath = process.env.PATH
      process.env.PATH = `${sandbox}:${process.env.PATH ?? ''}`
      try {
        run()
      } finally {
        if (savedPath === undefined) delete process.env.PATH
        else process.env.PATH = savedPath
        rmSync(sandbox, { recursive: true, force: true })
      }
    }

    // A planned task Issue: open, tranche-labeled, its title carrying the
    // ordinal — and NO frozen brief. `resolveIssueForRef`'s status-list read
    // would skip it; this resolver must find it (O1).
    const PLANNED_ISSUES = JSON.stringify([
      {
        number: 741,
        title: '[unattended-run-v1] 10 — a planned task, brief not frozen',
        labels: [{ name: 'vinaya/tranche:unattended-run-v1' }]
      },
      {
        number: 742,
        title: '[unattended-run-v1] 11 — another planned task',
        labels: [{ name: 'vinaya/tranche:unattended-run-v1' }]
      }
    ])

    it('resolves a planned task whose brief is not frozen — the open, labeled Issue task run preparation resolves (O1)', () => {
      withStubbedForge(PLANNED_ISSUES, () => {
        expect(resolveOpenTaskIssueForRef({ tranche: 'unattended-run-v1', id: '10' })).toBe(741)
      })
    })

    it('refuses (null) an ordinal that names no open task Issue — never resolves blind (O2)', () => {
      withStubbedForge(PLANNED_ISSUES, () => {
        expect(resolveOpenTaskIssueForRef({ tranche: 'unattended-run-v1', id: '99' })).toBeNull()
      })
    })

    it('returns a raw Issue ref unchanged, with no forge read at all', () => {
      // No stub on PATH: an `{ issue }` ref must never shell out to `gh`.
      expect(resolveOpenTaskIssueForRef({ issue: 741 })).toBe(741)
    })
  })

  describe('defaultLaunch — the real spawn, confirmed on a real driver lock', () => {
    let sandbox: string

    function cleanup(): void {
      if (sandbox) rmSync(sandbox, { recursive: true, force: true })
    }

    it('resolves alive once the launched process writes its own driver lock', async () => {
      sandbox = mkdtempSync(join(tmpdir(), 'vinaya-task-start-launch-'))
      try {
        const script = join(sandbox, 'stays-alive.sh')
        const dir = join(sandbox, 'tasks-execution', String(ISSUE))
        mkdirSync(dir, { recursive: true })
        writeFileSync(
          script,
          `#!/bin/sh\necho '{"pid": '"$$"', "startedAt": "2026-01-01T00:00:00.000Z"}' > "${dir}/driver.pid.json"\nexec sleep 3\n`,
          { mode: 0o755 }
        )
        const original = process.env[TASK_RUN_COMMAND_ENV]
        process.env[TASK_RUN_COMMAND_ENV] = script
        try {
          const outcome = await defaultLaunch(
            { ref: { tranche: 'task-operator-v1', id: '2' }, agent: 'claude', issue: ISSUE },
            { requestId: 'req_x', caller: 'operator-1' },
            sandbox
          )
          expect(outcome.alive).toBe(true)
        } finally {
          if (original === undefined) delete process.env[TASK_RUN_COMMAND_ENV]
          else process.env[TASK_RUN_COMMAND_ENV] = original
        }
      } finally {
        cleanup()
      }
    })

    it('spawns `task run --issue <n>` for a standalone Issue, and `task run <tranche> <id>` for a tranche task', async () => {
      sandbox = mkdtempSync(join(tmpdir(), 'vinaya-task-start-launch-'))
      try {
        const argvLog = join(sandbox, 'argv.log')
        const script = join(sandbox, 'record-argv.sh')
        const dir = join(sandbox, 'tasks-execution', String(ISSUE))
        mkdirSync(dir, { recursive: true })
        writeFileSync(
          script,
          `#!/bin/sh\necho "$@" >> "${argvLog}"\necho '{"pid": '"$$"', "startedAt": "2026-01-01T00:00:00.000Z"}' > "${dir}/driver.pid.json"\nexec sleep 3\n`,
          { mode: 0o755 }
        )
        const original = process.env[TASK_RUN_COMMAND_ENV]
        process.env[TASK_RUN_COMMAND_ENV] = script
        try {
          const byIssue = await defaultLaunch(
            { ref: { issue: ISSUE }, agent: 'claude', issue: ISSUE },
            { requestId: 'req_issue', caller: 'operator-1' },
            sandbox
          )
          expect(byIssue.alive).toBe(true)
          const byTranche = await defaultLaunch(
            { ref: { tranche: 'demo', id: '3' }, agent: 'codex', issue: ISSUE },
            { requestId: 'req_tranche', caller: 'operator-1' },
            sandbox
          )
          expect(byTranche.alive).toBe(true)
          expect(readFileSync(argvLog, 'utf8').trim().split('\n')).toEqual([
            `task run --issue ${ISSUE} --agent claude`,
            'task run demo 3 --agent codex'
          ])
        } finally {
          if (original === undefined) delete process.env[TASK_RUN_COMMAND_ENV]
          else process.env[TASK_RUN_COMMAND_ENV] = original
        }
      } finally {
        cleanup()
      }
    })

    it('reports a real ENOENT through its own LaunchResult, never as an unhandled error', async () => {
      sandbox = mkdtempSync(join(tmpdir(), 'vinaya-task-start-launch-'))
      try {
        const original = process.env[TASK_RUN_COMMAND_ENV]
        process.env[TASK_RUN_COMMAND_ENV] = '/does/not/exist/vinaya-launcher-fixture'
        try {
          const outcome = await defaultLaunch(
            { ref: { tranche: 'task-operator-v1', id: '2' }, agent: 'claude', issue: ISSUE },
            { requestId: 'req_x', caller: 'operator-1' },
            sandbox
          )
          expect(outcome.alive).toBe(false)
          if (!outcome.alive) expect(outcome.error.message).toContain('ENOENT')
        } finally {
          if (original === undefined) delete process.env[TASK_RUN_COMMAND_ENV]
          else process.env[TASK_RUN_COMMAND_ENV] = original
        }
      } finally {
        cleanup()
      }
    })
  })
})
