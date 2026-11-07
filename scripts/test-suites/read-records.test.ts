import { expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nearestReachableRecord } from './read-records'

const record = (commit: string) =>
  JSON.stringify({ schema: 'vinaya.read-record', schemaVersion: 1, commit, platform: 'linux', tests: {} })

/** A folder outside any git checkout, so no kept record is found and every lookup goes through the fetch. */
function outside(): string {
  return mkdtempSync(join(tmpdir(), 'read-records-'))
}

it('a commit with no record of its own uses the nearest earlier commit that has one', () => {
  const root = outside()
  try {
    const asked: string[] = []
    const fetch = (commit: string) => {
      asked.push(commit)
      if (commit === 'c1') return record('c1')
      throw new Error(`no run for ${commit}`)
    }
    const reached = nearestReachableRecord(root, 'c3', fetch, 10, () => ['c3', 'c2', 'c1', 'c0'])
    expect(reached.record?.commit).toBe('c1')
    expect(reached.reason).toContain('c1, the nearest earlier commit that has one')
    // It stops at the first record and never looks further back.
    expect(asked).toEqual(['c3', 'c2', 'c1'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('the exact commit wins when it has a record, and nothing in reach gives no record with the first reason', () => {
  const root = outside()
  try {
    const exact = nearestReachableRecord(
      root,
      'c3',
      (c) => record(c),
      10,
      () => ['c3', 'c2']
    )
    expect([exact.record?.commit, exact.reason.includes('nearest earlier')]).toEqual(['c3', false])
    const none = nearestReachableRecord(
      root,
      'c3',
      (c) => {
        throw new Error(`no run for ${c}`)
      },
      10,
      () => ['c3', 'c2']
    )
    expect(none.record).toBeNull()
    expect(none.reason).toContain('no run for c3')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
