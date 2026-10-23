import { describe, expect, test } from 'bun:test'
import type { VinayaConfig } from '../../../src/lib/config.js'
import { resolveTrustAnchorSecurityScanCommand } from '../../../src/lib/dev-review-loop/security-scan-command.js'

describe('resolveTrustAnchorSecurityScanCommand', () => {
  test('returns the argv the trust anchor configures', () => {
    const config = { securityScan: { command: ['npx', '--yes', 'scanner@1.0.0', 'scan'] } } as unknown as VinayaConfig
    expect(resolveTrustAnchorSecurityScanCommand(() => config)).toEqual(['npx', '--yes', 'scanner@1.0.0', 'scan'])
  })

  test('returns null when the anchor is unreadable or configures none', () => {
    expect(resolveTrustAnchorSecurityScanCommand(() => null)).toBeNull()
    expect(resolveTrustAnchorSecurityScanCommand(() => ({}) as VinayaConfig)).toBeNull()
  })

  test('reads the anchor through the reader it is given, once per call', () => {
    let reads = 0
    resolveTrustAnchorSecurityScanCommand(() => {
      reads += 1
      return null
    })
    expect(reads).toBe(1)
  })
})
