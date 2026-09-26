/**
 * A test that spawns a Vinaya command and then reads the DEFAULT log
 * destination — `<runtimeDir>/logs/<repo>/<task>.ndjson` under its own
 * temporary `$HOME` — is asserting against a folder the repository's own
 * `vinaya.config.json` can empty out from under it. `config.ts`'s
 * `findLocalConfig()` walks up from the CHILD's working directory, so a
 * child spawned with this repository's own `cwd` reads this repository's
 * `logs` setting: declare a `logs.url` there and the child delivers every
 * event to that server and writes no file at all, so the fixture fails for
 * a reason that has nothing to do with what it tests. That is not
 * hypothetical — it is how two `checks/runner/cancelled.test.ts` cases
 * passed pre-push and failed CI the day a `logs.url` first landed on the
 * default branch.
 *
 * The fix in each such fixture is one line: spawn with a working directory
 * of its own (a scratch directory, or `isolatedConfigFixture`'s, whose own
 * empty `vinaya.config.json` is where the walk stops). This file is the
 * mechanical backstop for it, in the shape `process-fixture-coverage.test.ts`
 * already established for the environment/kill-budget halves: walk the real
 * tree, find every file that reads a default log destination, and require
 * each real-process call site in it to name a working directory — or to be
 * listed, by path, on `GRANDFATHERED_FILES`.
 *
 * The list is data, not a waiver: a new non-compliant file fails the build,
 * and so does a listed file that has since been fixed, so the list can
 * neither grow silently nor go stale. It is empty — every fixture that
 * reads a default log destination today isolates its own configuration.
 */

import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TESTS_ROOT = join(fileURLToPath(new URL('.', import.meta.url)))
/** The shared fixture helper itself: it DEFINES the isolation (and the budgeted spawn wrappers), so it is never one of its own subjects. */
const HELPER_FILE = 'lib/process-fixture.ts'

/** Files whose own call sites do not yet name a working directory. Empty — see this file's own header. */
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
 * Reads the default log destination: a path built from a `runtime` segment
 * and the `logs` folder inside it, a `runtimeDir` joined to `'logs'`, or
 * `isolatedConfigFixture`'s own `logsDir`. A fixture that names its OWN
 * `logs.folder` (`log-sink-no-sync-spawn.test.ts`) is not one of these — it
 * already declares the destination it reads.
 */
const READS_DEFAULT_DESTINATION = /['"]runtime['"][\s\S]{0,80}?['"]logs['"]|runtimeDir\s*,\s*['"]logs['"]|\.logsDir\b/

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

/** Every file under `apps/cli/tests` that reads a default log destination, paired with its own unisolated call sites. */
function subjects(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const [rel, abs] of walk(TESTS_ROOT, '')) {
    if (rel === HELPER_FILE) continue
    const code = stripComments(readFileSync(abs, 'utf8'))
    if (!READS_DEFAULT_DESTINATION.test(code)) continue
    out.set(rel, unisolatedCallSites(code))
  }
  return out
}

describe("no test reads this repository's own log destination", () => {
  it('every fixture that reads a default log destination spawns with a working directory of its own', () => {
    const offenders = [...subjects()]
      .filter(([rel, sites]) => sites.length > 0 && !GRANDFATHERED_FILES.includes(rel))
      .map(([rel, sites]) => `${rel}\n    ${sites.join('\n    ')}`)
    expect(offenders).toEqual([])
  })

  it('every grandfathered path is still a real, still-unisolated file — a stale entry fails as loudly as a missing one', () => {
    const found = subjects()
    const stale = GRANDFATHERED_FILES.filter((rel) => (found.get(rel) ?? []).length === 0)
    expect(stale).toEqual([])
  })

  it('the scan finds the fixtures it is meant to cover — an empty subject set would make it vacuous', () => {
    expect(subjects().size).toBeGreaterThanOrEqual(5)
  })
})
