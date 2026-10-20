import { describe, expect, it } from 'bun:test'
import { compareVersions, deriveStatus } from './derive-status'

describe('deriveStatus', () => {
  const published = { version: '0.19.2' }
  const unreachable = { fallback: true as const }

  it('is shipping when the milestone version is at or below the published version', () => {
    expect(deriveStatus({ status: 'planned', version: '0.19.0' }, published)).toBe('shipping')
    expect(deriveStatus({ status: 'planned', version: '0.19.2' }, published)).toBe('shipping')
  })

  it('is planned when the milestone version is above the published version', () => {
    expect(deriveStatus({ status: 'shipping', version: '0.20.0' }, published)).toBe('planned')
  })

  it('dropped always wins, regardless of version', () => {
    expect(deriveStatus({ status: 'dropped', version: '0.1.0' }, published)).toBe('dropped')
    expect(deriveStatus({ status: 'dropped', version: '9.9.9' }, published)).toBe('dropped')
  })

  it('falls back to the CMS-stored status when the registry is unreachable', () => {
    expect(deriveStatus({ status: 'planned', version: '0.19.0' }, unreachable)).toBe('planned')
    expect(deriveStatus({ status: 'shipping', version: '0.19.0' }, unreachable)).toBe('shipping')
  })

  it('falls back to the CMS-stored status when version is null — no target to compare against', () => {
    expect(deriveStatus({ status: 'planned', version: null }, published)).toBe('planned')
    // Even a status of 'shipping' with no version isn't auto-corrected — status is the
    // only source of truth while version is empty; the registry comparison never runs.
    expect(deriveStatus({ status: 'shipping', version: null }, published)).toBe('shipping')
  })

  it('dropped still wins over a null version', () => {
    expect(deriveStatus({ status: 'dropped', version: null }, published)).toBe('dropped')
  })
})

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('0.19.3', '0.19.3')).toBe(0)
  })

  it('is negative when the first version is lower', () => {
    expect(compareVersions('0.19.0', '0.19.3')).toBeLessThan(0)
  })

  it('is positive when the first version is higher', () => {
    expect(compareVersions('1.0.0', '0.24.0')).toBeGreaterThan(0)
  })

  it('compares segments numerically, not lexically', () => {
    expect(compareVersions('0.19.10', '0.19.3')).toBeGreaterThan(0)
  })

  it('treats a missing trailing segment as 0', () => {
    expect(compareVersions('0.19', '0.19.0')).toBe(0)
    expect(compareVersions('0.19', '0.19.1')).toBeLessThan(0)
  })
})
