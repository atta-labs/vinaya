#!/usr/bin/env node
/**
 * The `test-selection` command: the tests a change between two commits
 * requires, printed as one JSON document and grouped by the runner start that
 * serves them. It is the one place in the package that builds a git reader
 * itself; it starts no test and writes no file.
 *
 * Usage: `test-selection --base <commit> --head <commit> [--record <file>] [--config <file>]`.
 * It reads no file but the two the optional flags name.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { type ConsumerConfig, ConsumerConfigError, parseConsumerConfig, withDeclaredInputs } from './consumer-config.js'
import { groupNativeTests } from './native.js'
import { isReadRecord, type ReadRecord } from './recorded-reads.js'
import { gitRepository, plannedTests, selectTests } from './selector.js'
import { workspaceInventory } from './workspace-inventory.js'

const USAGE = 'usage: test-selection --base <commit> --head <commit> [--record <file>] [--config <file>]'

class CommandError extends Error {}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

type Arguments = { base: string; head: string; record: string | null; config: string | null }

function argumentsOf(argv: readonly string[]): Arguments {
  let values: { base?: string; head?: string; record?: string; config?: string }
  try {
    values = parseArgs({
      args: [...argv],
      options: {
        base: { type: 'string' },
        head: { type: 'string' },
        record: { type: 'string' },
        config: { type: 'string' }
      },
      strict: true,
      allowPositionals: false
    }).values
  } catch (error) {
    throw new CommandError(`${(error as Error).message}; ${USAGE}`)
  }
  if (!values.base) throw new CommandError(`--base is missing; ${USAGE}`)
  if (!values.head) throw new CommandError(`--head is missing; ${USAGE}`)
  if (values.record === '') throw new CommandError(`--record names no file; ${USAGE}`)
  if (values.config === '') throw new CommandError(`--config names no file; ${USAGE}`)
  return { base: values.base, head: values.head, record: values.record ?? null, config: values.config ?? null }
}

/** The parsed JSON document of a file a flag names, or a usage error naming the flag. */
function jsonFile(flag: string, file: string): unknown {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    throw new CommandError(`${flag} ${file} cannot be read: ${(error as NodeJS.ErrnoException).code ?? 'unreadable'}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new CommandError(`${flag} ${file} is not a JSON document`)
  }
}

/** The read record `--record` names, validated with the package's record validator. */
function recordOf(file: string): ReadRecord {
  const value = jsonFile('--record', file)
  if (!isReadRecord(value)) throw new CommandError(`--record ${file} is not a read record`)
  return value
}

/** The consumer config `--config` names; absent, a transitive walk with nothing declared. */
function configOf(file: string | null): ConsumerConfig {
  if (file === null) return { policy: { depth: 'transitive' }, inputs: [] }
  try {
    return parseConsumerConfig(jsonFile('--config', file))
  } catch (error) {
    if (error instanceof ConsumerConfigError) throw new CommandError(`--config ${file}: ${error.message}`)
    throw error
  }
}

/** The plan document for the repository around `cwd`. */
function planDocument(cwd: string, argv: readonly string[]): unknown {
  const args = argumentsOf(argv)
  const record = args.record === null ? null : recordOf(args.record)
  const config = configOf(args.config)
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
    inventory: {
      base: withDeclaredInputs(baseInventory.view, config.inputs),
      head: withDeclaredInputs(headInventory.view, config.inputs)
    },
    policy: config.policy,
    ...(record ? { records: { record, platform: process.platform } } : {})
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
