import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AUTHORITIES,
  ENGINE_STATES,
  ENGINE_TRANSITIONS,
  NODE_CONTRACTS,
  OWNERS,
  PROVIDER_ADAPTER_EXTENSION_POINTS,
  SIDE_EFFECT_CLASSES,
  TERMINAL_OUTCOME_IDS,
  TERMINAL_OUTCOMES,
  type EngineTransition,
  type NodeContract
} from './dev-review-engine-state-contract.fixture'

/**
 * `apps/cli/specs/dev-review-engine-state-machine.md`'s own test — the
 * target, provider-neutral Atta-Engine-backed developer-review workflow's
 * state/transition/terminal-outcome/node-contract completeness (O1, O2) and
 * provider-neutrality (O3). This is Task 2 of `developer-review-architecture-v1`
 * (Issue #975): it specifies the contract production execution must
 * satisfy; it builds no execution itself, so it holds no filesystem-surface
 * scan the way Task 1's loop-invariant test does — the model under test is
 * entirely the fixture's own declared data.
 */

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..')
const AMBIGUITY_FIXTURE_PATH = join(
  REPO_ROOT,
  'apps',
  'cli',
  'tests',
  'fixtures',
  'dev-review-architecture-invariants.json'
)

interface AmbiguityEntry {
  id: string
  question: string
  citations: string[]
  rulingStatus: string
  ruling?: string
}

const ambiguities: AmbiguityEntry[] = JSON.parse(readFileSync(AMBIGUITY_FIXTURE_PATH, 'utf8')).ambiguities

/** Shipped `<kind>:<event>` pairs `apps/cli/specs/log.md` documents today — never a family this model invents. */
const SHIPPED_LOG_EVENTS = new Set([
  'dispatch:dispatched',
  'dispatch:outcome_received',
  'dispatch:dispatch_failed',
  'dev_review_loop:loop_started',
  'dev_review_loop:round_started',
  'dev_review_loop:gate_result_read',
  'dev_review_loop:verdicts_read',
  'dev_review_loop:findings_compared',
  'dev_review_loop:stop_condition_met',
  'dev_review_loop:paused',
  'dev_review_loop:resumed',
  'dev_review_loop:cancelled',
  'dev_review_loop:unpushed_work_resume',
  'dev_review_loop:round_ended',
  'dev_review_loop:journal_finalized',
  'dev_review_loop:infrastructure_retry',
  'dev_review_loop:driver_heartbeat',
  'dev_review_loop:driver_exited',
  'gate:summary',
  'gate:checked',
  'operation:completed',
  'usage:observed',
  'role_attempt:attempted',
  'handoff:raised',
  'handoff:resolved',
  'effect:verified'
])

/** No core field may name a provider — confinement, not absence (O3). */
const BANNED_PROVIDER_TOKENS = [
  'claude',
  'codex',
  'anthropic',
  'openai',
  'chatgpt',
  'gpt-',
  'gpt4',
  'gpt 4',
  'vertex',
  'gemini'
]

/** A guard must be a deterministic predicate — never a model's own judgement call. */
const NON_DETERMINISTIC_PHRASES = [
  /\bthe model decides\b/i,
  /\ban llm\b/i,
  /\bthe agent decides\b/i,
  /\bin its judgement\b/i
]

const stateIds = new Set(ENGINE_STATES.map((s) => s.id))
const terminalIds = new Set(TERMINAL_OUTCOME_IDS as readonly string[])
const VALID_TRANSITION_TARGETS = new Set([...stateIds, ...terminalIds, 'any in-flight state', 'cancel_run'])

function findings<T>(items: T[], predicate: (item: T) => string[]): string[] {
  return items.flatMap(predicate)
}

describe('target state model (O1): states, transitions, terminal outcomes', () => {
  it('every state names a real owner and authority', () => {
    const bad = findings(ENGINE_STATES, (s) => {
      const problems: string[] = []
      if (!OWNERS.includes(s.owner)) problems.push(`${s.id}: owner "${s.owner}" is not one of ${OWNERS.join(', ')}`)
      if (!AUTHORITIES.includes(s.authority))
        problems.push(`${s.id}: authority "${s.authority}" is not one of ${AUTHORITIES.join(', ')}`)
      if (s.description.trim().length === 0) problems.push(`${s.id}: empty description`)
      return problems
    })
    expect(bad).toEqual([])
  })

  it('state ids are unique', () => {
    expect(new Set(ENGINE_STATES.map((s) => s.id)).size).toBe(ENGINE_STATES.length)
  })

  it('every transition names a real trigger and a deterministic guard, and connects real states', () => {
    const bad = findings(ENGINE_TRANSITIONS, (t: EngineTransition) => {
      const problems: string[] = []
      if (t.trigger.trim().length === 0) problems.push(`${t.id}: empty trigger`)
      if (t.guard.trim().length === 0) problems.push(`${t.id}: empty guard`)
      for (const phrase of NON_DETERMINISTIC_PHRASES) {
        if (phrase.test(t.guard))
          problems.push(`${t.id}: guard "${t.guard}" reads as a model judgement, not a deterministic predicate`)
      }
      if (t.from !== 'any in-flight state' && !stateIds.has(t.from))
        problems.push(`${t.id}: from "${t.from}" is not a declared state`)
      if (!VALID_TRANSITION_TARGETS.has(t.to))
        problems.push(`${t.id}: to "${t.to}" is not a declared state or terminal outcome`)
      return problems
    })
    expect(bad).toEqual([])
  })

  it('transition ids are unique', () => {
    expect(new Set(ENGINE_TRANSITIONS.map((t) => t.id)).size).toBe(ENGINE_TRANSITIONS.length)
  })

  it('every terminal outcome carries explicit persistence and resumption behavior, and the five are distinct', () => {
    expect(new Set(TERMINAL_OUTCOMES.map((o) => o.id)).size).toBe(5)
    expect(TERMINAL_OUTCOMES.length).toBe(5)
    const bad = findings(TERMINAL_OUTCOMES, (o) => {
      const problems: string[] = []
      if (o.persistence.trim().length === 0) problems.push(`${o.id}: empty persistence`)
      if (o.resumption.trim().length === 0) problems.push(`${o.id}: empty resumption`)
      return problems
    })
    expect(bad).toEqual([])
  })

  it('develop, review, mechanical-gate, human-handoff, publication, restart and cancellation are all represented', () => {
    const ids = new Set(ENGINE_STATES.map((s) => s.id))
    for (const required of [
      'dispatch_developer', // developer
      'dispatch_reviewers', // reviewer
      'run_mechanical_gates', // mechanical gate
      'raise_human_handoff', // human handoff
      'publish_ready_for_merge', // publication
      'reconcile_external_state', // restart
      'cancel_run' // cancellation
    ]) {
      expect(ids.has(required)).toBe(true)
    }
  })

  it("every cited ruling (AMB-*) exists in Task 1's register and is actually ruled, never awaiting-principal", () => {
    const byId = new Map(ambiguities.map((a) => [a.id, a]))
    const cited = new Set(ENGINE_TRANSITIONS.flatMap((t) => (t.ruling ? [t.ruling] : [])))
    const bad: string[] = []
    for (const id of cited) {
      const entry = byId.get(id)
      if (!entry) {
        bad.push(`${id}: cited by this model but absent from the ambiguity register`)
        continue
      }
      if (entry.rulingStatus !== 'ruled' || !entry.ruling) {
        bad.push(`${id}: cited by this model but rulingStatus is "${entry.rulingStatus}", not "ruled"`)
      }
    }
    expect(bad).toEqual([])
  })
})

describe('target node contracts (O2): every field, for every node', () => {
  const REQUIRED_STRING_FIELDS: (keyof NodeContract)[] = [
    'typedInput',
    'typedOutput',
    'retryPolicy',
    'timeoutPolicy',
    'failureBehavior',
    'cancellationBehavior'
  ]

  it('every node contract id matches a declared state exactly once', () => {
    const contractIds = NODE_CONTRACTS.map((c) => c.id)
    expect(new Set(contractIds).size).toBe(contractIds.length)
    expect(new Set(contractIds)).toEqual(new Set(ENGINE_STATES.map((s) => s.id)))
  })

  it('reports zero node contracts missing a required field', () => {
    const missing = findings(NODE_CONTRACTS, (c) => {
      const problems: string[] = []
      if (!OWNERS.includes(c.owner)) problems.push(`${c.id}.owner`)
      for (const field of REQUIRED_STRING_FIELDS) {
        const value = c[field] as string
        if (typeof value !== 'string' || value.trim().length === 0) problems.push(`${c.id}.${field}`)
      }
      if (!SIDE_EFFECT_CLASSES.includes(c.sideEffects)) problems.push(`${c.id}.sideEffects`)
      if (!Array.isArray(c.lifecycleEvents) || c.lifecycleEvents.length === 0) problems.push(`${c.id}.lifecycleEvents`)
      return problems
    })
    expect(missing).toEqual([])
  })

  it('every emitted lifecycle event is a real, shipped Log kind:event pair, never an invented family', () => {
    const bad = findings(NODE_CONTRACTS, (c) =>
      c.lifecycleEvents
        .filter((e) => !SHIPPED_LOG_EVENTS.has(e))
        .map((e) => `${c.id}: "${e}" is not a shipped log.md event`)
    )
    expect(bad).toEqual([])
  })

  it('a node that declares a real side effect never claims "none", and vice versa', () => {
    const governed = NODE_CONTRACTS.filter((c) => c.owner === 'governed-operation' || c.owner === 'provider-adapter')
    for (const c of governed) {
      if (c.id === 'await_developer') continue // the wait itself has no side effect; dispatch_developer owns it
      expect(c.sideEffects).not.toBe('none')
    }
  })
})

describe('provider neutrality (O3): core names no provider, outside the declared adapter extension points', () => {
  it('reports zero provider-specific tokens across states, transitions, terminal outcomes and node contracts', () => {
    const coreText = JSON.stringify({
      ENGINE_STATES,
      ENGINE_TRANSITIONS,
      TERMINAL_OUTCOMES,
      NODE_CONTRACTS
    }).toLowerCase()
    const hits = BANNED_PROVIDER_TOKENS.filter((token) => coreText.includes(token))
    expect(hits).toEqual([])
  })

  it('declares at least one adapter extension point per agent-facing node, naming providers only there', () => {
    expect(PROVIDER_ADAPTER_EXTENSION_POINTS.length).toBeGreaterThan(0)
    for (const point of PROVIDER_ADAPTER_EXTENSION_POINTS) {
      expect(point.implementations.length).toBeGreaterThan(0)
      expect(point.coreCaller.trim().length).toBeGreaterThan(0)
    }
    const extensionText = JSON.stringify(PROVIDER_ADAPTER_EXTENSION_POINTS).toLowerCase()
    expect(extensionText.includes('claude') || extensionText.includes('codex')).toBe(true)
  })

  it('prints the totals the Test Plan names, with zero missing contract fields and zero provider-specific core fields', () => {
    const missingContractFields = findings(NODE_CONTRACTS, (c) => {
      const problems: string[] = []
      const required: (keyof NodeContract)[] = [
        'typedInput',
        'typedOutput',
        'retryPolicy',
        'timeoutPolicy',
        'failureBehavior',
        'cancellationBehavior'
      ]
      for (const field of required) {
        const value = c[field] as string
        if (typeof value !== 'string' || value.trim().length === 0) problems.push(`${c.id}.${field}`)
      }
      if (!Array.isArray(c.lifecycleEvents) || c.lifecycleEvents.length === 0) problems.push(`${c.id}.lifecycleEvents`)
      if (!SIDE_EFFECT_CLASSES.includes(c.sideEffects)) problems.push(`${c.id}.sideEffects`)
      return problems
    })
    const coreText = JSON.stringify({
      ENGINE_STATES,
      ENGINE_TRANSITIONS,
      TERMINAL_OUTCOMES,
      NODE_CONTRACTS
    }).toLowerCase()
    const providerSpecificCoreFields = BANNED_PROVIDER_TOKENS.filter((token) => coreText.includes(token))
    const lines = [
      `states: ${ENGINE_STATES.length}`,
      `transitions: ${ENGINE_TRANSITIONS.length}`,
      `terminal outcomes: ${TERMINAL_OUTCOMES.length}`,
      `node contracts: ${NODE_CONTRACTS.length}`,
      `missing contract fields: ${missingContractFields.length}`,
      `provider-specific core fields: ${providerSpecificCoreFields.length}`,
      `ambiguity rulings consumed: ${new Set(ENGINE_TRANSITIONS.flatMap((t) => (t.ruling ? [t.ruling] : []))).size}`
    ]
    process.stdout.write(`${lines.join('\n')}\n`)
    expect(missingContractFields.length).toBe(0)
    expect(providerSpecificCoreFields.length).toBe(0)
  })
})
