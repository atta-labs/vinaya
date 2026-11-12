import { readFileSync, existsSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

const INTEGRATION = 'harness/processes/vinaya-strict/integration/'

/** Explicit ownership of generated content. Sources are derived, never hand-maintained. */
export const GENERATED_ARTIFACT_WRITERS: Readonly<Record<string, string>> = {
  '.mcp.json': `${INTEGRATION}adapters.ts`,
  'AGENTS.md': `${INTEGRATION}artifacts.ts`,
  'CLAUDE.md': `${INTEGRATION}artifacts.ts`,
  'vinaya.config.json': `${INTEGRATION}artifacts.ts`,
  '.vinaya/doc-owners': `${INTEGRATION}artifacts.ts`,
  'vinaya/checks/.gitkeep': `${INTEGRATION}artifacts.ts`,
  'vinaya/roles/.gitkeep': `${INTEGRATION}artifacts.ts`,
  '.gemini/settings.json': `${INTEGRATION}artifacts.ts`,
  '.github/workflows/vinaya-checks.yml': `${INTEGRATION}artifacts.ts`,
  '.github/workflows/vinaya-review.yml': `${INTEGRATION}artifacts.ts`,
  '.github/workflows/vinaya-review-verdict.yml': `${INTEGRATION}artifacts.ts`,
  '.github/workflows/vinaya-body-checks.yml': `${INTEGRATION}artifacts.ts`,
  '.github/workflows/vinaya-archivist.yml': `${INTEGRATION}artifacts.ts`,
  '.vinaya/hooks/pre-commit': `${INTEGRATION}artifacts.ts`,
  '.vinaya/hooks/pre-push': `${INTEGRATION}artifacts.ts`,
  '.vinaya/hooks/commit-msg': `${INTEGRATION}artifacts.ts`,
  '.husky/pre-commit': `${INTEGRATION}artifacts.ts`,
  '.husky/pre-push': `${INTEGRATION}artifacts.ts`,
  '.husky/commit-msg': `${INTEGRATION}artifacts.ts`,
  '.claude/commands/vinaya.md': `${INTEGRATION}claude-command-emitter.ts`,
  '.gemini/commands/vinaya.toml': `${INTEGRATION}gemini-command-emitter.ts`,
  '.claude/settings.json': `${INTEGRATION}claude-stop-hook-emitter.ts`,
  '.claude/hooks/track-transcript.sh': `${INTEGRATION}claude-stop-hook-emitter.ts`,
  ...Object.fromEntries(
    ['architect', 'archivist', 'developer', 'operator', 'planner', 'reviewer', 'security', 'tranche-archivist'].flatMap(
      (role) =>
        ['.agents/skills', '.claude/skills'].map((directory) => [
          `${directory}/vinaya-${role}/SKILL.md`,
          `${INTEGRATION}agents-skills-emitter.ts`
        ])
    )
  )
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
  const closures = new Map<string, string[]>()
  return Object.entries(GENERATED_ARTIFACT_WRITERS).flatMap(([path, writer]) => {
    if (!existsSync(resolve(root, writer))) return []
    let sources = closures.get(writer)
    if (!sources) {
      sources = transitiveImportClosure(writer, tree)
      closures.set(writer, sources)
    }
    return [{ path, writer, sources }]
  })
}
