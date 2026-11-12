import { readFileSync, existsSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

/** The roles the installer writes a skill for. */
const SKILL_ROLES = [
  'architect',
  'archivist',
  'developer',
  'operator',
  'planner',
  'reviewer',
  'security',
  'tranche-archivist'
] as const

const INTEGRATION = 'harness/processes/vinaya-strict/integration/'

/**
 * The module that writes each generated file. A generated file's sources are that writer, every module the writer
 * imports directly (the constants and builders it writes into the file), other than another file's writer it only
 * calls for that file. Computed from the writer's own import statements, never
 * listed by hand and never followed past one level: everything further away is reachable from the writer but decides
 * none of the file's bytes, and a set that wide refuses tasks that cannot change the file.
 *
 * `vinaya.config.json` and `.vinaya/doc-owners` are left out on purpose: `vinaya upgrade` keeps them as the
 * adopter's own content. The two placeholder `.gitkeep` files are empty and depend on no source.
 */
const ARTIFACTS = `${INTEGRATION}artifacts.ts`
const SKILLS = `${INTEGRATION}agents-skills-emitter.ts`
export const GENERATED_ARTIFACT_WRITERS: Readonly<Record<string, string>> = {
  '.mcp.json': `${INTEGRATION}adapters.ts`,
  'AGENTS.md': ARTIFACTS,
  'CLAUDE.md': ARTIFACTS,
  '.gemini/settings.json': ARTIFACTS,
  '.github/workflows/vinaya-checks.yml': ARTIFACTS,
  '.github/workflows/vinaya-review.yml': ARTIFACTS,
  '.github/workflows/vinaya-review-verdict.yml': ARTIFACTS,
  '.github/workflows/vinaya-body-checks.yml': ARTIFACTS,
  '.github/workflows/vinaya-archivist.yml': ARTIFACTS,
  '.vinaya/hooks/pre-commit': ARTIFACTS,
  '.vinaya/hooks/pre-push': ARTIFACTS,
  '.vinaya/hooks/commit-msg': ARTIFACTS,
  '.husky/pre-commit': ARTIFACTS,
  '.husky/pre-push': ARTIFACTS,
  '.husky/commit-msg': ARTIFACTS,
  '.claude/commands/vinaya.md': `${INTEGRATION}claude-command-emitter.ts`,
  '.gemini/commands/vinaya.toml': `${INTEGRATION}gemini-command-emitter.ts`,
  '.claude/settings.json': `${INTEGRATION}claude-stop-hook-emitter.ts`,
  '.claude/hooks/track-transcript.sh': `${INTEGRATION}claude-stop-hook-emitter.ts`,
  ...Object.fromEntries(
    SKILL_ROLES.flatMap((role) =>
      ['.agents/skills', '.claude/skills'].map((directory) => [`${directory}/vinaya-${role}/SKILL.md`, SKILLS])
    )
  )
}

/** Generated files the installer writes that no source decides, so no pin can make them drift. */
export const NON_SOURCED_GENERATED_FILES: readonly string[] = [
  'vinaya.config.json',
  '.vinaya/doc-owners',
  'vinaya/checks/.gitkeep',
  'vinaya/roles/.gitkeep'
]

/**
 * Not predicted here: a role's skill file also copies that role's doctrine frontmatter (its actor and tool grants).
 * Most tasks that pin a doctrine file change its prose, which no skill copies, so counting the whole doctrine file
 * would refuse nearly every such task; a frontmatter change is caught when the pull request's own checks find the
 * skill out of date.
 */
/** A writer and the modules it imports directly, resolved inside the repository. */
export function directSources(writer: string, tree: ImportTree): string[] {
  const loader = /\.[jt]sx$/.test(writer) ? 'tsx' : /\.[cm]?ts$/.test(writer) ? 'ts' : 'js'
  const imported = new Bun.Transpiler({ loader })
    .scanImports(tree.read(writer).replace(/^#![^\n]*/, ''))
    .map((entry) => tree.resolve(entry.path, writer))
    .filter((path): path is string => path !== null)
  return [...new Set([writer, ...imported])].sort()
}

export type GeneratedArtifactSources = { path: string; writer: string; sources: string[] }
export type ImportTree = {
  read: (path: string) => string
  resolve: (specifier: string, importer: string) => string | null
}

/** Includes the writer itself and each runtime import, re-export, require and literal dynamic import, cycle-safe. */
export function transitiveImportClosure(writer: string, tree: ImportTree): string[] {
  const visited = new Set<string>()
  const visit = (path: string): void => {
    if (visited.has(path)) return
    visited.add(path)
    if (!/\.[cm]?[jt]sx?$/.test(path)) return
    const loader = /\.[jt]sx$/.test(path) ? 'tsx' : /\.[cm]?ts$/.test(path) ? 'ts' : 'js'
    const imports = new Bun.Transpiler({ loader }).scanImports(tree.read(path).replace(/^#![^\n]*/, ''))
    for (const entry of imports) {
      const dependency = tree.resolve(entry.path, path)
      if (dependency !== null) visit(dependency)
    }
  }
  visit(writer)
  return [...visited].sort()
}

/** Resolve through Bun, including workspace exports and .js specifiers targeting TypeScript. Never executes a generator. */
export function repositoryImportTree(root: string): ImportTree {
  return {
    read: (path) => readFileSync(resolve(root, path), 'utf8'),
    resolve: (specifier, importer) => {
      if (specifier.startsWith('node:') || specifier.startsWith('bun:')) return null
      let absolute: string
      try {
        absolute = Bun.resolveSync(specifier, dirname(resolve(root, importer)))
      } catch (error) {
        if (specifier.startsWith('.')) throw error
        return null
      }
      if (!isAbsolute(absolute)) return null
      const path = relative(root, absolute).replaceAll('\\', '/')
      return path.startsWith('../') || path.split('/').includes('node_modules') ? null : path
    }
  }
}

/** Dormant in adopters without the generator source tree; reads only the repository being planned. */
export function readGeneratedArtifactSources(root: string): GeneratedArtifactSources[] {
  const tree = repositoryImportTree(root)
  const direct = new Map<string, string[]>()
  return Object.entries(GENERATED_ARTIFACT_WRITERS).flatMap(([path, writer]) => {
    if (!existsSync(resolve(root, writer))) return []
    let sources = direct.get(writer)
    if (!sources) {
      // A writer that calls another writer for that writer's own file takes none of its content.
      const others = new Set(Object.values(GENERATED_ARTIFACT_WRITERS).filter((other) => other !== writer))
      sources = directSources(writer, tree).filter((source) => !others.has(source))
      direct.set(writer, sources)
    }
    return [{ path, writer, sources }]
  })
}
