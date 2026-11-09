/**
 * Where every Bun test run's JUnit report lands, and which test files it
 * proves passed.
 *
 * Each `bunfig.toml` of this repository names one fixed report path under
 * `node_modules/.vinaya-junit/` (`[test.reporter] junit`), one per folder a
 * run starts in. Bun writes that path even when the command line names
 * another outfile, and expands nothing in it, so the test preload makes the
 * fixed path a link before any test runs: to the runner's own report when
 * the scheduler that started it says where it reads it
 * (`VINAYA_JUNIT_REPORT`), otherwise to a new file in the worktree's git
 * directory (`<git dir>/vinaya/junit/`), with a note of the commit, the
 * folder and the verification context the run started under. A selection
 * reads those files back as earlier passes; nothing here decides selection.
 *
 * Nothing here may fail a test run: every step that cannot be done is
 * skipped, and a report that cannot be tied to its commit and folder is
 * never read as a pass.
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { computeVerificationContext } from './pre-push-failed-tests.js'

/** The folder, under the repository root, holding each run folder's fixed report path. */
export const JUNIT_LINK_DIR = 'node_modules/.vinaya-junit'
/** The environment variable a scheduler sets to the report path it will read. */
export const JUNIT_REPORT_ENV = 'VINAYA_JUNIT_REPORT'
/** Set to this process's id once its report link is made, so an isolated file's preload does not make it again. */
const LINKED_ENV = 'VINAYA_JUNIT_LINKED'
/** The store under the worktree's git directory. */
export const JUNIT_STORE = 'vinaya/junit'
/** How many hand-run reports the store keeps; the oldest go first. */
export const JUNIT_STORE_LIMIT = 200

/** The fixed report file name for a run started in `cwd` (repository-relative): `root` for the root. */
export function junitLinkName(cwd: string): string {
  const slug = cwd
    .split('/')
    .filter((part) => part && part !== '.')
    .join('-')
  return `${slug || 'root'}.xml`
}

/** What a stored report was run on, written beside it. */
export type JunitRunNote = {
  version: 1
  /** The commit checked out when the run started. */
  head: string
  /** Repository-relative folder the run started in: report paths are relative to it. */
  cwd: string
  /** Whether no tracked file differed from the commit when the run started. */
  clean: boolean
  /** The verification context digest of the run's environment; `null` when unreadable. */
  verification: string | null
  startedAt: string
}

function cleanGitEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(out)) if (key.startsWith('GIT_')) delete out[key]
  return out
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: cleanGitEnv(),
      timeout: 10_000
    }).trim()
  } catch {
    return null
  }
}

/**
 * The environment a run's verification context is read under: Bun's test runner sets `NODE_ENV=test` in every run it
 * starts, so a value of `test` there says nothing about the caller's environment and is read as unset.
 */
export function runEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key, value]) => !(key === 'NODE_ENV' && value === 'test'))
  ) as NodeJS.ProcessEnv
}

/** The note of a run starting now in `cwd` of the repository at `repoRoot`; `null` when the commit cannot be read. */
export function junitRunNote(repoRoot: string, cwd: string): JunitRunNote | null {
  const head = git(repoRoot, ['rev-parse', 'HEAD'])
  const status = git(repoRoot, ['status', '--porcelain', '-uno'])
  if (!head || status === null) return null
  return {
    version: 1,
    head,
    cwd: relative(repoRoot, resolve(repoRoot, cwd)) || '.',
    clean: status === '',
    verification: computeVerificationContext(repoRoot, runEnvironment())?.digest ?? null,
    startedAt: new Date().toISOString()
  }
}

/** Keeps at most `limit` stored reports, the newest. */
function prune(store: string, limit: number): void {
  const reports = readdirSync(store)
    .filter((name) => name.endsWith('.xml'))
    .map((name) => ({ name, at: statSync(join(store, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
  for (const old of reports.slice(limit)) {
    rmSync(join(store, old.name), { force: true })
    rmSync(join(store, old.name.replace(/\.xml$/, '.json')), { force: true })
  }
}

/** The parent of `pid`, or `null` when it cannot be read. This process's own parent needs no `ps`. */
function parentOf(pid: number): number | null {
  if (pid === process.pid) return process.ppid > 0 ? process.ppid : null
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000
    }).trim()
    const parent = Number(out)
    return Number.isInteger(parent) && parent > 0 ? parent : null
  } catch {
    return null
  }
}

/**
 * Whether the process that last made a link (its `.owner` file: its id, then its repository root) is a live
 * ancestor of this one, running in the same repository (`repoRoot`, when given). A repository that shares another
 * checkout's `node_modules` — a fixture clone a test runs a scheduler in — shares its links too; an ancestor in the
 * other checkout does not hold this repository's run. The outer run then loses its report (Bun says it could not
 * write it and exits as it would have), so it proves no pass: never one it did not make.
 */
export function ownedByAncestor(ownerFile: string, pid: number = process.pid, repoRoot?: string): boolean {
  let owner: number
  let ownerRoot: string | undefined
  try {
    const [id, root] = readFileSync(ownerFile, 'utf8').split('\n')
    owner = Number(id?.trim())
    ownerRoot = root?.trim() || undefined
  } catch {
    return false
  }
  if (!Number.isInteger(owner) || owner <= 1 || owner === pid) return false
  if (repoRoot !== undefined && ownerRoot !== repoRoot) return false
  try {
    process.kill(owner, 0)
  } catch (error) {
    // Gone: an earlier run's mark. A live process this one may not signal is still checked.
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false
  }
  let current: number | null = pid
  for (let step = 0; step < 16 && current !== null && current > 1; step++) {
    current = parentOf(current)
    if (current === owner) return true
  }
  return false
}

/**
 * Called by the test preload: points this run's fixed report path at the scheduler's report, or at a new stored
 * report with its run note. Once per process; never throws.
 */
export function linkJunitReport(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    if (env[LINKED_ENV] === String(process.pid)) return null
    env[LINKED_ENV] = String(process.pid)
    const repoRoot = git(cwd, ['rev-parse', '--show-toplevel'])
    if (!repoRoot) return null
    const linkDir = join(repoRoot, JUNIT_LINK_DIR)
    mkdirSync(linkDir, { recursive: true })
    const link = join(linkDir, junitLinkName(relative(repoRoot, cwd)))
    // A run a test starts in the same folder leaves the link to the run that started it: its report goes where the
    // outer run's goes, and the outer run, which ends last, writes its own report over it.
    const owner = `${link}.owner`
    if (ownedByAncestor(owner, process.pid, repoRoot)) return null
    let target = env[JUNIT_REPORT_ENV]
    // A test this run starts gets its own link, never the scheduler's report.
    delete env[JUNIT_REPORT_ENV]
    if (!target) {
      const gitDir = git(repoRoot, ['rev-parse', '--absolute-git-dir'])
      const note = junitRunNote(repoRoot, cwd)
      if (!gitDir || !note) return null
      const store = join(gitDir, JUNIT_STORE)
      mkdirSync(store, { recursive: true })
      prune(store, JUNIT_STORE_LIMIT)
      const name = `${Date.now()}-${process.pid}-${junitLinkName(note.cwd).replace(/\.xml$/, '')}`
      target = join(store, `${name}.xml`)
      writeFileSync(join(store, `${name}.json`), `${JSON.stringify(note)}\n`)
    }
    const temporary = `${link}.${process.pid}`
    rmSync(temporary, { force: true })
    symlinkSync(target, temporary)
    renameSync(temporary, link)
    writeFileSync(owner, `${process.pid}\n${repoRoot}\n`)
    return target
  } catch {
    return null
  }
}

/** Every stored hand-run report with its run note, oldest first; a report with no readable note is left out. */
export function storedJunitReports(gitDir: string): { report: string; note: JunitRunNote }[] {
  const store = join(gitDir, JUNIT_STORE)
  if (!existsSync(store)) return []
  const out: { report: string; note: JunitRunNote; at: number }[] = []
  for (const name of readdirSync(store)) {
    if (!name.endsWith('.xml')) continue
    const report = join(store, name)
    try {
      if (!lstatSync(report).isFile()) continue
      const note = JSON.parse(readFileSync(report.replace(/\.xml$/, '.json'), 'utf8')) as JunitRunNote
      if (note.version !== 1 || typeof note.head !== 'string' || typeof note.cwd !== 'string') continue
      out.push({ report, note, at: statSync(report).mtimeMs })
    } catch {}
  }
  return out.sort((a, b) => a.at - b.at).map(({ report, note }) => ({ report, note }))
}

function xmlText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * Each test file a Bun JUnit report names, as written (relative to the run's folder), and whether it passed
 * completely: at least one test case, every one ran and passed — none failed, errored or skipped (a skip, a todo
 * and a test a `-t` filter left out are all written as skipped). `null` when the text is not a whole Bun JUnit
 * report. A `.only` leaves its siblings out of the report altogether, so a caller also checks the file's source.
 */
export function junitFileResults(xml: string): { file: string; passed: boolean }[] | null {
  if (!/<testsuites\b/.test(xml) || !/<\/testsuites>\s*$/.test(xml)) return null
  const results = new Map<string, boolean>()
  // Top-level suites only: one per file. Nested `<testsuite>` elements (describe blocks) are inside them.
  let depth = 0
  let current: { file: string; passed: boolean; cases: number } | null = null
  for (const tag of xml.matchAll(/<(\/?)(testsuites|testsuite|testcase|skipped|failure|error)\b([^>]*?)(\/?)>/g)) {
    const [, closing, name, attrs, selfClosing] = tag as unknown as [string, string, string, string, string]
    if (name === 'testsuites') continue
    if (name === 'testsuite') {
      if (closing) {
        depth--
        if (depth === 0 && current) {
          const passed = current.passed && current.cases > 0
          results.set(current.file, (results.get(current.file) ?? true) && passed)
          current = null
        }
        continue
      }
      if (depth === 0) {
        const file = /\bfile="([^"]*)"/.exec(attrs)?.[1]
        if (file === undefined) return null
        const count = (attr: string) => Number(new RegExp(`\\b${attr}="(\\d+)"`).exec(attrs)?.[1] ?? 0)
        current = {
          file: xmlText(file),
          passed: count('failures') === 0 && count('errors') === 0 && count('skipped') === 0,
          cases: 0
        }
        if (selfClosing) {
          results.set(current.file, false)
          current = null
          continue
        }
      }
      if (!selfClosing) depth++
      continue
    }
    if (!current || closing) continue
    if (name === 'testcase') current.cases++
    else current.passed = false
  }
  if (depth !== 0) return null
  return [...results].map(([file, passed]) => ({ file, passed })).sort((a, b) => a.file.localeCompare(b.file))
}

/** Whether a test file's source marks any test or block `.only`, which leaves its siblings out of the run unreported. */
export function marksOnly(source: string): boolean {
  return /\b(?:test|it|describe)\s*\.\s*only\s*[(.]/.test(source) || /\b(?:fit|fdescribe)\s*\(/.test(source)
}
