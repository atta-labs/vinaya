import { describe, expect, test } from 'bun:test'
import { type RoleGrants, withModel } from './manifest'

const grants = (claude: string, codex: string) =>
  ({ role: 'developer', vendor: { claude: { model: claude }, codex: { model: codex } } }) as unknown as RoleGrants

describe('withModel', () => {
  test('replaces every process-supplied model', () => {
    const out = withModel(grants('process-supplied', 'process-supplied'), 'opus')
    expect(out.vendor.claude.model).toBe('opus')
    expect(out.vendor.codex.model).toBe('opus')
  })

  test('keeps a model the grants pin, and leaves the input untouched', () => {
    const input = grants('sonnet', 'process-supplied')
    const out = withModel(input, 'opus')
    expect(out.vendor.claude.model).toBe('sonnet')
    expect(out.vendor.codex.model).toBe('opus')
    expect(input.vendor.codex.model).toBe('process-supplied')
  })

  test('an absent model returns the grants unchanged', () => {
    const input = grants('process-supplied', 'gpt')
    expect(withModel(input, undefined)).toBe(input)
  })
})
