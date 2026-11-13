import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// The seam between a test's fake forge and live GitHub. A forge the engine runs on is either the live one or a
// complete replacement: no code may spread the live forge into another object, because a function the other object
// leaves out would then fall through to GitHub. And the two trusted policy readers, which read the default branch's
// committed configuration from the forge, are called only by the production code that owns that read; a test reaches
// them through an injected reader instead.
//
// This is a closed identifier check over the source text, not a TypeScript parser: an aliased import or a computed
// spread is outside what it sees.

const PROCESS_ROOT = join(import.meta.dir, '..')

/** The process folder's TypeScript sources, as paths relative to it, outside installed dependencies. */
function processSources(): string[] {
  return readdirSync(PROCESS_ROOT, { recursive: true, encoding: 'utf8' })
    .filter((path) => /\.tsx?$/.test(path) && !path.split('/').includes('node_modules'))
    .sort()
}

const isTestFile = (path: string): boolean => /\.test\.tsx?$/.test(path)

/** The live forge spread into another object: the three dots, then the live forge's name, spaced or not. */
const LIVE_FORGE_SPREAD = /\.\.\.\s*liveForge\b/

/** Whether `source` spreads the live forge into another object. */
export function spreadsLiveForge(source: string): boolean {
  return LIVE_FORGE_SPREAD.test(source)
}

/** The two trusted policy readers, by name. */
const POLICY_READERS = ['readTrustedReadyTestsPolicy', 'readTrustedRequiredCiPolicy'] as const

/** Every trusted policy reader `source` names. */
export function policyReadersNamed(source: string): string[] {
  return POLICY_READERS.filter((name) => new RegExp(`\\b${name}\\b`).test(source))
}

/**
 * The non-test files allowed to name the trusted policy readers: the readers' own module, whose pre-push ready-policy
 * entry point calls one; the engine's live run; and the pull-request report engine's default reader.
 */
const POLICY_READER_CALLERS: readonly string[] = [
  'tools/pre-push-ready-policy.ts',
  'bin/run-engine.ts',
  'tools/pr-report/pr-report-engine.ts'
]

describe('the live forge seam', () => {
  test('no file in the process folder spreads the live forge into another object', () => {
    const offending = processSources().filter((path) =>
      spreadsLiveForge(readFileSync(join(PROCESS_ROOT, path), 'utf8'))
    )
    expect(offending).toEqual([])
  })

  test('only the fixed production callers name a trusted policy reader; test files are exempt', () => {
    const offending: string[] = []
    for (const path of processSources()) {
      if (isTestFile(path) || POLICY_READER_CALLERS.includes(path)) continue
      for (const name of policyReadersNamed(readFileSync(join(PROCESS_ROOT, path), 'utf8')))
        offending.push(`${path} names ${name}`)
    }
    expect(offending).toEqual([])
  })

  test('every allowed caller exists and still names a reader, so the list never outlives the code', () => {
    const sources = new Set(processSources())
    for (const path of POLICY_READER_CALLERS) {
      expect(sources.has(path)).toBe(true)
      expect(policyReadersNamed(readFileSync(join(PROCESS_ROOT, path), 'utf8')).length).toBeGreaterThan(0)
    }
  })

  test('the scans catch a planted spread and a planted reader call', () => {
    // Built from pieces, so this file's own text never holds what it looks for.
    const dots = '...'
    const forge = 'liveForge'
    expect(spreadsLiveForge(`const f = { ${dots}${forge}, prBody: () => '' }`)).toBe(true)
    expect(spreadsLiveForge(`const f = { ${dots} ${forge} }`)).toBe(true)
    expect(spreadsLiveForge(`const f = ${forge} ?? other`)).toBe(false)
    expect(spreadsLiveForge(`const f = { ${dots}${forge}Like }`)).toBe(false)
    const ready = ['readTrusted', 'ReadyTestsPolicy'].join('')
    expect(policyReadersNamed(`const p = ${ready}()`)).toEqual([ready])
    expect(policyReadersNamed(`const p = ${ready}Cached()`)).toEqual([])
  })
})
