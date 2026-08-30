import { parseTokensLines } from '@attalabs/aeg-core'
import type { MeteringCapability } from '@attalabs/aeg-core'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ArchiveDeps } from '../src/commands/archive.js'
import {
  renderArchiveTokensLine,
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

// rings.ring2_asyncAudits is additive, never disabling (Issue #45's
// 2026-08-25 Amendment): `false`/absent is a no-op — every pre-existing
// `vinaya init` starter config reads `false` here, so the Archivist's real
// work must keep running unconditionally. `true` is the new opt-in
// accelerator that skips it.
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

  it('`true` skips real work entirely — never even calls detectRepo', async () => {
    writeConfig({ rings: { ring1_forgeWriteInterception: false, ring2_asyncAudits: true } })
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

  it('`false` is a no-op — real work still runs (fails pre-flight the same as before the flag existed)', async () => {
    writeConfig({ rings: { ring1_forgeWriteInterception: false, ring2_asyncAudits: false } })
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
  title = 'a task'
): { number: number; title: string; state: 'OPEN' | 'CLOSED' } {
  return { number, title, state }
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
