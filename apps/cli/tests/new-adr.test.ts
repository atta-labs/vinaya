import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DECISION_RECORD_CITATION_ID, resolveProseRules } from '@attalabs/aeg-core'
import {
  indexWithRecord,
  kebabTitle,
  nextDecisionRecordNumber,
  renderDecisionRecord
} from '../src/lib/decision-records'
import { spawnBudgetedAsync, stripVinayaEnv } from './lib/process-fixture'

const CLI_ENTRY = join(import.meta.dir, '..', 'src', 'index.ts')
const TEMPLATE = join(import.meta.dir, '..', '..', '..', 'aeg-root', 'templates', 'decision-record-template.md')

let tmpDir: string | undefined

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = undefined
  }
})

/** A fresh git repository holding only `config` as its `vinaya.config.json`. */
function repo(config: unknown): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'vinaya-new-adr-'))
  execFileSync('git', ['init', '-q'], { cwd: tmpDir })
  writeFileSync(join(tmpDir, 'vinaya.config.json'), JSON.stringify(config))
  return tmpDir
}

async function newAdr(cwd: string, ...title: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await spawnBudgetedAsync(['bun', CLI_ENTRY, 'new', 'adr', ...title], { cwd, env: stripVinayaEnv() })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('vinaya new adr', () => {
  it('refuses with decisionRecords.path unset, naming the key, and writes nothing', async () => {
    const dir = repo({})
    const result = await newAdr(dir, 'Use one rule set')
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('decisionRecords.path is not set')
    for (const folder of ['docs/adr', 'docs', 'adr']) expect(existsSync(join(dir, folder))).toBe(false)
  })

  it('writes 0001 from the template with status Proposed and creates the index', async () => {
    const dir = repo({ decisionRecords: { path: 'docs/decisions' } })
    const result = await newAdr(dir, 'Use one rule set', 'for both checks')
    expect(result.code).toBe(0)
    const record = readFileSync(join(dir, 'docs/decisions/0001-use-one-rule-set-for-both-checks.md'), 'utf-8')
    expect(record.split('\n')[0]).toBe('# 0001. Use one rule set for both checks')
    expect(record).toContain('**Status:** Proposed')
    expect(record).toMatch(/\*\*Date:\*\* \d{4}-\d{2}-\d{2}/)
    for (const section of ['Context', 'Decision', 'Considered options', 'Consequences', 'Where it is applied']) {
      expect(record).toContain(`## ${section}`)
    }
    expect(record).not.toContain('{{')
    expect(record).not.toContain('sidebar_title')
    const index = readFileSync(join(dir, 'docs/decisions/README.md'), 'utf-8')
    expect(index).toContain(
      '| [0001](0001-use-one-rule-set-for-both-checks.md) | Use one rule set for both checks | Proposed |'
    )
  })

  it('numbers past the highest record and never reuses a number whose file was removed', async () => {
    const dir = repo({ decisionRecords: { path: 'adr' } })
    expect((await newAdr(dir, 'First')).code).toBe(0)
    expect((await newAdr(dir, 'Second')).code).toBe(0)
    rmSync(join(dir, 'adr/0002-second.md'))
    expect((await newAdr(dir, 'Third')).code).toBe(0)
    expect(existsSync(join(dir, 'adr/0003-third.md'))).toBe(true)
    const rows = readFileSync(join(dir, 'adr/README.md'), 'utf-8')
      .split('\n')
      .filter((line) => line.startsWith('| ['))
    expect(rows).toEqual([
      '| [0001](0001-first.md) | First | Proposed |',
      '| [0002](0002-second.md) | Second | Proposed |',
      '| [0003](0003-third.md) | Third | Proposed |'
    ])
  })

  it('adds a row to an existing index page it did not create', async () => {
    const dir = repo({ decisionRecords: { path: 'adr' } })
    mkdirSync(join(dir, 'adr'))
    writeFileSync(join(dir, 'adr/README.md'), '# Our decisions\n\nWritten by hand.\n')
    writeFileSync(join(dir, 'adr/0007-older.md'), '# 0007. Older\n')
    expect((await newAdr(dir, 'Newer')).code).toBe(0)
    const index = readFileSync(join(dir, 'adr/README.md'), 'utf-8')
    expect(index.startsWith('# Our decisions\n\nWritten by hand.\n')).toBe(true)
    expect(index).toContain('| [0008](0008-newer.md) | Newer | Proposed |')
  })

  it('refuses a title with nothing to name the file after', async () => {
    const dir = repo({ decisionRecords: { path: 'adr' } })
    expect((await newAdr(dir, '!!!')).code).toBe(2)
    expect((await newAdr(dir)).code).toBe(2)
  })
})

describe('new adr helpers', () => {
  it('kebab-cases a title', () => {
    expect(kebabTitle('  Use Bun 1.4 — not Node! ')).toBe('use-bun-1-4-not-node')
    expect(kebabTitle('Café crème')).toBe('cafe-creme')
  })

  it('takes the next number from the files and the index together', () => {
    expect(nextDecisionRecordNumber([], null)).toBe(1)
    expect(nextDecisionRecordNumber(['0001-a.md', 'README.md', '0004-b.md', 'notes.md'], null)).toBe(5)
    expect(nextDecisionRecordNumber(['0001-a.md'], '| [0009](0009-gone.md) | Gone | Superseded |')).toBe(10)
  })

  it('escapes a pipe in the title of an index row', () => {
    expect(indexWithRecord('| Number | Title | Status |\n| --- | --- | --- |\n', '0001', '0001-a-b.md', 'a | b')).toBe(
      '| Number | Title | Status |\n| --- | --- | --- |\n| [0001](0001-a-b.md) | a \\| b | Proposed |\n'
    )
  })

  it('renders the shipped template below its divider only', () => {
    const record = renderDecisionRecord(readFileSync(TEMPLATE, 'utf-8'), '0012', 'A title', '2026-10-14')
    expect(record.startsWith('# 0012. A title\n')).toBe(true)
    expect(record).toContain('**Date:** 2026-10-14')
  })

  it('the shipped template cites no record by number in its own prose', () => {
    const rule = resolveProseRules(undefined, { decisionRecordsPath: 'docs/adr' }).rules.find(
      (candidate) => candidate.id === DECISION_RECORD_CITATION_ID
    )
    const pattern = rule?.patternFor('ships')
    expect(pattern).toBeDefined()
    expect(readFileSync(TEMPLATE, 'utf-8').match(pattern as RegExp)).toBeNull()
  })
})
