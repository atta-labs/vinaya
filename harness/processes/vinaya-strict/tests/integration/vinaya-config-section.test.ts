import { describe, expect, test } from 'bun:test'
import type { z } from 'zod'
import { KERNEL_CONFIG_KEYS } from '../../../../kernel/config/schema/config-schema'
import { CONFIG_KEY_ORDER, VinayaConfigSchema, VinayaConfigShape } from '../../integration/config/compose'
import {
  decisionRecordsPathIssue,
  isDefaultedAgentVendorPath,
  resolveCollisionThreshold,
  resolveGateCutovers,
  resolveReleaseActor,
  resolveReviewPolicy,
  VINAYA_CONFIG_SECTION,
  VINAYA_GLOBAL_ONLY_KEYS
} from '../../integration/config/vinaya-config-section'

// The keys this process owns: review policy, gate cutovers, prose rules, the
// collision threshold, the release actor, principals, tokens collection, and the
// keys that name its roles, briefs, review loop and plans.
const VINAYA_KEYS = [
  'roles',
  'briefSchema',
  'principals',
  'releaseActor',
  'tokens',
  'blastRadius',
  'proseGates',
  'projects',
  'dispatch',
  'reviewPolicy',
  'securityScan',
  'gateCutovers',
  'planning',
  'prePush',
  'report',
  'decisionRecords'
]

describe("Vinaya's configuration section", () => {
  test('owns exactly its keys, and the composition places every kernel and section key once', () => {
    expect<string[]>([...VINAYA_CONFIG_SECTION.keys]).toEqual(VINAYA_KEYS)
    expect(Object.keys(VINAYA_CONFIG_SECTION.fragment)).toEqual(VINAYA_KEYS)
    expect<string[]>([...CONFIG_KEY_ORDER].sort()).toEqual([...KERNEL_CONFIG_KEYS, ...VINAYA_KEYS].sort())
    expect(Object.keys(VinayaConfigShape)).toEqual([...CONFIG_KEY_ORDER])
  })

  test('every key has exactly one place in the order', () => {
    expect(new Set(CONFIG_KEY_ORDER).size).toBe(CONFIG_KEY_ORDER.length)
  })

  test("the decision-records rule reads the section's doctrine root and adds its issue after every field's", () => {
    const parsed = VinayaConfigSchema.safeParse({
      decisionRecords: { path: 'docs/aeg/adr' },
      proseGates: { doctrineRoot: 'docs/aeg' }
    })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(parsed.error.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      [
        'decisionRecords.path',
        'must be outside the doctrine tree "docs/aeg" — decision records belong to this repository, not to the doctrine it ships'
      ]
    ])
    expect(decisionRecordsPathIssue('docs/adr', undefined)).toBeNull()
    const ctx: z.RefinementCtx = { addIssue: () => {}, path: [] }
    expect(() => VINAYA_CONFIG_SECTION.refinements[0]?.({}, ctx)).not.toThrow()
  })

  test('the section resolvers default, and refuse a present invalid value', () => {
    expect(resolveReleaseActor(null)).toBe('github-actions[bot]')
    expect(resolveCollisionThreshold({ planning: { collisionThreshold: 0 } })).toBe(0)
    expect(resolveGateCutovers({ gateCutovers: { objectivesSinceIssue: 5 } }).objectivesSinceIssue).toBe(5)
    expect(() => resolveReviewPolicy({ reviewPolicy: { maxRounds: 0 } })).toThrow('reviewPolicy.maxRounds "0"')
  })

  test('an unrecorded agent selection defaults the command-emitter paths', () => {
    expect(isDefaultedAgentVendorPath('.claude/commands/vinaya.md', {})).toBe(true)
    expect(isDefaultedAgentVendorPath('.gemini/commands/vinaya.toml', { agents: [] })).toBe(false)
  })

  test('the machine-wide file may not set roles, principals, the release actor or tokens', () => {
    expect(Object.keys(VINAYA_GLOBAL_ONLY_KEYS)).toEqual(['roles', 'principals', 'releaseActor', 'tokens'])
    expect(VINAYA_GLOBAL_ONLY_KEYS.principals.present({ principals: ['a'] })).toBe(true)
    expect(VINAYA_GLOBAL_ONLY_KEYS.principals.warning('/g.json')).toContain(
      '"principals" in the global config is ignored'
    )
  })
})
