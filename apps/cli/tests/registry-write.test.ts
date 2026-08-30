import { describe, expect, it } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { parseRegistry } from '@attalabs/aeg-core'
import {
  appendRegistryRow,
  applyConfigProjectEntry,
  freshProjectsRegistry,
  planConfigProjectEntry,
  planRegistryRow,
  renderConfigProjectEntryDiffLine
} from '../src/lib/registry-write.js'

describe('registry-write', () => {
  it('freshProjectsRegistry produces content parseRegistry can read', () => {
    const content = freshProjectsRegistry('mobile', 'apps/mobile', 'apps/mobile/specs')
    const rows = parseRegistry(content)
    expect(rows).toEqual([{ name: 'mobile', path: 'apps/mobile', specsPath: 'apps/mobile/specs', statePath: null }])
  })

  it('appendRegistryRow inserts after the last existing row, keeping earlier rows intact', () => {
    const before = freshProjectsRegistry('mobile', 'apps/mobile', 'apps/mobile/specs')
    const after = appendRegistryRow(before, 'web', 'apps/web', 'apps/web/specs')
    const rows = parseRegistry(after)
    expect(rows.map((r) => r.name)).toEqual(['mobile', 'web'])
  })

  it('appendRegistryRow falls back to a fresh ## Registry section when the heading is missing', () => {
    const foreign = '# Some other file\n\nNo registry here.\n'
    const after = appendRegistryRow(foreign, 'mobile', 'apps/mobile', 'apps/mobile/specs')
    expect(after).toContain('# Some other file')
    expect(after).toContain('No registry here.')
    const rows = parseRegistry(after)
    expect(rows).toEqual([{ name: 'mobile', path: 'apps/mobile', specsPath: 'apps/mobile/specs', statePath: null }])
  })

  it('planRegistryRow classifies create-host / append-row / skip-present correctly', () => {
    const dir = `${globalThis.process.env.TMPDIR ?? '/tmp'}/registry-write-plan-${Date.now()}`
    require('node:fs').mkdirSync(dir, { recursive: true })
    const p1 = planRegistryRow(dir, 'mobile', 'apps/mobile', 'apps/mobile/specs')
    expect(p1.action).toBe('create-host')

    require('node:fs').mkdirSync(`${dir}/.vinaya`, { recursive: true })
    require('node:fs').writeFileSync(
      `${dir}/.vinaya/projects.md`,
      freshProjectsRegistry('mobile', 'apps/mobile', 'apps/mobile/specs')
    )
    const p2 = planRegistryRow(dir, 'mobile', 'apps/mobile', 'apps/mobile/specs')
    expect(p2.action).toBe('skip-present')

    const p3 = planRegistryRow(dir, 'web', 'apps/web', 'apps/web/specs')
    expect(p3.action).toBe('append-row')

    require('node:fs').rmSync(dir, { recursive: true, force: true })
  })
})

describe('registry-write — config-native projects (task 15, #44)', () => {
  function freshDir(): string {
    const dir = `${globalThis.process.env.TMPDIR ?? '/tmp'}/config-project-entry-${Date.now()}-${Math.random().toString(36).slice(2)}`
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${dir}/vinaya.config.json`, '{}\n')
    return dir
  }

  it('planConfigProjectEntry classifies add-entry / skip-present correctly', () => {
    const dir = freshDir()
    const p1 = planConfigProjectEntry(dir, { name: 'mobile', path: 'apps/mobile' })
    expect(p1.action).toBe('add-entry')

    applyConfigProjectEntry(dir, p1)
    const p2 = planConfigProjectEntry(dir, { name: 'mobile', path: 'apps/mobile' })
    expect(p2.action).toBe('skip-present')

    const p3 = planConfigProjectEntry(dir, { name: 'web', path: 'apps/web' })
    expect(p3.action).toBe('add-entry')

    rmSync(dir, { recursive: true, force: true })
  })

  it('applyConfigProjectEntry appends without disturbing existing config content', () => {
    const dir = freshDir()
    writeFileSync(`${dir}/vinaya.config.json`, `${JSON.stringify({ rings: { ring1_forgeWriteInterception: true } })}\n`)
    const plan = planConfigProjectEntry(dir, { name: 'mobile', path: 'apps/mobile', description: 'The mobile client' })
    applyConfigProjectEntry(dir, plan)

    const written = JSON.parse(require('node:fs').readFileSync(`${dir}/vinaya.config.json`, 'utf-8'))
    expect(written.rings).toEqual({ ring1_forgeWriteInterception: true })
    expect(written.projects).toEqual([{ name: 'mobile', path: 'apps/mobile', description: 'The mobile client' }])

    rmSync(dir, { recursive: true, force: true })
  })

  it('applyConfigProjectEntry is a no-op for skip-present', () => {
    const dir = freshDir()
    const p1 = planConfigProjectEntry(dir, { name: 'mobile', path: 'apps/mobile' })
    applyConfigProjectEntry(dir, p1)
    const before = require('node:fs').readFileSync(`${dir}/vinaya.config.json`, 'utf-8')

    const p2 = planConfigProjectEntry(dir, { name: 'mobile', path: 'apps/mobile' })
    applyConfigProjectEntry(dir, p2)
    const after = require('node:fs').readFileSync(`${dir}/vinaya.config.json`, 'utf-8')
    expect(after).toBe(before)

    rmSync(dir, { recursive: true, force: true })
  })

  it('renderConfigProjectEntryDiffLine renders add-entry and skip-present distinctly', () => {
    const add = renderConfigProjectEntryDiffLine({ action: 'add-entry', entry: { name: 'mobile' } })
    expect(add).toContain('append entry')
    expect(add).toContain('"mobile"')

    const skip = renderConfigProjectEntryDiffLine({ action: 'skip-present', entry: { name: 'mobile' } })
    expect(skip).toContain('keep')
  })
})
