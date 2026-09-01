import { describe, expect, it } from 'bun:test'
import { resolveMeteringCapability, type MeteringCapabilityDeps } from '@attalabs/aeg-core'

/**
 * `check-token-report.ts`'s whole probe-crash-vs-incapable distinction
 * (task 4, #271, §9 Test Plan item 5) rests on one contract:
 * `resolveMeteringCapability` does NOT catch a throwing `deps.exists` —
 * only its own `deps.readFile` call is wrapped. This test proves that
 * contract directly against the real, shipped `@attalabs/aeg-core`
 * function (never a local reimplementation), so a future change to the
 * probe that started swallowing this exception would fail HERE, not
 * silently disarm the bin's uncaught-propagation guarantee.
 *
 * The bin's own hardened `exists` (`safeLstat`-wrapped) never itself
 * throws in real operation — this test's throwing `exists` is a
 * deliberately adversarial double standing in for "some deps
 * implementation genuinely fails", to prove what happens structurally
 * when one does.
 */
describe('resolveMeteringCapability probe-crash propagation', () => {
  it('a throwing deps.exists propagates uncaught — never converted into a clean incapable verdict', () => {
    const deps: MeteringCapabilityDeps = {
      env: { CLAUDE_PROJECT_DIR: '/tmp/fake-project', CLAUDE_CODE_SESSION_ID: 'fake-session' },
      cwd: '/tmp/fake-project',
      exists: () => {
        throw new Error('simulated fs failure — not an incapable verdict')
      },
      readFile: () => {
        throw new Error('unreachable: exists() throws first')
      }
    }

    expect(() => resolveMeteringCapability(deps)).toThrow('simulated fs failure — not an incapable verdict')
  })

  it('by contrast, deps.readFile throwing IS caught — resolves to a clean incapable verdict, not a crash', () => {
    const deps: MeteringCapabilityDeps = {
      env: { CLAUDE_PROJECT_DIR: '/tmp/fake-project', CLAUDE_CODE_SESSION_ID: 'fake-session' },
      cwd: '/tmp/fake-project',
      exists: () => true,
      readFile: () => {
        throw new Error('simulated unreadable transcript')
      }
    }

    const result = resolveMeteringCapability(deps)
    expect(result.capable).toBe(false)
  })
})
