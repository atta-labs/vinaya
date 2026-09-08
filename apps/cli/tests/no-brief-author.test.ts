import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'bun:test'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')

/**
 * `brief-author` is retired as a role id — `author-the-brief` is
 * `performedBy: ['planner']`, the `needs-brief-correction` label and the
 * generated `/vinaya` command text both name the Planner, and
 * `vinaya doctrine --role brief-author` refuses (plan-brief-v1 task 3,
 * #428). This test is O1's own mechanical enforcement: any source file
 * under a scanned root that still names the retired role fails it.
 *
 * Excluded, deliberately:
 * - `*.test.ts` (co-located tests under `src/`) — several embed real,
 *   historical, byte-for-byte quoted fixture data (a real GitHub Issue
 *   body, a real token-ledger fixture) that legitimately still contains the
 *   retired name. Scrubbing those would corrupt the fixture, not fix a live
 *   reference — the same reasoning that keeps a package's own tests/fixtures
 *   directory (and apps/cli's) untouched. A test asserting real CURRENT
 *   behavior around the retirement (doctrine.test.ts's
 *   `--role brief-author` refusal) lives under apps/cli/tests, outside
 *   this scan's roots entirely.
 * - `apps/cli/src/commands/doctrine.ts` — the one file that must keep
 *   naming the retired role, in order to refuse a request for it and point
 *   the caller at `planner`.
 * - `apps/cli/src/lib/dispatch-task.ts` — quotes `aeg-root/process.md`'s own
 *   Phase 5 verbatim, and `aeg-root/**` is out of this task's surface (task
 *   4's doctrine rewrite); editing the quote to disagree with the doctrine
 *   it quotes would be the actual regression.
 */
const SCAN_ROOTS = ['packages/aeg-core/src', 'packages/aeg-forge-state/src', 'packages/aeg-types/src', 'apps/cli/src']

const ALLOWLISTED_FILES = new Set([
  'apps/cli/src/commands/doctrine.ts',
  'apps/cli/src/lib/dispatch-task.ts',
  // The retirement DECLARATION itself (`RETIRED_ROLE_NAMES`). Retiring a
  // role means naming it exactly once, in the place that states it is
  // retired — the alternative is inferring retirement from a role file's
  // absence, which is the bug this task fixed: the file deliberately
  // outlives the code, so absence proves nothing.
  'apps/cli/src/lib/agents-skills-emitter.ts'
])

const NAME_PATTERN = /\bbrief[- ]author\b/i

function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(p))
    } else if (entry.isFile() && p.endsWith('.ts') && !p.endsWith('.test.ts')) {
      out.push(p)
    }
  }
  return out
}

describe('no-brief-author — brief-author is retired as a role id (plan-brief-v1 task 3, #428)', () => {
  it('no source file under packages/*/src or apps/cli/src names brief-author, except the doctrine refusal itself', () => {
    const offenders: string[] = []
    for (const root of SCAN_ROOTS) {
      for (const file of listSourceFiles(join(REPO_ROOT, root))) {
        const rel = relative(REPO_ROOT, file)
        if (ALLOWLISTED_FILES.has(rel)) continue
        const content = readFileSync(file, 'utf8')
        if (NAME_PATTERN.test(content)) offenders.push(rel)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the retirement declaration still names it — the allowlist entry is load-bearing, not a blanket exemption', () => {
    const content = readFileSync(join(REPO_ROOT, 'apps/cli/src/lib/agents-skills-emitter.ts'), 'utf8')
    expect(content).toContain('RETIRED_ROLE_NAMES')
    expect(content).toContain('brief-author')
  })

  it('the allowlisted doctrine.ts still legitimately names it — this test goes stale (not silently vacuous) the day it stops', () => {
    const content = readFileSync(join(REPO_ROOT, 'apps/cli/src/commands/doctrine.ts'), 'utf8')
    expect(content).toMatch(NAME_PATTERN)
  })
})
