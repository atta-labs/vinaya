// `vinaya doctrine` — print where the bundled doctrine lives on THIS machine.
//
// The committed root `VINAYA.md` pointer deliberately carries no filesystem
// path: the package's install location is a property of each machine, and
// that file is committed for every clone (atta-labs/attalabs#928). This
// command is the resolution step the pointer hands the reader — it resolves
// the installed package's own `aeg-root/` at READ time, wherever the CLI
// physically sits, so the pointer's bytes stay machine-independent while the
// answer stays machine-correct.

import { existsSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { printJson } from '../lib/envelope.js'
import { packageRoot } from '../lib/package-root.js'

/** The doctrine's front door, relative to its `aeg-root/`. */
export const ENTRY_SEGMENTS = ['skills', 'aeg', 'SKILL.md'] as const

/**
 * Candidate doctrine roots, in resolution order:
 *
 * 1. `<packageRoot>/aeg-root` — the published-tarball shape (`aeg-root` is in
 *    this package's `files` array), which is every ordinary install.
 * 2. `<packageRoot>/../../aeg-root` — the vendored dev shape. The bundled
 *    copy is a gitignored pack-time artifact (`scripts/bundle-doctrine.ts`),
 *    so in a monorepo that vendors the CLI the live doctrine is the monorepo
 *    root's own `aeg-root/` — the exact directory `bundle-doctrine` copies
 *    from, reached by the same `../..` relation that script encodes.
 *
 * The fallback is tried only when the CLI does NOT sit inside a
 * `node_modules` tree: an npm-installed copy always carries its own bundled
 * `aeg-root/`, so on such an install the fallback could only ever fire on a
 * broken artifact — and there it would walk into the adopter's dependency
 * tree, where a package that happens to be named `aeg-root` would be served
 * as doctrine to agents told to read and follow it.
 *
 * `pkg` is injectable for tests; every real caller takes the default.
 */
export function resolveDoctrineRoot(pkg: string = packageRoot(import.meta.url)): string | null {
  const candidates = [join(pkg, 'aeg-root')]
  if (!pkg.split(sep).includes('node_modules')) candidates.push(join(dirname(dirname(pkg)), 'aeg-root'))
  for (const root of candidates) {
    if (existsSync(join(root, ...ENTRY_SEGMENTS))) return root
  }
  return null
}

export function doctrineCommand(args: string[]): void {
  const root = resolveDoctrineRoot()
  if (root === null) {
    process.stderr.write(
      'vinaya doctrine: no bundled doctrine found next to this CLI install. ' +
        'The doctrine ships inside the @attalabs/vinaya npm package — reinstall it, ' +
        "or, in a repo that vendors the CLI, run the package's bundle-doctrine script first.\n"
    )
    process.exit(1)
  }
  const entry = join(root, ...ENTRY_SEGMENTS)
  if (args.includes('--json')) {
    printJson({ root, entry })
    return
  }
  // Bare output is the entry path alone, so it composes:
  // `cat "$(vinaya doctrine)"` opens the front door directly.
  process.stdout.write(`${entry}\n`)
}
