#!/usr/bin/env node
/**
 * The `test-selection` command: the tests a change between two commits
 * requires, printed as one JSON document and grouped by the runner start that
 * serves them. It is the one place in the package that builds a git reader
 * itself; it starts no test and writes no file.
 *
 * Usage: `test-selection --base <commit> --head <commit>`.
 */
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { groupNativeTests } from './native.js'
import { gitRepository, plannedTests, selectTests } from './selector.js'
import { workspaceInventory } from './workspace-inventory.js'

const USAGE = 'usage: test-selection --base <commit> --head <commit>'

class CommandError extends Error {}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

function argumentsOf(argv: readonly string[]): { base: string; head: string } {
  let values: { base?: string; head?: string }
  try {
    values = parseArgs({
      args: [...argv],
      options: { base: { type: 'string' }, head: { type: 'string' } },
      strict: true,
      allowPositionals: false
    }).values
  } catch (error) {
    throw new CommandError(`${(error as Error).message}; ${USAGE}`)
  }
  if (!values.base) throw new CommandError(`--base is missing; ${USAGE}`)
  if (!values.head) throw new CommandError(`--head is missing; ${USAGE}`)
  return { base: values.base, head: values.head }
}

/** The plan document for the repository around `cwd`. */
function planDocument(cwd: string, argv: readonly string[]): unknown {
  const args = argumentsOf(argv)
  const root = git(cwd, ['rev-parse', '--show-toplevel'])
  if (!root) throw new CommandError(`${cwd} is not inside a git repository`)
  const commit = (revision: string): string => {
    if (revision.startsWith('-')) throw new CommandError(`${revision} does not name a commit`)
    const id = git(root, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`])
    if (!id) throw new CommandError(`${revision} does not name a commit in ${root}`)
    return id
  }
  const base = commit(args.base)
  const head = commit(args.head)

  const repo = gitRepository(root)
  const headInventory = workspaceInventory(repo, head)
  const baseInventory = workspaceInventory(repo, base)
  const plan = selectTests({
    repo,
    base,
    head,
    inventory: { base: baseInventory.view, head: headInventory.view },
    policy: { depth: 'transitive' }
  })

  const removed = new Set(plan.removedTests)
  const tests = plannedTests(plan).filter((test) => !removed.has(test))
  const identities = new Map(headInventory.view.tests.map((t) => [t.id, t]))
  const grouping = groupNativeTests({
    tests: tests.flatMap((test) => {
      const identity = identities.get(test)
      return identity ? [identity] : []
    }),
    universe: headInventory.view.tests
  })
  return {
    schema: 'test-selection-command',
    schemaVersion: 1,
    base,
    head,
    tests,
    groups: grouping.groups.map((group) => ({
      id: group.id,
      runner: group.runner,
      cwd: group.cwd,
      args: group.args,
      exclude: group.exclude,
      tests: group.tests
    })),
    ungrouped: tests.filter((test) => !identities.has(test)),
    problems: grouping.problems,
    fallbacks: plan.fallbacks,
    leftOut: headInventory.leftOut
  }
}

function main(): number {
  try {
    process.stdout.write(`${JSON.stringify(planDocument(process.cwd(), process.argv.slice(2)), null, 2)}\n`)
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`test-selection: ${message.split('\n')[0]}\n`)
    return error instanceof CommandError ? 2 : 1
  }
}

process.exitCode = main()
