import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import {
  DEFAULT_REVIEW_POLICY,
  objectivesOf,
  objectivesVersion,
  pauseBoundRulingDigest,
  policyDigest
} from '@attalabs/aeg-core'
import { resolveFrozenPauseBoundRuling } from '../../src/lib/review-gate-input.js'

/**
 * The digest `check-review-gate.ts` resolves when the default branch's
 * `vinaya.config.json` sets no `reviewPolicy` (the `gh` stub below serves one
 * carrying only `principals`) — it falls back to `DEFAULT_REVIEW_POLICY`. Every comment fixture here that expects `pass`
 * now needs this line too: `isBoundToPolicy` no longer grandfathers a
 * missing `Policy digest:` line (`#478` round 4, security MEDIUM).
 */
const DEFAULT_POLICY_DIGEST = policyDigest(DEFAULT_REVIEW_POLICY)

const BIN = join(import.meta.dir, '../../src/checks/bin/check-review-gate.ts')

/** The default branch's `vinaya.config.json` every spawned gate reads: it names the verdict authors below as Principals. */
const PRINCIPALS_CONFIG_B64 = Buffer.from(JSON.stringify({ principals: ['daniboomerang'] }), 'utf8').toString('base64')

const ISSUE_OBJECTIVES_BODY = '## Objectives\n\nO1. Does the thing observably.\n'
const ISSUE_VERSION = objectivesVersion(
  (objectivesOf(ISSUE_OBJECTIVES_BODY) as { ok: true; objectives: never[] }).objectives
)

describe('resolveFrozenPauseBoundRuling — repeated newest-round attempts', () => {
  const principal = 'daniboomerang'
  const ruling = (ordinal: number) => {
    const text = `Ruling ${ordinal}`
    return {
      binding: `1-${ordinal}|esc-${ordinal}|${pauseBoundRulingDigest(text)}`,
      comment: { body: `<!-- aeg:principal:ruling:1-${ordinal} -->\n${text}`, author: principal }
    }
  }

  it('takes the latest posted binding when three comments re-run the newest round', () => {
    const rulings = [ruling(1), ruling(2), ruling(3)]
    const comments = [
      ...rulings.map(({ comment }) => comment),
      ...rulings.map(({ binding }) => ({
        body: `<!-- aeg:developer:round-4 -->\nPause-bound ruling: ${binding}`,
        author: principal
      }))
    ]

    const resolved = resolveFrozenPauseBoundRuling(1, comments, [principal], () => [])

    expect(resolved).toEqual({
      ok: true,
      value: { rulingId: '1-3', pauseId: 'esc-3', contentDigest: pauseBoundRulingDigest('Ruling 3') }
    })
  })

  it('fails closed when the latest posted newest-round comment has no binding', () => {
    const first = ruling(1)
    const comments = [
      first.comment,
      { body: `<!-- aeg:developer:round-4 -->\nPause-bound ruling: ${first.binding}`, author: principal },
      { body: '<!-- aeg:developer:round-4 -->\nHead: abc', author: principal }
    ]

    const resolved = resolveFrozenPauseBoundRuling(1, comments, [principal], () => [])

    expect(resolved.ok).toBe(false)
  })

  it('preserves the existing behavior for a single round comment', () => {
    const only = ruling(1)
    const comments = [
      only.comment,
      { body: `<!-- aeg:developer:round-4 -->\nPause-bound ruling: ${only.binding}`, author: principal }
    ]

    const resolved = resolveFrozenPauseBoundRuling(1, comments, [principal], () => [])

    expect(resolved).toEqual({
      ok: true,
      value: { rulingId: '1-1', pauseId: 'esc-1', contentDigest: pauseBoundRulingDigest('Ruling 1') }
    })
  })
})

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
if (args[0] === 'api' && String(args[1]).includes('/timeline')) {
  process.stdout.write(process.env.STUB_TIMELINE_JSON ?? '[]')
  process.exit(0)
}
// The trust-anchor config read (\`gh api repos/<repo>/contents/vinaya.config.json --jq .content\`)
// — where \`review-gate\` resolves the Principal list and
// \`gateCutovers.objectivesSinceIssue\`. A test sets STUB_TRUST_ANCHOR_CONFIG_B64
// (base64 of the config JSON) to make a cutover active; unset, the default
// branch carries only \`principals\` — no cutover (O1).
if (args[0] === 'api' && String(args[1]).includes('/contents/')) {
  process.stdout.write(process.env.STUB_TRUST_ANCHOR_CONFIG_B64 ?? ${JSON.stringify(PRINCIPALS_CONFIG_B64)})
  process.exit(0)
}
process.stderr.write('gh stub: unhandled invocation: ' + args.join(' ') + '\\n')
process.exit(1)
`
    )
    chmodSync(ghPath, 0o755)
    return ghDir
  }

  async function run(
    d: string,
    ghDir: string,
    env: Record<string, string>
  ): Promise<{ exitCode: number; stderr: string }> {
    const proc = Bun.spawn(['bun', BIN], {
      cwd: d,
      env: {
        ...process.env,
        PATH: `${ghDir}:${process.env.PATH}`,
        PR_NUMBER: '1',
        // The Principal read addresses the stubbed \`contents\` call through
        // this repository identity (the throwaway \`origin\` is a local path),
        // never the pre-merge probe's local ref.
        GITHUB_REPOSITORY: 'atta-labs/vinaya',
        VINAYA_CI_CONFIG_PROBE_REF: '',
        ...env
      },
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
          body: `VERDICT: APPROVE\n\nJudged head: ${sha}\n\nObjectives version: ${ISSUE_VERSION}\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}\n\nJudged base: ${sha}\n\nManifest version: 2\n\nPause-bound ruling: (none)`,
          author: { login: 'daniboomerang' }
        },
        {
          body: `VERDICT: PASS\n\nJudged head: ${sha}\n\nObjectives version: ${ISSUE_VERSION}\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}\n\nJudged base: ${sha}\n\nManifest version: 2\n\nPause-bound ruling: (none)`,
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
      STUB_ISSUE_VIEW_BODY: ISSUE_OBJECTIVES_BODY
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
      STUB_ISSUE_VIEW_BODY: ISSUE_OBJECTIVES_BODY
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
          body: `VERDICT: APPROVE\n\nJudged head: ${sha}\n\nObjectives version: ${bodyVersion}\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}\n\nJudged base: ${sha}\n\nManifest version: 2\n\nPause-bound ruling: (none)`,
          author: { login: 'daniboomerang' }
        },
        {
          body: `VERDICT: PASS\n\nJudged head: ${sha}\n\nObjectives version: ${bodyVersion}\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}\n\nJudged base: ${sha}\n\nManifest version: 2\n\nPause-bound ruling: (none)`,
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
      STUB_PR_VIEW_JSON: JSON.stringify(prView)
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
          body: `VERDICT: APPROVE\n\nJudged head: ${sha}\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}\n\nJudged base: ${sha}\n\nManifest version: 2\n\nPause-bound ruling: (none)`,
          author: { login: 'daniboomerang' }
        },
        {
          body: `VERDICT: PASS\n\nJudged head: ${sha}\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}\n\nJudged base: ${sha}\n\nManifest version: 2\n\nPause-bound ruling: (none)`,
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
      STUB_PR_VIEW_JSON: JSON.stringify(prView)
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
          body: `VERDICT: APPROVE\n\nJudged head: ${sha}\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}\n\nJudged base: ${sha}\n\nManifest version: 2\n\nPause-bound ruling: (none)`,
          author: { login: 'daniboomerang' }
        },
        {
          body: `VERDICT: PASS\n\nJudged head: ${sha}\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}\n\nJudged base: ${sha}\n\nManifest version: 2\n\nPause-bound ruling: (none)`,
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
      STUB_ISSUE_VIEW_FAIL: 'API rate limit exceeded for this token'
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
      STUB_ISSUE_VIEW_FAIL: 'GraphQL: Could not resolve to an issue with the number of 500.'
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
      STUB_ISSUE_VIEW_BODY: 'not a real Objectives section'
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
          body: `VERDICT: APPROVE\n\nJudged head: ${sha}\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}\n\nJudged base: ${sha}\n\nManifest version: 2\n\nPause-bound ruling: (none)`,
          author: { login: 'daniboomerang' }
        },
        {
          body: `VERDICT: PASS\n\nJudged head: ${sha}\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}\n\nJudged base: ${sha}\n\nManifest version: 2\n\nPause-bound ruling: (none)`,
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

    // The Objectives cutover now comes from the trust-anchor `gateCutovers`
    // key. Configure this repo's own historical value (404) via the trust
    // anchor so #1 is genuinely pre-cutover and the binding is skipped — the
    // behaviour this test asserts. `GITHUB_REPOSITORY` lets the trust-anchor
    // read resolve the repo identity so the stubbed `contents` call is reached.
    const trustAnchorConfigB64 = Buffer.from(
      JSON.stringify({ principals: ['daniboomerang'], gateCutovers: { objectivesSinceIssue: 404 } }),
      'utf8'
    ).toString('base64')
    const { exitCode } = await run(d, ghDir, {
      STUB_PR_VIEW_JSON: JSON.stringify(prView),
      GITHUB_REPOSITORY: 'atta-labs/vinaya',
      STUB_TRUST_ANCHOR_CONFIG_B64: trustAnchorConfigB64
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
      ])
    })

    expect(exitCode).toBe(0)
  })

  /**
   * The ruling slot is checked against the binding the loop's round comment
   * recorded from the consumed resolution before any reviewer ran, never
   * against the verdicts' own echoes: two verdicts agreeing on a wrong
   * binding both fail.
   */
  function pauseBoundFixture(sha: string, echoed: string) {
    const rulingText = 'Ruling — resume, one more round.'
    const digest = pauseBoundRulingDigest(rulingText)
    const frozen = `1-1|esc-1|${digest}`
    const verdict = (label: string) =>
      `VERDICT: ${label}\n\nJudged head: ${sha}\n\nRuling ordinal: 1\n\nPolicy digest: ${DEFAULT_POLICY_DIGEST}\n\nJudged base: ${sha}\n\nManifest version: 2\n\nPause-bound ruling: ${echoed}`
    return {
      frozen,
      prView: {
        number: 1,
        comments: [
          { body: `<!-- aeg:principal:ruling:1-1 -->\n${rulingText}\n`, author: { login: 'daniboomerang' } },
          {
            body: `<!-- aeg:developer:round-2 -->\nHead: ${sha}\nPause-bound ruling: ${frozen}`,
            author: { login: 'daniboomerang' }
          },
          { body: verdict('APPROVE'), author: { login: 'daniboomerang' } },
          { body: verdict('PASS'), author: { login: 'daniboomerang' } }
        ],
        labels: [],
        headRefName: 'work',
        headRefOid: sha,
        baseRefName: 'main',
        body: ''
      }
    }
  }

  it('fails when both verdicts agree on a ruling binding other than the one the round comment froze', async () => {
    const { dir: d, sha } = setupRepo()
    dir = d
    const ghDir = writeGhStub(d)
    const { prView } = pauseBoundFixture(sha, '(none)')

    const { exitCode, stderr } = await run(d, ghDir, { STUB_PR_VIEW_JSON: JSON.stringify(prView) })

    expect(exitCode).toBe(1)
    expect(stderr).toContain('pauseBoundRuling')
  })

  it('passes when both verdicts echo the ruling binding the round comment froze', async () => {
    const { dir: d, sha } = setupRepo()
    dir = d
    const ghDir = writeGhStub(d)
    const { prView } = pauseBoundFixture(sha, pauseBoundFixture(sha, '').frozen)

    const { exitCode } = await run(d, ghDir, { STUB_PR_VIEW_JSON: JSON.stringify(prView) })

    expect(exitCode).toBe(0)
  })

  it('fails closed when the frozen ruling binding does not match the ruling text on the forge', async () => {
    const { dir: d, sha } = setupRepo()
    dir = d
    const ghDir = writeGhStub(d)
    const { prView, frozen } = pauseBoundFixture(sha, '')
    const echoed = pauseBoundFixture(sha, frozen).prView
    echoed.comments[0] = {
      body: '<!-- aeg:principal:ruling:1-1 -->\nAn edited ruling.\n',
      author: { login: 'daniboomerang' }
    }
    void prView

    const { exitCode, stderr } = await run(d, ghDir, { STUB_PR_VIEW_JSON: JSON.stringify(echoed) })

    expect(exitCode).toBe(1)
    expect(stderr).toContain('does not hash to the recorded content digest')
  })
})
