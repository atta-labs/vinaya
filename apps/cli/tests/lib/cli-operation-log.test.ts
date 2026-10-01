import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMMANDS } from '@attalabs/vinaya-sources'
import {
  CLI_OPERATION,
  cliOperationEvent,
  cliOperationResult,
  cliOperationTarget,
  DRAIN_TARGET,
  recordCliOperationAtExit,
  UNKNOWN_CLI_TARGET
} from '../../src/lib/cli-operation-log.js'
import type { LogEventInput } from '../../src/lib/log-sink.js'
import { isolatedConfigFixture, spawnSyncBudgeted } from './process-fixture.js'

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'index.ts')

/** The target a catalog entry's name maps to: its first word, plus the subcommand for `log` and `task`. */
function expectedTarget(name: string): string {
  const [first, second] = name.split(' ')
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

describe('cliOperationResult and cliOperationEvent (O1)', () => {
  it('maps exit code 0 to ok, 2 to refused, and any other to error', () => {
    expect(cliOperationResult(0)).toBe('ok')
    expect(cliOperationResult(2)).toBe('refused')
    expect(cliOperationResult(1)).toBe('error')
    expect(cliOperationResult(130)).toBe('error')
  })

  it('carries the duration and the exit code as the error class, and never an argument', () => {
    const event = cliOperationEvent(['check', '--token', 'ghp_secretvalue'], 1, 41.6)
    expect(event).toEqual({
      kind: 'operation',
      event: 'completed',
      payload: {},
      operation: CLI_OPERATION,
      target: 'check',
      result: 'error',
      error_class: '1',
      duration_ms: 42
    })
    expect(JSON.stringify(event)).not.toContain('ghp_secretvalue')
  })

  it('records nothing for the drain (O3)', () => {
    expect(cliOperationEvent(['log', 'send'], 0, 5)).toBeNull()
    expect(DRAIN_TARGET).toBe('log send')
  })
})

describe('recordCliOperationAtExit (O2)', () => {
  function harness(now: () => number = () => 1000) {
    const handlers: Array<(code: number) => void> = []
    const logged: LogEventInput[] = []
    return {
      handlers,
      logged,
      deps: {
        on: (_event: 'exit', handler: (code: number) => void) => handlers.push(handler),
        logSync: (e: LogEventInput) => {
          logged.push(e)
        },
        now
      }
    }
  }

  it('registers once and records one event at exit with the process duration', () => {
    const times = [1000, 1250]
    const h = harness(() => times.shift() ?? 0)
    recordCliOperationAtExit(['version'], h.deps)
    expect(h.handlers).toHaveLength(1)
    h.handlers[0]?.(0)
    expect(h.logged).toHaveLength(1)
    expect(h.logged[0]).toMatchObject({ target: 'version', result: 'ok', error_class: '0', duration_ms: 250 })
  })

  it('records nothing for the drain', () => {
    const h = harness()
    recordCliOperationAtExit(['log', 'send'], h.deps)
    h.handlers[0]?.(0)
    expect(h.logged).toHaveLength(0)
  })

  it('never throws when the sink does', () => {
    const h = harness()
    recordCliOperationAtExit(['check'], {
      ...h.deps,
      logSync: () => {
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
    const events: Array<Record<string, unknown>> = []
    const logsRoot = join(fixture.runtimeDir, 'logs')
    if (existsSync(logsRoot)) {
      for (const f of readdirSync(logsRoot, { recursive: true, encoding: 'utf-8' })) {
        if (!f.endsWith('.ndjson')) continue
        for (const line of readFileSync(join(logsRoot, f), 'utf-8').split('\n')) {
          if (line.trim() !== '') events.push(JSON.parse(line))
        }
      }
    }
    return { ...r, events: events.filter((e) => e.kind === 'operation' && e.operation === CLI_OPERATION) }
  }

  it('records one event for a process.exit(2) from inside the command, and prints nothing extra', () => {
    const r = run(['not-a-real-command', '--token', 'ghp_secretvalue'])
    expect(r.status).toBe(2)
    expect(r.stderr).not.toContain('logSync')
    expect(r.stderr).not.toContain('log destination')
    expect(r.events).toHaveLength(1)
    expect(r.events[0]).toMatchObject({ target: UNKNOWN_CLI_TARGET, result: 'refused', error_class: '2' })
    expect(JSON.stringify(r.events)).not.toContain('ghp_secretvalue')
  })

  it('records one ok event for a command that returns normally', () => {
    const r = run(['version'])
    expect(r.status).toBe(0)
    expect(r.events).toHaveLength(1)
    expect(r.events[0]).toMatchObject({ target: 'version', result: 'ok', error_class: '0' })
  })
})
