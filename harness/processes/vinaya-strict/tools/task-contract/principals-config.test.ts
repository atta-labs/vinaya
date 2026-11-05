import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PRINCIPALS_CONFIG_FIX, readConfigPrincipals } from './principals-config'

describe('readConfigPrincipals', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'principals-config-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  const writeConfig = (content: string): void => writeFileSync(join(dir, 'vinaya.config.json'), content)

  it('returns the configured list verbatim', () => {
    writeConfig(JSON.stringify({ principals: ['alice', 'Bob'] }))
    expect(readConfigPrincipals(dir)).toEqual({ ok: true, principals: ['alice', 'Bob'] })
  })

  it('refuses, naming the fix, when the file is missing', () => {
    const result = readConfigPrincipals(dir)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain(PRINCIPALS_CONFIG_FIX)
  })

  it('refuses, naming the fix, when the file is not JSON', () => {
    writeConfig('{ not json')
    const result = readConfigPrincipals(dir)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain(PRINCIPALS_CONFIG_FIX)
  })

  it('refuses, naming the fix, when the key is absent — never a built-in default', () => {
    writeConfig(JSON.stringify({ checks: [] }))
    const result = readConfigPrincipals(dir)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain(PRINCIPALS_CONFIG_FIX)
  })

  it('refuses an empty list as a misconfiguration, not "trust nobody"', () => {
    writeConfig(JSON.stringify({ principals: [] }))
    expect(readConfigPrincipals(dir).ok).toBe(false)
  })

  it.each([['"daniboomerang"'], ['[1]'], ['["alice", null]'], ['[""]'], ['null']])(
    'refuses a value that is not a non-empty array of login strings: %s',
    (value) => {
      writeConfig(`{ "principals": ${value} }`)
      const result = readConfigPrincipals(dir)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain(PRINCIPALS_CONFIG_FIX)
    }
  )

  it('refuses a JSON document that is not an object', () => {
    writeConfig('["alice"]')
    expect(readConfigPrincipals(dir).ok).toBe(false)
  })
})
