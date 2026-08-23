import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Regression coverage for aeg-governance-hardening task 21 (#351) —
 * `currentFindingCounts()` previously fed `verify-docs`/`verify-coherence`
 * through `sh()`/`shJson()`, which swallow ANY non-zero exit to `''`/`null`.
 * Both tools exit non-zero exactly when findings exist, so the baseline
 * silently reported 0 in the one case it was supposed to catch. This mocks
 * `node:child_process`'s `spawnSync` (the array-form, no-shell primitive
 * `captureStreams` uses since `tranche-rename-v1` task 2) to exercise
 * every observable outcome without needing the real tools to be in a
 * specific state.
 */

const spawnSyncMock = vi.fn()

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawnSync: (...args: unknown[]) => spawnSyncMock(...args) }
})

const { currentFindingCounts } = await import('./verify-dispatch')

beforeEach(() => {
  spawnSyncMock.mockReset()
})

function successResult(stdout: string, status = 0): { stdout: string; stderr: string; status: number } {
  return { stdout, stderr: '', status }
}

function failureResult(stdout: string, status = 1): { stdout: string; stderr: string; status: number } {
  return { stdout, stderr: '', status }
}

function spawnFailureResult(): { error: Error; stdout: null; stderr: null; status: null } {
  // No `.stdout` at all — simulates a spawn failure (e.g. ENOENT), never a
  // captured non-zero exit. Must not be confused with "0 findings."
  return { error: new Error('spawn bun ENOENT'), stdout: null, stderr: null, status: null }
}

describe('currentFindingCounts', () => {
  it('(a) reports 0 when both tools exit 0 with no findings', () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('packages/aeg-core/bin/verify-docs.ts'))
        return successResult('verify-docs passed (full mode).\n')
      if (args.includes('packages/aeg-core/bin/verify-coherence.ts')) {
        return successResult(JSON.stringify({ summary: { passed: 5, failed: 0, info: 0 } }))
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`)
    })

    expect(currentFindingCounts()).toEqual([
      { tool: 'verify-docs-full', findingCount: 0, unavailable: false },
      { tool: 'verify-coherence', findingCount: 0, unavailable: false }
    ])
  })

  it('(b) counts real findings from a non-zero exit — the bug this task fixes', () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('packages/aeg-core/bin/verify-docs.ts')) {
        return failureResult(
          [
            '',
            'verify-docs FAILED (full mode) — 3 issue(s):',
            '',
            '  ✗ finding one',
            '  ✗ finding two',
            '  ✗ finding three',
            ''
          ].join('\n')
        )
      }
      if (args.includes('packages/aeg-core/bin/verify-coherence.ts')) {
        return failureResult(JSON.stringify({ summary: { passed: 2, failed: 4, info: 0 } }))
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`)
    })

    expect(currentFindingCounts()).toEqual([
      { tool: 'verify-docs-full', findingCount: 3, unavailable: false },
      { tool: 'verify-coherence', findingCount: 4, unavailable: false }
    ])
  })

  /**
   * atta-labs/vinaya#173. `captureStreams` used to concatenate stdout and
   * stderr before parsing, on the stated premise that neither tool writes to
   * stderr on its clean `--json` path. `verify-coherence` does: it probes
   * `aeg-root/tranches` off the base ref, the forge-native cutover deleted
   * those directories, and `git` prints a `fatal:` line per probe while the
   * tool itself exits 0 with correct results. One such line made `JSON.parse`
   * throw and the baseline reported UNAVAILABLE on EVERY dispatch check.
   */
  it('(#173) a healthy verify-coherence that also writes to stderr is NOT unavailable', () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('packages/aeg-core/bin/verify-docs.ts')) return successResult('')
      if (args.includes('packages/aeg-core/bin/verify-coherence.ts')) {
        return {
          stdout: JSON.stringify({ summary: { passed: 10, failed: 0, info: 6 } }),
          stderr: [
            'fatal: Not a valid object name origin/main:aeg-root/tranches',
            "fatal: path 'aeg-root/tranches/x.md' does not exist in 'origin/main'",
            ''
          ].join('\n'),
          status: 0
        }
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`)
    })

    expect(currentFindingCounts()).toEqual([
      { tool: 'verify-docs-full', findingCount: 0, unavailable: false },
      { tool: 'verify-coherence', findingCount: 0, unavailable: false }
    ])
  })

  it('(#173) stderr noise does not hide a REAL finding count either', () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('packages/aeg-core/bin/verify-docs.ts')) return successResult('')
      if (args.includes('packages/aeg-core/bin/verify-coherence.ts')) {
        return {
          stdout: JSON.stringify({ summary: { passed: 2, failed: 4, info: 0 } }),
          stderr: 'fatal: Not a valid object name origin/main:aeg-root/tranches\n',
          status: 1
        }
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`)
    })

    expect(currentFindingCounts()).toEqual([
      { tool: 'verify-docs-full', findingCount: 0, unavailable: false },
      { tool: 'verify-coherence', findingCount: 4, unavailable: false }
    ])
  })

  // Non-discriminating by construction — it passes under the old concatenating
  // code too, and is not among the mutation-proof failures. Kept deliberately
  // as a REGRESSION GUARD: splitting the streams removed the accidental
  // fail-closed that any stderr byte used to provide, and this pins that the
  // deliberate one replaced it.
  it('(#173) a genuinely unparseable stdout is still UNAVAILABLE — the signal is not lost', () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('packages/aeg-core/bin/verify-docs.ts')) return successResult('')
      if (args.includes('packages/aeg-core/bin/verify-coherence.ts')) {
        return { stdout: 'Segmentation fault', stderr: 'fatal: something else\n', status: 139 }
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`)
    })

    const coherence = currentFindingCounts().find((f) => f.tool === 'verify-coherence')
    expect(coherence).toEqual({ tool: 'verify-coherence', findingCount: 0, unavailable: true })
  })

  /**
   * These ARE discriminating, and they are the ones the split made necessary.
   * Concatenated stderr used to make every stdout unparseable, so valid JSON of
   * the WRONG shape never reached the property access. Once stdout is parsed
   * alone, `{}` or a scalar parses fine and `summary.failed` throws a
   * TypeError — a crash where a clean UNAVAILABLE belongs.
   */
  it.each([
    ['a JSON scalar', '0'],
    ['a JSON string', '"done"'],
    ['an array', '[]'],
    ['an object with no summary', '{}'],
    ['a summary with no failed', '{"summary":{"passed":3}}'],
    ['a non-numeric failed', '{"summary":{"failed":"three"}}'],
    ['null', 'null']
  ])('(#173) %s on stdout is UNAVAILABLE, not a crash and not a 0 count', (_label, payload) => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('packages/aeg-core/bin/verify-docs.ts')) return successResult('')
      if (args.includes('packages/aeg-core/bin/verify-coherence.ts')) {
        return { stdout: payload, stderr: '', status: 0 }
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`)
    })

    const coherence = currentFindingCounts().find((f) => f.tool === 'verify-coherence')
    expect(coherence).toEqual({ tool: 'verify-coherence', findingCount: 0, unavailable: true })
  })

  it('(c) reports UNAVAILABLE, never 0, when a tool cannot run at all (spawn failure)', () => {
    spawnSyncMock.mockImplementation(() => spawnFailureResult())

    expect(currentFindingCounts()).toEqual([
      { tool: 'verify-docs-full', findingCount: 0, unavailable: true },
      { tool: 'verify-coherence', findingCount: 0, unavailable: true }
    ])
  })

  it('(c) reports UNAVAILABLE for verify-coherence when --json output is a crash, not a report', () => {
    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('packages/aeg-core/bin/verify-docs.ts')) {
        return successResult('verify-docs passed (full mode).\n')
      }
      return failureResult('TypeError: Cannot read properties of undefined\n    at runCoherenceChecks (...)')
    })

    const result = currentFindingCounts()

    expect(result.find((r) => r.tool === 'verify-coherence')).toEqual({
      tool: 'verify-coherence',
      findingCount: 0,
      unavailable: true
    })
  })

  it('(c) reports UNAVAILABLE for verify-docs when a non-zero exit produces no ✗ lines (crash, not a real 0)', () => {
    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('packages/aeg-core/bin/verify-coherence.ts')) {
        return successResult(JSON.stringify({ summary: { passed: 1, failed: 0, info: 0 } }))
      }
      return failureResult('Segmentation fault\n')
    })

    const result = currentFindingCounts()

    expect(result.find((r) => r.tool === 'verify-docs-full')).toEqual({
      tool: 'verify-docs-full',
      findingCount: 0,
      unavailable: true
    })
  })
})

describe('(d) sh()/shJson() other call sites are untouched', () => {
  const src = readFileSync(join(import.meta.dirname, 'verify-dispatch.ts'), 'utf8')

  it("sh()'s throw-and-swallow-to-'' contract is unchanged, array-form signature", () => {
    const shBody = src.match(/function sh\(cmd: string, args: string\[]\): string \{[\s\S]*?\n\}\n/)
    expect(shBody).not.toBeNull()
    expect(shBody?.[0]).toContain("stdio: ['ignore', 'pipe', 'ignore']")
    expect(shBody?.[0]).toContain("return ''")
    // Array-form execFileSync — no shell, no injection surface (task 2, #671).
    expect(shBody?.[0]).toContain('execFileSync(cmd, args,')
  })

  it('every other sh()/shJson() call site (git, gh) still uses the original helpers, not the new one', () => {
    for (const needle of [
      "sh('git', ['ls-remote', '--heads', 'origin', branch])",
      "sh('git', ['fetch', 'origin', branch, '--quiet'])",
      "sh('git', ['log', '-1', '--format=%cI'])",
      "'issue',\n    'view',",
      "'--json',\n    'number,state,body,labels'",
      "'--json',\n      'number,headRefName,state,mergedAt',"
    ]) {
      expect(src).toContain(needle)
    }
    // The capture helper is scoped to currentFindingCounts's two tool
    // invocations only — defined once, called exactly twice.
    const occurrences = src.split('captureStreams(').length - 1
    expect(occurrences).toBe(3)
    // #173: the two streams must stay apart. A concatenation here is what made
    // one `fatal:` line from a healthy `verify-coherence` read as UNAVAILABLE.
    expect(src).not.toContain("(result.stdout ?? '') + (result.stderr ?? '')")
    // The coherence payload is PARSED, so it must read stdout and never stderr.
    // Asserted on the call, not on a type argument, so refactoring the parser
    // does not silently retire the guard.
    expect(src).toContain('coherenceFailedCount(coherence.stdout)')
    expect(src).not.toContain('coherence.stderr')
    // verify-docs is line-COUNTED, and writes its `✗` findings to stderr
    // (`console.error`), so scanning both streams there is required — a
    // stdout-only read would report zero findings forever.
    expect(src).toContain('docs.stdout')
    expect(src).toContain('docs.stderr')
  })
})

/**
 * aeg-governance-hardening task 23 (#360) — `resolvePriorTrancheArchival`'s
 * `gh issue list` called with no explicit repo target, which silently returns
 * `[]` from a linked worktree checkout (the only environment this script runs
 * in during real dispatch) even when real open Issues exist. Reproduced live
 * 2026-07-04: `[]` vs 4 real Issues, same worktree, same instant. Every other
 * `gh` call in the file (`ghIssueView`, `fetchTrancheBranchPrs`) had the
 * identical gap. This is a structural, source-scanning test (not a live `gh`
 * mock) because live `gh` is unmockable cheaply — same style as the `(d)`
 * suite above and task 21's `sh()`/`shJson()` call-site assertions.
 *
 * Updated for the array-form `execFileSync` conversion (task 2, #671): the
 * repo target is now the array element right after `'-R'`, not a template
 * segment inside a single command string.
 */
describe('(e) every gh invocation carries an explicit repo target (Part 1, task 23, #360)', () => {
  const src = readFileSync(join(import.meta.dirname, 'verify-dispatch.ts'), 'utf8')

  it("every 'gh' call passed to sh()/shJson() carries '-R', a repo template segment", () => {
    const callPattern = /\('gh',\s*\[([\s\S]*?)\]\)/g
    const ghCommands: string[] = []
    let match: RegExpExecArray | null
    // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
    while ((match = callPattern.exec(src)) !== null) {
      ghCommands.push(match[1] as string)
    }
    // Fails loud if the gh calls this test targets ever get refactored away
    // from sh()/shJson() (e.g. to execFileSync directly) without updating this scan.
    expect(ghCommands.length).toBe(3)
    for (const argsText of ghCommands) {
      expect(argsText).toContain("'-R'")
      expect(argsText).toMatch(/`\$\{repo\.owner\}\/\$\{repo\.repo\}`/)
    }
  })
})
