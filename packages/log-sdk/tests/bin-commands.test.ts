import { expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { commands } from '../src/bin/commands.js'
import { connect } from '../src/writer/connect.js'
import { fixture } from './bin-fixture.js'

test('every SDK subject function has exactly one command', async () => {
  const handle = connect({ runId: 'coverage', destination: false })
  const methods = Object.entries(handle).flatMap(([group, value]) =>
    group === 'settings' || value === null || typeof value !== 'object'
      ? []
      : Object.entries(value)
          .filter(([, fn]) => typeof fn === 'function')
          .map(([method]) => group + '.' + method)
  )
  expect([...commands.values()].map(({ group, method }) => group + '.' + method).sort()).toEqual(methods.sort())
  await handle.shutdown()
})

test('each command invocation writes its own file and sequence', async () => {
  const repo = fixture()
  try {
    expect(repo.call(['change', 'merged', '--run', 'test-run', '--json', '{}']).exitCode).toBe(0)
    expect(repo.call(['run', 'alive', '--run', 'test-run'], '{}').exitCode).toBe(0)
    const { records } = await repo.read()
    expect(records.map((record) => record.name).sort()).toEqual(['vinaya.change.merged', 'vinaya.run.alive'])
    expect(records.map((record) => record.seq)).toEqual([1, 1])
    expect(new Set(records.map((record) => record.writerId)).size).toBe(2)
    expect(records.every((record) => record.provenance === 'reported')).toBe(true)
    expect(readdirSync(repo.folder)).toHaveLength(2)
  } finally {
    repo.clean()
  }
})
