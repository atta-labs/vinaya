import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { git, REPOSITORY_ROOT } from './architecture-ratchet.js'
import {
  checkLongImportBaseline,
  compareLongImportsToBase,
  listLongImports,
  LONG_IMPORT_BASELINE,
  WRITE_COMMAND
} from './long-import-ratchet.js'

test('the committed long import baseline matches the tracked tree', () => {
  expect(checkLongImportBaseline(REPOSITORY_ROOT)).toEqual([])
})

describe('long import ratchet', () => {
  const file = 'src/deep/folder/example.ts'
  const specifier = '../../../target.js'
  const longImport = `import '${specifier}'`
  let root: string

  function write(path: string, source: string): void {
    const absolute = join(root, path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, source)
  }

  function baseline(counts: Record<string, number>): void {
    write(LONG_IMPORT_BASELINE, JSON.stringify(counts))
  }

  function stage(): void {
    git(root, ['add', '-A'])
  }

  function commit(message: string): string {
    stage()
    git(root, [
      '-c',
      'user.name=ratchet',
      '-c',
      'user.email=ratchet@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-qm',
      message
    ])
    return git(root, ['rev-parse', 'HEAD']).trim()
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'long-import-ratchet-'))
    git(root, ['init', '-q'])
    baseline({})
    write(file, 'export {}')
    commit('initial baseline')
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  test.each([
    ['static import', longImport],
    ['re-export', `export * from '${specifier}'`],
    ['dynamic import', `import('${specifier}')`],
    ['require call', `require('${specifier}')`],
    ['mock.module call', `mock.module('${specifier}', () => ({}))`],
    ['import type', `type Target = typeof import('${specifier}')`],
    ['module declaration', `declare module '${specifier}' {}`]
  ])('refuses a new long %s', (_kind, source) => {
    write(file, source)
    const failures = checkLongImportBaseline(root)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain(`${file}: 1 long imports`)
    expect(failures[0]).toContain('@harness/kernel/<path>')
    expect(failures[0]).toContain('@harness/workflow/<path>')
    expect(failures[0]).toContain('named exception')
  })

  test('counts a new tracked fixture file and ignores an untracked file', () => {
    const fixture = 'src/deep/fixtures/example.tsx'
    write(fixture, longImport)
    stage()
    write('src/deep/fixtures/untracked.ts', longImport)
    const failures = checkLongImportBaseline(root)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain(fixture)
  })

  test('ignores comments, import text in strings, template arguments, and shorter paths', () => {
    write(
      file,
      [
        `// ${longImport}`,
        `const example = \`${longImport}\``,
        `import(\`${specifier}\`)`,
        'require(`../../../${name}.js`)',
        "import '../../nearby.js'"
      ].join('\n')
    )
    expect(checkLongImportBaseline(root)).toEqual([])
  })

  test('refuses a stale entry and names the write command', () => {
    baseline({ [file]: 1 })
    expect(checkLongImportBaseline(root)[0]).toContain(WRITE_COMMAND)
  })

  test('passes with a notice when the base has no baseline', () => {
    rmSync(join(root, LONG_IMPORT_BASELINE))
    const base = commit('before the ratchet')
    baseline({})
    commit('introduce the ratchet')
    const result = compareLongImportsToBase(root, base)
    expect(result.failures).toEqual([])
    expect(result.notice).toContain('no baseline yet')
  })

  test.each([false, true])('refuses source growth with the head baseline updated = %s', (updateBaseline) => {
    const base = git(root, ['rev-parse', 'HEAD']).trim()
    write(file, longImport)
    if (updateBaseline) baseline({ [file]: 1 })
    commit('introduce a long import')
    expect(compareLongImportsToBase(root, base).failures).toContainEqual(expect.stringContaining('its base entry (0)'))
  })

  test('refuses a falling count with a stale head entry and accepts the lowered entry', () => {
    write(file, longImport)
    baseline({ [file]: 1 })
    const base = commit('record a long import')
    write(file, 'export {}')
    commit('remove the long import')
    expect(compareLongImportsToBase(root, base).failures[0]).toContain(WRITE_COMMAND)
    baseline({})
    commit('lower the baseline')
    expect(compareLongImportsToBase(root, base).failures).toEqual([])
  })

  test('carries the allowance of a renamed file', () => {
    write(file, longImport)
    baseline({ [file]: 1 })
    const base = commit('record a long import')
    const renamed = 'src/deep/folder/módulo.ts'
    renameSync(join(root, file), join(root, renamed))
    baseline({ [renamed]: 1 })
    commit('rename the file')
    expect(compareLongImportsToBase(root, base).failures).toEqual([])
  })

  test('lists each occurrence in path and source order with its resolved repository path', () => {
    write('target.ts', 'export {}')
    write('other.tsx', 'export {}')
    write(file, `${longImport}\nexport * from '../../../other.js'\n${longImport}`)
    const earlier = 'src/deep/folder/earlier.ts'
    write(earlier, longImport)
    const outside = 'different/deep/folder/example.ts'
    write(outside, longImport)
    stage()

    const folders = ['src/deep/folder', 'src']
    const expected = [
      `${earlier}\t${specifier}\ttarget.ts`,
      `${file}\t${specifier}\ttarget.ts`,
      `${file}\t../../../other.js\tother.tsx`,
      `${file}\t${specifier}\ttarget.ts`
    ]
    expect(listLongImports(root, folders)).toEqual(expected)
    expect(listLongImports(root, folders)).toEqual(expected)
    expect(listLongImports(root)).toEqual([`${outside}\t${specifier}\ttarget.ts`, ...expected])
  })
})
