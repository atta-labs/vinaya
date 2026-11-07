// Vinaya's run control, role dispatch, task-contract commands, agent-file
// emitters, artifacts and the Developer and reviewer results live in the
// Vinaya process (`harness/processes/vinaya-strict/`), not in the CLI. This
// test lists each file the move took out of the CLI, beside where it lives
// now, and refuses any of them existing again at its old place — so a new
// copy of the loop, the run control or the role dispatch under `apps/cli/src`
// fails here rather than quietly forking the process.
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const PROCESS = 'harness/processes/vinaya-strict'

/** Each moved file's old path in the CLI, and its path in the process. */
const MOVED_OUT_OF_THE_CLI: readonly (readonly [string, string])[] = [
  [
    'apps/cli/src/commands/pr-verify-evidence-logic.test.ts',
    `${PROCESS}/tools/pr-report/pr-verify-evidence-logic.test.ts`
  ],
  ['apps/cli/src/commands/pr-verify-evidence-logic.ts', `${PROCESS}/tools/pr-report/pr-verify-evidence-logic.ts`],
  ['apps/cli/src/lib/agents-skills-emitter.ts', `${PROCESS}/integration/agents-skills-emitter.ts`],
  ['apps/cli/src/lib/artifacts.ts', `${PROCESS}/integration/artifacts.ts`],
  ['apps/cli/src/lib/backend-rollback.ts', `${PROCESS}/loops/dev-review/run-control/backend-rollback.ts`],
  ['apps/cli/src/lib/brief-assembly.ts', `${PROCESS}/tools/task-contract/brief-assembly.ts`],
  ['apps/cli/src/lib/claude-command-emitter.ts', `${PROCESS}/integration/claude-command-emitter.ts`],
  ['apps/cli/src/lib/claude-stop-hook-emitter.ts', `${PROCESS}/integration/claude-stop-hook-emitter.ts`],
  ['apps/cli/src/lib/context-packet.ts', `${PROCESS}/tools/task-contract/context-packet.ts`],
  ['apps/cli/src/lib/detached-launch.ts', `${PROCESS}/loops/dev-review/run-control/detached-launch.ts`],
  ['apps/cli/src/lib/developer-turn-result.ts', `${PROCESS}/executing/developer/developer-turn-result.ts`],
  ['apps/cli/src/lib/dispatch-task.ts', `${PROCESS}/tools/task-contract/dispatch-task.ts`],
  ['apps/cli/src/lib/dispatch.ts', `${PROCESS}/loops/dev-review/dispatch/dispatch.ts`],
  ['apps/cli/src/lib/flow-v2-events.ts', `${PROCESS}/loops/dev-review/flow-v2-events.ts`],
  ['apps/cli/src/lib/forge-write.ts', `${PROCESS}/tools/task-contract/forge/forge-write.ts`],
  ['apps/cli/src/lib/gemini-command-emitter.ts', `${PROCESS}/integration/gemini-command-emitter.ts`],
  ['apps/cli/src/lib/milestone-close-hold.ts', `${PROCESS}/retrospecting/archivist/milestone-close-hold.ts`],
  ['apps/cli/src/lib/pr-report-engine.ts', `${PROCESS}/tools/pr-report/pr-report-engine.ts`],
  ['apps/cli/src/lib/registry-write.ts', `${PROCESS}/artifacts/registry-write.ts`],
  ['apps/cli/src/lib/review-gate-input.ts', `${PROCESS}/loops/dev-review/review-gate-input.ts`],
  ['apps/cli/src/lib/review-result.ts', `${PROCESS}/executing/code-reviewer/review-result.ts`],
  ['apps/cli/src/lib/task-run-background.ts', `${PROCESS}/loops/dev-review/run-control/task-run-background.ts`],
  ['apps/cli/src/lib/task-run-engine.ts', `${PROCESS}/loops/dev-review/run-control/task-run-engine.ts`],
  ['apps/cli/src/lib/task-run.ts', `${PROCESS}/loops/dev-review/run-control/task-run.ts`],
  ['apps/cli/src/lib/task-status-history.ts', `${PROCESS}/loops/dev-review/run-control/task-status-history.ts`],
  ['apps/cli/src/lib/task-status.ts', `${PROCESS}/loops/dev-review/run-control/task-status.ts`],
  ['apps/cli/src/lib/task-sweep.ts', `${PROCESS}/loops/dev-review/run-control/task-sweep.ts`],
  ['apps/cli/src/lib/task-switch.ts', `${PROCESS}/loops/dev-review/run-control/task-switch.ts`],
  ['apps/cli/src/lib/task-tools/adapters.ts', `${PROCESS}/integration/adapters.ts`],
  ['apps/cli/src/lib/task-tools/cancel.ts', `${PROCESS}/loops/dev-review/run-control/cancel.ts`],
  [
    'apps/cli/src/lib/task-tools/developer-dev-tools-context.ts',
    `${PROCESS}/loops/dev-review/actions/developer-dev-tools-context.ts`
  ],
  ['apps/cli/src/lib/task-tools/handlers.ts', `${PROCESS}/loops/dev-review/run-control/handlers.ts`],
  [
    'apps/cli/src/lib/task-tools/live-developer-context.ts',
    `${PROCESS}/loops/dev-review/actions/live-developer-context.ts`
  ],
  ['apps/cli/src/lib/task-tools/pr-facts.ts', `${PROCESS}/loops/dev-review/run-control/pr-facts.ts`],
  ['apps/cli/src/lib/task-tools/pr-read.ts', `${PROCESS}/loops/dev-review/run-control/pr-read.ts`],
  ['apps/cli/src/lib/task-tools/read.ts', `${PROCESS}/loops/dev-review/run-control/read.ts`],
  ['apps/cli/src/lib/task-tools/resume.ts', `${PROCESS}/loops/dev-review/run-control/resume.ts`],
  ['apps/cli/src/lib/task-tools/server.ts', `${PROCESS}/integration/server.ts`],
  ['apps/cli/src/lib/task-tools/start.ts', `${PROCESS}/loops/dev-review/run-control/start.ts`],
  ['apps/cli/src/roles/plan.ts', `${PROCESS}/integration/roles/plan.ts`]
]

/** Every moved file found again at its old place under `root`, as a TypeScript or JavaScript source of either extension. */
function reappearedInTheCli(root: string): string[] {
  return MOVED_OUT_OF_THE_CLI.flatMap(([old]) =>
    [old, old.replace(/\.ts$/, '.js'), old.replace(/\.ts$/, '.tsx')].filter((path) => existsSync(join(root, path)))
  )
}

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('placement — the Vinaya process holds its run control and role dispatch, the CLI does not', () => {
  it('lists forty-one moved files, each with one old and one new path', () => {
    expect(MOVED_OUT_OF_THE_CLI.length).toBe(41)
    expect(new Set(MOVED_OUT_OF_THE_CLI.map(([old]) => old)).size).toBe(41)
    expect(new Set(MOVED_OUT_OF_THE_CLI.map(([, now]) => now)).size).toBe(41)
    for (const [old, now] of MOVED_OUT_OF_THE_CLI) {
      expect(old.startsWith('apps/cli/src/'), old).toBe(true)
      expect(now.startsWith(`${PROCESS}/`), now).toBe(true)
    }
  })

  it('finds every moved file at its place in the process', () => {
    const missing = MOVED_OUT_OF_THE_CLI.map(([, now]) => now).filter((now) => !existsSync(join(REPO_ROOT, now)))
    expect(missing).toEqual([])
  })

  it('refuses any moved file existing again under the CLI', () => {
    expect(reappearedInTheCli(REPO_ROOT)).toEqual([])
  })

  it('names a moved file planted back at its old place, whichever source extension it takes', () => {
    const root = mkdtempSync(join(tmpdir(), 'vinaya-placement-'))
    scratch.push(root)
    for (const planted of ['apps/cli/src/lib/dispatch.ts', 'apps/cli/src/lib/task-tools/start.js']) {
      mkdirSync(dirname(join(root, planted)), { recursive: true })
      writeFileSync(join(root, planted), 'export {}\n')
    }
    expect(reappearedInTheCli(root)).toEqual(['apps/cli/src/lib/dispatch.ts', 'apps/cli/src/lib/task-tools/start.js'])
  })
})
