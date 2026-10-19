import { describe, expect, it } from 'bun:test'
import type { GhIssue, TrancheMilestoneIndex } from '@attalabs/aeg-forge-state'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSyncBudgeted, stripVinayaEnv } from '../lib/process-fixture'
import { evaluateLifecycleAdvisories, l4Applies } from '../../src/checks/bin/check-coherence'

const SLUG = 'fixture-tranche'

function index(opts: { active?: boolean; archived?: boolean; legacy?: boolean }): TrancheMilestoneIndex {
  const ref = [{ slug: SLUG, goal: '' }]
  return {
    active: opts.active ? ref : [],
    archived: opts.archived ? ref : [],
    facts: new Map(),
    legacySlugs: new Set(opts.legacy ? [SLUG] : [])
  }
}

const tranche = { name: SLUG, lifecycle: 'complete', goal: '', tasks: [], backlog: [] } as never

function entry(issue: number, issueState: 'open' | 'closed') {
  return {
    trancheSlug: SLUG,
    archived: false,
    task: { id: String(issue), issue },
    facts: { issueState }
  } as never
}

function issue(number: number, milestone: string | null, state: 'OPEN' | 'CLOSED' = 'OPEN'): GhIssue {
  return {
    number,
    title: '',
    body: '',
    state,
    labels: [],
    milestone: milestone ? { title: milestone } : null
  } as GhIssue
}

describe('evaluateLifecycleAdvisories', () => {
  it('L2 names an open task Issue of a tranche the index records as complete', () => {
    const results = evaluateLifecycleAdvisories(
      SLUG,
      tranche,
      [entry(7, 'open'), entry(8, 'closed')],
      index({ archived: true }),
      []
    )
    const l2 = results.find((r) => r.check === 'L2')
    expect(l2?.failures.map((f) => f.issue)).toEqual([7])
    expect(results.some((r) => r.check === 'L4')).toBe(false)
  })

  it('L2 is silent for a tranche the index does not record as complete', () => {
    const results = evaluateLifecycleAdvisories(SLUG, tranche, [entry(7, 'open')], index({ active: true }), [])
    expect(results.find((r) => r.check === 'L2')?.failures).toEqual([])
  })

  it('L4 names every open Issue not attached to the legacy Milestone', () => {
    const issues = [issue(1, SLUG), issue(2, null), issue(3, 'other'), issue(4, null, 'CLOSED')]
    const results = evaluateLifecycleAdvisories(SLUG, tranche, [], index({ active: true, legacy: true }), issues)
    const l4 = results.find((r) => r.check === 'L4')
    expect(l4?.failures.map((f) => f.issue)).toEqual([2, 3])
  })

  it('L4 does not run for a label-only active tranche', () => {
    const idx = index({ active: true, legacy: false })
    expect(l4Applies(SLUG, idx)).toBe(false)
    const results = evaluateLifecycleAdvisories(SLUG, tranche, [], idx, [issue(2, null)])
    expect(results.some((r) => r.check === 'L4')).toBe(false)
  })

  it('L4 does not run for an archived legacy tranche', () => {
    expect(l4Applies(SLUG, index({ archived: true, legacy: true }))).toBe(false)
  })
})

describe('check-coherence bin under a failing forge', () => {
  const binPath = join(import.meta.dir, '..', '..', 'src', 'checks', 'bin', 'check-coherence.ts')
  const config = Buffer.from(JSON.stringify({ principals: ['fixture-principal'] })).toString('base64')

  function run(stubBody: string): { status: number | null; lines: string[]; calls: string[] } {
    const root = join(tmpdir(), `vinaya-coherence-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const binDir = join(root, 'stub-bin')
    const repo = join(root, 'repo')
    const callLog = join(root, 'gh-calls.log')
    mkdirSync(binDir, { recursive: true })
    mkdirSync(repo, { recursive: true })
    try {
      const git = (...args: string[]) => spawnSyncBudgeted('git', args, { cwd: repo, encoding: 'utf8' })
      git('init', '-q', '-b', 'main')
      git('config', 'user.email', 'test@example.com')
      git('config', 'user.name', 'Test')
      writeFileSync(join(repo, 'README.md'), '# fixture\n')
      git('add', 'README.md')
      git('commit', '-q', '-m', 'Chore: initial commit')
      git('checkout', '-q', '-b', `task/${SLUG}/1`)
      const gh = join(binDir, 'gh')
      writeFileSync(gh, `#!/bin/sh\n${stubBody}\n`)
      chmodSync(gh, 0o755)
      const result = spawnSyncBudgeted('bun', [binPath], {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...stripVinayaEnv(),
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          HOME: process.env.HOME ?? root,
          AEG_REPO: 'fixture-owner/fixture-repo',
          // The Principal read resolves its repository from the runner's
          // variable, not `AEG_REPO`; the stub answers it as `gh --jq .content` would.
          GITHUB_REPOSITORY: 'fixture-owner/fixture-repo',
          GITHUB_TOKEN: 'dummy',
          BRANCH: `task/${SLUG}/1`,
          GH_CALL_LOG: callLog
        }
      })
      const calls = existsSync(callLog)
        ? readFileSync(callLog, 'utf8')
            .split('\n')
            .filter((l) => l !== '')
        : []
      return { status: result.status, lines: result.stderr.split('\n').filter((l) => l.trim() !== ''), calls }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  function expectWellFormed(lines: string[]): Array<Record<string, unknown>> {
    expect(lines.length).toBeGreaterThan(0)
    return lines.map((line) => {
      const parsed = JSON.parse(line) as Record<string, unknown>
      expect(parsed.schema).toBeDefined()
      expect(parsed.check).toBe('coherence')
      expect(parsed.severity).toBeDefined()
      expect(typeof parsed.message).toBe('string')
      expect(typeof parsed.agent_recovery_prompt).toBe('string')
      return parsed
    })
  }

  it('every gh call fails with a raw line: exit 1, only check-error JSON on stderr', () => {
    const { status, lines } = run('echo "raw gh failure: not authenticated" >&2\nexit 1')
    expect(status).toBe(1)
    const parsed = expectWellFormed(lines)
    expect(parsed.some((p) => p.severity === 'error' && String(p.message).includes('severity:infra'))).toBe(true)
  }, 30_000)

  it('only the Milestone-list read fails: exit 1, one L2/L4 did-not-evaluate warning', () => {
    const { status, lines } = run(
      [
        'case "$*" in',
        '  *"repos/fixture-owner/fixture-repo/milestones"*) echo "raw gh failure: milestones" >&2; exit 1 ;;',
        `  *"repos/fixture-owner/fixture-repo/contents/vinaya.config.json"*) echo '${config}' ;;`,
        '  *) echo "[]" ;;',
        'esac'
      ].join('\n')
    )
    expect(status).toBe(1)
    const parsed = expectWellFormed(lines)
    const notEvaluated = parsed.filter((p) => String(p.message).includes('L2 and L4 did not evaluate'))
    expect(notEvaluated).toHaveLength(1)
    expect(notEvaluated[0]?.severity).toBe('warning')
  }, 30_000)
  it('reads Issues for the branch tranche label only, in at most three gh issue list calls', () => {
    const labels = JSON.stringify(
      Array.from({ length: 47 }, (_, n) => ({ name: `vinaya/tranche:other-${n}-v1` })).concat([
        { name: `vinaya/tranche:${SLUG}` }
      ])
    )
    const { calls } = run(
      [
        'echo "$*" >> "$GH_CALL_LOG"',
        'case "$*" in',
        '  *"issue list"*) echo "[]" ;;',
        '  *"repos/fixture-owner/fixture-repo/milestones"*) echo "[]" ;;',
        `  *"repos/fixture-owner/fixture-repo/labels"*) echo '${labels}' ;;`,
        `  *"repos/fixture-owner/fixture-repo/contents/vinaya.config.json"*) echo '${config}' ;;`,
        '  *) echo "[]" ;;',
        'esac'
      ].join('\n')
    )
    const issueLists = calls.filter((c) => c.startsWith('issue list'))
    expect(issueLists.length).toBeGreaterThan(0)
    expect(issueLists.length).toBeLessThanOrEqual(3)
    for (const call of issueLists) {
      const named = call.split(' ').flatMap((arg, n, all) => (all[n - 1] === '--label' ? [arg] : []))
      expect(named).toEqual([`vinaya/tranche:${SLUG}`])
    }
  }, 30_000)
})
