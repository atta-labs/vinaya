import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMMANDS } from '../../commands.js'
import {
  CLI_OPERATION,
  cliOperationRecord,
  cliOperationResult,
  cliOperationTarget,
  DRAIN_TARGET,
  recordCliOperationAtExit,
  UNKNOWN_CLI_TARGET
} from '../../../../../kernel/log/client/cli-operation-log.js'
import { storedEvents } from '../../../../../kernel/gates/checks/runner/local-copy-probe.js'
import { isolatedConfigFixture, spawnSyncBudgeted } from '../../../../../kernel/conformance/unit/process-fixture.js'

type CommandRecord = NonNullable<ReturnType<typeof cliOperationRecord>>

const ENTRY = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'apps',
  'cli',
  'src',
  'index.ts'
)

/**
 * A catalog entry this doctrine deliberately leaves OFF `cli-operation-log.ts`'s
 * own fixed `SUBCOMMANDS` list — that file is outside this surface, so a
 * newly-catalogued `log`/`task` entry here falls back to the bare command,
 * the same operation-log target any other unlisted subcommand already gets,
 * rather than widening a file this task does not own.
 */
const UNLISTED_SUBCOMMAND_TARGETS: ReadonlySet<string> = new Set(['log emit'])

/** The target a catalog entry's name maps to: its first word, plus the subcommand for `log` and `task` — except the entries named above. */
function expectedTarget(name: string): string {
  const [first, second] = name.split(' ')
  if (UNLISTED_SUBCOMMAND_TARGETS.has(name)) return first as string
  return first === 'log' || first === 'task' ? `${first} ${second}` : (first as string)
}

describe('cliOperationTarget (O4)', () => {
  it('maps every command name in the catalog to a target', () => {
    for (const { name } of COMMANDS) {
      const target = cliOperationTarget(name.split(' '))
      expect(target).not.toBe(UNKNOWN_CLI_TARGET)
      expect(target).toBe(expectedTarget(name))
    }
  })

  it('maps a name outside the catalog to unknown', () => {
    expect(cliOperationTarget(['definitely-not-a-command'])).toBe(UNKNOWN_CLI_TARGET)
    expect(cliOperationTarget(['ghp_secretvalue', 'check'])).toBe(UNKNOWN_CLI_TARGET)
  })

  it('appends a log or task subcommand only from the fixed list', () => {
    expect(cliOperationTarget(['log', 'send'])).toBe('log send')
    expect(cliOperationTarget(['task', 'run', '--task', '4'])).toBe('task run')
    expect(cliOperationTarget(['log', 'ghp_secretvalue'])).toBe('log')
    expect(cliOperationTarget(['task'])).toBe('task')
    expect(cliOperationTarget(['pr', 'create', '--body-file', 'x.md'])).toBe('pr')
  })

  it('maps a bare invocation and the help flags to help', () => {
    expect(cliOperationTarget([])).toBe('help')
    expect(cliOperationTarget(['--help'])).toBe('help')
    expect(cliOperationTarget(['-h'])).toBe('help')
  })
})

describe('cliOperationResult and cliOperationRecord (O1)', () => {
  it('maps exit code 0 to ok, 2 to refused, and any other to error', () => {
    expect(cliOperationResult(0)).toBe('ok')
    expect(cliOperationResult(2)).toBe('refused')
    expect(cliOperationResult(1)).toBe('error')
    expect(cliOperationResult(130)).toBe('error')
  })

  it('carries the exit code as the error kind of a result that is not ok, and never an argument', () => {
    const record = cliOperationRecord(['check', '--token', 'ghp_secretvalue'], 1)
    expect(record).toEqual({ action: CLI_OPERATION, target: 'check', result: 'error', errorType: '1' })
    expect(JSON.stringify(record)).not.toContain('ghp_secretvalue')
    expect(cliOperationRecord(['version'], 0)).toEqual({ action: CLI_OPERATION, target: 'version', result: 'ok' })
  })

  it('records nothing for the drain (O3)', () => {
    expect(cliOperationRecord(['log', 'send'], 0)).toBeNull()
    expect(DRAIN_TARGET).toBe('log send')
  })
})

describe('recordCliOperationAtExit (O2)', () => {
  function harness() {
    const handlers: Array<(code: number) => void> = []
    const records: CommandRecord[] = []
    return {
      handlers,
      records,
      deps: {
        on: (_event: 'exit', handler: (code: number) => void) => handlers.push(handler),
        record: (r: CommandRecord) => {
          records.push(r)
        }
      }
    }
  }

  it('registers once and records one command record at exit', () => {
    const h = harness()
    recordCliOperationAtExit(['version'], h.deps)
    expect(h.handlers).toHaveLength(1)
    h.handlers[0]?.(0)
    expect(h.records).toEqual([{ action: CLI_OPERATION, target: 'version', result: 'ok' }])
  })

  it('records nothing for the drain', () => {
    const h = harness()
    recordCliOperationAtExit(['log', 'send'], h.deps)
    h.handlers[0]?.(0)
    expect(h.records).toHaveLength(0)
  })

  it('never throws when the writer does', () => {
    const h = harness()
    recordCliOperationAtExit(['check'], {
      ...h.deps,
      record: () => {
        throw new Error('disk full')
      }
    })
    expect(() => h.handlers[0]?.(1)).not.toThrow()
  })
})

describe('the real entry point', () => {
  function run(args: string[]) {
    const fixture = isolatedConfigFixture('vinaya-cli-op-')
    const r = spawnSyncBudgeted('bun', [ENTRY, ...args], {
      cwd: fixture.cwd,
      env: { ...fixture.env, VINAYA_RUNTIME_DIR: fixture.runtimeDir },
      encoding: 'utf-8'
    })
    const logsRoot = join(fixture.runtimeDir, 'logs')
    const earlierFormat = existsSync(logsRoot)
      ? readdirSync(logsRoot, { recursive: true, encoding: 'utf-8' }).filter((f) => f.endsWith('.ndjson'))
      : []
    const commands = storedEvents(fixture.logsDir).filter((e) => e.name === 'vinaya.command.completed')
    return { ...r, earlierFormat, commands }
  }

  it('writes a taskless invocation’s one command record to the local copy, under its own run id, and no earlier-format event', () => {
    const r = run(['version'])
    expect(r.status).toBe(0)
    expect(r.commands).toHaveLength(1)
    expect(r.commands[0]?.attributes).toMatchObject({
      'vinaya.outside.action': CLI_OPERATION,
      'vinaya.outside.target': 'version',
      'vinaya.result': 'ok'
    })
    expect(r.earlierFormat).toEqual([])
  })

  it('records one command record for a process.exit(2) from inside the command, and prints nothing extra', () => {
    const r = run(['not-a-real-command', '--token', 'ghp_secretvalue'])
    expect(r.status).toBe(2)
    expect(r.stderr).not.toContain('logSync')
    expect(r.stderr).not.toContain('log destination')
    expect(r.commands).toHaveLength(1)
    expect(r.commands[0]?.attributes).toMatchObject({
      'vinaya.outside.target': UNKNOWN_CLI_TARGET,
      'vinaya.result': 'refused',
      'error.type': '2'
    })
    expect(JSON.stringify(r.commands)).not.toContain('ghp_secretvalue')
  })
})
