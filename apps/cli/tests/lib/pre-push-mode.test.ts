// The pre-push hook's push mode: storage pushes (no tests) are allowed only
// while no pull request is open, and a forge read that fails refuses them.
import { describe, expect, it } from 'bun:test'
import { resolvePushMode, storageMarkerText } from '../../src/lib/pre-push-mode-logic'
import { resolveRemoteBase } from '../../src/lib/remote-base'

const never = () => {
  throw new Error('the forge must not be asked outside a storage push')
}

const alive = () => true
const dead = () => false
const marker = (over: Partial<{ runId: string; branch: string; pid: number }> = {}) =>
  storageMarkerText({ runId: 'run-1', branch: 'task/x', pid: 4242, ...over })

describe('resolvePushMode', () => {
  it('no mode named and no marker is the default push, with no forge read', () => {
    expect(
      resolvePushMode({ envMode: undefined, marker: null, branch: 'b', isPidAlive: alive, openPullRequests: never })
    ).toEqual({ ok: true, mode: 'default' })
  })

  it('the environment names a ready push over a marker', () => {
    expect(
      resolvePushMode({
        envMode: 'ready',
        marker: marker(),
        branch: 'task/x',
        isPidAlive: alive,
        openPullRequests: never
      })
    ).toEqual({ ok: true, mode: 'ready' })
  })

  it("a live run's marker on its own task branch with no pull request open is a storage push", () => {
    expect(
      resolvePushMode({
        envMode: undefined,
        marker: marker(),
        branch: 'task/x',
        isPidAlive: alive,
        openPullRequests: () => 0
      })
    ).toEqual({ ok: true, mode: 'storage' })
  })

  it('a marker whose run process is gone (a crash, a finished run) is ignored: the push runs the tests', () => {
    expect(
      resolvePushMode({
        envMode: undefined,
        marker: marker(),
        branch: 'task/x',
        isPidAlive: dead,
        openPullRequests: never
      })
    ).toEqual({ ok: true, mode: 'default' })
  })

  it('a marker for another branch, a non-task branch, or the old plain line is ignored', () => {
    for (const [text, branch] of [
      [marker({ branch: 'task/y' }), 'task/x'],
      [marker({ branch: 'feature' }), 'feature'],
      ['storage\n', 'task/x']
    ] as const) {
      expect(
        resolvePushMode({ envMode: undefined, marker: text, branch, isPidAlive: alive, openPullRequests: never })
      ).toEqual({ ok: true, mode: 'default' })
    }
  })

  it('the environment alone never turns on storage mode', () => {
    expect(
      resolvePushMode({
        envMode: 'storage',
        marker: null,
        branch: 'task/x',
        isPidAlive: alive,
        openPullRequests: never
      })
    ).toEqual({ ok: true, mode: 'default' })
  })

  it('a storage push is refused while a pull request is open', () => {
    const resolved = resolvePushMode({
      envMode: undefined,
      marker: marker(),
      branch: 'task/x',
      isPidAlive: alive,
      openPullRequests: () => 1
    })
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) expect(resolved.reason).toContain('a pull request is open for task/x')
  })

  it('a storage push is refused when the forge cannot say', () => {
    const resolved = resolvePushMode({
      envMode: undefined,
      marker: marker(),
      branch: 'task/x',
      isPidAlive: alive,
      openPullRequests: () => {
        throw new Error('gh: not logged in')
      }
    })
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) expect(resolved.reason).toContain('gh: not logged in')
  })

  it('an unknown mode reads as the default', () => {
    expect(
      resolvePushMode({ envMode: 'turbo', marker: 'nope', branch: 'b', isPidAlive: alive, openPullRequests: never })
    ).toEqual({ ok: true, mode: 'default' })
  })
})

describe('resolveRemoteBase', () => {
  it('a ready push names its base with VINAYA_PUSH_BASE', () => {
    const before = { base: process.env.VINAYA_PUSH_BASE, mode: process.env.VINAYA_PUSH_MODE }
    process.env.VINAYA_PUSH_BASE = 'origin/some-base'
    try {
      process.env.VINAYA_PUSH_MODE = 'ready'
      expect(resolveRemoteBase('/nonexistent')).toBe('origin/some-base')
      // Outside a ready push the variable redirects nothing.
      delete process.env.VINAYA_PUSH_MODE
      expect(resolveRemoteBase('/nonexistent')).not.toBe('origin/some-base')
    } finally {
      for (const [key, value] of [
        ['VINAYA_PUSH_BASE', before.base],
        ['VINAYA_PUSH_MODE', before.mode]
      ] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})
