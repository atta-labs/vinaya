import { expect, test } from 'bun:test'
import { otlpSignalUrl } from '../src/sender/send.js'

test('OTLP signal paths append to the base path and preserve its query', () => {
  expect(otlpSignalUrl('https://collector.example', 'traces')).toBe('https://collector.example/v1/traces')
  expect(otlpSignalUrl('https://collector.example/prefix/?tenant=one', 'logs')).toBe(
    'https://collector.example/prefix/v1/logs?tenant=one'
  )
  expect(otlpSignalUrl('https://collector.example/prefix?tenant=one', 'traces')).toBe(
    'https://collector.example/prefix/v1/traces?tenant=one'
  )
})
