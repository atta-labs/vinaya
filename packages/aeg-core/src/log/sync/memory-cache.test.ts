import { describe, expect, it } from 'vitest'
import { cacheContractCases } from './cache-contract'
import type { LogCache } from './contracts'
import { createMemoryCache } from './memory-cache'
import type { DatasetRow } from './row'

/** The in-memory cache against the shared cache contract (`apps/cli/specs/log-sync.md`). */

describe('the in-memory cache passes the cache contract', () => {
  it('the contract has cases', () => {
    expect(cacheContractCases.length).toBeGreaterThan(0)
  })

  for (const contractCase of cacheContractCases) {
    it(contractCase.name, () => {
      contractCase.run(createMemoryCache())
    })
  }
})

describe('the contract cases catch a broken cache', () => {
  /** A cache that stores every row it is handed, identity or not. */
  function appendOnlyCache(): LogCache {
    const inner = createMemoryCache()
    const all: DatasetRow[] = []
    return {
      ...inner,
      put(line) {
        if (line.type !== 'row') return inner.put(line)
        all.push(line.row)
        return { type: 'row', result: 'inserted' }
      },
      dataset: () => ({ ...inner.dataset(), rows: () => all })
    }
  }

  it('a cache that adds a second row for a stored identity fails exactly the identity cases', () => {
    const failing = cacheContractCases.filter((c) => {
      try {
        c.run(appendOnlyCache())
        return false
      } catch {
        return true
      }
    })
    expect(failing.map((c) => c.name)).toEqual([
      'storing one identity twice leaves one row',
      'storing one identity with different content keeps the first row and records one edit',
      'rows read back ordered by time, then identity'
    ])
  })
})
