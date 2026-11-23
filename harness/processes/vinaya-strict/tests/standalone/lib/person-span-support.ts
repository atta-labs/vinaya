import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { storedEvents, storedSpans } from '../../../../../kernel/gates/checks/runner/local-copy-probe'
import { spawnSyncBudgeted, stripVinayaEnv } from '../../../../../kernel/conformance/unit/process-fixture'
import type { EscalationFacts } from '../../../loops/dev-review/standalone/dev-review-loop/pause-resume'
import { type LoopWorld, outboxLines } from './dev-review-loop-harness'
import { runRecorder } from '../../../../../kernel/log/run-recorder'

const PAUSE_RESUME = join(import.meta.dir, '../../../loops/dev-review/standalone/dev-review-loop/pause-resume.ts')

/** Facts of one escalation in a loop world, with a pull request or without. */
export function escalationFactsFor(world: LoopWorld, overrides: Partial<EscalationFacts> = {}): EscalationFacts {
  return {
    task: world.task,
    round: 1,
    head: world.head,
    branch: world.branch,
    pr: world.prNumber,
    runId: 'run-1',
    agent: 'claude',
    reason: 'escalation',
    detail: 'a concrete, observed fact about this pause',
    briefHash: 'deadbeef',
    objectivesVersion: null,
    rulingOrdinal: 0,
    policyDigest: 'policy-digest',
    ...overrides
  }
}

/** Raises an escalation in a second process, as a pausing driver does; call inside `withWorldEnv`. */
export function raiseInAnotherProcess(facts: EscalationFacts): void {
  // An earlier test of the same process may have bound the recorder to another run and repository; the answer must
  // look for the question where the asking process wrote it.
  runRecorder().bind({})
  const script = `import { writeEscalationRecord } from ${JSON.stringify(PAUSE_RESUME)}
writeEscalationRecord(${JSON.stringify(facts)})
process.exit(0)`
  const run = spawnSyncBudgeted(process.execPath, ['-e', script], {
    env: {
      ...stripVinayaEnv(),
      HOME: process.env.HOME,
      VINAYA_RUNTIME_DIR: process.env.VINAYA_RUNTIME_DIR,
      VINAYA_TASK: process.env.VINAYA_TASK,
      VINAYA_REPO: process.env.VINAYA_REPO
    },
    cwd: process.cwd(),
    encoding: 'utf8'
  })
  if (run.status !== 0) throw new Error(`raising the escalation in a second process failed: ${run.stderr}`)
}

/** What a world's local copy holds of the people the harness asked, and of the earlier format. */
export function personRecordsOf(world: LoopWorld) {
  const logs = join(world.runtimeDir, 'logs')
  const folders = existsSync(logs)
    ? readdirSync(logs, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(logs, entry.name))
    : []
  return {
    asked: () => folders.flatMap((f) => storedEvents(f)).filter((e) => e.name === 'vinaya.person.asked'),
    spans: () => folders.flatMap((f) => storedSpans(f)).filter((s) => s.name.startsWith('vinaya.person ')),
    earlier: () => outboxLines(world).filter((e) => e.kind === 'handoff')
  }
}
