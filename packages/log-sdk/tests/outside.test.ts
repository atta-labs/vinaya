import { expect, test } from 'bun:test'
import { ATTRIBUTE_NAMES as A, EVENT_NAMES as E } from '../src/index.js'
import { harness } from './helpers.js'

test('outside events carry targets, results and error classes and omit input content', () => {
  const { handle, logs } = harness({ home: '/private-home' })
  const detail = {
    action: 'write',
    target: '/private-home/work',
    result: 'failed',
    errorType: 'timeout',
    arguments: ['private argument'],
    body: 'private comment'
  }
  handle.forgeAction(detail)
  handle.verifiedAction(detail)
  handle.commandCompleted(detail)
  const records = logs.getFinishedLogRecords()
  expect(records.map((r) => r.eventName)).toEqual([E.forgeAction, E.verifiedAction, E.commandCompleted])
  for (const event of records) {
    expect(event.attributes).toMatchObject({
      [A.action]: 'write',
      [A.target]: '~/work',
      [A.result]: 'failed',
      'error.type': 'timeout'
    })
    expect(JSON.stringify(event.attributes)).not.toContain('private')
  }
})
