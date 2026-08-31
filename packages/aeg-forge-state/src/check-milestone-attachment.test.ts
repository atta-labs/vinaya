import { describe, expect, it } from 'vitest'
import { checkMilestoneAttachment } from './check-milestone-attachment'
import { resolveMilestoneAttachTarget } from './fetch-milestone'

describe('checkMilestoneAttachment', () => {
  it('reports clean when every labeled Issue is attached and nothing foreign is attached', () => {
    expect(checkMilestoneAttachment([981, 982, 983], [981, 982, 983])).toEqual({ status: 'clean' })
  })

  it("names unattached Issues — labeled but never given the native milestone field (Issue #301's live-observed defect)", () => {
    expect(checkMilestoneAttachment([981, 982, 983], [981])).toEqual({
      status: 'mismatch',
      unattached: [982, 983],
      foreign: []
    })
  })

  it("names foreign Issues — attached to the Milestone but not carrying this tranche's label", () => {
    expect(checkMilestoneAttachment([981, 982], [981, 982, 999])).toEqual({
      status: 'mismatch',
      unattached: [],
      foreign: [999]
    })
  })

  it('reports both halves of the diff at once when a Milestone is both under- and over-attached', () => {
    expect(checkMilestoneAttachment([981, 982], [982, 999])).toEqual({
      status: 'mismatch',
      unattached: [981],
      foreign: [999]
    })
  })

  it('is order- and duplicate-independent', () => {
    expect(checkMilestoneAttachment([983, 981, 981], [981, 983])).toEqual({ status: 'clean' })
  })
})

describe('legacy vs intent-declared Milestone resolution (the target `milestone close` checks attachment against)', () => {
  it("resolves the legacy exact-title Milestone for a slug's close target", () => {
    const milestones = [{ number: 9, title: 'aeg-review-gate-v1', description: '', state: 'open' as const }]
    expect(resolveMilestoneAttachTarget(milestones, 'aeg-review-gate-v1')).toEqual({
      number: 9,
      title: 'aeg-review-gate-v1'
    })
  })

  it("resolves an intent-declared Milestone by its own title for a slug's close target — the gap the legacy-only `--milestone <slug>` recipe in tranche-archivist.md left open", () => {
    const description = [
      'Ship the Engine.',
      '',
      '### Tranche intents',
      '- engine-agent-spawn-v1: Real agent spawn.'
    ].join('\n')
    const milestones = [{ number: 64, title: 'Engine', description, state: 'open' as const }]
    expect(resolveMilestoneAttachTarget(milestones, 'engine-agent-spawn-v1')).toEqual({ number: 64, title: 'Engine' })
  })
})
