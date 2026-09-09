import { describe, expect, it } from 'bun:test'
import { reassertPrBodyPremise } from '../../src/checks/bin/check-pr-premise-reassert'

const CHECK_NAME = 'pr-premise-reassert'

describe('reassertPrBodyPremise', () => {
  it('O3: a body with no `Premise:` block returns null — silent, not a failure', () => {
    const body = ['## Summary', '', 'An ordinary PR with no pins at all.', ''].join('\n')
    expect(reassertPrBodyPremise(body)).toBeNull()
  })

  it('O3: an entirely empty body returns null', () => {
    expect(reassertPrBodyPremise('')).toBeNull()
  })

  it('O1: a `contains` pin that still matches the real tree passes', () => {
    const body = [
      '**Premise:**',
      '- apps/cli/src/checks/registry.ts contains: function bin(name: string): string {',
      ''
    ].join('\n')
    const result = reassertPrBodyPremise(body)
    expect(result).not.toBeNull()
    expect(result?.pass).toBe(true)
    expect(result?.errors).toHaveLength(0)
  })

  it("O1: a `contains` pin the PR's own diff falsifies fails, naming the pin", () => {
    const body = [
      '**Premise:**',
      '- apps/cli/src/checks/registry.ts contains: this literal string does not exist in the file',
      ''
    ].join('\n')
    const result = reassertPrBodyPremise(body)
    expect(result).not.toBeNull()
    expect(result?.pass).toBe(false)
    expect(result?.errors).toHaveLength(1)
    expect(result?.errors[0]?.check).toBe(CHECK_NAME)
    expect(result?.errors[0]?.severity).toBe('error')
    expect(result?.errors[0]?.message).toContain('apps/cli/src/checks/registry.ts')
  })

  it('a `sha256` pin against a path that does not exist on disk fails, not silently', () => {
    const body = ['**Premise:**', '- does/not/exist.ts sha256: deadbeef', ''].join('\n')
    const result = reassertPrBodyPremise(body)
    expect(result).not.toBeNull()
    expect(result?.pass).toBe(false)
    expect(result?.errors).toHaveLength(1)
    expect(result?.errors[0]?.message).toContain('does not exist on disk')
  })

  it('a pin path escaping the repo root (symlink/`..`) is treated as unreadable, never followed', () => {
    const body = ['**Premise:**', '- ../../../etc/passwd contains: root:', ''].join('\n')
    const result = reassertPrBodyPremise(body)
    expect(result).not.toBeNull()
    expect(result?.pass).toBe(false)
    expect(result?.errors).toHaveLength(1)
    expect(result?.errors[0]?.message).toContain('does not exist on disk')
  })
})
