import { NO_GATE_CUTOVERS } from '@attalabs/aeg-core'
import { describe, expect, it } from 'bun:test'
import { resolveGateCutovers, type VinayaConfig } from '../../src/lib/config'

// `resolveGateCutovers` is the seam that makes O1 hold: a repository that
// declares no `gateCutovers` key resolves every cutover to `null` (no
// cutover — each gate applies from Issue/PR 1), NOT to the built-in
// constants. A repository that predates a gate sets its own numbers (O2).
describe('resolveGateCutovers', () => {
  it('a null config resolves every cutover to null — NO cutover on any gate (O1)', () => {
    expect(resolveGateCutovers(null)).toEqual(NO_GATE_CUTOVERS)
  })

  it('a config with no `gateCutovers` key resolves every cutover to null (O1)', () => {
    const config = { rings: { ring1_forgeWriteInterception: true, ring2_asyncAudits: true } } as VinayaConfig
    expect(resolveGateCutovers(config)).toEqual(NO_GATE_CUTOVERS)
  })

  it('an empty `gateCutovers` object resolves every field to null (O1)', () => {
    const config = { gateCutovers: {} } as VinayaConfig
    expect(resolveGateCutovers(config)).toEqual(NO_GATE_CUTOVERS)
  })

  it('a fully-declared `gateCutovers` returns each number verbatim (O2)', () => {
    const config = {
      gateCutovers: {
        objectivesSinceIssue: 404,
        briefSectionsSinceIssue: 426,
        documentationSinceIssue: 626,
        briefRulesSincePr: 394,
        agentBoxesRefusedSincePr: 396
      }
    } as VinayaConfig
    expect(resolveGateCutovers(config)).toEqual({
      objectivesSinceIssue: 404,
      briefSectionsSinceIssue: 426,
      documentationSinceIssue: 626,
      briefRulesSincePr: 394,
      agentBoxesRefusedSincePr: 396
    })
  })

  it('a partial `gateCutovers` sets the declared fields and leaves the rest as null (no cutover)', () => {
    const config = { gateCutovers: { objectivesSinceIssue: 404 } } as VinayaConfig
    expect(resolveGateCutovers(config)).toEqual({
      objectivesSinceIssue: 404,
      briefSectionsSinceIssue: null,
      documentationSinceIssue: null,
      briefRulesSincePr: null,
      agentBoxesRefusedSincePr: null
    })
  })

  it('accepts 0 as a real cutover (grandfathers nothing — every positive Issue/PR is at or above it)', () => {
    const config = { gateCutovers: { objectivesSinceIssue: 0 } } as VinayaConfig
    expect(resolveGateCutovers(config).objectivesSinceIssue).toBe(0)
  })
})
