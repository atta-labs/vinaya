import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { taskEscalationReadHandler, taskStatusHandler } from '../../../src/lib/task-tools/handlers.js'

/**
 * The forge-touching composition inside `taskStatusHandler`/
 * `taskEscalationReadHandler` (a `{ tranche, id }` ref, or no ref at all)
 * shells to real `gh` via `task-status.ts`'s own `gatherTaskStatusList` —
 * exercised end-to-end there (`apps/cli/tests/commands/task-status.test.ts`)
 * against a `gh` stub on `PATH`. What IS safe and
 * deterministic in-process: validation (rejected before any read at all),
 * and the `{ issue }` shape of `task_escalation_read`, which resolves
 * straight to the outbox with no forge call — read against a bare Issue
 * number no real outbox on this machine will ever carry. `task_start`,
 * `task_resume` and `task_cancel` are real handlers of their own now — see
 * `start.test.ts`, `resume.test.ts` and `cancel.test.ts`.
 *
 * The regression guard at the bottom re-mocks `gh` — but out-of-process,
 * in a fresh `bun` subprocess with an isolated `HOME`, never in-process:
 * `runtimeDirForRepo` memoizes per repo for the life of a process
 * (`run-paths.ts`), so an in-process `HOME` swap would read a stale, cached
 * tree. It proves the split unattended-run-v1 task 8 (`#738`) introduced:
 * `task_status` now LISTS an open, tranche-labeled task whose brief is not
 * frozen — as `not started` (O4) — while `task_escalation_read`'s own resolver
 * (`resolveIssueForRef`) STILL refuses it, since a planned task has no pause or
 * escalation to read. Task 10's start-side resolver (`resolveOpenTaskIssueForRef`)
 * must NOT leak into that escalation-reader path.
 */

const NEVER_DISPATCHED_ISSUE = 900_000_001

describe('taskStatusHandler', () => {
  it('refuses malformed input with a validation error, before any read', () => {
    const result = taskStatusHandler({ limit: -1 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('validation')
  })

  it('refuses a limit over the catalog’s own ceiling', () => {
    const result = taskStatusHandler({ limit: 10_000 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('validation')
  })
})

describe('taskEscalationReadHandler', () => {
  it('refuses malformed input with a validation error', () => {
    const result = taskEscalationReadHandler({ task: { tranche: '', id: '1' } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('validation')
  })

  it('answers an empty, unknown-freshness page, never an error, for a bare Issue ref with no outbox record', () => {
    const result = taskEscalationReadHandler({ task: { issue: NEVER_DISPATCHED_ISSUE } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.result.items).toEqual([])
    expect(result.result.nextCursor).toBeNull()
    expect(result.result.freshness).toBe('unknown')
    expect(typeof result.result.observedAt).toBe('string')
  })
})

/**
 * Issue #660's own leak, guarded the same way every sibling subprocess
 * fixture in this directory guards it: a leaked `VINAYA_*` from a dispatched
 * session's environment survives a `HOME` override into the child, so it is
 * stripped before the child ever runs.
 */
function stripVinayaEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  for (const key of Object.keys(out)) {
    if (key.startsWith('VINAYA_')) delete out[key]
  }
  delete out.GITHUB_ACTIONS
  return out
}

describe('task_status lists an unfrozen task as not started; task_escalation_read still refuses it (O4)', () => {
  // Two open, tranche-labeled Issues: `[demo] 1` carries a principal-frozen
  // `aeg:brief:v1` comment; `[demo] 2` is planned, its brief NOT frozen (its
  // only comment is an ordinary reply). `task_status` now lists BOTH — the
  // planned one as `not started` (O4) — while `task_escalation_read`'s resolver
  // resolves ONLY the frozen one.
  const stubbedGh = `#!/bin/sh
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  cat <<'JSON'
[
  {"number":8801,"title":"[demo] 1 — a frozen task","labels":[{"name":"vinaya/tranche:demo"}]},
  {"number":8802,"title":"[demo] 2 — a planned task, brief not frozen","labels":[{"name":"vinaya/tranche:demo"}]}
]
JSON
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  case "$3" in
    8801) cat <<'JSON'
{"comments":[{"body":"<!-- aeg:brief:v1 -->\\nBrief hash: deadbeef\\n\\nA brief body.","author":{"login":"daniboomerang"}}]}
JSON
    ;;
    *) cat <<'JSON'
{"comments":[{"body":"just an ordinary reply, no frozen brief","author":{"login":"someone-else"}}]}
JSON
    ;;
  esac
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  echo '[]'
  exit 0
fi
# Anything else (e.g. the trust-anchor config fetch) fails, and the caller
# falls back to the built-in principal allowlist — the same graceful path a
# real \`gh\` stub triggers in tests/commands/task-status.test.ts.
echo "gh stub: unhandled: $*" >&2
exit 1
`

  const fixtureScript = `
import { taskEscalationReadHandler, taskStatusHandler } from '../../../src/lib/task-tools/handlers.js'

const status = taskStatusHandler({})
const frozen = taskEscalationReadHandler({ task: { tranche: 'demo', id: '1' } })
const planned = taskEscalationReadHandler({ task: { tranche: 'demo', id: '2' } })
process.stdout.write('O3_RESULT:' + JSON.stringify({ status, frozen, planned }) + '\\n')
`

  it('lists the planned task as not started, but the escalation reader resolves only the frozen one', () => {
    const repoRoot = join(import.meta.dir, '..', '..', '..', '..', '..')
    const home = mkdtempSync(join(tmpdir(), 'vinaya-o3-omit-'))
    const binDir = join(home, 'bin')
    mkdirSync(binDir, { recursive: true })
    const gh = join(binDir, 'gh')
    writeFileSync(gh, stubbedGh, { mode: 0o755 })
    chmodSync(gh, 0o755)
    const scriptPath = join(import.meta.dir, `.o3-omit-unfrozen-fixture-${process.pid}-${Date.now()}.ts`)
    writeFileSync(scriptPath, fixtureScript)

    try {
      const stdout = execFileSync('bun', [scriptPath], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 18_000,
        killSignal: 'SIGKILL',
        env: {
          ...stripVinayaEnv(process.env),
          HOME: home,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          AEG_REPO: 'attalabs/vinaya'
        }
      })
      const line = stdout.split('\n').find((l) => l.startsWith('O3_RESULT:'))
      expect(line).toBeDefined()
      const parsed = JSON.parse((line as string).slice('O3_RESULT:'.length)) as {
        status: { ok: boolean; result?: { items: Array<{ issue: number; state: string }> } }
        frozen: { ok: boolean; result?: { items: unknown[] } }
        planned: { ok: boolean; error?: { kind: string } }
      }

      // task_status lists BOTH — the planned one as `not started` (O4).
      expect(parsed.status.ok).toBe(true)
      const items = parsed.status.result?.items ?? []
      expect(items.map((i) => i.issue)).toContain(8801)
      const plannedItem = items.find((i) => i.issue === 8802)
      expect(plannedItem?.state).toBe('not started')

      // task_escalation_read resolves the frozen task's ref (empty page, no
      // pause record) but REFUSES the planned one — the resolver it uses
      // (`resolveIssueForRef`) still skips a `not_started` row.
      expect(parsed.frozen.ok).toBe(true)
      expect(parsed.planned.ok).toBe(false)
      expect(parsed.planned.error?.kind).toBe('precondition')
    } finally {
      rmSync(scriptPath, { force: true })
      rmSync(home, { recursive: true, force: true })
    }
  }, 20_000)
})
