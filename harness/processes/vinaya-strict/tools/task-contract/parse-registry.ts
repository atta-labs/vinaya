import type { Project, Registry } from './types'

/**
 * Parse a project registry (`.vinaya/projects.md`) and return its `## Registry` table as a typed
 * `Registry`. Surrounding prose is ignored.
 *
 * Tolerates a prose last-cell (e.g. "(state tracked globally for now)") by
 * setting `statePath: null`. A real path is detected by the backtick wrapping
 * (`<path>`) used in the live file's columns 2 + 3 + (when present) 4.
 *
 * The function is forgiving: a malformed row is skipped rather than throwing,
 * so a typo in the markdown does not crash all of Studio. Validation of
 * `Project:` references against the result is a separate concern.
 */
export function parseRegistry(md: string): Registry {
  const rows = readMarkdownTable(md, /^##\s+Registry\b/i)
  const projects: Project[] = []
  for (const row of rows) {
    // Expect 4 columns: Project | Path | Specs | Per-project state.
    if (row.length < 4) continue
    const name = stripBackticks(row[0] ?? '').trim()
    const path = stripBackticks(row[1] ?? '').trim()
    const specsPath = stripBackticks(row[2] ?? '').trim()
    const stateCell = (row[3] ?? '').trim()
    if (!name || !path || !specsPath) continue
    projects.push({
      name,
      path,
      specsPath,
      statePath: parseStateCell(stateCell)
    })
  }
  return projects
}

function parseStateCell(cell: string): string | null {
  if (!cell) return null
  // Prose state cell — anything that doesn't look like a backtick-wrapped path.
  // The live file uses `apps/<x>/aeg-project/` for tracked state and
  // parenthesized prose like "(state tracked globally for now)" otherwise.
  const stripped = stripBackticks(cell).trim()
  // If we stripped backticks and got a path-shaped string, return it.
  if (/^[\w./@-]+\/?$/.test(stripped) && cell.includes('`')) {
    return stripped
  }
  return null
}

function stripBackticks(s: string): string {
  return s.replace(/`/g, '')
}

/**
 * Generic markdown-table reader: finds the first `| … |` table block following
 * the `headingMatcher` regex, skips the header + separator rows, and returns
 * each body row as an array of trimmed cell strings.
 *
 * Pipes can be escaped inline as `\|`; this is unescaped after the split.
 * Leading/trailing pipes are tolerated. Lines outside the table block end
 * iteration.
 */
export function readMarkdownTable(md: string, headingMatcher: RegExp): string[][] {
  const lines = md.split(/\r?\n/)
  let i = 0
  // Advance to the section heading.
  for (; i < lines.length; i++) {
    if (headingMatcher.test(lines[i] ?? '')) {
      i++
      break
    }
  }
  if (i >= lines.length) return []
  // Advance to the first table line.
  for (; i < lines.length; i++) {
    if ((lines[i] ?? '').trim().startsWith('|')) break
  }
  // Skip header + separator.
  if (i + 1 >= lines.length) return []
  i += 2
  const out: string[][] = []
  for (; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trim()
    if (!trimmed.startsWith('|')) break
    out.push(splitTableRow(trimmed))
  }
  return out
}

/** Exported for reuse by parsers that read a table body outside `readMarkdownTable`'s single-section-per-call model (e.g. `parse-token-report.ts`'s multi-entry "Token report" sections). */
export function splitTableRow(row: string): string[] {
  // Use a placeholder for escaped pipes, split, then restore.
  // The sentinel is a NUL, escaped rather than typed literally. A raw NUL byte
  // in the source makes git classify this whole FILE as binary: `git diff`
  // reports `Bin 3715 -> 3716 bytes, 0 insertions(+), 0 deletions(-)` instead
  // of a reviewable diff, and `git grep -n` answers `Binary file ... matches`
  // with no line number, so every sweep that greps this repo silently skipped
  // it. `\u0000` is the same byte at runtime and keeps the file text.
  const PLACEHOLDER = '\u0000PIPE\u0000'
  const escaped = row.replace(/\\\|/g, PLACEHOLDER)
  const parts = escaped.split('|').map((s) => s.trim())
  // Strip the empty cells produced by leading and trailing `|`.
  if (parts.length && parts[0] === '') parts.shift()
  if (parts.length && parts[parts.length - 1] === '') parts.pop()
  return parts.map((p) => p.split(PLACEHOLDER).join('|'))
}
