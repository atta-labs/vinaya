import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { harness } from './helpers.js'

const temp = mkdtempSync(join(tmpdir(), 'log-sdk-custom-'))
afterAll(() => rmSync(temp, { recursive: true, force: true }))

function connectWithFileDeclaration(name: string) {
  const repoRoot = mkdtempSync(join(temp, 'repo-'))
  writeFileSync(
    join(repoRoot, 'vinaya.config.json'),
    JSON.stringify({ logs: { events: { [name]: { fields: { count: 'number' } } } } })
  )
  return harness({ repoRoot, destination: { folder: join(temp, 'logs') } })
}

test('a destination override retains declarations from the config file', () => {
  const { handle, logs, errors } = connectWithFileDeclaration('team.checked')
  handle.custom('team.checked', { count: 2 })
  const [event] = logs.getFinishedLogRecords()
  expect(event?.eventName).toBe('team.checked')
  expect(event?.attributes.count).toBe(2)
  expect(errors).toEqual([])
})

test('a destination override cannot hide a reserved declaration from the config file', () => {
  const { handle, logs, errors } = connectWithFileDeclaration('vinaya.mine')
  handle.alive()
  expect(errors).toHaveLength(1)
  expect(String(errors[0])).toContain('namespace is reserved')
  expect(logs.getFinishedLogRecords()).toEqual([])
})

test('custom validation and emission use the same snapshot of field values', () => {
  const { handle, logs, errors } = connectWithFileDeclaration('team.checked')
  let reads = 0
  handle.custom('team.checked', {
    get count() {
      return ++reads
    }
  })
  expect(reads).toBe(1)
  expect(logs.getFinishedLogRecords()[0]?.attributes.count).toBe(1)
  expect(errors).toEqual([])
})

test('structural refusals take precedence without reading any field values', () => {
  const { handle, logs, errors } = connectWithFileDeclaration('team.checked')
  let reads = 0
  const fields = {
    get extra() {
      reads += 1
      throw new Error('private value')
    }
  }
  handle.custom('team.undeclared', fields)
  handle.custom('team.checked', fields)
  handle.custom('team.checked', {
    count: 1,
    get extra() {
      return fields.extra
    }
  })
  expect(reads).toBe(0)
  expect(errors.map(String)).toEqual([
    'Error: custom event refused (undeclared) []',
    'Error: custom event refused (missing_field) [count]',
    'Error: custom event refused (extra_field) [extra]'
  ])
  expect(logs.getFinishedLogRecords()).toEqual([])
})

test('unreadable custom fields produce value-free refusals', () => {
  const { handle, logs, errors } = connectWithFileDeclaration('team.checked')
  handle.custom('team.checked', {
    get count() {
      throw new Error('private value')
    }
  })
  expect(errors.map(String)).toEqual(['Error: custom event refused (wrong_type) [count]'])
  expect(logs.getFinishedLogRecords()).toEqual([])
})

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
