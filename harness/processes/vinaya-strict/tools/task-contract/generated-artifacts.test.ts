import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import {
  GENERATED_ARTIFACT_WRITERS,
  readGeneratedArtifactSources,
  repositoryImportTree,
  transitiveImportClosure
} from './generated-artifacts'

const ROOT = resolve(import.meta.dir, '../../../../..')

describe('generated artifact sources', () => {
  it('maps every file and managed block the real installer generates', async () => {
    const { buildInitOps } = await import('../../integration/artifacts')
    const generated = buildInitOps({
      owner: 'owner',
      repo: 'repo',
      hookDir: '.vinaya/hooks',
      selfHost: null,
      ciSetup: null,
      agents: new Set(['skills', 'claude', 'gemini'])
    }).flatMap((op) => (op.kind === 'create-file' || op.kind === 'managed-block' ? [op.path] : []))
    const mapped = Object.keys(GENERATED_ARTIFACT_WRITERS).filter((path) => !path.startsWith('.husky/'))
    expect(mapped.sort()).toEqual(generated.sort())
  })
  it('walks literal import forms and cycles without scanning comments or source strings', () => {
    const files: Record<string, string> = {
      'src/writer.ts': `import './direct.ts'; export * from './export.ts'; const x = import('./dynamic.ts'); const y = require('./required.ts');\n// import './comment.ts'\nconst text = "import './string.ts'";`,
      'src/direct.ts': `import './leaf.ts'; import './writer.ts'; import 'external';`,
      'src/export.ts': `export { x } from './leaf.ts'`,
      'src/dynamic.ts': '',
      'src/required.ts': '',
      'src/leaf.ts': 'export const x = 1'
    }
    const sources = transitiveImportClosure('src/writer.ts', {
      read: (path) =>
        files[path] ??
        (() => {
          throw new Error(`unexpected read: ${path}`)
        })(),
      resolve: (specifier) => (specifier.startsWith('./') ? `src/${specifier.slice(2)}` : null)
    })
    expect(sources).toEqual([
      'src/direct.ts',
      'src/dynamic.ts',
      'src/export.ts',
      'src/leaf.ts',
      'src/required.ts',
      'src/writer.ts'
    ])
  })

  it('keeps every mapped source set closed over the real generator imports', () => {
    const tree = repositoryImportTree(ROOT)
    const artifacts = readGeneratedArtifactSources(ROOT)
    expect(artifacts.map((artifact) => artifact.path).sort()).toEqual(Object.keys(GENERATED_ARTIFACT_WRITERS).sort())
    for (const artifact of artifacts) {
      const sources = new Set(artifact.sources)
      expect(sources.has(artifact.writer)).toBe(true)
      for (const source of sources) {
        if (!/\.[cm]?[jt]sx?$/.test(source)) continue
        const loader = /\.[jt]sx$/.test(source) ? 'tsx' : /\.[cm]?ts$/.test(source) ? 'ts' : 'js'
        for (const entry of new Bun.Transpiler({ loader }).scanImports(tree.read(source).replace(/^#![^\n]*/, ''))) {
          const dependency = tree.resolve(entry.path, source)
          if (dependency !== null) expect(sources.has(dependency)).toBe(true)
        }
      }
    }
    const mcp = artifacts.find((artifact) => artifact.path === '.mcp.json')
    expect(mcp?.writer).toBe('harness/processes/vinaya-strict/integration/adapters.ts')
    expect(mcp?.sources).toContain('harness/processes/vinaya-strict/integration/server.ts')
    expect(mcp?.sources).toContain('harness/kernel/tools/host/seat-host.ts')
  })
})
