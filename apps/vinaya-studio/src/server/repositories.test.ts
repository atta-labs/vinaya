import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseLaunchContext, repositoryViews, resolveStudioRepositories } from './repositories.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A repository root holding the given `vinaya.config.json` text, or none. */
function checkout(config: string | null): string {
  const root = mkdtempSync(join(tmpdir(), 'studio-repo-'))
  roots.push(root)
  if (config !== null) writeFileSync(join(root, 'vinaya.config.json'), config)
  return root
}

const home = '/home/someone/.vinaya'
const remote = { owner: 'acme', repo: 'widgets' }

describe('resolveStudioRepositories', () => {
  test('a repository with no logs setting reads the default local folder for its own identity', () => {
    const root = checkout('{}')
    const [repo] = resolveStudioRepositories([{ root, remote }], { env: {}, home })
    expect(repo?.source).toEqual({
      ok: true,
      spec: {
        kind: 'folder',
        folderRoot: join(home, 'runtime', 'acme-widgets', 'logs'),
        repoDir: join(home, 'runtime', 'acme-widgets', 'logs', 'acme-widgets')
      }
    })
  })

  test('a configured folder is used as written', () => {
    const root = checkout(JSON.stringify({ logs: { folder: '/var/vinaya/logs' } }))
    const [repo] = resolveStudioRepositories([{ root, remote }], { env: {}, home })
    expect(repo?.source).toEqual({
      ok: true,
      spec: { kind: 'folder', folderRoot: '/var/vinaya/logs', repoDir: join('/var/vinaya/logs', 'acme-widgets') }
    })
  })

  test('two selected roots each resolve under their own configuration, in one call', () => {
    const a = checkout(JSON.stringify({ logs: { folder: '/logs/a' } }))
    const b = checkout(JSON.stringify({ logs: { url: 'https://log.example/r/events' } }))
    const repos = resolveStudioRepositories(
      [
        { root: a, remote: { owner: 'o', repo: 'a' } },
        { root: b, remote: { owner: 'o', repo: 'b' } }
      ],
      { env: {}, home }
    )
    expect(repos.map((r) => (r.source.ok ? r.source.spec.kind : r.source.code))).toEqual(['folder', 'server'])
  })

  test('a server destination keeps the raw read headers and never the ingest headers', () => {
    const root = checkout(
      JSON.stringify({
        logs: {
          url: 'https://log.example/r/events',
          headers: { authorization: 'Bearer ${VINAYA_LOG_TOKEN}' },
          readHeaders: { authorization: 'Bearer ${VINAYA_LOG_READ_TOKEN}' }
        }
      })
    )
    const [repo] = resolveStudioRepositories([{ root, remote }], {
      env: { VINAYA_LOG_READ_TOKEN: 'read-secret' },
      home
    })
    expect(repo?.source).toEqual({
      ok: true,
      spec: {
        kind: 'server',
        url: 'https://log.example/r/events',
        readHeaders: { authorization: 'Bearer ${VINAYA_LOG_READ_TOKEN}' }
      }
    })
    expect(JSON.stringify(repo)).not.toContain('VINAYA_LOG_TOKEN')
    expect(JSON.stringify(repositoryViews(repo ? [repo] : []))).not.toContain('read-secret')
  })

  test('a missing read credential is reported by name, never falls back to a folder, and shows no value', () => {
    const root = checkout(
      JSON.stringify({
        logs: { url: 'https://log.example/r/events', readHeaders: { authorization: 'Bearer ${VINAYA_LOG_READ_TOKEN}' } }
      })
    )
    const [repo] = resolveStudioRepositories([{ root, remote }], { env: { VINAYA_LOG_TOKEN: 'ingest-secret' }, home })
    expect(repo?.source.ok).toBe(false)
    if (repo?.source.ok === false) {
      expect(repo.source.code).toBe('missing_read_credential')
      expect(repo.source.message).toContain('VINAYA_LOG_READ_TOKEN')
      expect(repo.source.message).not.toContain('ingest-secret')
    }
    expect(JSON.stringify(repositoryViews(repo ? [repo] : []))).not.toContain('ingest-secret')
  })

  test('an invalid configuration is reported, not replaced by the default folder', () => {
    const notJson = checkout('{ nope')
    const badSchema = checkout(JSON.stringify({ logs: { folder: 'relative/path' } }))
    const both = checkout(JSON.stringify({ logs: { folder: '/x', url: 'https://log.example/events' } }))
    for (const root of [notJson, badSchema, both]) {
      const [repo] = resolveStudioRepositories([{ root, remote }], { env: {}, home })
      expect(repo?.source.ok).toBe(false)
      if (repo?.source.ok === false) expect(repo.source.code).toBe('invalid_config')
    }
  })

  test('logs: false is reported as disabled', () => {
    const [repo] = resolveStudioRepositories([{ root: checkout('{"logs":false}'), remote }], { env: {}, home })
    expect(repo?.source).toMatchObject({ ok: false, code: 'logs_disabled' })
  })

  test('a repository with no remote reads the unresolved folder', () => {
    const root = checkout('{}')
    const [repo] = resolveStudioRepositories([{ root, remote: null }], { env: {}, home })
    expect(repo?.source).toMatchObject({
      ok: true,
      spec: { kind: 'folder', repoDir: expect.stringContaining('unresolved') }
    })
  })

  test('resolving never changes the working directory', () => {
    const before = process.cwd()
    resolveStudioRepositories([{ root: checkout('{}'), remote }], { env: {}, home })
    expect(process.cwd()).toBe(before)
  })
})

describe('parseLaunchContext', () => {
  const secret = 'A'.repeat(43)

  test('reads the launcher document', () => {
    expect(parseLaunchContext(JSON.stringify({ secret, repositories: [{ root: '/r', remote }] }))).toEqual({
      secret,
      repositories: [{ root: '/r', remote }]
    })
  })

  test('refuses what is not a launcher document', () => {
    for (const text of [
      'nope',
      '{}',
      JSON.stringify({ secret, repositories: [] }),
      JSON.stringify({ secret, repositories: [{ root: 'relative', remote: null }] }),
      JSON.stringify({ secret, repositories: [{ root: '/r', remote: { owner: 1 } }] })
    ]) {
      expect(() => parseLaunchContext(text)).toThrow()
    }
  })
})
