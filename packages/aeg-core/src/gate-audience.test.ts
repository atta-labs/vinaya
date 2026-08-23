import { describe, expect, it } from 'vitest'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GATE_AUDIENCE, isShipped, NON_GATE_BINS, SHIPPED_BIN_AUDIENCE } from './gate-audience'

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

/**
 * RECURSIVE, and every extension — not `readdirSync` + `endsWith('.ts')`.
 * Review defeated the first version two ways that both left the suite green: a
 * nested `bin/nested/check-probe.ts`, and a `bin/check-probe.mts`. A gate whose
 * enumeration is narrower than the directory it guards is a gate with a door in
 * the back.
 */
function binBasenames(): string[] {
  const out: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      // `isDirectory()` is false for a symlink to a directory, so an unfollowed
      // symlink falls through to the extension filters, fails them on a bare
      // directory name, and is skipped in silence — a symlinked directory
      // holding an undeclared gate passed both suites green. Refused rather
      // than followed: following one would enumerate files git does not track
      // here, and skipping one is the fail-open this gate exists to remove.
      if (e.isSymbolicLink()) throw new Error(`symlink in bin/, cannot enumerate honestly: ${prefix}${e.name}`)
      if (e.isDirectory()) {
        walk(join(dir, e.name), `${prefix}${e.name}/`)
        continue
      }
      if (/\.test\.[cm]?ts$/.test(e.name)) continue
      if (!/\.[cm]?ts$/.test(e.name)) continue
      // Same reasoning as `shipped-bin-audience.test.ts`: stripping the
      // extension is what matches a bin to its declaration, so two bins
      // differing only by extension would share one row. Refused, not deduped.
      const name = `${prefix}${e.name}`.replace(/\.[cm]?ts$/, '')
      if (out.includes(name)) throw new Error(`two bins collapse to one name: ${name}`)
      out.push(name)
    }
  }
  walk(BIN_DIR, '')
  return out.sort()
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

describe('the shipped-side declaration is complete too', () => {
  it('gives every internal entry a substantive reason', () => {
    const thin = Object.entries(SHIPPED_BIN_AUDIENCE)
      .filter(([, a]) => !isShipped(a) && (a as { internal: string }).internal.trim().length < 40)
      .map(([n]) => n)
    expect(thin).toEqual([])
  })

  it('never claims both audiences', () => {
    const both = Object.entries(SHIPPED_BIN_AUDIENCE)
      .filter(([, a]) => 'shippedAs' in a && 'internal' in a)
      .map(([n]) => n)
    expect(both).toEqual([])
  })
})
