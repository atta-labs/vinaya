import { describe, expect, test } from 'bun:test'
import type { TaskPicture } from '../../../../harness/processes/vinaya-strict/tools/mission-control/picture.ts'
import { TEXT_MAX } from '../lib/mission-control-protocol.ts'
import type { RepositorySnapshot } from './picture-service.ts'
import { repositoryView, taskView } from './projection.ts'

export const SENTINELS = {
  finding: 'SENTINEL-FINDING-TEXT-9f3',
  reasoning: 'SENTINEL-REASONING-71c',
  path: '/Users/secret-person/SENTINEL-PATH',
  header: 'Bearer SENTINEL-CREDENTIAL-HEADER',
  secret: 'SENTINEL-BOOTSTRAP-SECRET-u8q',
  machine: 'SENTINEL-MACHINE-NAME',
  feed: 'SENTINEL-FEED-LINE'
}

export function internalTask(over: Partial<TaskPicture> = {}): TaskPicture {
  return {
    task: 7,
    title: 'A task',
    state: 'running',
    amber: false,
    reason: null,
    decision: null,
    rounds: [
      {
        n: 1,
        startedAt: 10,
        endedAt: null,
        wallMs: null,
        outcome: null,
        checksGreen: true,
        agents: { developer: 'working' },
        confidence: { value: 80, unavailable: false, extraTurnSpent: false },
        reviewers: [
          {
            role: 'code-reviewer',
            outcome: 'changes_requested',
            blocking: 1,
            findings: { blocking: 1, nonBlocking: 0, unclassified: 0, severities: { high: 1 } },
            shared: false
          }
        ],
        findings: { blocking: 1, nonBlocking: 2, unclassified: 0, severities: { high: 1 } }
      }
    ],
    pr: 12,
    nowLine: 'Round 1 is running',
    lastSign: 1234,
    whoActs: 'the loop',
    command: null,
    feed: [{ position: 1, at: 1, kind: 'information', text: SENTINELS.feed }],
    tokens: { developer: { input: 5, output: 6, unknownTurns: 0 } },
    model: 'opus',
    models: { developer: 'opus' },
    machine: SENTINELS.machine,
    reviewerRoles: ['code-reviewer'],
    loopIds: ['loop-1'],
    signals: { pause: null, handoff: null, stop: null, endedReady: false, exit: null },
    gateReads: {
      '1': {
        findings: [{ text: SENTINELS.finding, reasoning: SENTINELS.reasoning, file: SENTINELS.path }],
        authorization: SENTINELS.header,
        token: SENTINELS.secret
      }
    },
    ...over
  }
}

export function snapshotOf(tasks: TaskPicture[], over: Partial<RepositorySnapshot> = {}): RepositorySnapshot {
  return {
    repository: SENTINELS.path,
    remote: 'acme/widgets',
    sourceKind: 'server',
    status: { live: true, connection: 'live', reason: null },
    coverage: { startPosition: SENTINELS.secret, complete: true, limits: [] },
    picture: { now: 1, readThrough: 5, skipped: 0, repeated: 0, tasks, loops: { 'loop-1': 7 } },
    partialTasks: [],
    chronologyLimitedTasks: [],
    diagnostics: {
      applied: 1,
      duplicates: 0,
      unreadable: 0,
      heldBack: 0,
      identities: 1,
      bootstrapBytes: 1,
      sequence: 1,
      lastAppliedPosition: SENTINELS.secret
    },
    ...over
  }
}

describe('projection', () => {
  test('a task carries presentation fields and no sentinel from any internal field', () => {
    const wire = JSON.stringify(taskView(internalTask()))
    for (const sentinel of Object.values(SENTINELS)) expect(wire).not.toContain(sentinel)
    expect(wire).not.toContain('gateReads')
    expect(wire).not.toContain('feed')
    expect(wire).not.toContain('machine')
    expect(wire).not.toContain('loopIds')
    expect(wire).not.toContain('severities')
  })

  test('a task keeps the fields the board and detail need', () => {
    const view = taskView(internalTask())
    expect(view).toMatchObject({ task: 7, state: 'running', pr: 12, model: 'opus', whoActs: 'the loop' })
    expect(view.rounds[0]).toMatchObject({ n: 1, confidence: 80, checksGreen: true })
    expect(view.rounds[0]?.findings).toEqual({ blocking: 1, nonBlocking: 2, unclassified: 0 })
    expect(view.rounds[0]?.reviewers[0]).toEqual({ role: 'code-reviewer', outcome: 'changes_requested', blocking: 1 })
  })

  test('a repository is named by an opaque id; its root, start position and diagnostics never appear', () => {
    const wire = JSON.stringify(repositoryView('r1', snapshotOf([internalTask()])))
    for (const sentinel of Object.values(SENTINELS)) expect(wire).not.toContain(sentinel)
    expect(wire).toContain('"id":"r1"')
    expect(wire).toContain('acme/widgets')
    expect(wire).not.toContain('diagnostics')
  })

  test('coverage limits and connection state are carried so a partial picture is never read as live', () => {
    const view = repositoryView(
      'r1',
      snapshotOf([], {
        status: { live: false, connection: 'reconnecting', reason: 'the source dropped' },
        coverage: {
          startPosition: null,
          complete: false,
          limits: [{ kind: 'opening-limited', detail: 'started late' }]
        }
      })
    )
    expect(view.status).toEqual({ live: false, connection: 'reconnecting', reason: 'the source dropped' })
    expect(view.coverage.complete).toBe(false)
    expect(view.coverage.limits).toEqual([{ kind: 'opening-limited', detail: 'started late' }])
  })

  test('long text is bounded', () => {
    const view = taskView(internalTask({ nowLine: 'x'.repeat(TEXT_MAX * 3) }))
    expect(view.nowLine.length).toBeLessThanOrEqual(TEXT_MAX)
  })
})
