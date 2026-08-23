import { describe, expect, it } from 'vitest'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { GATE_AUDIENCE, isShipped, NON_GATE_BINS } from './gate-audience'

/**
 * The fail-closed half of `gate-audience.ts` (atta-labs/vinaya#186).
 *
 * Modelled on the mechanism this repo already proved works for commands:
 * `verify-published-lifecycle.ts` refuses to start when a `status: 'shipped'`
 * command has no `EXERCISES`/`EXEMPTIONS` entry. Same shape, different
 * registry — a declaration plus a gate that refuses when the directory
 * outgrows it. That is why atta-labs/vinaya#134 surfaced as a loud refusal
 * rather than rotting quietly for months.
 */
const BIN_DIR = fileURLToPath(new URL('../bin', import.meta.url))

function binBasenames(): string[] {
  return readdirSync(BIN_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => f.replace(/\.ts$/, ''))
    .sort()
}

describe('every gate under aeg-core/bin declares who it is for', () => {
  it('leaves nothing undeclared — a new gate with no audience fails here, by name', () => {
    const declared = new Set([...Object.keys(GATE_AUDIENCE), ...NON_GATE_BINS])
    const undeclared = binBasenames().filter((b) => !declared.has(b))
    expect(
      undeclared,
      `Undeclared bin(s): ${undeclared.join(', ')}. Add each to GATE_AUDIENCE — ` +
        '`{ shippedAs: "<core check name>" }` if adopters run it, `{ internal: "<why not>" }` if they do not — ' +
        'or to NON_GATE_BINS if it is not a gate at all.'
    ).toEqual([])
  })

  it('declares nothing that does not exist — a deleted bin cannot leave a stale row', () => {
    const present = new Set(binBasenames())
    const stale = [...Object.keys(GATE_AUDIENCE), ...NON_GATE_BINS].filter((b) => !present.has(b))
    expect(stale, `Declared but absent from bin/: ${stale.join(', ')}`).toEqual([])
  })

  it('gives every internal gate a real reason, not an empty string', () => {
    const empty = Object.entries(GATE_AUDIENCE)
      .filter(([, a]) => !isShipped(a) && (a as { internal: string }).internal.trim().length < 40)
      .map(([name]) => name)
    expect(empty, `Internal gate(s) with no substantive reason: ${empty.join(', ')}`).toEqual([])
  })

  it('never claims both audiences for one gate', () => {
    const both = Object.entries(GATE_AUDIENCE)
      .filter(([, a]) => 'shippedAs' in a && 'internal' in a)
      .map(([name]) => name)
    expect(both).toEqual([])
  })

  it('does not list a non-gate as a gate', () => {
    const overlap = NON_GATE_BINS.filter((b) => b in GATE_AUDIENCE)
    expect(overlap).toEqual([])
  })
})
