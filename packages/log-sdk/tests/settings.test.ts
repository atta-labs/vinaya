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

test('passed values win, then log.config.json, then vinaya.config.json', () => {
  const dir = root({
    'vinaya.config.json': { logs: { url: 'https://v.example' }, runtimeDir: '/v' }
  })
  expect(settingsOf(dir)).toEqual({ logs: { url: 'https://v.example' }, runtimeDir: '/v' })
  expect(settingsOf(dir, { runtimeDir: '/p', destination: { folder: '/f' } })).toEqual({
    logs: { folder: '/f' },
    runtimeDir: '/p'
  })
  expect(settingsOf(dir, { headers: { a: 'b' } }).logs).toEqual({ url: 'https://v.example', headers: { a: 'b' } })
})

test('log.config.json is the whole source when it exists', () => {
  const dir = root({
    'log.config.json': { logs: { folder: '/l' }, runtimeDir: '/lr' },
    'vinaya.config.json': { logs: false, runtimeDir: '/v' }
  })
  expect(settingsOf(dir)).toEqual({ logs: { folder: '/l' }, runtimeDir: '/lr' })
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
