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
 *
 * It also copies every file the process loader pins in the process digest —
 * `process.yaml`, each declared Flow, every file under each launched role
 * folder and every path `process.yaml` names under `provides` — into
 * `dist/vinaya-strict/`, at the same process-relative paths, so the built
 * Engine runner loads the process from an installed package with the digest a
 * checkout loads it to. The list is the process declaration's, read by the
 * loader itself, never a hand-written one. The copy sits under `dist` (already
 * in the manifest's `files`) and never beside the doctrine: some pinned files
 * are tests, which the test walkers and the CI shard check skip only under
 * `dist` and `node_modules`. The folder is removed before each copy, so a
 * source file deleted since the last pack leaves no stale copy behind.
 *
 * `--out <dir>` writes both trees under `<dir>` instead of the package folder.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { loadProcess, PROCESS_FILE } from '@harness/kernel/dev-process-socket/loader/load-process'
import { BUNDLED_DOCTRINE_DIR, DOCTRINE_MAP, DOCTRINE_TREE } from '@harness/workflow/tools/doctrine/doctrine-map'
import { BUILT_PROCESS_FOLDER } from '@harness/workflow/tools/programs'

const pkgRoot = join(import.meta.dir, '..')
const monorepoRoot = join(pkgRoot, '..', '..')
const sourceRoot = join(monorepoRoot, DOCTRINE_TREE)

function filesUnder(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path]
  return readdirSync(path)
    .sort()
    .flatMap((entry) => filesUnder(join(path, entry)))
}

/**
 * Every file the process loader pins in the digest of the process at `folder`, relative to that folder and sorted:
 * the process file, every declared Flow, every file under each launched role folder, and every file under each
 * path `provides` names.
 */
export function pinnedProcessFiles(folder: string): string[] {
  const loaded = loadProcess(folder)
  const provided = loaded.provided
  const declared = [
    join(loaded.folder, PROCESS_FILE),
    ...Object.values(loaded.flowPaths),
    ...loaded.rolePaths,
    ...(provided
      ? [
          ...Object.values(provided.roles).flatMap((role) =>
            [role.doctrine, role.grants, role.outputSchema, role.tools].filter(
              (path): path is string => path !== undefined
            )
          ),
          provided.checks,
          provided.policies,
          provided.configSection,
          provided.integration
        ]
      : [])
  ]
  return [...new Set(declared.flatMap(filesUnder).map((file) => relative(loaded.folder, file)))].sort()
}

/** Copies the pinned process files of the process at `folder` into `target`, emptied first. Returns the files copied. */
export function shipProcessFiles(folder: string, target: string): string[] {
  const files = pinnedProcessFiles(folder)
  if (existsSync(target)) rmSync(target, { recursive: true, force: true })
  const copiedAt = new Date()
  for (const file of files) {
    const to = join(target, file)
    mkdirSync(dirname(to), { recursive: true })
    cpSync(join(folder, file), to)
    // A copy is this pack's output: stamp it now, as the build stamps what it emits. A cloned copy can keep its
    // source's time, and a `dist` file older than the build reads as an earlier build's leftover.
    utimesSync(to, copiedAt, copiedAt)
  }
  return files
}

function main(argv: readonly string[]): void {
  const outFlag = argv.indexOf('--out')
  if (outFlag !== -1 && !argv[outFlag + 1]) {
    console.error('bundle-doctrine: --out needs a folder')
    process.exit(2)
  }
  const outRoot = outFlag === -1 ? pkgRoot : resolve(argv[outFlag + 1] as string)
  const targetRoot = join(outRoot, BUNDLED_DOCTRINE_DIR)

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

  const processTarget = join(outRoot, BUILT_PROCESS_FOLDER)
  const processFiles = shipProcessFiles(sourceRoot, processTarget)
  console.log(`bundle-doctrine: copied ${processFiles.length} pinned process files into ${processTarget}`)
}

if (import.meta.main) main(process.argv.slice(2))
