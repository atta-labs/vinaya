import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// The harness is generic machinery: it knows no process. A file under
// `harness/` that imports from `processes/`, by relative path or by the
// `@attalabs/process-` package scope, would tie the harness to one process.

const harnessRoot = join(import.meta.dir, '..')
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/
const SKIPPED_FOLDERS = new Set(['node_modules', 'dist', '.turbo'])

// A module specifier inside `from '…'`, `import '…'`, `import('…')` or `require('…')`.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"`])([^'"`\n]+)\1/g

export function* sourceFiles(folder: string): Generator<string> {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_FOLDERS.has(entry.name)) yield* sourceFiles(join(folder, entry.name))
    } else if (SOURCE_FILE.test(entry.name)) {
      yield join(folder, entry.name)
    }
  }
}

export function importsOfAProcess(source: string): string[] {
  const offending: string[] = []
  for (const match of source.matchAll(SPECIFIER)) {
    const specifier = match[2] ?? ''
    const segments = specifier.split('/')
    if (specifier.startsWith('@attalabs/process-') || segments.includes('processes')) offending.push(specifier)
  }
  return offending
}

describe('harness never imports a process', () => {
  test('no file under harness/ imports from processes/', () => {
    const violations: string[] = []
    for (const file of sourceFiles(harnessRoot)) {
      // This file names the forbidden specifiers as data, so it is not scanned.
      if (file === import.meta.path) continue
      for (const specifier of importsOfAProcess(readFileSync(file, 'utf8'))) {
        violations.push(`${file.slice(harnessRoot.length + 1)} imports ${specifier}`)
      }
    }
    expect(violations).toEqual([])
  })

  test('the scan catches a planted offending import', () => {
    expect(importsOfAProcess("import { x } from '../../processes/vinaya/thing'")).toEqual([
      '../../processes/vinaya/thing'
    ])
    expect(importsOfAProcess("import { x } from '@attalabs/process-vinaya'")).toEqual(['@attalabs/process-vinaya'])
    expect(importsOfAProcess("const m = await import('../processes/other')")).toEqual(['../processes/other'])
    expect(importsOfAProcess("import { x } from './local'\nimport y from 'node:fs'")).toEqual([])
  })
})
