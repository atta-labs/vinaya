import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_REVIEW_POLICY } from '@attalabs/aeg-core'
import type { ReviewerPromptFacts } from '../../../apps/cli/src/lib/dev-review-loop/reviewer-dispatch'
import { writeHeldVerdict } from '../../../apps/cli/src/lib/dev-review-loop/reviewer-dispatch'
import { createVinayaReviewInputStager, renderVinayaReviewerPrompt, reviewerRulings } from '../executing/review-input'

function repoWithCommit(): { worktree: string; head: string } {
  const worktree = mkdtempSync(join(tmpdir(), 'review-input-wt-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: worktree, encoding: 'utf8' }).trim()
  git('init', '-q')
  writeFileSync(join(worktree, 'code.ts'), 'export const x = 1\n')
  git('add', '-A')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'one')
  return { worktree, head: git('rev-parse', 'HEAD') }
}

describe('the Vinaya review input', () => {
  test('stages a copy of the judged head with the named input files, once per round', () => {
    const { worktree, head } = repoWithCommit()
    const root = mkdtempSync(join(tmpdir(), 'review-input-root-'))
    const calls: string[] = []
    const stager = createVinayaReviewInputStager({
      root,
      task: 9,
      worktreePath: worktree,
      judgedHead: () => {
        calls.push('head')
        return head
      },
      readHead: () => head,
      baseOf: (h) => {
        calls.push(`base ${h === head}`)
        return 'base-sha'
      },
      brief: () => {
        calls.push('brief')
        return 'the brief'
      },
      prBody: () => {
        calls.push('prBody')
        return 'the body'
      },
      diff: (base, h) => {
        calls.push('diff')
        return `diff ${base}...${h}`
      }
    })
    const first = stager.stage(1)
    expect(first).not.toBeNull()
    const staged = first as NonNullable<typeof first>
    expect(staged.dir.startsWith(root)).toBe(true)
    expect(readFileSync(join(staged.dir, 'code.ts'), 'utf8')).toBe('export const x = 1\n')
    expect(Object.keys(staged.paths ?? {}).sort()).toEqual(['brief', 'diff', 'prBody', 'priorFindings'])
    expect(readFileSync(staged.paths?.brief as string, 'utf8')).toBe('the brief')
    expect(readFileSync(staged.paths?.prBody as string, 'utf8')).toBe('the body')
    expect(readFileSync(staged.paths?.diff as string, 'utf8')).toBe(`diff base-sha...${head}`)
    expect(readFileSync(staged.paths?.priorFindings as string, 'utf8')).toBe(
      'This is round 1 — there is no prior round.'
    )
    // The same round at the same head is not restaged (only the head is read to confirm it); the next round is.
    expect(stager.stage(1)).toBe(staged)
    expect(calls).toEqual(['head', 'base true', 'diff', 'brief', 'prBody', 'head'])
    // Round 2 stages the findings round 1 held, as the standalone loop does.
    writeHeldVerdict(root, 9, 1, 'reviewer', 'REVIEWER round-1 finding F1')
    writeHeldVerdict(root, 9, 1, 'security', 'SECURITY round-1 finding S1')
    const second = stager.stage(2)
    expect(second?.dir).not.toBe(staged.dir)
    expect(calls.length).toBe(11)
    const prior = readFileSync(second?.paths?.priorFindings as string, 'utf8')
    expect(prior).toContain('REVIEWER round-1 finding F1')
    expect(prior).toContain('SECURITY round-1 finding S1')
  })

  test('builds a fresh isolated copy per role and attempt from identical staged bytes', () => {
    const { worktree, head } = repoWithCommit()
    const root = mkdtempSync(join(tmpdir(), 'review-input-root-'))
    const stager = createVinayaReviewInputStager({
      root,
      task: 9,
      worktreePath: worktree,
      judgedHead: () => head,
      readHead: () => head,
      baseOf: () => 'base',
      brief: () => 'brief bytes',
      prBody: () => 'body bytes',
      diff: () => 'diff bytes',
      priorFindings: () => 'finding bytes'
    })
    const reviewer1 = stager.stageAttempt(1, 'reviewer', 1)
    const security1 = stager.stageAttempt(1, 'security', 1)
    const reviewer2 = stager.stageAttempt(1, 'reviewer', 2)
    expect(new Set([reviewer1?.dir, security1?.dir, reviewer2?.dir]).size).toBe(3)
    for (const key of ['brief', 'prBody', 'diff', 'priorFindings'] as const) {
      const bytes = [reviewer1, security1, reviewer2].map((input) => readFileSync(input?.paths?.[key] as string))
      expect(bytes[0]).toEqual(bytes[1])
      expect(bytes[1]).toEqual(bytes[2])
    }
    const facts: ReviewerPromptFacts = {
      objectives: '',
      resolvedObjectives: [],
      rulings: [],
      ciConclusion: 'green',
      revision: 'rev',
      manifest: {
        headSha: 'a'.repeat(40),
        baseSha: 'b'.repeat(40),
        briefHash: 'c'.repeat(64),
        objectivesVersion: 'd'.repeat(64),
        rulingOrdinal: 0,
        policyDigest: 'e'.repeat(64)
      },
      policy: DEFAULT_REVIEW_POLICY
    }
    const reviewerPrompt = renderVinayaReviewerPrompt('reviewer', facts, reviewer1)
    const securityPrompt = renderVinayaReviewerPrompt('security', facts, security1)
    for (const path of Object.values(reviewer1?.paths ?? {})) expect(reviewerPrompt).toContain(path)
    for (const path of Object.values(security1?.paths ?? {})) expect(securityPrompt).toContain(path)
    expect(reviewerPrompt).not.toContain(security1?.dir as string)
    expect(securityPrompt).not.toContain(reviewer1?.dir as string)
  })

  test('a head that cannot be copied stages nothing and the prompt names no input paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'review-input-root-'))
    const stager = createVinayaReviewInputStager({
      root,
      task: 9,
      worktreePath: join(root, 'missing'),
      judgedHead: () => 'abc',
      readHead: () => null,
      baseOf: () => '',
      brief: () => '',
      prBody: () => '',
      diff: () => ''
    })
    expect(stager.stage(1)).toBeNull()
    expect(existsSync(join(root, 'missing'))).toBe(false)
  })

  test('a worktree whose head moves during the copy yields no candidate', () => {
    const { worktree, head } = repoWithCommit()
    const root = mkdtempSync(join(tmpdir(), 'review-input-root-'))
    let reads = 0
    const stager = createVinayaReviewInputStager({
      root,
      task: 9,
      worktreePath: worktree,
      judgedHead: () => head,
      // Agrees before the copy, has moved after it.
      readHead: () => (++reads === 1 ? head : 'moved'),
      baseOf: () => 'b',
      brief: () => '',
      prBody: () => '',
      diff: () => ''
    })
    expect(stager.stage(1)).toBeNull()
    expect(reads).toBe(2)
  })

  test('a failed input write keeps the candidate but names no input file', () => {
    const { worktree, head } = repoWithCommit()
    const root = mkdtempSync(join(tmpdir(), 'review-input-root-'))
    const stager = createVinayaReviewInputStager({
      root,
      task: 9,
      worktreePath: worktree,
      judgedHead: () => head,
      readHead: () => head,
      baseOf: () => 'b',
      brief: () => '',
      prBody: () => '',
      diff: () => '',
      writeInputs: () => false
    })
    const staged = stager.stage(1)
    expect(staged?.dir.startsWith(root)).toBe(true)
    expect(staged?.paths).toBeNull()
  })

  test('an unfetchable brief, body or diff becomes a placeholder naming the failure', () => {
    const { worktree, head } = repoWithCommit()
    const root = mkdtempSync(join(tmpdir(), 'review-input-root-'))
    const boom = (what: string) => () => {
      throw new Error(`${what} down`)
    }
    const stager = createVinayaReviewInputStager({
      root,
      task: 9,
      worktreePath: worktree,
      judgedHead: () => head,
      readHead: () => head,
      baseOf: boom('base'),
      brief: boom('brief'),
      prBody: boom('body'),
      diff: () => 'never'
    })
    const paths = stager.stage(1)?.paths
    expect(readFileSync(paths?.brief as string, 'utf8')).toBe(
      "(the task's frozen brief could not be fetched this round: brief down)"
    )
    expect(readFileSync(paths?.prBody as string, 'utf8')).toBe(
      '(the pull request body could not be fetched this round: body down)'
    )
    expect(readFileSync(paths?.diff as string, 'utf8')).toBe(
      '(the diff of the judged head against its base could not be computed this round)'
    )
  })

  test('the prompt carries the staged input paths, and none without a staging', () => {
    const inputs = { brief: '/s/in/b.md', prBody: '/s/in/p.md', diff: '/s/in/d.diff', priorFindings: '/s/in/f.md' }
    const facts: ReviewerPromptFacts = {
      objectives: 'O1. Do the thing.',
      resolvedObjectives: [{ id: 'O1', text: 'Do the thing.' }],
      rulings: [],
      ciConclusion: 'green',
      revision: 'rev',
      manifest: {
        headSha: 'a'.repeat(40),
        baseSha: 'e'.repeat(40),
        briefHash: 'b'.repeat(64),
        objectivesVersion: 'c'.repeat(64),
        rulingOrdinal: 0,
        policyDigest: 'd'.repeat(64)
      },
      policy: DEFAULT_REVIEW_POLICY
    }
    const staged = renderVinayaReviewerPrompt('reviewer', facts, { dir: '/s', paths: inputs })
    for (const path of Object.values(inputs)) expect(staged).toContain(path)
    const bare = renderVinayaReviewerPrompt('security', facts, null)
    expect(bare).not.toContain('/s/in/')
  })
})

describe('reviewerRulings', () => {
  const base = {
    task: 9,
    fetchIssueRulingsAfterBrief: () => ['issue ruling'],
    fetchRulings: (pr: number) => [`pr ${pr} ruling`]
  }
  test("the Issue's rulings after the brief, then the pull request's", () => {
    expect(reviewerRulings({ ...base, prNumber: 42 })).toEqual(['issue ruling', 'pr 42 ruling'])
    expect(reviewerRulings({ ...base, prNumber: null })).toEqual(['issue ruling'])
  })
  test("a failed Issue read falls back to the pull request's alone, and says so", () => {
    const warned: string[] = []
    const rulings = reviewerRulings({
      ...base,
      prNumber: 42,
      fetchIssueRulingsAfterBrief: () => {
        throw new Error('gh down')
      },
      warn: (line) => warned.push(line)
    })
    expect(rulings).toEqual(['pr 42 ruling'])
    expect(warned.join('')).toContain('gh down')
  })
})

describe('a staged review input reused across runs in one process', () => {
  test('is rebuilt when its copy was removed or the judged head moved', () => {
    const { worktree, head } = repoWithCommit()
    const root = mkdtempSync(join(tmpdir(), 'review-input-root-'))
    let judged = head
    const stager = createVinayaReviewInputStager({
      root,
      task: 9,
      worktreePath: worktree,
      judgedHead: () => judged,
      readHead: () => judged,
      baseOf: () => 'base-sha',
      brief: () => 'the brief',
      prBody: () => 'the body',
      diff: (base, h) => `diff ${base}...${h}`
    })
    const first = stager.stageAttempt(1, 'reviewer', 1)
    expect(first).not.toBeNull()
    rmSync(first?.dir as string, { recursive: true, force: true })
    const again = stager.stageAttempt(1, 'reviewer', 1)
    expect(existsSync(again?.dir as string)).toBe(true)
    const before = stager.stage(1)
    judged = 'a-moved-head'
    expect(stager.stage(1)).not.toBe(before)
  })
})
