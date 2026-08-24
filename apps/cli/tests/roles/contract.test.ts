import { describe, expect, it } from 'bun:test'
import { validateRoleContract } from '../../src/roles/contract'

const VALID = `---
sidebar_title: Foo
title: Foo
order: 1
role_id: foo
description: Does the foo thing.
actor: agent
performs:
  - do-foo
refuses_when: >
  Never.
summary: Ever needed foo?
---
# Foo — Role Reference

## The short version

Foo does foo, and nothing else.

## Reference

More detail here.
`

describe('validateRoleContract', () => {
  it('accepts a well-formed contract', () => {
    const result = validateRoleContract(VALID)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.contract).toEqual({
      roleId: 'foo',
      title: 'Foo',
      order: 1,
      description: 'Does the foo thing.',
      actor: 'agent',
      performs: ['do-foo'],
      refusesWhen: 'Never.\n',
      summary: 'Ever needed foo?'
    })
  })

  it('accepts a non-integer "order" (a fractional insertion point)', () => {
    const result = validateRoleContract(VALID.replace('order: 1', 'order: 1.5'))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.contract.order).toBe(1.5)
  })

  it('rejects a missing "role_id"', () => {
    const result = validateRoleContract(VALID.replace('role_id: foo\n', ''))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.some((e) => e.includes('role_id'))).toBe(true)
  })

  it('rejects a missing "title"', () => {
    const result = validateRoleContract(VALID.replace('title: Foo\n', ''))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.some((e) => e.includes('title'))).toBe(true)
  })

  it('rejects a missing "order"', () => {
    const result = validateRoleContract(VALID.replace('order: 1\n', ''))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.some((e) => e.includes('order'))).toBe(true)
  })

  it('rejects a missing "description"', () => {
    const result = validateRoleContract(VALID.replace('description: Does the foo thing.\n', ''))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.some((e) => e.includes('description'))).toBe(true)
  })

  it('rejects an invalid "actor"', () => {
    const result = validateRoleContract(VALID.replace('actor: agent', 'actor: robot'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.some((e) => e.includes('actor'))).toBe(true)
  })

  it('rejects a missing "performs"', () => {
    const result = validateRoleContract(VALID.replace('performs:\n  - do-foo\n', ''))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.some((e) => e.includes('performs'))).toBe(true)
  })

  it('rejects a missing "refuses_when"', () => {
    const result = validateRoleContract(VALID.replace('refuses_when: >\n  Never.\n', ''))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.some((e) => e.includes('refuses_when'))).toBe(true)
  })

  it('rejects a missing "summary"', () => {
    const result = validateRoleContract(VALID.replace('summary: Ever needed foo?\n', ''))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.some((e) => e.includes('summary'))).toBe(true)
  })

  it('rejects a body with no "## The short version" heading', () => {
    const result = validateRoleContract(VALID.replace('## The short version', '## Something else'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.some((e) => e.includes('The short version'))).toBe(true)
  })

  it('rejects a "## The short version" heading with nothing under it', () => {
    const empty = VALID.replace(
      '## The short version\n\nFoo does foo, and nothing else.\n\n## Reference',
      '## The short version\n\n## Reference'
    )
    const result = validateRoleContract(empty)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.some((e) => e.includes('The short version'))).toBe(true)
  })

  it('accepts "## The short version" as the last section in the file (no trailing heading)', () => {
    const trailing = `---
title: Foo
order: 1
role_id: foo
description: Does the foo thing.
actor: agent
performs:
  - do-foo
refuses_when: Never.
summary: Ever needed foo?
---
## The short version

Foo does foo.
`
    const result = validateRoleContract(trailing)
    expect(result.ok).toBe(true)
  })

  it('collects every violation at once rather than stopping at the first', () => {
    const result = validateRoleContract('---\n---\nno heading here\n')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.length).toBeGreaterThan(1)
  })
})
