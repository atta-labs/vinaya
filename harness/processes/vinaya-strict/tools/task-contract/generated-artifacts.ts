import { readFileSync, existsSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

const INTEGRATION = 'harness/processes/vinaya-strict/integration/'

/**
 * The modules whose own content becomes each generated file's content: the module that writes the file, then the
 * modules whose data it writes into it. A task that pins one of these must reach the generated file in its Surface.
 *
 * Listed by hand, from the repository's history of changes to each generated file, never derived by following
 * imports: everything the writer imports is reachable from it, but most of it never reaches the file's bytes, and a
 * set that wide refuses tasks that cannot change the file at all. The test keeps every listed module real and
 * reachable from the writer. `vinaya.config.json` and `.vinaya/doc-owners` are left out on purpose: `vinaya upgrade`
 * keeps them as the adopter's own content. The two placeholder `.gitkeep` files are empty and depend on no source.
 */
const ARTIFACTS = `${INTEGRATION}artifacts.ts`
const MCP_SOURCES = [
  `${INTEGRATION}adapters.ts`,
  `${INTEGRATION}server.ts`,
  `${INTEGRATION}policies/roles.ts`,
  'harness/kernel/tools/host/seat-host.ts',
  'harness/processes/vinaya-strict/tools/programs.ts'
]
export const GENERATED_ARTIFACT_SOURCES: Readonly<Record<string, readonly string[]>> = {
  '.mcp.json': MCP_SOURCES,
  'AGENTS.md': [ARTIFACTS],
  'CLAUDE.md': [ARTIFACTS],
  '.gemini/settings.json': [ARTIFACTS],
  '.github/workflows/vinaya-checks.yml': [ARTIFACTS],
  '.github/workflows/vinaya-review.yml': [ARTIFACTS],
  '.github/workflows/vinaya-review-verdict.yml': [ARTIFACTS],
  '.github/workflows/vinaya-body-checks.yml': [ARTIFACTS],
  '.github/workflows/vinaya-archivist.yml': [ARTIFACTS],
  '.vinaya/hooks/pre-commit': [ARTIFACTS],
  '.vinaya/hooks/pre-push': [ARTIFACTS],
  '.vinaya/hooks/commit-msg': [ARTIFACTS],
  '.husky/pre-commit': [ARTIFACTS],
  '.husky/pre-push': [ARTIFACTS],
  '.husky/commit-msg': [ARTIFACTS],
  '.claude/commands/vinaya.md': [`${INTEGRATION}claude-command-emitter.ts`],
  '.gemini/commands/vinaya.toml': [`${INTEGRATION}gemini-command-emitter.ts`],
  '.claude/settings.json': [`${INTEGRATION}claude-stop-hook-emitter.ts`],
  '.claude/hooks/track-transcript.sh': [`${INTEGRATION}claude-stop-hook-emitter.ts`],
  ...Object.fromEntries(
    ['architect', 'archivist', 'developer', 'operator', 'planner', 'reviewer', 'security', 'tranche-archivist'].flatMap(
      (role) =>
        ['.agents/skills', '.claude/skills'].map((directory) => [
          `${directory}/vinaya-${role}/SKILL.md`,
          [`${INTEGRATION}agents-skills-emitter.ts`]
        ])
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
  return Object.entries(GENERATED_ARTIFACT_SOURCES).flatMap(([path, sources]) => {
    const writer = sources[0] as string
    if (!existsSync(resolve(root, writer))) return []
    return [{ path, writer, sources: [...sources] }]
  })
}
