import { describe, expect, it } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { GATE_AUDIENCE, isShipped, SHIPPED_BIN_AUDIENCE } from '@attalabs/aeg-core'
import { CORE_CHECK_RING, coreCheckRegistry } from '../../src/checks/registry.js'

/**
 * The half of atta-labs/vinaya#186 that has to live here.
 *
 * `apps/cli/src/checks/bin/*` is where an adopter-runnable check executable
 * actually sits, so it is where "built but not registered" can hide — which is
 * exactly what `reader-resolvable-prose` is. `aeg-core` cannot import
 * `coreCheckRegistry()` without closing a dependency cycle, so the declaration
 * lives there and the assertion lives here, where the registry is in scope.
 *
 * It is also the only place `shippedAs` names CAN be checked against the
 * registry, since `coreCheckRegistry()` is in scope only here. A mapping naming
 * a check that does not exist is precisely the authoritative-looking false
 * claim this mechanism exists to stop — and until the last commit nothing
 * asserted it, while the changeset said something did. That is the failure this
 * whole change is about, so it is now a test rather than a sentence.
 */
const BIN_DIR = join(import.meta.dirname, '../../src/checks/bin')

function shippedBinNames(): string[] {
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
      if (/\.test\.[cm]?ts$/.test(e.name) || !/\.[cm]?ts$/.test(e.name)) continue
      // Extension is stripped so a bin matches its registry name, which means
      // `check-x.ts` and `check-x.mts` collapse to one entry — a single row
      // would then silence two files. Refused rather than deduped: two bins
      // that differ only by extension is itself the ambiguity this gate exists
      // to remove.
      const name = `${prefix}${e.name}`.replace(/\.[cm]?ts$/, '')
      if (out.includes(name)) throw new Error(`two bins collapse to one name: ${name}`)
      out.push(name)
    }
  }
  walk(BIN_DIR, '')
  return out.sort()
}

/** `check-doc-coverage` → `doc-coverage`: the bin name minus its `check-` prefix. */
function registeredBinNames(): Set<string> {
  return new Set(coreCheckRegistry().map((s) => `check-${s.name}`))
}

describe('every shipped check bin is registered, or declares why not', () => {
  it('leaves nothing unaccounted — a built-but-unregistered check fails here, by name', () => {
    const registered = registeredBinNames()
    const declared = new Set(Object.keys(SHIPPED_BIN_AUDIENCE))
    const orphans = shippedBinNames().filter((b) => !registered.has(b) && !declared.has(b))
    expect(
      orphans,
      `Built but neither registered nor declared: ${orphans.join(', ')}. ` +
        'Register it in coreCheckRegistry(), or add it to SHIPPED_BIN_AUDIENCE with a reason.'
    ).toEqual([])
  })

  it('declares nothing that does not exist', () => {
    const present = new Set(shippedBinNames())
    const stale = Object.keys(SHIPPED_BIN_AUDIENCE).filter((b) => !present.has(b))
    expect(stale, `Declared but absent: ${stale.join(', ')}`).toEqual([])
  })

  it('never declares a bin that IS registered — the two columns cannot overlap', () => {
    const registered = registeredBinNames()
    const both = Object.keys(SHIPPED_BIN_AUDIENCE).filter((b) => registered.has(b))
    expect(both, `Declared internal yet registered: ${both.join(', ')}`).toEqual([])
  })
})

describe('every `shippedAs` names a check that exists', () => {
  /** Every core-check name a declaration claims to ship as, with the bin that claims it. */
  function claimedNames(): [string, string][] {
    const out: [string, string][] = []
    // Iterated as two maps, never spread into one. A spread lets the second
    // map SHADOW an identically-keyed entry in the first, dropping its
    // `shippedAs` from validation entirely — and the two namespaces really do
    // overlap (`check-branch-topology`, `check-first-push-dispatch`,
    // `check-no-disk-state` exist in both directories), so a bogus name in the
    // shadowed entry validated green.
    for (const [label, map] of [
      ['GATE_AUDIENCE', GATE_AUDIENCE],
      ['SHIPPED_BIN_AUDIENCE', SHIPPED_BIN_AUDIENCE]
    ] as const) {
      for (const [bin, audience] of Object.entries(map)) {
        if (!('shippedAs' in audience)) continue
        const names = Array.isArray(audience.shippedAs) ? audience.shippedAs : [audience.shippedAs]
        for (const n of names) out.push([`${label}:${bin}`, n])
      }
    }
    return out
  }

  /** A bin declared in both maps, where the two declarations disagree about what it is. */
  function crossMapContradictions(): string[] {
    const out: string[] = []
    for (const [bin, shipped] of Object.entries(SHIPPED_BIN_AUDIENCE)) {
      const core = (GATE_AUDIENCE as Record<string, unknown>)[bin]
      if (core === undefined) continue
      if (JSON.stringify(core) !== JSON.stringify(shipped)) out.push(bin)
    }
    return out
  }

  // A tripwire set well below the real corpus is not a tripwire. Half the
  // claims could stop being extracted without a `> 5` guard noticing.
  it('extracts every shippedAs declaration in both maps — a guard on the extraction itself', () => {
    const declared = [...Object.values(GATE_AUDIENCE), ...Object.values(SHIPPED_BIN_AUDIENCE)].filter(
      (a) => 'shippedAs' in a
    ).length
    expect(declared).toBeGreaterThan(5)
    const extractedBins = new Set(claimedNames().map(([bin]) => bin))
    expect(extractedBins.size).toBe(declared)
  })

  it('never lets one map shadow the other — a bin declared twice must agree', () => {
    expect(
      crossMapContradictions(),
      'A bin is declared in both GATE_AUDIENCE and SHIPPED_BIN_AUDIENCE with different audiences. One of them is wrong, and nothing else reports which.'
    ).toEqual([])
  })

  it('resolves every claimed name in coreCheckRegistry()', () => {
    const registered = new Set(coreCheckRegistry().map((s) => s.name))
    const unresolved = claimedNames().filter(([, name]) => !registered.has(name))
    expect(
      unresolved.map(([bin, name]) => `${bin} -> ${name}`),
      'A `shippedAs` names a check that is not in `coreCheckRegistry()`. Either the check was renamed or deregistered and the declaration was not updated, or the name is a typo. Either way the declaration asserts an enforcement that does not exist.'
    ).toEqual([])
  })
})

describe('GATE_AUDIENCE.ring mirrors CORE_CHECK_RING — the only place both are in scope at once', () => {
  // `registry-scaffold.ts` (aeg-core) reads GATE_AUDIENCE's `ring` to place a
  // stub row for an aeg-core-bin G2 candidate; `registry.ts`'s `REGISTRY`
  // pairing is the actual source of truth `CORE_CHECK_RING` derives from.
  // aeg-core cannot import `apps/cli` to check this itself (same
  // dependency-cycle constraint `shippedAs` runs into above), so the
  // duplicated `ring` value is asserted in sync here, same shape as the
  // `crossMapContradictions` check above.
  it('every GATE_AUDIENCE shippedAs name agrees with CORE_CHECK_RING on its ring', () => {
    const mismatches: string[] = []
    for (const [bin, audience] of Object.entries(GATE_AUDIENCE)) {
      if (!isShipped(audience)) continue
      const names = Array.isArray(audience.shippedAs) ? audience.shippedAs : [audience.shippedAs]
      for (const name of names) {
        const real = CORE_CHECK_RING[name]
        if (real !== audience.ring) {
          mismatches.push(
            `${bin} (shippedAs ${name}): GATE_AUDIENCE says ring ${audience.ring}, registry.ts says ${real}`
          )
        }
      }
    }
    expect(
      mismatches,
      'GATE_AUDIENCE.ring has drifted from registry.ts REGISTRY — update gate-audience.ts to match.'
    ).toEqual([])
  })
})
