/**
 * The after-turn protected-path check attributes control-store writes by
 * driver tool-call boundary: what a driver tool wrote while its call ran is
 * the driver's; what changed between tool calls is the worker's, for the
 * Developer and for both reviewers (`isolation.md` §7).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import type { LoopDeps } from '../../../src/lib/dev-review-loop.js'
import { type ProtectedPathEntry, startTurnWriteAttribution, taskControlDir } from '../../../src/lib/worker-boundary.js'
import {
  cleanupWorlds,
  controlDir,
  developerPublishesViaToolsDeps,
  type LoopWorld,
  makeInProcessDeps,
  makeWorld,
  runLoopInProcess
} from '../dev-review-loop-harness.js'

const tempDirs: string[] = []

afterEach(() => {
  cleanupWorlds()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A record written into the task's control store — the shape a driver effect or ownership write takes on disk. */
function writeControlRecord(dir: string, area: string, name: string): void {
  mkdirSync(join(dir, area), { recursive: true })
  writeFileSync(join(dir, area, name), JSON.stringify({ written: name }))
}

function controlFixture(): { control: string; config: string; entries: ProtectedPathEntry[] } {
  const root = mkdtempSync(join(tmpdir(), 'after-turn-attribution-'))
  tempDirs.push(root)
  const control = taskControlDir(root, 7)
  mkdirSync(control, { recursive: true })
  const config = join(root, 'vinaya.config.json')
  writeFileSync(config, '{}')
  return {
    control,
    config,
    entries: [
      { path: control, kind: 'dir' },
      { path: config, kind: 'file' }
    ]
  }
}

describe('startTurnWriteAttribution', () => {
  it('O1: a control write made inside a driver tool call is the driver’s', async () => {
    const { control, entries } = controlFixture()
    const attribution = startTurnWriteAttribution(entries, [control])
    await attribution.driverToolCall(async () => writeControlRecord(control, 'ownership', 'epoch-000002.json'))
    await attribution.driverToolCall(async () => writeControlRecord(control, 'effects', 'push.json'))
    expect(attribution.changedPaths()).toEqual([])
  })

  it('O1: a write a tool call makes is still the driver’s when the call throws', async () => {
    const { control, entries } = controlFixture()
    const attribution = startTurnWriteAttribution(entries, [control])
    await expect(
      attribution.driverToolCall(async () => {
        writeControlRecord(control, 'effects', 'push.json')
        throw new Error('push refused')
      })
    ).rejects.toThrow('push refused')
    expect(attribution.changedPaths()).toEqual([])
  })

  it('O2: a control write after the last tool call returned is the worker’s', async () => {
    const { control, entries } = controlFixture()
    const attribution = startTurnWriteAttribution(entries, [control])
    await attribution.driverToolCall(async () => writeControlRecord(control, 'effects', 'push.json'))
    writeControlRecord(control, 'effects', 'forged.json')
    expect(attribution.changedPaths()).toEqual([control])
  })

  it('O2: a control write before a tool call is the worker’s, and the call’s re-baseline never absorbs it', async () => {
    const { control, entries } = controlFixture()
    const attribution = startTurnWriteAttribution(entries, [control])
    writeControlRecord(control, 'effects', 'forged.json')
    await attribution.driverToolCall(async () => writeControlRecord(control, 'effects', 'push.json'))
    expect(attribution.changedPaths()).toEqual([control])
  })

  it('O2: a write between two tool calls is the worker’s', async () => {
    const { control, entries } = controlFixture()
    const attribution = startTurnWriteAttribution(entries, [control])
    await attribution.driverToolCall(async () => writeControlRecord(control, 'effects', 'push.json'))
    writeControlRecord(control, 'ownership', 'forged.json')
    await attribution.driverToolCall(async () => writeControlRecord(control, 'effects', 'pr-open.json'))
    expect(attribution.changedPaths()).toEqual([control])
  })

  it('O2: a turn with no tool calls compares against the snapshot taken before it', () => {
    const { control, entries } = controlFixture()
    const attribution = startTurnWriteAttribution(entries, [control])
    expect(attribution.changedPaths()).toEqual([])
    writeControlRecord(control, 'effects', 'forged.json')
    expect(attribution.changedPaths()).toEqual([control])
  })

  it('O2: only the named driver-written entries are re-baselined after a tool call', async () => {
    const { control, config, entries } = controlFixture()
    const attribution = startTurnWriteAttribution(entries, [control])
    await attribution.driverToolCall(async () => writeFileSync(config, '{"changed":true}'))
    expect(attribution.changedPaths()).toEqual([config])
  })
})

/** Deps whose driver push writes effect and ownership records into the control store, the way the real governed push does. */
function pushWritesControlRecords(world: LoopWorld, base: Partial<LoopDeps>): Partial<LoopDeps> {
  let pushes = 0
  return {
    ...base,
    pushTaskBranch: (input) => {
      pushes += 1
      writeControlRecord(controlDir(world), 'effects', `push-${pushes}.json`)
      writeControlRecord(controlDir(world), 'ownership', `epoch-${pushes}.json`)
      return base.pushTaskBranch!(input)
    }
  }
}

function confinementReasks(world: LoopWorld): number {
  return world.dispatches.filter(
    (d) => d.role === 'developer' && (d.prompt ?? '').includes('protected path(s) changed during this turn')
  ).length
}

describe('the loop’s after-turn check, attributed by tool-call boundary', () => {
  it('O1: a Developer turn whose driver tools wrote control records is not re-asked', async () => {
    const world = makeWorld({ worktreeExists: true })
    const deps = pushWritesControlRecords(world, developerPublishesViaToolsDeps(world))
    const result = await runLoopInProcess(world, { task: world.task, agent: 'claude' }, deps)
    expect(world.pushes.length).toBeGreaterThan(0)
    expect(confinementReasks(world)).toBe(0)
    expect(result.finalDecision).toEqual({ type: 'publish' })
  })

  it('O2: a Developer that writes a control record outside a tool call is re-asked naming the control store', async () => {
    const world = makeWorld({ worktreeExists: true })
    const publishing = pushWritesControlRecords(world, developerPublishesViaToolsDeps(world))
    let forged = false
    await runLoopInProcess(
      world,
      { task: world.task, agent: 'claude' },
      {
        ...publishing,
        dispatchRole: async (role, agent, prompt, opts) => {
          const handle = await publishing.dispatchRole!(role, agent, prompt, opts)
          if (role === 'developer' && !forged) {
            forged = true
            writeControlRecord(controlDir(world), 'effects', 'forged.json')
          }
          return handle
        }
      }
    )
    expect(confinementReasks(world)).toBe(1)
    const reask = world.dispatches.find((d) => (d.prompt ?? '').includes('protected path(s) changed'))
    expect(reask?.prompt).toContain(controlDir(world))
  })

  for (const reviewer of ['code-reviewer', 'security'] as const) {
    it(`O2: a ${reviewer} turn that writes a control record is refused`, async () => {
      const world = makeWorld()
      const base = makeInProcessDeps(world)
      const result = await runLoopInProcess(
        world,
        { task: world.task, agent: 'claude' },
        {
          dispatchRole: async (role, agent, prompt, opts) => {
            const handle = await base.dispatchRole!(role, agent, prompt, opts)
            if (role === reviewer) writeControlRecord(controlDir(world), 'effects', `forged-${reviewer}.json`)
            return handle
          }
        }
      )
      expect(result.finalDecision.type).toBe('pause')
      expect(JSON.stringify(result)).toContain('protected path(s) changed during this turn')
    })
  }
})
