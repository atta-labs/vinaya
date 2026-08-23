import { describe, expect, it } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { GATE_AUDIENCE, SHIPPED_BIN_AUDIENCE } from '@attalabs/aeg-core'
import { coreCheckRegistry } from '../../src/checks/registry.js'

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
    for (const [bin, audience] of Object.entries({ ...GATE_AUDIENCE, ...SHIPPED_BIN_AUDIENCE })) {
      if (!('shippedAs' in audience)) continue
      const names = Array.isArray(audience.shippedAs) ? audience.shippedAs : [audience.shippedAs]
      for (const n of names) out.push([bin, n])
    }
    return out
  }

  it('finds claims to check — a guard on the extraction itself', () => {
    expect(claimedNames().length).toBeGreaterThan(5)
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
