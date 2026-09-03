// `vinaya doctrine` — print where the bundled doctrine lives on THIS machine.
//
// The committed root `VINAYA.md` pointer deliberately carries no filesystem
// path: the package's install location is a property of each machine, and
// that file is committed for every clone (atta-labs/attalabs#928). This
// command is the resolution step the pointer hands the reader — it resolves
// the installed package's own `aeg-root/` at READ time, wherever the CLI
// physically sits, so the pointer's bytes stay machine-independent while the
// answer stays machine-correct.

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
export function resolveDoctrineRoot(pkg: string = packageRoot(import.meta.url)): string | null {
  const fromSource = !pkg.split(sep).includes('node_modules')
  const root = fromSource ? join(dirname(dirname(pkg)), 'aeg-root') : join(pkg, 'aeg-root')
  return hasDoctrineEntry(root) ? root : null
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
    const roleName = requested !== undefined ? (ROLE_ALIASES[requested] ?? requested) : undefined
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
