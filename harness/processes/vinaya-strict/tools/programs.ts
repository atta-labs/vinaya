import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cliPackageRoot } from '../../../../apps/cli/src/lib/package-root.js'

/**
 * The process's programs: every plumbing step a hook, a workflow, the review
 * loop or an agent's sandbox runs is a program of its own, never a command of
 * the command line. Each is named here once — its internal `bin`, its source
 * file (repository-relative) and the file the command line's build emits for it
 * (relative to the command line's package root). The command line's manifest
 * `bin` map is `vinaya` plus exactly these `bin` names, and neither `vinaya
 * help` nor the command catalog lists them.
 *
 * `commands` maps the command words a program replaced to the argument words
 * it starts with, so a caller that still builds the old command words (a
 * recovery line, a relaunch) can reach the program through `programForWords`.
 */
export type Program = {
  /** The internal `bin`, always `vinaya-<name>`. */
  bin: string
  /** Repository-relative source file, run as `bun <source>` inside this repository. */
  source: string
  /** Built file, relative to the command line's package root. */
  built: string
  /** Leading command words this program stands for, and the arguments it is given in their place. */
  commands: readonly { words: readonly string[]; argv: readonly string[] }[]
}

const P = 'harness/processes/vinaya-strict'
const K = 'harness/kernel'

const program = (
  name: string,
  source: string,
  built: string,
  commands: readonly { words: readonly string[]; argv: readonly string[] }[] = []
): [string, Program] => [name, { bin: `vinaya-${name}`, source, built, commands }]

const words = (...w: string[]) => ({ words: w, argv: [] as string[] })

export const PROGRAMS: ReadonlyMap<string, Program> = new Map([
  // The pre-push hook's helpers.
  program('select-tests', `${P}/integration/pre-push-select-tests.ts`, 'dist/lib/pre-push-select-tests.js'),
  program(
    'changed-files',
    `${K}/gates/ring0-hooks/pre-push/pre-push-changed-files.ts`,
    'dist/lib/pre-push-changed-files.js'
  ),
  program('cache-test-run', `${P}/tools/pr-report/pre-push-cache-test-run.ts`, 'dist/lib/pre-push-cache-test-run.js'),
  program(
    'record-tests',
    `${K}/gates/ring0-hooks/pre-push/pre-push-record-tests.ts`,
    'dist/lib/pre-push-record-tests.js'
  ),
  program('push-mode', `${K}/gates/ring0-hooks/pre-push/pre-push-mode.ts`, 'dist/lib/pre-push-mode.js'),
  program('push-progress', `${P}/integration/pre-push-progress-dir.ts`, 'dist/lib/pre-push-progress-dir.js'),
  program('push-progress-observer', `${P}/integration/push-progress-observer.ts`, 'dist/lib/push-progress-observer.js'),
  // The agent sandbox's tool bridge and the ring-2 audit.
  program('dev-bridge', `${K}/tools/host/dev-tools-bridge.ts`, 'dist/kernel/tools/host/dev-tools-bridge.js', [
    words('task-tools', 'dev-bridge')
  ]),
  program('audit', `${P}/gates/ring2-audits/audit.ts`, 'dist/programs/audit.js', [words('audit')]),
  // The plumbing commands the command line used to route.
  program('check', `${P}/checks/check.ts`, 'dist/programs/check.js', [words('check')]),
  program('commit-msg', `${P}/gates/bin/commit-msg.ts`, 'dist/programs/commit-msg.js', [words('commit-msg')]),
  program('waiver', `${P}/gates/bin/waiver.ts`, 'dist/programs/waiver.js', [words('waiver')]),
  program('archive', `${P}/retrospecting/bin/archive.ts`, 'dist/programs/archive.js', [
    words('archive'),
    { words: ['archive', 'tranche'], argv: ['tranche'] },
    { words: ['archive', 'tranches'], argv: ['tranches'] }
  ]),
  program('pr', `${P}/tools/pull-request/bin/pr.ts`, 'dist/programs/pr.js', [
    { words: ['pr', 'create'], argv: ['create'] },
    { words: ['pr', 'edit'], argv: ['edit'] }
  ]),
  program('pr-report', `${P}/tools/pr-report/bin/pr-report.ts`, 'dist/programs/pr-report.js', [words('pr', 'report')]),
  program(
    'pr-verify-evidence',
    `${P}/tools/pr-report/bin/pr-verify-evidence.ts`,
    'dist/programs/pr-verify-evidence.js',
    [words('pr', 'verify-evidence')]
  ),
  program('pr-snapshot', `${P}/tools/pull-request/bin/pr-snapshot.ts`, 'dist/programs/pr-snapshot.js', [
    words('pr', 'snapshot')
  ]),
  program('tokens', `${P}/tools/pr-report/tokens/bin/tokens.ts`, 'dist/programs/tokens.js', [words('tokens')]),
  program('review-post', `${P}/loops/dev-review/bin/review-post.ts`, 'dist/programs/review-post.js', [
    words('review', 'post')
  ]),
  program('review-status', `${P}/loops/dev-review/bin/review-status.ts`, 'dist/programs/review-status.js', [
    words('review', 'status')
  ]),
  program('dispatch', `${P}/loops/dev-review/dispatch/bin/dispatch.ts`, 'dist/programs/dispatch.js', [
    words('dispatch')
  ]),
  program(
    'dev-review-loop',
    `${P}/loops/dev-review/standalone/bin/dev-review-loop.ts`,
    'dist/programs/dev-review-loop.js',
    [words('dev-review-loop')]
  ),
  program('task-brief', `${P}/tools/task-contract/bin/task-brief.ts`, 'dist/programs/task-brief.js', [
    words('task', 'brief')
  ]),
  program('task-sweep', `${P}/loops/dev-review/run-control/bin/task-sweep.ts`, 'dist/programs/task-sweep.js', [
    words('task', 'sweep')
  ]),
  program('task-tools-serve', `${P}/integration/bin/task-tools-serve.ts`, 'dist/programs/task-tools-serve.js', [
    words('task-tools', 'serve')
  ]),
  program('log-send', `${P}/integration/bin/log-send.ts`, 'dist/programs/log-send.js', [words('log', 'send')]),
  program('log-emit', `${P}/integration/bin/log-emit.ts`, 'dist/programs/log-emit.js', [words('log', 'emit')]),
  program('log-selftest', `${P}/integration/bin/log-selftest.ts`, 'dist/programs/log-selftest.js', [
    words('log', 'selftest')
  ]),
  program('sync', `${P}/integration/bin/sync.ts`, 'dist/programs/sync.js', [words('sync')])
])

/** The repository root, found from this file's own place in the source tree. */
const SOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

function lookup(name: string): Program {
  const found = PROGRAMS.get(name)
  if (!found)
    throw new Error(`no program named '${name}' — the program table names: ${[...PROGRAMS.keys()].join(', ')}`)
  return found
}

/**
 * The file that runs `name`: from a built install (this module is part of a
 * bundle), the built file under the command line's package root; from source,
 * the program's source file in this tree when it is there — so a source
 * checkout never runs a stale build of its own code — else the built file.
 */
export function programFile(name: string): string {
  const entry = lookup(name)
  const built = join(cliPackageRoot(), entry.built)
  const source = join(SOURCE_ROOT, entry.source)
  if (FROM_SOURCE && existsSync(source)) return source
  return existsSync(built) ? built : source
}

/** Whether this module runs from its own source file rather than from a bundle. */
const FROM_SOURCE = fileURLToPath(import.meta.url).endsWith('.ts')

/** How to start `name` with `args`: this runtime, the program's file, then the arguments. */
export function programInvocation(name: string, args: readonly string[] = []): { command: string; argv: string[] } {
  return { command: process.execPath, argv: [programFile(name), ...args] }
}

/**
 * The program a command's leading words stand for, and the arguments it is
 * given: `['check', '--all']` → `check` with `['--all']`, `['pr', 'create', '--x']`
 * → `pr` with `['create', '--x']`. `null` for words no program replaced (a
 * command the command line still dispatches).
 */
export function programForWords(commandWords: readonly string[]): { name: string; args: string[] } | null {
  let best: { name: string; args: string[]; length: number } | null = null
  for (const [name, entry] of PROGRAMS) {
    for (const { words: w, argv } of entry.commands) {
      if (w.length > commandWords.length || !w.every((word, i) => commandWords[i] === word)) continue
      if (best !== null && best.length >= w.length) continue
      best = { name, args: [...argv, ...commandWords.slice(w.length)], length: w.length }
    }
  }
  return best === null ? null : { name: best.name, args: best.args }
}

/**
 * The program file and arguments a command's words run as — `['check', '--all']` → `[<check file>, '--all']` —
 * or `null` for words no program replaced. Spawned under the caller's own runtime.
 */
export function programCommandLine(commandWords: readonly string[]): string[] | null {
  const program = programForWords(commandWords)
  return program === null ? null : [programFile(program.name), ...program.args]
}

/** The program whose `bin` is `bin`, or `null`. */
export function programForBin(bin: string): string | null {
  for (const [name, entry] of PROGRAMS) if (entry.bin === bin) return name
  return null
}

/**
 * The push-progress observer's entrypoint for the command line installed at `root`: a source checkout (its
 * package root two folders under the repository root) runs the observer's source, as its self-hosted hook does;
 * a published install, which ships no source, runs the built helper the build emits.
 */
export function progressObserverEntry(root: string = cliPackageRoot()): { command: string; args: string[] } {
  const entry = lookup('push-progress-observer')
  const source = join(root, '..', '..', entry.source)
  if (existsSync(source)) return { command: 'bun', args: [source] }
  return { command: 'node', args: [join(root, entry.built)] }
}

/** The source file of `name` under the repository at `root` — a runner that starts another checkout's programs. */
export function programSourceIn(root: string, name: string): string {
  return join(root, lookup(name).source)
}
