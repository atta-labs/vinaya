import { describe, expect, test } from 'bun:test'
import { agentEnvAllowlist } from './launch-env'

describe('agentEnvAllowlist', () => {
  test('forwards PATH, HOME and the Keychain login names USER and LOGNAME', () => {
    expect(agentEnvAllowlist()).toEqual(['PATH', 'HOME', 'USER', 'LOGNAME'])
    expect(agentEnvAllowlist({ extra: [] })).toEqual(['PATH', 'HOME', 'USER', 'LOGNAME'])
  })

  test('adds exactly the extra names the caller forwards', () => {
    expect(agentEnvAllowlist({ extra: ['SOME_OPT_IN'] })).toEqual(['PATH', 'HOME', 'USER', 'LOGNAME', 'SOME_OPT_IN'])
  })
})
