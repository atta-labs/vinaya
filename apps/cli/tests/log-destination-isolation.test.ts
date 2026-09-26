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
 * The fix in each such fixture is to run the code with a working directory of
 * its own, holding a `vinaya.config.json` that declares a destination — a
 * scratch directory with one, or `isolatedConfigFixture`'s, whose own
 * declared `logs.folder` is both where the walk stops and the destination the
 * fixture then reads. An EMPTY configuration there is not enough, for the
 * reason the trust-anchor paragraph below gives. This file
 * is the mechanical backstop for it, in the shape
 * `process-fixture-coverage.test.ts` already established for the
 * environment/kill-budget halves: walk the real tree, find every file that
 * reads a default log destination, and require each of them to run Vinaya
 * code only in a working directory that is not this repository's — or to be
 * listed, by path, on `GRANDFATHERED_FILES`.
 *
 * Three shapes are non-compliant:
 *   - a real-process call that names no working directory at all (the child
 *     inherits this process's, i.e. this repository's);
 *   - a directory that RESOLVES to this repository handed to anything that
 *     runs — `cwd: repoRoot`, the same identifier passed to a `run…`/`spawn…`
 *     wrapper, a `REPO_ROOT` imported from a sibling module, or a
 *     `process.chdir` into it. Naming a working directory was the whole of the
 *     original rule, and it was not enough: `cancel.test.ts` named one, and
 *     what it named was this checkout;
 *   - a call to a Vinaya Log PRODUCER in this process — the module-level
 *     `log()`, a default-deps sink, the loop driver, `dispatchRole` — by a
 *     file that neither hands that producer a destination of its own nor moves
 *     this process out of the repository with a `process.chdir`. A spawned
 *     child can be given a directory; in-process code cannot, so those two are
 *     the only isolations available to it. Two subjects rely on one each
 *     today: `lib/dev-review-loop-harness.ts` chdirs into its own scratch
 *     world, and `lib/log-destination.test.ts` builds every sink it exercises
 *     from injected deps.
 *
 * Every judgement above is made on what the code does, never on a token that
 * happens to appear. A producer call inside a fixture SCRIPT belongs to the
 * child that runs it; `console.log` is not `log`; an inert `git init` names a
 * directory for `git` and nothing else; a captured `process.cwd()` chooses no
 * directory; a `chdir` into this checkout is the offence rather than the
 * isolation; and a `logs.folder` this file writes for a child says nothing
 * about its own in-process read. Each of those was a way through this scan,
 * reported against an earlier version of it, and each has a standing case at
 * the bottom of this file.
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

/**
 * How many files the scan must still find. A number that DROPS means a subject
 * quietly left it — the same staleness the grandfather list's own test catches.
 * The ten today: `checks/runner/cancelled.test.ts`, `lib/dev-review-loop.test.ts`,
 * `lib/dispatch.test.ts`, `lib/dev-review-loop-harness.ts`,
 * `lib/log-destination.test.ts`, `lib/dispatch/unattended.test.ts`,
 * `lib/log-webhook-drain.test.ts`, `lib/task-tools/cancel.test.ts`,
 * `commands/dispatch.test.ts` and `conformance/live-smoke.ts`.
 */
const SUBJECT_FLOOR = 10

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

/**
 * Two views of one file, each the SAME LENGTH as the source, so an offset
 * found in either indexes the other:
 *
 *   - `withStrings` — comments blanked, string and template literals intact.
 *     A destination path and a command name are both string content, so the
 *     read predicate and `literalCommand` need them.
 *   - `codeOnly` — comments AND strings blanked. A spawn, a `cwd` key and a
 *     `log()` call are real syntax, never string content, so every syntax
 *     predicate reads this view. It is also what keeps a fixture SCRIPT — a
 *     template literal holding a whole program — from being read as this
 *     file's own code: that program's `log()` call runs in a child.
 *
 * Both are produced by one scanner rather than by a regex, because a regex
 * cannot tell a `//` inside a string from a comment: `'https://x/y'` ended the
 * physical line for every earlier scan here, hiding whatever followed it,
 * including an unisolated spawn (round 3 review, MINOR; round 3 security
 * review, MEDIUM). Regex literals are tracked too — otherwise a pattern like
 * a character class holding a quote would open a string that swallows the rest
 * of the file — using the standard preceding-token heuristic, which is exact
 * for every shape in this tree: a `/` can only begin a regex where a value
 * cannot already have ended.
 */
type ScannedSource = { withStrings: string; codeOnly: string }

function scanSource(content: string): ScannedSource {
  const withStrings: string[] = []
  const codeOnly: string[] = []
  const blank = (text: string): string => text.replace(/[^\n]/g, ' ')
  const emit = (text: string, keepInWithStrings: boolean): void => {
    withStrings.push(keepInWithStrings ? text : blank(text))
    codeOnly.push(blank(text))
  }
  const code = (text: string): void => {
    withStrings.push(text)
    codeOnly.push(text)
  }

  let i = 0
  const n = content.length
  // Template literals nest: `${ … }` is code again, and may hold another
  // template. A stack of the open `${` brace depths is what lets the scanner
  // come back out to the right literal.
  const templateStack: number[] = []
  let braceDepth = 0
  let previousMeaningful = ''

  while (i < n) {
    const c = content[i] as string
    const next = content[i + 1]

    if (c === '/' && next === '/') {
      const nl = content.indexOf('\n', i)
      const end = nl === -1 ? n : nl
      emit(content.slice(i, end), false)
      i = end
      continue
    }
    if (c === '/' && next === '*') {
      const close = content.indexOf('*/', i + 2)
      const end = close === -1 ? n : close + 2
      emit(content.slice(i, end), false)
      i = end
      continue
    }
    if (c === '/' && beginsRegexLiteral(previousMeaningful)) {
      const end = endOfRegexLiteral(content, i)
      code(content.slice(i, end))
      previousMeaningful = '/'
      i = end
      continue
    }
    if (c === "'" || c === '"') {
      const end = endOfQuotedString(content, i, c)
      emit(content.slice(i, end), true)
      previousMeaningful = c
      i = end
      continue
    }
    if (c === '`') {
      const end = endOfTemplateChunk(content, i)
      emit(content.slice(i, end), true)
      if (content.slice(end - 2, end) === '${') {
        templateStack.push(braceDepth)
        braceDepth++
      } else {
        previousMeaningful = '`'
      }
      i = end
      continue
    }
    if (c === '{') braceDepth++
    if (c === '}') {
      braceDepth--
      if (templateStack.length > 0 && templateStack[templateStack.length - 1] === braceDepth) {
        templateStack.pop()
        const end = endOfTemplateChunk(content, i)
        emit(content.slice(i, end), true)
        if (content.slice(end - 2, end) === '${') {
          templateStack.push(braceDepth)
          braceDepth++
        }
        i = end
        continue
      }
    }
    code(c)
    if (!/\s/.test(c)) previousMeaningful = c
    i++
  }
  return { withStrings: withStrings.join(''), codeOnly: codeOnly.join('') }
}

/** Where a value cannot already have ended, a `/` opens a regex rather than dividing. */
function beginsRegexLiteral(previousMeaningful: string): boolean {
  return previousMeaningful === '' || '(,=:[!&|?{};+-*%^<>~'.includes(previousMeaningful)
}

/** The index just past a regex literal opening at `start`, character classes included (a `/` inside `[…]` closes nothing). */
function endOfRegexLiteral(content: string, start: number): number {
  let inClass = false
  for (let i = start + 1; i < content.length; i++) {
    const c = content[i]
    if (c === '\\') {
      i++
      continue
    }
    if (c === '\n') return i
    if (c === '[') inClass = true
    else if (c === ']') inClass = false
    else if (c === '/' && !inClass) return i + 1
  }
  return content.length
}

/** The index just past a `'`/`"` string opening at `start`. */
function endOfQuotedString(content: string, start: number, quote: string): number {
  for (let i = start + 1; i < content.length; i++) {
    const c = content[i]
    if (c === '\\') {
      i++
      continue
    }
    if (c === quote || c === '\n') return i + 1
  }
  return content.length
}

/** The index just past a template chunk opening at `start` — at its closing backtick, or just past the `${` that interrupts it. */
function endOfTemplateChunk(content: string, start: number): number {
  for (let i = start + 1; i < content.length; i++) {
    const c = content[i]
    if (c === '\\') {
      i++
      continue
    }
    if (c === '`') return i + 1
    if (c === '$' && content[i + 1] === '{') return i + 2
  }
  return content.length
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
 * A configuration that declares its own `logs.folder`. No longer a waiver for
 * anything in the scan — a declaration this file writes could be for a CHILD,
 * and reading it as the parent's own isolation was a way through (round 3
 * review, MINOR; round 3 security review, LOW). It survives as the vocabulary
 * of one assertion: that the shared fixture helper still declares a
 * destination rather than writing an empty configuration.
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
const SPAWNS_REAL_PROCESS_SOURCE =
  '(?:Bun\\.spawnSync|Bun\\.spawn|\\bspawnSyncBudgeted|\\bspawnBudgetedAsync|(?<!\\.)\\bspawnSync|\\bexecFileSync|\\bexecSync)\\s*\\('

/**
 * A FRESH matcher per scan, never one shared module-level global regex: a
 * global `RegExp` carries `lastIndex` between uses, and `String.matchAll`
 * starts from whatever the previous caller left there, so one `.test()` on a
 * shared instance made every later file's scan begin part-way in and skipped
 * every call site before that offset — an order-dependent blind spot that
 * reported a non-compliant file as clean (round 2 security review, MEDIUM).
 */
function spawnMatcher(): RegExp {
  return new RegExp(SPAWNS_REAL_PROCESS_SOURCE, 'g')
}

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

/** A path whose last literal segment carries an extension names a FILE, never a working directory — `join(import.meta.dir, '..', 'src', 'lib', 'log-sink.ts')` is a module this file imports or interpolates, and nothing runs IN it. */
const NAMES_A_FILE = new RegExp(`${QUOTE}[^\\u0027\\u0022\\u0060/]+\\.[A-Za-z0-9]+${QUOTE}\\s*\\)?\\s*$`)

/** Every name a file binds — with `const`/`let`/`var`, exported or not — to a repository-rooted DIRECTORY. */
function locallyBoundRepositoryRoots(code: string): string[] {
  const out: string[] = []
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n]*)/g)) {
    const expression = m[2] as string
    if (!REPOSITORY_ROOTED_EXPRESSION.test(expression)) continue
    if (READS_THE_PATH.test(expression)) continue
    if (NAMES_A_FILE.test(expression.trim())) continue
    out.push(m[1] as string)
  }
  return out
}

/** A relative import's own source, resolved against `rel`'s own directory — `null` when the specifier is not a file in this tree (a package, or a path this scan cannot see). */
function siblingModuleCode(rel: string, specifier: string): string | null {
  const dir = join(TESTS_ROOT, rel, '..')
  for (const candidate of [specifier, `${specifier}.ts`, `${specifier}/index.ts`, specifier.replace(/\.js$/, '.ts')]) {
    const abs = join(dir, candidate)
    if (/\.tsx?$/.test(abs) && existsSync(abs)) return scanSource(readFileSync(abs, 'utf8')).withStrings
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
function repositoryRootedIdentifiers(rel: string, source: ScannedSource): string[] {
  const code = source.withStrings
  const out = [...locallyBoundRepositoryRoots(code)]
  const relativeImport = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*${QUOTE}(\\.${NOT_QUOTE}*)${QUOTE}`, 'g')
  for (const m of code.matchAll(relativeImport)) {
    const names = (m[1] as string)
      .split(',')
      .map((n) => (n.split(/\s+as\s+/).pop() ?? '').trim())
      .filter(Boolean)
    if (names.length === 0) continue
    const moduleSource = siblingModuleCode(rel, m[2] as string)
    if (moduleSource === null) continue
    const bound = new Set(locallyBoundRepositoryRoots(moduleSource))
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
  'afterAll'
  // `chdir` is deliberately NOT here. It is the one call that really moves
  // this process, so `process.chdir(repoRoot)` is this repository being run
  // in — the most literal form of the offence — and listing it here made the
  // scan skip exactly that (round 3 review, MAJOR).
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
function repositoryRootedRunSites(rel: string, source: ScannedSource): string[] {
  const code = source.codeOnly
  const ids = [...new Set(repositoryRootedIdentifiers(rel, source))].map((id) => `\\b${escapeForRegExp(id)}\\b`)
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

/**
 * Does this file move THIS process out of the repository — `process.chdir(dir)`
 * with a directory that is not the repository itself? That is the only way
 * in-process code can run anywhere else: a `cwd` option hands a directory to a
 * CHILD and says nothing about the caller.
 *
 * The first version of this predicate accepted the bare substring `cwd`
 * anywhere in the file, so any incidental token waived the whole in-process
 * rule — a destructured `const { cwd } = fixture`, a `{ cwd: string }` type,
 * the word inside a quoted sentence, even a literal `cwd: REPO_ROOT` (round 2
 * review; round 3 review, MINOR; round 3 security review, MEDIUM, which
 * planted real files at HEAD to prove each one). Nothing about a `cwd` is
 * evidence of where THIS process runs, so no form of it is consulted here any
 * more.
 */
function relocatesThisProcess(rel: string, source: ScannedSource): boolean {
  const repoRooted = new Set(repositoryRootedIdentifiers(rel, source))
  for (const m of source.codeOnly.matchAll(/process\.chdir\s*\(\s*([A-Za-z_$][\w$.]*)?/g)) {
    const target = m[1]
    // A chdir INTO this repository is the offence, not the isolation; an
    // unnamed target (an expression) is read as a directory of its own, and
    // `repositoryRootedRunSites` reports it separately if it is not.
    if (target !== undefined && repoRooted.has(target)) continue
    return true
  }
  return false
}

/**
 * Calls that write a Vinaya Log event in the process that makes them — the
 * producer boundaries `apps/cli/specs/log.md` § "Producer coverage is
 * enforced, not assumed" already names, plus the sink constructors behind
 * them. A member call is never one of these (`(?<!\.)`): `console.log(…)` is
 * not `log(…)`, and a handler called through an injected dependency
 * (`deps.log`) writes wherever the test told it to.
 *
 * This is what decides the in-process case, instead of "the file starts no
 * process at all". A file that spawns ONE isolated child was exempted
 * wholesale before, so a spawn anywhere in it hid every in-process call it
 * also made, and the rule fired on no real file in the tree (round 3 review,
 * MINOR). Read against the code-only view, so a `log()` inside a fixture
 * SCRIPT — a template literal holding a program a child runs — is correctly
 * not this file's own in-process call.
 */
/**
 * The file hands a producer its OWN destination, so nothing about this
 * repository is in scope for the events it writes: an injected
 * `resolveLogDestination`, or an `outboxRoot` of its own
 * (`lib/log-destination.test.ts`'s `sinkDeps`, which builds every sink it
 * exercises out of a temp directory). A property key in real code, never a
 * quoted phrase — the code-only view is what this is read against.
 *
 * This is the in-process counterpart of a spawned child's `cwd`: the child
 * gets a directory, and an in-process producer gets its destination directly.
 */
const SUPPLIES_ITS_OWN_SINK_DESTINATION = /\b(?:resolveLogDestination|outboxRoot)\s*:/

const CALLS_A_LOG_PRODUCER_IN_PROCESS =
  /(?<!\.)\b(?:log|createLogSink|drainLogSink|dispatchRole|devReviewLoop|cancelDevReviewLoop|assessRound|runChecks|drainOutboxToWebhook)\s*\(/

/**
 * Every real-process call site, found in the code-only view and read back in
 * the string-bearing one: the two are the same length, so one offset indexes
 * both — the site is syntax, the command it names is string content.
 */
function realProcessCallSites(source: ScannedSource): { index: number; args: string; command: string | null }[] {
  const out: { index: number; args: string; command: string | null }[] = []
  for (const m of source.codeOnly.matchAll(spawnMatcher())) {
    if (m.index === undefined) continue
    const open = source.codeOnly.indexOf('(', m.index)
    const args = callArguments(source.codeOnly, open)
    out.push({ index: m.index, args, command: literalCommand(source.withStrings.slice(open, open + args.length)) })
  }
  return out
}

/** Every call site that starts a real process without naming a working directory. */
function unisolatedCallSites(source: ScannedSource): string[] {
  const out: string[] = []
  for (const site of realProcessCallSites(source)) {
    if (site.command && CONFIGURATION_INERT_COMMANDS.has(site.command)) continue
    if (namesWorkingDirectory(site.args)) continue
    out.push(`${source.withStrings.slice(site.index, site.index + 60).replace(/\s+/g, ' ')}…`)
  }
  return out
}

/** Whether the file reads a default log destination — the subject predicate, over the view that still holds the paths. */
function readsDefaultDestination(source: ScannedSource): boolean {
  return READS_DEFAULT_DESTINATION.test(source.withStrings)
}

const IN_PROCESS_SITE = 'calls a Vinaya Log producer in this process without moving this process out of the repository'

/**
 * Every way the file runs Vinaya code in this repository's own working
 * directory: a spawn naming no working directory, anything handed this
 * checkout's own root (a `cwd`, a positional argument, or a `chdir`), and a
 * log producer called in this process by a file that never relocates it.
 *
 * Every one of these reads the code-only view. A `logs.folder` a file writes
 * for a CHILD no longer excuses its own in-process read either — that
 * declaration pins where the child delivers, not where this process resolves
 * its own destination (round 3 review, MINOR; round 3 security review, LOW,
 * which reached the same waiver with nothing but the phrase in a string).
 */
function repositoryWorkingDirectorySites(rel: string, source: ScannedSource): string[] {
  const out = [...unisolatedCallSites(source), ...repositoryRootedRunSites(rel, source)]
  const producesInProcess =
    CALLS_A_LOG_PRODUCER_IN_PROCESS.test(source.codeOnly) && !SUPPLIES_ITS_OWN_SINK_DESTINATION.test(source.codeOnly)
  if (producesInProcess && !relocatesThisProcess(rel, source)) out.push(IN_PROCESS_SITE)
  return out
}

/** Every file under `apps/cli/tests` that reads a default log destination, paired with its own offending sites. */
function subjects(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const [rel, abs] of walk(TESTS_ROOT, '')) {
    if (rel === HELPER_FILE || rel === GUARD_FILE) continue
    const source = scanSource(readFileSync(abs, 'utf8'))
    if (!readsDefaultDestination(source)) continue
    out.set(rel, repositoryWorkingDirectorySites(rel, source))
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

  it('the scan finds the fixtures it is meant to cover — an empty subject set would make it vacuous', () => {
    expect(subjects().size).toBeGreaterThanOrEqual(SUBJECT_FLOOR)
  })

  it("the shared fixture's own configuration declares a destination — an empty one leaves the default branch's own setting in scope", () => {
    const helper = scanSource(readFileSync(join(TESTS_ROOT, HELPER_FILE), 'utf8')).codeOnly
    expect(DECLARES_OWN_DESTINATION.test(helper)).toBe(true)
    // And the declared folder is the SAME place the fixture advertises as its
    // own `logsDir`, so an attended child (which honours the declared value)
    // and an unattended one (whose local value the trust-anchor gate refuses,
    // falling back to the default folder) write to one path, not two.
    expect(helper).toContain('logsDir: join(logsFolder, FIXTURE_REPO_SEGMENT)')
  })

  // Every case below is a shape this rule exists to reject or to accept, run
  // through the real scan. Each was reported against a version of this file
  // that got it wrong, so each stays as the standing proof of one defect. None
  // of them spells a budgeted-spawn call out: `process-fixture-coverage.test.ts`
  // scans this same tree, and reads a spawn named inside one of these samples
  // as a real, unhardened call site of this file's own.
  const sitesFor = (sample: string): string[] => repositoryWorkingDirectorySites(GUARD_FILE, scanSource(sample))
  const A_DEFAULT_READ =
    "const landed = readFileSync(join(home, '.vinaya', 'runtime', 'r', 'logs', 'r', '558.ndjson'), 'utf8')"
  const AN_IN_PROCESS_PRODUCER = "await log({ operation: 'task_start' })"

  it('a spawn whose named working directory resolves to this repository is flagged, not accepted for naming one', () => {
    const sample = `
      const repoRoot = join(import.meta.dir, '..', '..')
      const found = findOutboxFile(join(home, '.vinaya'), '991.ndjson')
      const out = runFixtureScript(scriptPath, repoRoot, env)
    `
    expect(readsDefaultDestination(scanSource(sample))).toBe(true)
    expect(sitesFor(sample)).not.toEqual([])
  })

  it('a log producer called in this process is flagged: the test runner runs in the repository', () => {
    const sample = `
      import { log } from '../src/lib/log-sink.js'
      ${AN_IN_PROCESS_PRODUCER}
      ${A_DEFAULT_READ}
    `
    expect(sitesFor(sample)).toEqual([IN_PROCESS_SITE])
  })

  it('…and still flagged when the same file also spawns a properly isolated child, which used to excuse it wholesale', () => {
    const sample = `
      import { log } from '../src/lib/log-sink.js'
      const fixture = isolatedConfigFixture('x-')
      const out = runFixtureScript(scriptPath, fixture.cwd, fixture.env)
      ${AN_IN_PROCESS_PRODUCER}
      ${A_DEFAULT_READ}
    `
    expect(sitesFor(sample)).toEqual([IN_PROCESS_SITE])
  })

  it('a chdir INTO this repository is the offence, never the isolation', () => {
    const sample = `
      import { log } from '../src/lib/log-sink.js'
      const repoRoot = join(import.meta.dir, '..', '..')
      process.chdir(repoRoot)
      ${AN_IN_PROCESS_PRODUCER}
      ${A_DEFAULT_READ}
    `
    const sites = sitesFor(sample)
    expect(sites).toContain(IN_PROCESS_SITE)
    expect(sites.some((site) => site.includes('chdir'))).toBe(true)
  })

  it('a chdir into a directory of its own does excuse it — that is what moving this process means', () => {
    const sample = `
      import { log } from '../src/lib/log-sink.js'
      process.chdir(world.repoRoot)
      ${AN_IN_PROCESS_PRODUCER}
      ${A_DEFAULT_READ}
    `
    expect(sitesFor(sample)).toEqual([])
  })

  it('no incidental cwd token excuses an in-process producer — a destructured one, a type, or a quoted sentence', () => {
    for (const token of [
      'const { cwd } = fixture',
      'type Opts = { cwd: string }',
      "const hint = 'pass { cwd: dir } to the child'",
      'const options = { cwd: someTempDir }'
    ]) {
      const sample = `
        import { log } from '../src/lib/log-sink.js'
        ${token}
        ${AN_IN_PROCESS_PRODUCER}
        ${A_DEFAULT_READ}
      `
      expect(sitesFor(sample), token).toEqual([IN_PROCESS_SITE])
    }
  })

  it('a logs.folder this file writes for a CHILD excuses nothing about its own in-process read, quoted or not', () => {
    for (const declaration of [
      "writeFileSync(join(sandbox, 'vinaya.config.json'), JSON.stringify({ logs: { folder: join(sandbox, 'childlogs') } }))",
      "const advice = 'set logs: { folder: /somewhere } in vinaya.config.json'"
    ]) {
      const sample = `
        import { log } from '../src/lib/log-sink.js'
        ${declaration}
        ${AN_IN_PROCESS_PRODUCER}
        ${A_DEFAULT_READ}
      `
      expect(sitesFor(sample), declaration).toEqual([IN_PROCESS_SITE])
    }
  })

  it('a producer call inside a fixture SCRIPT belongs to the child that runs it, not to this file', () => {
    const sample = [
      "const fixture = isolatedConfigFixture('x-')",
      'const script = `',
      "import { log } from '../../src/lib/log-sink.js'",
      "await log({ operation: 'task_start' })",
      '`',
      'const out = runFixtureScript(scriptPath, fixture.cwd, fixture.env)',
      A_DEFAULT_READ
    ].join('\n')
    expect(readsDefaultDestination(scanSource(sample))).toBe(true)
    expect(sitesFor(sample)).toEqual([])
  })

  it('a producer built from injected deps is accepted — its destination is the one the file handed it', () => {
    const sample = `
      import { createLogSink } from '../src/lib/log-sink.js'
      const { log } = createLogSink({ outboxRoot: () => join(dir, 'queue'), home: () => dir })
      log(DISPATCHED)
      ${A_DEFAULT_READ}
    `
    expect(sitesFor(sample)).toEqual([])
  })

  it('console.log is not a log producer — a member call writes no event', () => {
    const sample = `
      import { defaultControlStoreDeps } from '@attalabs/aeg-core'
      console.log('nothing is recorded here')
      ${A_DEFAULT_READ}
    `
    expect(sitesFor(sample)).toEqual([])
  })

  it('a URL in a string no longer ends the line for the scan — what follows it is still code', () => {
    const scheme = `${'ht'}tps:${'//'}example.com/x`
    const sample = [
      `const endpoint = '${scheme}'; Bun.spawnSync([bin, 'check'], { env: process.env })`,
      A_DEFAULT_READ
    ].join('\n')
    const sites = sitesFor(sample)
    expect(sites).toHaveLength(1)
    expect(sites[0]).toContain('spawnSync')
  })

  it('a block-comment opener inside a string blanks nothing after it either', () => {
    const opener = `${'/'}${'*'}`
    const sample = [
      `const pattern = '${opener} not a comment'; Bun.spawnSync([bin, 'check'], { env: process.env })`,
      A_DEFAULT_READ
    ].join('\n')
    expect(sitesFor(sample)).toHaveLength(1)
  })

  it('a real comment still blanks — a doc comment naming a spawn is not a spawn', () => {
    const sample = [
      '// Bun.spawnSync([bin, "check"], { env })',
      '/* and process.chdir(repoRoot) named in prose */',
      A_DEFAULT_READ
    ].join('\n')
    expect(sitesFor(sample)).toEqual([])
  })

  it("one file's scan never moves another's starting point — the matcher carries no state between them", () => {
    const offending = scanSource(`
      Bun.spawnSync([bin, 'check'], { env })
      ${A_DEFAULT_READ}
    `)
    const alone = unisolatedCallSites(offending)
    expect(alone).toHaveLength(1)
    // A longer, compliant file scanned first: a shared global matcher would
    // leave its own lastIndex past this sample's only call site.
    unisolatedCallSites(scanSource(`${' '.repeat(2000)}\nBun.spawnSync([bin, 'check'], { cwd: dir, env })\n`))
    expect(unisolatedCallSites(offending)).toEqual(alone)
  })
})
