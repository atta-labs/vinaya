import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readCurrentOwnership, type AcquireResult } from './local'

// `local.test.ts`'s own race fixture calls `attemptEpochClaim` twice,
// sequentially, inside one process, both times naming the SAME fixed
// epoch: it proves the exclusive-publish primitive picks exactly one
// winner for two callers that truly observed the same starting state, but
// a single process never overlaps two syscalls, so it cannot exercise the
// window a real concurrent writer could hit. This suite instead spawns
// real, separate OS processes, each importing and calling the SHIPPED
// `acquireOwnership` (`local.ts`) directly — the real public entry point
// whose own retry loop drives `attemptEpochClaim`, which in turn drives
// `exclusiveCreateFile` — never a hand-duplicated stand-in for any of that
// chain, so a future edit reintroducing a race anywhere in it is exercised
// by this exact fixture.
//
// Real OS scheduling rarely lines every racer up on the exact same
// starting epoch — most legitimately take over the next epoch in sequence,
// which is correct, not a race loss — so this suite does not assert "one
// winner among N". It asserts the invariant a race would actually violate:
// no two racers ever end up agreeing they hold the SAME epoch, and the
// disk's own current record always matches whichever racer really holds
// the highest one.

const workerPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'tests',
  'fixtures',
  'exclusive-create-race-worker.ts'
)

function runWorker(rootDir: string, task: number, ownerId: string): Promise<AcquireResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', [workerPath, rootDir, String(task), ownerId], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`worker exited ${code}: ${stderr}`))
        return
      }
      resolve(JSON.parse(stdout.trim()) as AcquireResult)
    })
  })
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'control-store-race-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('acquireOwnership, under genuine multi-process concurrency', () => {
  it('no two real, concurrently-racing OS processes ever acquire the same epoch, and the disk record matches the true highest winner exactly', async () => {
    const task = 551
    const racers = ['owner-a', 'owner-b', 'owner-c', 'owner-d', 'owner-e', 'owner-f']

    const results = await Promise.all(racers.map((ownerId) => runWorker(dir, task, ownerId)))
    expect(results).toHaveLength(racers.length)

    const winners = results.filter((r): r is Extract<AcquireResult, { acquired: true }> => r.acquired)
    expect(winners.length).toBeGreaterThan(0)

    // The core anti-double-ownership invariant: every winner's epoch is
    // unique. A duplicate here is exactly the original defect — two
    // processes each believing they hold the same epoch.
    const epochs = winners.map((w) => w.epoch)
    expect(new Set(epochs).size).toBe(epochs.length)

    // Each winner's own returned record is internally consistent — never a
    // record whose epoch or ownerId drifted from what that call believes it
    // published (the exact divergence a torn-write race could cause).
    for (const winner of winners) {
      expect(winner.record.epoch).toBe(winner.epoch)
    }

    const highest = winners.reduce((max, w) => (w.epoch > max.epoch ? w : max))

    // Every loser names a real epoch that some real winner actually holds
    // — never a phantom epoch nobody claimed.
    for (const result of results) {
      if (result.acquired) continue
      expect(epochs).toContain(result.currentEpoch)
    }

    // The on-disk record — read fresh, independent of anything any racer
    // reported — matches the true highest winner exactly, and no corrupt
    // epoch slot was left behind.
    const onDisk = readCurrentOwnership({ root: () => dir }, task)
    expect(onDisk.epoch).toBe(highest.epoch)
    expect(onDisk.record?.ownerId).toBe(highest.record.ownerId)
    expect(onDisk.corruptEpochs).toEqual([])
  })
})
