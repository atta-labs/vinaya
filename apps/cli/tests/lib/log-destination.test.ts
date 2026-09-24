/**
 * The `logs` setting ([task-files-v1] 5, O1/O4): a folder (the default, under
 * this repository's own `runtimeDir`) or a server, mutually exclusive,
 * trust-anchor-gated for an unattended caller exactly as `runtimeDir` already
 * is. `resolveLogsSetting`/`resolveTrustAnchorLogsDestination`/
 * `resolveLogsHeaderValues` (`../../src/lib/config.js`) are pure;
 * `resolveLogDestinationFrom` (`../../src/lib/log-sink.js`) is the pure
 * decision layer built on top of them, mirroring `run-paths.ts`'s own
 * `resolveRuntimeDir`. The sink's own live delivery (folder append, server
 * queue + drain) is covered end to end below, against a real local HTTP
 * server, the same discipline `log-webhook-drain.test.ts` uses.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveLogsHeaderValues,
  resolveLogsSetting,
  resolveTrustAnchorLogsDestination,
  VinayaConfigSchema,
  type VinayaConfig
} from '../../src/lib/config.js'
import {
  createLogSink,
  resolveLogAppendPath,
  resolveLogDestinationFrom,
  type LogSinkDeps
} from '../../src/lib/log-sink.js'
import { spawnBudgetedAsync, stripVinayaEnv } from './process-fixture'

const DEFAULT_FOLDER = '/h/runtime/atta-labs-vinaya/logs'

describe('logs — schema mutual exclusion (see also tests/config.test.ts)', () => {
  it('accepts a folder-only config', () => {
    expect(VinayaConfigSchema.safeParse({ logs: { folder: '/var/lib/vinaya/logs' } }).success).toBe(true)
  })
})

describe('resolveLogsSetting (pure)', () => {
  it('is null when logs is absent', () => {
    expect(resolveLogsSetting(null)).toBeNull()
    expect(resolveLogsSetting({} as VinayaConfig)).toBeNull()
  })

  it('resolves a folder', () => {
    expect(resolveLogsSetting({ logs: { folder: '/var/log/vinaya' } } as VinayaConfig)).toEqual({
      folder: '/var/log/vinaya'
    })
  })

  it('resolves a url, with headers, ahead of folder', () => {
    expect(
      resolveLogsSetting({
        logs: { url: 'https://example.com/ingest', headers: { 'x-api-key': 'k' } }
      } as VinayaConfig)
    ).toEqual({ url: 'https://example.com/ingest', headers: { 'x-api-key': 'k' } })
  })
})

describe('resolveTrustAnchorLogsDestination (pure) — a PR cannot grant itself a new log destination', () => {
  it('is null when the default branch declares no logs setting at all', () => {
    expect(resolveTrustAnchorLogsDestination({ folder: '/var/log/vinaya' }, null)).toBeNull()
    expect(resolveTrustAnchorLogsDestination({ folder: '/var/log/vinaya' }, {} as VinayaConfig)).toBeNull()
  })

  it("is null when the default branch's folder differs from the working tree's", () => {
    const anchor = { logs: { folder: '/trusted/logs' } } as VinayaConfig
    expect(resolveTrustAnchorLogsDestination({ folder: '/attacker/logs' }, anchor)).toBeNull()
  })

  it("is null when the default branch's url differs from the working tree's", () => {
    const anchor = { logs: { url: 'https://trusted.example.com/ingest' } } as VinayaConfig
    expect(resolveTrustAnchorLogsDestination({ url: 'https://attacker.example.com/ingest' }, anchor)).toBeNull()
  })

  it('is null when the default branch configures the other destination kind', () => {
    const anchorFolder = { logs: { folder: '/trusted/logs' } } as VinayaConfig
    expect(resolveTrustAnchorLogsDestination({ url: 'https://example.com/ingest' }, anchorFolder)).toBeNull()
    const anchorUrl = { logs: { url: 'https://example.com/ingest' } } as VinayaConfig
    expect(resolveTrustAnchorLogsDestination({ folder: '/trusted/logs' }, anchorUrl)).toBeNull()
  })

  it('resolves the matching folder', () => {
    const anchor = { logs: { folder: '/trusted/logs' } } as VinayaConfig
    expect(resolveTrustAnchorLogsDestination({ folder: '/trusted/logs' }, anchor)).toEqual({ folder: '/trusted/logs' })
  })

  it("resolves the TRUST ANCHOR's own headers, never a caller-supplied set, when the url matches", () => {
    const anchor = {
      logs: { url: 'https://trusted.example.com/ingest', headers: { authorization: 'Bearer real' } }
    } as VinayaConfig
    expect(resolveTrustAnchorLogsDestination({ url: 'https://trusted.example.com/ingest' }, anchor)).toEqual({
      url: 'https://trusted.example.com/ingest',
      headers: { authorization: 'Bearer real' }
    })
  })
})

describe('resolveLogsHeaderValues (pure) — env-var references, never a literal secret in config', () => {
  it('returns undefined for undefined headers', () => {
    expect(resolveLogsHeaderValues(undefined, {})).toBeUndefined()
  })

  it('substitutes a variable reference from the given env', () => {
    expect(resolveLogsHeaderValues({ authorization: 'Bearer ${TOKEN}' }, { TOKEN: 'abc123' })).toEqual({
      authorization: 'Bearer abc123'
    })
  })

  it('resolves an unset variable to the empty string, never throwing', () => {
    expect(resolveLogsHeaderValues({ authorization: 'Bearer ${MISSING}' }, {})).toEqual({ authorization: 'Bearer ' })
  })

  it('leaves a header with no variable reference untouched', () => {
    expect(resolveLogsHeaderValues({ 'x-plain': 'literal' }, {})).toEqual({ 'x-plain': 'literal' })
  })
})

describe('resolveLogDestinationFrom (pure) — who is allowed to name the destination', () => {
  it('falls back to the default folder when logs is unconfigured', () => {
    expect(
      resolveLogDestinationFrom({
        localConfig: null,
        trustAnchorConfig: null,
        unattended: false,
        env: {},
        defaultFolder: DEFAULT_FOLDER
      })
    ).toEqual({ kind: 'folder', folder: DEFAULT_FOLDER })
  })

  it('honours a configured folder for an attended caller, unchecked', () => {
    expect(
      resolveLogDestinationFrom({
        localConfig: { logs: { folder: '/srv/logs' } } as VinayaConfig,
        trustAnchorConfig: null,
        unattended: false,
        env: {},
        defaultFolder: DEFAULT_FOLDER
      })
    ).toEqual({ kind: 'folder', folder: '/srv/logs' })
  })

  it('falls back to the default folder for an UNATTENDED caller when the default branch disagrees', () => {
    expect(
      resolveLogDestinationFrom({
        localConfig: { logs: { folder: '/srv/logs' } } as VinayaConfig,
        trustAnchorConfig: null,
        unattended: true,
        env: {},
        defaultFolder: DEFAULT_FOLDER
      })
    ).toEqual({ kind: 'folder', folder: DEFAULT_FOLDER })
  })

  it('honours a configured folder for an unattended caller when the default branch declares the identical one', () => {
    expect(
      resolveLogDestinationFrom({
        localConfig: { logs: { folder: '/srv/logs' } } as VinayaConfig,
        trustAnchorConfig: { logs: { folder: '/srv/logs' } } as VinayaConfig,
        unattended: true,
        env: {},
        defaultFolder: DEFAULT_FOLDER
      })
    ).toEqual({ kind: 'folder', folder: '/srv/logs' })
  })

  it("honours the default branch's own folder for an unattended caller even when the working tree declares no `logs` setting at all (round-3 security review, HIGH: a PR that deletes its local declaration must not silently evade the org's configured destination)", () => {
    expect(
      resolveLogDestinationFrom({
        localConfig: null,
        trustAnchorConfig: { logs: { folder: '/srv/logs' } } as VinayaConfig,
        unattended: true,
        env: {},
        defaultFolder: DEFAULT_FOLDER
      })
    ).toEqual({ kind: 'folder', folder: '/srv/logs' })
  })

  it("honours the default branch's own server destination the same way, with header substitution applied, when the working tree declares nothing", () => {
    expect(
      resolveLogDestinationFrom({
        localConfig: null,
        trustAnchorConfig: {
          logs: { url: 'https://example.com/ingest', headers: { authorization: 'Bearer ${T}' } }
        } as VinayaConfig,
        unattended: true,
        env: { T: 'xyz' },
        defaultFolder: DEFAULT_FOLDER
      })
    ).toEqual({ kind: 'server', url: 'https://example.com/ingest', headers: { authorization: 'Bearer xyz' } })
  })

  it('resolves a server destination for an attended caller, with header substitution applied', () => {
    expect(
      resolveLogDestinationFrom({
        localConfig: {
          logs: { url: 'https://example.com/ingest', headers: { authorization: 'Bearer ${T}' } }
        } as VinayaConfig,
        trustAnchorConfig: null,
        unattended: false,
        env: { T: 'xyz' },
        defaultFolder: DEFAULT_FOLDER
      })
    ).toEqual({ kind: 'server', url: 'https://example.com/ingest', headers: { authorization: 'Bearer xyz' } })
  })

  it('an unattended caller never honours a working-tree server destination the default branch does not also declare — falls back to the default folder, never a partial/unrouted server attempt', () => {
    expect(
      resolveLogDestinationFrom({
        localConfig: { logs: { url: 'https://attacker.example.com/ingest' } } as VinayaConfig,
        trustAnchorConfig: null,
        unattended: true,
        env: {},
        defaultFolder: DEFAULT_FOLDER
      })
    ).toEqual({ kind: 'folder', folder: DEFAULT_FOLDER })
  })

  it('refuses a folder inside the repository — for an ATTENDED caller too, mirroring resolveRuntimeDir’s isInsideRepo rule', () => {
    expect(
      resolveLogDestinationFrom({
        localConfig: { logs: { folder: '/repo/.worktrees/task/5/logs' } } as VinayaConfig,
        trustAnchorConfig: null,
        unattended: false,
        env: {},
        defaultFolder: DEFAULT_FOLDER,
        repoRoot: '/repo'
      })
    ).toEqual({ kind: 'folder', folder: DEFAULT_FOLDER })
  })

  it('refuses a folder that IS the repository root, not just a subpath', () => {
    expect(
      resolveLogDestinationFrom({
        localConfig: { logs: { folder: '/repo' } } as VinayaConfig,
        trustAnchorConfig: null,
        unattended: true,
        env: {},
        defaultFolder: DEFAULT_FOLDER,
        repoRoot: '/repo'
      })
    ).toEqual({ kind: 'folder', folder: DEFAULT_FOLDER })
  })

  it('honours a folder outside the repository, unaffected by the inside-repo refusal', () => {
    expect(
      resolveLogDestinationFrom({
        localConfig: { logs: { folder: '/srv/logs' } } as VinayaConfig,
        trustAnchorConfig: null,
        unattended: false,
        env: {},
        defaultFolder: DEFAULT_FOLDER,
        repoRoot: '/repo'
      })
    ).toEqual({ kind: 'folder', folder: '/srv/logs' })
  })
})

// --- CI (task-files-v1 6, O3): a server or nothing, never an ephemeral
// runner's own folder, and never delivered without a real credential. -----

describe('resolveLogDestinationFrom — CI never falls back to a folder (O3)', () => {
  const CI_ENV = { GITHUB_ACTIONS: 'true' }

  it('records nothing when no server destination is configured at all', () => {
    expect(
      resolveLogDestinationFrom({
        localConfig: null,
        trustAnchorConfig: null,
        unattended: true,
        env: CI_ENV,
        defaultFolder: DEFAULT_FOLDER
      })
    ).toEqual({
      kind: 'none',
      reason: 'no server destination is configured for CI delivery (vinaya.config.json logs.url)'
    })
  })

  it('records nothing when the working tree configures a folder — CI never honours a folder, credentialed or not', () => {
    expect(
      resolveLogDestinationFrom({
        localConfig: { logs: { folder: '/srv/logs' } } as VinayaConfig,
        trustAnchorConfig: { logs: { folder: '/srv/logs' } } as VinayaConfig,
        unattended: true,
        env: CI_ENV,
        defaultFolder: DEFAULT_FOLDER
      })
    ).toEqual({
      kind: 'none',
      reason: 'no server destination is configured for CI delivery (vinaya.config.json logs.url)'
    })
  })

  it('delivers live to the configured server when the credential is present (a same-repository or default-branch run)', () => {
    expect(
      resolveLogDestinationFrom({
        localConfig: {
          logs: { url: 'https://ingest.example.com/vinaya', headers: { authorization: 'Bearer ${VINAYA_LOG_TOKEN}' } }
        } as VinayaConfig,
        trustAnchorConfig: {
          logs: { url: 'https://ingest.example.com/vinaya', headers: { authorization: 'Bearer ${VINAYA_LOG_TOKEN}' } }
        } as VinayaConfig,
        unattended: true,
        env: { ...CI_ENV, VINAYA_LOG_TOKEN: 'real-token' },
        defaultFolder: DEFAULT_FOLDER
      })
    ).toEqual({
      kind: 'server',
      url: 'https://ingest.example.com/vinaya',
      headers: { authorization: 'Bearer real-token' }
    })
  })

  it('records nothing, naming the missing credential, when the referenced env var is empty — a fork pull request withheld the secret', () => {
    expect(
      resolveLogDestinationFrom({
        localConfig: {
          logs: { url: 'https://ingest.example.com/vinaya', headers: { authorization: 'Bearer ${VINAYA_LOG_TOKEN}' } }
        } as VinayaConfig,
        trustAnchorConfig: {
          logs: { url: 'https://ingest.example.com/vinaya', headers: { authorization: 'Bearer ${VINAYA_LOG_TOKEN}' } }
        } as VinayaConfig,
        unattended: true,
        // GitHub Actions sets a secret-backed env var to '' for a fork PR —
        // the variable is present, its value is withheld.
        env: { ...CI_ENV, VINAYA_LOG_TOKEN: '' },
        defaultFolder: DEFAULT_FOLDER
      })
    ).toEqual({
      kind: 'none',
      reason:
        'a logs.url server destination is configured, but this job holds no delivery credential (a fork pull request, or a missing repository secret)'
    })
  })

  it('records nothing, naming the missing credential, when the referenced env var is entirely absent', () => {
    expect(
      resolveLogDestinationFrom({
        localConfig: {
          logs: { url: 'https://ingest.example.com/vinaya', headers: { authorization: 'Bearer ${VINAYA_LOG_TOKEN}' } }
        } as VinayaConfig,
        trustAnchorConfig: {
          logs: { url: 'https://ingest.example.com/vinaya', headers: { authorization: 'Bearer ${VINAYA_LOG_TOKEN}' } }
        } as VinayaConfig,
        unattended: true,
        env: CI_ENV,
        defaultFolder: DEFAULT_FOLDER
      })
    ).toEqual({
      kind: 'none',
      reason:
        'a logs.url server destination is configured, but this job holds no delivery credential (a fork pull request, or a missing repository secret)'
    })
  })

  it('delivers without a credential check when the destination declares no headers at all — nothing to be missing', () => {
    expect(
      resolveLogDestinationFrom({
        localConfig: { logs: { url: 'https://ingest.example.com/vinaya' } } as VinayaConfig,
        trustAnchorConfig: { logs: { url: 'https://ingest.example.com/vinaya' } } as VinayaConfig,
        unattended: true,
        env: CI_ENV,
        defaultFolder: DEFAULT_FOLDER
      })
    ).toEqual({ kind: 'server', url: 'https://ingest.example.com/vinaya', headers: undefined })
  })

  it("a fork PR cannot redirect CI delivery by editing its own diff's logs.url — the trust-anchor gate still applies, so an unmatched working-tree url falls through to 'no server configured', never the attacker's own endpoint", () => {
    expect(
      resolveLogDestinationFrom({
        localConfig: { logs: { url: 'https://attacker.example.com/ingest' } } as VinayaConfig,
        trustAnchorConfig: { logs: { url: 'https://ingest.example.com/vinaya' } } as VinayaConfig,
        unattended: true,
        env: { ...CI_ENV, VINAYA_LOG_TOKEN: 'real-token' },
        defaultFolder: DEFAULT_FOLDER
      })
    ).toEqual({
      kind: 'none',
      reason: 'no server destination is configured for CI delivery (vinaya.config.json logs.url)'
    })
  })
})

// --- resolveLogAppendPath — the exact path log() will append to -----------

describe('resolveLogAppendPath — mirrors log()’s own destination resolution', () => {
  const REPO = { owner: 'atta-labs', repo: 'vinaya' }

  it('a folder destination resolves to <folder>/<repo>/<issue>.ndjson', async () => {
    const path = await resolveLogAppendPath(REPO, 404, {
      resolveLogDestination: () => ({ kind: 'folder', folder: '/srv/logs' }),
      env: () => ({})
    })
    expect(path).toBe('/srv/logs/atta-labs-vinaya/404.ndjson')
  })

  it('a server destination resolves to the local retry queue, never the server root', async () => {
    const path = await resolveLogAppendPath(REPO, 404, {
      resolveLogDestination: () => ({ kind: 'server', url: 'https://example.com/ingest' }),
      outboxRoot: () => '/queue',
      env: () => ({})
    })
    expect(path).toBe('/queue/atta-labs-vinaya/404.ndjson')
  })

  it('a null issue resolves to none.ndjson, for either destination kind', async () => {
    expect(
      await resolveLogAppendPath(REPO, null, { resolveLogDestination: () => ({ kind: 'folder', folder: '/srv/logs' }) })
    ).toBe('/srv/logs/atta-labs-vinaya/none.ndjson')
  })
})

// --- the sink's own live delivery — folder and server, end to end ---------

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-log-destination-'))
  tempDirs.push(dir)
  return dir
}

const flush = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const DISPATCHED = {
  kind: 'dispatch' as const,
  event: 'dispatched' as const,
  payload: {},
  target_role: 'developer' as const,
  model: 'sonnet',
  effect_id: 'e1',
  prompt_hash: 'sha256:abc'
}

function sinkDeps(overrides: Partial<LogSinkDeps> = {}): { dir: string; deps: Partial<LogSinkDeps> } {
  const dir = tempDir()
  return {
    dir,
    deps: {
      outboxRoot: () => join(dir, 'queue'),
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

describe('log-sink — a folder destination is appended to directly (O1/O2)', () => {
  it('writes the event straight into <folder>/<repo>/<task>.ndjson', async () => {
    const { dir, deps } = sinkDeps({ resolveLogDestination: () => ({ kind: 'folder', folder: join(dir, 'logs') }) })
    const { log } = createLogSink(deps)
    log(DISPATCHED)
    await flush()
    const path = join(dir, 'logs', 'atta-labs-vinaya', '404.ndjson')
    const line = JSON.parse(readFileSync(path, 'utf8').trim())
    expect(line.event).toBe('dispatched')
  })
})

describe("log-sink — a 'none' destination writes nothing and warns exactly once per process (O3)", () => {
  it('writes no outbox file at all', async () => {
    const { dir, deps } = sinkDeps({
      resolveLogDestination: () => ({ kind: 'none', reason: 'no server destination is configured' })
    })
    const { log } = createLogSink(deps)
    log(DISPATCHED)
    log(DISPATCHED)
    await flush()
    expect(existsSync(join(dir, 'logs'))).toBe(false)
    expect(existsSync(join(dir, 'queue'))).toBe(false)
  })

  it('warns once, naming the reason, even across several events', async () => {
    const messages: string[] = []
    const { deps } = sinkDeps({
      resolveLogDestination: () => ({ kind: 'none', reason: 'a fork pull request holds no delivery credential' }),
      stderr: (m) => messages.push(m)
    })
    const { log } = createLogSink(deps)
    log(DISPATCHED)
    log(DISPATCHED)
    log(DISPATCHED)
    await flush()
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('a fork pull request holds no delivery credential')
  })
})

// --- server destination: drains through the REAL `flushOutboxToWebhook`,
// which resolves its own read path from `GLOBAL_VINAYA_HOME` (a module-level
// constant frozen at first import) rather than an injectable dep — a fresh
// subprocess with its own scratch `$HOME` is what makes that path land
// somewhere this test controls, the identical discipline
// `log-webhook-drain.test.ts` documents for the same reason.

function startWebhookServer(status = 200): { url: string; requests: string[]; stop: () => void } {
  const requests: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      requests.push(await req.text())
      return new Response(status === 200 ? 'ok' : 'error', { status })
    }
  })
  return { url: `http://127.0.0.1:${server.port}/ingest`, requests, stop: () => server.stop() }
}

function initGitRepo(cwd: string): void {
  execFileSync('git', ['init', '--quiet'], { cwd })
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:test-owner/test-repo.git'], { cwd })
}

const LOG_SINK_PATH = join(import.meta.dir, '..', '..', 'src', 'lib', 'log-sink.ts')

/**
 * Runs a fresh `bun` subprocess that logs one `dispatched` event through a
 * sink pinned to a `{kind: 'server', url}` destination, then exits — proving
 * the sink's own append-then-drain sequencing without touching this test
 * process's real `~/.vinaya`.
 *
 * Async launch, not `spawnSyncBudgeted`: for a real `url` (`startWebhookServer`,
 * below), the child's own drain POSTs back to THIS test process's
 * `Bun.serve()` instance — a synchronous spawn here would block the one
 * thread that server's `fetch` handler also needs to run on, and on Bun
 * 1.4.2 (a genuinely blocking synchronous spawn, unlike 1.2.14's
 * event-loop-spinning one) the request would never be answered at all
 * (found live running this task's own required Test Plan; escalated on
 * Issue #706 before this fix, since neither this file nor these two tests
 * were named among the seven Bun-1.4.2 failures the task's Boundary lists —
 * same root cause as O4's three named `log-webhook-drain.test.ts` tests).
 */
async function runServerDestinationScript(home: string, cwd: string, url: string, effectId: string): Promise<void> {
  const script = join(cwd, `run-log-${effectId}.ts`)
  writeFileSync(
    script,
    `import { createLogSink } from ${JSON.stringify(LOG_SINK_PATH)}
    const { log } = createLogSink({
      env: () => ({ VINAYA_ROLE: 'developer', VINAYA_TASK: '404' }),
      resolveLogDestination: () => ({ kind: 'server', url: ${JSON.stringify(url)} })
    })
    log({
      kind: 'dispatch', event: 'dispatched', payload: {}, target_role: 'developer',
      model: 'sonnet', effect_id: ${JSON.stringify(effectId)}, prompt_hash: 'sha256:abc'
    })
    await new Promise((r) => setTimeout(r, 400))`
  )
  await spawnBudgetedAsync(['bun', script], { cwd, env: { ...stripVinayaEnv(), HOME: home } }, undefined, 'run-log.ts')
}

function queuePath(home: string): string {
  return join(home, '.vinaya', 'outbox', 'test-owner-test-repo', '404.ndjson')
}

describe('log-sink — a server destination appends locally first, then drains (O2)', () => {
  it('a single event lands in the queue and reaches the server, which truncates it', async () => {
    const cwd = tempDir()
    initGitRepo(cwd)
    const home = tempDir()
    const server = startWebhookServer(200)

    await runServerDestinationScript(home, cwd, server.url, 'e1')
    server.stop()

    expect(server.requests).toHaveLength(1)
    const posted = JSON.parse(server.requests[0]!.trim())
    expect(posted.effect_id).toBe('e1')

    // Drained on success — the local queue is truncated, exactly the
    // durability rule `flushOutboxToWebhook` already guarantees.
    expect(readFileSync(queuePath(home), 'utf8')).toBe('')
  })

  it('an event queues locally and survives an unreachable server — nothing lost, nothing thrown', async () => {
    const cwd = tempDir()
    initGitRepo(cwd)
    const home = tempDir()

    await runServerDestinationScript(home, cwd, 'http://127.0.0.1:1/never-reached', 'e2')

    const afterFailure = readFileSync(queuePath(home), 'utf8').trim().split('\n')
    expect(afterFailure).toHaveLength(1)
    expect(JSON.parse(afterFailure[0]!).effect_id).toBe('e2')
  })

  it('a later event catches up the backlog once the server is back — delivered in order, no separate retry timer', async () => {
    const cwd = tempDir()
    initGitRepo(cwd)
    const home = tempDir()

    // First attempt: server unreachable, the line stays queued.
    await runServerDestinationScript(home, cwd, 'http://127.0.0.1:1/never-reached', 'first')
    expect(readFileSync(queuePath(home), 'utf8').trim().split('\n')).toHaveLength(1)

    // Second attempt, same queue file, server now live: its own drain reads
    // the WHOLE file — both the backlogged first line and this one.
    const server = startWebhookServer(200)
    await runServerDestinationScript(home, cwd, server.url, 'second')
    server.stop()

    expect(server.requests).toHaveLength(1)
    const delivered = server.requests[0]!.trim()
      .split('\n')
      .map((l) => JSON.parse(l).effect_id)
    expect(delivered).toEqual(['first', 'second'])
    expect(readFileSync(queuePath(home), 'utf8')).toBe('')
  })
})

// --- the sink's drain of pending writes before an abrupt exit (O5, Issue
// #707) --------------------------------------------------------------------
//
// `log()`'s own write does not land synchronously — it lands inside a `.then()`
// continuation of `context()`'s repo/doctrine/destination resolution, which
// genuinely forks a `git` subprocess. A caller that calls `process.exit()`
// right after `log()`, with nothing else keeping the event loop alive,
// tears the process down before that continuation ever runs — exactly the
// gap `drainLogSink()` exists to close, and exactly the shape of the driver's
// own `SIGTERM`/`SIGINT` handlers (`dev-review-loop.ts`). Both scripts below
// register the SAME signal, log the SAME event, and send themselves that
// SAME signal in the SAME synchronous turn — the only difference is whether
// the handler awaits `drainLogSink()` before exiting. The 60-second interval
// is what makes the exit genuinely abrupt rather than the process ending
// naturally once its own microtasks settle: nothing but the handler's own
// `process.exit()` call can end the process before it fires.
async function runAbruptExitScript(cwd: string, home: string, drainOnExit: boolean, effectId: string): Promise<void> {
  const script = join(cwd, `run-log-abrupt-${effectId}.ts`)
  writeFileSync(
    script,
    `import { drainLogSink, log } from ${JSON.stringify(LOG_SINK_PATH)}
    setInterval(() => {}, 60000)
    process.on('SIGTERM', async () => {
      ${drainOnExit ? 'await drainLogSink()' : ''}
      process.exit(0)
    })
    log({
      kind: 'dispatch', event: 'dispatched', payload: {}, target_role: 'developer',
      model: 'sonnet', effect_id: ${JSON.stringify(effectId)}, prompt_hash: 'sha256:abc'
    })
    process.kill(process.pid, 'SIGTERM')`
  )
  await spawnBudgetedAsync(
    ['bun', script],
    { cwd, env: { ...stripVinayaEnv(), HOME: home } },
    undefined,
    'run-log-abrupt.ts'
  )
}

function folderEventPath(logsFolder: string): string {
  return join(logsFolder, 'test-owner-test-repo', 'none.ndjson')
}

describe('log-sink — the drain before an abrupt exit is what keeps a pending write from being dropped (O5, Issue #707)', () => {
  it('a SIGTERM handler that awaits drainLogSink() before exiting never drops the write in flight', async () => {
    const cwd = tempDir()
    initGitRepo(cwd)
    const home = tempDir()
    const logsFolder = join(home, 'logs')
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify({ logs: { folder: logsFolder } }))

    await runAbruptExitScript(cwd, home, true, 'drained')

    const path = folderEventPath(logsFolder)
    expect(existsSync(path)).toBe(true)
    const line = JSON.parse(readFileSync(path, 'utf8').trim())
    expect(line.effect_id).toBe('drained')
  })

  it('a SIGTERM handler that exits WITHOUT draining drops the write — the control case that proves the assertion above is real', async () => {
    const cwd = tempDir()
    initGitRepo(cwd)
    const home = tempDir()
    const logsFolder = join(home, 'logs')
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify({ logs: { folder: logsFolder } }))

    await runAbruptExitScript(cwd, home, false, 'dropped')

    // No drain, no wait: `context()`'s own async resolution (a real `git`
    // fork) had no chance to land the append before `process.exit()` tore
    // the process down.
    expect(existsSync(folderEventPath(logsFolder))).toBe(false)
  })
})
