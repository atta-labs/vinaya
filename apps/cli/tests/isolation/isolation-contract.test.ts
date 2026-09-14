import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findHeadingLine, findTable, rowToRecord } from '@attalabs/aeg-core'

/**
 * Parses apps/cli/specs/isolation.md's boundary contract table (worker-
 * isolation-v1 task 1, #549, O1) the same way every other doctrine table in
 * this repo is parsed — `@attalabs/aeg-core`'s `findTable`, never a one-off
 * regex — and asserts it names all six required boundaries, each with a
 * non-empty Permitted and Forbidden column.
 */

const SPEC_PATH = join(import.meta.dirname, '..', '..', 'specs', 'isolation.md')

const REQUIRED_BOUNDARIES = ['Controller', 'Worker', 'Reviewer', 'Operator', 'Repository subprocess', 'Broker']

describe('isolation.md contract table', () => {
  const lines = readFileSync(SPEC_PATH, 'utf8').split('\n')
  const headingLine = findHeadingLine(lines, /^##\s+1\.\s+The six boundaries/)
  if (headingLine === null) throw new Error('isolation.md: "## 1. The six boundaries" heading not found')
  const maybeTable = findTable(lines, headingLine)
  if (maybeTable === null) throw new Error('isolation.md: no table found under "## 1. The six boundaries"')
  const table = maybeTable

  it('has exactly the six required columns', () => {
    expect(table.headers).toEqual([
      'Boundary',
      'What it is today',
      'Trust level',
      'Permitted operations',
      'Forbidden operations'
    ])
  })

  function boundaryOf(row: (typeof table.rows)[number]): string {
    return (rowToRecord(table.headers, row).Boundary ?? '').replace(/\*\*/g, '')
  }

  it('has exactly one row per required boundary, in order', () => {
    const names = table.rows.map(boundaryOf)
    expect(names).toEqual(REQUIRED_BOUNDARIES)
  })

  it.each(REQUIRED_BOUNDARIES)('%s names non-empty Permitted and Forbidden operations', (boundaryName) => {
    const row = table.rows.find((r) => boundaryOf(r) === boundaryName)
    if (!row) throw new Error(`isolation.md: no row for boundary "${boundaryName}"`)
    const record = rowToRecord(table.headers, row)
    expect((record['Permitted operations'] ?? '').length).toBeGreaterThan(0)
    expect((record['Forbidden operations'] ?? '').length).toBeGreaterThan(0)
  })
})
