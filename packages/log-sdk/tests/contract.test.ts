import { expect, test } from 'bun:test'
import { KNOWN_SCHEMA_VERSIONS, LogEventSchema, redact } from '../src/index.js'

test('the package exports the Log contract', () => {
  expect(KNOWN_SCHEMA_VERSIONS).toEqual([1, 2, 3, 4])
  expect(typeof LogEventSchema.safeParse).toBe('function')
  expect(redact({ a: 1 }, '/home/nobody')).toEqual({ a: 1 })
})
