import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type DraftCheckDeps, checkDraft, checkScopeCoverage } from './check'
import type { PlanDraft } from './draft'

const sh = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** A `gh` on `PATH` that answers only the Principal read, as the render's trust anchor needs. */
function servePrincipalsConfig(): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-check-gh-'))
  const config = Buffer.from(JSON.stringify({ principals: ['daniboomerang'] })).toString('base64')
  writeFileSync(
    join(dir, 'gh'),
    `#!/bin/sh\nif [ "$1" = "api" ] && [ "\${2#*contents/vinaya.config.json}" != "$2" ]; then echo '${config}'; exit 0; fi\nexit 1\n`
  )
  execFileSync('chmod', ['+x', join(dir, 'gh')])
  const path = process.env.PATH
  process.env.PATH = `${dir}:${path ?? ''}`
  return () => {
    process.env.PATH = path
    rmSync(dir, { recursive: true, force: true })
  }
}

const PINNED = ['src/a.ts', 'src/b.ts', 'src/c.ts']

function taskBody(o: { depends?: string; conflicts?: string; premise?: string; pins?: string[] } = {}): string {
  const pins = (o.pins ?? PINNED).map((p) => `\`${p}\``).join(', ')
  return [
    '**Project:** cli',
    '',
    '## Objectives',
    '',
    'O1. The fixture is graded as part of its draft.',
    '',
    '## Documentation',
    '',
    'None.',
    '',
    '## Surface',
    '',
    'in: src',
    'out: —',
    '',
    ...(o.premise ? ['## Premises', '', o.premise, ''] : []),
    '## Parts',
    '',
    'Part 1 (O1) — proves the draft is graded.',
    '',
    '## Test plan',
    '',
    '```',
    'bun test src/a.test.ts → passes: the fixture is graded as part of its draft (O1)',
    '```',
    '',
    '## Stop conditions',
    '',
    '- None.',
    '',
    "## Task Issue — Planner's rationale",
    '',
    `**Boundary** — In: ${pins}, the fixture's own committed source. Out: nothing.`,
    '',
    '**Sizing** — n/a, test fixture.',
    '',
    '**Project(s) + blast radius** — `Project: cli`. No shared-primitive fan-out.',
    '',
    `**Dependency rationale** — \`Depends-on: ${o.depends ?? '—'}\`; \`Conflicts-with: ${o.conflicts ?? '—'}\`.`,
    '',
    '**Traps to avoid** — n/a.',
    '',
    '**Suggested agent-class** — fast — test fixture.',
    '',
    '**Stop-and-escalate** — n/a.',
    '',
    '**Docs to keep coherent** — no-doc-surface.'
  ].join('\n')
}

type Bodies = Parameters<typeof taskBody>[0][]

const draftOf = (revision: string, tasks: Bodies, scope: PlanDraft['scope'] = []): PlanDraft => ({
  schemaVersion: 1,
  tranche: 'sample-plan',
  revision,
  reviewQuestionVersion: 'q1',
  tasks: tasks.map((t, i) => ({ number: i + 1, issue: null, title: `Task ${i + 1}`, body: taskBody(t), labels: [] })),
  scope
})

/** The write gate's groups that need live forge state, replaced by nothing published. */
const OFFLINE: DraftCheckDeps = {
  milestoneSource: null,
  gate: { runIssueChecks: async () => [] },
  readPeers: () => ({ ok: true, value: { peers: [], capHit: false } })
}

const checksOf = (xs: readonly { check: string }[]) => xs.map((x) => x.check)

describe('the draft check', () => {
  let root = ''
  let revision = ''
  let restore: () => void = () => {}
  let before = ''
  let repo: string | undefined
  let github: string | undefined

  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'vinaya-check-fixture-'))
    root = tmp
    const remote = join(tmp, 'remote')
    const local = join(tmp, 'local')
    mkdirSync(join(remote, 'src'), { recursive: true })
    sh(tmp, ['init', '-q', '-b', 'main', remote])
    sh(remote, ['config', 'user.email', 'a@example.com'])
    sh(remote, ['config', 'user.name', 'A'])
    for (const f of ['a', 'b', 'c', 'd']) writeFileSync(join(remote, 'src', `${f}.ts`), `export const ${f} = 1\n`)
    writeFileSync(join(remote, 'src', 'a.test.ts'), 'export {}\n')
    sh(remote, ['add', '.'])
    sh(remote, ['commit', '-q', '-m', 'seed'])
    sh(tmp, ['clone', '-q', remote, local])
    revision = sh(local, ['rev-parse', 'HEAD'])
    before = process.cwd()
    repo = process.env.VINAYA_REPO
    github = process.env.GITHUB_REPOSITORY
    restore = servePrincipalsConfig()
    process.chdir(local)
    process.env.VINAYA_REPO = 'test-owner/test-repo'
    process.env.GITHUB_REPOSITORY = 'test-owner/test-repo'
  })

  afterEach(() => {
    process.chdir(before)
    restore()
    if (repo === undefined) delete process.env.VINAYA_REPO
    else process.env.VINAYA_REPO = repo
    if (github === undefined) delete process.env.GITHUB_REPOSITORY
    else process.env.GITHUB_REPOSITORY = github
    rmSync(root, { recursive: true, force: true })
  })

  it('reports a missing conflict, a dangling edge, a cycle and an unproduced deferred fact in one draft of three tasks', async () => {
    const draft = draftOf(revision, [
      { depends: '3' }, // 1 → 3 → 1 is a cycle; shares three files with task 2 and declares nothing
      { depends: '9', premise: 'after task 3: `src/a.ts` contains `export const later = 1`', pins: PINNED },
      { depends: '1', pins: ['src/d.ts'] }
    ])
    const report = await checkDraft(draft, OFFLINE)

    expect(report.blocking).toBe(true)
    const cross = report.cross
    expect(
      cross.some(
        (e) => e.check === 'plan-draft-collision' && e.message.includes('task 1') && e.message.includes('task 2')
      )
    ).toBe(true)
    expect(
      cross.some((e) => e.check === 'plan-draft-edges' && e.message.includes('task 2') && e.message.includes('task 9'))
    ).toBe(true)
    expect(
      cross.some((e) => e.check === 'plan-draft-cycle' && e.message.includes('task 1') && e.message.includes('task 3'))
    ).toBe(true)
    expect(
      cross.some(
        (e) =>
          e.check === 'plan-draft-deferred-fact' &&
          e.message.includes('task 2') &&
          e.message.includes('task 3') &&
          e.message.includes('Depends-on: 3')
      )
    ).toBe(true)
    expect(cross.every((e) => e.agent_recovery_prompt.length > 0)).toBe(true)
    // The write gate ran for every task.
    expect(report.tasks.map((t) => t.task)).toEqual([1, 2, 3])
  })

  it('names a deferral to a task the draft does not hold', async () => {
    const draft = draftOf(revision, [
      { premise: 'after task 7: `src/a.ts` contains `export const later = 1`', pins: ['src/d.ts'] }
    ])
    const report = await checkDraft(draft, OFFLINE)
    expect(report.cross.some((e) => e.check === 'plan-draft-deferred-fact' && e.message.includes('task 7'))).toBe(true)
  })

  it('accepts a declared conflict, a resolvable edge and a produced deferred fact', async () => {
    const draft = draftOf(revision, [
      { conflicts: '2' },
      { premise: 'after task 3: `src/d.ts` contains `export const later = 1`', depends: '3' },
      { pins: ['src/d.ts'] }
    ])
    const report = await checkDraft(draft, OFFLINE)
    expect(report.cross.filter((e) => e.severity !== 'warning')).toEqual([])
    expect(report.coverage).toEqual([])
  })

  it('runs the write gate on each task with the draft as its siblings: no edge to a draft task is unresolvable', async () => {
    const draft = draftOf(revision, [{ pins: ['src/d.ts'] }, { depends: '1', pins: ['src/c.ts'] }])
    const report = await checkDraft(draft, OFFLINE)
    const second = report.tasks.find((t) => t.task === 2)
    expect(second?.findings.filter((e) => e.severity !== 'warning').map((e) => e.message)).toEqual([])
  })

  it('compares with open published tasks and pull requests, and keeps a published Issue apart from a task of the same number', async () => {
    const published = {
      ok: true as const,
      value: {
        capHit: false,
        peers: [{ ref: '2', label: 'task Issue #2', files: PINNED, conflictsWith: [] as string[] }]
      }
    }
    // Task 1 names task 2 of the draft in `Conflicts-with: 2`; that must not exempt the published Issue #2.
    const asTask = draftOf(revision, [{ conflicts: '2', pins: PINNED }, { pins: ['src/d.ts'] }])
    const refused = await checkDraft(asTask, { ...OFFLINE, readPeers: () => published })
    const collision = (r: typeof refused) =>
      r.tasks.flatMap((t) => t.findings).filter((e) => e.severity !== 'warning' && e.message.includes('file collision'))
    expect(collision(refused).some((e) => e.message.includes('task Issue #2'))).toBe(true)

    // `Conflicts-with: #2` does name the published Issue.
    const asIssue = draftOf(revision, [{ conflicts: '#2', pins: PINNED }, { pins: ['src/d.ts'] }])
    const exempt = await checkDraft(asIssue, { ...OFFLINE, readPeers: () => published })
    expect(collision(exempt)).toEqual([])
  })

  it('does not compare a published task with the draft task it was published as', async () => {
    const draft = draftOf(revision, [{ pins: PINNED }])
    ;(draft.tasks[0] as { issue: number | null }).issue = 41
    const report = await checkDraft(draft, {
      ...OFFLINE,
      readPeers: () => ({
        ok: true,
        value: { capHit: false, peers: [{ ref: '41', label: 'task Issue #41', files: PINNED, conflictsWith: [] }] }
      })
    })
    expect(report.tasks[0]?.findings.some((e) => e.message.includes('#41'))).toBe(false)
  })

  it('is a finding, not a fall back to the working tree, when the revision is unknown', async () => {
    const report = await checkDraft(draftOf('c'.repeat(40), [{}]), OFFLINE)
    expect(report.blocking).toBe(true)
    expect(report.tasks).toEqual([])
    expect(checksOf(report.cross)).toEqual(['plan-draft-revision'])
  })
})

describe('scope coverage', () => {
  it('names an item assigned to no task and an item assigned twice, and passes the rest', () => {
    const findings = checkScopeCoverage(
      [1, 2],
      [
        { item: 'Check the draft', disposition: { kind: 'delivered', task: 1 } },
        { item: 'Preview the draft', disposition: { kind: 'delivered', task: 1 } },
        { item: 'Preview the draft', disposition: { kind: 'delivered', task: 2 } },
        { item: 'Review the draft' },
        { item: 'Publish the draft', disposition: { kind: 'delivered', task: 9 } },
        { item: 'Archive the draft', disposition: { kind: 'left-out', reason: 'a later plan' } },
        { item: 'Settled', disposition: { kind: 'left-out', reason: 'covered elsewhere' } },
        { item: 'Settled', disposition: { kind: 'delivered', task: 2 } }
      ]
    )
    const messages = findings.map((f) => f.message)
    expect(messages.find((m) => m.includes('"Preview the draft"'))).toContain('assigned 2 times (task 1, task 2)')
    expect(messages.find((m) => m.includes('"Review the draft"'))).toContain('assigned to no task')
    expect(messages.find((m) => m.includes('"Publish the draft"'))).toContain('assigned to no task')
    expect(messages.find((m) => m.includes('"Settled"'))).toContain('assigned 2 times (left out, task 2)')
    expect(messages.some((m) => m.includes('"Check the draft"') || m.includes('"Archive the draft"'))).toBe(false)
    expect(findings).toHaveLength(4)
    expect(findings.every((f) => f.check === 'plan-draft-scope' && f.agent_recovery_prompt.length > 0)).toBe(true)
  })

  it('finds nothing when every item is assigned once', () => {
    expect(checkScopeCoverage([1], [{ item: 'All of it', disposition: { kind: 'delivered', task: 1 } }])).toEqual([])
  })

  it('is part of the draft check', async () => {
    // A stored draft cannot carry a doubly assigned item (the draft schema refuses it), so the check reads the draft's own list.
    const draft = draftOf('d'.repeat(40), [{}], [{ item: 'All of it', disposition: { kind: 'delivered', task: 1 } }])
    const report = await checkDraft(draft, OFFLINE)
    expect(report.coverage).toEqual([])
  })
})
