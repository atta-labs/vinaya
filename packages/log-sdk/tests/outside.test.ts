import { expect, test } from 'bun:test'
import { ATTRIBUTE_NAMES as A, EVENT_NAMES as E } from '../src/index.js'
import { harness } from './helpers.js'

test('outside events carry targets, results and error classes and omit input content', () => {
  const { handle, logs, errors } = harness({ home: '/private-home' })
  const detail = {
    action: 'write',
    target: '/private-home/work',
    errorType: 'timeout',
    arguments: ['private argument'],
    body: 'private comment'
  }
  handle.forge.validated(detail)
  handle.forge.refused({ ...detail, why: 'too_long' })
  handle.forge.written(detail)
  handle.action.verified({ ...detail, result: 'failure' })
  handle.command.completed({ ...detail, result: 'error' })
  expect(errors).toEqual([])
  const records = logs.getFinishedLogRecords()
  expect(records.map((r) => r.eventName)).toEqual([
    E.forgeValidated,
    E.forgeRefused,
    E.forgeWritten,
    E.actionVerified,
    E.commandCompleted
  ])
  for (const event of records) {
    expect(event.attributes).toMatchObject({ [A.action]: 'write', [A.target]: '~/work' })
    expect(JSON.stringify(event.attributes)).not.toContain('private')
  }
  expect(records[1]?.attributes[A.reason]).toBe('too_long')
  expect(records[3]?.attributes).toMatchObject({ [A.result]: 'failure', 'error.type': 'timeout' })
  expect(records[4]?.attributes).toMatchObject({ [A.result]: 'error', 'error.type': 'timeout' })
})
