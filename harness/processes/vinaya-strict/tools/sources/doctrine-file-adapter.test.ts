import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createFileDoctrineSource } from './doctrine-file-adapter'

const REPO_ROOT = join(import.meta.dir, '../../../../..')

describe('createFileDoctrineSource — configured root', () => {
  let tmpRoot: string
  let root: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'vinaya-sources-doctrine-'))
    root = join(tmpRoot, 'harness/processes/vinaya-strict')
    for (const dir of ['doctrine/contracts', 'thinking/architect', 'retrospecting/archivist']) {
      mkdirSync(join(root, dir), { recursive: true })
    }
    writeFileSync(join(root, 'doctrine/enforcement.md'), '## Ring 0 — Prevention\n', 'utf-8')
    writeFileSync(join(root, 'retrospecting/archivist/doctrine.md'), '---\nrole_id: b\n---\n', 'utf-8')
    writeFileSync(join(root, 'thinking/architect/doctrine.md'), '---\nrole_id: a\n---\n', 'utf-8')
    writeFileSync(join(root, 'doctrine/contracts/architect-planner.md'), '---\ncontract_id: c1\n---\n', 'utf-8')
    // A file the doctrine map does not name must be ignored.
    writeFileSync(join(root, 'thinking/architect/README.md'), 'ignore me', 'utf-8')
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('reads enforcement + roles + contracts from the configured root', async () => {
    const doctrine = await createFileDoctrineSource({ root }).getDoctrine()
    expect(doctrine.enforcement).toContain('Ring 0')
    expect(doctrine.roles).toHaveLength(2)
    expect(doctrine.contracts).toHaveLength(1)
    expect(doctrine.contracts[0]?.content).toContain('contract_id: c1')
  })

  it('lists the role doctrine sorted by logical key, ignoring files the doctrine map does not name', async () => {
    const doctrine = await createFileDoctrineSource({ root }).getDoctrine()
    expect(doctrine.roles.map((r) => r.path)).toEqual([join('roles', 'architect.md'), join('roles', 'archivist.md')])
  })
})

describe('createFileDoctrineSource — real doctrine tree', () => {
  it('reads this repo real doctrine files', async () => {
    const doctrine = await createFileDoctrineSource({
      root: join(REPO_ROOT, 'harness/processes/vinaya-strict')
    }).getDoctrine()
    expect(doctrine.enforcement).toContain('Ring 0')
    // 9 role files, per aeg-core actions.test.ts's own invariant.
    expect(doctrine.roles).toHaveLength(9)
    expect(doctrine.contracts.length).toBeGreaterThan(0)
    expect(doctrine.roles.every((r) => r.path.startsWith('roles/'))).toBe(true)
  })
})
