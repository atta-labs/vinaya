import { describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSyncBudgeted, stripVinayaEnv } from '../conformance/unit/process-fixture.js'
import { WITH_DEADLINE_GRACE_MS, withDeadline } from './log-sink.js'

// `withDeadline` under Node (which runs the published command line) and Bun.

describe('withDeadline', () => {
  it('keeps work that finished before a deadline the busy process then missed (Node)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-with-deadline-'))
    const entry = join(dir, 'entry.ts')
    writeFileSync(
      entry,
      `import { execFileSync, spawn } from 'node:child_process'
import { withDeadline } from ${JSON.stringify(join(import.meta.dir, 'log-sink.ts'))}
const work = new Promise<string>((resolve) => {
  const child = spawn('sleep', ['0.2'], { stdio: 'ignore' })
  child.on('exit', () => resolve('value'))
})
const answer = withDeadline(work, 1000, 'fallback')
execFileSync('sleep', ['2'])
console.log(await answer)
`
    )
    const built = await Bun.build({ entrypoints: [entry], target: 'node', format: 'esm', outdir: join(dir, 'out') })
    expect(built.success).toBe(true)
    const r = spawnSyncBudgeted('node', [built.outputs[0]?.path as string], {
      encoding: 'utf8',
      env: stripVinayaEnv()
    })
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('value')
  }, 20_000)

  it('gives the fallback no later than the deadline plus the grace for work that never finishes (Bun)', async () => {
    const keepAlive = setInterval(() => {}, 50)
    try {
      const start = Date.now()
      const answer = await withDeadline(new Promise<string>(() => {}), 200, 'fallback')
      const took = Date.now() - start
      expect(answer).toBe('fallback')
      expect(took).toBeLessThan(200 + WITH_DEADLINE_GRACE_MS + 150)
    } finally {
      clearInterval(keepAlive)
    }
  })

  it('gives the fallback at once for work that rejects before the deadline (Bun)', async () => {
    const start = Date.now()
    const answer = await withDeadline(Promise.reject(new Error('no')), 5000, 'fallback')
    expect(answer).toBe('fallback')
    expect(Date.now() - start).toBeLessThan(500)
  })

  it('keeps the grace at or under 250ms', () => {
    expect(WITH_DEADLINE_GRACE_MS).toBeLessThanOrEqual(250)
  })
})
