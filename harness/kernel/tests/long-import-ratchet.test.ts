import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { git, REPOSITORY_ROOT } from './architecture-ratchet.js'
import {
  checkLongImportExceptions,
  compareLongImportsToBase,
  LONG_IMPORT_BASELINE,
  LONG_IMPORT_EXCEPTIONS,
  type LongImportException,
  listLongImports
} from './long-import-ratchet.js'

test('the committed exceptions list matches the tracked tree', () => {
  expect(checkLongImportExceptions(REPOSITORY_ROOT)).toEqual([])
})

describe('long import ratchet', () => {
  const file = 'src/deep/folder/example.ts'
  const specifier = '../../../target.js'
  const longImport = `import '${specifier}'`
  const importAssignment = `import target = require('${specifier}')`
  let root: string

  function write(path: string, source: string): void {
    const absolute = join(root, path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, source)
  }

  function exception(entryFile: string, entrySpecifier = specifier): LongImportException {
    return { file: entryFile, specifier: entrySpecifier, reason: 'The target lies outside both aliases.' }
  }

  function list(...entries: LongImportException[]): void {
    write(LONG_IMPORT_EXCEPTIONS, JSON.stringify(entries))
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
    list()
    write(file, 'export {}')
    commit('initial list')
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  test.each([
    ['static import', longImport],
    ['external import assignment', importAssignment],
    ['re-export', `export * from '${specifier}'`],
    ['dynamic import', `import('${specifier}')`],
    ['require call', `require('${specifier}')`],
    ['parenthesized require call', `((require))('${specifier}')`],
    ['non-null require call', `require!('${specifier}')`],
    ['mock.module call', `mock.module('${specifier}', () => ({}))`],
    ['parenthesized mock.module call', `((mock).module)('${specifier}', () => ({}))`],
    ['non-null mock.module call', `mock.module!('${specifier}', () => ({}))`],
    ['import type', `type Target = typeof import('${specifier}')`],
    ['module declaration', `declare module '${specifier}' {}`]
  ])('refuses an unlisted long %s', (_kind, source) => {
    write(file, source)
    const failures = checkLongImportExceptions(root)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain(`${file} imports ${specifier} 1 times`)
    expect(failures[0]).toContain('@harness/kernel/<path>')
    expect(failures[0]).toContain('@harness/workflow/<path>')
    expect(failures[0]).toContain('named exception')
  })

  test('accepts a listed long import and refuses a second occurrence of it', () => {
    write(file, longImport)
    list(exception(file))
    expect(checkLongImportExceptions(root)).toEqual([])
    write(file, `${longImport}\n${importAssignment}`)
    expect(checkLongImportExceptions(root)).toEqual([expect.stringContaining(`${file} imports ${specifier} 2 times`)])
  })

  test('counts a new tracked fixture file and ignores an untracked file', () => {
    const fixture = 'src/deep/fixtures/example.tsx'
    write(fixture, longImport)
    stage()
    write('src/deep/fixtures/untracked.ts', longImport)
    const failures = checkLongImportExceptions(root)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain(fixture)
  })

  test('skips tracked links and paths replaced by a directory or a linked parent', () => {
    const external = mkdtempSync(join(tmpdir(), 'long-import-external-'))
    try {
      const target = join(external, 'example.ts')
      writeFileSync(target, longImport)
      symlinkSync(target, join(root, 'linked.ts'))
      stage()
      expect(listLongImports(root)).toEqual([])

      rmSync(join(root, file))
      mkdirSync(join(root, file))
      expect(listLongImports(root)).toEqual([])

      const parent = join(root, dirname(file))
      rmSync(parent, { recursive: true })
      symlinkSync(external, parent, 'dir')
      expect(listLongImports(root)).toEqual([])
      expect(checkLongImportExceptions(root)).toEqual([])
    } finally {
      rmSync(external, { recursive: true, force: true })
    }
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
    expect(checkLongImportExceptions(root)).toEqual([])
  })

  test('refuses a stale entry and names the list', () => {
    list(exception(file))
    expect(checkLongImportExceptions(root)).toEqual([expect.stringContaining(LONG_IMPORT_EXCEPTIONS)])
  })

  test('refuses an entry without a reason', () => {
    write(LONG_IMPORT_EXCEPTIONS, JSON.stringify([{ file, specifier, reason: '' }]))
    expect(() => checkLongImportExceptions(root)).toThrow('a file, a specifier and a reason')
  })

  test('refuses an excepted kernel or workflow specifier outside the Studio app, and allows it inside', () => {
    const kernelSpecifier = '../../../../harness/kernel/target.js'
    const folder = 'apps/other/src/deep'
    const outside = `${folder}/example.ts`
    write(outside, `import '${kernelSpecifier}'`)
    stage()
    list(exception(outside, kernelSpecifier))
    expect(checkLongImportExceptions(root)).toEqual([expect.stringContaining('cannot be an exception')])

    const workflow = `${folder}/workflow.ts`
    const workflowSpecifier = `../../../../harness/${'processes'}/vinaya-strict/target.js`
    write(workflow, `import '${workflowSpecifier}'`)
    stage()
    list(exception(outside, kernelSpecifier), exception(workflow, workflowSpecifier))
    expect(checkLongImportExceptions(root)).toHaveLength(2)

    rmSync(join(root, outside))
    rmSync(join(root, workflow))
    const studio = 'apps/vinaya-studio/src/server/example.ts'
    write(studio, `import '${'../../../../harness/kernel/target.js'}'`)
    stage()
    list(exception(studio, '../../../../harness/kernel/target.js'))
    expect(checkLongImportExceptions(root)).toEqual([])
  })

  test('refuses while the baseline file still exists', () => {
    write(LONG_IMPORT_BASELINE, '{}')
    expect(checkLongImportExceptions(root)).toEqual([expect.stringContaining(`${LONG_IMPORT_BASELINE} must not exist`)])
  })

  test('passes with a notice when the base has no list', () => {
    rmSync(join(root, LONG_IMPORT_EXCEPTIONS))
    const base = commit('before the list')
    list()
    commit('introduce the list')
    const result = compareLongImportsToBase(root, base)
    expect(result.failures).toEqual([])
    expect(result.notice).toContain('no exceptions list yet')
  })

  test.each([false, true])('refuses a new long import with the head list updated = %s', (updateList) => {
    const base = git(root, ['rev-parse', 'HEAD']).trim()
    write(file, importAssignment)
    if (updateList) list(exception(file))
    commit('introduce a long import')
    const failures = compareLongImportsToBase(root, base).failures
    expect(failures).toContainEqual(expect.stringContaining('does not allow it'))
    if (updateList) expect(failures).toContainEqual(expect.stringContaining('grew from 0 to 1'))
  })

  test('refuses a head tree with a new unlisted long import while the list is unchanged', () => {
    const base = git(root, ['rev-parse', 'HEAD']).trim()
    write(file, longImport)
    commit('add an import without touching the list')
    expect(compareLongImportsToBase(root, base).failures).not.toEqual([])
  })

  test('refuses a list that grew even when the tree matches it', () => {
    const base = git(root, ['rev-parse', 'HEAD']).trim()
    write(file, longImport)
    list(exception(file))
    commit('add and list an import')
    expect(compareLongImportsToBase(root, base).failures).toContainEqual(expect.stringContaining('grew from 0 to 1'))
  })

  test('refuses a listed entry that no longer exists in the head tree, then accepts the lowered list', () => {
    write(file, longImport)
    list(exception(file))
    const base = commit('record a long import')
    write(file, 'export {}')
    commit('remove the long import')
    expect(compareLongImportsToBase(root, base).failures[0]).toContain(LONG_IMPORT_EXCEPTIONS)
    list()
    commit('lower the list')
    expect(compareLongImportsToBase(root, base).failures).toEqual([])
  })

  test('carries the allowance of a renamed file', () => {
    write(file, longImport)
    list(exception(file))
    const base = commit('record a long import')
    const renamed = 'src/deep/folder/módulo.ts'
    renameSync(join(root, file), join(root, renamed))
    list(exception(renamed))
    commit('rename the file')
    expect(compareLongImportsToBase(root, base).failures).toEqual([])
  })

  test('escapes control characters in diagnostics', () => {
    const oldFile = 'src/deep/folder/old\nname.ts'
    const renamed = 'src/deep/folder/new\rname.ts'
    const body = `export const description = '${'stable file content '.repeat(12)}';`
    write(oldFile, `${longImport}\n${body}\n`)
    list(exception(oldFile))
    const base = commit('record the original file')
    renameSync(join(root, oldFile), join(root, renamed))
    write(renamed, `${longImport}\n${body}\n((require))('${specifier}')\n`)
    commit('rename the file and add an import')

    const { failures } = compareLongImportsToBase(root, base)
    expect(failures.length).toBeGreaterThan(0)
    expect(failures.join('\n')).toContain('new\\rname.ts')
    expect(failures.join('\n')).toContain('old\\nname.ts')
    for (const failure of failures) expect(failure).not.toMatch(/[\r\n]/)
  })

  test('refuses a new file that only shares the basename of a deleted file', () => {
    write(file, `${longImport}\nexport const previous = ['original data', 'more original data']`)
    list(exception(file))
    const base = commit('record the original file')
    const replacement = 'src/replacement/folder/example.ts'
    rmSync(join(root, file))
    write(replacement, "export * from '../../../unrelated.js'\nexport function replacement() { return 42 }")
    list(exception(replacement, '../../../unrelated.js'))
    commit('replace the original file')

    expect(checkLongImportExceptions(root)).toEqual([])
    expect(compareLongImportsToBase(root, base).failures).toContainEqual(
      expect.stringContaining(`${replacement} imports ../../../unrelated.js 1 times`)
    )
  })

  test('lists each occurrence in path and source order with its resolved repository path', () => {
    write('target.ts', 'export {}')
    write('other.tsx', 'export {}')
    write(file, `${longImport}\nexport * from '../../../other.js'\n${importAssignment}`)
    const earlier = 'src/deep/folder/earlier.ts'
    write(earlier, `(require)('${specifier}')`)
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
