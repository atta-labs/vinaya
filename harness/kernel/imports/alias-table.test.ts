// The kernel's one reading of the alias table: it takes the repository root from its caller, reads the shared base
// config, and is an empty table — never an exception — for a root with no config or a config that does not parse.
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { extractImportSpecifiers, resolveAliasedSpecifier } from '@attalabs/test-selection'
import { BASE_CONFIG_PATH, readAliasTable, resolveAliasedPath } from './alias-table.js'

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function rootWith(config: string | null): string {
  const root = mkdtempSync(join(tmpdir(), 'alias-table-'))
  roots.push(root)
  if (config !== null) {
    mkdirSync(dirname(join(root, BASE_CONFIG_PATH)), { recursive: true })
    writeFileSync(join(root, BASE_CONFIG_PATH), config)
  }
  return root
}

const CONFIG = JSON.stringify({
  compilerOptions: {
    paths: {
      '@attalabs/exact': ['../exact/src/index.ts'],
      '@one/*': ['../../one/*'],
      '@two/*': ['../../two/src/*'],
      '@out/*': ['../../../outside/*']
    }
  }
})

describe('readAliasTable', () => {
  it('reads the table from the root the caller names, resolving targets from the config folder', () => {
    expect(readAliasTable(rootWith(CONFIG))).toEqual([
      { prefix: '@one/', directory: 'one/' },
      { prefix: '@two/', directory: 'two/src/' }
    ])
  })
  it('reads the repository this file sits in: both harness aliases', () => {
    const repo = resolve(import.meta.dir, '..', '..', '..')
    expect(readAliasTable(repo)).toContainEqual({ prefix: '@harness/kernel/', directory: 'harness/kernel/' })
    expect(resolveAliasedPath(repo, '@harness/workflow/checks/x.js')).toBe(
      'harness/processes/vinaya-strict/checks/x.js'
    )
  })
  it('is an empty table, and throws nothing, for a root with no base config', () => {
    expect(readAliasTable(rootWith(null))).toEqual([])
    expect(readAliasTable('/nonexistent/root/for/alias-table')).toEqual([])
  })
  it('is an empty table, and throws nothing, for a config that is empty or does not parse or has no paths', () => {
    expect(readAliasTable(rootWith(''))).toEqual([])
    expect(readAliasTable(rootWith('{ not json'))).toEqual([])
    expect(readAliasTable(rootWith('null'))).toEqual([])
    expect(readAliasTable(rootWith(JSON.stringify({ compilerOptions: {} })))).toEqual([])
    expect(readAliasTable(rootWith(JSON.stringify({ compilerOptions: { paths: [] } })))).toEqual([])
  })
  it('notices a changed config', () => {
    const root = rootWith(JSON.stringify({ compilerOptions: { paths: { '@a/*': ['../../a/*'] } } }))
    expect(readAliasTable(root)).toEqual([{ prefix: '@a/', directory: 'a/' }])
    writeFileSync(
      join(root, BASE_CONFIG_PATH),
      JSON.stringify({ compilerOptions: { paths: { '@bb/*': ['../../bb/*'] } } })
    )
    expect(readAliasTable(root)).toEqual([{ prefix: '@bb/', directory: 'bb/' }])
  })
})

describe('a reader called with the empty table', () => {
  it('returns what it returned before aliases: an aliased specifier names no path', () => {
    const empty = rootWith(null)
    expect(resolveAliasedPath(empty, '@harness/kernel/x.js')).toBeNull()
    expect(resolveAliasedSpecifier('@harness/kernel/x.js', readAliasTable(empty))).toBeNull()
    expect(extractImportSpecifiers("import { a } from '@harness/kernel/x.js'\nimport { b } from './b.js'\n")).toEqual([
      '@harness/kernel/x.js',
      './b.js'
    ])
  })
})
