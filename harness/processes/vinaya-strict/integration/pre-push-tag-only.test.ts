import { describe, expect, test } from 'bun:test'
import type { AgentVendor } from '../../../kernel/adapters/agents/agent-vendors.js'
import { buildInitOps } from './artifacts.js'

// The self-hosted pre-push hook stops after the Vinaya checks on a tag-only push of already-pushed commits; the
// adopter hook does not carry that step.

const prePush = (selfHost: Parameters<typeof buildInitOps>[0]['selfHost']): string => {
  const op = buildInitOps({
    owner: 'acme',
    repo: 'widget',
    hookDir: '.husky',
    selfHost,
    ciSetup: null,
    agents: new Set<AgentVendor>()
  }).find((candidate) => candidate.kind === 'managed-block' && candidate.path.endsWith('/pre-push'))
  if (op?.kind !== 'managed-block') throw new Error('no pre-push hook generated')
  return op.body
}

const PROGRAM = 'harness/kernel/gates/ring0-hooks/pre-push/tag-only-push.ts'

describe('the generated pre-push hook and a tag-only push', () => {
  test('the self-hosted hook runs the tag-only step after the checks and before the typecheck', () => {
    const body = prePush({ dir: 'apps/cli', bin: 'apps/cli/dist/index.js' })
    const checks = body.indexOf('--all --local')
    const step = body.indexOf(`bun ${PROGRAM}`)
    const typecheck = body.indexOf('bunx turbo typecheck --affected')
    expect(checks).toBeGreaterThanOrEqual(0)
    expect(step).toBeGreaterThan(checks)
    expect(typecheck).toBeGreaterThan(step)
    expect(body).toContain('tag-only push of already-pushed commits')
  })

  test('the adopter hook does not', () => {
    const body = prePush(null)
    expect(body).not.toContain('tag-only-push')
    expect(body).not.toContain('already-pushed commits')
  })
})
