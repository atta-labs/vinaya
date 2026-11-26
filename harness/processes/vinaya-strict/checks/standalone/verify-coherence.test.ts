import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { PROVENANCE_HEADING } from '../../tools/legacy-markers'

/**
 * Regression coverage for two
 * confirmed root causes in `fetchProvenance`:
 *
 * 1. `timelineItems(first: 1, ...)` fetched the FIRST `ClosedEvent`, not the
 *    most recent, missing provenance on a reopened-then-reclosed issue.
 * 2. Issues closed via explicit `gh issue close` never populate
 *    GitHub's `closer` field, even when a real merged PR did the work.
 *
 * The mock below fakes `@octokit/graphql`'s `graphql.defaults(...)` client,
 * dispatching on whether the outgoing query targets `CLOSED_EVENT` (and
 * whether it uses `last: 1` vs `first: 1`) or `CROSS_REFERENCED_EVENT`, so
 * the fixtures below exercise the exact query shapes `fetchProvenance` emits.
 */

type FixtureCloser = { number: number; body: string; comments: string[] } | null
type FixtureCrossRefSource = { number: number; body: string; comments: string[] }

let closedEventFixtures: Record<number, FixtureCloser[]> = {}
let crossRefFixtures: Record<number, FixtureCrossRefSource[]> = {}

mock.module('@octokit/graphql', () => ({
  graphql: {
    defaults: () => async (query: string) => {
      const issueNums = [...query.matchAll(/i_(\d+):/g)].map((m) => Number(m[1]))
      const repository: Record<string, unknown> = {}

      if (query.includes('CLOSED_EVENT')) {
        const usesLast = /timelineItems\(last:\s*1/.test(query)
        for (const n of issueNums) {
          const closers = closedEventFixtures[n] ?? []
          const picked = usesLast ? closers[closers.length - 1] : closers[0]
          repository[`i_${n}`] = {
            timelineItems: {
              nodes: [
                {
                  closer: picked
                    ? {
                        number: picked.number,
                        body: picked.body,
                        comments: { nodes: picked.comments.map((body) => ({ body })) }
                      }
                    : null
                }
              ]
            }
          }
        }
      } else if (query.includes('CROSS_REFERENCED_EVENT')) {
        for (const n of issueNums) {
          const sources = crossRefFixtures[n] ?? []
          repository[`i_${n}`] = {
            timelineItems: {
              nodes: sources.map((s) => ({
                source: {
                  number: s.number,
                  body: s.body,
                  comments: { nodes: s.comments.map((body) => ({ body })) }
                }
              }))
            }
          }
        }
      }

      return { repository }
    }
  }
}))

const { fetchProvenance, evaluateA2ByIssue } = await import('./verify-coherence')
const { buildIssueEntries } = await import('../coherence-checks')

describe('evaluateA2ByIssue — keyed by Issue number', () => {
  const task = (issue: number) => ({
    id: '3',
    title: 'a task',
    issue,
    projects: [],
    dependsOn: [],
    conflictsWith: [],
    rationaleMarkdown: ''
  })
  const facts = (stateReason: 'completed' | 'not_planned') => ({
    issueState: 'closed' as const,
    assigned: false,
    blockedLabel: false,
    branchExists: false,
    prState: 'merged' as const,
    reviewDecision: 'none' as const,
    stateReason,
    closedAt: null,
    mergedAt: '2026-08-01T00:00:00Z',
    closedByActor: null
  })
  // Issue 101 was dropped (not planned) and Issue 102 re-used task number 3; both
  // read the shared task branch's merged pull request.
  const entries = buildIssueEntries(
    't',
    false,
    [task(101), task(102)],
    new Map([
      [101, facts('not_planned')],
      [102, facts('completed')]
    ])
  )

  it('passes the duplicate-number tranche when the standing Issue’s close-out is present', async () => {
    const asked: number[][] = []
    const result = await evaluateA2ByIssue(entries, async (nums) => {
      asked.push(nums)
      return new Map([[102, true]])
    })
    expect(result.status).toBe('pass')
    expect(asked).toEqual([[102]])
  })

  it('fails naming the merged Issue only when its close-out is absent', async () => {
    const result = await evaluateA2ByIssue(entries, async () => new Map([[102, false]]))
    expect(result.status).toBe('fail')
    expect(result.failures.map((f) => f.issue)).toEqual([102])
  })
})

const PROVENANCE_FOR = (issue: number) =>
  `${PROVENANCE_HEADING.old} — task 1 (tranche fixture)\n- Issue:        #${issue}  (closed by merge)\n- Tier:         1`

beforeEach(() => {
  closedEventFixtures = {}
  crossRefFixtures = {}
})

describe('fetchProvenance — Part 1: most-recent-closure', () => {
  it('finds provenance on the most recent closer, not the first (Issue #287 → PR #288 then #313)', async () => {
    closedEventFixtures[287] = [
      { number: 288, body: 'no provenance here', comments: [] },
      { number: 313, body: 'merge commit', comments: [PROVENANCE_FOR(287)] }
    ]

    const result = await fetchProvenance([287], 'owner', 'repo', 'token')

    expect(result.get(287)).toBe(true)
  })

  it('still correctly reports false when the most recent closer genuinely lacks provenance', async () => {
    closedEventFixtures[999] = [{ number: 1000, body: 'no provenance here', comments: [] }]

    const result = await fetchProvenance([999], 'owner', 'repo', 'token')

    expect(result.get(999)).toBe(false)
  })
})

describe('fetchProvenance — Part 2: null-closer fallback', () => {
  it('finds provenance via a cross-referenced merged PR when closer is null (Issue #167 → PR #148)', async () => {
    closedEventFixtures[167] = [null]
    crossRefFixtures[167] = [
      { number: 189, body: 'unrelated mention of #167', comments: [] },
      { number: 148, body: 'the real work', comments: [PROVENANCE_FOR(167)] }
    ]

    const result = await fetchProvenance([167], 'owner', 'repo', 'token')

    expect(result.get(167)).toBe(true)
  })

  it('correctly returns false when closer is null and no cross-referenced PR carries provenance', async () => {
    closedEventFixtures[900] = [null]
    crossRefFixtures[900] = [{ number: 901, body: 'mentions #900 in passing', comments: [] }]

    const result = await fetchProvenance([900], 'owner', 'repo', 'token')

    expect(result.get(900)).toBe(false)
  })

  it('does not false-positive on a cross-referenced PR carrying provenance for a DIFFERENT issue', async () => {
    // Mirrors live data: PR #193 mentions #170 in passing but its own
    // provenance block targets #171; PR #321 mentions #168 but targets #282.
    closedEventFixtures[170] = [null]
    crossRefFixtures[170] = [{ number: 193, body: 'references #170', comments: [PROVENANCE_FOR(171)] }]

    const result = await fetchProvenance([170], 'owner', 'repo', 'token')

    expect(result.get(170)).toBe(false)
  })

  it('resolves a mixed batch independently per issue', async () => {
    closedEventFixtures[287] = [
      { number: 288, body: '', comments: [] },
      { number: 313, body: '', comments: [PROVENANCE_FOR(287)] }
    ]
    closedEventFixtures[167] = [null]
    crossRefFixtures[167] = [{ number: 148, body: '', comments: [PROVENANCE_FOR(167)] }]
    closedEventFixtures[900] = [null]
    crossRefFixtures[900] = []

    const result = await fetchProvenance([287, 167, 900], 'owner', 'repo', 'token')

    expect(result.get(287)).toBe(true)
    expect(result.get(167)).toBe(true)
    expect(result.get(900)).toBe(false)
  })
})

/**
 * Regression coverage for a review finding:
 * `--json` mode's stdout must be pure, parseable JSON — nothing
 * else (a stray `console.log`/`console.warn`, or noise leaking from a
 * shelled-out command like the item-5 `git fetch origin main`) may write to
 * it, because the `coherence-gate` CI job captures stdout+stderr combined
 * into one file and feeds it straight to `jq`. Spawns the real CLI as a
 * subprocess (not the in-process `runCoherenceChecks`) so this actually
 * exercises the same stdio path CI does, including the real `git fetch`
 * this file's `loadTrancheFiles` now performs.
 *
 * On the budget below (#52). It is deliberately NOT tuned to the current
 * runtime. This test's assertion is JSON purity; the clock is only here to
 * stop a hung forge call from hanging CI, so the right budget is one no
 * healthy run can reach — anything tighter makes machine load, not the code
 * under test, decide the result.
 *
 * The history is worth keeping, because it is what made the number a defect
 * once already: when `loadTrancheFiles` derived each tranche from the forge
 * one serial `gh` round trip at a time, the sweep grew with the repo until it
 * outran its own budget (measured 2026-08-14 in the attalabs monorepo, ~20
 * tranches: 115.7 s / 121 s / 142 s against 120,000 ms — a coin flip). The
 * fix was not a bigger constant: the sweep now indexes Milestones once and
 * fetches each tranche's Issues exactly once, `FORGE_FETCH_CONCURRENCY` at a
 * time.
 *
 * The subprocess runs with a `gh` on its PATH that refuses every call and
 * with no GitHub token in its environment, so it never reads the live forge:
 * a live run read every tranche label in the repository on each test run,
 * and with dozens of tranches the loops and CI shards running this test spent
 * the account's GraphQL budget. Every forge read failing is also the path
 * that writes the most `gh` noise, so it is the stricter purity case.
 */
describe('CLI --json mode produces pure JSON on stdout (PR #378 review)', () => {
  it('parses as JSON with no leading/trailing noise, regardless of exit code', () => {
    const scriptPath = join(import.meta.dirname, 'verify-coherence.ts')
    // Exit code is 1 when the oracle finds a real `fail` — not a script
    // error. Read stdout from the thrown error in that case too (mirrors
    // `verify-dispatch.ts`'s `captureStreams`), so this test asserts
    // JSON purity independent of the repo's current coherence state.
    const offlineBin = mkdtempSync(join(tmpdir(), 'coherence-offline-gh-'))
    writeFileSync(join(offlineBin, 'gh'), '#!/bin/sh\necho "gh: offline in this test" >&2\nexit 1\n')
    chmodSync(join(offlineBin, 'gh'), 0o755)
    const env = { ...process.env, PATH: `${offlineBin}:${process.env.PATH ?? ''}`, GH_TOKEN: '', GITHUB_TOKEN: '' }
    let out: string
    try {
      out = execFileSync('bun', [scriptPath, '--json'], { encoding: 'utf8', timeout: 120_000, env })
    } catch (err) {
      out = (err as { stdout?: string }).stdout ?? ''
    } finally {
      rmSync(offlineBin, { recursive: true, force: true })
    }
    expect(() => JSON.parse(out)).not.toThrow()
    const parsed = JSON.parse(out)
    expect(parsed).toHaveProperty('summary')
    expect(parsed).toHaveProperty('checks')
  }, 120_000)
})
