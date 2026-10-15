/**
 * A reviewer dispatched again in a round already reviewed — after a
 * Principal ruling, a resume, or any re-run — is a fresh, non-resumed session
 * whose verdict is only the structured ReviewResult that dispatch itself
 * returns. Nothing an earlier dispatch left on disk is ever read as a
 * verdict, and a reviewer is granted no result directory to write into.
 *
 * The earlier dispatch is modeled by the result files reviewers once wrote:
 * the round's `security-work` directory, already holding a full report,
 * before the round runs. See `dev-review-loop-harness.ts` for the in-process
 * world.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import type { LoopDeps } from '../../../src/lib/dev-review-loop.js'
import { buildWriteAccessScope, type DispatchOpts } from '../../../src/lib/dispatch.js'
import {
  CLEAN_SECURITY,
  cleanupWorlds,
  makeInProcessDeps,
  makeWorld,
  roundDir,
  runLoopInProcess,
  type LoopWorld
} from '../dev-review-loop-harness.js'

afterEach(cleanupWorlds)

const EARLIER_FAIL = {
  findings: 'HIGH|apps/cli/src/lib/example.ts:12|a secret is logged in plain text.\n',
  report: 'CONFIG_SCAN: clean\nSECRETS: none found — atta-labs/secret-scan passed\nFINDING_IDS: F1\n',
  objectives: 'O1|MET|done.\n'
}

/** Leaves the result files an earlier security dispatch of round 1 once wrote, where it wrote them. */
function seedEarlierSecurityDispatch(world: LoopWorld): string {
  const dir = join(roundDir(world, 1), 'security-work')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'findings.txt'), EARLIER_FAIL.findings)
  writeFileSync(join(dir, 'report.txt'), EARLIER_FAIL.report)
  writeFileSync(join(dir, 'objectives.txt'), EARLIER_FAIL.objectives)
  return dir
}

/** Records the options and prompt each reviewer dispatch was handed, in dispatch order. */
function recordReviewerDispatches(world: LoopWorld): {
  options: { role: string; opts: DispatchOpts; prompt: string }[]
  deps: Partial<LoopDeps>
} {
  const base = makeInProcessDeps(world)
  const options: { role: string; opts: DispatchOpts; prompt: string }[] = []
  const dispatchRole: LoopDeps['dispatchRole'] = async (role, agent, prompt, opts) => {
    if (role === 'security' || role === 'code-reviewer') options.push({ role, opts, prompt })
    return base.dispatchRole!(role, agent, prompt, opts)
  }
  return { options, deps: { dispatchRole } }
}

describe('a re-dispatched reviewer never reads an earlier dispatch’s output', () => {
  it('a re-dispatch that returns no structured result is no review — the earlier dispatch’s clean files are never read as its verdict', async () => {
    const world = makeWorld({
      roleOutcomes: { 1: { security: { ...CLEAN_SECURITY, writesNothing: true } } }
    })
    const earlierDir = join(roundDir(world, 1), 'security-work')
    mkdirSync(earlierDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(earlierDir, 'findings.txt'), CLEAN_SECURITY.findings)
    writeFileSync(join(earlierDir, 'report.txt'), CLEAN_SECURITY.report)
    writeFileSync(join(earlierDir, 'objectives.txt'), CLEAN_SECURITY.objectives!)

    const result = await runLoopInProcess(world, { task: world.task, agent: 'claude' })

    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'infrastructure' })
    expect(world.dispatches.filter((d) => d.role === 'security').map((d) => d.round)).toEqual([1, 1])
    expect(world.publishedRounds).toEqual([])
  })

  it('a re-dispatch returning PASS is recorded as PASS although the earlier dispatch wrote FAIL, and the earlier files stay untouched', async () => {
    const world = makeWorld()
    const earlierDir = seedEarlierSecurityDispatch(world)

    const result = await runLoopInProcess(world, { task: world.task, agent: 'claude' })

    expect(result.finalDecision).toEqual({ type: 'publish' })
    const held = readFileSync(join(roundDir(world, 1), 'security.md'), 'utf8')
    expect(held).not.toMatch(/a secret is logged in plain text/)
    expect(readFileSync(join(earlierDir, 'findings.txt'), 'utf8')).toBe(EARLIER_FAIL.findings)
    expect(readFileSync(join(earlierDir, 'report.txt'), 'utf8')).toBe(EARLIER_FAIL.report)
  })

  it('every reviewer dispatch is fresh, granted no result directory, names no result file, and may write no file', async () => {
    const world = makeWorld()
    seedEarlierSecurityDispatch(world)
    const { options, deps } = recordReviewerDispatches(world)

    await runLoopInProcess(world, { task: world.task, agent: 'claude' }, deps)

    expect(options.map((o) => o.role).sort()).toEqual(['code-reviewer', 'security'])
    for (const { role, opts, prompt } of options) {
      expect(opts.unattended).toBe(true)
      expect(opts.resumeId).toBeUndefined()
      expect(opts.extraWritableDirs).toBeUndefined()
      for (const file of ['findings.txt', 'objectives.txt', 'report.txt']) expect(prompt).not.toContain(file)
      expect(prompt).toContain('ReviewResult')
      expect(buildWriteAccessScope(role as 'security', world.repoRoot)).toEqual({ kind: 'exact-files', paths: [] })
    }
  })
})
