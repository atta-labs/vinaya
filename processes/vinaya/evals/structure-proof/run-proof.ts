#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

// The frozen halt, inspect, resume and cancel proof, as one command every structural move reruns. It runs each test
// `proof-list.json` names, file by file, and fails when a listed test fails, is skipped, or no longer exists under its
// listed full name. `--packed` then runs the shipped-command lifecycle against a pack of this working tree.
// Usage, from processes/vinaya: bun evals/structure-proof/run-proof.ts [--packed]

const repoRoot = resolve(import.meta.dir, '../../../..')
const LIST = join(import.meta.dir, 'proof-list.json')
const LIFECYCLE = join(repoRoot, 'apps/cli/scripts/verify-published-lifecycle.ts')
const AGENTS = ['claude', 'codex'] as const

export interface ProofEntry {
  /** The test file, relative to the repository root. */
  file: string
  /** The test's describe blocks and its own name, joined by ' > '. */
  name: string
  /** The agent stub the test drives; null for a test that drives none. */
  agent: (typeof AGENTS)[number] | null
  proves: string
}

export type ProofStatus = 'passed' | 'failed' | 'skipped' | 'missing'

/** One test case a JUnit report records: its full name and how it ended. */
export interface ReportedCase {
  name: string
  status: 'passed' | 'failed' | 'skipped'
}

/** Why the list itself is unusable, one line per problem; empty when it is well formed. */
export function listProblems(entries: readonly ProofEntry[]): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const key = `${entry.file}\u0000${entry.name}`
    if (seen.has(key)) problems.push(`listed twice: ${entry.file} — ${entry.name}`)
    seen.add(key)
    if (entry.agent !== null && !entry.name.includes(entry.agent))
      problems.push(`names no ${entry.agent} in its full name: ${entry.file} — ${entry.name}`)
  }
  // An agent-parameterized test is listed once per agent.
  for (const entry of entries) {
    if (entry.agent === null) continue
    for (const other of AGENTS) {
      const twin = entry.name.replaceAll(entry.agent, other)
      if (!entries.some((candidate) => candidate.file === entry.file && candidate.name === twin))
        problems.push(`listed for ${entry.agent} but not for ${other}: ${entry.file} — ${entry.name}`)
    }
  }
  return problems
}

const unescapeXml = (text: string): string =>
  text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')

const attribute = (tag: string, name: string): string | undefined => {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)
  return match ? unescapeXml(match[1] as string) : undefined
}

/**
 * The cases of one file's JUnit report, by full name. The report nests a suite per file and one per describe block;
 * the file's own suite is not part of a test's name.
 */
export function parseJunit(xml: string): ReportedCase[] {
  const cases: ReportedCase[] = []
  const suites: string[] = []
  const tokens = /<testsuite\b[^>]*>|<\/testsuite>|<testcase\b[^>]*?\/>|<testcase\b[^>]*>[\s\S]*?<\/testcase>/g
  for (const [token] of xml.matchAll(tokens)) {
    if (token.startsWith('</testsuite')) suites.pop()
    else if (token.startsWith('<testsuite')) suites.push(attribute(token, 'name') ?? '')
    else {
      const open = /<testcase\b[^>]*>/.exec(token)?.[0] ?? token
      const name = [...suites.slice(1), attribute(open, 'name') ?? ''].join(' > ')
      const status = /<failure\b|<error\b/.test(token) ? 'failed' : /<skipped\b/.test(token) ? 'skipped' : 'passed'
      cases.push({ name, status })
    }
  }
  return cases
}

/** How each listed test ended, given the cases its file's report records. */
export function judge(entries: readonly ProofEntry[], reported: readonly ReportedCase[]): ProofStatus[] {
  return entries.map((entry) => reported.find((reportedCase) => reportedCase.name === entry.name)?.status ?? 'missing')
}

/** The package a test file belongs to: the nearest folder above it with a package.json, whose test setup it runs under. */
function packageRootOf(file: string): string {
  let dir = dirname(join(repoRoot, file))
  while (dir !== repoRoot && !existsSync(join(dir, 'package.json'))) dir = dirname(dir)
  return dir
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/** Runs only the listed tests of one file and reads back how each case ended. */
function runFile(file: string, entries: readonly ProofEntry[], reportDir: string): ReportedCase[] {
  const cwd = packageRootOf(file)
  const report = join(reportDir, `${file.replaceAll('/', '_')}.xml`)
  // Bun's name filter matches a test's describe blocks and name joined by spaces.
  const filter = entries.map((entry) => escapeRegex(entry.name.replaceAll(' > ', ' '))).join('|')
  spawnSync(
    process.execPath,
    [
      'test',
      relative(cwd, join(repoRoot, file)),
      '--timeout=30000',
      '--test-name-pattern',
      filter,
      '--reporter=junit',
      `--reporter-outfile=${report}`
    ],
    { cwd, stdio: ['ignore', 'inherit', 'inherit'] }
  )
  return existsSync(report) ? parseJunit(readFileSync(report, 'utf8')) : []
}

/** Runs every listed test and prints the list with each one's status; true when every one passed. */
export function runProofList(entries: readonly ProofEntry[], write: (line: string) => void): boolean {
  const problems = listProblems(entries)
  if (problems.length > 0) {
    for (const problem of problems) write(`proof list: ${problem}`)
    return false
  }
  const reportDir = mkdtempSync(join(tmpdir(), 'structure-proof-'))
  const statuses: ProofStatus[] = []
  try {
    for (const file of [...new Set(entries.map((entry) => entry.file))]) {
      const ofFile = entries.filter((entry) => entry.file === file)
      const reported = existsSync(join(repoRoot, file)) ? runFile(file, ofFile, reportDir) : []
      const judged = judge(ofFile, reported)
      ofFile.forEach((entry, index) => {
        statuses[entries.indexOf(entry)] = judged[index] as ProofStatus
      })
    }
  } finally {
    rmSync(reportDir, { recursive: true, force: true })
  }
  write('')
  write('structure proof')
  entries.forEach((entry, index) => {
    write(`  ${(statuses[index] as string).padEnd(7)} ${entry.agent ?? 'runtime'}  ${entry.file} — ${entry.name}`)
  })
  const count = (status: ProofStatus) => statuses.filter((s) => s === status).length
  write(
    `${entries.length} listed: ${count('passed')} passed, ${count('failed')} failed, ${count('skipped')} skipped, ${count('missing')} missing`
  )
  return count('passed') === entries.length
}

/** The packed leg: the shipped-command lifecycle against an `npm pack` of this working tree, installed outside it. */
function runPackedLeg(write: (line: string) => void): boolean {
  write('')
  write(`packed leg: bun ${relative(repoRoot, LIFECYCLE)} --local-pack`)
  const result = spawnSync(process.execPath, [LIFECYCLE, '--local-pack'], { cwd: repoRoot, stdio: 'inherit' })
  return result.status === 0
}

if (import.meta.main) {
  const write = (line: string) => console.log(line)
  const entries = (JSON.parse(readFileSync(LIST, 'utf8')) as { tests: ProofEntry[] }).tests
  const listed = runProofList(entries, write)
  const packed = process.argv.includes('--packed') ? runPackedLeg(write) : true
  process.exit(listed && packed ? 0 : 1)
}
