// `vinaya doctrine` — print where the bundled doctrine lives on THIS machine.
//
// The committed root `VINAYA.md` pointer deliberately carries no filesystem
// path: the package's install location is a property of each machine, and
// that file is committed for every clone. This
// command is the resolution step the pointer hands the reader — it resolves
// the installed package's own `aeg-root/` at READ time, wherever the CLI
// physically sits, so the pointer's bytes stay machine-independent while the
// answer stays machine-correct.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import matter from 'gray-matter'
import { printJson } from '../lib/envelope.js'
import { packageRoot } from '../lib/package-root.js'

/** The doctrine's front door, relative to its `aeg-root/`. */
export const ENTRY_SEGMENTS = ['skills', 'aeg', 'SKILL.md'] as const

/**
 * The doctrine root, resolved by WHERE THIS CLI IS RUNNING FROM — not by
 * which candidate directory happens to exist first.
 *
 * **Installed** (a `node_modules` segment in the package root): the only
 * candidate is `<packageRoot>/aeg-root`, the published-tarball shape
 * (`aeg-root` is in this package's `files` array). Nothing above it is
 * tried: walking out of an npm install lands in the adopter's dependency
 * tree, where a package that happens to be named `aeg-root` would be served
 * as doctrine to agents told to read and follow it.
 *
 * **From source** (no `node_modules` segment): the only candidate is the
 * repo root's own `aeg-root/` — `<packageRoot>/../../aeg-root`, the exact
 * directory `scripts/bundle-doctrine.ts` copies FROM. The package-relative
 * bundle is not merely second here; it is IGNORED. That bundle is a
 * gitignored pack-time artifact, so in a checkout that has ever run a pack
 * it is a stale copy of the live tree sitting at the higher-priority path —
 * and the ordered-candidate form served it, silently, to every agent that
 * asked this command where its doctrine lives. Two directories with the same
 * name, one of them git-ignored and stale, is exactly the shape that already
 * cost this tranche a review round through `apps/cli/dist`. A checkout is
 * governed by the doctrine it has committed, and that is the repo root's.
 *
 * `pkg` is injectable for tests; every real caller takes the default.
 */
export function resolveDoctrineRoot(
  pkg: string = packageRoot(import.meta.url),
  cwd: string = process.cwd()
): string | null {
  return resolveDoctrineRootInfo(pkg, cwd)?.root ?? null
}

/** Where a resolved doctrine root came from — the calling repo's own tree, or a package-bundled copy. */
export type DoctrineSource = 'tree' | 'bundle'

/** `null` when `git -C cwd rev-parse --show-toplevel` fails — not a git worktree, or `git` itself missing. */
function gitToplevel(cwd: string): string | null {
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
 * `resolveDoctrineRoot`, with the source it resolved through attached. A
 * repo whose root carries its own `aeg-root/roles/` — this repo, or any
 * adopter who vendors the tree — is governed by that tree, never by
 * whatever bundled copy happens to sit next to the CLI binary that's
 * running: a globally-installed `vinaya` invoked from inside such a repo
 * previously resolved the bundle it shipped with, silently serving doctrine
 * up to two releases stale (a real regression). The `<packageRoot>`-based
 * candidates above remain the fallback — the ONLY candidate for a repo (or
 * subtree) with no `aeg-root/roles/` of its own, e.g. every ordinary
 * adopter reading the published bundle.
 *
 * `cwd` is injectable for tests; every real caller takes the default.
 */
export function resolveDoctrineRootInfo(
  pkg: string = packageRoot(import.meta.url),
  cwd: string = process.cwd()
): { root: string; source: DoctrineSource } | null {
  const toplevel = gitToplevel(cwd)
  if (toplevel !== null) {
    const treeRoot = join(toplevel, 'aeg-root')
    if (existsSync(join(treeRoot, 'roles'))) return { root: treeRoot, source: 'tree' }
  }
  const fromSource = !pkg.split(sep).includes('node_modules')
  const bundleRoot = fromSource ? join(dirname(dirname(pkg)), 'aeg-root') : join(pkg, 'aeg-root')
  return hasDoctrineEntry(bundleRoot) ? { root: bundleRoot, source: 'bundle' } : null
}

/**
 * Role-name spellings that are not filenames under `roles/`. `code-reviewer`
 * is the name the review commands, the agent definitions and the process
 * doctrine all use for the role whose file is `reviewer.md`; asking for it by
 * that name and being told it "is not a known role" is a papercut with a real
 * cost — it is the exact string a dispatched reviewer is handed. Resolved as
 * an alias rather than by renaming the file, so every existing `--role
 * reviewer` caller is untouched.
 */
const ROLE_ALIASES: Readonly<Record<string, string>> = { 'code-reviewer': 'reviewer' }

/**
 * Retired role spellings that must refuse rather than resolve, even while
 * `roles/<name>.md` still exists on disk. `brief-author` is retired: the
 * brief is now dispatched by the Planner, not authored by a separate role
 * (`author-the-brief` in `actions.ts` is `performedBy: ['planner']`), but
 * `roles/brief-author.md` itself is a later task's deletion — until then
 * `listRoleNames()` would still enumerate it as live. The refusal points the
 * caller at its replacement instead of silently handing back doctrine for a
 * role nothing dispatches anymore.
 */
const RETIRED_ROLES: Readonly<Record<string, string>> = { 'brief-author': 'planner' }

/**
 * Whether `root` is itself a real doctrine root — i.e. `<root>/skills/aeg/SKILL.md`
 * exists. Exported so a caller resolving `root` by a DIFFERENT anchor than
 * `resolveDoctrineRoot`'s own package-relative default (e.g. the repo actually
 * under check, via `git rev-parse --show-toplevel`, rather than wherever the
 * calling module's own file happens to sit on disk) can validate its own
 * candidate with the same test this function uses, instead of duplicating the
 * `ENTRY_SEGMENTS` check inline.
 */
export function hasDoctrineEntry(root: string): boolean {
  return existsSync(join(root, ...ENTRY_SEGMENTS))
}

/**
 * Role names actually available under `<root>/roles/`, from `*.md` filenames —
 * never a hardcoded list. Excludes any role whose frontmatter declares
 * `actor: human` (`principal`) — `--role` hands its output to a third-party
 * agent tool as operating instructions (`.agents/skills/`, `.claude/commands/`,
 * `.gemini/commands/` all shell out to this exact flag), so a human-only role
 * must never resolve through it: doing so would tell an AI tool to act with
 * the one authority this doctrine deliberately never grants an agent. Filtered
 * on the same structured `actor` signal `agents-skills-emitter.ts`'s own
 * `discoverRoleNames()` already uses, not a hardcoded name exclusion, so a
 * future human-only role is excluded automatically.
 */
function listRoleNames(root: string): string[] {
  const rolesDir = join(root, 'roles')
  if (!existsSync(rolesDir)) return []
  return readdirSync(rolesDir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.slice(0, -'.md'.length))
    .filter((roleName) => {
      const { data } = matter(readFileSync(join(rolesDir, `${roleName}.md`), 'utf8'))
      return data.actor !== 'human'
    })
    .sort()
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

  const roleFlagIndex = args.indexOf('--role')
  if (roleFlagIndex !== -1) {
    const requested = args[roleFlagIndex + 1]
    // `Object.hasOwn`, never a bare index: a bare lookup reaches
    // `Object.prototype`, so `--role constructor` resolved to a function and
    // crashed instead of producing the ordinary "not a known role" refusal.
    const roleName =
      requested !== undefined
        ? Object.hasOwn(ROLE_ALIASES, requested)
          ? (ROLE_ALIASES[requested] as string)
          : requested
        : undefined
    if (roleName !== undefined && Object.hasOwn(RETIRED_ROLES, roleName)) {
      process.stderr.write(
        `vinaya doctrine --role: '${roleName}' has been retired — use --role ${RETIRED_ROLES[roleName]}.\n`
      )
      process.exit(1)
    }
    const validRoleNames = listRoleNames(root)
    if (roleName === undefined || roleName.startsWith('--') || !validRoleNames.includes(roleName)) {
      process.stderr.write(
        `vinaya doctrine --role: '${requested ?? ''}' is not a known role. ` +
          `Valid role names: ${validRoleNames.join(', ')}\n`
      )
      process.exit(1)
    }
    const entry = join(root, 'roles', `${roleName}.md`)
    if (args.includes('--json')) {
      printJson({ root, entry })
      return
    }
    process.stdout.write(`${entry}\n`)
    return
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

import type { SurfaceExemption } from '../lib/surface-exemption'

export const SURFACE_EXEMPTIONS: Record<string, SurfaceExemption> = {
  doctrine: { date: '2026-09-05', callsToday: 2, retiresVia: 'sharedCommandShell' }
}
