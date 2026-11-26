import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assembleAndRenderBriefForIssue,
  DRAFT_ISSUE_SENTINEL
} from '@harness/workflow/tools/task-contract/brief-assembly.js'
import type { PlanDraft } from './draft'
import { publishedIssueOf, previewDraft, renderDraftTask, stageRevision } from './preview'

const sh = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** A `gh` on `PATH` that answers only the Principal read, as the render's trust anchor needs. */
function servePrincipalsConfig(): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-preview-gh-'))
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

/** A task body that renders: one objective, one pinned file, and the edges and premises a test gives it. */
function taskBody(o: { depends?: string; conflicts?: string; premise?: string; pins?: string[] } = {}): string {
  const pins = (o.pins ?? ['src/fixture.ts']).map((p) => `\`${p}\``).join(', ')
  return [
    '**Project:** cli',
    '',
    '## Objectives',
    '',
    'O1. The fixture renders from the draft alone.',
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
    'Part 1 (O1) — proves the draft renders.',
    '',
    '## Test plan',
    '',
    'Test Plan: unit-tests-only',
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

type Fixture = { root: string; revision: string; cleanup: () => void }

/** A clone of a one-commit repository whose default branch is `main`, made the working directory. */
function makeFixture(files: Record<string, string> = {}): Fixture {
  const tmp = mkdtempSync(join(tmpdir(), 'vinaya-draft-fixture-'))
  const remote = join(tmp, 'remote')
  const local = join(tmp, 'local')
  mkdirSync(join(remote, 'src'), { recursive: true })
  sh(tmp, ['init', '-q', '-b', 'main', remote])
  sh(remote, ['config', 'user.email', 'a@example.com'])
  sh(remote, ['config', 'user.name', 'A'])
  writeFileSync(join(remote, 'src', 'fixture.ts'), 'export const fixture = true\n')
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(remote, path, '..'), { recursive: true })
    writeFileSync(join(remote, path), text)
  }
  sh(remote, ['add', '.'])
  sh(remote, ['commit', '-q', '-m', 'seed'])
  sh(tmp, ['clone', '-q', remote, local])
  sh(local, ['config', 'user.email', 'a@example.com'])
  sh(local, ['config', 'user.name', 'A'])
  const before = process.cwd()
  const repo = process.env.VINAYA_REPO
  const restoreGh = servePrincipalsConfig()
  process.chdir(local)
  process.env.VINAYA_REPO = 'test-owner/test-repo'
  const github = process.env.GITHUB_REPOSITORY
  process.env.GITHUB_REPOSITORY = 'test-owner/test-repo'
  return {
    root: local,
    revision: sh(local, ['rev-parse', 'HEAD']),
    cleanup: () => {
      process.chdir(before)
      restoreGh()
      if (github === undefined) delete process.env.GITHUB_REPOSITORY
      else process.env.GITHUB_REPOSITORY = github
      if (repo === undefined) delete process.env.VINAYA_REPO
      else process.env.VINAYA_REPO = repo
      rmSync(tmp, { recursive: true, force: true })
    }
  }
}

function draftOf(revision: string, tasks: { body: string; title?: string; issue?: number | null }[]): PlanDraft {
  return {
    schemaVersion: 1,
    tranche: 'sample-plan',
    revision,
    reviewQuestionVersion: 'q1',
    tasks: tasks.map((t, i) => ({
      number: i + 1,
      issue: t.issue ?? null,
      title: t.title ?? `Task ${i + 1}`,
      body: t.body,
      labels: []
    })),
    scope: []
  }
}

describe('the draft preview', () => {
  let fx: Fixture
  beforeEach(() => {
    fx = makeFixture()
  })
  afterEach(() => fx.cleanup())

  it('previews the exact Issue: the tranche title form, the body verbatim, and the tranche label', async () => {
    const draft = draftOf(fx.revision, [{ body: taskBody() }])
    const task = draft.tasks[0] as PlanDraft['tasks'][number]
    expect(publishedIssueOf(draft, task)).toEqual({
      title: '[sample-plan] 1 — Task 1',
      body: taskBody(),
      labels: ['vinaya/tranche:sample-plan']
    })
  })

  it('previews a draft of one task', async () => {
    const preview = await previewDraft(draftOf(fx.revision, [{ body: taskBody() }]))
    expect(preview.ok, JSON.stringify(preview.findings)).toBe(true)
    expect(preview.tasks).toHaveLength(1)
    expect(preview.tasks[0]?.brief).toContain('O1. The fixture renders from the draft alone.')
    expect(preview.tasks[0]?.waiting).toEqual([])
  })

  it('previews a task whose dependency has not merged in full, with readiness beside it', async () => {
    const draft = draftOf(fx.revision, [{ body: taskBody() }, { body: taskBody({ depends: '1' }) }])
    const preview = await previewDraft(draft)
    expect(preview.ok, JSON.stringify(preview.tasks.map((t) => t.findings))).toBe(true)
    const second = preview.tasks.find((t) => t.task === 2)
    expect(second?.brief).toContain('O1. The fixture renders from the draft alone.')
    expect(second?.waiting.length).toBeGreaterThan(0)
    expect(preview.tasks.find((t) => t.task === 1)?.waiting).toEqual([])
  })

  it('holds a premise deferred to an unmerged task of the draft back, and previews the task', async () => {
    const draft = draftOf(fx.revision, [
      { body: taskBody() },
      { body: taskBody({ depends: '1', premise: 'after task 1: `src/new.ts` contains `export const made = 1`' }) }
    ])
    const preview = await previewDraft(draft, [2])
    expect(preview.ok, JSON.stringify(preview.tasks.map((t) => t.findings))).toBe(true)
    expect(preview.tasks).toHaveLength(1)
  })

  it('names a missing fact as a finding for the task and still previews the others', async () => {
    const draft = draftOf(fx.revision, [
      { body: taskBody() },
      { body: taskBody({ premise: '`src/fixture.ts` contains `not there`' }) }
    ])
    const preview = await previewDraft(draft)
    expect(preview.ok).toBe(false)
    expect(preview.tasks.find((t) => t.task === 1)?.brief).not.toBeNull()
    const refused = preview.tasks.find((t) => t.task === 2)
    expect(refused?.brief).toBeNull()
    expect(refused?.findings[0]?.check).toBe('plan-draft-preview')
    expect(refused?.findings[0]?.agent_recovery_prompt.length).toBeGreaterThan(0)
  })

  it('is unchanged by an uncommitted edit to a pinned file, which refuses a render from the working tree', async () => {
    const draft = draftOf(fx.revision, [{ body: taskBody() }])
    const clean = await previewDraft(draft)
    writeFileSync(join(fx.root, 'src', 'fixture.ts'), 'export const fixture = false // edited\n')
    expect(sh(fx.root, ['status', '--porcelain'])).toContain('src/fixture.ts')

    const direct = await renderDraftTask(draft, draft.tasks[0] as PlanDraft['tasks'][number])
    expect(direct.ok).toBe(false)
    if (!direct.ok) expect(direct.missing.join('\n')).toContain('uncommitted')

    const dirty = await previewDraft(draft)
    expect(dirty.ok).toBe(true)
    expect(dirty.tasks[0]?.brief).toBe(clean.tasks[0]?.brief ?? null)
  })

  it('equals the brief a render made to start would freeze for the same text at the same revision', async () => {
    const draft = draftOf(fx.revision, [{ body: taskBody() }])
    const task = draft.tasks[0] as PlanDraft['tasks'][number]
    const preview = await previewDraft(draft)
    const frozen = await assembleAndRenderBriefForIssue(DRAFT_ISSUE_SENTINEL, publishedIssueOf(draft, task), {
      skipFreshness: true,
      trancheDraft: { slug: 'sample-plan', taskId: '1', tasks: [{ id: '1', issue: null }] }
    })
    expect(frozen.ok).toBe(true)
    expect(preview.tasks[0]?.brief).toBe(frozen.ok ? frozen.brief : null)
  })

  it('names an unknown revision as a finding and never falls back to the working tree', async () => {
    const preview = await previewDraft(draftOf('b'.repeat(40), [{ body: taskBody() }]))
    expect(preview.ok).toBe(false)
    expect(preview.tasks).toEqual([])
    expect(preview.findings[0]?.check).toBe('plan-draft-revision')
    expect(preview.findings[0]?.message).toContain('unknown')
  })

  it('names a revision that is not on the default branch as stale', async () => {
    writeFileSync(join(fx.root, 'src', 'other.ts'), 'export const other = 1\n')
    sh(fx.root, ['checkout', '-q', '-b', 'side'])
    sh(fx.root, ['add', '.'])
    sh(fx.root, ['commit', '-q', '-m', 'side only'])
    const off = sh(fx.root, ['rev-parse', 'HEAD'])
    const staged = stageRevision(off)
    expect(staged.ok).toBe(false)
    if (!staged.ok) expect(staged.finding.message).toContain('stale')
  })

  it('leaves the working directory where it was, and removes the copy', async () => {
    const before = process.cwd()
    const preview = await previewDraft(draftOf(fx.revision, [{ body: taskBody() }]))
    expect(preview.ok).toBe(true)
    expect(process.cwd()).toBe(before)
    const copy = stageRevision(fx.revision)
    expect(copy.ok).toBe(true)
    if (copy.ok) {
      expect(sh(copy.dir, ['rev-parse', 'HEAD'])).toBe(fx.revision)
      copy.dispose()
    }
  })
})
