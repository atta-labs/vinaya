import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { coreCheckRegistry } from './registry'
import { runChecks } from '../../../kernel/gates/checks/runner'
import { plannerToolHandlers } from '../thinking/planner/tools/planner-tools'

/**
 * The five write-only rules, registered as `validates: 'issue'`
 * checks, run through the SAME `runChecks` entry point every other check
 * uses — no bespoke invocation path.
 */

function specFor(name: string) {
  const spec = coreCheckRegistry().find((s) => s.name === name)
  if (!spec) throw new Error(`coreCheckRegistry() no longer registers "${name}"`)
  return spec
}

async function run(name: string, env: Record<string, string>) {
  const [outcome] = await runChecks([specFor(name)], {
    parallel: 1,
    diffOnly: false,
    changedFiles: null,
    defaultTimeoutMs: 10_000,
    callerEnv: { ...process.env, ...env }
  })
  return outcome
}

describe('validates: issue — every one of the five checks is registered, ownWorkflow, never a pull-request-only signal', () => {
  it.each([
    'issue-title-grammar',
    'issue-objectives-numbering',
    'issue-parts-coverage',
    'issue-surface-globs',
    'issue-milestone-attach'
  ])('%s declares validates: "issue" and ownWorkflow: true', (name) => {
    const spec = specFor(name)
    expect(spec.validates).toBe('issue')
    expect(spec.ownWorkflow).toBe(true)
  })
})

describe('issue-title-grammar (bin)', () => {
  it('passes a well-formed task title', async () => {
    const outcome = await run('issue-title-grammar', { ISSUE_TITLE: '[demo-v1] 1 — a real title' })
    expect(outcome?.status).toBe('pass')
  })

  it('fails a title matching neither grammar', async () => {
    const outcome = await run('issue-title-grammar', { ISSUE_TITLE: 'not a valid title at all' })
    expect(outcome?.status).toBe('fail')
    expect(outcome?.errors[0]?.check).toBe('issue-title-grammar')
  })

  it('passes (nothing to grade) when no title is given', async () => {
    const env = { ...process.env }
    delete env.ISSUE_TITLE
    const [outcome] = await runChecks([specFor('issue-title-grammar')], {
      parallel: 1,
      diffOnly: false,
      changedFiles: null,
      defaultTimeoutMs: 10_000,
      callerEnv: env
    })
    expect(outcome?.status).toBe('pass')
  })
})

describe('issue-objectives-numbering (bin)', () => {
  it('passes a well-formed Objectives section', async () => {
    const outcome = await run('issue-objectives-numbering', {
      ISSUE_BODY: '## Objectives\n\nO1. Something observable happens.\n'
    })
    expect(outcome?.status).toBe('pass')
  })

  it('fails a body with no Objectives section at all, at/above the cutover Issue number', async () => {
    const outcome = await run('issue-objectives-numbering', {
      ISSUE_BODY: 'a body with nothing but a title.',
      ISSUE_NUMBER: '9999999'
    })
    expect(outcome?.status).toBe('fail')
  })
})

describe('issue-parts-coverage (bin)', () => {
  it('passes a Part citing a real Objective id', async () => {
    const outcome = await run('issue-parts-coverage', {
      ISSUE_BODY: '## Objectives\n\nO1. Thing.\n\n## Parts\n\nPart 1 (O1) — does the thing.\n'
    })
    expect(outcome?.status).toBe('pass')
  })

  it('fails a Part citing an Objective id the section never defines', async () => {
    const outcome = await run('issue-parts-coverage', {
      ISSUE_BODY: '## Objectives\n\nO1. Thing.\n\n## Parts\n\nPart 1 (O9) — does the thing.\n'
    })
    expect(outcome?.status).toBe('fail')
  })
})

describe('issue-surface-globs (bin)', () => {
  it('passes a glob that resolves to a real tracked file', async () => {
    const outcome = await run('issue-surface-globs', {
      ISSUE_BODY: '## Surface\n\nin: package.json\nout: (none)\n'
    })
    expect(outcome?.status).toBe('pass')
  })

  it('fails a glob that resolves to nothing', async () => {
    const outcome = await run('issue-surface-globs', {
      ISSUE_BODY: '## Surface\n\nin: this/directory/does-not-exist-anywhere/**\nout: (none)\n'
    })
    expect(outcome?.status).toBe('fail')
  })
})

describe('issue-milestone-attach (bin)', () => {
  it('passes when the live Milestone matches the resolved target', async () => {
    const outcome = await run('issue-milestone-attach', {
      ISSUE_LABELS: 'vinaya/tranche:demo-v1',
      CURRENT_MILESTONE_TITLE: 'v1',
      RESOLVED_MILESTONE_TITLE: 'v1'
    })
    expect(outcome?.status).toBe('pass')
  })

  it('fails when the live Milestone diverges from the resolved target', async () => {
    const outcome = await run('issue-milestone-attach', {
      ISSUE_LABELS: 'vinaya/tranche:demo-v1',
      CURRENT_MILESTONE_TITLE: 'v0',
      RESOLVED_MILESTONE_TITLE: 'v1'
    })
    expect(outcome?.status).toBe('fail')
  })
})

describe('Planner validation tool — the Issue write path invokes runIssueChecks', () => {
  let tmpDir: string

  async function withRepo(fn: (dir: string) => Promise<void>): Promise<void> {
    tmpDir = mkdtempSync(join(tmpdir(), 'vinaya-issue-checks-test-'))
    const cwd = process.cwd()
    try {
      execFileSync('git', ['init', '-q'], { cwd: tmpDir })
      process.chdir(tmpDir)
      await fn(tmpDir)
    } finally {
      process.chdir(cwd)
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  it('refuses invalid Objectives numbering through the real tool and registry write gate', async () => {
    await withRepo(async () => {
      const body = [
        '## Objectives',
        '',
        'O2. Something happens.',
        '',
        "## Planner's rationale",
        '',
        '**Boundary** — test only.',
        '',
        '**Sizing** — one task.',
        '',
        '**Project(s) + blast radius** — none.',
        '',
        '**Dependency rationale** — none.',
        '',
        '**Traps** — executing/developer/doctrine.md — no real doc surface touched.',
        '',
        '**Suggested agent-class** — n/a.',
        '',
        '**Stop-and-escalate** — n/a.',
        '',
        '**Docs to keep coherent** — none.'
      ].join('\n')
      const result = await plannerToolHandlers().task_issue_validate(
        {
          mode: 'create',
          body,
          title: 'Feat: a well-formed title',
          labels: ['vinaya/tranche:demo-v1']
        },
        undefined
      )
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('invalid Objectives accepted')
      expect(result.error.kind).toBe('validation')
      const findings = JSON.parse(result.error.detail ?? '[]') as { check: string }[]
      expect(findings.some((finding) => finding.check === 'issue-objectives-numbering')).toBe(true)
    })
  })
})
