import { describe, expect, it } from 'vitest'
import {
  resolvePriorTrancheArchival,
  type PriorTrancheArchivalDeps,
  type PriorTrancheArchivalFact
} from './prior-tranche-archival'

const REPO = { owner: 'atta-labs', repo: 'vinaya' }

type Overrides = Partial<PriorTrancheArchivalDeps>
const deps = (overrides: Overrides = {}): PriorTrancheArchivalDeps => ({
  activeTrancheSlugs: async () => ['prior-tranche-v1'],
  deriveTranche: async () => ({ tasks: [{ projects: ['cli'] }] }) as never,
  openIssues: async () => [],
  ...overrides
})

const unarchived = (slug: string): PriorTrancheArchivalFact => ({
  project: 'cli',
  priorTrancheSlug: slug,
  archived: false
})

describe('resolvePriorTrancheArchival — a failed read is unknown, never "no prior tranche"', () => {
  it('a null open-Issues answer yields the infrastructure failure and no fact', async () => {
    const result = await resolvePriorTrancheArchival(['cli'], 'x', REPO, deps({ openIssues: async () => null }))
    expect(result.infraFailure).toContain('severity:infra')
    expect(result.infraFailure).toContain('open Issues')
    expect(result.infraFailure).toContain('prior-tranche-v1')
    expect(result.facts).toEqual([])
  })

  it('a rejected open-Issues read is the same failure', async () => {
    const result = await resolvePriorTrancheArchival(
      ['cli'],
      'x',
      REPO,
      deps({
        openIssues: async () => {
          throw new Error('gh exploded')
        }
      })
    )
    expect(result.infraFailure).toContain('open Issues')
    expect(result.facts).toEqual([])
  })

  it('a failed active-tranche read fails closed with no fact', async () => {
    const result = await resolvePriorTrancheArchival(
      ['cli'],
      'x',
      REPO,
      deps({
        activeTrancheSlugs: async () => {
          throw new Error('milestones unreachable')
        }
      })
    )
    expect(result.infraFailure).toContain('severity:infra')
    expect(result.infraFailure).toContain('active tranches')
    expect(result.infraFailure).toContain('milestones unreachable')
    expect(result.facts).toEqual([])
  })

  it('a failed tranche derivation fails closed and names the tranche', async () => {
    const result = await resolvePriorTrancheArchival(
      ['cli'],
      'x',
      REPO,
      deps({
        deriveTranche: async () => {
          throw new Error('issues unreachable')
        }
      })
    )
    expect(result.infraFailure).toContain('severity:infra')
    expect(result.infraFailure).toContain('prior-tranche-v1')
    expect(result.facts).toEqual([])
  })

  it('the failure message does not name the verifier', async () => {
    const result = await resolvePriorTrancheArchival(['cli'], 'x', REPO, deps({ openIssues: async () => null }))
    expect(result.infraFailure).not.toContain('verify-dispatch')
  })

  it('one project failing leaves the other projects answered', async () => {
    const result = await resolvePriorTrancheArchival(
      ['cli', 'sources'],
      'x',
      REPO,
      deps({
        deriveTranche: async () => ({ tasks: [{ projects: ['cli'] }] }) as never,
        openIssues: async () => null
      })
    )
    expect(result.facts).toEqual([{ project: 'sources', priorTrancheSlug: null, archived: false }])
    expect(result.infraFailure).toContain('project `cli`')
  })
})

describe('resolvePriorTrancheArchival — answers when every read succeeds', () => {
  it('a prior tranche with every Issue closed yields the archival fact', async () => {
    const result = await resolvePriorTrancheArchival(['cli'], 'x', REPO, deps())
    expect(result).toEqual({ facts: [unarchived('prior-tranche-v1')], infraFailure: null })
  })

  it('a prior tranche with open Issues is no block and no failure', async () => {
    const result = await resolvePriorTrancheArchival(
      ['cli'],
      'x',
      REPO,
      deps({ openIssues: async () => [{ number: 12 }] })
    )
    expect(result).toEqual({ facts: [{ project: 'cli', priorTrancheSlug: null, archived: false }], infraFailure: null })
  })

  it('a prior tranche touching another project is skipped without reading its Issues', async () => {
    let reads = 0
    const result = await resolvePriorTrancheArchival(
      ['sources'],
      'x',
      REPO,
      deps({
        openIssues: async () => {
          reads++
          return []
        }
      })
    )
    expect(reads).toBe(0)
    expect(result.facts).toEqual([{ project: 'sources', priorTrancheSlug: null, archived: false }])
  })

  it('no projects reads nothing and returns no fact', async () => {
    const result = await resolvePriorTrancheArchival(
      [],
      'x',
      REPO,
      deps({
        activeTrancheSlugs: async () => {
          throw new Error('must not be read')
        }
      })
    )
    expect(result).toEqual({ facts: [], infraFailure: null })
  })
})
