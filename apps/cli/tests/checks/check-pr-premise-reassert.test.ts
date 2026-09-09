import { describe, expect, it } from 'bun:test'
import { reassertPrBodyPremise } from '../../src/checks/bin/check-pr-premise-reassert'

const CHECK_NAME = 'pr-premise-reassert'

function fixtureReader(files: Record<string, string>): (path: string) => string | null {
  return (p) => files[p] ?? null
}

describe('reassertPrBodyPremise', () => {
  it('O3: a body with no `Premise:` block returns null — silent, not a failure', () => {
    const body = ['## Summary', '', 'An ordinary PR with no pins at all.', ''].join('\n')
    expect(reassertPrBodyPremise(body, fixtureReader({}))).toBeNull()
  })

  it('O3: an entirely empty body returns null', () => {
    expect(reassertPrBodyPremise('', fixtureReader({}))).toBeNull()
  })

  it('O1: a `contains` pin that still matches the real tree passes', () => {
    const body = ['**Premise:**', '- src/thing.ts contains: export function thing', ''].join('\n')
    const result = reassertPrBodyPremise(body, fixtureReader({ 'src/thing.ts': 'export function thing() {}\n' }))
    expect(result).not.toBeNull()
    expect(result?.pass).toBe(true)
    expect(result?.errors).toHaveLength(0)
  })

  it("O1: a `contains` pin the PR's own diff falsifies fails, naming the pin", () => {
    const body = ['**Premise:**', '- src/thing.ts contains: export function thing', ''].join('\n')
    const result = reassertPrBodyPremise(
      body,
      fixtureReader({ 'src/thing.ts': 'export function somethingElse() {}\n' })
    )
    expect(result).not.toBeNull()
    expect(result?.pass).toBe(false)
    expect(result?.errors).toHaveLength(1)
    expect(result?.errors[0]?.check).toBe(CHECK_NAME)
    expect(result?.errors[0]?.severity).toBe('error')
    expect(result?.errors[0]?.message).toContain('src/thing.ts')
  })

  it('a `sha256` pin against a path that does not exist on disk fails, not silently', () => {
    const body = ['**Premise:**', '- does/not/exist.ts sha256: deadbeef', ''].join('\n')
    const result = reassertPrBodyPremise(body, fixtureReader({}))
    expect(result).not.toBeNull()
    expect(result?.pass).toBe(false)
    expect(result?.errors).toHaveLength(1)
    expect(result?.errors[0]?.message).toContain('does not exist on disk')
  })

  it('a pin path escaping the containment root (symlink/`..`) is treated as unreadable, never followed', () => {
    // `containedRealPath` is exercised for real here (default reader, no
    // fixture override) — the fixture reader above bypasses containment
    // entirely, so this is the one case that must use the real reader to
    // prove the escape is actually refused, not just that a fixture map has
    // no matching key. Rooted from this file's own real cwd, whatever that
    // is, since containment (not a specific file's content) is what's
    // asserted.
    const body = ['**Premise:**', '- ../../../etc/passwd contains: root:', ''].join('\n')
    const result = reassertPrBodyPremise(body)
    expect(result).not.toBeNull()
    expect(result?.pass).toBe(false)
    expect(result?.errors).toHaveLength(1)
    expect(result?.errors[0]?.message).toContain('does not exist on disk')
  })
})
