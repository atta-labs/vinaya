import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLAN_DRAFTS_DIRNAME } from '../../../../kernel/run-paths'
import { readStoredPlanDraft, submitPlanDraft } from '../../thinking/planner/tools/planner-operations'
import {
  canonicalDraft,
  draftFingerprint,
  draftFromIssues,
  parsePlanDraft,
  resolveDraftEdges,
  type PlanDraft
} from './draft'
import { draftFilePath, readPlanDraft, writePlanDraft } from './store'

const REVISION = 'a'.repeat(40)

const rationale = (edges: string) => `**Dependency rationale** — ${edges}\n\n**Next** — x`

function draft(over: Partial<PlanDraft> = {}): PlanDraft {
  return {
    schemaVersion: 1,
    tranche: 'sample-plan',
    revision: REVISION,
    reviewQuestionVersion: 'q1',
    tasks: [
      {
        number: 1,
        issue: null,
        title: 'First',
        body: rationale('`Depends-on: —` `Conflicts-with: —`'),
        labels: ['b', 'a']
      },
      {
        number: 2,
        issue: null,
        title: 'Second',
        body: rationale('`Depends-on: 1, #2291` `Conflicts-with: 3`'),
        labels: ['a']
      },
      { number: 3, issue: null, title: 'Third', body: rationale('`Depends-on: 1`'), labels: [] }
    ],
    scope: [
      { item: 'Alpha', disposition: { kind: 'delivered', task: 1 } },
      { item: 'Beta', disposition: { kind: 'left-out', reason: 'later' } }
    ],
    ...over
  }
}

const clone = (d: PlanDraft): PlanDraft => JSON.parse(JSON.stringify(d)) as PlanDraft

describe('draftFingerprint', () => {
  it('gives the same fingerprint for the same draft', () => {
    expect(draftFingerprint(draft())).toBe(draftFingerprint(draft()))
    expect(draftFingerprint(draft())).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('does not change with key order, task order, label order, scope order or line endings', () => {
    const base = draft()
    const reordered = clone(base)
    reordered.tasks.reverse()
    reordered.scope.reverse()
    for (const t of reordered.tasks) t.labels.reverse()
    const keyShuffled = JSON.parse(
      JSON.stringify(reordered, [
        'scope',
        'tasks',
        'labels',
        'body',
        'title',
        'issue',
        'number',
        'item',
        'disposition',
        'kind',
        'task',
        'reason',
        'reviewQuestionVersion',
        'revision',
        'tranche',
        'schemaVersion'
      ])
    ) as PlanDraft
    expect(draftFingerprint(keyShuffled)).toBe(draftFingerprint(base))

    const crlf = clone(base)
    crlf.tasks[0]!.body = crlf.tasks[0]!.body.replace(/\n/g, '\r\n')
    expect(draftFingerprint(crlf)).toBe(draftFingerprint(base))
  })

  it('changes with one character of a task body, title or label', () => {
    const base = draftFingerprint(draft())
    const body = clone(draft())
    body.tasks[2]!.body += '.'
    const title = clone(draft())
    title.tasks[0]!.title = 'Firsts'
    const labels = clone(draft())
    labels.tasks[1]!.labels = ['b']
    for (const changed of [body, title, labels]) expect(draftFingerprint(changed)).not.toBe(base)
  })

  it('changes with the task list, the scope, the revision and the review question version', () => {
    const base = draftFingerprint(draft())
    const fewer = clone(draft())
    fewer.tasks = fewer.tasks.slice(0, 2)
    fewer.scope = [fewer.scope[1]!]
    const renumbered = clone(draft())
    renumbered.tasks[2]!.number = 4
    const scope = clone(draft())
    scope.scope[1] = { item: 'Beta', disposition: { kind: 'delivered', task: 2 } }
    const revision = clone(draft())
    revision.revision = 'b'.repeat(40)
    const question = clone(draft())
    question.reviewQuestionVersion = 'q2'
    for (const changed of [fewer, renumbered, scope, revision, question]) {
      expect(draftFingerprint(changed)).not.toBe(base)
    }
  })

  it('serializes in one fixed order', () => {
    expect(canonicalDraft(draft())).toBe(canonicalDraft(clone(draft())))
    expect(canonicalDraft(draft()).startsWith('{"reviewQuestionVersion":"q1","revision":')).toBe(true)
  })
})

describe('parsePlanDraft', () => {
  it('accepts a whole draft', () => {
    expect(parsePlanDraft(draft()).ok).toBe(true)
  })

  it('refuses a duplicate task number, an unheld delivering task, a short revision and an unknown key', () => {
    const dup = clone(draft())
    dup.tasks[1]!.number = 1
    expect(parsePlanDraft(dup).ok).toBe(false)
    const missing = clone(draft())
    missing.scope[0] = { item: 'Alpha', disposition: { kind: 'delivered', task: 9 } }
    expect(parsePlanDraft(missing).ok).toBe(false)
    expect(parsePlanDraft({ ...draft(), revision: 'abc' }).ok).toBe(false)
    expect(parsePlanDraft({ ...draft(), extra: 1 }).ok).toBe(false)
    expect(parsePlanDraft('nope').ok).toBe(false)
  })
})

describe('draftFromIssues', () => {
  const issue = (number: number, title: string, body = 'Body') => ({ number, title, body, labels: ['x'] })

  it("builds a draft from a tranche's task Issues, keeping each Issue number beside its task number", () => {
    const r = draftFromIssues({
      tranche: 'sample-plan',
      revision: REVISION,
      reviewQuestionVersion: 'q1',
      issues: [
        issue(2302, '[sample-plan] 2 — Second', rationale('`Depends-on: 1`')),
        issue(2301, '[sample-plan] 1 — First')
      ]
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.draft.tasks.map((t) => [t.number, t.issue, t.title])).toEqual([
      [1, 2301, 'First'],
      [2, 2302, 'Second']
    ])
    expect(readbackEqual(r.draft)).toBe(true)
  })

  it('builds a one-task draft from one standalone Issue', () => {
    const r = draftFromIssues({
      tranche: 'solo',
      revision: REVISION,
      reviewQuestionVersion: 'q1',
      issues: [issue(77, 'A plain title')]
    })
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.draft.tasks).toEqual([{ number: 1, issue: 77, title: 'A plain title', body: 'Body', labels: ['x'] }])
  })

  it('refuses an Issue of another tranche or with a lettered task id', () => {
    const base = { tranche: 'sample-plan', revision: REVISION, reviewQuestionVersion: 'q1' }
    expect(draftFromIssues({ ...base, issues: [issue(1, '[other] 1 — A'), issue(2, '[sample-plan] 2 — B')] }).ok).toBe(
      false
    )
    expect(
      draftFromIssues({ ...base, issues: [issue(1, '[sample-plan] 7a — A'), issue(2, '[sample-plan] 2 — B')] }).ok
    ).toBe(false)
  })
})

function readbackEqual(d: PlanDraft): boolean {
  const again = parsePlanDraft(JSON.parse(JSON.stringify(d)))
  return again.ok && draftFingerprint(again.draft) === draftFingerprint(d)
}

describe('resolveDraftEdges', () => {
  it('resolves bare numbers inside the draft and keeps `#<n>` a published Issue', () => {
    const edges = resolveDraftEdges(draft())
    const second = edges.find((e) => e.task === 2)!
    expect(second.dependsOnTasks).toEqual([1])
    expect(second.dependsOnIssues).toEqual([2291])
    expect(second.conflictsWithTasks).toEqual([3])
    expect(second.unknownTasks).toEqual([])
  })

  it('never reads task 5 and Issue #5 as the same edge', () => {
    const d = clone(draft())
    d.tasks[0]!.body = rationale('`Depends-on: 5, #5`')
    const first = resolveDraftEdges(d).find((e) => e.task === 1)!
    expect(first.dependsOnTasks).toEqual([5])
    expect(first.dependsOnIssues).toEqual([5])
    expect(first.unknownTasks).toEqual([5])
  })

  it('sets a cross-tranche edge apart', () => {
    const d = clone(draft())
    d.tasks[0]!.body = rationale('`Depends-on: other-plan 4`')
    expect(resolveDraftEdges(d).find((e) => e.task === 1)!.otherTranche).toEqual(['other-plan 4'])
  })
})

describe('the draft store', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plan-draft-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('keeps one draft per tranche slug and replaces it on resubmission', () => {
    const first = draft()
    writePlanDraft(dir, first)
    expect(readPlanDraft(dir, 'sample-plan')).toEqual(first)

    const second = clone(first)
    second.reviewQuestionVersion = 'q2'
    writePlanDraft(dir, second)
    expect(readPlanDraft(dir, 'sample-plan')?.reviewQuestionVersion).toBe('q2')

    writePlanDraft(dir, draft({ tranche: 'other-plan' }))
    expect(readPlanDraft(dir, 'sample-plan')?.reviewQuestionVersion).toBe('q2')
    expect(readPlanDraft(dir, 'other-plan')?.reviewQuestionVersion).toBe('q1')
    expect(readPlanDraft(dir, 'absent')).toBeNull()
  })

  it('stores under the run folder in a plan scope, with fixed key order', () => {
    const file = writePlanDraft(dir, draft())
    expect(file).toBe(draftFilePath(dir, 'sample-plan'))
    expect(file).toBe(join(dir, PLAN_DRAFTS_DIRNAME, 'sample-plan', 'draft.json'))
    const text = readFileSync(file, 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(Object.keys(JSON.parse(text))).toEqual([
      'reviewQuestionVersion',
      'revision',
      'schemaVersion',
      'scope',
      'tasks',
      'tranche'
    ])
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false)
  })

  it('refuses a slug that is not a safe path segment', () => {
    expect(() => draftFilePath(dir, '../escape')).toThrow()
  })

  it('submits and reads back through the planner operations, fingerprint included', () => {
    const out = submitPlanDraft(draft(), dir)
    expect(out).toEqual({ ok: true, tranche: 'sample-plan', fingerprint: draftFingerprint(draft()), tasks: 3 })
    const read = readStoredPlanDraft('sample-plan', dir)
    expect(read.ok && read.fingerprint).toBe(draftFingerprint(draft()))
    expect(readStoredPlanDraft('nothing', dir).ok).toBe(false)
    expect(readStoredPlanDraft('../x', dir).ok).toBe(false)
    expect(submitPlanDraft({ tranche: 'x' }, dir).ok).toBe(false)
  })
})
