import { describe, expect, it } from 'vitest'
import { findWorkspaceEscapes } from './workspace-escape'

const WORKSPACE_DIRS = ['apps', 'packages']

describe('workspace-escape detection', () => {
  it('flags the 2026-08-16 incident shape: a sibling workspace consumed via a constructed relative path', () => {
    const files = [
      {
        path: 'packages/b/src/commands-router-coverage.test.ts',
        content: "const INDEX_PATH = fileURLToPath(new URL('../../../apps/cli/src/index.ts', import.meta.url))"
      }
    ]
    const knownPaths = new Set(['packages/b/src/commands-router-coverage.test.ts', 'apps/cli/src/index.ts'])
    const findings = findWorkspaceEscapes(files, knownPaths, WORKSPACE_DIRS)
    expect(findings).toEqual([
      {
        file: 'packages/b/src/commands-router-coverage.test.ts',
        line: 1,
        reference: '../../../apps/cli/src/index.ts',
        resolved: 'apps/cli/src/index.ts',
        reason: 'escapes-workspace-package'
      }
    ])
  })

  it('a clean tree — every reference stays inside its own package — produces silence', () => {
    const files = [
      {
        path: 'apps/cli/tests/commands.test.ts',
        content: "const INDEX_TS = fileURLToPath(new URL('../src/index.ts', import.meta.url))"
      },
      {
        path: 'packages/aeg-core/src/gate-audience.test.ts',
        content: "const BIN_DIR = fileURLToPath(new URL('../bin', import.meta.url))"
      }
    ]
    const knownPaths = new Set([
      'apps/cli/tests/commands.test.ts',
      'apps/cli/src/index.ts',
      'packages/aeg-core/src/gate-audience.test.ts',
      'packages/aeg-core/bin'
    ])
    expect(findWorkspaceEscapes(files, knownPaths, WORKSPACE_DIRS)).toEqual([])
  })

  it('flags a reference that stays inside its own package but resolves to a path that does not exist', () => {
    const files = [
      {
        path: 'apps/cli/src/foo.ts',
        content: "readFileSync('./missing.json', 'utf8')"
      }
    ]
    const knownPaths = new Set(['apps/cli/src/foo.ts'])
    expect(findWorkspaceEscapes(files, knownPaths, WORKSPACE_DIRS)).toEqual([
      {
        file: 'apps/cli/src/foo.ts',
        line: 1,
        reference: './missing.json',
        resolved: 'apps/cli/src/missing.json',
        reason: 'path-not-found'
      }
    ])
  })

  it('does not flag ordinary import/require specifiers', () => {
    const files = [
      {
        path: 'apps/cli/src/foo.ts',
        content:
          "import { bar } from '../../../packages/other/src/bar'\nconst x = require('../../../packages/other/src/baz')"
      }
    ]
    expect(findWorkspaceEscapes(files, new Set(['apps/cli/src/foo.ts']), WORKSPACE_DIRS)).toEqual([])
  })

  it('skips a literal carrying template interpolation — a dynamically computed path, out of scope by design', () => {
    const files = [
      {
        path: 'apps/cli/src/foo.ts',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the detector skips a fixture template literal, not writing a template string
        content: 'readFileSync(`../../../packages/other/${name}.ts`, "utf8")'
      }
    ]
    expect(findWorkspaceEscapes(files, new Set(['apps/cli/src/foo.ts']), WORKSPACE_DIRS)).toEqual([])
  })

  it('skips a non-literal (variable) argument entirely — resolving those needs data-flow analysis, out of scope', () => {
    const files = [
      {
        path: 'apps/cli/src/foo.ts',
        content: 'readFileSync(somePath, "utf8")'
      }
    ]
    expect(findWorkspaceEscapes(files, new Set(['apps/cli/src/foo.ts']), WORKSPACE_DIRS)).toEqual([])
  })

  it('skips a file that sits outside every workspace dir — there is no "own package" for it to escape', () => {
    const files = [
      {
        path: 'aeg-root/scripts/foo.ts',
        content: "readFileSync(new URL('../../apps/cli/src/index.ts', import.meta.url))"
      }
    ]
    expect(findWorkspaceEscapes(files, new Set(['apps/cli/src/index.ts']), WORKSPACE_DIRS)).toEqual([])
  })

  it('does not flag a call shape merely described in a comment', () => {
    const files = [
      {
        path: 'apps/cli/src/foo.ts',
        content:
          "// example: readFileSync('../../../packages/other/src/bar.ts')\n" +
          "/* new URL('../../../packages/other/src/bar.ts', import.meta.url) */\n" +
          'export const x = 1'
      }
    ]
    expect(findWorkspaceEscapes(files, new Set(['apps/cli/src/foo.ts']), WORKSPACE_DIRS)).toEqual([])
  })

  it('detects readFile (not just readFileSync) with a literal relative argument', () => {
    const files = [
      {
        path: 'apps/cli/src/foo.ts',
        content: "readFile('../../../packages/other/src/bar.ts', 'utf8', cb)"
      }
    ]
    const knownPaths = new Set(['apps/cli/src/foo.ts', 'packages/other/src/bar.ts'])
    const findings = findWorkspaceEscapes(files, knownPaths, WORKSPACE_DIRS)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.reason).toBe('escapes-workspace-package')
  })
})
