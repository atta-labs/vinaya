import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createLineReader, narrate as packageNarrate, type OtelRecord, type SeatNames } from '@attalabs/vinaya-log-sdk'
import { EXECUTION_NAMES, buildExecution } from '../fixtures/executions'
import { registerRole, restoreRoleRegistry, saveRoleRegistry, type RoleRegistrySnapshot } from '../roles'
import { narrate as harnessNarrate } from './narration'

let savedRoles: RoleRegistrySnapshot
const seatNames: SeatNames = {
  developer: 'developer',
  'code-reviewer': { reading: 'code reviewer', reviews: true },
  security: { reading: 'security reviewer', reviews: true }
}

beforeAll(() => {
  savedRoles = saveRoleRegistry()
  registerRole('developer', { reading: 'developer', title: 'Developer', reviews: false })
  registerRole('code-reviewer', { reading: 'code reviewer', title: 'Code review', reviews: true })
  registerRole('security', { reading: 'security reviewer', title: 'Security', reviews: true })
})
afterAll(() => restoreRoleRegistry(savedRoles))

/** Each earlier event the harness narration words, narrated by the package over its converted record. */
function compare(rawLines: string[]) {
  const lines = createLineReader('parity')
  const events: Record<string, unknown>[] = []
  const converted: OtelRecord[] = []
  const wordedBoth: { harness: unknown; text: string }[] = []
  const mismatches: unknown[] = []
  for (const raw of rawLines) {
    const event = JSON.parse(raw) as Record<string, unknown>
    const read = lines.readLine(raw)
    const record = read.records[0]
    if (record === undefined) continue
    const expected = harnessNarrate(event, events)
    const actual = packageNarrate(record, seatNames, converted)
    events.push(event)
    converted.push(record)
    if (expected === null) continue
    if (JSON.stringify(expected) === JSON.stringify(actual)) wordedBoth.push({ harness: expected, text: expected.text })
    else mismatches.push({ event: `${event.kind}.${event.event}`, expected, actual })
  }
  return { wordedBoth, mismatches }
}

describe('the harness narration and the package narration say the same', () => {
  for (const name of EXECUTION_NAMES) {
    it(`every earlier event of ${name} the harness words gives the same kind and text`, () => {
      const { mismatches } = compare(buildExecution(name).lines.map((line) => line.raw))
      expect(mismatches).toEqual([])
    })
  }

  it('the earlier events of the stored fixture give the same kind and text, and a round end its confidence clause', async () => {
    const raw = (
      await Bun.file(
        new URL('../../../../packages/log-sdk/tests/fixtures/earlier-events.jsonl', import.meta.url)
      ).text()
    )
      .trim()
      .split('\n')
    const { wordedBoth, mismatches } = compare(raw)
    expect(mismatches).toEqual([])
    expect(wordedBoth.length).toBeGreaterThan(5)
  })

  it('a round end after its gate read carries the same confidence clause in both', () => {
    const rawLines = buildExecution('three-rounds-recurring-finding').lines.map((line) => line.raw)
    const { wordedBoth, mismatches } = compare(rawLines)
    expect(mismatches).toEqual([])
    expect(wordedBoth.some(({ text }) => text.includes('Confidence:'))).toBe(true)
  })
})
