import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeSpecPath } from '@attalabs/aeg-core'
import { resolveDoctrineRoot } from '../commands/doctrine.js'
import { loadConfigChecked } from './config.js'

/** The shipped template, under the doctrine root's `templates/`. */
export const DECISION_RECORD_TEMPLATE = join('templates', 'decision-record-template.md')

/** The folder's index page, created on the first record. */
export const DECISION_RECORD_INDEX = 'README.md'

const INDEX_HEADER = '| Number | Title | Status |'

/** A numbered record's file name: its number, a hyphen, its kebab-case title. */
const RECORD_FILE = /^([0-9]+)-.*\.md$/

/** A numbered record's row in the index page — the number links to the file. */
const INDEX_ROW = /^\|\s*\[([0-9]+)\]\(/

/** `title` as a file-name slug: lower case, every run of other characters one hyphen, no hyphen at either end. */
export function kebabTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * The next record's number: one past the highest number either a file in
 * the folder or a row of the index page carries. The index counts too, so a
 * number whose file was removed is still never handed out again.
 */
export function nextDecisionRecordNumber(fileNames: readonly string[], index: string | null): number {
  let highest = 0
  for (const name of fileNames) {
    const match = RECORD_FILE.exec(name)
    if (match) highest = Math.max(highest, Number(match[1]))
  }
  for (const line of (index ?? '').split('\n')) {
    const match = INDEX_ROW.exec(line.trim())
    if (match) highest = Math.max(highest, Number(match[1]))
  }
  return highest + 1
}

/** The record body: the template's block below its divider, with the number, title and date filled in. */
export function renderDecisionRecord(template: string, number: string, title: string, date: string): string {
  const body = recordBlock(template)
  return `${body.split('{{NUMBER}}').join(number).split('{{TITLE}}').join(title).split('{{DATE}}').join(date).trim()}\n`
}

/** Everything below the first `---` line after the template's frontmatter. */
function recordBlock(template: string): string {
  const lines = template.split('\n')
  let start = 0
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((line, i) => i > 0 && line.trim() === '---')
    start = close + 1
  }
  const divider = lines.findIndex((line, i) => i >= start && line.trim() === '---')
  if (divider === -1) throw new Error('the decision-record template has no `---` divider above its record block')
  return lines.slice(divider + 1).join('\n')
}

/** The index page with a row for the new record — a new page holding only that row when `index` is `null`. */
export function indexWithRecord(index: string | null, number: string, fileName: string, title: string): string {
  const row = `| [${number}](${fileName}) | ${title.replace(/\|/g, '\\|')} | Proposed |`
  if (index === null) {
    return [
      '# Decision records',
      '',
      'One file per decision, numbered in order; a number is never reused. A record that is reversed stays here, marked Superseded.',
      '',
      INDEX_HEADER,
      '| --- | --- | --- |',
      row,
      ''
    ].join('\n')
  }
  const lines = index.replace(/\n+$/, '').split('\n')
  const header = lines.findIndex((line) => line.trim() === INDEX_HEADER)
  if (header === -1) return `${lines.join('\n')}\n\n${INDEX_HEADER}\n| --- | --- | --- |\n${row}\n`
  let last = header
  while (last + 1 < lines.length && lines[last + 1]?.trim().startsWith('|')) last++
  lines.splice(last + 1, 0, row)
  return `${lines.join('\n')}\n`
}

function repositoryRoot(): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } catch {
    return process.cwd()
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export type DecisionRecordResult =
  | { ok: true; recordPath: string; indexPath: string; indexCreated: boolean }
  | { ok: false; exitCode: 1 | 2; message: string }

/**
 * Writes the next numbered decision record for `title` into the folder
 * `decisionRecords.path` names, from the shipped template, with status
 * Proposed, and adds its row to the folder's index page (creating the page
 * on the first record). Refuses while the key is unset: decision records are
 * opt-in, and the folder is the repository's own choice. Paths in the
 * result are relative to the repository root.
 */
export function createDecisionRecord(title: string): DecisionRecordResult {
  const slug = kebabTitle(title)
  if (slug.length === 0) {
    return {
      ok: false,
      exitCode: 2,
      message: `Refusing: "${title}" has no letter or digit to name the record's file after.`
    }
  }

  const loaded = loadConfigChecked()
  if (!loaded.ok) return { ok: false, exitCode: 2, message: `Refusing: ${loaded.path} does not load — ${loaded.error}` }
  const configured = loaded.config?.decisionRecords?.path
  if (configured === undefined) {
    return {
      ok: false,
      exitCode: 2,
      message:
        'Refusing: decisionRecords.path is not set in vinaya.config.json. Decision records are opt-in — set ' +
        'decisionRecords.path to the folder, relative to the repository root, that should hold them, e.g. ' +
        '{ "decisionRecords": { "path": "docs/adr" } }.'
    }
  }

  const doctrineRoot = resolveDoctrineRoot()
  const templatePath = doctrineRoot === null ? null : join(doctrineRoot, DECISION_RECORD_TEMPLATE)
  if (templatePath === null || !existsSync(templatePath)) {
    return {
      ok: false,
      exitCode: 1,
      message: `Error: the decision-record template is missing (${templatePath ?? DECISION_RECORD_TEMPLATE}).`
    }
  }

  const folder = normalizeSpecPath(configured)
  const folderPath = join(repositoryRoot(), folder)
  mkdirSync(folderPath, { recursive: true })
  const indexPath = join(folderPath, DECISION_RECORD_INDEX)
  const index = existsSync(indexPath) ? readFileSync(indexPath, 'utf-8') : null

  const number = String(nextDecisionRecordNumber(readdirSync(folderPath), index)).padStart(4, '0')
  const fileName = `${number}-${slug}.md`
  const recordPath = join(folderPath, fileName)
  if (existsSync(recordPath))
    return { ok: false, exitCode: 1, message: `Error: ${join(folder, fileName)} already exists.` }

  writeFileSync(recordPath, renderDecisionRecord(readFileSync(templatePath, 'utf-8'), number, title, today()), 'utf-8')
  writeFileSync(indexPath, indexWithRecord(index, number, fileName, title), 'utf-8')
  return {
    ok: true,
    recordPath: join(folder, fileName),
    indexPath: join(folder, DECISION_RECORD_INDEX),
    indexCreated: index === null
  }
}
