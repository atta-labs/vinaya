import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogSink, OUTBOX_MAX_BYTES, type LogSinkDeps } from '../../src/lib/log-sink.js'

// `resolveDoctrine`'s `git` calls run inside `log()`'s `.then()` chain; in a
// non-repo temp dir the first call fails (fast, but not instant), and a
// `setImmediate` racing that isn't reliable — a longer real delay is.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 100))

const DISPATCHED = {
  kind: 'dispatch' as const,
  event: 'dispatched' as const,
  payload: {},
  target_role: 'developer' as const,
  model: 'sonnet',
  effect_id: 'e1',
  prompt_hash: 'sha256:abc'
}

function testDeps(overrides: Partial<LogSinkDeps> = {}): { dir: string; deps: Partial<LogSinkDeps> } {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-log-sink-'))
  return {
    dir,
    deps: {
      outboxRoot: () => join(dir, 'outbox'),
      home: () => dir,
      hostname: () => 'test-host',
      cwd: () => dir,
      now: () => new Date('2026-09-05T00:00:00.000Z'),
      env: () => ({ VINAYA_ROLE: 'developer', VINAYA_TASK: '404' }),
      resolveRepo: () => Promise.resolve({ owner: 'atta-labs', repo: 'vinaya' }),
      vinayaVersion: () => '0.24.1',
      stderr: () => {},
      ...overrides
    }
  }
}

describe('log-sink — a valid line', () => {
  it('appends one ndjson line whose meta/subject are filled from the injected environment', async () => {
    const { dir, deps } = testDeps()
    const { log } = createLogSink(deps)
    log(DISPATCHED)
    await flush()
    const path = join(dir, 'outbox', 'atta-labs-vinaya', '404.ndjson')
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]!)
    expect(parsed.subject.role).toBe('developer')
    expect(parsed.subject.issue).toBe(404)
    expect(parsed.meta.repo).toBe('atta-labs/vinaya')
    expect(parsed.meta.host).toBe('cli')
  })

  it('two calls in the same millisecond each carry a distinct, correctly-assigned seq', async () => {
    // `seq` is assigned synchronously at call time (call order), not at
    // write time — two overlapping async appends are not guaranteed to
    // land in that order, which is exactly why a reader sorts by `seq`
    // instead of trusting file position (spec §19's `(run_id, seq)` key).
    const { dir, deps } = testDeps()
    const { log } = createLogSink(deps)
    log(DISPATCHED)
    log(DISPATCHED)
    await flush()
    const path = join(dir, 'outbox', 'atta-labs-vinaya', '404.ndjson')
    const lines = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    const seqs = lines.map((l) => l.meta.seq).sort((a, b) => a - b)
    expect(seqs).toEqual([0, 1])
  })
})

describe('log-sink — defeat cases', () => {
  it('refuses an invalid payload without writing anything', async () => {
    const { dir, deps } = testDeps()
    const { log } = createLogSink(deps)
    log({ ...DISPATCHED, extraKey: 'not allowed' } as never)
    await flush()
    expect(() => statSync(join(dir, 'outbox'))).toThrow()
  })

  it('refuses a symlinked outbox target — writes nothing', async () => {
    const { dir, deps } = testDeps()
    const outboxDir = join(dir, 'outbox', 'atta-labs-vinaya')
    const elsewhere = join(dir, 'elsewhere.ndjson')
    writeFileSync(elsewhere, 'pre-existing\n')
    mkdirSync(outboxDir, { recursive: true })
    symlinkSync(elsewhere, join(outboxDir, '404.ndjson'))

    const { log } = createLogSink(deps)
    log(DISPATCHED)
    await flush()
    expect(readFileSync(elsewhere, 'utf8')).toBe('pre-existing\n')
  })

  it('rotates the file to .1.ndjson once it is at the cap, then appends fresh', async () => {
    const { dir, deps } = testDeps()
    const outboxDir = join(dir, 'outbox', 'atta-labs-vinaya')
    mkdirSync(outboxDir, { recursive: true })
    const target = join(outboxDir, '404.ndjson')
    writeFileSync(target, 'x'.repeat(OUTBOX_MAX_BYTES + 1))

    const { log } = createLogSink(deps)
    log(DISPATCHED)
    await flush()
    const rotated = readFileSync(join(outboxDir, '404.1.ndjson'), 'utf8')
    expect(rotated.length).toBe(OUTBOX_MAX_BYTES + 1)
    const fresh = readFileSync(target, 'utf8').trim().split('\n')
    expect(fresh).toHaveLength(1)
  })

  it('reports dropped identities via one stderr line when rotation overwrites an existing .1.ndjson backup', async () => {
    const { dir, deps } = testDeps()
    const outboxDir = join(dir, 'outbox', 'atta-labs-vinaya')
    mkdirSync(outboxDir, { recursive: true })
    const target = join(outboxDir, '404.ndjson')
    const backup = join(outboxDir, '404.1.ndjson')
    const existingLine = JSON.stringify({
      meta: {
        schema: 1,
        ts: '2026-09-05T00:00:00.000Z',
        run_id: 'priorRun',
        seq: 7,
        repo: null,
        vinaya: '0.0.0',
        doctrine: 'unknown',
        host: 'cli',
        machine: 'deadbeef'
      },
      subject: { issue: 404, role: 'developer' },
      kind: 'forge_write',
      event: 'validated',
      payload: {},
      op: 'issue.comment',
      target: { issue: 404 }
    })
    writeFileSync(backup, `${existingLine}\n`)
    writeFileSync(target, 'x'.repeat(OUTBOX_MAX_BYTES + 1))

    const messages: string[] = []
    const { log } = createLogSink({ ...deps, stderr: (m) => messages.push(m) })
    log(DISPATCHED)
    await flush()

    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('1 record(s) permanently lost')
    expect(messages[0]).toContain('priorRun:7')
  })

  it('reports nothing on the first-ever rotation — there is no prior backup to lose', async () => {
    const { dir, deps } = testDeps()
    const outboxDir = join(dir, 'outbox', 'atta-labs-vinaya')
    mkdirSync(outboxDir, { recursive: true })
    const target = join(outboxDir, '404.ndjson')
    writeFileSync(target, 'x'.repeat(OUTBOX_MAX_BYTES + 1))

    const messages: string[] = []
    const { log } = createLogSink({ ...deps, stderr: (m) => messages.push(m) })
    log(DISPATCHED)
    await flush()

    expect(messages).toHaveLength(0)
  })

  it('never throws when the outbox directory cannot be created — one stderr line, no exception', async () => {
    const { dir, deps } = testDeps()
    // A file where a directory needs to go: mkdirSync will fail with ENOTDIR.
    const blocker = join(dir, 'outbox')
    writeFileSync(blocker, 'not a directory')
    let stderrCalls = 0
    const { log } = createLogSink({
      ...deps,
      stderr: () => {
        stderrCalls++
      }
    })
    expect(() => log(DISPATCHED)).not.toThrow()
    await flush()
    expect(stderrCalls).toBe(1)
  })

  it('resolveRepo() returning null writes under outbox/unresolved with meta.repo: null', async () => {
    const { dir, deps } = testDeps({ resolveRepo: () => Promise.resolve(null) })
    const { log } = createLogSink(deps)
    log(DISPATCHED)
    await flush()
    const path = join(dir, 'outbox', 'unresolved', '404.ndjson')
    const line = JSON.parse(readFileSync(path, 'utf8').trim())
    expect(line.meta.repo).toBeNull()
  })

  it('an unattributed session (no VINAYA_TASK) files under none.ndjson', async () => {
    const { dir, deps } = testDeps({ env: () => ({}) })
    const { log } = createLogSink(deps)
    log(DISPATCHED)
    await flush()
    const path = join(dir, 'outbox', 'atta-labs-vinaya', 'none.ndjson')
    const line = JSON.parse(readFileSync(path, 'utf8').trim())
    expect(line.subject.role).toBe('unattributed')
    expect(line.subject.issue).toBeNull()
  })

  it('a forged meta/subject field on the caller-supplied event never overrides the trusted header (review BLOCKER)', async () => {
    // `LogEventInput`'s type strips `meta`/`subject`, but TS's excess-property
    // check only fires on a fresh object literal — a value coming through a
    // wider type or `as never` can still carry them at runtime. The header
    // must win regardless of spread order.
    const { dir, deps } = testDeps()
    const forged = {
      ...DISPATCHED,
      subject: { issue: 999, role: 'principal' },
      meta: { repo: 'attacker/owned' }
    }
    const { log } = createLogSink(deps)
    log(forged as never)
    await flush()
    const path = join(dir, 'outbox', 'atta-labs-vinaya', '404.ndjson')
    const line = JSON.parse(readFileSync(path, 'utf8').trim())
    expect(line.subject.role).toBe('developer')
    expect(line.subject.issue).toBe(404)
    expect(line.meta.repo).toBe('atta-labs/vinaya')
  })

  it('an unsafe owner/repo (path traversal) falls back to unresolved rather than escaping the outbox root (review HIGH)', async () => {
    const { dir, deps } = testDeps({
      resolveRepo: () => Promise.resolve({ owner: 'evil', repo: '../../../../../../tmp/evil' })
    })
    const { log } = createLogSink(deps)
    log(DISPATCHED)
    await flush()
    const path = join(dir, 'outbox', 'unresolved', '404.ndjson')
    const line = JSON.parse(readFileSync(path, 'utf8').trim())
    expect(line.meta.repo).toBeNull()
    // Nothing was created outside the sandboxed outbox root.
    expect(() => statSync('/tmp/evil')).toThrow()
  })

  it('an owner/repo containing a path separator also falls back to unresolved', async () => {
    const { dir, deps } = testDeps({
      resolveRepo: () => Promise.resolve({ owner: 'a/b', repo: 'c' })
    })
    const { log } = createLogSink(deps)
    log(DISPATCHED)
    await flush()
    const path = join(dir, 'outbox', 'unresolved', '404.ndjson')
    const line = JSON.parse(readFileSync(path, 'utf8').trim())
    expect(line.meta.repo).toBeNull()
  })
})
