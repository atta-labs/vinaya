import { describe, expect, it } from 'vitest'
import { type CustomEventDeclarations, CustomEventDeclarationsSchema, checkCustomEvent } from './custom'

function messages(input: unknown): string[] {
  const parsed = CustomEventDeclarationsSchema.safeParse(input)
  return parsed.success ? [] : parsed.error.issues.map((i) => i.message)
}

describe('CustomEventDeclarationsSchema — the logs.events rules', () => {
  it('accepts every field type: text, number, boolean and a list of words', () => {
    const input = {
      'acme.deploy': { fields: { env: ['prod', 'staging'], count: 'number', note: 'text', ok: 'boolean' } },
      'acme.build.finished': { fields: {} }
    }
    expect(CustomEventDeclarationsSchema.safeParse(input).success).toBe(true)
  })

  it('refuses a name that is not <namespace>.<event>, naming the entry', () => {
    for (const name of ['deploy', 'Acme.deploy', 'acme.', '.deploy', '1acme.deploy', 'acme-co.deploy']) {
      expect(messages({ [name]: { fields: {} } }).join(' ')).toContain(`"${name}"`)
    }
  })

  it('refuses a name longer than 64 characters', () => {
    const name = `acme.${'a'.repeat(60)}`
    expect(messages({ [name]: { fields: {} } }).join(' ')).toContain('at most 64 characters')
  })

  it('refuses a name in the reserved vinaya. namespace', () => {
    expect(messages({ 'vinaya.gate': { fields: {} } }).join(' ')).toContain('reserved')
  })

  it('refuses more than 20 fields', () => {
    const fields = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`f${i}`, 'number']))
    expect(messages({ 'acme.big': { fields } }).join(' ')).toContain('"acme.big": at most 20 fields')
  })

  it('refuses a malformed field name, naming the field', () => {
    expect(messages({ 'acme.deploy': { fields: { Env: 'text' } } }).join(' ')).toContain('field "Env"')
  })

  it('refuses a type that is not one of the four', () => {
    expect(CustomEventDeclarationsSchema.safeParse({ 'acme.deploy': { fields: { env: 'string' } } }).success).toBe(
      false
    )
    expect(
      CustomEventDeclarationsSchema.safeParse({ 'acme.deploy': { fields: { env: { type: 'text' } } } }).success
    ).toBe(false)
  })

  it('refuses an empty list of words, a malformed word and a repeated word', () => {
    expect(messages({ 'acme.a': { fields: { env: [] } } }).join(' ')).toContain('at least one word')
    expect(messages({ 'acme.a': { fields: { env: ['Prod'] } } }).join(' ')).toContain('listed word')
    expect(messages({ 'acme.a': { fields: { env: ['prod', 'prod'] } } }).join(' ')).toContain('twice')
  })

  it('refuses an extra key beside fields', () => {
    expect(CustomEventDeclarationsSchema.safeParse({ 'acme.a': { fields: {}, kind: 'gate' } }).success).toBe(false)
  })
})

const declarations: CustomEventDeclarations = {
  'acme.deploy': { fields: { env: ['prod', 'staging'], count: 'number', note: 'text', ok: 'boolean' } }
}
const valid = { env: 'prod', count: 2, note: 'shipped', ok: true }

describe('checkCustomEvent', () => {
  it('accepts a declared event with every field of its declared type', () => {
    expect(checkCustomEvent(declarations, 'acme.deploy', valid)).toEqual({
      ok: true,
      name: 'acme.deploy',
      fields: valid
    })
  })

  it('refuses an undeclared name', () => {
    expect(checkCustomEvent(declarations, 'acme.other', valid)).toEqual({
      ok: false,
      reason: 'undeclared',
      fieldNames: []
    })
  })

  it('refuses a name only an object prototype carries', () => {
    expect(checkCustomEvent(declarations, 'constructor', {})).toMatchObject({ ok: false, reason: 'undeclared' })
  })

  it('refuses a missing field, naming it', () => {
    const { count: _c, note: _n, ...rest } = valid
    expect(checkCustomEvent(declarations, 'acme.deploy', rest)).toEqual({
      ok: false,
      reason: 'missing_field',
      fieldNames: ['count', 'note']
    })
  })

  it('refuses an extra field, naming it', () => {
    expect(checkCustomEvent(declarations, 'acme.deploy', { ...valid, zone: 'eu' })).toEqual({
      ok: false,
      reason: 'extra_field',
      fieldNames: ['zone']
    })
  })

  it('records an extra field name not shaped like one as unrecordable, never the name itself', () => {
    const result = checkCustomEvent(declarations, 'acme.deploy', { ...valid, 'token=ghp_abc': 'x' })
    expect(result).toEqual({ ok: false, reason: 'extra_field', fieldNames: ['<unrecordable>'] })
  })

  it('refuses a value of the wrong type, naming the field', () => {
    for (const [field, value] of [
      ['env', 'dev'],
      ['env', 1],
      ['count', '2'],
      ['count', Number.NaN],
      ['note', 5],
      ['ok', 'yes'],
      ['note', { nested: 'x' }],
      ['note', ['x']],
      ['note', null]
    ] as const) {
      expect(checkCustomEvent(declarations, 'acme.deploy', { ...valid, [field]: value })).toEqual({
        ok: false,
        reason: 'wrong_type',
        fieldNames: [field]
      })
    }
  })

  it('refuses a text value over 500 characters', () => {
    expect(checkCustomEvent(declarations, 'acme.deploy', { ...valid, note: 'x'.repeat(501) })).toEqual({
      ok: false,
      reason: 'too_long',
      fieldNames: ['note']
    })
    expect(checkCustomEvent(declarations, 'acme.deploy', { ...valid, note: 'x'.repeat(500) }).ok).toBe(true)
  })
})
