import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import corpus from '../fixtures/dev-review-engine-scenarios.json'
import { currentRunId, type LogSinkDeps, type ResolvedLogDestination } from '../../src/lib/log-sink.js'
import { RUNTIME_DIR_ENV_KEY } from '../../src/lib/run-paths.js'
import { runStandaloneScenario } from './dev-review-current-loop-adapter.js'
import { runEngineScenario } from './dev-review-engine-loop-adapter.js'

/** The shared sink, recording to the scenario's own Log folder whatever the machine's config names. */
const recording = (env: NodeJS.ProcessEnv): ResolvedLogDestination => ({
  kind: 'folder',
  folder: join(env[RUNTIME_DIR_ENV_KEY]!, 'logs')
})
const RECORDING_SINK: Partial<LogSinkDeps> = {
  resolveLogDestination: (_repo, env) => recording(env),
  unresolvedLogDestination: recording
}

type Line = Record<string, unknown>

/**
 * The scenarios whose Log the two runners shape differently by design, each kept out of field equality with its
 * reason. Both runners must still record a Log for each through the shared sink.
 */
const STRUCTURAL_EXCLUSIONS: Readonly<Record<string, string>> = {
  'review-policy-unreadable':
    'crash path: standalone logs an uncaught crash (driver_exited first), the Engine a deliberate pause',
  'provider-failure':
    'crash path: standalone logs an uncaught crash (driver_exited first), the Engine a deliberate pause',
  'isolation-refusal':
    'crash path: standalone logs an uncaught crash (driver_exited first), the Engine a deliberate pause',
  'uncertain-effect-crash':
    'crash path: standalone logs an uncaught crash (driver_exited first), the Engine a deliberate pause',
  'publication-replay': 'restart: standalone reruns the loop and its round, the Engine resumes from its checkpoint',
  resume: 'restart: standalone reruns the loop and its round, the Engine resumes from its checkpoint',
  cancellation:
    'cancellation: standalone cancels the paused run from another process, the Engine halts its live resumed leg'
}

/**
 * Open defects in the register that the standalone loop still shows and the Engine does not, each named with what
 * the replay leaves out of the standalone Log for a scenario the corpus maps to it.
 */
const STANDALONE_DEFECTS: Readonly<Record<string, (lines: Line[]) => Line[]>> = {
  // A round revisited after a red gate starts again in standalone's Log; the Engine starts each round once.
  'DEF-03': (lines) => {
    const started = new Set<string>()
    return lines.filter((l) => {
      if (l.kind !== 'dev_review_loop' || l.event !== 'round_started') return true
      const round = `${String((l.meta as Line | undefined)?.run_id)}:${String(l.round)}`
      if (started.has(round)) return false
      started.add(round)
      return true
    })
  }
}

/** The run identity fields: their values name this run, so only whether each is present is compared. */
const IDENTITY = new Set<string>([
  'meta.ts',
  'meta.run_id',
  'meta.event_id',
  'meta.seq',
  'meta.process_id',
  'meta.lineage.run',
  'loop_id',
  'task',
  'subject.issue',
  'subject.pr',
  'meta.work.ref',
  'meta.work.change',
  'head',
  'base_head',
  'final_head',
  'effect_id',
  'wall_ms',
  'total_wall_ms',
  'time_to_green_ms',
  'duration_ms'
])

/** The fixture-world fields: each adapter's repository has its own diff, so only whether each is present is compared. */
const WORLD = new Set<string>(['files_changed', 'insertions', 'deletions', 'files_changed_total'])

/**
 * Identity tokens inside text: a commit sha, a vendor session and the agent the run was dispatched under. A session
 * a runner could not name stays `(unknown)`, so a missing one is still a difference.
 */
function masked(value: unknown): unknown {
  if (typeof value !== 'string') return value
  return value
    .replace(/\b[0-9a-f]{40}\b/g, '<sha>')
    .replace(/session (?!\(unknown\))[^\s):;]+/g, 'session <id>')
    .replace(/\b(claude|codex)\b/g, '<agent>')
}

const present = (value: unknown) => value !== undefined && value !== null

function flatten(value: unknown, prefix: string, out: Map<string, unknown>): void {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, inner] of Object.entries(value)) flatten(inner, prefix ? `${prefix}.${key}` : key, out)
    return
  }
  out.set(prefix, Array.isArray(value) ? JSON.parse(JSON.stringify(value), (_k, v) => masked(v)) : masked(value))
}

/**
 * Each sink's lines in that sink's own order, the run's sinks first and the
 * module's default sink last — the order it drains in on both runners.
 */
function canonical(lines: Line[]): Line[] {
  const runOf = (l: Line) => String((l.meta as Line | undefined)?.run_id)
  const streams = new Map<string, Line[]>()
  for (const l of lines) streams.set(runOf(l), [...(streams.get(runOf(l)) ?? []), l])
  const own = [...streams.entries()].filter(([run]) => run !== currentRunId()).flatMap(([, ls]) => ls)
  return [...own, ...(streams.get(currentRunId()) ?? [])]
}

function differences(engineLines: Line[], standaloneLines: Line[]): string[] {
  const engine = canonical(engineLines)
  const standalone = canonical(standaloneLines)
  const out: string[] = []
  const name = (l: Line) => `${String(l.kind)}:${String(l.event)}`
  const sequence = (ls: Line[]) => ls.map(name).join(' ')
  if (sequence(engine) !== sequence(standalone))
    return [`events: engine [${sequence(engine)}] standalone [${sequence(standalone)}]`]
  for (let i = 0; i < engine.length; i++) {
    const e = engine[i]!
    const s = standalone[i]!
    const fe = new Map<string, unknown>()
    const fs = new Map<string, unknown>()
    flatten(e, '', fe)
    flatten(s, '', fs)
    for (const key of new Set([...fe.keys(), ...fs.keys()]))
      if (
        IDENTITY.has(key) || WORLD.has(key)
          ? present(fe.get(key)) !== present(fs.get(key))
          : JSON.stringify(fe.get(key)) !== JSON.stringify(fs.get(key))
      )
        out.push(
          `#${i} ${name(e)} ${key}: engine ${JSON.stringify(fe.get(key))} standalone ${JSON.stringify(fs.get(key))}`
        )
  }
  return out
}

describe('standalone and Engine Log replay', () => {
  it('names only corpus scenarios as structural exclusions, and only registered defects', () => {
    const ids = new Set(corpus.scenarios.map((scenario) => scenario.id))
    for (const id of Object.keys(STRUCTURAL_EXCLUSIONS)) expect(ids.has(id), id).toBe(true)
    for (const scenario of corpus.scenarios as Array<{ expectedDefect?: string }>)
      if (scenario.expectedDefect !== undefined) expect(STANDALONE_DEFECTS[scenario.expectedDefect]).toBeDefined()
  })

  it('replays every corpus scenario through both runners with equal Log lines', async () => {
    const all: string[] = []
    for (const scenario of corpus.scenarios as Array<{ id: string; expectedDefect?: string }>) {
      const recorded = await runStandaloneScenario(scenario.id, RECORDING_SINK)
      const known = scenario.expectedDefect === undefined ? undefined : STANDALONE_DEFECTS[scenario.expectedDefect]
      const standalone = known ? known(recorded.logLines ?? []) : (recorded.logLines ?? [])
      for (const agent of ['claude', 'codex'] as const) {
        const engine = (await runEngineScenario(scenario.id, agent, RECORDING_SINK)).logLines ?? []
        if (STRUCTURAL_EXCLUSIONS[scenario.id] !== undefined) {
          if (engine.length === 0 || standalone.length === 0) all.push(`${scenario.id} (${agent}) recorded no Log`)
          continue
        }
        for (const d of differences(engine, standalone)) all.push(`${scenario.id} (${agent}) ${d}`)
      }
    }
    expect(all).toEqual([])
  }, 600_000)
})
