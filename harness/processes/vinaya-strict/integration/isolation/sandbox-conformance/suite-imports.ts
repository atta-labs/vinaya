// The import walk of the sandbox-conformance suite: it lists the suite's own source files so that a change to any of
// them triggers the live sandbox run. Kept apart from the test so a registry can run it on a fixture tree.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { resolveAliasedPath } from '@harness/kernel/imports/alias-table.js'

/** The suite's helper modules under `apps/cli/tests/` are followed, `src/` and package modules are not. */
export function suiteImports(
  startFiles: readonly string[],
  repoRoot: string
): { modules: Set<string>; packages: Set<string> } {
  const modules = new Set<string>()
  const packages = new Set<string>()
  const queue = [...startFiles]
  for (const file of queue) {
    const source = readFileSync(file, 'utf8')
    for (const m of source.matchAll(/^(?:import|export)\b[^'"]*?from\s+'([^']+)'/gms)) {
      const specifier = m[1] ?? ''
      if (specifier.startsWith('@attalabs/')) packages.add(specifier)
      // A relative specifier is read from the importing file; an aliased one names a path of the repository.
      const aliased = specifier.startsWith('.') ? null : resolveAliasedPath(repoRoot, specifier)
      if (!specifier.startsWith('.') && aliased === null) continue
      const named = aliased === null ? resolve(dirname(file), specifier) : join(repoRoot, aliased)
      const ts = named.replace(/\.js$/, '.ts')
      const rel = relative(repoRoot, ts)
      modules.add(rel)
      if (rel.startsWith('apps/cli/tests/') && !queue.includes(ts) && existsSync(ts)) queue.push(ts)
    }
  }
  return { modules, packages }
}
