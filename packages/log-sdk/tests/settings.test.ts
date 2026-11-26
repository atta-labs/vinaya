import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from '../src/index.js'
import { defaultRuntimeDir, repoSegment, resolveSettings } from '../src/writer/settings.js'
import { harness } from './helpers.js'

const roots: string[] = []
function root(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'log-sdk-settings-'))
  roots.push(dir)
  mkdirSync(dir, { recursive: true })
  for (const [name, value] of Object.entries(files))
    writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value))
  return dir
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const settingsOf = (repoRoot: string, passed = {}) => {
  const r = resolveSettings({ repoRoot, repository: 'acme/widgets', vinayaHome: '/home/v/.vinaya', passed })
  if (!r.ok) throw r.error
  return r.settings
}

test('reads the optional OTLP address independently of the live destination', () => {
  const otlp = { url: 'https://collector.example', headers: { authorization: 'Bearer ${TOKEN}' } }
  for (const filename of ['log.config.json', 'vinaya.config.json']) {
    for (const destination of [{}, { folder: '/logs' }, { url: 'https://legacy.example' }]) {
      const logs = { ...destination, otlp }
      expect(settingsOf(root({ [filename]: { logs } })).logs).toEqual(logs)
    }
  }
  const invalid = root({ 'log.config.json': { logs: { otlp: { headers: otlp.headers } } } })
  expect(resolveSettings({ repoRoot: invalid })).toMatchObject({ ok: false })
})

test('passed values win, then log.config.json, then vinaya.config.json', () => {
  const dir = root({
    'vinaya.config.json': { logs: { url: 'https://v.example' }, runtimeDir: '/v' }
  })
  expect(settingsOf(dir)).toEqual({ logs: { url: 'https://v.example' }, runtimeDir: '/v', keepDays: 90 })
  expect(settingsOf(dir, { runtimeDir: '/p', destination: { folder: '/f' } })).toEqual({
    logs: { folder: '/f' },
    runtimeDir: '/p',
    keepDays: 90
  })
  expect(settingsOf(dir, { headers: { a: 'b' } }).logs).toEqual({ url: 'https://v.example', headers: { a: 'b' } })
})

test('log.config.json is the whole source when it exists', () => {
  const dir = root({
    'log.config.json': { logs: { folder: '/l' }, runtimeDir: '/lr' },
    'vinaya.config.json': { logs: false, runtimeDir: '/v' }
  })
  expect(settingsOf(dir)).toEqual({ logs: { folder: '/l' }, runtimeDir: '/lr', keepDays: 90 })
})

test('the default runtime directory is under the Vinaya home with the safe repository segment', () => {
  expect(settingsOf(root({})).runtimeDir).toBe('/home/v/.vinaya/runtime/acme-widgets')
  expect(repoSegment('a/../b')).toBe('unresolved')
  expect(repoSegment(undefined)).toBe('unresolved')
  expect(defaultRuntimeDir('o/r', '/h')).toBe('/h/runtime/o-r')
})

test('logs false gives a handle that records nothing', () => {
  const dir = root({ 'vinaya.config.json': { logs: false } })
  const h = harness({ repoRoot: dir })
  expect(h.handle.enabled).toBe(false)
  h.handle.run.started()
  h.handle.run.alive()
  h.handle.agent.sent({ seat: 'a' })
  h.handle.run.ended()
  expect(h.spans.getFinishedSpans()).toEqual([])
  expect(h.logs.getFinishedLogRecords()).toEqual([])
  expect(h.errors).toEqual([])
})

test('a bad log.config.json is reported, not thrown, and the handle records nothing', () => {
  const cases: Record<string, unknown> = {
    'unknown key': { logs: false, extra: 1 },
    'relative runtimeDir': { runtimeDir: 'relative/dir' },
    'headers without url': { logs: { folder: '/f', headers: { a: 'b' } } },
    'both folder and url': { logs: { folder: '/f', url: 'https://x.example' } },
    'invalid json': '{ nope'
  }
  for (const [label, content] of Object.entries(cases)) {
    const dir = root({ 'log.config.json': content })
    const h = harness({ repoRoot: dir })
    expect(h.errors.length, label).toBe(1)
    expect(h.handle.enabled, label).toBe(false)
    expect(() => h.handle.run.started(), label).not.toThrow()
    expect(h.spans.getFinishedSpans(), label).toEqual([])
  }
})

test('connect without custom processors does not throw', () => {
  const h = connect({ runId: 'r', repoRoot: root({}), runtimeDir: root({}) })
  expect(() => {
    h.run.started()
    h.run.ended()
  }).not.toThrow()
})

test('logs.keepDays is read from both settings files, and defaults to 90', () => {
  expect(settingsOf(root({})).keepDays).toBe(90)
  expect(settingsOf(root({ 'log.config.json': { logs: { keepDays: 30 } } })).keepDays).toBe(30)
  expect(settingsOf(root({ 'vinaya.config.json': { logs: { keepDays: 7 } } })).keepDays).toBe(7)
  expect(settingsOf(root({ 'vinaya.config.json': { logs: { folder: '/tmp/x', keepDays: 1 } } })).keepDays).toBe(1)
})

test('logs.keepDays below 1 or not whole is refused, naming the key', () => {
  for (const bad of [0, -3, 1.5, '30', null]) {
    for (const file of ['log.config.json', 'vinaya.config.json']) {
      const r = resolveSettings({ repoRoot: root({ [file]: { logs: { keepDays: bad } } }) })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.message).toContain('keepDays')
    }
  }
})

test('a passed keepDays replaces the file value and is checked too', () => {
  const dir = root({ 'log.config.json': { logs: { keepDays: 30 } } })
  expect(settingsOf(dir, { keepDays: 5 }).keepDays).toBe(5)
  expect(settingsOf(dir, { destination: { folder: '/tmp/x' } }).keepDays).toBe(30)
  expect(resolveSettings({ repoRoot: dir, passed: { keepDays: 0 } }).ok).toBe(false)
})
