import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  checkQuotedCommandStaleness,
  evaluateCitedQuotes,
  findCitedQuotes,
  type QuotedCommandSourceFile
} from './quoted-command'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const READER_FACING_PREFIX = '/no-reader-facing-surface'
const READER_FACING_SUFFIX = '/page.tsx'

describe('findCitedQuotes — marker discovery', () => {
  it('finds one inline-backtick pair and reports the doc line, quoted text, and cited file', () => {
    const content =
      'one job — <!-- AEG:QUOTES-FILE:START:.github/workflows/x.yml -->`vinaya check --all`<!-- AEG:QUOTES-FILE:END --> today'
    const quotes = findCitedQuotes(
      [{ path: 'aeg-root/enforcement.md', content }],
      READER_FACING_PREFIX,
      READER_FACING_SUFFIX
    )
    expect(quotes).toEqual([
      {
        file: 'aeg-root/enforcement.md',
        line: 1,
        quotedText: 'vinaya check --all',
        citedFile: '.github/workflows/x.yml'
      }
    ])
  })

  it('finds a two-line pair, reporting the line the marker pair starts on', () => {
    const content = [
      'preamble',
      '<!-- AEG:QUOTES-FILE:START:aeg-root/glossary.md -->',
      '`some quoted text`',
      '<!-- AEG:QUOTES-FILE:END -->',
      'trailer'
    ].join('\n')
    const quotes = findCitedQuotes([{ path: 'aeg-root/x.md', content }], READER_FACING_PREFIX, READER_FACING_SUFFIX)
    expect(quotes).toHaveLength(1)
    expect(quotes[0]?.quotedText).toBe('some quoted text')
    expect(quotes[0]?.citedFile).toBe('aeg-root/glossary.md')
    expect(quotes[0]?.line).toBe(2)
  })

  it('finds multiple pairs in one file, left to right', () => {
    const content = [
      '<!-- AEG:QUOTES-FILE:START:a.txt -->`one`<!-- AEG:QUOTES-FILE:END -->',
      '<!-- AEG:QUOTES-FILE:START:b.txt -->`two`<!-- AEG:QUOTES-FILE:END -->'
    ].join('\n')
    const quotes = findCitedQuotes([{ path: 'aeg-root/x.md', content }], READER_FACING_PREFIX, READER_FACING_SUFFIX)
    expect(quotes.map((q) => q.quotedText)).toEqual(['one', 'two'])
    expect(quotes.map((q) => q.citedFile)).toEqual(['a.txt', 'b.txt'])
  })

  it('does NOT fire on a decoy marker inside a fenced code block — an authoring example is not a real anchor', () => {
    const content = [
      'Here is the marker syntax:',
      '```',
      '<!-- AEG:QUOTES-FILE:START:some/file.txt -->',
      '`example`',
      '<!-- AEG:QUOTES-FILE:END -->',
      '```'
    ].join('\n')
    const quotes = findCitedQuotes([{ path: 'aeg-root/x.md', content }], READER_FACING_PREFIX, READER_FACING_SUFFIX)
    expect(quotes).toEqual([])
  })

  it('does NOT fire on an unterminated START with no following END', () => {
    const content = '<!-- AEG:QUOTES-FILE:START:a.txt -->`dangling, no end marker`'
    const quotes = findCitedQuotes([{ path: 'aeg-root/x.md', content }], READER_FACING_PREFIX, READER_FACING_SUFFIX)
    expect(quotes).toEqual([])
  })

  it('never sweeps apps/*/specs/** or CLAUDE.md — this reader already has this forge', () => {
    const content = '<!-- AEG:QUOTES-FILE:START:aeg-root/enforcement.md -->`x`<!-- AEG:QUOTES-FILE:END -->'
    const quotes = findCitedQuotes(
      [
        { path: 'apps/cli/specs/self-hosting.md', content },
        { path: 'CLAUDE.md', content }
      ],
      READER_FACING_PREFIX,
      READER_FACING_SUFFIX
    )
    expect(quotes).toEqual([])
  })

  it('strips a fenced (triple-backtick) wrapper the same way as an inline span', () => {
    const content = [
      '<!-- AEG:QUOTES-FILE:START:a.txt -->',
      '```',
      'line one',
      '```',
      '<!-- AEG:QUOTES-FILE:END -->'
    ].join('\n')
    const quotes = findCitedQuotes([{ path: 'aeg-root/x.md', content }], READER_FACING_PREFIX, READER_FACING_SUFFIX)
    expect(quotes[0]?.quotedText).toBe('line one')
  })
})

describe('evaluateCitedQuotes — the predicate', () => {
  it('passes when the cited file still contains the quoted text verbatim', () => {
    const findings = evaluateCitedQuotes(
      [{ file: 'doc.md', line: 3, quotedText: 'npx foo', citedFile: 'real.yml' }],
      new Map([['real.yml', 'steps: run npx foo here']])
    )
    expect(findings).toEqual([])
  })

  it('fires, naming both sides, when the cited file no longer contains the quoted text', () => {
    const findings = evaluateCitedQuotes(
      [{ file: 'doc.md', line: 3, quotedText: 'npx foo check', citedFile: 'real.yml' }],
      // A version pin inserted mid-string is the real incident's own shape:
      // the quoted text is no longer a substring, even though "npx foo" and
      // "check" both still appear in the file.
      new Map([['real.yml', 'steps: run npx foo@1.0.0 check here']])
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]?.quotedText).toBe('npx foo check')
    expect(findings[0]?.citedFile).toBe('real.yml')
    expect(findings[0]?.message).toContain('npx foo check')
    expect(findings[0]?.message).toContain('real.yml')
  })

  it('fires when the cited file could not be read at all', () => {
    const findings = evaluateCitedQuotes(
      [{ file: 'doc.md', line: 3, quotedText: 'npx foo', citedFile: 'missing.yml' }],
      new Map()
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('could not be read')
  })

  it("red before green — a seeded staleness fires, then the fix (restoring the quoted text) passes — the real incident's own shape: a version pin inserted mid-command", () => {
    const quote = [
      { file: 'doc.md', line: 1, quotedText: 'npx --yes @attalabs/vinaya check --all --diff-only', citedFile: 'wf.yml' }
    ]
    const stale = evaluateCitedQuotes(
      quote,
      new Map([['wf.yml', 'run: npx --yes @attalabs/vinaya@0.12.0 check --all --diff-only']])
    )
    expect(stale).toHaveLength(1)
    const fixed = evaluateCitedQuotes(
      quote,
      new Map([['wf.yml', 'run: npx --yes @attalabs/vinaya check --all --diff-only']])
    )
    expect(fixed).toEqual([])
  })
})

describe('checkQuotedCommandStaleness — end to end over a small fixture', () => {
  it('composes discovery and evaluation in one call', () => {
    const files: QuotedCommandSourceFile[] = [
      {
        path: 'aeg-root/enforcement.md',
        content: '<!-- AEG:QUOTES-FILE:START:wf.yml -->`vinaya@X check --all`<!-- AEG:QUOTES-FILE:END -->'
      }
    ]
    const passing = checkQuotedCommandStaleness(
      files,
      new Map([['wf.yml', 'name: vinaya@X check --all']]),
      READER_FACING_PREFIX,
      READER_FACING_SUFFIX
    )
    expect(passing).toEqual([])

    const failing = checkQuotedCommandStaleness(
      files,
      new Map([['wf.yml', 'name: vinaya@Y check --all']]),
      READER_FACING_PREFIX,
      READER_FACING_SUFFIX
    )
    expect(failing).toHaveLength(1)
  })
})

/** Recursively collects repo-relative `.md` paths under `dir`, POSIX-separated. */
function collectMarkdown(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(join(REPO_ROOT, dir))
  } catch {
    return out
  }
  for (const name of entries) {
    const rel = `${dir}/${name}`
    const abs = join(REPO_ROOT, rel)
    if (statSync(abs).isDirectory()) {
      collectMarkdown(rel, out)
    } else if (name.endsWith('.md')) {
      out.push(rel)
    }
  }
  return out
}

describe('corpus test — the real aeg-root/** tree', () => {
  it('produces zero findings against this repo as it stands today', () => {
    const docPaths = collectMarkdown('aeg-root')
    const files: QuotedCommandSourceFile[] = docPaths.map((p) => ({
      path: p,
      content: readFileSync(join(REPO_ROOT, p), 'utf8')
    }))

    const citedQuotes = findCitedQuotes(files, READER_FACING_PREFIX, READER_FACING_SUFFIX)

    const citedFileContents = new Map<string, string>()
    for (const quote of citedQuotes) {
      const abs = join(REPO_ROOT, quote.citedFile)
      if (existsSync(abs) && statSync(abs).isFile()) {
        citedFileContents.set(quote.citedFile, readFileSync(abs, 'utf8'))
      }
    }

    const findings = evaluateCitedQuotes(citedQuotes, citedFileContents)
    expect(findings).toEqual([])
  })

  it('carries at least one real, live annotation today — this check ships with a true-positive-capable case, not only synthetic fixtures', () => {
    const docPaths = collectMarkdown('aeg-root')
    const files: QuotedCommandSourceFile[] = docPaths.map((p) => ({
      path: p,
      content: readFileSync(join(REPO_ROOT, p), 'utf8')
    }))
    const citedQuotes = findCitedQuotes(files, READER_FACING_PREFIX, READER_FACING_SUFFIX)
    expect(citedQuotes.length).toBeGreaterThan(0)
  })
})
