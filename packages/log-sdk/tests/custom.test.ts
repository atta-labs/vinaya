import { expect, test } from 'bun:test'
import { harness } from './helpers.js'

test('custom records use the declared name and refuse invalid fields without displaying values', () => {
  const { handle, logs, errors } = harness({
    destination: { events: { 'team.checked': { fields: { path: 'text', count: 'number' } } } },
    home: '/private-home'
  })
  handle.custom('team.checked', { path: '/private-home/work', count: 1 })
  handle.custom('team.undeclared', { path: 'private value' })
  handle.custom('team.checked', { path: 'private value' })
  handle.custom('team.checked', { path: 'private value', count: 1, extra: 'private value' })
  handle.custom('team.checked', { path: 'private value', count: 'private value' })
  handle.custom('team.checked', { path: 'private value'.repeat(100), count: 1 })
  const records = logs.getFinishedLogRecords()
  expect(records.map((e) => e.eventName)).toEqual(['team.checked'])
  expect(records[0]?.attributes).toMatchObject({ path: '~/work', count: 1 })
  expect(errors.map(String)).toEqual([
    'Error: custom event refused (undeclared) []',
    'Error: custom event refused (missing_field) [count]',
    'Error: custom event refused (extra_field) [extra]',
    'Error: custom event refused (wrong_type) [count]',
    'Error: custom event refused (too_long) [path]'
  ])
})

test('connecting with a Vinaya event declaration fails through the callback', () => {
  const { handle, errors, logs } = harness({ destination: { events: { 'vinaya.mine': { fields: {} } } } })
  handle.alive()
  expect(handle.settings).toBeUndefined()
  expect(errors).toHaveLength(1)
  expect(String(errors[0])).toContain('namespace is reserved')
  expect(logs.getFinishedLogRecords()).toEqual([])
})
