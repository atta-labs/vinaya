/**
 * The command-line entry point loads a command's module only when that command runs. A test that runs one command
 * then reads only that command's code, so the test selection, which follows what each test read, does not pick every
 * command-running test for a change to any one command.
 */
import { expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '../../../..')
const ENTRY = join(REPO_ROOT, 'apps/cli/src/index.ts')

/** Every repository file the entry point reaches through static `import` statements alone. */
function staticClosure(entry: string): string[] {
  const transpiler = new Bun.Transpiler({ loader: 'ts' })
  const seen = new Set<string>()
  const stack = [entry]
  const resolveLocal = (from: string, specifier: string): string | null => {
    if (!specifier.startsWith('.')) return null
    const base = resolve(dirname(from), specifier)
    for (const candidate of [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), `${base}.ts`, base])
      if (/\.(ts|tsx|js)$/.test(candidate) && existsSync(candidate)) return candidate
    return null
  }
  while (stack.length > 0) {
    const file = stack.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    const source = readFileSync(file, 'utf8').replace(/^#!.*/, '')
    for (const found of transpiler.scanImports(source)) {
      if (found.kind !== 'import-statement') continue
      const next = resolveLocal(file, found.path)
      if (next) stack.push(next)
    }
  }
  return [...seen].map((file) => relative(REPO_ROOT, file)).sort()
}

/** Whether a command module only carries the process's startup installers to the entry point, which runs them before any command. */
const forwardsStartupInstallers = (file: string): boolean =>
  /\binstallVinayaLogSinkFactory\b/.test(readFileSync(join(REPO_ROOT, file), 'utf8'))

it('the entry point imports no command module statically, except one that carries the startup installers', () => {
  const closure = staticClosure(ENTRY)
  expect(closure).toContain('apps/cli/src/index.ts')
  const commands = closure.filter((file) => file.startsWith('apps/cli/src/commands/'))
  expect(commands.filter((file) => !forwardsStartupInstallers(file))).toEqual([])
  expect(commands.length).toBeLessThanOrEqual(1)
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
