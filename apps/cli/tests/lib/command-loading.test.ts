/**
 * The command-line entry point loads a command's module only when that command runs. A test that runs one command
 * then reads only that command's code, so the test selection, which follows what each test read, does not pick every
 * command-running test for a change to any one command.
 */
import { expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { staticClosure as closureOf } from './static-closure.js'

const REPO_ROOT = join(import.meta.dir, '../../../..')
const ENTRY = join(REPO_ROOT, 'apps/cli/src/index.ts')

/** Every repository file the entry point reaches through static `import` statements alone. */
const staticClosure = (entry: string): string[] => closureOf(entry, REPO_ROOT)

it('the entry point imports no command module statically', () => {
  const closure = staticClosure(ENTRY)
  expect(closure).toContain('apps/cli/src/index.ts')
  expect(closure.filter((file) => file.startsWith('apps/cli/src/commands/'))).toEqual([])
})

it('the entry point loads only argument routing at startup: no Log file, no configuration provider, no check registry', () => {
  const closure = staticClosure(ENTRY)
  expect(closure.filter((file) => file.startsWith('harness/kernel/log/'))).toEqual([])
  expect(closure.filter((file) => /config\/compose|config-provider|checks\/registry/.test(file))).toEqual([])
  expect(closure.length).toBeLessThanOrEqual(25)
})

it('every command module the entry point names is one it loads on demand', () => {
  const source = readFileSync(ENTRY, 'utf8')
  const onDemand = [...source.matchAll(/await import\('(\.\/commands\/[^']+)'\)/g)].map((m) => m[1] as string)
  expect(onDemand.length).toBeGreaterThan(0)
  for (const specifier of onDemand)
    expect([specifier, existsSync(join(REPO_ROOT, 'apps/cli/src', specifier.replace(/\.js$/, '.ts')))]).toEqual([
      specifier,
      true
    ])
})
