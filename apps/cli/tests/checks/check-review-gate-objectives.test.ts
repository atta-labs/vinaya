import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { DEFAULT_REVIEW_POLICY, objectivesOf, objectivesVersion, policyDigest } from '@attalabs/aeg-core'

/**
 * The digest `check-review-gate.ts` resolves when no `vinaya.config.json` is
 * reachable (none of these throwaway repos have one) — it falls back to
 * `DEFAULT_REVIEW_POLICY`. Every comment fixture here that expects `pass`
 * now needs this line too: `isBoundToPolicy` no longer grandfathers a
 * missing `Policy digest:` line (`#478` round 4, security MEDIUM).
 */
const DEFAULT_POLICY_DIGEST = policyDigest(DEFAULT_REVIEW_POLICY)

const BIN = join(import.meta.dir, '../../src/checks/bin/check-review-gate.ts')

const ISSUE_OBJECTIVES_BODY = '## Objectives\n\nO1. Does the thing observably.\n'
const ISSUE_VERSION = objectivesVersion(
  (objectivesOf(ISSUE_OBJECTIVES_BODY) as { ok: true; objectives: never[] }).objectives
)

/**
 * `check-review-gate`'s `resolveObjectivesVersion` (dev-review-loop-v1 task 2,
 * `#412`, O3) mirrors `verify-brief.ts`'s Issue-then-body resolution and
 * fails closed (`severity:infra`) on a real Issue-fetch error. These spin up
 * a real throwaway repo with a self-referential `origin` (same trick
 * `check-review-gate-true-head.test.ts` uses, since `resolveTrueHeadSha`
 * always runs first) and a `gh` stub configurable per test via env vars.
 */
describe('check-review-gate — objectives-version binding (O3)', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  function setupRepo(): { dir: string; sha: string } {
    const d = mkdtempSync(join(tmpdir(), 'review-gate-objectives-'))
    const g = (args: string[]) => execFileSync('git', args, { cwd: d, stdio: 'ignore' })
    g(['init', '-q', '-b', 'work'])
    g(['config', 'user.email', 't@example.com'])
    g(['config', 'user.name', 'test'])
    writeFileSync(join(d, 'a.txt'), 'content\n')
    g(['add', '-A'])
    g(['commit', '-qm', 'initial'])
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d, encoding: 'utf8' }).trim()
    g(['remote', 'add', 'origin', d])
    // `resolveBaseSha` now fails closed on an unresolvable base tip (round 2
    // review, security MEDIUM) — every PR fixture below names `baseRefName:
    // 'main'`, so a real `main` ref must exist for `git ls-remote` to
    // resolve it, or every `exitCode` assertion in this file would see 1
    // for the wrong reason.
    g(['branch', 'main'])
    return { dir: d, sha }
  }

  function writeGhStub(d: string): string {
    const ghDir = join(d, 'fakebin')
    execFileSync('mkdir', ['-p', ghDir])
    const ghPath = join(ghDir, 'gh')
    writeFileSync(
      ghPath,
      `#!/usr/bin/env bun
const args = process.argv.slice(2)
if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write(process.env.STUB_PR_VIEW_JSON ?? '{}')
  process.exit(0)
}
if (args[0] === 'issue' && args[1] === 'view') {
  if (process.env.STUB_ISSUE_VIEW_FAIL) {
    process.stderr.write(process.env.STUB_ISSUE_VIEW_FAIL)
    process.exit(1)
  }
  // \`--json body\` (objectives) and \`--json comments\` (brief hash,
  // task 4, #478) are two DIFFERENT real calls this stub must answer
  // differently — collapsing them meant the brief-hash resolver, now
  // fail-closed on a genuine error (round 3 review, #478), saw the raw
  // objectives text as its own JSON and threw a parse error every test in
  // this file never intended to exercise.
  if (args.includes('comments')) {
    process.stdout.write(process.env.STUB_ISSUE_VIEW_COMMENTS_JSON ?? '{"comments":[]}')
    process.exit(0)
  }
  process.stdout.write(process.env.STUB_ISSUE_VIEW_BODY ?? '')
  process.exit(0)
}
if (args[0] === 'api' && String(args[1]).includes('/check-runs')) {
  process.stdout.write(process.env.STUB_CHECK_RUNS_NDJSON ?? '')
  process.exit(0)
}
if (args[0] === 'api' && String(args[1]).includes('/timeline')) {
  process.stdout.write(process.env.STUB_TIMELINE_JSON ?? '[]')
  process.exit(0)
}
process.stderr.write('gh stub: unhandled invocation: ' + args.join(' ') + '\\n')
process.exit(1)
`
    )
    chmodSync(ghPath, 0o755)
    return ghDir
  }

  const CLEAN_CHECK_RUNS = '{"id":1,"name":"ci","status":"completed","conclusion":"success"}\n'

  async function run(
    d: string,
    ghDir: string,
    env: Record<string, string>
  ): Promise<{ exitCode: number; stderr: string }> {
    const proc = Bun.spawn(['bun', BIN], {
      cwd: d,
      env: { ...process.env, PATH: `${ghDir}:${process.env.PATH}`, PR_NUMBER: '1', ...env },
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited
    return { exitCode, stderr }
  }

  it('resolves the objectives version from the closed Issue and passes when the verdicts carry it', async () => {
    const { dir: d, sha } = setupRepo()
    dir = d
    const ghDir = writeGhStub(d)

    const prView = {
      number: 1,
      comments: [
        {
          body: `VERDICT: APPROVE\n\nJudged head: ${sha}\n\nObjectives version: ${ISSUE_VERSION}\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}\n\nJudged base: ${sha}`,
          author: { login: 'daniboomerang' }
        },
        {
          body: `VERDICT: PASS\n\nJudged head: ${sha}\n\nObjectives version: ${ISSUE_VERSION}\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}\n\nJudged base: ${sha}`,
          author: { login: 'daniboomerang' }
        }
      ],
      labels: [],
      headRefName: 'work',
      headRefOid: sha,
      baseRefName: 'main',
      body: 'Closes #500'
    }

    const { exitCode } = await run(d, ghDir, {
      STUB_PR_VIEW_JSON: JSON.stringify(prView),
      STUB_ISSUE_VIEW_BODY: ISSUE_OBJECTIVES_BODY,
      STUB_CHECK_RUNS_NDJSON: CLEAN_CHECK_RUNS
    })

    expect(exitCode).toBe(0)
  })

  it('fails, naming the objectives-version mismatch, when a verdict was cast against a superseded Issue objectives list', async () => {
    const { dir: d, sha } = setupRepo()
    dir = d
    const ghDir = writeGhStub(d)
    const staleVersion = 'a'.repeat(64)

    const prView = {
      number: 1,
      comments: [
        {
          body: `VERDICT: APPROVE\n\nJudged head: ${sha}\n\nObjectives version: ${staleVersion}\n\nJudged base: ${sha}`,
          author: { login: 'daniboomerang' }
        },
        {
          body: `VERDICT: PASS\n\nJudged head: ${sha}\n\nObjectives version: ${staleVersion}\n\nJudged base: ${sha}`,
          author: { login: 'daniboomerang' }
        }
      ],
      labels: [],
      headRefName: 'work',
      headRefOid: sha,
      baseRefName: 'main',
      body: 'Closes #500'
    }

    const { exitCode, stderr } = await run(d, ghDir, {
      STUB_PR_VIEW_JSON: JSON.stringify(prView),
      STUB_ISSUE_VIEW_BODY: ISSUE_OBJECTIVES_BODY,
      STUB_CHECK_RUNS_NDJSON: CLEAN_CHECK_RUNS
    })

    expect(exitCode).toBe(1)
    expect(stderr).toContain('objectives version')
    expect(stderr).toContain(staleVersion)
    expect(stderr).toContain(ISSUE_VERSION)
  })

  it("falls back to the PR body's own Objectives section when there is no Closes # at all", async () => {
    const { dir: d, sha } = setupRepo()
    dir = d
    const ghDir = writeGhStub(d)
    const bodyObjectives = '## Objectives\n\nO1. A standalone brief objective.\n'
    const bodyVersion = objectivesVersion(
      (objectivesOf(bodyObjectives) as { ok: true; objectives: never[] }).objectives
    )

    const prView = {
      number: 1,
      comments: [
        {
          body: `VERDICT: APPROVE\n\nJudged head: ${sha}\n\nObjectives version: ${bodyVersion}\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}\n\nJudged base: ${sha}`,
          author: { login: 'daniboomerang' }
        },
        {
          body: `VERDICT: PASS\n\nJudged head: ${sha}\n\nObjectives version: ${bodyVersion}\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}\n\nJudged base: ${sha}`,
          author: { login: 'daniboomerang' }
        }
      ],
      labels: [],
      headRefName: 'work',
      headRefOid: sha,
      baseRefName: 'main',
      body: `no Closes here.\n\n${bodyObjectives}`
    }

    const { exitCode } = await run(d, ghDir, {
      STUB_PR_VIEW_JSON: JSON.stringify(prView),
      STUB_CHECK_RUNS_NDJSON: CLEAN_CHECK_RUNS
    })

    expect(exitCode).toBe(0)
  })

  it('skips the objectives binding entirely (pre-cutover PR stock) when neither the Issue nor the body has a section', async () => {
    const { dir: d, sha } = setupRepo()
    dir = d
    const ghDir = writeGhStub(d)

    const prView = {
      number: 1,
      comments: [
        {
          body: `VERDICT: APPROVE\n\nJudged head: ${sha}\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}\n\nJudged base: ${sha}`,
          author: { login: 'daniboomerang' }
        },
        {
          body: `VERDICT: PASS\n\nJudged head: ${sha}\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}\n\nJudged base: ${sha}`,
          author: { login: 'daniboomerang' }
        }
      ],
      labels: [],
      headRefName: 'work',
      headRefOid: sha,
      baseRefName: 'main',
      body: 'no Closes and no Objectives here.'
    }

    const { exitCode } = await run(d, ghDir, {
      STUB_PR_VIEW_JSON: JSON.stringify(prView),
      STUB_CHECK_RUNS_NDJSON: CLEAN_CHECK_RUNS
    })

    expect(exitCode).toBe(0)
  })

  it('exits severity:infra when the Issue fetch fails for a reason OTHER than not-found', async () => {
    const { dir: d, sha } = setupRepo()
    dir = d
    const ghDir = writeGhStub(d)

    const prView = {
      number: 1,
      comments: [
        {
          body: `VERDICT: APPROVE\n\nJudged head: ${sha}\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}\n\nJudged base: ${sha}`,
          author: { login: 'daniboomerang' }
        },
        {
          body: `VERDICT: PASS\n\nJudged head: ${sha}\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}\n\nJudged base: ${sha}`,
          author: { login: 'daniboomerang' }
        }
      ],
      labels: [],
      headRefName: 'work',
      headRefOid: sha,
      baseRefName: 'main',
      body: 'Closes #500'
    }

    const { exitCode, stderr } = await run(d, ghDir, {
      STUB_PR_VIEW_JSON: JSON.stringify(prView),
      STUB_ISSUE_VIEW_FAIL: 'API rate limit exceeded for this token',
      STUB_CHECK_RUNS_NDJSON: CLEAN_CHECK_RUNS
    })

    expect(exitCode).toBe(1)
    expect(stderr).toContain('severity:infra')
    expect(stderr).toContain('could not fetch Issue')
  })

  it('fails closed (severity:infra) when an at/above-cutover Issue does not resolve — never falls back to the body (security review, #433, CRITICAL)', async () => {
    const { dir: d, sha } = setupRepo()
    dir = d
    const ghDir = writeGhStub(d)

    const prView = {
      number: 1,
      comments: [
        {
          body: `VERDICT: APPROVE\n\nJudged head: ${sha}\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}\n\nJudged base: ${sha}`,
          author: { login: 'daniboomerang' }
        },
        {
          body: `VERDICT: PASS\n\nJudged head: ${sha}\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}\n\nJudged base: ${sha}`,
          author: { login: 'daniboomerang' }
        }
      ],
      labels: [],
      headRefName: 'work',
      headRefOid: sha,
      baseRefName: 'main',
      body: 'Closes #500'
    }

    const { exitCode, stderr } = await run(d, ghDir, {
      STUB_PR_VIEW_JSON: JSON.stringify(prView),
      STUB_ISSUE_VIEW_FAIL: 'GraphQL: Could not resolve to an issue with the number of 500.',
      STUB_CHECK_RUNS_NDJSON: CLEAN_CHECK_RUNS
    })

    // A deleted/renamed Issue at/above the cutover must never silently
    // disarm the binding — falling back to the body (which has no section
    // here either) would have let anyone who can delete the linked Issue
    // make an already-cast verdict read as bound-to-nothing-in-particular.
    expect(exitCode).toBe(1)
    expect(stderr).toContain('severity:infra')
    expect(stderr).toContain('does not resolve')
  })

  it('fails closed when an at/above-cutover Issue resolves but its Objectives section no longer parses (security review, #433, CRITICAL)', async () => {
    const { dir: d, sha } = setupRepo()
    dir = d
    const ghDir = writeGhStub(d)

    const prView = {
      number: 1,
      comments: [
        {
          body: `VERDICT: APPROVE\n\nJudged head: ${sha}\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}\n\nJudged base: ${sha}`,
          author: { login: 'daniboomerang' }
        },
        {
          body: `VERDICT: PASS\n\nJudged head: ${sha}\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}\n\nJudged base: ${sha}`,
          author: { login: 'daniboomerang' }
        }
      ],
      labels: [],
      headRefName: 'work',
      headRefOid: sha,
      baseRefName: 'main',
      body: 'Closes #500'
    }

    const { exitCode, stderr } = await run(d, ghDir, {
      STUB_PR_VIEW_JSON: JSON.stringify(prView),
      STUB_ISSUE_VIEW_BODY: 'not a real Objectives section',
      STUB_CHECK_RUNS_NDJSON: CLEAN_CHECK_RUNS
    })

    expect(exitCode).toBe(1)
    expect(stderr).toContain('severity:infra')
    expect(stderr).toContain('does not parse')
  })

  it('a pre-cutover Issue skips the binding even when the PR body itself happens to carry an unrelated Objectives-shaped section (resolution-order parity, security review MEDIUM)', async () => {
    const { dir: d, sha } = setupRepo()
    dir = d
    const ghDir = writeGhStub(d)

    const prView = {
      number: 1,
      comments: [
        {
          body: `VERDICT: APPROVE\n\nJudged head: ${sha}\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}\n\nJudged base: ${sha}`,
          author: { login: 'daniboomerang' }
        },
        {
          body: `VERDICT: PASS\n\nJudged head: ${sha}\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}\n\nJudged base: ${sha}`,
          author: { login: 'daniboomerang' }
        }
      ],
      labels: [],
      headRefName: 'work',
      headRefOid: sha,
      baseRefName: 'main',
      // Closes #1 is pre-cutover, but the body ALSO carries its own
      // Objectives section — `review post` never considers the body for a
      // pre-cutover Issue (it skips immediately), so this gate must not
      // either, or a verdict `review post` rendered with no version line at
      // all would permanently mismatch a version resolved from here.
      body: 'Closes #1\n\n## Objectives\n\nO1. Unrelated leftover text.\n'
    }

    const { exitCode } = await run(d, ghDir, {
      STUB_PR_VIEW_JSON: JSON.stringify(prView),
      STUB_CHECK_RUNS_NDJSON: CLEAN_CHECK_RUNS
    })

    expect(exitCode).toBe(0)
  })

  it('an actor-verified vinaya/waiver:review label passes even when the linked Issue cannot resolve at all (security review, #433, MAJOR — waiver must stay reachable)', async () => {
    const { dir: d, sha } = setupRepo()
    dir = d
    const ghDir = writeGhStub(d)

    const prView = {
      number: 1,
      comments: [],
      labels: [{ name: 'vinaya/waiver:review' }],
      headRefName: 'work',
      headRefOid: sha,
      baseRefName: 'main',
      // An at/above-cutover Issue that will never resolve — without the
      // waiver pre-check, `resolveObjectivesVersion` would `process.exit(1)`
      // before `checkReviewGate` (and its own waiver short-circuit) ever runs.
      body: 'Closes #500'
    }

    const { exitCode } = await run(d, ghDir, {
      STUB_PR_VIEW_JSON: JSON.stringify(prView),
      STUB_ISSUE_VIEW_FAIL: 'GraphQL: Could not resolve to an Issue',
      STUB_TIMELINE_JSON: JSON.stringify([
        { event: 'labeled', label: { name: 'vinaya/waiver:review' }, actor: { login: 'daniboomerang' } }
      ]),
      STUB_CHECK_RUNS_NDJSON: CLEAN_CHECK_RUNS
    })

    expect(exitCode).toBe(0)
  })
})
