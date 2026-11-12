#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { printJson } from '../../../harness/kernel/effects/envelope.js'
import { ensureGhOnPath } from '../../../harness/kernel/adapters/code-host/github/gh-path.js'
import {
  installServices,
  registerOperationRecord
} from '../../../harness/processes/vinaya-strict/integration/cli-services.js'
import { printHelp } from './lib/output.js'
import { packageRoot } from './lib/package-root.js'
import { resolveAuthorRepoSourceEntry } from '../../../harness/processes/vinaya-strict/tools/self-host.js'

// Each command's module loads only when that command runs, so a run, and a test that runs one command, reads
// no other command's code.
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Inside the author repository the tree is the CLI: an installed `vinaya`
 * re-executes `<toplevel>/apps/cli/src/index.ts` under `bun`, with the same
 * argv/env/stdio, so the checkout's own doctrine and its own CLI are governed
 * by the same tree (mirrors `resolveDoctrineRoot()`'s tree-first resolution).
 * `resolveAuthorRepoSourceEntry` carries the detection
 * (including the self-guard against a re-executed process deferring to
 * itself); this function carries only the process concerns the detection
 * can't be unit-tested through: the escape hatch, the CI guard, the `bun`
 * PATH check, the one stderr line, and the re-exec itself.
 */
function maybeDeferToAuthorRepoSource(): void {
  if (process.env.VINAYA_NO_DEFER === '1') return
  if (process.env.GITHUB_ACTIONS) return

  const sourceEntry = resolveAuthorRepoSourceEntry(packageRoot(import.meta.url))
  if (!sourceEntry) return

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
  // A signal-terminated child reports `status: null` with `signal` set —
  // collapsing that to a fixed exit code would be a different exit than the
  // child actually had (a code-review finding). Re-raising the same
  // signal on this process is the closest a re-exec can get to reproducing
  // it without a real `execve`.
  if (result.signal) {
    process.kill(process.pid, result.signal)
    return
  }
  process.exit(result.status ?? 1)
}

// Before ANY command runs, and before the author-repo re-exec below (which
// passes `env: process.env` to its child), make `gh` reachable when the
// launching PATH lacked its install folder — so every `gh`-by-name call site,
// in this process and in every child it spawns, resolves it.
ensureGhOnPath()

maybeDeferToAuthorRepoSource()

function readVersion(): string {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8'))
  return pkg.version
}

const [, , command, ...args] = process.argv

// A taskless invocation's event lands in its own folder file, never the shared
// `none.ndjson`, so a test run's real-runtime guard can exempt it alone. The Log client loads here, once, and only
// when the process has a Log destination: a synchronous exit handler cannot await an import.
registerOperationRecord(command === undefined ? [] : [command, ...args])

if (!command || command === 'help' || command === '--help' || command === '-h') {
  printHelp()
  process.exit(0)
}

// Retired role operations remain explicit refusals, never advertised commands.
const roleTools: Record<string, string> = {
  issue: 'task_issue_create, task_issue_edit, task_issue_surface, task_objectives_edit, task_issue_validate',
  brief: 'brief_render',
  milestone: 'milestone_create, milestone_edit, milestone_adopt, milestone_close, milestone_status'
}
if (Object.hasOwn(roleTools, command)) {
  console.error(`vinaya ${command} is a role tool now; use ${roleTools[command]}.`)
  process.exit(2)
}

if (command !== 'version') installServices()

try {
  switch (command) {
    case 'version': {
      const version = readVersion()
      if (args.includes('--json')) {
        printJson({ version })
      } else {
        process.stdout.write(`${version}\n`)
      }
      break
    }
    case 'init': {
      const [subcommand, ...rest] = args
      if (subcommand === 'product') {
        await (await import('./commands/init.js')).initProductCommand(rest)
      } else {
        await (await import('./commands/init.js')).initCommand(args)
      }
      break
    }
    case 'eject': {
      await (await import('./commands/eject.js')).ejectCommand(args)
      break
    }
    case 'doctor': {
      await (await import('./commands/doctor.js')).doctorCommand(args)
      break
    }
    case 'doctrine': {
      await (await import('./commands/doctrine.js')).doctrineCommand(args)
      break
    }
    case 'upgrade': {
      await (await import('./commands/upgrade.js')).upgradeCommand(args)
      break
    }
    case 'new': {
      const [subcommand, ...rest] = args
      if (subcommand === 'check') {
        ;(await import('./commands/new-check.js')).newCheckCommand(rest)
      } else if (subcommand === 'noop-check') {
        ;(await import('./commands/new-noop-check.js')).newNoopCheckCommand(rest)
      } else if (subcommand === 'role') {
        ;(await import('./commands/new-role.js')).newRoleCommand(rest)
      } else {
        console.error(`Unknown 'new' subcommand: ${subcommand ?? '(none)'} (expected 'check', 'noop-check', or 'role')`)
        process.exit(2)
      }
      break
    }
    case 'pr': {
      const [subcommand, ...rest] = args
      if (subcommand === 'rule') {
        ;(await import('./commands/pr-rule.js')).prRuleCommand(rest)
      } else {
        console.error(`Unknown 'pr' subcommand: ${subcommand ?? '(none)'} (expected 'rule')`)
        process.exit(2)
      }
      break
    }
    case 'task': {
      const [subcommand, ...rest] = args
      if (subcommand === 'run') {
        await (await import('./commands/task-run.js')).taskRunCommand(rest)
      } else if (subcommand === 'switch') {
        await (await import('./commands/task-switch.js')).taskSwitchCommand(rest)
      } else if (subcommand === 'status') {
        await (await import('./commands/task-status.js')).taskStatusCommand(rest)
      } else {
        console.error(`Unknown 'task' subcommand: ${subcommand ?? '(none)'} (expected 'run', 'switch', or 'status')`)
        process.exit(2)
      }
      break
    }
    case 'quickstart': {
      await (await import('./commands/quickstart.js')).quickstartCommand(args)
      break
    }
    case 'studio': {
      await (await import('./commands/studio.js')).studioCommand(args)
      break
    }
    default:
      console.error(`Unknown command: ${command}`)
      printHelp()
      process.exit(2)
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Error: ${message}`)
  process.exit(1)
}
