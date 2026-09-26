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
    if (/[A-Za-z_$]/.test(c)) {
      const word = (/^[A-Za-z_$][\w$]*/.exec(content.slice(i))?.[0] ?? c) as string
      code(word)
      previousMeaningful = word
      i += word.length
      continue
    }
    code(c)
    if (!/\s/.test(c)) previousMeaningful = c
    i++
  }
  return { withStrings: withStrings.join(''), codeOnly: codeOnly.join('') }
}

/**
 * Where a value cannot already have ended, a `/` opens a regex rather than
 * dividing. The previous meaningful TOKEN decides it, not the previous
 * character: a regex in keyword position — `return /…/.test(x)`, `await`,
 * `typeof`, `case` — follows a letter, and reading that as division opened a
 * spurious string on the first quote inside the pattern and blanked the rest
 * of the line. `tests/run-paths-only.test.ts` already had one (round 4
 * review, MINOR).
 */
function beginsRegexLiteral(previousToken: string): boolean {
  if (previousToken === '') return true
  if (previousToken.length === 1) return REGEX_MAY_FOLLOW.has(previousToken)
  return KEYWORDS_A_VALUE_FOLLOWS.has(previousToken)
}

/** Keywords a value — and so a regex literal — may directly follow. */
const KEYWORDS_A_VALUE_FOLLOWS = new Set([
  'return',
  'typeof',
  'case',
  'await',
  'yield',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'instanceof',
  'do',
  'else',
  'throw'
])

/** The tokens a value cannot follow: after any of them, a `/` opens a regex rather than dividing. A set of single characters rather than one packed string — a packed one reads as retired vocabulary to the architecture test that scans this tree. */
const REGEX_MAY_FOLLOW = new Set([
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '^',
  '<',
  '>',
  '~'
])

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

/**
 * A working directory this call names: `{ cwd }`, `{ cwd: dir }`, a threaded
 * options object (`{ ...opts }`) whose own callers name it, or a `--cwd`
 * ARGUMENT — `bun run --cwd <dir> build` chooses where it runs as explicitly as
 * the option does, and `conformance/harness.ts`'s own build spawn is written
 * that way. `argsWithStrings` carries the string content the flag lives in;
 * `args` is the code-only view the rest of the rule reads.
 */
function namesWorkingDirectory(args: string, argsWithStrings: string): boolean {
  return (
    /\bcwd\s*[,:}]/.test(args) ||
    /\.\.\.\s*(?:opts|options|spawnOpts|spawnOptions)\b/.test(args) ||
    /--cwd\b/.test(argsWithStrings)
  )
}

/**
 * An expression that resolves to this repository: a module-path anchor walked
 * up. Both halves are required and their ORDER is not, because the real shapes
 * put them either way round — `join(import.meta.dir, '..', '..')` and
 * `fileURLToPath(new URL('../..', import.meta.url))` — and requiring the `..`
 * to come second meant the second form, which this file's own doc comment
 * claimed to recognise, never matched at all (round 4 security review,
 * MEDIUM). `__dirname` is an anchor too: `resolve(__dirname, '..', '..')` is
 * the same walk in the other module system.
 *
 * A captured `process.cwd()` is deliberately NOT one of these: a fixture
 * captures it to restore it afterwards, which is the opposite of choosing to
 * run something there. Handing `process.cwd()` straight to a child is caught
 * on its own, below.
 */
const MODULE_PATH_ANCHOR = /import\.meta\.dir|import\.meta\.url|__dirname|__filename/
const WALKS_UP = new RegExp(`${QUOTE}\\.\\.(?:\\/[^\\u0027\\u0022\\u0060]*)?${QUOTE}`)

function isRepositoryRootedExpression(expression: string): boolean {
  return MODULE_PATH_ANCHOR.test(expression) && WALKS_UP.test(expression)
}

/** A binding that READS a repository-rooted path holds that file's CONTENTS, not a directory — `const source = readFileSync(join(import.meta.dir, '..', 'src', …))` is a source-text assertion, and handing it to `indexOf` runs nothing. */
const READS_THE_PATH = /\b(?:readFileSync|readdirSync|existsSync|statSync|readFile)\s*\(/

/** A path whose last literal segment carries an extension names a FILE, never a working directory — `join(import.meta.dir, '..', 'src', 'lib', 'log-sink.ts')` is a module this file imports or interpolates, and nothing runs IN it. */
const NAMES_A_FILE = new RegExp(`${QUOTE}[^\\u0027\\u0022\\u0060/]+\\.[A-Za-z0-9]+${QUOTE}\\s*\\)?\\s*$`)

/**
 * A binding's whole initializer, however many lines it spans: from the `=` to
 * the `;` or line end that closes it at bracket depth zero. Reading only to
 * the end of the physical line meant a `const repoRoot = join(` wrapped by the
 * formatter bound no name at all, and every use of it escaped the scan (round
 * 4 review, MINOR; round 4 security review, MEDIUM) — the offence this file
 * exists to catch, silenced by a reformat.
 */
function initializerFrom(code: string, start: number): string {
  let depth = 0
  for (let i = start; i < code.length; i++) {
    const c = code[i] as string
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) {
      if (depth === 0) return code.slice(start, i)
      depth--
    } else if (depth === 0 && (c === ';' || (c === '\n' && !/[=+,?:&|(]\s*$/.test(code.slice(start, i))))) {
      return code.slice(start, i)
    }
  }
  return code.slice(start)
}

/** Every name a file binds — with `const`/`let`/`var`, exported or not — to a repository-rooted DIRECTORY. */
function locallyBoundRepositoryRoots(code: string): string[] {
  const out: string[] = []
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g)) {
    if (m.index === undefined) continue
    const expression = initializerFrom(code, m.index + m[0].length)
    if (!isRepositoryRootedExpression(expression)) continue
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
  return withOptionsObjectsCarrying(out, code)
}

/**
 * Every name above, plus every OPTIONS object built around one:
 * `const opts = { cwd: repoRoot }` carries this repository into whatever
 * receives it, and `{ ...opts }` then satisfied the spawn rule's own
 * `namesWorkingDirectory` while the binding site itself sat inside a
 * `describe` body, whose callee runs nothing — so the directory reached the
 * child with neither half of the rule seeing it (round 4 security review,
 * LOW). Iterated to a fixed point, so an options object built from another one
 * carries it too.
 */
function withOptionsObjectsCarrying(roots: string[], code: string): string[] {
  const carriers = new Set(roots)
  for (let pass = 0; pass < 3; pass++) {
    const before = carriers.size
    for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g)) {
      if (m.index === undefined) continue
      const name = m[1] as string
      if (carriers.has(name)) continue
      const initializer = initializerFrom(code, m.index + m[0].length)
      for (const carrier of carriers) {
        const escaped = escapeForRegExp(carrier)
        if (new RegExp(`(?:cwd\\s*:\\s*|\\.\\.\\.\\s*)${escaped}\\b`).test(initializer)) {
          carriers.add(name)
          break
        }
      }
    }
    if (carriers.size === before) break
  }
  return [...carriers]
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
 * The brace blocks containing `index`, innermost first, and finally the whole
 * file. An approximation of lexical scope good enough for this scan's two
 * questions — is there a `process.chdir` before this call in a block that
 * encloses it, and is the producer this call names bound to a sink of the
 * file's own there — and the reason both are decided PER CALL now: every
 * waiver here used to be file-wide, so one `chdir` or one injected dependency
 * anywhere in a file excused every producer call in it, including calls in
 * other functions and calls made after the process had been moved back (round
 * 4 review, MAJOR/MINOR; round 4 security review, MEDIUM twice, each proved
 * live by appending a real leaking call to a file the scan then kept passing).
 */
function enclosingBlocks(code: string, index: number): [number, number][] {
  const out: [number, number][] = []
  let depth = 0
  for (let i = index; i >= 0; i--) {
    const c = code[i]
    if (c === '}') depth++
    else if (c === '{') {
      if (depth > 0) {
        depth--
        continue
      }
      out.push([i, endOfBlock(code, i)])
    }
  }
  out.push([0, code.length])
  return out
}

/**
 * Is `evidence` in the SAME block as `index`, or in one that encloses it?
 * Comparing the evidence's own innermost block against the call's enclosing
 * set is what makes this a scope question rather than a file-order one — the
 * whole-file block is in every call's set, so "appears earlier in the file"
 * would put a `chdir` in one function, or a sink built in another test case, in
 * scope for a call it can never reach.
 */
function inScopeFor(code: string, evidence: number, index: number): boolean {
  if (evidence >= index) return false
  const [innermost] = enclosingBlocks(code, evidence)
  const enclosing = enclosingBlocks(code, index)
  return innermost !== undefined && enclosing.some(([from, to]) => from === innermost[0] && to === innermost[1])
}

/** The index just past the `}` closing the block that opens at `start`. */
function endOfBlock(code: string, start: number): number {
  let depth = 0
  for (let i = start; i < code.length; i++) {
    const c = code[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return code.length
}

/**
 * Names bound to a captured working directory — `const original = process.cwd()`.
 * A `process.chdir` back into one of these is the standard `afterEach` restore:
 * it puts the process back where it started, which in a test run is this
 * repository, so treating it as proof the process left was an inversion of the
 * rule (round 4 review, MAJOR; round 4 security review, MEDIUM).
 */
function capturedWorkingDirectories(code: string): Set<string> {
  const out = new Set<string>()
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*process\.cwd\s*\(\s*\)/g)) {
    out.add(m[1] as string)
  }
  return out
}

/**
 * Was this process moved OUT of the repository before `index`, in a block that
 * encloses it? A `chdir` into this repository, or back into a captured
 * directory, is not a move out — it is the offence, or the restore.
 */
function movedOutOfRepositoryBefore(index: number, code: string, repoRooted: Set<string>): boolean {
  const restores = capturedWorkingDirectories(code)
  for (const m of code.matchAll(/process\.chdir\s*\(\s*([A-Za-z_$][\w$.]*)?/g)) {
    if (m.index === undefined) continue
    const target = m[1]
    if (target !== undefined && (repoRooted.has(target) || restores.has(target))) continue
    if (inScopeFor(code, m.index, index)) return true
  }
  return false
}

/**
 * Was this call made inside a callback handed to a wrapper in this same file
 * whose own body moves the process out of the repository? That is how
 * `lib/dev-review-loop-harness.ts` drives the loop:
 * `withWorldEnv(world, () => devReviewLoop(…))`, and the `process.chdir` into
 * that world's own scratch root lives in `withWorldEnv`, not in any block that
 * lexically encloses the call.
 *
 * Resolved one hop, by NAME resolved to a definition in this file — never by
 * the name alone: a wrapper this file does not define, or one that does not
 * itself chdir, vouches for nothing.
 */
function calledInsideARelocatingWrapper(code: string, index: number, repoRooted: Set<string>): boolean {
  for (const [from] of enclosingBlocks(code, index)) {
    const callee = enclosingCallee(code, from)
    if (callee === null || CALLEES_THAT_RUN_NOTHING.has(callee)) continue
    const body = definitionBodyOf(callee, code)
    if (body === null) continue
    if (movedOutOfRepositoryBefore(body.end, body.code, repoRooted)) return true
  }
  const callee = enclosingCallee(code, index)
  if (callee !== null && !CALLEES_THAT_RUN_NOTHING.has(callee)) {
    const body = definitionBodyOf(callee, code)
    if (body !== null && movedOutOfRepositoryBefore(body.end, body.code, repoRooted)) return true
  }
  return false
}

/** The body of `name`'s own definition in `code` — a `function name(…) { … }` or a `const name = (…) => { … }` — as its own text, with the offset its end sits at inside it. */
function definitionBodyOf(name: string, code: string): { code: string; end: number } | null {
  const escaped = escapeForRegExp(name)
  const declaration = new RegExp(`(?:function\\s+${escaped}\\s*[(<]|(?:const|let|var)\\s+${escaped}\\s*=)`)
  const m = declaration.exec(code)
  if (m === null || m.index === undefined) return null
  const open = code.indexOf('{', m.index)
  if (open === -1) return null
  const body = code.slice(open, endOfBlock(code, open))
  return { code: body, end: body.length }
}

/**
 * Is the producer this call names a sink the FILE built, with a destination of
 * its own — `const { log } = createLogSink(deps)` — rather than the module-level
 * default one? Resolved per call, in the blocks that enclose it, so a sink
 * built inside one test case does not vouch for a call in another
 * (`lib/log-destination.test.ts` builds one per case, and a call appended
 * outside them all resolves this repository's own configuration — the round 4
 * security review's own live proof).
 *
 * `createLogSink()` with no argument at all is the default-deps sink and is not
 * one of these: it resolves exactly what the module-level `log()` resolves.
 */
function usesASinkOfItsOwn(name: string, index: number, code: string): boolean {
  const escaped = escapeForRegExp(name)
  const binding = new RegExp(
    `(?:const|let|var)\\s*(?:\\{[^}]*\\b${escaped}\\b[^}]*\\}|${escaped})\\s*=\\s*createLogSink\\s*\\(\\s*[^)\\s]`,
    'g'
  )
  for (const m of code.matchAll(binding)) {
    if (m.index === undefined) continue
    if (inScopeFor(code, m.index, index)) return true
  }
  return false
}

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
    const open = source.codeOnly.indexOf('(', site.index)
    if (namesWorkingDirectory(site.args, source.withStrings.slice(open, open + site.args.length))) continue
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
 * Every call that writes a Vinaya Log event in the process that makes it. Two
 * families, because what isolates them differs:
 *
 *   - a SINK producer (`log`, `drainLogSink`, `createLogSink`) — isolated when
 *     the name resolves to a sink this file built with deps of its own;
 *   - a BOUNDARY producer (the drivers, the executor, the broker, the
 *     task-tools handler factories) — isolated when the call itself is handed
 *     a `log` dependency, which is how a test drives one without writing
 *     anywhere real.
 *
 * The vocabulary is cross-checked against `lib/log-callers.test.ts`'s own
 * `PRODUCER_BOUNDARIES` by a test below, since that table is what
 * `apps/cli/specs/log.md` treats as the authoritative producer list and this
 * one silently missed four of its boundaries (round 4 security review, LOW).
 */
const SINK_PRODUCERS = ['log', 'drainLogSink', 'createLogSink'] as const
const BOUNDARY_PRODUCERS = [
  'dispatchRole',
  'devReviewLoop',
  'cancelDevReviewLoop',
  'assessRound',
  'runChecks',
  'runOne',
  'requestEffect',
  'authenticateWorkerInvocation',
  'authenticateOperatorInvocation',
  'EffectExecutor',
  'drainOutboxToWebhook',
  'createTaskCancelHandler',
  'createTaskResumeHandler'
] as const
const LOG_PRODUCERS: readonly string[] = [...SINK_PRODUCERS, ...BOUNDARY_PRODUCERS]

/**
 * A boundary `PRODUCER_BOUNDARIES` names in prose rather than by symbol,
 * paired with the symbols this scan watches for it. Source-visible so a new
 * prose-named boundary cannot be covered by a silent assumption.
 */
const BOUNDARIES_NAMED_IN_PROSE: Record<string, readonly string[]> = {
  'task-tools': ['createTaskCancelHandler', 'createTaskResumeHandler'],
  broker: ['requestEffect', 'authenticateWorkerInvocation', 'authenticateOperatorInvocation']
}

/** A name that table uses for its OWN self-test fixture rather than for a producer — never a boundary this scan could watch. */
const SELF_TEST_BOUNDARY_TOKENS = new Set(['planted'])

/**
 * Every name that reaches a producer inside this file, mapped to the producer
 * it reaches: the producer's own name, an alias it was imported under
 * (`import { log as writeLog }`), and a namespace import's member call
 * (`import * as sink` … `sink.log(…)`). Both aliases scanned clean before
 * (round 4 security review, LOW).
 */
function producerCallNames(code: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const producer of LOG_PRODUCERS) out.set(producer, producer)
  for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const clause of (m[1] as string).split(',')) {
      const parts = clause.split(/\s+as\s+/).map((part) => part.trim())
      const [original, alias] = parts
      if (original && alias && LOG_PRODUCERS.includes(original)) out.set(alias, original)
    }
  }
  for (const m of code.matchAll(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from/g)) {
    const namespace = m[1] as string
    for (const producer of LOG_PRODUCERS) out.set(`${namespace}.${producer}`, producer)
  }
  return out
}

/** Every in-process producer call in `code`: where it is, the name it was called by, and the producer that name reaches. */
function producerCallSites(code: string): { index: number; calledAs: string; producer: string }[] {
  const out: { index: number; calledAs: string; producer: string }[] = []
  for (const [calledAs, producer] of producerCallNames(code)) {
    const escaped = escapeForRegExp(calledAs)
    // A bare name is never a member call (`console.log` is not `log`); a
    // namespace member call is matched with its own dot already in the name.
    const pattern = calledAs.includes('.')
      ? new RegExp(`\\b${escaped}\\s*\\(`, 'g')
      : new RegExp(`(?<!\\.)\\b${escaped}\\s*\\(`, 'g')
    for (const m of code.matchAll(pattern)) {
      if (m.index === undefined) continue
      out.push({ index: m.index, calledAs, producer })
    }
  }
  return out.sort((a, b) => a.index - b.index)
}

/** A `log` dependency the call itself is handed — how a test drives a boundary producer without writing anywhere real. */
function callIsHandedALogDependency(code: string, index: number): boolean {
  const open = code.indexOf('(', index)
  if (open === -1) return false
  return /(?<!\.)\blog\s*:/.test(callArguments(code, open))
}

/**
 * Every way the file runs Vinaya code in this repository's own working
 * directory: a spawn naming no working directory, anything handed this
 * checkout's own root (a `cwd`, a positional argument, or a `chdir`), and
 * every in-process producer call that is neither handed a destination of its
 * own nor made with this process moved out of the repository.
 *
 * Each producer call is judged on its own, in its own scope. Every earlier
 * version of this decided it once per FILE, and every one of those waivers was
 * demonstrated live: a `chdir` in one function excusing a call in another, a
 * sink built in one test case excusing a call outside every case, a bare
 * `outboxRoot:` key — even one written into a config for a CHILD, or in a type
 * annotation — excusing the whole file (round 4 review, MAJOR and MINOR; round
 * 4 security review, MEDIUM twice).
 */
function repositoryWorkingDirectorySites(rel: string, source: ScannedSource): string[] {
  const code = source.codeOnly
  const out = [...unisolatedCallSites(source), ...repositoryRootedRunSites(rel, source)]
  const repoRooted = new Set(repositoryRootedIdentifiers(rel, source))
  for (const site of producerCallSites(code)) {
    if (movedOutOfRepositoryBefore(site.index, code, repoRooted)) continue
    if (calledInsideARelocatingWrapper(code, site.index, repoRooted)) continue
    const isolated = (SINK_PRODUCERS as readonly string[]).includes(site.producer)
      ? site.producer === 'createLogSink'
        ? /createLogSink\s*\(\s*[^)\s]/.test(code.slice(site.index, site.index + 40))
        : usesASinkOfItsOwn(site.calledAs, site.index, code)
      : callIsHandedALogDependency(code, site.index)
    if (isolated) continue
    out.push(`${IN_PROCESS_SITE}: ${site.calledAs}(…`)
  }
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

  it('the producer vocabulary covers every boundary log-callers.test.ts names — that table is the authoritative list', () => {
    const callers = scanSource(readFileSync(join(TESTS_ROOT, 'lib/log-callers.test.ts'), 'utf8')).withStrings
    const boundaries = [...callers.matchAll(/name:\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1] as string)
    expect(boundaries.length).toBeGreaterThanOrEqual(7)
    const uncovered = boundaries.filter((boundary) => {
      const token = /^[A-Za-z_$][\w$-]*/.exec(boundary)?.[0] ?? ''
      if (LOG_PRODUCERS.includes(token) || SELF_TEST_BOUNDARY_TOKENS.has(token)) return false
      const named = BOUNDARIES_NAMED_IN_PROSE[token]
      return !named?.every((symbol) => LOG_PRODUCERS.includes(symbol))
    })
    expect(uncovered).toEqual([])
  })

  // Every case below is a shape this rule exists to reject or to accept, run
  // through the real scan. Each was reported against a version of this file
  // that got it wrong, so each stays as the standing proof of one defect.
  //
  // Their spawns are written as `spawnSyncBudgeted`, which this file's own
  // `SPAWNS_REAL_PROCESS_SOURCE` matches and
  // `process-fixture-coverage.test.ts`'s own pattern does not — the same care
  // that pattern's own comment already takes with its shape. That scanner pairs
  // string delimiters and cannot see through a template literal's
  // interpolations, so an unbudgeted spawn named inside one of these samples
  // read to it as a real, unhardened call site of this file's own — and a name
  // its pattern matches is avoided even in this prose, since a delimiter it
  // mis-pairs can expose a comment to it as code.
  const sitesFor = (sample: string): string[] => repositoryWorkingDirectorySites(GUARD_FILE, scanSource(sample))
  const inProcessSites = (sample: string): string[] =>
    sitesFor(sample).filter((site) => site.startsWith(IN_PROCESS_SITE))
  // Samples that need a quote or a backtick CHARACTER build it rather than
  // writing it, and none of them nests a template inside another: both keep
  // every string delimiter in this file balanced for the OTHER scans that read
  // this same tree, which pair delimiters without understanding a template's
  // interpolations.
  const SINGLE = String.fromCharCode(39)
  const DOUBLE = String.fromCharCode(34)
  const BACKTICK = String.fromCharCode(96)
  const quoted = (text: string): string => `${SINGLE}${text}${SINGLE}`

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

  it('…and so does the URL form of the same walk, and the __dirname one, and one the formatter wrapped across lines', () => {
    const forms = [
      "const repoRoot = fileURLToPath(new URL('../..', import.meta.url))",
      "const repoRoot = resolve(__dirname, '..', '..')",
      "const repoRoot = join(\n        import.meta.dir,\n        '..',\n        '..'\n      )"
    ]
    for (const binding of forms) {
      const sample = `
      ${binding}
      const found = findOutboxFile(join(home, '.vinaya'), '991.ndjson')
      const out = runFixtureScript(scriptPath, repoRoot, env)
    `
      expect(sitesFor(sample), binding).not.toEqual([])
    }
  })

  it('…and so does one threaded through a spread options object, which satisfied the spawn rule by shape alone', () => {
    const sample = `
      const repoRoot = join(import.meta.dir, '..', '..')
      const opts = { cwd: repoRoot }
      const found = findOutboxFile(join(home, '.vinaya'), '991.ndjson')
      const r = spawnSyncBudgeted('bun', [bin, 'dispatch'], { ...opts, env })
    `
    expect(sitesFor(sample)).not.toEqual([])
  })

  it('a log producer called in this process is flagged: the test runner runs in the repository', () => {
    const sample = `
      import { log } from '../src/lib/log-sink.js'
      ${AN_IN_PROCESS_PRODUCER}
      ${A_DEFAULT_READ}
    `
    expect(inProcessSites(sample)).toHaveLength(1)
  })

  it('…and so is one reached through an import alias, or through a namespace import', () => {
    const aliased = `
      import { log as writeLog } from '../src/lib/log-sink.js'
      await writeLog({ operation: 'task_start' })
      ${A_DEFAULT_READ}
    `
    expect(inProcessSites(aliased)).toHaveLength(1)
    const namespaced = `
      import * as sink from '../src/lib/log-sink.js'
      await sink.log({ operation: 'task_start' })
      ${A_DEFAULT_READ}
    `
    expect(inProcessSites(namespaced)).toHaveLength(1)
  })

  it('…and so is a boundary producer driven with no log dependency of the caller’s own', () => {
    const sample = `
      import { devReviewLoop } from '../src/lib/dev-review-loop.js'
      await devReviewLoop(input, { fetchPrBody: () => 'x' })
      ${A_DEFAULT_READ}
    `
    expect(inProcessSites(sample)).toHaveLength(1)
  })

  it('a boundary producer handed a log dependency is accepted — that is how a test drives one writing nowhere real', () => {
    const sample = `
      import { createTaskCancelHandler } from '../src/lib/task-tools/cancel.js'
      const handler = createTaskCancelHandler({ runtimeDir: () => outbox, log: (e) => { seen.push(e) } })
      ${A_DEFAULT_READ}
    `
    expect(inProcessSites(sample)).toEqual([])
  })

  it('…and still flagged when the same file also spawns a properly isolated child, which used to excuse it wholesale', () => {
    const sample = `
      import { log } from '../src/lib/log-sink.js'
      const fixture = isolatedConfigFixture('x-')
      const out = runFixtureScript(scriptPath, fixture.cwd, fixture.env)
      ${AN_IN_PROCESS_PRODUCER}
      ${A_DEFAULT_READ}
    `
    expect(inProcessSites(sample)).toHaveLength(1)
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
    expect(sites.filter((site) => site.startsWith(IN_PROCESS_SITE))).toHaveLength(1)
    expect(sites.some((site) => site.includes('chdir'))).toBe(true)
  })

  it('a chdir BACK into a captured directory is the restore idiom, not a move out', () => {
    const sample = `
      import { log } from '../src/lib/log-sink.js'
      const original = process.cwd()
      afterEach(() => {
        process.chdir(original)
      })
      ${AN_IN_PROCESS_PRODUCER}
      ${A_DEFAULT_READ}
    `
    expect(inProcessSites(sample)).toHaveLength(1)
  })

  it('a chdir in one function excuses nothing in another — every call is judged where it sits', () => {
    const sample = `
      import { log } from '../src/lib/log-sink.js'
      function inItsOwnWorld() {
        process.chdir(world.repoRoot)
      }
      export async function leaked() {
        ${AN_IN_PROCESS_PRODUCER}
      }
      ${A_DEFAULT_READ}
    `
    expect(inProcessSites(sample)).toHaveLength(1)
  })

  it('a chdir out of the repository before the call, in a block that encloses it, does excuse it', () => {
    const sample = `
      import { log } from '../src/lib/log-sink.js'
      async function run() {
        process.chdir(world.repoRoot)
        ${AN_IN_PROCESS_PRODUCER}
      }
      ${A_DEFAULT_READ}
    `
    expect(inProcessSites(sample)).toEqual([])
  })

  it('…and so does a wrapper this file defines whose own body moves the process, one hop away', () => {
    const sample = `
      import { log } from '../src/lib/log-sink.js'
      export async function withWorldEnv(world, fn) {
        process.chdir(world.repoRoot)
        try {
          return await fn()
        } finally {
          process.chdir(savedCwd)
        }
      }
      const result = withWorldEnv(world, () => log({ operation: 'task_start' }))
      ${A_DEFAULT_READ}
    `
    expect(inProcessSites(sample)).toEqual([])
  })

  it('a sink built from deps of its own excuses the calls in its own scope — and nothing outside them', () => {
    const inScope = `
      import { createLogSink } from '../src/lib/log-sink.js'
      it('writes where it was told', () => {
        const { log } = createLogSink({ outboxRoot: () => join(dir, 'queue'), home: () => dir })
        log(DISPATCHED)
      })
      ${A_DEFAULT_READ}
    `
    expect(inProcessSites(inScope)).toEqual([])
    const leakedOutside = `
      import { createLogSink, log } from '../src/lib/log-sink.js'
      it('writes where it was told', () => {
        const { log: ownLog } = createLogSink({ outboxRoot: () => join(dir, 'queue') })
        ownLog(DISPATCHED)
      })
      export async function leakedProducerCall() {
        ${AN_IN_PROCESS_PRODUCER}
      }
      ${A_DEFAULT_READ}
    `
    expect(inProcessSites(leakedOutside)).toHaveLength(1)
  })

  it('a bare outboxRoot key excuses nothing — not one written for a child, not one in a type', () => {
    for (const token of [
      "writeFileSync(cfgPath, JSON.stringify({ outboxRoot: join(tmp, 'child') }))",
      'type Deps = { outboxRoot: () => string }',
      'const childConfig = { resolveLogDestination: () => ({ kind: 0 }) }'
    ]) {
      const sample = `
        import { log } from '../src/lib/log-sink.js'
        ${token}
        ${AN_IN_PROCESS_PRODUCER}
        ${A_DEFAULT_READ}
      `
      expect(inProcessSites(sample), token).toHaveLength(1)
    }
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
      expect(inProcessSites(sample), token).toHaveLength(1)
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
      expect(inProcessSites(sample), declaration).toHaveLength(1)
    }
  })

  it('a producer call inside a fixture SCRIPT belongs to the child that runs it, not to this file', () => {
    const sample = [
      `const fixture = isolatedConfigFixture(${quoted('x-')})`,
      `const script = ${BACKTICK}`,
      `import { log } from ${quoted('../../src/lib/log-sink.js')}`,
      `await log({ operation: ${quoted('task_start')} })`,
      BACKTICK,
      'const out = runFixtureScript(scriptPath, fixture.cwd, fixture.env)',
      A_DEFAULT_READ
    ].join('\n')
    expect(readsDefaultDestination(scanSource(sample))).toBe(true)
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
    const scheme = `ht${'tp'}s:${'//'}example.com/x`
    const sample = [
      `const endpoint = ${quoted(scheme)}; spawnSyncBudgeted('bun', [bin], { env: process.env })`,
      A_DEFAULT_READ
    ].join('\n')
    const sites = sitesFor(sample)
    expect(sites).toHaveLength(1)
    expect(sites[0]).toContain('spawnSyncBudgeted')
  })

  it('a block-comment opener inside a string blanks nothing after it either', () => {
    const opener = `${'/'}${'*'}`
    const sample = [
      `const pattern = ${quoted(`${opener} not a comment`)}; spawnSyncBudgeted('bun', [bin], { env: process.env })`,
      A_DEFAULT_READ
    ].join('\n')
    expect(sitesFor(sample)).toHaveLength(1)
  })

  it('a regex in keyword position is a regex, not a division — a quote inside it blanks nothing', () => {
    const sample = [
      `  return /(?:^|\\})\\s*from\\s*[${SINGLE}${DOUBLE}]/.test(line); spawnSyncBudgeted('bun', [bin], { env })`,
      A_DEFAULT_READ
    ].join('\n')
    expect(sitesFor(sample)).toHaveLength(1)
  })

  it('…held against the real file that carried one: its own line survives the scan intact', () => {
    const raw = readFileSync(join(TESTS_ROOT, 'run-paths-only.test.ts'), 'utf8')
    const lines = raw.split('\n')
    const line = lines.findIndex((text) => text.trimStart().startsWith('return /') && text.includes('.test(line)'))
    expect(line).toBeGreaterThan(0)
    expect(scanSource(raw).codeOnly.split('\n')[line]).toBe(lines[line] as string)
  })

  it('a real comment still blanks — a doc comment naming a spawn is not a spawn', () => {
    const sample = [
      `// spawnSyncBudgeted('bun', [bin], { env })`,
      '/* and process.chdir(repoRoot) named in prose */',
      A_DEFAULT_READ
    ].join('\n')
    expect(sitesFor(sample)).toEqual([])
  })

  it("one file's scan never moves another's starting point — the matcher carries no state between them", () => {
    const offending = scanSource(`
      spawnSyncBudgeted('bun', [bin], { env })
      ${A_DEFAULT_READ}
    `)
    const alone = unisolatedCallSites(offending)
    expect(alone).toHaveLength(1)
    // A longer, compliant file scanned first: a shared global matcher would
    // leave its own lastIndex past this sample's only call site.
    unisolatedCallSites(scanSource(`${' '.repeat(2000)}\nspawnSyncBudgeted('bun', [bin], { cwd: dir, env })\n`))
    expect(unisolatedCallSites(offending)).toEqual(alone)
  })
})
