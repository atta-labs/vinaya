import { describe, expect, it } from 'bun:test'
import { errorClassOf } from '../../src/lib/dev-review-loop/round-assess'

describe('errorClassOf', () => {
  it('takes the error code, else the constructor name, else unknown — never the message', () => {
    expect(errorClassOf(Object.assign(new Error('no such file /tmp/secret'), { code: 'ENOENT' }))).toBe('ENOENT')
    expect(errorClassOf(new TypeError('boom /home/x'))).toBe('TypeError')
    expect(errorClassOf(Object.assign(new Error('x'), { code: '/home/x y' }))).toBe('unknown')
    expect(errorClassOf('a string /tmp/x')).toBe('unknown')
    expect(errorClassOf(null)).toBe('unknown')
    expect(errorClassOf(Object.assign(new Error('x'), { code: 'c'.repeat(65) }))).toBe('unknown')
  })
})
