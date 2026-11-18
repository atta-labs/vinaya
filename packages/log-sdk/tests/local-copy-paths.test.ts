import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from '../src/index.js'
import { createFileExporters } from '../src/local-copy/file-exporters.js'

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
    connect({ ...base, runId: 'configured' }).alive()
    expect(readdirSync(join(configured, 'acme-widgets'))).toHaveLength(1)
    connect({ ...base, runId: 'inside', destination: { folder: inside } }).alive()
    connect({ ...base, runId: 'alias', destination: { folder: join(alias, 'new') } }).alive()
    connect({ ...base, runId: 'default', destination: {} }).alive()
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
    connect({ ...base, runId: 'bad-owner', repository: '../widgets' }).alive()
    connect({ ...base, runId: 'bad-repo', repository: 'acme/a..b' }).alive()
    connect({ ...base, runId: '../run', repository: 'acme/widgets' }).alive()
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
    handle.alive()
    expect(errors).toEqual([expect.objectContaining({ message: 'Unsafe Log writer identifier' })])
    expect(existsSync(join(runtimeDir, 'logs', 'unsafe-writer'))).toBe(false)
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true })
  }
})
