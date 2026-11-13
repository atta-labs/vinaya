import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMMENT_MARKER_PREFIX } from '../legacy-markers'
import { parseRegistry } from './parse-registry'

// The recorded projects.md fixture still carries the retired project names.
const OLD = COMMENT_MARKER_PREFIX.old
const OLD_CORE = `${OLD}-core`

const FIXTURES = join(__dirname, './fixtures')
const projectsMd = readFileSync(join(FIXTURES, 'projects.md'), 'utf8')

describe('parseRegistry', () => {
  it('parses every row in the live projects.md, including the retired core row', () => {
    const registry = parseRegistry(projectsMd)
    expect(registry.map((p) => p.name)).toEqual(['vada', 'cetana', 'herald', OLD, OLD_CORE, 'atta', 'desktop'])
  })

  it('reads the retired core row', () => {
    const registry = parseRegistry(projectsMd)
    const coreRow = registry.find((p) => p.name === OLD_CORE)
    expect(coreRow).toMatchObject({
      name: OLD_CORE,
      path: `packages/${OLD_CORE}`,
      specsPath: `packages/${OLD_CORE}/specs/`,
      statePath: null
    })
  })

  it('captures specs paths from backtick-wrapped cells', () => {
    const registry = parseRegistry(projectsMd)
    const vada = registry.find((p) => p.name === 'vada')
    expect(vada).toMatchObject({
      name: 'vada',
      path: 'apps/vada-ai',
      specsPath: 'apps/vada-ai/specs/',
      statePath: `apps/vada-ai/${OLD}-project/`
    })
  })

  it('returns statePath:null when the last cell is prose, not a path', () => {
    const registry = parseRegistry(projectsMd)
    const atta = registry.find((p) => p.name === 'atta')
    const desktop = registry.find((p) => p.name === 'desktop')
    expect(atta?.statePath).toBeNull()
    expect(desktop?.statePath).toBeNull()
    // The tracked rows still have paths — the null case is targeted.
    expect(registry.find((p) => p.name === OLD)?.statePath).toBe(`apps/${OLD}/${OLD}-project/`)
  })

  it('returns [] when the Registry section is missing', () => {
    expect(parseRegistry('# Some other doc\nNo registry here.')).toEqual([])
  })

  it('skips a malformed row without throwing', () => {
    const md = [
      '## Registry',
      '',
      '| Project | Path | Specs | State |',
      '|---------|------|-------|-------|',
      '| good    | `apps/x` | `apps/x/specs/` | `apps/x/state-notes/` |',
      '| broken  | `apps/y` |', // 3 cells, not 4 — skipped
      ''
    ].join('\n')
    const registry = parseRegistry(md)
    expect(registry.map((p) => p.name)).toEqual(['good'])
  })
})
