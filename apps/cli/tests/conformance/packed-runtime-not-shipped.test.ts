import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const CLI = join(import.meta.dir, '../..')

function filesUnder(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

describe('packed Atta fixtures remain development-only', () => {
  it('keeps tarballs and @atta imports outside the published CLI surface', () => {
    const manifest = JSON.parse(readFileSync(join(CLI, 'package.json'), 'utf8')) as {
      files: string[]
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    const sourceImports = filesUnder(join(CLI, 'src'))
      .filter((path) => /\.(?:ts|tsx|js|mjs|cjs)$/.test(path))
      .filter((path) => /(?:from\s*|import\s*\()\s*['"]@atta\//.test(readFileSync(path, 'utf8')))
      .map((path) => relative(CLI, path))

    expect(manifest.files).not.toContain('tests')
    expect(Object.keys(manifest.dependencies).filter((name) => name.startsWith('@atta/'))).toEqual([])
    expect(
      Object.entries(manifest.devDependencies)
        .filter(
          ([name, specifier]) => name.startsWith('@atta/') && specifier.startsWith('file:tests/fixtures/atta-engine/')
        )
        .map(([name]) => name)
        .sort()
    ).toEqual(['@atta/adapter-langgraph', '@atta/agents', '@atta/engine', '@atta/models'])
    expect(sourceImports).toEqual([])
  })
})
