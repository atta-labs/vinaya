import { describe, expect, test } from 'bun:test'
import type {
  FeedLine,
  ReviewerVerdict,
  RoundPicture,
  TaskPicture
} from '../../../../harness/processes/vinaya-strict/tools/mission-control/picture.ts'
import {
  parseServerMessage,
  REVIEWER_ROLES_MAX,
  STORY_ID_PATTERN,
  STORY_PER_TASK_MAX,
  TEXT_MAX
} from '../lib/mission-control-protocol.ts'
import type { RepositorySnapshot } from './picture-service.ts'
import { repositoryView, storyId, taskView } from './projection.ts'

export const SENTINELS = {
  finding: 'SENTINEL-FINDING-TEXT-9f3',
  reasoning: 'SENTINEL-REASONING-71c',
  path: '/Users/secret-person/SENTINEL-PATH',
  header: 'Bearer SENTINEL-CREDENTIAL-HEADER',
  secret: 'SENTINEL-BOOTSTRAP-SECRET-u8q',
  runId: 'run-SENTINEL-RUN-ID:42',
  feed: 'SENTINEL-FEED-LINE'
}

/** Machine is a deliberately permitted display field, so it is not a sentinel: its own test asserts it. */
const MACHINE = 'build-box-3'

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
    attentionSince: null,
    feed: [
      {
        id: SENTINELS.runId,
        position: 1,
        at: 1,
        kind: 'information',
        text: 'Round 1 started.',
        personNeeded: false,
        command: null
      }
    ],
    tokens: { developer: { input: 5, output: 6, unknownTurns: 0 } },
    model: 'opus',
    models: { developer: 'opus' },
    machine: MACHINE,
    reviewerRoles: ['code-reviewer'],
    loopIds: ['loop-1'],
    signals: { pause: null, handoff: null, stop: null, endedReady: false, exit: null, wait: null },
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
    expect(wire).not.toContain('loopIds')
    expect(wire).not.toContain('signals')
    expect(wire).not.toContain('severities')
  })

  test('a task keeps the fields the board and detail need', () => {
    const view = taskView(internalTask())
    expect(view).toMatchObject({ task: 7, state: 'running', pr: 12, model: 'opus', whoActs: 'the loop' })
    expect(view.rounds[0]).toMatchObject({ n: 1, confidence: 80, checksGreen: true })
    expect(view.rounds[0]?.findings).toEqual({ blocking: 1, nonBlocking: 2, unclassified: 0 })
    expect(view.rounds[0]?.reviewers[0]).toEqual({
      role: 'code-reviewer',
      outcome: 'changes_requested',
      blocking: 1,
      shared: false
    })
  })

  test('the recorded machine and reviewer roles are carried; a missing machine is unknown, never invented', () => {
    expect(taskView(internalTask())).toMatchObject({ machine: MACHINE, reviewerRoles: ['code-reviewer'] })
    expect(taskView(internalTask({ machine: null, reviewerRoles: [] }))).toMatchObject({
      machine: null,
      reviewerRoles: []
    })
  })

  test('own and shared changes-requested verdicts keep their attribution on the wire', () => {
    const base = internalTask().rounds[0] as RoundPicture
    const reviewers: ReviewerVerdict[] = [
      { role: 'code-reviewer', outcome: 'changes_requested', blocking: 1, findings: null, shared: true },
      { role: 'security', outcome: 'changes_requested', blocking: null, findings: null, shared: true },
      {
        role: 'tests',
        outcome: 'changes_requested',
        blocking: 2,
        findings: { blocking: 2, nonBlocking: 0, unclassified: 0, severities: {} },
        shared: false
      }
    ]
    const view = taskView(internalTask({ rounds: [{ ...base, reviewers }] }))
    expect(view.rounds[0]?.reviewers.map((r) => [r.role, r.shared])).toEqual([
      ['code-reviewer', true],
      ['security', true],
      ['tests', false]
    ])
    // The flag is the reading's own; it is never inferred from how many reviewers there are.
    const alone = taskView(internalTask({ rounds: [{ ...base, reviewers: [reviewers[2] as ReviewerVerdict] }] }))
    expect(alone.rounds[0]?.reviewers[0]?.shared).toBe(false)
  })

  test('the attention start is carried as the reading holds it, and unknown stays null', () => {
    expect(taskView(internalTask({ state: 'needs_you', attentionSince: 5000 })).attentionSince).toBe(5000)
    expect(taskView(internalTask({ state: 'needs_you', attentionSince: null })).attentionSince).toBeNull()
    expect(taskView(internalTask({ attentionSince: 0 })).attentionSince).toBeNull()
  })

  test('a story entry carries an opaque, replay-stable identity, its time, kind, text, classification and its own command', () => {
    const feed: FeedLine[] = [
      {
        id: 'run-A:1',
        position: 4,
        at: 111,
        kind: 'blocked',
        text: 'The loop paused for a person: the round limit was reached.',
        personNeeded: true,
        command: null
      },
      {
        id: 'run-A:2',
        position: 9,
        at: 0,
        kind: 'working',
        text: 'The developer is working.',
        personNeeded: false,
        command: 'vinaya pr rule 5 --file <ruling.md>'
      }
    ]
    const first = taskView(internalTask({ feed })).story
    // A reconnect re-projects the same task at other positions: the identity is the source event's, not the position's.
    const again = taskView(internalTask({ feed: feed.map((f) => ({ ...f, position: f.position + 1000 })) })).story
    expect(first.map((s) => s.id)).toEqual(again.map((s) => s.id))
    expect(new Set(first.map((s) => s.id)).size).toBe(2)
    for (const entry of first) expect(entry.id).toMatch(STORY_ID_PATTERN)
    expect(JSON.stringify(first)).not.toContain('run-A')
    expect(first[0]).toMatchObject({ at: 111, kind: 'blocked', personNeeded: true, command: null })
    expect(first[1]).toMatchObject({ at: null, personNeeded: false, command: 'vinaya pr rule 5 --file <ruling.md>' })
    expect(Object.keys(first[0] as object).sort()).toEqual(['at', 'command', 'id', 'kind', 'personNeeded', 'text'])
  })

  test('the story is bounded to the newest entries and every text is bounded', () => {
    const feed: FeedLine[] = Array.from({ length: STORY_PER_TASK_MAX + 7 }, (_, i) => ({
      id: `e${i}`,
      position: i + 1,
      at: i + 1,
      kind: 'information',
      text: 'x'.repeat(TEXT_MAX * 2),
      personNeeded: false,
      command: 'c'.repeat(TEXT_MAX * 2)
    }))
    const story = taskView(internalTask({ feed })).story
    expect(story).toHaveLength(STORY_PER_TASK_MAX)
    expect(story.at(-1)?.id).toBe(storyId(`e${STORY_PER_TASK_MAX + 6}`))
    for (const s of story) {
      expect(s.text.length).toBeLessThanOrEqual(TEXT_MAX)
      expect((s.command ?? '').length).toBeLessThanOrEqual(TEXT_MAX)
    }
    const roles = Array.from({ length: REVIEWER_ROLES_MAX + 5 }, (_, i) => `role-${i}`)
    expect(taskView(internalTask({ reviewerRoles: roles })).reviewerRoles).toHaveLength(REVIEWER_ROLES_MAX)
  })

  test('the wire shape of a projected task passes the protocol check, so the page and server agree', () => {
    const message = JSON.stringify({
      v: 1,
      type: 'task',
      generation: 1,
      repository: 'r1',
      task: taskView(internalTask({ state: 'needs_you', attentionSince: 99 }))
    })
    expect(parseServerMessage(message)).not.toBeNull()
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
