import { parseTokensLines } from '@attalabs/aeg-core'
import type { MeteringCapability } from '@attalabs/aeg-core'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ArchiveDeps } from '../src/commands/archive.js'
import {
  appendRetrospectiveSection,
  fetchMilestoneIssueStates,
  fetchTrancheIssuesByLabel,
  renderArchiveTokensLine,
  renderRetrospectiveSection,
  resolveTaskMilestone,
  roundsForTaskPr,
  runArchive,
  runArchiveTranche,
  trancheArchivalStatus
} from '../src/commands/archive.js'

const INCAPABLE: MeteringCapability = {
  capable: false,
  reason: 'no-transcript-resolved',
  detail: 'test default — no transcript pointer set up'
}

function archiveDeps(overrides: Partial<ArchiveDeps> = {}): ArchiveDeps {
  return {
    detectRepo: async () => ({ repoRoot: '/tmp/does-not-matter', owner: 'acme', repo: 'widget' }),
    meteringCapability: () => INCAPABLE,
    ...overrides
  }
}

describe('vinaya archive — pre-flight', () => {
  it('refuses when not a git repository', async () => {
    const exit = await runArchive([], archiveDeps({ detectRepo: async () => null }))
    expect(exit).toBe(1)
  })

  it('refuses when no GitHub owner/repo can be resolved from `origin`', async () => {
    const exit = await runArchive(
      [],
      archiveDeps({ detectRepo: async () => ({ repoRoot: '/tmp/does-not-matter', owner: '', repo: '' }) })
    )
    expect(exit).toBe(1)
  })
})

// vinaya-token-determinism-v1 task 6 (#273) — the Archivist's own `Tokens: …`
// row in the provenance comment it already posts.
describe('renderArchiveTokensLine', () => {
  it('capable, real figures — a parseable `Tokens: …` line', () => {
    const capability: MeteringCapability = {
      capable: true,
      transcriptPath: '/tmp/real.jsonl',
      summary: {
        components: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 10, cacheReadInputTokens: 5 },
        model: 'claude-sonnet-5',
        messageCount: 3
      }
    }
    const result = renderArchiveTokensLine(capability, '6: archive', 'Archivist')
    expect(result.dangling).toBeNull()
    expect(result.line).toBe('Tokens: 6: archive — Archivist — claude-sonnet-5 — 115/50/—')
    expect(parseTokensLines(result.line as string)).toHaveLength(1)
  })

  it('incapable host — posts the sanctioned all-`—` line, never degrades', () => {
    const result = renderArchiveTokensLine(INCAPABLE, '6: archive', 'Archivist')
    expect(result.dangling).toBeNull()
    expect(result.line).toBe('Tokens: 6: archive — Archivist — — — —')
  })

  it('capable but zero totals — omits the line and flags it DANGLING, never a refusal', () => {
    const capability: MeteringCapability = {
      capable: true,
      transcriptPath: '/tmp/empty-usage.jsonl',
      summary: {
        components: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        model: 'claude-sonnet-5',
        messageCount: 2
      }
    }
    const result = renderArchiveTokensLine(capability, '6: archive', 'Archivist')
    expect(result.line).toBeNull()
    expect(result.dangling).toMatch(/summarized to zero/)
  })
})

// Fakes `gh` as a tiny script placed ahead of the real one on `$PATH` —
// `detect.test.ts`'s own top comment records why `mock.module('node:child_process', ...)`
// is rejected repo-wide (a bun-process-wide binding race across every command
// module that imports `execFileSync`): this is the sanctioned alternative,
// deterministic per test and unable to leak into another test file's real
// subprocess calls.
function withFakeGh<T>(
  prView: unknown,
  fn: (calls: () => string[], postedBody: () => string | null) => Promise<T>
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-archive-fakegh-'))
  const logPath = join(dir, 'calls.log')
  const prViewPath = join(dir, 'pr-view.json')
  const postedPath = join(dir, 'posted.txt')
  writeFileSync(prViewPath, JSON.stringify(prView))
  writeFileSync(logPath, '')
  const script = `#!/usr/bin/env bash
echo "$*" >> "${logPath}"
case "$1 $2" in
  "api "*)
    echo '[{"number":42}]'
    ;;
  "pr view")
    cat "${prViewPath}"
    ;;
  "pr comment")
    cat > "${postedPath}"
    ;;
  "issue view")
    echo '{"state":"CLOSED"}'
    ;;
  "issue close")
    ;;
  *)
    exit 1
    ;;
esac
`
  const ghPath = join(dir, 'gh')
  writeFileSync(ghPath, script)
  chmodSync(ghPath, 0o755)
  const originalPath = process.env.PATH
  process.env.PATH = `${dir}:${originalPath}`
  return fn(
    () =>
      readFileSync(logPath, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    () => {
      try {
        return readFileSync(postedPath, 'utf8')
      } catch {
        return null
      }
    }
  ).finally(() => {
    process.env.PATH = originalPath
    rmSync(dir, { recursive: true, force: true })
  })
}

const PR_WITH_PROVENANCE = {
  number: 42,
  headRefName: 'task/fake-tranche/6',
  body: 'Closes #99\n\n**Tier:** 1',
  mergedAt: '2026-01-01T00:00:00Z',
  comments: [{ body: '### AEG provenance — task 6 (tranche fake-tranche)\n- Issue:        #99  (closed by merge)' }]
}

const PR_WITHOUT_PROVENANCE = { ...PR_WITH_PROVENANCE, comments: [] as { body: string }[] }

describe('vinaya archive — provenance posting (fake `gh` on PATH)', () => {
  it('idempotent re-run: posts nothing new, and the new token logic never even runs', async () => {
    let meteringCalled = false
    await withFakeGh(PR_WITH_PROVENANCE, async (calls) => {
      const exit = await runArchive(
        ['--merge-sha=deadbeef'],
        archiveDeps({
          meteringCapability: () => {
            meteringCalled = true
            return INCAPABLE
          }
        })
      )
      expect(exit).toBe(0)
      expect(calls().some((c) => c.startsWith('pr comment'))).toBe(false)
      expect(calls().some((c) => c.startsWith('issue close'))).toBe(false)
    })
    expect(meteringCalled).toBe(false)
  })

  it('first-time post, incapable host: the posted comment carries the sanctioned all-`—` Tokens line', async () => {
    await withFakeGh(PR_WITHOUT_PROVENANCE, async (_calls, postedBody) => {
      const exit = await runArchive(['--merge-sha=deadbeef'], archiveDeps())
      expect(exit).toBe(0)
      expect(postedBody()).toContain('Tokens: 6: archive — Archivist — — — —')
    })
  })

  it('capable-but-empty: still posts provenance and still closes the Issue — only the Tokens line degrades to DANGLING', async () => {
    // PR #305 review (BLOCKER): an earlier version refused the whole post
    // here, leaving the merged PR with no provenance comment and the Issue
    // still open — collateral damage to a duty this feature has nothing to
    // do with, over one missing token row. The brief's own §10 names that
    // trade-off as a Principal-only call; the fix never forces it.
    const emptyCapability: MeteringCapability = {
      capable: true,
      transcriptPath: '/tmp/fake.jsonl',
      summary: {
        components: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        model: 'claude-sonnet-5',
        messageCount: 1
      }
    }
    await withFakeGh(PR_WITHOUT_PROVENANCE, async (calls, postedBody) => {
      const exit = await runArchive(
        ['--merge-sha=deadbeef'],
        archiveDeps({ meteringCapability: () => emptyCapability })
      )
      expect(exit).toBe(0)
      const body = postedBody()
      expect(body).not.toBeNull()
      expect(body).not.toContain('Tokens: 6: archive')
      expect(body).toContain('DANGLING (tokens): Archivist Tokens: line omitted')
      expect(calls().some((c) => c.startsWith('pr comment'))).toBe(true)
      expect(calls().some((c) => c.startsWith('issue close'))).toBe(true)
    })
  })
})

// rings.ring2_asyncAudits means what it says (issue-545, O2): `true`/absent
// RUNS the async audits, so the Archivist's real work runs. `false` is the
// opt-OUT that skips it.
describe('vinaya archive — rings.ring2_asyncAudits', () => {
  let cwd: string
  let originalCwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'vinaya-archive-ring2-test-'))
    originalCwd = process.cwd()
    process.chdir(cwd)
  })
  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(cwd, { recursive: true, force: true })
  })

  function writeConfig(config: unknown): void {
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify(config), 'utf8')
  }

  it('`false` skips real work entirely — never even calls detectRepo', async () => {
    writeConfig({ rings: { ring1_forgeWriteInterception: true, ring2_asyncAudits: false } })
    let detectRepoCalled = false
    const exit = await runArchive(
      [],
      archiveDeps({
        detectRepo: async () => {
          detectRepoCalled = true
          return { repoRoot: cwd, owner: 'acme', repo: 'widget' }
        }
      })
    )
    expect(exit).toBe(0)
    expect(detectRepoCalled).toBe(false)
  })

  it('`true` is a no-op — real work still runs (fails pre-flight the same as before the flag existed)', async () => {
    writeConfig({ rings: { ring1_forgeWriteInterception: true, ring2_asyncAudits: true } })
    const exit = await runArchive([], archiveDeps({ detectRepo: async () => null }))
    expect(exit).toBe(1)
  })
})

describe('vinaya archive tranche — pre-flight', () => {
  it('refuses with no slug argument', async () => {
    const exit = await runArchiveTranche([], archiveDeps())
    expect(exit).toBe(2)
  })

  it('refuses when not a git repository', async () => {
    const exit = await runArchiveTranche(['some-tranche'], archiveDeps({ detectRepo: async () => null }))
    expect(exit).toBe(1)
  })

  it('refuses when no GitHub owner/repo can be resolved from `origin`', async () => {
    const exit = await runArchiveTranche(
      ['some-tranche'],
      archiveDeps({ detectRepo: async () => ({ repoRoot: '/tmp/does-not-matter', owner: '', repo: '' }) })
    )
    expect(exit).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// vinaya-milestone-model-v1 task 1 — `trancheArchivalStatus` is the pure
// derivation `runArchiveTranche` now runs on: "is this tranche done" from its
// OWN `vinaya/tranche:<slug>`-labeled Issues, never from a Milestone's
// `?milestone=<number>` Issue listing (which would have returned every
// sibling tranche's Issues too, once one Milestone can hold several).
// ---------------------------------------------------------------------------

function issueRef(
  state: 'OPEN' | 'CLOSED',
  number = 1,
  title = 'a task',
  milestone: { number: number; title: string } | null = null
): { number: number; title: string; state: 'OPEN' | 'CLOSED'; milestone: { number: number; title: string } | null } {
  return { number, title, state, milestone }
}

describe('trancheArchivalStatus', () => {
  it('no-tranche — zero Issues carry the label', () => {
    expect(trancheArchivalStatus([])).toEqual({ kind: 'no-tranche' })
  })

  it('open — at least one Issue is still open, and every open one is named', () => {
    const open1 = issueRef('OPEN', 10, 'first open task')
    const open2 = issueRef('OPEN', 11, 'second open task')
    const closed = issueRef('CLOSED', 12, 'a closed task')

    expect(trancheArchivalStatus([closed, open1, open2])).toEqual({
      kind: 'open',
      openIssues: [open1, open2]
    })
  })

  it('complete — every Issue is closed', () => {
    expect(trancheArchivalStatus([issueRef('CLOSED'), issueRef('CLOSED', 2)])).toEqual({ kind: 'complete' })
  })

  it('never reads a sibling tranche — only the Issues it is handed, regardless of any shared Milestone', () => {
    // The whole point of moving off `?milestone=<number>`: this function has
    // no Milestone concept at all, so it structurally cannot see another
    // tranche's Issues the way the old query did.
    const onlyThisTranchesIssues = [issueRef('CLOSED', 1), issueRef('CLOSED', 2)]
    expect(trancheArchivalStatus(onlyThisTranchesIssues)).toEqual({ kind: 'complete' })
  })
})

/**
 * Fakes `gh api repos/<repo>/issues?...` as a paginated REST endpoint —
 * one JSON file per page under `dir`, keyed by the `page=<n>` value in the
 * invoked URL, mirroring `withFakeGh`'s PATH-injection technique above but
 * shaped for a multi-page walk rather than a single canned response.
 */
function withPaginatedFakeGh<T>(pages: unknown[][], fn: (calls: () => string[]) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-archive-paginated-fakegh-'))
  const logPath = join(dir, 'calls.log')
  writeFileSync(logPath, '')
  pages.forEach((page, i) => {
    writeFileSync(join(dir, `page-${i + 1}.json`), JSON.stringify(page))
  })
  const script = `#!/usr/bin/env bash
echo "$*" >> "${logPath}"
url="$2"
# Split on '&'/'?' so the exact "page=" segment is matched — a plain
# substring grep for "page=" also matches "per_page=", GitHub's own
# page-SIZE parameter this same query string always carries.
page=$(echo "$url" | tr '&?' '\\n\\n' | grep '^page=' | cut -d= -f2)
file="${dir}/page-$page.json"
if [ -f "$file" ]; then
  cat "$file"
else
  echo '[]'
fi
`
  const ghPath = join(dir, 'gh')
  writeFileSync(ghPath, script)
  chmodSync(ghPath, 0o755)
  const originalPath = process.env.PATH
  process.env.PATH = `${dir}:${originalPath}`
  return Promise.resolve(
    fn(() =>
      readFileSync(logPath, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    )
  ).finally(() => {
    process.env.PATH = originalPath
    rmSync(dir, { recursive: true, force: true })
  })
}

function restIssue(number: number, state: 'open' | 'closed', pullRequest = false) {
  return { number, title: `task ${number}`, state, milestone: null, ...(pullRequest ? { pull_request: {} } : {}) }
}

describe('fetchTrancheIssuesByLabel — pagination (task 4)', () => {
  it('walks every page of a Milestone with 250 Issues, never truncating at the first 100-item page', async () => {
    // 250 Issues split across three REST pages (100, 100, 50) — the exact
    // shape a single `per_page=100` call used to drop everything past.
    const page1 = Array.from({ length: 100 }, (_, i) => restIssue(i + 1, 'closed'))
    const page2 = Array.from({ length: 100 }, (_, i) => restIssue(i + 101, 'closed'))
    // The 250th Issue is open — proves the tail past two full pages is
    // actually read, not merely counted.
    const page3 = [...Array.from({ length: 49 }, (_, i) => restIssue(i + 201, 'closed')), restIssue(250, 'open')]
    const issues = await withPaginatedFakeGh([page1, page2, page3], () =>
      fetchTrancheIssuesByLabel('acme/widget', 'vinaya/tranche:big-tranche')
    )
    expect(issues).toHaveLength(250)
    expect(issues.filter((i) => i.state === 'OPEN')).toHaveLength(1)
    expect(issues.find((i) => i.number === 250)?.state).toBe('OPEN')
  })

  it('excludes pull requests carrying the same label — the REST endpoint returns both', async () => {
    const page1 = [restIssue(1, 'closed'), restIssue(2, 'open', true)]
    const issues = await withPaginatedFakeGh([page1], () =>
      fetchTrancheIssuesByLabel('acme/widget', 'vinaya/tranche:small-tranche')
    )
    expect(issues).toEqual([{ number: 1, title: 'task 1', state: 'CLOSED', milestone: null }])
  })

  it('stops at the first short page rather than requesting a page beyond the last one', async () => {
    const page1 = [restIssue(1, 'closed'), restIssue(2, 'closed')]
    const issues = await withPaginatedFakeGh([page1], (calls) => {
      const result = fetchTrancheIssuesByLabel('acme/widget', 'vinaya/tranche:tiny-tranche')
      expect(calls().filter((c) => c.includes('page=2'))).toHaveLength(0)
      return result
    })
    expect(issues).toHaveLength(2)
  })

  it("maps each REST issue's own milestone into the returned ref, or null when unattached", async () => {
    const page1 = [{ ...restIssue(1, 'open'), milestone: { number: 9, title: 'Beta' } }, restIssue(2, 'closed')]
    const issues = await withPaginatedFakeGh([page1], () =>
      fetchTrancheIssuesByLabel('acme/widget', 'vinaya/tranche:milestone-tranche')
    )
    expect(issues.find((i) => i.number === 1)?.milestone).toEqual({ number: 9, title: 'Beta' })
    expect(issues.find((i) => i.number === 2)?.milestone).toBeNull()
  })
})

/**
 * Fakes `gh issue list --milestone <n> --json state --limit <n>` the way
 * the real CLI behaves: a single canned Issue-state array, sliced to
 * whatever `--limit` the call under test asked for — so a fixture proves
 * `fetchMilestoneIssueStates` actually grows its `--limit` across rounds
 * rather than trusting one arbitrary cap.
 */
function withGrowingLimitFakeGh<T>(
  states: Array<'OPEN' | 'CLOSED'>,
  fn: (calls: () => string[]) => Promise<T> | T
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-archive-milestone-fakegh-'))
  const dataPath = join(dir, 'states.json')
  const logPath = join(dir, 'calls.log')
  writeFileSync(dataPath, JSON.stringify(states.map((state) => ({ state }))))
  writeFileSync(logPath, '')
  const script = `#!/usr/bin/env bash
echo "$*" >> "${logPath}"
limit="\${@: -1}"
node -e "const fs=require('fs'); const a=JSON.parse(fs.readFileSync('${dataPath}','utf8')); process.stdout.write(JSON.stringify(a.slice(0, \${limit})))"
`
  const ghPath = join(dir, 'gh')
  writeFileSync(ghPath, script)
  chmodSync(ghPath, 0o755)
  const originalPath = process.env.PATH
  process.env.PATH = `${dir}:${originalPath}`
  return Promise.resolve(
    fn(() =>
      readFileSync(logPath, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    )
  ).finally(() => {
    process.env.PATH = originalPath
    rmSync(dir, { recursive: true, force: true })
  })
}

describe('fetchMilestoneIssueStates — pagination (O4)', () => {
  it('walks every round of a Milestone with 250 Issues, never truncating at the first 100-item `--limit`', async () => {
    // 250 Issues, all closed except the 250th — the exact tail a single
    // `--limit 500`-style cap that happened to undershoot would drop.
    const states: Array<'OPEN' | 'CLOSED'> = [...Array.from({ length: 249 }, () => 'CLOSED' as const), 'OPEN']
    const result = await withGrowingLimitFakeGh(states, () => fetchMilestoneIssueStates('acme/widget', 15))
    expect(result).toHaveLength(250)
    expect(result.filter((i) => i.state === 'OPEN')).toHaveLength(1)
    expect(result.at(-1)?.state).toBe('OPEN')
  })

  it('stops after the first round short of its own `--limit`, never requesting a round beyond the last one', async () => {
    const states: Array<'OPEN' | 'CLOSED'> = ['CLOSED', 'CLOSED']
    const result = await withGrowingLimitFakeGh(states, (calls) => {
      const r = fetchMilestoneIssueStates('acme/widget', 15)
      expect(calls()).toHaveLength(1)
      return r
    })
    expect(result).toHaveLength(2)
  })
})

// The retrospective `archive tranche` appends to the Milestone description
// once a tranche is complete.
describe('roundsForTaskPr', () => {
  it("takes the HIGHEST round marker across a PR's comments", () => {
    const pr = {
      number: 7,
      comments: [
        { body: 'unrelated comment' },
        { body: '<!-- aeg:developer:round-1 -->\nHead: abc' },
        { body: '<!-- aeg:developer:round-3 -->\nHead: def' },
        { body: '<!-- aeg:developer:round-2 -->\nHead: ghi' }
      ]
    }
    expect(roundsForTaskPr(pr)).toBe(3)
  })

  it('defaults to 1 when no round marker is present — merged on the first round', () => {
    expect(roundsForTaskPr({ number: 8, comments: [{ body: 'looks good, merging' }] })).toBe(1)
    expect(roundsForTaskPr({ number: 9, comments: [] })).toBe(1)
  })
})

describe('renderRetrospectiveSection', () => {
  it('renders the task count, rounds per task, and merged PR list under the slug heading', () => {
    const taskPrs = [
      { number: 10, comments: [{ body: '<!-- aeg:developer:round-2 -->' }] },
      { number: 11, comments: [] }
    ]
    const section = renderRetrospectiveSection('my-tranche', taskPrs)
    expect(section).toContain('### Retrospective: my-tranche')
    expect(section).toContain('- Tasks: 2')
    expect(section).toContain('- Rounds per task: #10 (2), #11 (1)')
    expect(section).toContain('- Merged PRs: #10, #11')
  })

  it('renders "none" for a tranche with no merged task PRs', () => {
    const section = renderRetrospectiveSection('empty-tranche', [])
    expect(section).toContain('- Tasks: 0')
    expect(section).toContain('- Rounds per task: none')
    expect(section).toContain('- Merged PRs: none')
  })
})

describe('appendRetrospectiveSection', () => {
  it('appends to a non-empty description, separated by a blank line', () => {
    const result = appendRetrospectiveSection(
      '## Goal\n\nShip the thing.',
      'my-tranche',
      '### Retrospective: my-tranche\n\n- Tasks: 1'
    )
    expect(result).toBe('## Goal\n\nShip the thing.\n\n### Retrospective: my-tranche\n\n- Tasks: 1\n')
  })

  it('appends cleanly to an empty description', () => {
    const result = appendRetrospectiveSection('', 'my-tranche', '### Retrospective: my-tranche\n\n- Tasks: 1')
    expect(result).toBe('### Retrospective: my-tranche\n\n- Tasks: 1\n')
  })

  it('replaces an EXISTING retrospective for the same slug in place — a re-run never duplicates it', () => {
    const description = [
      '## Goal',
      '',
      'Ship the thing.',
      '',
      '### Retrospective: my-tranche',
      '',
      '- Tasks: 1',
      '',
      '### Another section',
      '',
      'Untouched.'
    ].join('\n')
    const result = appendRetrospectiveSection(description, 'my-tranche', '### Retrospective: my-tranche\n\n- Tasks: 2')
    expect(result).toContain('- Tasks: 2')
    expect(result).not.toContain('- Tasks: 1')
    expect(result).toContain('### Another section\n\nUntouched.')
    expect(result.match(/### Retrospective: my-tranche/g)?.length).toBe(1)
  })

  it("never touches a DIFFERENT slug's retrospective section sharing the same Milestone", () => {
    const description = '### Retrospective: sibling-tranche\n\n- Tasks: 5'
    const result = appendRetrospectiveSection(description, 'my-tranche', '### Retrospective: my-tranche\n\n- Tasks: 1')
    expect(result).toContain('### Retrospective: sibling-tranche')
    expect(result).toContain('- Tasks: 5')
    expect(result).toContain('### Retrospective: my-tranche')
    expect(result).toContain('- Tasks: 1')
  })
})

describe('resolveTaskMilestone', () => {
  it('returns the Milestone the first attached Issue carries', () => {
    const m = { number: 15, title: 'Q3 shared milestone' }
    expect(resolveTaskMilestone([issueRef('CLOSED', 1, 'a', m), issueRef('CLOSED', 2, 'b', null)])).toEqual(m)
  })

  it('skips an unattached Issue to find one that does carry a Milestone', () => {
    const m = { number: 15, title: 'Q3 shared milestone' }
    expect(resolveTaskMilestone([issueRef('CLOSED', 1, 'a', null), issueRef('CLOSED', 2, 'b', m)])).toEqual(m)
  })

  it('null when no Issue in the tranche carries a Milestone at all', () => {
    expect(resolveTaskMilestone([issueRef('CLOSED', 1), issueRef('CLOSED', 2)])).toBeNull()
  })
})

// The Milestone `archive tranche` writes into is resolved
// from the tranche's own task Issues, never a Milestone titled exactly the
// slug, and it stays open when the Milestone holds other open work.
function withFakeGhForTranche<T>(
  opts: {
    issues: Array<{
      number: number
      title: string
      state: 'OPEN' | 'CLOSED'
      milestone: { number: number; title: string } | null
    }>
    milestone: { number: number; title: string; description: string | null }
    milestoneIssueStates: Array<'OPEN' | 'CLOSED'>
  },
  fn: (patchedBody: () => Record<string, unknown> | null) => Promise<T>
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-archive-tranche-fakegh-'))
  const issuesPath = join(dir, 'issues.json')
  const restIssuesPath = join(dir, 'rest-issues.json')
  const milestonePath = join(dir, 'milestone.json')
  const milestoneIssuesPath = join(dir, 'milestone-issues.json')
  const patchedPath = join(dir, 'patched.json')
  writeFileSync(issuesPath, JSON.stringify(opts.issues))
  // `fetchTrancheIssuesByLabel` reads the REST `issues?labels=` endpoint, not
  // `gh issue list` — lowercase `state`, same `milestone` shape.
  writeFileSync(restIssuesPath, JSON.stringify(opts.issues.map((i) => ({ ...i, state: i.state.toLowerCase() }))))
  writeFileSync(milestonePath, JSON.stringify(opts.milestone))
  writeFileSync(milestoneIssuesPath, JSON.stringify(opts.milestoneIssueStates.map((state) => ({ state }))))
  const script = `#!/usr/bin/env bash
case "$*" in
  *"-X PATCH"*"/milestones/"*)
    cat > "${patchedPath}"
    ;;
  "issue list"*"--milestone"*)
    limit="\${@: -1}"
    node -e "const fs=require('fs'); const a=JSON.parse(fs.readFileSync('${milestoneIssuesPath}','utf8')); process.stdout.write(JSON.stringify(a.slice(0, \${limit})))"
    ;;
  *"/milestones/"*)
    cat "${milestonePath}"
    ;;
  "api "*"/issues?"*"labels="*)
    cat "${restIssuesPath}"
    ;;
  "issue list"*)
    cat "${issuesPath}"
    ;;
  "pr list"*)
    echo '[]'
    ;;
  *)
    exit 1
    ;;
esac
`
  const ghPath = join(dir, 'gh')
  writeFileSync(ghPath, script)
  chmodSync(ghPath, 0o755)
  const originalPath = process.env.PATH
  process.env.PATH = `${dir}:${originalPath}`
  return fn(() => {
    try {
      return JSON.parse(readFileSync(patchedPath, 'utf8'))
    } catch {
      return null
    }
  }).finally(() => {
    process.env.PATH = originalPath
    rmSync(dir, { recursive: true, force: true })
  })
}

describe('runArchiveTranche — Milestone resolved from the tasks, not a same-titled Milestone (O7)', () => {
  it('closes the Milestone when every Issue it holds is closed', async () => {
    await withFakeGhForTranche(
      {
        issues: [
          { number: 1, title: 'task one', state: 'CLOSED', milestone: { number: 15, title: 'Shared Milestone' } },
          { number: 2, title: 'task two', state: 'CLOSED', milestone: { number: 15, title: 'Shared Milestone' } }
        ],
        milestone: { number: 15, title: 'Shared Milestone', description: null },
        milestoneIssueStates: ['CLOSED', 'CLOSED']
      },
      async (patchedBody) => {
        const exit = await runArchiveTranche(['my-tranche', '--yes'], archiveDeps())
        expect(exit).toBe(0)
        const patched = patchedBody()
        expect(patched?.state).toBe('closed')
        expect(String(patched?.description)).toContain('### Retrospective: my-tranche')
      }
    )
  })

  it('leaves the Milestone open, but still records the retrospective, when another task in it is still open', async () => {
    await withFakeGhForTranche(
      {
        issues: [
          { number: 1, title: 'task one', state: 'CLOSED', milestone: { number: 15, title: 'Shared Milestone' } }
        ],
        milestone: { number: 15, title: 'Shared Milestone', description: null },
        milestoneIssueStates: ['CLOSED', 'OPEN']
      },
      async (patchedBody) => {
        const exit = await runArchiveTranche(['my-tranche', '--yes'], archiveDeps())
        expect(exit).toBe(0)
        const patched = patchedBody()
        expect(patched?.state).toBeUndefined()
        expect(String(patched?.description)).toContain('### Retrospective: my-tranche')
      }
    )
  })

  it('closes the Milestone with a hundred other Issues attached, all closed — the field-selecting fetch never chokes on a large Milestone', async () => {
    await withFakeGhForTranche(
      {
        issues: [
          { number: 1, title: 'task one', state: 'CLOSED', milestone: { number: 15, title: 'Shared Milestone' } }
        ],
        milestone: { number: 15, title: 'Shared Milestone', description: null },
        milestoneIssueStates: Array.from({ length: 100 }, () => 'CLOSED')
      },
      async (patchedBody) => {
        const exit = await runArchiveTranche(['my-tranche', '--yes'], archiveDeps())
        expect(exit).toBe(0)
        const patched = patchedBody()
        expect(patched?.state).toBe('closed')
      }
    )
  })

  it('leaves the Milestone open with a hundred other Issues attached, one still open', async () => {
    await withFakeGhForTranche(
      {
        issues: [
          { number: 1, title: 'task one', state: 'CLOSED', milestone: { number: 15, title: 'Shared Milestone' } }
        ],
        milestone: { number: 15, title: 'Shared Milestone', description: null },
        milestoneIssueStates: [...Array.from({ length: 99 }, () => 'CLOSED' as const), 'OPEN']
      },
      async (patchedBody) => {
        const exit = await runArchiveTranche(['my-tranche', '--yes'], archiveDeps())
        expect(exit).toBe(0)
        const patched = patchedBody()
        expect(patched?.state).toBeUndefined()
      }
    )
  })
})
