import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// `local.test.ts`'s own race fixture calls `attemptEpochClaim` twice,
// sequentially, inside one process: it proves the exclusive-publish
// primitive picks exactly one winner, but a single process never truly
// overlaps two syscalls, so it cannot exercise the window a real concurrent
// writer could hit — a second process opening a target file between another
// process's `open` and its content write, before that write completes.
// This suite spawns real, separate OS processes racing the exact
// write-then-link sequence `exclusiveCreateFile` (`local.ts`) uses to
// publish a file exclusively, to prove that sequence race-free under
// genuine concurrency rather than a synchronous stand-in for it.

const workerPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'tests',
  'fixtures',
  'exclusive-create-race-worker.mjs'
)

function runWorker(
  targetPath: string,
  content: string,
  ownerId: string
): Promise<{ outcome: string; ownerId: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, targetPath, content, ownerId], {
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
      resolve(JSON.parse(stdout.trim()))
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

describe('exclusiveCreateFile publish, under genuine multi-process concurrency', () => {
  it('exactly one of several real, concurrently-racing OS processes wins, and the published file matches the winner exactly — never a torn or divergent write', async () => {
    const target = join(dir, 'contested.json')
    const racers = ['owner-a', 'owner-b', 'owner-c', 'owner-d', 'owner-e', 'owner-f']

    const results = await Promise.all(
      racers.map((ownerId) => runWorker(target, JSON.stringify({ ownerId, content: 'x'.repeat(2000) }), ownerId))
    )

    const winners = results.filter((r) => r.outcome === 'won')
    const losers = results.filter((r) => r.outcome === 'lost')
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(racers.length - 1)

    // The file on disk is complete, parseable JSON — never partial — and
    // names exactly the reported winner, never a different racer's
    // content and never a mix of two racers' writes.
    const onDisk = JSON.parse(readFileSync(target, 'utf8')) as { ownerId: string; content: string }
    expect(onDisk.ownerId).toBe(winners[0]?.ownerId)
    expect(onDisk.content).toBe('x'.repeat(2000))
  })
})
