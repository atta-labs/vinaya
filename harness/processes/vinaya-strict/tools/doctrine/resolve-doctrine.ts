// Doctrine resolution — where the Vinaya doctrine lives on THIS machine.
//
// The committed root `AGENTS.md` pointer deliberately carries no filesystem
// path: the package's install location is a property of each machine, and
// that file is committed for every clone. `vinaya doctrine` is the resolution
// step the pointer hands the reader, and it resolves through this module at
// READ time, wherever the command line physically sits, so the pointer's bytes
// stay machine-independent while the answer stays machine-correct.
//
// Every doctrine file is found through the doctrine map (`./doctrine-map.ts`):
// a root here is the folder the map's source paths are relative to — the
// process folder in a checkout, the package's bundled `vinaya-strict/` in an
// install.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { cliPackageRoot } from '../../../../../apps/cli/src/lib/package-root'
import { BUNDLED_DOCTRINE_DIR, DOCTRINE_TREE, FRONT_DOOR_SOURCE, TEMPLATE_ENTRIES } from './doctrine-map'

/** The doctrine's front door, relative to a doctrine root. */
export const ENTRY_SEGMENTS: readonly string[] = FRONT_DOOR_SOURCE.split('/')

/** Where a resolved doctrine root came from — the calling repo's own tree, or a package-bundled copy. */
export type DoctrineSource = 'tree' | 'bundle'

/** `null` when `git -C cwd rev-parse --show-toplevel` fails — not a git worktree, or `git` itself missing. */
export function gitToplevel(cwd: string): string | null {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } catch {
    return null
  }
}

/**
 * The doctrine root, resolved by WHERE THE COMMAND LINE IS RUNNING FROM — not
 * by which candidate directory happens to exist first.
 *
 * **Installed** (a `node_modules` segment in the package root): the only
 * candidate is `<packageRoot>/vinaya-strict`, the published-tarball shape
 * (`vinaya-strict` is in the package's `files` array). Nothing above it is
 * tried: walking out of an npm install lands in the adopter's dependency
 * tree, where a package that happens to carry that name would be served as
 * doctrine to agents told to read and follow it.
 *
 * **From source** (no `node_modules` segment): the only candidate is the
 * repository's own process folder — `<packageRoot>/../../harness/processes/vinaya-strict`,
 * the exact folder the bundler copies FROM. The package-relative bundle is
 * IGNORED: it is a gitignored pack-time artifact, so in a checkout that has
 * ever run a pack it is a stale copy of the live tree. A checkout is governed
 * by the doctrine it has committed.
 *
 * `pkg` is the command line package's root; every real caller takes the
 * default, which stays anchored in the command line package wherever this
 * module sits.
 */
export function resolveDoctrineRoot(pkg: string = cliPackageRoot(), cwd: string = process.cwd()): string | null {
  return resolveDoctrineRootInfo(pkg, cwd)?.root ?? null
}

/**
 * `resolveDoctrineRoot`, with the source it resolved through attached. A repo
 * whose toplevel carries the front door at its source path — this repo, or any
 * adopter who vendors the tree — is governed by that tree, never by whatever
 * bundled copy happens to sit next to the binary that is running: a
 * globally-installed `vinaya` invoked from inside such a repo would otherwise
 * serve doctrine releases stale. The `<packageRoot>`-based candidate remains
 * the fallback — the ONLY candidate for a repo with no doctrine tree of its
 * own, e.g. every ordinary adopter reading the published bundle.
 */
export function resolveDoctrineRootInfo(
  pkg: string = cliPackageRoot(),
  cwd: string = process.cwd()
): { root: string; source: DoctrineSource } | null {
  const toplevel = gitToplevel(cwd)
  if (toplevel !== null) {
    const treeRoot = join(toplevel, DOCTRINE_TREE)
    if (hasDoctrineEntry(treeRoot)) return { root: treeRoot, source: 'tree' }
  }
  const fromSource = !pkg.split(sep).includes('node_modules')
  const bundleRoot = fromSource ? join(dirname(dirname(pkg)), DOCTRINE_TREE) : join(pkg, BUNDLED_DOCTRINE_DIR)
  return hasDoctrineEntry(bundleRoot) ? { root: bundleRoot, source: 'bundle' } : null
}

/**
 * Role-name spellings that are not role ids. `code-reviewer` is the name the
 * review commands, the agent definitions and the process doctrine all use for
 * the role whose id is `reviewer`; asking for it by that name and being told
 * it "is not a known role" is a papercut with a real cost — it is the exact
 * string a dispatched reviewer is handed. Resolved as an alias, so every
 * existing `--role reviewer` caller is untouched.
 */
export const ROLE_ALIASES: Readonly<Record<string, string>> = { 'code-reviewer': 'reviewer' }

/**
 * Retired role spellings that must refuse rather than resolve. `brief-author`
 * is retired: the brief is dispatched by the Planner, not authored by a
 * separate role. The refusal points the caller at its replacement instead of
 * silently handing back doctrine for a role nothing dispatches anymore.
 */
export const RETIRED_ROLES: Readonly<Record<string, string>> = { 'brief-author': 'planner' }

/**
 * Whether `root` is itself a real doctrine root — i.e. the front door exists
 * at its source path under it. Exported so a caller resolving `root` by a
 * DIFFERENT anchor than `resolveDoctrineRoot`'s own default (e.g. the repo
 * actually under check) can validate its own candidate with the same test.
 */
export function hasDoctrineEntry(root: string): boolean {
  return existsSync(join(root, ...ENTRY_SEGMENTS))
}

/**
 * Template names the doctrine map carries whose file exists under `root` —
 * never a hardcoded list. `pr-report-template.md` is therefore
 * `--template pr-report`.
 */
export function listTemplateNames(root: string): string[] {
  return TEMPLATE_ENTRIES.filter((entry) => existsSync(join(root, entry.source)))
    .map((entry) => entry.template as string)
    .sort()
}

/** The file a `--template` name resolves to under `root`, or `null` for a name the map does not carry. */
export function templatePath(root: string, name: string): string | null {
  const entry = TEMPLATE_ENTRIES.find((candidate) => candidate.template === name)
  return entry === undefined ? null : join(root, entry.source)
}
