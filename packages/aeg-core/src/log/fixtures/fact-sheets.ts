/**
 * The answer key for each fixture execution, written by hand from the
 * scenario in `./executions` — never computed from the lines. A later task's
 * expected result is worked out from these sheets by a person; the test beside
 * this file compares each sheet with the lines, so a sheet and its scenario can
 * never drift apart unnoticed.
 *
 * What each fact counts:
 * - `lines` — every stored line, valid or not, repeats included.
 * - `schemas` — lines per declared `meta.schema`.
 * - `rounds` — the review rounds the execution started (`round_started` events).
 * - `eventsByKind` — lines per event family (`kind`), repeats and invalid lines included.
 * - `findingIdentities` — the distinct finding identities the execution names, sorted.
 * - `models` — the distinct `model` values events carry, sorted; a null model is none.
 */

import type { ExecutionName } from './executions'

export type FactSheet = {
  lines: number
  schemas: Record<string, number>
  rounds: number
  eventsByKind: Record<string, number>
  findingIdentities: string[]
  models: string[]
}

export const FACT_SHEETS: Record<ExecutionName, FactSheet> = {
  // loop_started, one round of four events, stop condition and journal; one developer and one reviewer dispatch pair; one typecheck.
  'green-one-round': {
    lines: 12,
    schemas: { '3': 12 },
    rounds: 1,
    eventsByKind: { dev_review_loop: 7, dispatch: 4, gate: 1 },
    findingIdentities: [],
    models: ['opus', 'sonnet']
  },
  // Round 1 reports the authentication finding; round 2 reports it again (recurring) beside the documentation finding; round 3 resolves both.
  // Rounds 2 and 3 carry a findings comparison and a stated confidence, round 3 after the extra turn.
  'three-rounds-recurring-finding': {
    lines: 32,
    schemas: { '3': 32 },
    rounds: 3,
    eventsByKind: { dev_review_loop: 17, dispatch: 12, gate: 3 },
    findingIdentities: ['fnd-auth-1', 'fnd-docs-2'],
    models: ['opus', 'sonnet']
  },
  // Round 1 reports one finding and ends changes requested; a pause and a resume follow; round 2 resolves it.
  'paused-and-resumed': {
    lines: 24,
    schemas: { '3': 24 },
    rounds: 2,
    eventsByKind: { dev_review_loop: 14, dispatch: 8, gate: 2 },
    findingIdentities: ['fnd-q-1'],
    models: ['opus', 'sonnet']
  },
  // loop_started, round_started, stop condition, round_ended and journal; the developer dispatch pair; one handoff. No reviewer is ever dispatched.
  'escalated-handoff': {
    lines: 8,
    schemas: { '3': 8 },
    rounds: 1,
    eventsByKind: { dev_review_loop: 5, dispatch: 2, handoff: 1 },
    findingIdentities: [],
    models: ['sonnet']
  },
  // One check and one fingerprint: fail at the first commit, pass at the second.
  'gate-two-commits': {
    lines: 2,
    schemas: { '3': 2 },
    rounds: 0,
    eventsByKind: { gate: 2 },
    findingIdentities: [],
    models: []
  },
  // One check and one fingerprint, no commit on either line: pass, then fail.
  'gate-no-commit': {
    lines: 2,
    schemas: { '3': 2 },
    rounds: 0,
    eventsByKind: { gate: 2 },
    findingIdentities: [],
    models: []
  },
  // One check, one fingerprint, one commit: pass, pass.
  'gate-same-commit-twice': {
    lines: 2,
    schemas: { '3': 2 },
    rounds: 0,
    eventsByKind: { gate: 2 },
    findingIdentities: [],
    models: []
  },
  // Five usage observations (two cumulative opus, three delta sonnet, the last with every unit unknown) and two sonnet role attempts with null usage.
  'usage-and-models': {
    lines: 7,
    schemas: { '3': 7 },
    rounds: 0,
    eventsByKind: { usage: 5, role_attempt: 2 },
    findingIdentities: [],
    models: ['opus', 'sonnet']
  },
  // In order: schema 1, schema 2, schema 2 low-trust (0.30.1), schema 3, schema 9 (unknown), schema 3 failing validation (a gate line), the schema 3 line again.
  'historical-and-hostile-lines': {
    lines: 7,
    schemas: { '1': 1, '2': 2, '3': 3, '9': 1 },
    rounds: 0,
    eventsByKind: { operation: 6, gate: 1 },
    findingIdentities: [],
    models: []
  }
}
