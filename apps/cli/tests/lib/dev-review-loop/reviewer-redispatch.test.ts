/**
 * A reviewer dispatched again in a round already reviewed — after a
 * Principal ruling, a resume, or any re-run — writes into an output directory
 * no earlier dispatch used, so the loop never reads the earlier dispatch's
 * `findings.txt`/`objectives.txt`/`report.txt` as the new verdict, and that
 * directory is inside the reviewer's sandbox's writable set.
 *
 * The earlier dispatch is modeled by the files it leaves on disk: the round's
 * `security-work` directory, already holding a full report, before the round
 * runs. See `dev-review-loop-harness.ts` for the in-process world.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import {
  freshReviewerWorkDir,
  missingReviewerArtifacts,
  reviewerOutputFloorMs,
  reviewerWorkDir
} from '../../../src/lib/dev-review-loop/reviewer-dispatch.js'
import type { LoopDeps } from '../../../src/lib/dev-review-loop.js'
import { addCodexWritableDirs, buildWriteAccessScope } from '../../../src/lib/dispatch.js'
import { resolveClaudeConfinement } from '../../../src/lib/worker-boundary.js'
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

/** Creates a directory the way the driver does — owner-only — without importing the driver's path module. */
function makeOwnerOnlyDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

const EARLIER_FAIL = {
  findings: 'HIGH|apps/cli/src/lib/example.ts:12|a secret is logged in plain text.\n',
  report: 'CONFIG_SCAN: clean\nSECRETS: none found — atta-labs/secret-scan passed\nFINDING_IDS: F1\n',
  objectives: 'O1|MET|done.\n'
}

/** Leaves the files an earlier dispatch of round 1's security review wrote, where that dispatch wrote them. */
function seedEarlierSecurityDispatch(
  world: LoopWorld,
  files: { findings: string; report: string; objectives: string }
): string {
  const dir = join(roundDir(world, 1), 'security-work')
  makeOwnerOnlyDir(dir)
  writeFileSync(join(dir, 'findings.txt'), files.findings)
  writeFileSync(join(dir, 'report.txt'), files.report)
  writeFileSync(join(dir, 'objectives.txt'), files.objectives)
  return dir
}

/** Records the output directory each security dispatch was granted, in dispatch order. */
function recordSecurityDirs(world: LoopWorld): { dirs: string[]; prompts: string[]; deps: Partial<LoopDeps> } {
  const base = makeInProcessDeps(world)
  const dirs: string[] = []
  const prompts: string[] = []
  const dispatchRole: LoopDeps['dispatchRole'] = async (role, agent, prompt, opts) => {
    if (role === 'security') {
      dirs.push(opts.extraWritableDirs?.[0] ?? '')
      prompts.push(prompt)
    }
    return base.dispatchRole!(role, agent, prompt, opts)
  }
  return { dirs, prompts, deps: { dispatchRole } }
}

describe('a re-dispatched reviewer never reads an earlier dispatch’s output', () => {
  it('a re-dispatch whose reviewer writes nothing is not delivered — the earlier dispatch’s clean report is never read as its verdict', async () => {
    const world = makeWorld({
      roleOutcomes: { 1: { security: { ...CLEAN_SECURITY, writesNothing: true } } }
    })
    const earlierDir = seedEarlierSecurityDispatch(world, {
      findings: CLEAN_SECURITY.findings,
      report: CLEAN_SECURITY.report,
      objectives: CLEAN_SECURITY.objectives!
    })
    const { dirs, deps } = recordSecurityDirs(world)

    const result = await runLoopInProcess(world, { task: world.task, agent: 'claude' }, deps)

    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'infrastructure' })
    expect(world.dispatches.filter((d) => d.role === 'security').map((d) => d.round)).toEqual([1, 1])
    expect(dirs).toHaveLength(2)
    expect(dirs).not.toContain(earlierDir)
    expect(world.publishedRounds).toEqual([])
  })

  it('a re-dispatch whose reviewer writes PASS is recorded as PASS although the earlier dispatch wrote FAIL, and the earlier files stay untouched', async () => {
    const world = makeWorld()
    const earlierDir = seedEarlierSecurityDispatch(world, EARLIER_FAIL)
    const { dirs, deps } = recordSecurityDirs(world)

    const result = await runLoopInProcess(world, { task: world.task, agent: 'claude' }, deps)

    expect(result.finalDecision).toEqual({ type: 'publish' })
    expect(dirs).toEqual([`${earlierDir}-redispatch1`])
    const held = readFileSync(join(roundDir(world, 1), 'security.md'), 'utf8')
    expect(held).not.toMatch(/a secret is logged in plain text/)
    expect(readFileSync(join(earlierDir, 'findings.txt'), 'utf8')).toBe(EARLIER_FAIL.findings)
    expect(readFileSync(join(earlierDir, 'report.txt'), 'utf8')).toBe(EARLIER_FAIL.report)
  })

  it('the re-dispatched reviewer’s output directory is the one its prompt names, and inside its sandbox’s writable set', async () => {
    const world = makeWorld()
    seedEarlierSecurityDispatch(world, EARLIER_FAIL)
    const { dirs, prompts, deps } = recordSecurityDirs(world)

    await runLoopInProcess(world, { task: world.task, agent: 'claude' }, deps)

    const workDir = dirs[0]!
    expect(existsSync(workDir)).toBe(true)
    expect(prompts[0]).toContain(join(workDir, 'findings.txt'))
    const realDir = realpathSync(workDir)

    // Claude: the sandbox block `dispatch.ts` builds from this dispatch's own
    // `extraWritableDirs`, and the write-access hook's file grant.
    const confinement = resolveClaudeConfinement(
      {
        role: 'security',
        agent: 'claude',
        worktreeDir: world.repoRoot,
        scratchDir: world.runtimeDir,
        allowedHosts: [],
        extraWritableDirs: dirs
      },
      { platform: 'darwin', linuxTools: { available: true, missing: [] } as never, developerDir: null }
    )
    if (!confinement.ok || !confinement.confined) throw new Error('expected a confined Claude sandbox')
    expect(confinement.settings.sandbox.filesystem.allowWrite).toContain(realDir)
    const scope = buildWriteAccessScope('security', world.repoRoot, dirs)
    expect(scope).toEqual({
      kind: 'exact-files',
      paths: ['findings.txt', 'report.txt', 'objectives.txt'].map((f) => join(realDir, f))
    })

    // Codex: the same directory as a writable root.
    const codexArgs = addCodexWritableDirs(['exec', '--json'], dirs, false)
    expect(codexArgs).toEqual(['exec', '--add-dir', realDir, '--json'])
  })
})

describe('freshReviewerWorkDir / missingReviewerArtifacts', () => {
  it('gives each dispatch of one round, role and attempt its own directory', () => {
    const world = makeWorld()
    const first = freshReviewerWorkDir(world.runtimeDir, world.task, 1, 'reviewer')
    expect(first).toBe(reviewerWorkDir(world.runtimeDir, world.task, 1, 'reviewer'))
    makeOwnerOnlyDir(first)
    const second = freshReviewerWorkDir(world.runtimeDir, world.task, 1, 'reviewer')
    makeOwnerOnlyDir(second)
    const third = freshReviewerWorkDir(world.runtimeDir, world.task, 1, 'reviewer')
    expect(second).toBe(`${first}-redispatch1`)
    expect(third).toBe(`${first}-redispatch2`)
    const retry = freshReviewerWorkDir(world.runtimeDir, world.task, 1, 'reviewer', 2)
    expect(retry).toBe(reviewerWorkDir(world.runtimeDir, world.task, 1, 'reviewer', 2))
  })

  it('counts a file older than the dispatch as missing, never as its output', () => {
    const world = makeWorld()
    const dir = freshReviewerWorkDir(world.runtimeDir, world.task, 1, 'security')
    makeOwnerOnlyDir(dir)
    const floor = reviewerOutputFloorMs(dir)
    writeFileSync(join(dir, 'findings.txt'), '')
    writeFileSync(join(dir, 'report.txt'), CLEAN_SECURITY.report)
    writeFileSync(join(dir, 'objectives.txt'), CLEAN_SECURITY.objectives!)
    expect(missingReviewerArtifacts(dir, true, floor)).toEqual([])

    const earlier = new Date(floor - 60_000)
    utimesSync(join(dir, 'report.txt'), earlier, earlier)
    expect(missingReviewerArtifacts(dir, true, floor)).toEqual(['report.txt'])
    expect(missingReviewerArtifacts(dir, true)).toEqual([])
  })
})
