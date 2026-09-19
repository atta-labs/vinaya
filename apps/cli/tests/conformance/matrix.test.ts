import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Part 1 (O1): `apps/cli/specs/conformance.md`'s own test — every row it
 * claims must cite a real test that really exists, so the matrix can never
 * drift into a register of links with no test behind a row (Issue #571's
 * own named trap). This never re-derives WHAT each row should say; it only
 * checks the document's own claims against the real repository tree.
 */

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')
const MATRIX_PATH = join(REPO_ROOT, 'apps', 'cli', 'specs', 'conformance.md')
const matrix = readFileSync(MATRIX_PATH, 'utf8')

// --- every applicable study-index item and primary doc must appear --------

const STUDY_INDEX_IDS = [
  '1.1',
  '1.2',
  '1.3',
  '1.4',
  '1.5',
  '1.6',
  '1.7',
  '2.1',
  '2.2',
  '2.3',
  '2.4',
  '2.5',
  '3.1',
  '3.2',
  '3.3',
  '3.4',
  '3.5',
  '3.6',
  '4.1',
  '4.2',
  '4.3',
  '4.4',
  '4.5',
  '4.6',
  '5.1',
  '5.2',
  '5.3',
  '5.4',
  '5.5',
  '5.6'
] as const

const PRIMARY_DOCS = ['headless', 'patterns', 'outputs', 'mcp', 'secure'] as const

const NINE_SCENARIOS = [
  'Clean result',
  'Invalid result',
  'Mechanical rejection',
  'Bounded retries',
  'Fresh reviews',
  'Input change',
  'Human handoff',
  'Cancellation',
  'Recovery'
] as const

describe('conformance matrix — every row exists and cites a real, tested file', () => {
  it('names every applicable study-index item exactly once, in table A', () => {
    for (const id of STUDY_INDEX_IDS) {
      const cell = new RegExp(`^\\|\\s*${id.replace('.', '\\.')}\\s*\\|`, 'm')
      expect(matrix).toMatch(cell)
    }
  })

  it('names every primary documentation requirement, in table B', () => {
    for (const doc of PRIMARY_DOCS) {
      const cell = new RegExp(`^\\|\\s*${doc}\\s*\\|`, 'm')
      expect(matrix).toMatch(cell)
    }
  })

  it('names every one of the nine O2 fixture scenarios, in table C', () => {
    for (const scenario of NINE_SCENARIOS) {
      const cell = new RegExp(`^\\|\\s*${scenario}\\s*\\|`, 'm')
      expect(matrix).toMatch(cell)
    }
  })

  it('gives every row a disposition from the fixed four-value vocabulary', () => {
    const rows = matrix
      .split('\n')
      .filter((line) => /^\|\s*\d\.\d\s*\|/.test(line))
      .map((line) => line.split('|').map((cell) => cell.trim()))
    expect(rows.length).toBe(STUDY_INDEX_IDS.length)
    const allowed = new Set(['implemented', 'retained', 'conditional', 'not applicable'])
    for (const cells of rows) {
      // cells: ['', id, concern, disposition, primary reference, owner, test, '']
      const disposition = cells[3]
      expect(allowed.has(disposition ?? '')).toBe(true)
    }
  })

  it('every backtick-quoted test file the matrix cites really exists', () => {
    const cited = extractCitedTestFiles(matrix)
    expect(cited.length).toBeGreaterThan(0)
    for (const relPath of cited) {
      const abs = join(REPO_ROOT, relPath)
      expect(existsSync(abs)).toBe(true)
    }
  })

  it('every cited test file actually carries at least one real test', () => {
    const cited = extractCitedTestFiles(matrix)
    for (const relPath of cited) {
      const abs = join(REPO_ROOT, relPath)
      const content = readFileSync(abs, 'utf8')
      const hasTest = /\b(it|test)\s*\(/.test(content)
      expect(hasTest).toBe(true)
    }
  })

  it('every disposition other than "not applicable" cites at least one test in its own row', () => {
    const lines = matrix.split('\n').filter((line) => /^\|\s*\d\.\d\s*\|/.test(line))
    for (const line of lines) {
      const cells = line.split('|').map((cell) => cell.trim())
      const disposition = cells[3]
      const testCell = cells[6] ?? ''
      if (disposition === 'not applicable') {
        expect(testCell).toBe('—')
      } else {
        expect(extractCitedTestFiles(testCell).length).toBeGreaterThan(0)
      }
    }
  })

  it('the O2 scenario table (C) cites both claude.test.ts and codex.test.ts for every scenario', () => {
    const lines = matrix.split('\n').filter((line) => NINE_SCENARIOS.some((s) => line.startsWith(`| ${s} |`)))
    expect(lines.length).toBe(NINE_SCENARIOS.length)
    for (const line of lines) {
      expect(line).toContain('apps/cli/tests/conformance/claude.test.ts')
      expect(line).toContain('apps/cli/tests/conformance/codex.test.ts')
    }
  })
})

function extractCitedTestFiles(text: string): string[] {
  const matches = text.match(/`[\w./-]+\.test\.ts`/g) ?? []
  const paths = matches.map((m) => m.slice(1, -1))
  return [...new Set(paths)]
}
