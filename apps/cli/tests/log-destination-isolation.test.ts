/**
 * A test that runs Vinaya code and then reads the DEFAULT log destination —
 * `<runtimeDir>/logs/<repo>/<task>.ndjson` under its own temporary `$HOME` —
 * is asserting against a folder the repository's own `vinaya.config.json`
 * can empty out from under it. `config.ts`'s `findLocalConfig()` walks up
 * from the WORKING DIRECTORY the code runs in, so code running in this
 * repository reads this repository's `logs` setting: declare a `logs.url`
 * there and the destination resolves to that server, whose local outbox is
 * only a retry queue the drain clears asynchronously — so the file the
 * fixture reads is missing, or present-then-missing, for a reason that has
 * nothing to do with what it tests. That is not hypothetical — it is how two
 * `checks/runner/cancelled.test.ts` cases passed pre-push and failed CI the
 * day a `logs.url` first landed on the default branch, and how both
 * `lib/task-tools/cancel.test.ts` subprocess fixtures then failed CI's shard
 * 3 on every open pull request while passing on a laptop, where the drain
 * lost the race.
 *
 * The fix in each such fixture is one line: run the code with a working
 * directory of its own (a scratch directory, or `isolatedConfigFixture`'s,
 * whose own empty `vinaya.config.json` is where the walk stops). This file
 * is the mechanical backstop for it, in the shape
 * `process-fixture-coverage.test.ts` already established for the
 * environment/kill-budget halves: walk the real tree, find every file that
 * reads a default log destination, and require each of them to run Vinaya
 * code only in a working directory that is not this repository's — or to be
 * listed, by path, on `GRANDFATHERED_FILES`.
 *
 * Three shapes are non-compliant, all three of them "runs in this
 * repository's working directory":
 *   - a real-process call that names no working directory at all (the
 *     child inherits this process's, i.e. this repository's);
 *   - a real-process call whose named working directory RESOLVES to this
 *     repository — `cwd: repoRoot`, or the same identifier handed to a
 *     `run…`/`spawn…`/`exec…` wrapper that spawns on its behalf. Naming a
 *     working directory was the whole of the original rule, and it was not
 *     enough: `cancel.test.ts` named one, and what it named was this
 *     checkout;
 *   - an IN-PROCESS call into Vinaya code with no real process anywhere in
 *     the file. The test runner runs in the repository root, so such a call
 *     has this repository's working directory by construction and cannot be
 *     handed another one.
 *
 * A working directory is only half of the resolution, and this file scans that
 * half. The other half is the trust anchor: an unattended caller whose local
 * configuration declares no `logs` setting at all still honours the DEFAULT
 * BRANCH's own declared destination, read over the forge with an identity that
 * comes from the Actions runner rather than from any directory. No working
 * directory closes that one — a configuration that DECLARES a destination
 * does, which is why `isolatedConfigFixture` writes one and why the test below
 * refuses to let that regress to an empty object.
 *
 * The list is data, not a waiver: a new non-compliant file fails the build,
 * and so does a listed file that has since been fixed, so the list can
 * neither grow silently nor go stale. It is empty — every fixture that
 * reads a default log destination today runs on a configuration of its own.
 */

import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TESTS_ROOT = join(fileURLToPath(new URL('.', import.meta.url)))
/** The shared fixture helper itself: it DEFINES the isolation (and the budgeted spawn wrappers), so it is never one of its own subjects. */
const HELPER_FILE = 'lib/process-fixture.ts'
/** This file: it defines the rule, and carries a synthetic sample of every shape the rule forbids, so it is never one of its own subjects either. */
const GUARD_FILE = 'log-destination-isolation.test.ts'

/** Files whose own calls still run in this repository's working directory. Empty — see this file's own header. */
const GRANDFATHERED_FILES: string[] = []

function walk(dir: string, prefix: string): [string, string][] {
  const out: [string, string][] = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const abs = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    if (entry.isDirectory()) {
      out.push(...walk(abs, rel))
      continue
    }
    if (!/\.tsx?$/.test(entry.name)) continue
    out.push([rel, abs])
  }
  return out
}

/** `content` with every comment blanked to same-length whitespace, so a doc comment that merely NAMES a spawn or a logs path is never mistaken for one. Strings are left intact: a command name and a `cwd` key are both read as real syntax. */
function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '))
}

/**
 * A string delimiter — single quote, double quote or backtick — and its
 * negation, spelled as escapes rather than as the characters themselves, and
 * composed into patterns through `new RegExp` rather than written inline.
 * `process-fixture-coverage.test.ts` scans this same tree with a scanner that
 * blanks strings by delimiter while reading a regex literal as ordinary code,
 * so an ODD number of raw quotes inside one of these patterns throws its whole
 * pass off by a string and hands it this file's own comments as code.
 */
const QUOTE = '[\\u0027\\u0022\\u0060]'
const NOT_QUOTE = '[^\\u0027\\u0022\\u0060]'

/**
 * Reads the default log destination: a path built from a `runtime` segment
 * and the `logs` folder inside it, a `runtimeDir` joined to `'logs'`, or
 * `isolatedConfigFixture`'s own `logsDir` — or a log file located by NAME
 * inside a `$HOME`-rooted `.vinaya` tree, which is the same read one
 * directory higher: `cancel.test.ts` searched `<home>/.vinaya` for
 * `991.ndjson` and so was invisible to the first three shapes while being
 * exactly what they are about.
 */
const READS_DEFAULT_DESTINATION = new RegExp(
  `['"]runtime['"][\\s\\S]{0,80}?['"]logs['"]|runtimeDir\\s*,\\s*['"]logs['"]|\\.logsDir\\b|` +
    `${QUOTE}${NOT_QUOTE}*\\.vinaya${QUOTE}[\\s\\S]{0,4000}?\\.ndjson`
)

/**
 * A fixture that names its OWN `logs.folder` (`log-sink-no-sync-spawn.test.ts`,
 * `log-destination.test.ts`) declares the destination it reads, so no
 * repository setting is in scope for it however it runs — the one honest
 * alternative to an isolated working directory, and not a subject of this
 * scan.
 */
const DECLARES_OWN_DESTINATION = new RegExp(`logs${QUOTE}?\\s*:\\s*\\{[^}]*folder`)

/**
 * Every shape that starts a real process. `spawn`/`exec` as bare calls are
 * deliberately absent — this file's subjects are the handful that read a
 * default log destination, and every one of them uses one of these. Written
 * without a `(?:Sync)?` group after `spawn`, so this source line does not
 * itself read as a `spawn(` call to `process-fixture-coverage.test.ts`'s own
 * scan of the same tree.
 */
const SPAWNS_REAL_PROCESS =
  /(?:Bun\.spawnSync|Bun\.spawn|\bspawnSyncBudgeted|\bspawnBudgetedAsync|(?<!\.)\bspawnSync|\bexecFileSync|\bexecSync)\s*\(/g

/** Commands that do one fixed thing to the filesystem or the process table and never resolve a Vinaya configuration, so where they run cannot affect a log destination. */
const CONFIGURATION_INERT_COMMANDS = new Set([
  'git',
  'chmod',
  'mkdir',
  'ln',
  'cp',
  'rm',
  'touch',
  'ps',
  'kill',
  'which',
  'true'
])

/** The call's arguments, from its opening parenthesis to the parenthesis that closes it. */
function callArguments(code: string, openIndex: number): string {
  let depth = 0
  for (let i = openIndex; i < code.length; i++) {
    if (code[i] === '(') depth++
    else if (code[i] === ')') {
      depth--
      if (depth === 0) return code.slice(openIndex, i + 1)
    }
  }
  return code.slice(openIndex)
}

/**
 * The command a call names, when it names one literally — the first token of
 * a string argument (`execSync`'s whole shell line included). `null` for a
 * call whose command is an identifier: nothing is exempted on a name alone.
 */
function literalCommand(args: string): string | null {
  const m = args.match(/^\(\s*(?:\[\s*)?['"]([^'"]+)['"]/)
  if (!m) return null
  const line = m[1] as string
  // A shell line is exempt only when NOTHING in it runs a JavaScript
  // runtime or the CLI — `ps -eo pid,command | grep …` is a process-table
  // read; `ps … | xargs bun …` is not.
  if (/\b(?:bun|node|vinaya)\b/.test(line)) return null
  return line.trim().split(/\s+/)[0] as string
}

/** A working directory this call names: `{ cwd }`, `{ cwd: dir }`, or a threaded options object (`{ ...opts }`) whose own callers name it. */
function namesWorkingDirectory(args: string): boolean {
  return /\bcwd\s*[,:}]/.test(args) || /\.\.\.\s*(?:opts|options|spawnOpts|spawnOptions)\b/.test(args)
}

/**
 * An expression that resolves to this repository: a module's own path walked
 * up — `join(import.meta.dir, '..', …)`, or the `fileURLToPath(new URL('.',
 * import.meta.url))` form this very file uses. A captured `process.cwd()` is
 * deliberately NOT one of these: a fixture captures it to restore it
 * afterwards, which is the opposite of running something there. Handing
 * `process.cwd()` straight to a child is caught on its own, below.
 */
const REPOSITORY_ROOTED_EXPRESSION = new RegExp(
  `(?:import\\.meta\\.dir|import\\.meta\\.url)[\\s\\S]{0,160}?${QUOTE}\\.\\.${QUOTE}`
)

/** A binding that READS a repository-rooted path holds that file's CONTENTS, not a directory — `const source = readFileSync(join(import.meta.dir, '..', 'src', …))` is a source-text assertion, and handing it to `indexOf` runs nothing. */
const READS_THE_PATH = /\b(?:readFileSync|readdirSync|existsSync|statSync|readFile)\s*\(/

/** Every name a file binds — with `const`/`let`/`var`, exported or not — to a repository-rooted DIRECTORY. */
function locallyBoundRepositoryRoots(code: string): string[] {
  const out: string[] = []
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n]*)/g)) {
    const expression = m[2] as string
    if (!REPOSITORY_ROOTED_EXPRESSION.test(expression)) continue
    if (READS_THE_PATH.test(expression)) continue
    out.push(m[1] as string)
  }
  return out
}

/** A relative import's own source, resolved against `rel`'s own directory — `null` when the specifier is not a file in this tree (a package, or a path this scan cannot see). */
function siblingModuleCode(rel: string, specifier: string): string | null {
  const dir = join(TESTS_ROOT, rel, '..')
  for (const candidate of [specifier, `${specifier}.ts`, `${specifier}/index.ts`, specifier.replace(/\.js$/, '.ts')]) {
    const abs = join(dir, candidate)
    if (/\.tsx?$/.test(abs) && existsSync(abs)) return stripComments(readFileSync(abs, 'utf8'))
  }
  return null
}

/**
 * Every name that holds this repository's own root inside `code` — bound
 * here, or imported from a sibling module that binds it there. Traced to the
 * binding rather than trusted by spelling, the same rule
 * `process-fixture-coverage.test.ts`'s own `identifierResolvesToGit`
 * follows: `conformance/live-smoke.ts` hands its server spawn a `REPO_ROOT`
 * it imports from `harness.ts`, and the name alone is not evidence of what
 * it holds.
 */
function repositoryRootedIdentifiers(rel: string, code: string): string[] {
  const out = [...locallyBoundRepositoryRoots(code)]
  const relativeImport = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*${QUOTE}(\\.${NOT_QUOTE}*)${QUOTE}`, 'g')
  for (const m of code.matchAll(relativeImport)) {
    const names = (m[1] as string)
      .split(',')
      .map((n) => (n.split(/\s+as\s+/).pop() ?? '').trim())
      .filter(Boolean)
    if (names.length === 0) continue
    const moduleCode = siblingModuleCode(rel, m[2] as string)
    if (moduleCode === null) continue
    const bound = new Set(locallyBoundRepositoryRoots(moduleCode))
    for (const name of names) if (bound.has(name)) out.push(name)
  }
  return out
}

/**
 * Callees that run nothing: a pure path computation, a filesystem read, or
 * the test framework's own structure. Handing one this repository's root
 * resolves no configuration — `join(REPO_ROOT, 'fixtures')` is a path, and a
 * `describe` body merely CONTAINS whatever its own calls do.
 */
const CALLEES_THAT_RUN_NOTHING = new Set([
  'join',
  'resolve',
  'relative',
  'dirname',
  'basename',
  'existsSync',
  'readFileSync',
  'readdirSync',
  'statSync',
  'realpathSync',
  'String',
  'describe',
  'it',
  'test',
  'expect',
  'beforeEach',
  'afterEach',
  'beforeAll',
  'afterAll',
  // Restores a captured working directory rather than choosing one; going
  // INTO a repository-rooted directory is caught by the `cwd`/argument scan
  // instead, since `chdir` takes its directory as its own argument.
  'chdir'
])

/** The callee whose own argument list `index` sits directly inside, skipping the nested calls between them — `null` when `index` is not inside any call. */
function enclosingCallee(code: string, index: number): string | null {
  let depth = 0
  for (let i = index; i >= 0; i--) {
    const ch = code[i]
    if (ch === ')') depth++
    else if (ch === '(') {
      if (depth > 0) {
        depth--
        continue
      }
      // `String.match`, never `RegExp.exec`: `process-fixture-coverage.test.ts`
      // scans this same tree for a member-call `exec(`, which is also how a
      // real `cp.exec(…)` runs a shell — this line would read as one.
      const m = code.slice(Math.max(0, i - 60), i).match(/([A-Za-z_$][\w$]*)\s*$/)
      return m ? (m[1] as string) : null
    }
  }
  return null
}

/**
 * Every place the file hands this repository's own root to something that
 * runs: a spawn option (`cwd: repoRoot`), or any argument of a call that is
 * not a pure path/read — `runFixtureScript(scriptPath, repoRoot, env)`,
 * which named a working directory and so satisfied the original rule exactly
 * while running in this checkout, and `new SpawnRpcClient(…, REPO_ROOT)`,
 * whose working directory is a positional argument with no `cwd` key in
 * sight.
 */
function repositoryRootedRunSites(rel: string, code: string): string[] {
  const ids = [...new Set(repositoryRootedIdentifiers(rel, code))].map((id) => `\\b${escapeForRegExp(id)}\\b`)
  // A working directory handed straight to a child, never captured: the one
  // `process.cwd()` shape that IS this repository being run in.
  ids.push('process\\.cwd\\s*\\(\\s*\\)')
  const out = new Set<string>()
  for (const id of ids) {
    for (const m of code.matchAll(new RegExp(id, 'g'))) {
      if (m.index === undefined) continue
      const callee = enclosingCallee(code, m.index)
      if (callee === null || CALLEES_THAT_RUN_NOTHING.has(callee)) continue
      out.add(`${callee}(… ${code.slice(m.index, m.index + 48).replace(/\s+/g, ' ')}…`)
    }
  }
  return [...out]
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The file imports Vinaya code — the CLI's own `src`, or a workspace package — and so can call it in THIS process. */
const IMPORTS_VINAYA_CODE = new RegExp(
  `from\\s+${QUOTE}${NOT_QUOTE}*\\/src\\/${NOT_QUOTE}*${QUOTE}|from\\s+${QUOTE}@attalabs\\/`
)

/**
 * A working directory the file names for the code it runs: `process.chdir(dir)`
 * — the in-process counterpart of a spawn's own `cwd` — or a `cwd` it hands
 * to whatever it delegates its run to (`conformance/live-smoke.ts` gives its
 * JSON-RPC client a `serverCwd`). A file that names none, starts no process
 * and still reads a default log destination is running in this repository:
 * the test runner's own working directory is the only one it can have.
 */
const NAMES_A_WORKING_DIRECTORY = /process\.chdir\s*\(|cwd/i

/** Every call site in `code` that starts a real process without naming a working directory. */
function unisolatedCallSites(code: string): string[] {
  const out: string[] = []
  SPAWNS_REAL_PROCESS.lastIndex = 0
  for (const m of code.matchAll(SPAWNS_REAL_PROCESS)) {
    if (m.index === undefined) continue
    const args = callArguments(code, code.indexOf('(', m.index))
    const command = literalCommand(args)
    if (command && CONFIGURATION_INERT_COMMANDS.has(command)) continue
    if (namesWorkingDirectory(args)) continue
    out.push(`${code.slice(m.index, m.index + 60).replace(/\s+/g, ' ')}…`)
  }
  return out
}

/** Whether `code` starts a real process at all — a file that does not, yet reads a default log destination, is reading it from an in-process call. */
function startsAnyRealProcess(code: string): boolean {
  SPAWNS_REAL_PROCESS.lastIndex = 0
  return SPAWNS_REAL_PROCESS.test(code)
}

/** Whether `code` reads a default log destination without declaring one of its own — the subject predicate, over already-comment-blanked code. */
function readsDefaultDestination(code: string): boolean {
  return READS_DEFAULT_DESTINATION.test(code) && !DECLARES_OWN_DESTINATION.test(code)
}

const IN_PROCESS_SITE =
  'in-process call into Vinaya code — no real process in this file, so its working directory is this repository'

/** Every way `code` runs Vinaya code in this repository's own working directory: unisolated spawns, anything handed this checkout's own root, and the in-process case. */
function repositoryWorkingDirectorySites(rel: string, code: string): string[] {
  const out = [...unisolatedCallSites(code), ...repositoryRootedRunSites(rel, code)]
  const inProcessOnly = !startsAnyRealProcess(code) && IMPORTS_VINAYA_CODE.test(code)
  if (inProcessOnly && !NAMES_A_WORKING_DIRECTORY.test(code)) out.push(IN_PROCESS_SITE)
  return out
}

/** Every file under `apps/cli/tests` that reads a default log destination, paired with its own offending sites. */
function subjects(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const [rel, abs] of walk(TESTS_ROOT, '')) {
    if (rel === HELPER_FILE || rel === GUARD_FILE) continue
    const code = stripComments(readFileSync(abs, 'utf8'))
    if (!readsDefaultDestination(code)) continue
    out.set(rel, repositoryWorkingDirectorySites(rel, code))
  }
  return out
}

describe("no test reads this repository's own log destination", () => {
  it('every fixture that reads a default log destination runs on a configuration of its own', () => {
    const offenders = [...subjects()]
      .filter(([rel, sites]) => sites.length > 0 && !GRANDFATHERED_FILES.includes(rel))
      .map(([rel, sites]) => `${rel}\n    ${sites.join('\n    ')}`)
    expect(offenders).toEqual([])
  })

  it('every grandfathered path is still a real, still-offending file — a stale entry fails as loudly as a missing one', () => {
    const found = subjects()
    const stale = GRANDFATHERED_FILES.filter((rel) => (found.get(rel) ?? []).length === 0)
    expect(stale).toEqual([])
  })

  // Nine files today, no grandfathered entry among them: `checks/runner/cancelled.test.ts`,
  // `lib/dev-review-loop.test.ts`, `lib/dispatch.test.ts`, `lib/dev-review-loop-harness.ts`,
  // `lib/dispatch/unattended.test.ts`, `lib/log-webhook-drain.test.ts`,
  // `lib/task-tools/cancel.test.ts`, `commands/dispatch.test.ts` and
  // `conformance/live-smoke.ts`. A number that DROPS means a subject quietly
  // left the scan — the same staleness the grandfather list's own test catches.
  it('the scan finds the fixtures it is meant to cover — an empty subject set would make it vacuous', () => {
    expect(subjects().size).toBeGreaterThanOrEqual(9)
  })

  it("the shared fixture's own configuration declares a destination — an empty one leaves the default branch's own setting in scope", () => {
    const helper = stripComments(readFileSync(join(TESTS_ROOT, HELPER_FILE), 'utf8'))
    expect(DECLARES_OWN_DESTINATION.test(helper)).toBe(true)
    // And the declared folder is the SAME place the fixture advertises as its
    // own `logsDir`, so an attended child (which honours the declared value)
    // and an unattended one (whose local value the trust-anchor gate refuses,
    // falling back to the default folder) write to one path, not two.
    expect(helper).toContain('logsDir: join(logsFolder, FIXTURE_REPO_SEGMENT)')
  })

  // The samples below are the scan's own positive controls: each is a
  // fixture shape this rule exists to reject, and each was compliant under
  // the spawn-only version of it. Kept here, as code the scan is run
  // against directly, rather than as a real file in the tree — a committed
  // failing fixture would have to be excluded from the suite it lives in.
  // None of them spells a budgeted-spawn call out: `process-fixture-coverage.test.ts`
  // scans this same tree, and reads a spawn named inside one of these
  // samples as a real, unhardened call site of this file's own.
  it('a spawn whose named working directory resolves to this repository is flagged, not accepted for naming one', () => {
    const sample = stripComments(`
      const repoRoot = join(import.meta.dir, '..', '..')
      const home = mkdtempSync(join(tmpdir(), 'x-'))
      const found = findOutboxFile(join(home, '.vinaya'), '991.ndjson')
      const out = runFixtureScript(scriptPath, repoRoot, env)
    `)
    expect(readsDefaultDestination(sample)).toBe(true)
    expect(repositoryWorkingDirectorySites(GUARD_FILE, sample)).not.toEqual([])
  })

  it("a default log file read from an in-process call is flagged: the test runner's own working directory is this repository", () => {
    const sample = stripComments(`
      import { log } from '../src/lib/log-sink.js'
      const home = mkdtempSync(join(tmpdir(), 'x-'))
      await log({ operation: 'task_start' })
      const landed = readFileSync(join(home, '.vinaya', 'runtime', 'r', 'logs', 'r', '558.ndjson'), 'utf8')
    `)
    expect(readsDefaultDestination(sample)).toBe(true)
    expect(repositoryWorkingDirectorySites(GUARD_FILE, sample)).toEqual([IN_PROCESS_SITE])
  })

  it("a fixture spawned into an isolated configuration's own directory is accepted", () => {
    const sample = stripComments(`
      const fixture = isolatedConfigFixture('x-')
      const found = findOutboxFile(join(fixture.home, '.vinaya'), '991.ndjson')
      const out = runFixtureScript(scriptPath, fixture.cwd, fixture.env)
    `)
    expect(readsDefaultDestination(sample)).toBe(true)
    expect(repositoryWorkingDirectorySites(GUARD_FILE, sample)).toEqual([])
  })

  it('a fixture that declares its own logs folder is not a subject at all — it names the destination it reads', () => {
    const sample = stripComments(`
      writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify({ logs: { folder: ownLogs } }))
      const landed = readFileSync(join(ownLogs, '558.ndjson'), 'utf8')
    `)
    expect(readsDefaultDestination(sample)).toBe(false)
  })
})
