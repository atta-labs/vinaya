import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { cliPackageRoot } from '../../../../apps/cli/src/lib/package-root.js'
import { ensureGhOnPath } from '../../../kernel/adapters/code-host/github/gh-path.js'
import { installVinayaCheckRegistry } from '../checks/registry.js'
import { installVinayaConfigProvider } from '../integration/config/compose.js'
import { installVinayaLogSinkFactory } from '../integration/log/log-sink-factory.js'
import { PROGRAMS } from './programs.js'
import { resolveAuthorRepoSourceEntry } from './self-host.js'

/**
 * Inside the author repository the tree is the program: a built program run
 * from an installed package re-executes its own source file under `bun`, with
 * the same argv/env/stdio, so the checkout's own code runs — the same
 * hand-off the command line's entry makes for itself. `resolveAuthorRepoSourceEntry`
 * carries the detection; this function carries the escape hatch, the CI guard,
 * the `bun` PATH check, the one stderr line, and the re-exec itself.
 */
function maybeDeferToAuthorRepoSource(source: string): void {
  if (process.env.VINAYA_NO_DEFER === '1') return
  if (process.env.GITHUB_ACTIONS) return

  const cliSourceEntry = resolveAuthorRepoSourceEntry(cliPackageRoot())
  if (!cliSourceEntry) return
  // The command line's source entry sits at `<toplevel>/apps/cli/src/index.ts`.
  const sourceEntry = join(resolve(cliSourceEntry, '..', '..', '..', '..'), source)

  const bunCheck = spawnSync('bun', ['--version'], { stdio: 'ignore' })
  if (bunCheck.error || bunCheck.status !== 0) {
    process.stderr.write(
      `vinaya: author repo detected, but 'bun' is not on PATH — running the installed build instead of ${sourceEntry}\n`
    )
    return
  }

  process.stderr.write(`vinaya: deferring to source at ${sourceEntry}\n`)
  const result = spawnSync('bun', [sourceEntry, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env
  })
  // A signal-terminated child reports `status: null` with `signal` set; re-raising the
  // same signal on this process is the closest a re-exec can get to reproducing it.
  if (result.signal) {
    process.kill(process.pid, result.signal)
    return
  }
  process.exit(result.status ?? 1)
}

/**
 * Starts the program `name` the way the command line's entry starts a command,
 * in the same order: installs the Log sink factory, makes `gh` reachable,
 * installs the configuration provider and the check list, hands off to the
 * program's own source file when a built program runs inside the author
 * repository, then runs `run` with `process.argv.slice(2)`; an error it throws
 * prints `Error: <message>` and exits 1.
 */
export async function runProgram(name: string, run: (argv: string[]) => unknown): Promise<void> {
  const entry = PROGRAMS.get(name)
  if (!entry) throw new Error(`no program named '${name}'`)

  // The Log client builds its default sink from an installed factory, never on its own.
  installVinayaLogSinkFactory()
  // Before the program runs, and before the author-repo re-exec (which passes `env: process.env`
  // to its child), make `gh` reachable when the launching PATH lacked its install folder.
  ensureGhOnPath()
  // The composition root: kernel code reads configuration through the provider this installs.
  installVinayaConfigProvider()
  installVinayaCheckRegistry()

  maybeDeferToAuthorRepoSource(entry.source)

  try {
    await run(process.argv.slice(2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Error: ${message}`)
    process.exit(1)
  }
}
