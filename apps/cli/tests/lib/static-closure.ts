// The static import closure the command-loading test reads, kept apart from the test so a registry can run it.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { resolveAliasedPath } from '@harness/kernel/imports/alias-table.js'

/**
 * Every repository file `entry` reaches through static `import` statements alone, repository-relative and sorted.
 * A relative specifier and an aliased one both name a repository file; anything else is a package and is not followed.
 */
export function staticClosure(entry: string, repoRoot: string): string[] {
  const transpiler = new Bun.Transpiler({ loader: 'ts' })
  const seen = new Set<string>()
  const stack = [entry]
  const resolveLocal = (from: string, specifier: string): string | null => {
    const aliased = specifier.startsWith('.') ? null : resolveAliasedPath(repoRoot, specifier)
    if (!specifier.startsWith('.') && aliased === null) return null
    const base = aliased === null ? resolve(dirname(from), specifier) : resolve(repoRoot, aliased)
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
  return [...seen].map((file) => relative(repoRoot, file)).sort()
}
