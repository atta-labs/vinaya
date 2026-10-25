import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { takeDriverLock } from '../../../../processes/vinaya/bin/run-lifecycle.js'
import { runDirectory, type Agent } from '../../../../processes/vinaya/bin/run-engine.js'
import { shadowRecordPath, type ShadowRecord } from '../../../../processes/vinaya/executing/shadow.js'
import { readDriverLock } from '../../src/lib/dev-review-loop/pause-resume.js'
import type { Observation } from './dev-review-current-loop-adapter.js'
import { ENGINE_SCENARIO_DRIVERS, ENGINE_SCENARIO_TASK, runEngineScenario } from './dev-review-engine-loop-adapter.js'
import corpus from '../fixtures/dev-review-engine-scenarios.json'

/**
 * Shadow mode on the Engine backend: the evidence for fault-attack:29-shadow-mode-mutation and
 * cutover-gate:gate-9 (shadow mode cannot mutate).
 *
 * Every scenario of the behavioural corpus runs twice on each stub vendor, through the same adapter and the same
 * fake forge: once live, where the forge-fake ledger records the effects the scenario expects, and once in shadow
 * mode (`runShadowEngine`), where the ledger records no commit, push, pull-request open, published round or marked
 * comment. The shadow run still dispatches the Developer and both reviewers and runs the gates, and writes its
 * decision and refused-attempt list to its own runtime directory, beside a live run whose directory and driver
 * lock it never touches.
 */

const AGENTS: readonly Agent[] = ['claude', 'codex']
const SCENARIOS = Object.keys(ENGINE_SCENARIO_DRIVERS)
const LIVE_LOCK_TOKEN = 'the-live-run'

type EffectExpectation = Partial<Record<keyof Observation['effects'], unknown>> & {
  markersInclude?: string[]
  markersExclude?: string[]
}
const expectations = new Map(
  (corpus as { scenarios: { id: string; expect: { effects?: EffectExpectation } }[] }).scenarios.map((scenario) => [
    scenario.id,
    scenario.expect.effects ?? {}
  ])
)

interface ShadowInspection {
  record: ShadowRecord | null
  /** The record's path inside the shadow run's runtime directory. */
  recordPath: string
  actionNodes: string[]
}

interface Pair {
  id: string
  agent: Agent
  live: Observation
  shadow: Observation
  inspection: ShadowInspection | null
}

const pairs: Pair[] = []
let liveRuntimeDir = ''
let liveFilesBefore: string[] = []

const listing = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: false } as never)
    .map(String)
    .sort()

beforeAll(async () => {
  // The live run beside every shadow run: its own runtime directory, its driver lock held.
  liveRuntimeDir = mkdtempSync(join(tmpdir(), 'engine-live-runtime-'))
  const lock = takeDriverLock(liveRuntimeDir, ENGINE_SCENARIO_TASK, {
    pid: process.pid,
    now: () => new Date(),
    isPidAlive: () => true,
    token: LIVE_LOCK_TOKEN,
    narrate: () => {}
  })
  if (!lock.acquired) throw new Error('the live run could not take its driver lock')
  liveFilesBefore = listing(liveRuntimeDir)
  for (const id of SCENARIOS) {
    for (const agent of AGENTS) {
      const live = await runEngineScenario(id, agent)
      let inspection: ShadowInspection | null = null
      const shadow = await runEngineScenario(
        id,
        agent,
        undefined,
        ({ runtimeDir, task }) => {
          const path = shadowRecordPath(runDirectory(runtimeDir, task))
          const actions = join(runtimeDir, 'actions.jsonl')
          inspection = {
            record: existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as ShadowRecord) : null,
            recordPath: relative(runtimeDir, path),
            actionNodes: existsSync(actions)
              ? readFileSync(actions, 'utf8')
                  .split('\n')
                  .filter(Boolean)
                  .map((line) => String((JSON.parse(line) as { node?: unknown }).node))
              : []
          }
        },
        { liveRuntimeDir }
      )
      pairs.push({ id, agent, live, shadow, inspection })
    }
  }
}, 900_000)

afterAll(() => {
  if (liveRuntimeDir !== '') rmSync(liveRuntimeDir, { recursive: true, force: true })
})

const pairsOf = (id: string) => pairs.filter((pair) => pair.id === id)

describe('fault-attack:29-shadow-mode-mutation — a shadow run makes zero forge effects', () => {
  it('runs every corpus scenario on both stub vendors, live and in shadow mode', () => {
    expect(SCENARIOS.length).toBeGreaterThan(0)
    expect(pairs.length).toBe(SCENARIOS.length * AGENTS.length)
  })

  it('records no commit, push, pull-request open, published round or marked comment in shadow mode', () => {
    for (const { id, agent, shadow } of pairs)
      expect({ id, agent, effects: shadow.effects }).toEqual({
        id,
        agent,
        effects: {
          ...shadow.effects,
          publishedRounds: [],
          markers: [],
          commits: 0,
          pushes: 0,
          prOpens: 0
        }
      })
  })

  it('records the effects each scenario expects when the same scenario runs live', () => {
    let published = 0
    for (const { id, agent, live } of pairs) {
      const expected = expectations.get(id) ?? {}
      for (const key of ['publishedRounds', 'commits', 'pushes', 'prOpens'] as const)
        if (expected[key] !== undefined)
          expect({ id, agent, key, value: live.effects[key] as unknown }).toEqual({
            id,
            agent,
            key,
            value: expected[key]
          })
      for (const marker of expected.markersInclude ?? [])
        expect({ id, agent, marker, present: live.effects.markers.includes(marker) }).toEqual({
          id,
          agent,
          marker,
          present: true
        })
      for (const marker of expected.markersExclude ?? [])
        expect({ id, agent, marker, present: live.effects.markers.includes(marker) }).toEqual({
          id,
          agent,
          marker,
          present: false
        })
      published += live.effects.publishedRounds.length
    }
    // The live corpus does publish: the shadow run's empty ledger is the refusal, not a corpus that never writes.
    expect(published).toBeGreaterThan(0)
  })
})

describe('cutover-gate:gate-9 — shadow mode cannot mutate, and still does the work', () => {
  it('dispatches every role the live run dispatches', () => {
    for (const { id, agent, live, shadow } of pairs)
      for (const role of ['developerDispatches', 'codeReviewerDispatches', 'securityDispatches'] as const)
        if (live.effects[role] > 0)
          expect({ id, agent, role, dispatched: shadow.effects[role] > 0 }).toEqual({
            id,
            agent,
            role,
            dispatched: true
          })
  })

  it('runs the gates, decides the round, and writes its decision and refused attempts to its own runtime directory', () => {
    for (const { agent, shadow, inspection } of pairsOf('clean-completion')) {
      expect(shadow.effects.developerDispatches).toBe(1)
      expect(shadow.effects.codeReviewerDispatches).toBe(1)
      expect(shadow.effects.securityDispatches).toBe(1)
      expect(inspection?.actionNodes).toContain('run-mechanical-gates')
      expect(inspection?.recordPath).toBe(join('engine-runs', String(ENGINE_SCENARIO_TASK), 'shadow.json'))
      const record = inspection?.record
      expect({ agent, decision: record?.decision, outcome: record?.outcome }).toEqual({
        agent,
        decision: { type: 'publish' },
        outcome: 'completed'
      })
      const refused = (record?.refused ?? []).map((attempt) => `${attempt.registry}:${attempt.name}`)
      expect(refused).toContain('bound:postMarkedComment')
      expect(refused).toContain('bound:publishRound')
    }
  })

  it('records a refused attempt for every effect the live run of the scenario made', () => {
    for (const { id, agent, live, inspection } of pairs) {
      if (inspection === null) continue
      const refused = new Set((inspection.record?.refused ?? []).map((attempt) => attempt.name))
      if (live.effects.publishedRounds.length > 0)
        expect({ id, agent, refused: refused.has('publishRound') }).toEqual({ id, agent, refused: true })
      if (live.effects.commits > 0)
        expect({ id, agent, refused: refused.has('publishChanges') }).toEqual({ id, agent, refused: true })
    }
  })

  it('leaves the live run’s runtime directory and driver lock as they were', () => {
    expect(listing(liveRuntimeDir)).toEqual(liveFilesBefore)
    expect(readDriverLock(liveRuntimeDir, ENGINE_SCENARIO_TASK)?.token).toBe(LIVE_LOCK_TOKEN)
  })
})
