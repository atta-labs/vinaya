// An aliased import is followed the way a relative one is, in the compiler walk and in the text-scan walk, and the
// table is an input of the call: two tables in one process give two different graphs. Fixtures are built on disk.
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  diskTree,
  loadTypeScript,
  type PathAliasTable,
  resolveAliasedSpecifier,
  selectAffectedFiles
} from '../src/index.js'
import { parseConsumerConfig } from '../src/consumer-config.js'

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'path-aliases-'))
  roots.push(root)
  const all: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['pkgs/*'] }),
    'pkgs/lib/package.json': JSON.stringify({ name: '@t/lib', version: '1.0.0' }),
    'pkgs/other/package.json': JSON.stringify({ name: '@t/other', version: '1.0.0' }),
    'pkgs/app/package.json': JSON.stringify({ name: '@t/app', version: '1.0.0' }),
    ...files
  }
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

const TABLE: PathAliasTable = [{ prefix: '@a/', directory: 'pkgs/lib/src/' }]
const OTHER_TABLE: PathAliasTable = [{ prefix: '@a/', directory: 'pkgs/other/src/' }]

const FILES = {
  'pkgs/lib/src/util.ts': 'export const util = 1\n',
  'pkgs/other/src/util.ts': 'export const util = 2\n',
  'pkgs/app/src/index.ts': "export * from '@a/util.js'\n",
  'pkgs/app/tests/direct.test.ts': "import { util } from '@a/util.js'\nexport const x = util\n",
  'pkgs/app/tests/barrel.test.ts': "import { util } from '../src/index.js'\nexport const x = util\n",
  'pkgs/app/tests/unrelated.test.ts': 'export const x = 1\n'
}

const selectedFor = (root: string, table: PathAliasTable | undefined, resolver: 'compiler' | 'text-scan') =>
  selectAffectedFiles(diskTree(root), ['pkgs/lib/src/util.ts'], {
    resolver,
    typescript: resolver === 'compiler' ? loadTypeScript(root) : null,
    ...(table ? { pathAliases: table } : {})
  })
    .selected.map((path) => path.slice(root.length + 1))
    .sort()

describe('resolveAliasedSpecifier', () => {
  it('maps a specifier with an alias prefix to the folder it names, longest prefix first', () => {
    expect(resolveAliasedSpecifier('@a/x/y.js', TABLE)).toBe('pkgs/lib/src/x/y.js')
    const nested: PathAliasTable = [...TABLE, { prefix: '@a/x/', directory: 'pkgs/other/' }]
    expect(resolveAliasedSpecifier('@a/x/y.js', nested)).toBe('pkgs/other/y.js')
  })
  it('names nothing for another specifier, a bare prefix or no table', () => {
    expect(resolveAliasedSpecifier('@b/x', TABLE)).toBeNull()
    expect(resolveAliasedSpecifier('@a/', TABLE)).toBeNull()
    expect(resolveAliasedSpecifier('@a/x', undefined)).toBeNull()
    expect(resolveAliasedSpecifier('@a/x', [])).toBeNull()
  })
})

describe('an aliased import is followed', () => {
  for (const resolver of ['compiler', 'text-scan'] as const) {
    it(`in the ${resolver} walk, directly and through an aliased re-export`, () => {
      const root = repository(FILES)
      expect(selectedFor(root, TABLE, resolver)).toEqual([
        'pkgs/app/tests/barrel.test.ts',
        'pkgs/app/tests/direct.test.ts'
      ])
    })
    it(`in the ${resolver} walk, two tables in one process give two different graphs`, () => {
      const root = repository(FILES)
      const withLib = selectedFor(root, TABLE, resolver)
      const withOther = selectedFor(root, OTHER_TABLE, resolver)
      expect(withLib.length).toBe(2)
      expect(withOther).toEqual([])
      expect(selectedFor(root, TABLE, resolver)).toEqual(withLib)
    })
    it(`in the ${resolver} walk, with no table an aliased import is no edge, as before`, () => {
      const root = repository(FILES)
      expect(selectedFor(root, undefined, resolver)).toEqual([])
    })
  }
  it('keeps a coarse edge for an alias that names a file the compiler cannot resolve but the disk holds', () => {
    const root = repository({
      ...FILES,
      'pkgs/lib/src/data.js': 'export const d = 1\n',
      'pkgs/app/tests/literal.test.ts': "import { d } from '@a/data.js'\nexport const x = d\n"
    })
    const selected = selectAffectedFiles(diskTree(root), ['pkgs/lib/src/data.js'], {
      resolver: 'compiler',
      typescript: loadTypeScript(root),
      pathAliases: TABLE
    }).selected.map((path) => path.slice(root.length + 1))
    expect(selected).toContain('pkgs/app/tests/literal.test.ts')
  })
})

describe('the consumer config', () => {
  it('reads a path alias table and refuses a prefix that does not end in a slash', () => {
    expect(
      parseConsumerConfig({ pathAliases: [{ prefix: '@a/', directory: 'pkgs/lib/src/' }] }).policy.pathAliases
    ).toEqual(TABLE)
    expect(() => parseConsumerConfig({ pathAliases: [{ prefix: '@a', directory: 'x/' }] })).toThrow(
      'pathAliases[0].prefix'
    )
  })
})
