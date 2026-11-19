import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from '../src/index.js'
import { createFileExporters } from '../src/local-copy/file-exporters.js'

test('an oversized repository component falls back in both default directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'log-sdk-long-repo-'))
  try {
    const vinayaHome = join(root, 'home')
    const errors: unknown[] = []
    const handle = connect({
      runId: 'long-repo',
      repository: `${'a'.repeat(128)}/${'b'.repeat(127)}`,
      repoRoot: join(root, 'repo'),
      vinayaHome,
      onError: (error) => errors.push(error)
    })
    handle.run.alive()
    expect(errors).toEqual([])
    expect(readdirSync(join(vinayaHome, 'runtime', 'unresolved', 'logs', 'unresolved'))).toEqual([
      `long-repo~${handle.writerId}~000000000000.logs.jsonl`
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a run ID that leaves no room for the file suffix falls back to unresolved', () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'log-sdk-long-run-'))
  try {
    const handle = connect({ runId: 'a'.repeat(200), runtimeDir, repoRoot: join(runtimeDir, 'repo') })
    handle.run.started()
    handle.run.ended()
    const files = readdirSync(join(runtimeDir, 'logs', 'unresolved')).sort()
    expect(files).toEqual([
      `unresolved~${handle.writerId}~000000000000.logs.jsonl`,
      `unresolved~${handle.writerId}~000000000001.traces.jsonl`
    ])
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true })
  }
})

test('configured folders win unless they resolve inside the repository', () => {
  const root = mkdtempSync(join(tmpdir(), 'log-sdk-paths-'))
  try {
    const repoRoot = join(root, 'repo')
    const runtimeDir = join(root, 'runtime')
    const configured = join(root, 'configured')
    const inside = join(repoRoot, 'logs')
    const alias = join(root, 'alias')
    mkdirSync(inside, { recursive: true })
    symlinkSync(inside, alias, 'dir')
    const errors: unknown[] = []
    const base = { repository: 'acme/widgets', repoRoot, runtimeDir, onError: (error: unknown) => errors.push(error) }
    writeFileSync(join(repoRoot, 'log.config.json'), JSON.stringify({ logs: { folder: configured } }))
    connect({ ...base, runId: 'configured' }).run.alive()
    expect(readdirSync(join(configured, 'acme-widgets'))).toHaveLength(1)
    connect({ ...base, runId: 'inside', destination: { folder: inside } }).run.alive()
    connect({ ...base, runId: 'alias', destination: { folder: join(alias, 'new') } }).run.alive()
    connect({ ...base, runId: 'default', destination: {} }).run.alive()
    expect(
      readdirSync(join(runtimeDir, 'logs', 'acme-widgets'))
        .sort()
        .map((file) => file.split('~')[0])
    ).toEqual(['alias', 'default', 'inside'])
    expect(readdirSync(inside)).toEqual([])
    expect(errors).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('unsafe segments use unresolved or report the unsafe writer', () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'log-sdk-segments-'))
  try {
    const repoRoot = join(runtimeDir, 'repo')
    const errors: unknown[] = []
    const base = { runtimeDir, repoRoot, onError: (error: unknown) => errors.push(error) }
    connect({ ...base, runId: 'bad-owner', repository: '../widgets' }).run.alive()
    connect({ ...base, runId: 'bad-repo', repository: 'acme/a..b' }).run.alive()
    connect({ ...base, runId: '../run', repository: 'acme/widgets' }).run.alive()
    expect(
      readdirSync(join(runtimeDir, 'logs', 'unresolved'))
        .sort()
        .map((file) => file.split('~')[0])
    ).toEqual(['bad-owner', 'bad-repo'])
    expect(readdirSync(join(runtimeDir, 'logs', 'acme-widgets'))[0]).toStartWith('unresolved~')

    const handle = connect({
      ...base,
      runId: 'unsafe-writer',
      repository: 'acme/widgets',
      logRecordProcessors: [
        {
          onEmit(record) {
            createFileExporters({
              runId: 'unsafe-writer',
              writerId: '../writer',
              repoRoot,
              repository: 'unsafe/writer',
              settings: { runtimeDir, logs: undefined }
            }).logs.export([record], (result) => {
              if (result.error) errors.push(result.error)
            })
          },
          async forceFlush() {},
          async shutdown() {}
        }
      ]
    })
    handle.run.alive()
    expect(errors).toEqual([expect.objectContaining({ message: 'Unsafe Log writer identifier' })])
    expect(existsSync(join(runtimeDir, 'logs', 'unsafe-writer'))).toBe(false)
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true })
  }
})
