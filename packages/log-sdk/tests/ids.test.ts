import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createRunIdGenerator, spanIdFor, traceIdFor } from '../src/contract/ids.js'

test('trace and span ids are stable lowercase hex', () => {
  expect(traceIdFor('r')).toMatch(/^[0-9a-f]{32}$/)
  expect(spanIdFor('r', 'k')).toMatch(/^[0-9a-f]{16}$/)
  expect(traceIdFor('r')).toBe(traceIdFor('r'))
  expect(traceIdFor('r')).not.toBe(traceIdFor('s'))
  expect(spanIdFor('r', 'k')).toBe(spanIdFor('r', 'k'))
  expect(spanIdFor('r', 'k')).not.toBe(spanIdFor('r', 'j'))
  expect(spanIdFor('r', 'k')).not.toBe(spanIdFor('s', 'k'))
})

test('the run id generator gives the run trace id, the next span id once, then random ids', () => {
  const gen = createRunIdGenerator('r')
  expect(gen.generateTraceId()).toBe(traceIdFor('r'))
  gen.useNextSpanId('aaaaaaaaaaaaaaaa')
  expect(gen.generateSpanId()).toBe('aaaaaaaaaaaaaaaa')
  const a = gen.generateSpanId()
  const b = gen.generateSpanId()
  expect(a).toMatch(/^[0-9a-f]{16}$/)
  expect(a).not.toBe(b)
})

test('ids.ts imports nothing but node:crypto', () => {
  const source = readFileSync(new URL('../src/contract/ids.ts', import.meta.url), 'utf8')
  const specifiers = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
  expect(specifiers).toEqual(['node:crypto'])
})
