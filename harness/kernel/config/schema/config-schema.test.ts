import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
  hookBlockPathRule,
  isSafeRepoRelPath,
  KERNEL_CHECK_ENTRY_FIELDS,
  KERNEL_CONFIG_KEYS,
  kernelConfigFragment,
  lintEnvDeclarations,
  resolveAgentVendors,
  resolveLogsHeaderValues,
  resolveLogsSetting,
  resolveRuntimeDirSetting,
  resolveTaskRunner,
  resolveTrustAnchorLogsDestination,
  resolveTrustAnchorRuntimeDir
} from './config-schema'
import { orderedShape } from './process-config-section'

// A process of the test's own: two vendors, one hook folder, a free-form event grammar, and one extra check field.
const fragment = kernelConfigFragment({
  agentVendors: ['alpha', 'beta'] as const,
  hookBlockPrefixes: ['.hooks/'],
  logEvents: z.record(z.string(), z.object({ kind: z.string() })),
  checkEntryFields: { ...KERNEL_CHECK_ENTRY_FIELDS, owner: z.string().optional() }
})
const schema = z.object(fragment)
const issues = (value: unknown) => {
  const parsed = schema.safeParse(value)
  return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
}

describe('the kernel configuration schema', () => {
  test('declares exactly the kernel keys', () => {
    expect(Object.keys(fragment)).toEqual([...KERNEL_CONFIG_KEYS])
  })

  test('a check entry carries the fields it is given, and its anyOf keys must name themselves once', () => {
    expect(issues({ checks: { a: { run: 'x', scope: 'diff', owner: 'me' } } })).toEqual([])
    expect(issues({ checks: { a: { run: 'x', scope: 'diff', env: { TOKEN: { anyOf: ['GH', 'GH'] } } } } })).toEqual([
      'checks.a.env.TOKEN.anyOf: env.TOKEN.anyOf has duplicate members',
      'checks.a.env.TOKEN.anyOf: env.TOKEN.anyOf must include "TOKEN" itself as a member'
    ])
  })

  test('the managed manifest takes the vendors and hook folders the process supplies', () => {
    const manifest = { version: 3, files: ['a.md'], labels: [], agents: ['alpha'] }
    expect(
      issues({ managed: { ...manifest, blocks: [{ path: '.hooks/pre-push', marker: 'm', comment: 'hash' }] } })
    ).toEqual([])
    expect(
      issues({ managed: { ...manifest, blocks: [{ path: '.git/hooks/x', marker: 'm', comment: 'hash' }] } })
    ).toEqual(['managed.blocks.0.path: must start with one of .hooks/ (byte-exact, case-sensitive)'])
    expect(issues({ managed: { ...manifest, blocks: [], agents: ['gamma'] } })).toHaveLength(1)
    expect(hookBlockPathRule(['.hooks/']).isCanonical('.hooks/')).toBe(false)
  })

  test('logs takes one destination, headers only with a url, and the process event grammar', () => {
    expect(issues({ logs: { folder: '/var/log', url: 'https://example.test' } })).toEqual([
      'logs: logs: set at most one of folder/url'
    ])
    expect(issues({ logs: { folder: 'relative' } })).toHaveLength(1)
    expect(issues({ logs: { url: 'https://example.test', events: { ping: { kind: 'x' } } } })).toEqual([])
    expect(issues({ logs: false })).toEqual([])
  })

  test('logPublish is refused naming its replacement, and runtimeDir must be absolute', () => {
    expect(issues({ logPublish: {} })[0]).toContain('configure `logs` instead')
    expect(issues({ runtimeDir: 'runs' })).toEqual(['runtimeDir: runtimeDir: must be an absolute path'])
  })
})

describe('the kernel configuration resolvers', () => {
  test('runtimeDir and logs resolve from the working tree, and an unattended read only when the default branch agrees', () => {
    expect(resolveRuntimeDirSetting(null)).toBeNull()
    expect(resolveTrustAnchorRuntimeDir('/a', { runtimeDir: '/a' })).toBe('/a')
    expect(resolveTrustAnchorRuntimeDir('/a', { runtimeDir: '/b' })).toBeNull()
    const local = resolveLogsSetting({ logs: { url: 'https://example.test', headers: { A: 'local' } } })
    expect(local).toEqual({ url: 'https://example.test', headers: { A: 'local' } })
    expect(
      resolveTrustAnchorLogsDestination(local ?? { folder: '/x' }, {
        logs: { url: 'https://example.test', headers: { A: 'anchored' } }
      })
    ).toEqual({ url: 'https://example.test', headers: { A: 'anchored' } })
    expect(resolveTrustAnchorLogsDestination({ folder: '/x' }, { logs: { folder: '/y' } })).toBeNull()
  })

  test('header references resolve from the environment, an unset one to the empty string', () => {
    // A literal `${NAME}` reference, written with `$` concatenated so it is never read as a template placeholder.
    const reference = (name: string) => `$${'{'}${name}}`
    expect(resolveLogsHeaderValues({ A: `Bearer ${reference('T')}`, B: reference('MISSING') }, { T: 'tok' })).toEqual({
      A: 'Bearer tok',
      B: ''
    })
    expect(resolveLogsHeaderValues(undefined, {})).toBeUndefined()
  })

  test('the runner defaults to standalone and refuses an unknown name', () => {
    expect(resolveTaskRunner(undefined, null)).toBe('standalone')
    expect(resolveTaskRunner(undefined, { runner: 'atta-engine' })).toBe('atta-engine')
    expect(() => resolveTaskRunner('other', null)).toThrow('runner: expected standalone or atta-engine')
  })

  test('an unrecorded vendor selection is every vendor; a recorded empty one stays empty', () => {
    expect([...resolveAgentVendors(undefined, ['alpha', 'beta'])]).toEqual(['alpha', 'beta'])
    expect([...resolveAgentVendors({ agents: [] }, ['alpha', 'beta'])]).toEqual([])
  })

  test('env lint flags literal booleans and high-entropy literals', () => {
    const warnings = lintEnvDeclarations({ c: { env: { A: 'true', B: 'aB3dE5gH7jK9mN1pQ3sT5', C: true } } })
    expect(warnings).toHaveLength(2)
    expect(isSafeRepoRelPath('../x')).toBe(false)
  })
})

describe('ordered composition of fragments', () => {
  test('places each key in the given order', () => {
    const shape = orderedShape(['b', 'a'], { a: z.string() }, { b: z.number() })
    expect(Object.keys(shape)).toEqual(['b', 'a'])
  })

  test('refuses a key two fragments declare, a key with no place, and a place with no key', () => {
    expect(() => orderedShape(['a'], { a: z.string() }, { a: z.string() })).toThrow('declared by two fragments')
    expect(() => orderedShape(['a'], { a: z.string(), b: z.string() })).toThrow('has no place in the order')
    expect(() => orderedShape(['a', 'c'], { a: z.string() })).toThrow('no fragment declares it')
  })
})
