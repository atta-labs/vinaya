// The pre-push hook's push mode: storage pushes (no tests) are allowed only
// while no pull request is open, and a forge read that fails refuses them.
import { describe, expect, it } from 'bun:test'
import { resolvePushMode } from '../../src/lib/pre-push-mode-logic'
import { resolveRemoteBase } from '../../src/lib/remote-base'

const never = () => {
  throw new Error('the forge must not be asked outside a storage push')
}

describe('resolvePushMode', () => {
  it('no mode named and no marker is the default push, with no forge read', () => {
    expect(resolvePushMode({ envMode: undefined, marker: null, branch: 'b', openPullRequests: never })).toEqual({
      ok: true,
      mode: 'default'
    })
  })

  it('the environment wins over the marker', () => {
    expect(resolvePushMode({ envMode: 'ready', marker: 'storage\n', branch: 'b', openPullRequests: never })).toEqual({
      ok: true,
      mode: 'ready'
    })
  })

  it('a storage marker with no pull request open is a storage push', () => {
    expect(
      resolvePushMode({ envMode: undefined, marker: 'storage\n', branch: 'b', openPullRequests: () => 0 })
    ).toEqual({ ok: true, mode: 'storage' })
  })

  it('a storage push is refused while a pull request is open', () => {
    const resolved = resolvePushMode({ envMode: 'storage', marker: null, branch: 'task/x', openPullRequests: () => 1 })
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) expect(resolved.reason).toContain('a pull request is open for task/x')
  })

  it('a storage push is refused when the forge cannot say', () => {
    const resolved = resolvePushMode({
      envMode: 'storage',
      marker: null,
      branch: 'b',
      openPullRequests: () => {
        throw new Error('gh: not logged in')
      }
    })
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) expect(resolved.reason).toContain('gh: not logged in')
  })

  it('an unknown mode reads as the default', () => {
    expect(resolvePushMode({ envMode: 'turbo', marker: 'nope', branch: 'b', openPullRequests: never })).toEqual({
      ok: true,
      mode: 'default'
    })
  })
})

describe('resolveRemoteBase', () => {
  it('a ready push names its base with VINAYA_PUSH_BASE', () => {
    const before = process.env.VINAYA_PUSH_BASE
    process.env.VINAYA_PUSH_BASE = 'origin/main'
    try {
      expect(resolveRemoteBase('/nonexistent')).toBe('origin/main')
    } finally {
      if (before === undefined) delete process.env.VINAYA_PUSH_BASE
      else process.env.VINAYA_PUSH_BASE = before
    }
  })
})
