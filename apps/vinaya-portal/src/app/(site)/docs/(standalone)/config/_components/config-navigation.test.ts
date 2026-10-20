import { describe, expect, it } from 'bun:test'
import { configFieldSlug } from './config-navigation'

describe('config navigation', () => {
  it('uses stable hashes for both top-level and nested config fields', () => {
    expect(configFieldSlug('checks')).toBe('config-checks')
    expect(configFieldSlug('checks.env.literal')).toBe('config-checks-env-literal')
  })
})
