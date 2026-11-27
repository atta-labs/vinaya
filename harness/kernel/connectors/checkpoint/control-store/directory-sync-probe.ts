// Run as its own process by `local.test.ts`: it wraps `node:fs` so that every
// directory sync is recorded, and one chosen directory's sync can be made to
// throw. The wrapper is process-wide, so it lives in a child process and never
// reaches another test. It prints one JSON report of what the store synced.
import { mock } from 'bun:test'
import * as fsNamespace from 'node:fs'
import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A copy taken before the mock is installed, so the wrapper never calls itself.
const realFs = { ...fsNamespace }
const openPaths = new Map<number, string>()
const syncedDirs: string[] = []
let failSyncOf: string | null = null

mock.module('node:fs', () => ({
  ...realFs,
  openSync: (path: unknown, ...rest: unknown[]) => {
    const fd = (realFs.openSync as (...a: unknown[]) => number)(path, ...rest)
    if (typeof path === 'string') openPaths.set(fd, path)
    return fd
  },
  fsyncSync: (fd: number) => {
    const path = openPaths.get(fd)
    if (path !== undefined && realFs.statSync(path).isDirectory()) {
      if (path === failSyncOf) throw Object.assign(new Error('injected directory sync failure'), { code: 'EIO' })
      syncedDirs.push(path)
    }
    return realFs.fsyncSync(fd)
  }
}))

const store = await import('./local')

const root = mkdtempSync(join(tmpdir(), 'control-store-probe-'))
const outside = mkdtempSync(join(tmpdir(), 'control-store-outside-'))
const deps = { root: () => root, now: () => new Date('2026-09-14T00:00:00.000Z'), pid: () => 4242, hostname: () => 'h' }
const take = (): string[] => syncedDirs.splice(0)
const errorOf = (fn: () => unknown): string | null => {
  try {
    fn()
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

try {
  const claim = store.acquireOwnership(deps, 551, 'run-a')
  if (!claim.acquired) throw new Error('expected the claim')
  const claimSynced = take()
  const run = { runId: 'run-a', pid: 100, host: 'box', startedAt: '2026-09-14T00:00:00.000Z' }
  store.writeRun(deps, 551, claim.epoch, run)
  const runSynced = take()

  store.mkdirNoSymlinks(join(root, 'a', 'b'), 0o700, root)
  const createdSynced = take()
  store.mkdirNoSymlinks(join(root, 'a', 'b'), 0o700, root)
  const existingSynced = take()
  const target = join(outside, 'x', 'y')
  store.mkdirNoSymlinks(target, 0o700, join(root, 'a'))
  const outsideSynced = take()
  const outsideCreated = existsSync(target)

  const runDir = join(root, '551', 'control', 'run')
  const ownershipDir = join(root, '551', 'control', 'ownership')
  failSyncOf = runDir
  const runError = errorOf(() => store.writeRun(deps, 551, claim.epoch, run))
  const runStatus = store.readRun(deps, 551, 'run-a').status
  const runFiles = readdirSync(runDir)
  failSyncOf = ownershipDir
  const claimError = errorOf(() => store.attemptEpochClaim(deps, 551, 2, 'x'))
  const ownershipFiles = readdirSync(ownershipDir).sort()
  failSyncOf = null

  console.log(
    `REPORT:${JSON.stringify({
      root,
      claimSynced,
      runSynced,
      createdSynced,
      existingSynced,
      outsideSynced,
      outsideCreated,
      runError,
      runStatus,
      runFiles,
      claimError,
      ownershipFiles
    })}`
  )
} finally {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
}
