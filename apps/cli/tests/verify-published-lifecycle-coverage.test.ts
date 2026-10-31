import { describe, expect, test } from 'bun:test'
import { COMMANDS } from '@attalabs/vinaya-sources'
import {
  declaredCommandNames,
  EXERCISES,
  EXEMPTIONS,
  HANDLED_INLINE,
  RUN_ORDER,
  uncoveredShippedCommands
} from '../scripts/verify-published-lifecycle'

// The shipped-command lifecycle only runs after a release, against an
// installed artifact. These tests read the same declarations statically, in the
// ordinary suite, so a shipped command added without an exercise, an inline
// handling or a stated exemption fails at pull-request time instead of at the
// next release. Nothing here installs, packs or reaches a forge.

const shipped = COMMANDS.filter((c) => c.status === 'shipped').map((c) => c.name)

describe('verify-published-lifecycle coverage', () => {
  test('every shipped command has an exercise, an inline handling or an exemption', () => {
    expect(uncoveredShippedCommands()).toEqual([])
  })

  test('a synthetic shipped command with no entry is reported by name', () => {
    const synthetic = [...COMMANDS, { name: 'synthetic uncovered command', status: 'shipped' }]
    expect(uncoveredShippedCommands(synthetic)).toEqual(['synthetic uncovered command'])
  })

  test('a synthetic command that is not shipped is not reported', () => {
    const synthetic = [...COMMANDS, { name: 'synthetic planned command', status: 'planned' }]
    expect(uncoveredShippedCommands(synthetic)).toEqual([])
  })

  test('no exercise, exemption or inline handling names a command the registry does not ship', () => {
    const stale = declaredCommandNames().filter((name) => !shipped.includes(name))
    expect(stale).toEqual([])
  })

  test('every exercise except init is in the run order, and every run-order entry is an exercise', () => {
    const missingFromOrder = Object.keys(EXERCISES).filter(
      (name) => name !== 'init' && !RUN_ORDER.includes(name as never)
    )
    const notAnExercise = RUN_ORDER.filter((name) => !(name in EXERCISES))
    expect({ missingFromOrder, notAnExercise }).toEqual({ missingFromOrder: [], notAnExercise: [] })
  })

  test('the run order lists no exercise twice', () => {
    expect(new Set(RUN_ORDER).size).toBe(RUN_ORDER.length)
  })

  test('`sync` runs after `log emit`, whose folder it reads', () => {
    expect(RUN_ORDER.indexOf('sync')).toBeGreaterThan(RUN_ORDER.indexOf('log emit'))
  })

  test('no command has both an exercise and an exemption', () => {
    const both = Object.keys(EXERCISES).filter((name) => name in EXEMPTIONS)
    const inlineAndExempt = [...HANDLED_INLINE].filter((name) => name in EXEMPTIONS)
    expect({ both, inlineAndExempt }).toEqual({ both: [], inlineAndExempt: [] })
  })

  test('every exemption states its reason', () => {
    const empty = Object.entries(EXEMPTIONS)
      .filter(([, reason]) => reason.trim().length === 0)
      .map(([name]) => name)
    expect(empty).toEqual([])
  })
})
