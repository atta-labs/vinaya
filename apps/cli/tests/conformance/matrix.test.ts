import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `apps/cli/specs/conformance.md`'s own test — every row it claims must
 * cite a real test that really exists, so the matrix can never drift into a
 * register of links with no test behind a row: a spec claim nobody can
 * verify is worse than no claim at all. This never re-derives WHAT each row
 * should say; it only checks the document's own claims against the real
 * repository tree.
 */

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')
const MATRIX_PATH = join(REPO_ROOT, 'apps', 'cli', 'specs', 'conformance.md')
const matrix = readFileSync(MATRIX_PATH, 'utf8')

// --- every applicable concern and primary doc must appear -----------------

const CONCERNS = [
  'Agentic loops',
  'Orchestration patterns',
  'Subagent invocation context',
  'Workflow enforcement & handoff',
  'Agent SDK hooks',
  'Task decomposition',
  'Session state & resumption',
  'Tool schema design',
  'Structured error responses',
  'Tool distribution choice',
  'MCP server / registration',
  'Built-in tools',
  '`CLAUDE.md`/rules hierarchy',
  'Slash commands & skills',
  'Path-specific rules',
  'Plan mode & execution boundary',
  'Iterative refinement',
  'CI/CD integration',
  'System prompts',
  'Few-shot prompting',
  'Structured output',
  'Validation & retry loops',
  'Batch processing',
  'Multi-pass review',
  'Context window management',
  'Escalation & ambiguity',
  'Error propagation',
  'Codebase exploration',
  'Human review calibration',
  'Information provenance'
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
  it('names every applicable concern exactly once, in table A', () => {
    for (const concern of CONCERNS) {
      const cell = new RegExp(`^\\|\\s*${escapeRegex(concern)}\\s*\\|`, 'm')
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
    const rows = tableARows()
    expect(rows.length).toBe(CONCERNS.length)
    const allowed = new Set(['implemented', 'retained', 'conditional', 'not applicable'])
    for (const cells of rows) {
      // cells: ['', concern, disposition, owner, test, '']
      const disposition = cells[2]
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
    for (const cells of tableARows()) {
      const disposition = cells[2]
      const testCell = cells[4] ?? ''
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

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Table A's own data rows — matched by concern name (the table carries no numbering column), returned as trimmed `|`-split cells. */
function tableARows(): string[][] {
  return matrix
    .split('\n')
    .filter((line) => CONCERNS.some((concern) => line.startsWith(`| ${concern} |`)))
    .map((line) => line.split('|').map((cell) => cell.trim()))
}
