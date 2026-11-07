#!/usr/bin/env bun
/**
 * Copies the portable doctrine from the process folder
 * (`harness/processes/vinaya-strict/`) into `apps/cli/vinaya-strict/` — a
 * build-time artifact, gitignored, so `npm pack`/`npm publish` (both run this
 * via `prepack`) can ship it as a normal top-level package directory, the same
 * convention `templates/` already uses. Doctrine outside the package's own
 * directory tree can never reach the tarball any other way — npm's `files`
 * allowlist cannot reach outside the package root.
 *
 * The file list is the doctrine map's (`tools/doctrine/doctrine-map.ts`), never
 * a blanket copy of the process folder: only the rows marked `ships` are
 * copied — the process folder also holds the process's own code, and the
 * unshipped rows (the manual-flow page, the documentation-coherence page, the
 * reviewer prompt) are this repository's operational prose rather than the
 * portable core. Each file lands at the same process-relative path under
 * `vinaya-strict/`, so a relative link between doctrine files resolves the
 * same way in the source tree and in an installed package.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  BUNDLED_DOCTRINE_DIR,
  DOCTRINE_MAP,
  DOCTRINE_TREE
} from '../../../harness/processes/vinaya-strict/tools/doctrine/doctrine-map'

const pkgRoot = join(import.meta.dir, '..')
const monorepoRoot = join(pkgRoot, '..', '..')
const sourceRoot = join(monorepoRoot, DOCTRINE_TREE)
const targetRoot = join(pkgRoot, BUNDLED_DOCTRINE_DIR)

const shipped = DOCTRINE_MAP.filter((entry) => entry.ships)

const missing = shipped.filter((entry) => !existsSync(join(sourceRoot, entry.source)))
if (missing.length > 0) {
  console.error(
    `bundle-doctrine: ${missing.length} shipped doctrine file(s) missing under ${sourceRoot} — run from within the vinaya monorepo: ${missing.map((entry) => entry.source).join(', ')}`
  )
  process.exit(1)
}

if (existsSync(targetRoot)) rmSync(targetRoot, { recursive: true, force: true })

for (const entry of shipped) {
  const target = join(targetRoot, entry.source)
  mkdirSync(dirname(target), { recursive: true })
  cpSync(join(sourceRoot, entry.source), target)
}

console.log(`bundle-doctrine: copied ${shipped.length} doctrine files into ${targetRoot}`)
