import { expect, test } from 'bun:test'
import { fixture } from './bin-fixture.js'

test('emit accepts the harness argument form and reports the configured server', () => {
  const repo = fixture({ url: 'https://example.invalid/logs', events: { 'acme.deploy': { fields: {} } } })
  try {
    const result = repo.call(['emit', 'acme.deploy', '--json', '{}'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe('vinaya log emit: recorded acme.deploy → server\n')
  } finally {
    repo.clean()
  }
})

test('emit records a declaration and reports usage errors and field-only refusals', async () => {
  const repo = fixture({ events: { 'acme.deploy': { fields: { count: 'number' } } } })
  try {
    const args = ['emit', '--run', 'test-run']
    const ok = repo.call([...args, 'acme.deploy'], '{"count":1}')
    expect(ok.exitCode).toBe(0)
    expect(ok.stdout.toString()).toBe('vinaya log emit: recorded acme.deploy → folder\n')
    for (const [name, body, reason] of [
      ['acme.other', '{}', 'undeclared'],
      ['acme.deploy', '{}', 'missing_field (fields: count)'],
      ['acme.deploy', '{"count":"private-value"}', 'wrong_type (fields: count)']
    ] as const) {
      const bad = repo.call([...args, name, '--json', body])
      expect(bad.exitCode).toBe(1)
      expect(bad.stderr.toString()).toContain(reason)
      expect(bad.stderr.toString()).not.toContain('private-value')
    }
    expect(repo.call(args).exitCode).toBe(2)
    expect(repo.call([...args, 'acme.deploy', '--json', '{"count":1}', '--task']).exitCode).toBe(2)
    expect(repo.call([...args, 'acme.deploy', '--json', '{']).exitCode).toBe(2)
    expect((await repo.read()).records.map((r) => r.name)).toEqual(['acme.deploy'])
  } finally {
    repo.clean()
  }
})
