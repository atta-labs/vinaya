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
// issue-545, O3 — `checkBareEdgeQualification` (and the `tranchesAttachedToMilestone`
// it calls, in `@attalabs/aeg-forge-state`) shell out via `execFileSync`, not
// `spawnSync` — stubbed here alongside it so those tests never touch a real
// `gh` invocation. Unmocked by default (each test below sets its own
// `mockImplementation`); a call this suite's own currentFindingCounts/
// resolvePremiseBriefText tests never make.
const execFileSyncMock = vi.fn()

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args)
  }
})

const { checkBareEdgeQualification, currentFindingCounts, resolvePremiseBriefText } = await import('./verify-dispatch')

beforeEach(() => {
  spawnSyncMock.mockReset()
  execFileSyncMock.mockReset()
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

    // The noise is both non-fatal AND surfaced — dropping it on the floor is
    // the defect PR #179 found in the first cut of this fix.
    expect(currentFindingCounts()).toEqual([
      { tool: 'verify-docs-full', findingCount: 0, unavailable: false },
      {
        tool: 'verify-coherence',
        findingCount: 0,
        unavailable: false,
        diagnostic: 'fatal: Not a valid object name origin/main:aeg-root/tranches'
      }
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
      {
        tool: 'verify-coherence',
        findingCount: 4,
        unavailable: false,
        diagnostic: 'fatal: Not a valid object name origin/main:aeg-root/tranches'
      }
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
    expect(coherence).toEqual({
      tool: 'verify-coherence',
      findingCount: 0,
      unavailable: true,
      diagnostic: 'fatal: something else'
    })
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
      "'--json',\n    'number,state,body,labels,milestone'",
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
    // The coherence payload is PARSED, so the PARSE must read stdout alone.
    // Asserted on the call, not on a type argument, so refactoring the parser
    // does not silently retire the guard.
    expect(src).toContain('coherenceFailedCount(coherence.stdout)')
    // Deliberately NOT `not.toContain('coherence.stderr')`. That was the first
    // shape of this guard and it was too blunt: the property is "stderr never
    // reaches the parse", not "stderr is never read". Stated as the former, it
    // forbade the diagnostic that PR #179 added — a `verify-coherence` stderr
    // line an operator needs to see — and so pinned a real gap in place.
    // The parse is guarded by the assertion above; these forbid the two ways
    // stderr could get back INTO it.
    expect(src).not.toContain('coherenceFailedCount(coherence.stderr)')
    expect(src).not.toContain('coherence.stdout}${coherence.stderr')
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
    // 4, not 3: `runPremiseModeFromIssue`'s `gh issue view --json comments`
    // call (plan-brief-v1 task 2, #427) is the fourth.
    expect(ghCommands.length).toBe(4)
    for (const argsText of ghCommands) {
      expect(argsText).toContain("'-R'")
      expect(argsText).toMatch(/`\$\{repo\.owner\}\/\$\{repo\.repo\}`/)
    }
  })
})

/**
 * PR #179 review: splitting the streams stopped stderr corrupting the parse,
 * and in doing so meant nothing read stderr at all — so a `verify-coherence`
 * diagnostic (an unresolvable ref, say) was captured by the caller and dropped.
 * A diagnostic that reaches no operator is not a diagnostic.
 */
describe("(#179) the baseline carries the child's diagnostic", () => {
  it('surfaces stderr from a coherence run that otherwise SUCCEEDED', () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('packages/aeg-core/bin/verify-docs.ts')) return successResult('')
      if (args.includes('packages/aeg-core/bin/verify-coherence.ts')) {
        return {
          stdout: JSON.stringify({ summary: { passed: 10, failed: 0, info: 6 } }),
          stderr: '[verify-coherence] ref "deadbeef" does not resolve — input incomplete\n',
          status: 0
        }
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`)
    })

    const coherence = currentFindingCounts().find((f) => f.tool === 'verify-coherence')
    expect(coherence?.unavailable).toBe(false)
    expect(coherence?.diagnostic).toContain('does not resolve')
  })

  it('carries the reason a tool is unavailable, not just the fact', () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('packages/aeg-core/bin/verify-docs.ts')) return successResult('')
      if (args.includes('packages/aeg-core/bin/verify-coherence.ts')) {
        return { stdout: 'Segmentation fault', stderr: 'bun: fatal error\n', status: 139 }
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`)
    })

    const coherence = currentFindingCounts().find((f) => f.tool === 'verify-coherence')
    expect(coherence?.unavailable).toBe(true)
    expect(coherence?.diagnostic).toBe('bun: fatal error')
  })

  it('does not echo a verify-docs finding as a diagnostic on a clean run', () => {
    // verify-docs writes its own `✗` findings to stderr, so an unconditional
    // diagnostic there would report every ordinary finding as an error.
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('packages/aeg-core/bin/verify-docs.ts')) {
        return { stdout: '', stderr: '  ✗ a real finding\n', status: 1 }
      }
      if (args.includes('packages/aeg-core/bin/verify-coherence.ts')) {
        return { stdout: JSON.stringify({ summary: { failed: 0 } }), stderr: '', status: 0 }
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`)
    })

    const docs = currentFindingCounts().find((f) => f.tool === 'verify-docs-full')
    expect(docs).toEqual({ tool: 'verify-docs-full', findingCount: 1, unavailable: false })
  })
})

describe('(#179) the shape guard rejects a number that is not a count', () => {
  it.each([
    ['a negative failed', '{"summary":{"failed":-1}}'],
    ['an overflowing failed', '{"summary":{"failed":1e999}}']
  ])('%s is UNAVAILABLE, not a count', (_label, payload) => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('packages/aeg-core/bin/verify-docs.ts')) return successResult('')
      if (args.includes('packages/aeg-core/bin/verify-coherence.ts')) {
        return { stdout: payload, stderr: '', status: 0 }
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`)
    })

    const coherence = currentFindingCounts().find((f) => f.tool === 'verify-coherence')
    expect(coherence?.unavailable).toBe(true)
    expect(coherence?.findingCount).toBe(0)
  })
})

/**
 * PR #179 security review, MEDIUM. A forge-degraded `verify-coherence` run
 * reports a SMALLER `failed` count, honestly arrived at from the tranches it
 * could see. Read as a finding count it under-reports, and `--check-baseline`
 * would compare it as if it were complete.
 *
 * Splitting the streams removed an accidental fail-closed here: an outage also
 * printed to stderr, so the old concatenated parse threw and the tool read as
 * unavailable. This pins the deliberate replacement.
 */
describe('(#179) a forge-degraded coherence sweep is UNAVAILABLE, not a small count', () => {
  it('rejects a report flagged forgeUnavailable even though its shape is valid', () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('packages/aeg-core/bin/verify-docs.ts')) return successResult('')
      if (args.includes('packages/aeg-core/bin/verify-coherence.ts')) {
        return {
          stdout: JSON.stringify({ forgeUnavailable: true, summary: { passed: 2, failed: 1, info: 0 } }),
          stderr: '',
          status: 1
        }
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`)
    })

    const coherence = currentFindingCounts().find((f) => f.tool === 'verify-coherence')
    // Not `findingCount: 1` — that number is real but incomplete, and the
    // whole point of `unavailable` is that it is never compared as a count.
    // The diagnostic must say the tool RAN: `fetchForgeFacts`'s reason never
    // reaches stderr, so without it the operator reads "failed to run" for a
    // run that succeeded.
    expect(coherence?.unavailable).toBe(true)
    expect(coherence?.findingCount).toBe(0)
    expect(coherence?.diagnostic).toContain('could not reach the forge')
    expect(coherence?.diagnostic).toContain('incomplete, not clean')
  })

  it('accepts the same report when the forge WAS reachable', () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('packages/aeg-core/bin/verify-docs.ts')) return successResult('')
      if (args.includes('packages/aeg-core/bin/verify-coherence.ts')) {
        return {
          stdout: JSON.stringify({ forgeUnavailable: false, summary: { passed: 2, failed: 1, info: 0 } }),
          stderr: '',
          status: 1
        }
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`)
    })

    const coherence = currentFindingCounts().find((f) => f.tool === 'verify-coherence')
    expect(coherence).toEqual({ tool: 'verify-coherence', findingCount: 1, unavailable: false })
  })
})

describe('(#179) a diagnostic that is cut says so', () => {
  it('marks a truncated line instead of ending mid-token', () => {
    const long = `x${'y'.repeat(400)}`
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('packages/aeg-core/bin/verify-docs.ts')) return successResult('')
      if (args.includes('packages/aeg-core/bin/verify-coherence.ts')) {
        return { stdout: JSON.stringify({ summary: { failed: 0 } }), stderr: `${long}\n`, status: 0 }
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`)
    })

    const coherence = currentFindingCounts().find((f) => f.tool === 'verify-coherence')
    expect(coherence?.diagnostic).toMatch(/… \(truncated\)$/)
    expect(coherence?.diagnostic?.length).toBeLessThan(long.length)
  })

  it('leaves a short line untouched', () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('packages/aeg-core/bin/verify-docs.ts')) return successResult('')
      if (args.includes('packages/aeg-core/bin/verify-coherence.ts')) {
        return { stdout: JSON.stringify({ summary: { failed: 0 } }), stderr: 'short line\n', status: 0 }
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`)
    })

    expect(currentFindingCounts().find((f) => f.tool === 'verify-coherence')?.diagnostic).toBe('short line')
  })
})

/** The one previously-untested arm: verify-docs shows a diagnostic ONLY when unavailable. */
describe('(#179) verify-docs surfaces its stderr only when unavailable', () => {
  it('carries the reason when a non-zero exit produced no findings (a crash)', () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('packages/aeg-core/bin/verify-docs.ts')) {
        return { stdout: '', stderr: 'bun: cannot find module\n', status: 1 }
      }
      if (args.includes('packages/aeg-core/bin/verify-coherence.ts')) {
        return { stdout: JSON.stringify({ summary: { failed: 0 } }), stderr: '', status: 0 }
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`)
    })

    const docs = currentFindingCounts().find((f) => f.tool === 'verify-docs-full')
    expect(docs).toEqual({
      tool: 'verify-docs-full',
      findingCount: 0,
      unavailable: true,
      diagnostic: 'bun: cannot find module'
    })
  })
})

/** The forge-outage reason explains the verdict; a stderr line only accompanies it. */
describe('(#179) an outage reason outranks an incidental stderr line', () => {
  it('reports the outage, not the probe noise, when both are present', () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('packages/aeg-core/bin/verify-docs.ts')) return successResult('')
      if (args.includes('packages/aeg-core/bin/verify-coherence.ts')) {
        return {
          stdout: JSON.stringify({ forgeUnavailable: true, summary: { failed: 0 } }),
          stderr: 'fatal: Not a valid object name origin/main:aeg-root/tranches\n',
          status: 1
        }
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`)
    })

    const coherence = currentFindingCounts().find((f) => f.tool === 'verify-coherence')
    expect(coherence?.diagnostic).toContain('could not reach the forge')
    expect(coherence?.diagnostic).not.toContain('Not a valid object name')
  })
})

/**
 * task 4, Issue #483, O3 — `resolvePremiseBriefText` is `--premise`'s
 * Issue-derived mode's own resolver, extracted so it never needs a spawned
 * `gh`/forge fixture to test (security review, PR #503 round 2, BLOCKER:
 * this exact seam previously matched only the literal `aeg:brief:v1` marker,
 * so `--premise` hard-refused every dispatch of a task whose brief had been
 * corrected via `--supersede` — precisely the scenario that flag exists for).
 */
describe('resolvePremiseBriefText (security review, PR #503 round 2, BLOCKER)', () => {
  const PRINCIPAL = 'daniboomerang'

  it('resolves a plain v1 frozen brief', () => {
    const comments = [
      { body: '<!-- aeg:brief:v1 -->\nBrief hash: abc\nOriginal brief text.', author: { login: PRINCIPAL } }
    ]
    const result = resolvePremiseBriefText(comments, 483)
    expect(result).toEqual({ ok: true, text: 'Original brief text.' })
  })

  it('resolves the NEWEST version after --supersede, never the superseded v1', () => {
    const comments = [
      { body: '<!-- aeg:brief:v1 -->\nBrief hash: abc\nWrong tier, wrong file.', author: { login: PRINCIPAL } },
      {
        body: '<!-- aeg:brief:v2 -->\nBrief hash: def\nSupersedes: url — wrong tier\nCorrected brief text.',
        author: { login: PRINCIPAL }
      }
    ]
    const result = resolvePremiseBriefText(comments, 483)
    expect(result).toEqual({ ok: true, text: 'Corrected brief text.' })
  })

  it('refuses (never falls back to a forged comment) when the only frozen-brief-shaped comment is not principal-authored', () => {
    const comments = [
      { body: '<!-- aeg:brief:v1 -->\nBrief hash: abc\nForged brief.', author: { login: 'an-impostor' } }
    ]
    const result = resolvePremiseBriefText(comments, 483)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toMatch(/not dispatched.*no `aeg:brief:v<k>` comment on Issue #483/)
  })

  it('refuses naming the Issue number when there is no frozen brief at all', () => {
    const result = resolvePremiseBriefText([], 999)
    expect(result).toEqual({ ok: false, message: 'not dispatched — no `aeg:brief:v<k>` comment on Issue #999.' })
  })

  it('a missing `author` field (a bot-posted comment) is treated as unauthored, never as principal', () => {
    const comments = [{ body: '<!-- aeg:brief:v1 -->\nBrief hash: abc\nBot-posted.' }]
    const result = resolvePremiseBriefText(comments, 483)
    expect(result.ok).toBe(false)
  })
})

// issue-545, O3 — real end-to-end wiring: `verify-dispatch`'s gate now
// refuses a bare edge id once its Issue's Milestone holds two or more
// tranches (review round 2, BLOCKER 2 — `requireTrancheQualifiedEdges` was
// implemented and unit-tested but never called from a real gate).
describe('checkBareEdgeQualification', () => {
  const REPO = { owner: 'atta-labs', repo: 'vinaya' }

  it('is a no-op with no Milestone at all — never calls the forge', () => {
    expect(checkBareEdgeQualification(['1'], [], null, REPO)).toBeNull()
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })

  it('is a no-op when the Milestone holds only one tranche — the ordinary case', () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (
        cmd === 'gh' &&
        args[0] === 'api' &&
        args[1] === 'repos/atta-labs/vinaya/issues?milestone=9&state=all&per_page=100'
      ) {
        return JSON.stringify([{ labels: [{ name: 'vinaya/tranche:solo-tranche' }] }])
      }
      throw new Error(`unmocked execFileSync: ${cmd} ${args?.join(' ')}`)
    })
    expect(checkBareEdgeQualification(['1'], [], { number: 9, title: 'solo' }, REPO)).toBeNull()
  })

  it('refuses a bare id once the Milestone holds two or more tranches, naming the token and both tranches', () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (
        cmd === 'gh' &&
        args[0] === 'api' &&
        args[1] === 'repos/atta-labs/vinaya/issues?milestone=9&state=all&per_page=100'
      ) {
        return JSON.stringify([
          { labels: [{ name: 'vinaya/tranche:tranche-a' }] },
          { labels: [{ name: 'vinaya/tranche:tranche-b' }] }
        ])
      }
      throw new Error(`unmocked execFileSync: ${cmd} ${args?.join(' ')}`)
    })
    const result = checkBareEdgeQualification(['1'], [], { number: 9, title: 'shared' }, REPO)
    expect(result).not.toBeNull()
    expect(result).toContain('`1`')
    expect(result).toContain('tranche-a')
    expect(result).toContain('tranche-b')
  })

  it('a slug-qualified edge in the same multi-tranche Milestone is never flagged', () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (
        cmd === 'gh' &&
        args[0] === 'api' &&
        args[1] === 'repos/atta-labs/vinaya/issues?milestone=9&state=all&per_page=100'
      ) {
        return JSON.stringify([
          { labels: [{ name: 'vinaya/tranche:tranche-a' }] },
          { labels: [{ name: 'vinaya/tranche:tranche-b' }] }
        ])
      }
      throw new Error(`unmocked execFileSync: ${cmd} ${args?.join(' ')}`)
    })
    expect(
      checkBareEdgeQualification(['tranche-a 1'], ['tranche-b 2'], { number: 9, title: 'shared' }, REPO)
    ).toBeNull()
  })

  it('checks conflictsWith ids too, not only dependsOn', () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (
        cmd === 'gh' &&
        args[0] === 'api' &&
        args[1] === 'repos/atta-labs/vinaya/issues?milestone=9&state=all&per_page=100'
      ) {
        return JSON.stringify([
          { labels: [{ name: 'vinaya/tranche:tranche-a' }] },
          { labels: [{ name: 'vinaya/tranche:tranche-b' }] }
        ])
      }
      throw new Error(`unmocked execFileSync: ${cmd} ${args?.join(' ')}`)
    })
    const result = checkBareEdgeQualification([], ['#372'], { number: 9, title: 'shared' }, REPO)
    expect(result).toContain('`#372`')
  })
})

// Source-scan (this file's own established convention for pinning
// verify-dispatch.ts's control flow — see "(d) sh()/shJson() other call
// sites are untouched" above): both gate modes fold the O3 check into their
// printed blockers and their exit-code readiness, not just call it and
// discard the result.
describe('O3 wiring reaches both gate modes, not just checkBareEdgeQualification itself', () => {
  const src = readFileSync(join(import.meta.dirname, 'verify-dispatch.ts'), 'utf8')

  it('runGateMode computes ambiguousEdge from task.dependsOn/conflictsWith and the Issue Milestone', () => {
    // Substrings, not one exact-formatted literal: a formatter is free to
    // wrap this call's argument list across lines, and the test must not
    // pin whichever wrapping happened to be current when it was written.
    expect(src).toContain('const ambiguousEdge = checkBareEdgeQualification(')
    expect(src).toContain('task.dependsOn')
    expect(src).toContain('task.conflictsWith')
    expect(src).toContain('issueJson?.milestone ?? null')
  })

  it('runGateModeForIssue computes ambiguousEdge the same way, off the parsed raw ids', () => {
    expect(src).toContain(
      'const ambiguousEdge = checkBareEdgeQualification(dependsOnIds, conflictsWithIds, issueJson.milestone, repo)'
    )
  })

  it('both gate modes fold ambiguousEdge into overallReady — a found ambiguity is never printed but ignored', () => {
    const occurrences = src.split("leftover.verdict !== 'stop' && !ambiguousEdge").length - 1
    expect(occurrences).toBe(2)
  })

  it('both gate modes print the ambiguousEdge message as a blocker line when present', () => {
    const occurrences = src.split('if (ambiguousEdge) console.log(').length - 1
    expect(occurrences).toBe(2)
  })
})
