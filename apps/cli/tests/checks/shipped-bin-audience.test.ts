import { describe, expect, it } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { SHIPPED_BIN_AUDIENCE } from '@attalabs/aeg-core'
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
 * This also lets the `shippedAs` names be checked against the registry rather
 * than taken on trust. A mapping naming a check that does not exist would be
 * precisely the authoritative-looking false claim this whole mechanism exists
 * to stop, and the aeg-core-side test structurally cannot catch it.
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
      out.push(`${prefix}${e.name}`.replace(/\.[cm]?ts$/, ''))
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
