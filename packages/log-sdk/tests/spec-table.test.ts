import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { harness } from './helpers.js'

const spec = readFileSync(join(import.meta.dir, '..', 'specs', 'log-sdk.md'), 'utf8')

/** The function of every row of the spec's table: the first cell, in backticks. */
function specRows(): string[] {
  return spec
    .split('\n')
    .map((line) => /^\| `([^`]+)` \|/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined)
}

/** `connect` and every `log.<subject>.<method>` the handle has. */
function handleFunctions(): string[] {
  const handle = harness().handle as unknown as Record<string, unknown>
  const methods = Object.entries(handle).flatMap(([subject, value]) =>
    subject !== 'settings' && typeof value === 'object' && value !== null
      ? Object.keys(value).map((fn) => `log.${subject}.${fn}`)
      : []
  )
  return ['connect', ...methods]
}

test('the spec has a Status block', () => {
  expect(spec).toMatch(/^Status: \w+/m)
})

test('every row of the spec table names a function of the handle', () => {
  const functions = new Set(handleFunctions())
  expect(specRows().filter((row) => !functions.has(row))).toEqual([])
})

test('every function of the handle has a row in the spec table', () => {
  const rows = new Set(specRows())
  expect(handleFunctions().filter((fn) => !rows.has(fn))).toEqual([])
})

test('no function has two rows', () => {
  const rows = specRows()
  expect(new Set(rows).size).toBe(rows.length)
})
