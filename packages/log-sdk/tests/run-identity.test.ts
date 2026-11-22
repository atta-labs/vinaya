import { expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from '../src/index.js'
import { NO_SETTINGS_ROOT } from './helpers.js'

type Attribute = { key: string; value: { stringValue?: string; boolValue?: boolean } }
type Group = {
  resource: { attributes: Attribute[] }
  scopeLogs?: { logRecords: { eventName?: string; attributes: Attribute[] }[] }[]
  scopeSpans?: { spans: { name: string; attributes: Attribute[] }[] }[]
}

const IDENTITY_KEYS = [
  'vinaya.runner.name',
  'vinaya.runner.version',
  'vinaya.cli.version',
  'vinaya.flow.id',
  'vinaya.flow.version',
  'vinaya.process.digest',
  'vinaya.settings.digest'
]

function withCi<T>(value: string | undefined, fn: () => T): T {
  const before = process.env.CI
  if (value === undefined) delete process.env.CI
  else process.env.CI = value
  try {
    return fn()
  } finally {
    if (before === undefined) delete process.env.CI
    else process.env.CI = before
  }
}

/** Runs a run start and an agent turn through a handle and reads its local copy back. */
function write(identity: Record<string, string | boolean> | undefined, effort: string | undefined) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'log-sdk-identity-'))
  const errors: unknown[] = []
  const handle = connect({
    runId: 'run-1',
    repository: 'acme/widgets',
    repoRoot: NO_SETTINGS_ROOT,
    runtimeDir,
    ...(identity !== undefined ? { identity } : {}),
    onError: (e) => errors.push(e)
  })
  handle.run.started()
  handle.agent.sent({ seat: 'developer', ...(effort !== undefined ? { effort } : {}) })
  handle.agent.returned()
  handle.run.ended()
  expect(errors).toEqual([])
  const folder = join(runtimeDir, 'logs', 'acme-widgets')
  const groups: { kind: 'logs' | 'spans'; group: Group }[] = readdirSync(folder).flatMap((file) =>
    readFileSync(join(folder, file), 'utf8')
      .trimEnd()
      .split('\n')
      .flatMap((line) => {
        const doc = JSON.parse(line) as { resourceLogs?: Group[]; resourceSpans?: Group[] }
        return [
          ...(doc.resourceLogs ?? []).map((group) => ({ kind: 'logs' as const, group })),
          ...(doc.resourceSpans ?? []).map((group) => ({ kind: 'spans' as const, group }))
        ]
      })
  )
  rmSync(runtimeDir, { recursive: true, force: true })
  return groups
}

const value = (attributes: Attribute[], key: string) => attributes.find((a) => a.key === key)?.value

test('a run says what ran it', () => {
  const groups = withCi('true', () =>
    write(
      {
        runnerName: 'engine',
        runnerVersion: '1.2.3',
        cliVersion: '4.5.6',
        flowId: 'strict',
        flowVersion: '7',
        processDigest: 'sha256:aaa',
        settingsDigest: 'sha256:bbb'
      },
      'high'
    )
  )
  expect(groups.some((g) => g.kind === 'logs')).toBe(true)
  expect(groups.some((g) => g.kind === 'spans')).toBe(true)
  const expected: Record<string, string> = {
    'vinaya.runner.name': 'engine',
    'vinaya.runner.version': '1.2.3',
    'vinaya.cli.version': '4.5.6',
    'vinaya.flow.id': 'strict',
    'vinaya.flow.version': '7',
    'vinaya.process.digest': 'sha256:aaa',
    'vinaya.settings.digest': 'sha256:bbb'
  }
  for (const { group } of groups) {
    for (const [key, text] of Object.entries(expected)) {
      expect(value(group.resource.attributes, key)).toEqual({ stringValue: text })
    }
    expect(typeof value(group.resource.attributes, 'os.type')?.stringValue).toBe('string')
    expect(value(group.resource.attributes, 'vinaya.ci')).toEqual({ boolValue: true })
  }
  const events = groups.flatMap((g) => g.group.scopeLogs?.flatMap((s) => s.logRecords) ?? [])
  const spans = groups.flatMap((g) => g.group.scopeSpans?.flatMap((s) => s.spans) ?? [])
  const started = events.find((e) => e.eventName === 'vinaya.agent.started')
  const span = spans.find((s) => s.name === 'invoke_agent developer')
  expect(value(started?.attributes ?? [], 'vinaya.agent.effort')).toEqual({ stringValue: 'high' })
  expect(value(span?.attributes ?? [], 'vinaya.agent.effort')).toEqual({ stringValue: 'high' })
})

test('a handle with no identity parts writes none of them and no effort', () => {
  const groups = withCi(undefined, () => write(undefined, undefined))
  expect(groups.length).toBeGreaterThan(0)
  for (const { group } of groups) {
    for (const key of IDENTITY_KEYS) expect(value(group.resource.attributes, key)).toBeUndefined()
    expect(typeof value(group.resource.attributes, 'os.type')?.stringValue).toBe('string')
    expect(value(group.resource.attributes, 'vinaya.ci')).toEqual({ boolValue: false })
    for (const record of [
      ...(group.scopeLogs?.flatMap((s) => s.logRecords) ?? []),
      ...(group.scopeSpans?.flatMap((s) => s.spans) ?? [])
    ]) {
      expect(value(record.attributes, 'vinaya.agent.effort')).toBeUndefined()
    }
  }
})

test('CI empty or false is not CI, and a caller answer wins', () => {
  for (const ci of ['', 'false']) {
    const groups = withCi(ci, () => write(undefined, undefined))
    expect(value(groups[0]?.group.resource.attributes ?? [], 'vinaya.ci')).toEqual({ boolValue: false })
  }
  const groups = withCi('true', () => write({ ci: false }, undefined))
  expect(value(groups[0]?.group.resource.attributes ?? [], 'vinaya.ci')).toEqual({ boolValue: false })
})
