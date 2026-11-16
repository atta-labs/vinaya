#!/usr/bin/env bun
/**
 * Acceptance runner for Mission Control's live list.
 *
 * Fixture scenarios run first and need no network: Studio's real host starts in-process with its real session guard,
 * picture service, projection, application WebSocket and page component. Only the Log source and follower, the clock
 * and the clock's timers are the fixture's, supplied through the constructors the host and the picture service take —
 * never an environment switch or a URL. A real WebSocket client carrying the session cookie from the one-time link feeds
 * the live list, rendered into a jsdom document. Replay data are the recorded executions of
 * `harness/kernel/log/fixtures/executions.ts`, adapted here to two machines and never changed at their source.
 *
 * Then the existing isolated-install runner packs the CLI, installs it into a scratch directory and starts the
 * installed `vinaya studio` there (`apps/cli/scripts/verify-studio-install.ts`). Run with `--fixtures-only` to skip it.
 *
 * What only a real browser engine shows (layout, theme, paint) stays the Principal's visual check; nothing here
 * downloads or launches one.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import WebSocket from 'ws'
import { buildExecution } from '../../../harness/kernel/log/fixtures/executions.ts'
import type { LogSource, SourceLine } from '../../../harness/kernel/log/sync/contracts.ts'
import { known } from '../../../harness/kernel/log/sync/measured.ts'
import MissionControlPage from '../src/app/page.tsx'
import type { ConnectionSocket } from '../src/lib/mission-control-connection.ts'
import {
  createStudioHost,
  LIVE_ROUTE,
  type NextFactory,
  REPOSITORIES_ROUTE,
  TASK_LIST_ROUTE
} from '../src/server/host.ts'
import { createLiveSocket, type LiveSocketEndpoint } from '../src/server/live-socket.ts'
import {
  createPictureService,
  type FollowHandle,
  type FollowSink,
  type PictureService,
  type SourceFactory
} from '../src/server/picture-service.ts'
import type { StudioRepository } from '../src/server/repositories.ts'
import { BOOTSTRAP_ROUTE } from '../src/server/session.ts'
import { MissionControlLiveList } from '../src/ui/mission-control/live-list.tsx'

const APP_DIR = join(import.meta.dir, '..')
const INSTALL_RUNNER = '../../cli/scripts/verify-studio-install.ts'
const MIN = 60_000
const LAUNCH_SECRET = 'Q'.repeat(43)
const READ_SECRET = 'READ-CREDENTIAL-VALUE-9f3a'

// ---------------------------------------------------------------------------
// Fixture lines

type Fields = Record<string, unknown>

/** A recorded execution's lines, adapted to one machine; the record's own content is untouched. */
function recorded(name: Parameters<typeof buildExecution>[0], machine: string): string[] {
  return buildExecution(name).lines.map((line) => {
    const record = JSON.parse(line.raw as string) as { meta: Fields }
    record.meta.machine = machine
    return JSON.stringify(record)
  })
}

function lastRecordedAt(lines: readonly string[]): number {
  return Math.max(
    ...lines.map((raw) => Date.parse(String((JSON.parse(raw) as { meta: Fields }).meta.ts))).filter(Number.isFinite)
  )
}

const template = JSON.parse(buildExecution('green-one-round').lines[0]?.raw as string) as Fields
let counter = 0
/** One hand-built loop record on top of a real recorded header, so it passes the real normaliser. */
function record(task: number, body: Fields, at: number, machine: string): string {
  counter += 1
  const meta = {
    ...(template.meta as Fields),
    ts: new Date(at).toISOString(),
    seq: counter,
    event_id: `evt-acceptance-${counter}`,
    machine
  }
  return JSON.stringify({ meta, subject: { issue: task, role: 'unattributed' }, payload: {}, ...body })
}
const loopStarted = (task: number, at: number, machine: string) =>
  record(
    task,
    {
      kind: 'dev_review_loop',
      event: 'loop_started',
      loop_id: `loop-${task}`,
      task,
      title: `Acceptance task ${task}`,
      policy: { max_rounds: 5, reviewers: ['code-reviewer'], models: {} }
    },
    at,
    machine
  )

// ---------------------------------------------------------------------------
// Fixture sources: the only part of the pipeline that is not Studio's own

type Followed = { sink: FollowSink; handle: FollowHandle }

function fixtureSource(kind: 'folder' | 'server', lines: { stream: string; raw: string }[]) {
  const followed: Followed[] = []
  const factory: SourceFactory = () => {
    const source: LogSource & { retention?: () => Promise<never> } = {
      id: `${kind}:fixture`,
      async readPage(cursor, limit) {
        const from = cursor === null ? 0 : Number(cursor)
        const slice = lines.slice(from, from + limit)
        const page: SourceLine[] = slice.map((l, i) => ({
          raw: l.raw,
          position: kind === 'folder' ? `${l.stream}:live:${from + i}` : String(from + i + 1)
        }))
        return { lines: page, next: String(from + slice.length), gaps: [] }
      }
    }
    if (kind === 'server') {
      ;(source as unknown as { retention: () => Promise<unknown> }).retention = async () => ({
        head: known(lines.length),
        storedCount: known(lines.length),
        gap: known(0)
      })
    }
    return {
      source,
      follower: {
        id: 'fixture',
        follow(_from, sink) {
          const handle: FollowHandle = {
            cursor: () => null,
            async stop() {},
            done: new Promise<void>(() => {})
          }
          followed.push({ sink, handle })
          return handle
        }
      }
    }
  }
  return { factory, followed }
}

function fixtureTimers() {
  const handlers = new Map<number, () => void>()
  let next = 1
  return {
    timers: {
      setInterval: (handler: () => void) => {
        handlers.set(next, handler)
        return next++
      },
      clearInterval: (id: unknown) => void handlers.delete(id as number)
    },
    fire: () => {
      for (const handler of [...handlers.values()]) handler()
    }
  }
}

// ---------------------------------------------------------------------------
// The installed host, in-process

type Booted = {
  origin: string
  cookie: string
  pictures: PictureService
  sockets: { terminate(): void }[]
  clock: { now: () => number; set: (t: number) => void; advance: (ms: number) => void }
  timers: ReturnType<typeof fixtureTimers>
  followed: Followed[]
  stop(): Promise<void>
}

/** Studio's own page for the fake Next: the real page component, rendered on the server. */
const pageNext: NextFactory = () => ({
  async prepare() {},
  getRequestHandler: () => (_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(`<!doctype html><html><body>${renderToStaticMarkup(createElement(MissionControlPage))}</body></html>`)
  }
})

async function boot(options: {
  repositories: StudioRepository[]
  source: ReturnType<typeof fixtureSource>
  startAt: number
}): Promise<Booted> {
  let now = options.startAt
  const clock = {
    now: () => now,
    set: (t: number) => {
      now = t
    },
    advance: (ms: number) => {
      now += ms
    }
  }
  const timers = fixtureTimers()
  const sockets: { terminate(): void }[] = []
  let pictures: PictureService | null = null
  let live: LiveSocketEndpoint | null = null
  const host = createStudioHost({
    dir: APP_DIR,
    hostname: '127.0.0.1',
    port: 0,
    dev: false,
    session: { secret: LAUNCH_SECRET, ttlMs: 24 * 60 * MIN },
    repositories: options.repositories,
    clock: clock.now,
    next: pageNext,
    compose: (composition) => {
      pictures = createPictureService({
        repositories: composition.repositories,
        clock: composition.clock,
        timers: timers.timers,
        createSource: options.source.factory
      })
      live = createLiveSocket({ service: pictures, repositories: composition.repositories })
      composition.socket(LIVE_ROUTE, (socket) => {
        sockets.push(socket)
        live?.handler(socket)
      })
    }
  })
  const port = await host.listen()
  const origin = `http://127.0.0.1:${port}`
  const service = pictures as PictureService | null
  assert.ok(service, 'the host composed its picture service')
  await service.start()
  // The one-time launch link, exchanged exactly as a browser would: the cookie it sets is the only credential after.
  const exchange = await fetch(`${origin}${BOOTSTRAP_ROUTE}?token=${LAUNCH_SECRET}`, { redirect: 'manual' })
  const cookie = exchange.headers.get('set-cookie')?.split(';')[0] ?? ''
  assert.equal(exchange.status, 303, 'the launch link exchanges for a session')
  assert.ok(cookie, 'the launch link sets the session cookie')
  return {
    origin,
    cookie,
    pictures: service,
    sockets,
    clock,
    timers,
    followed: options.source.followed,
    async stop() {
      live?.close()
      await Promise.all([service.close(), host.close()])
    }
  }
}

// ---------------------------------------------------------------------------
// The page: server render, then the live list in a jsdom document over a real WebSocket

type Page = {
  document: Document
  frames: string[]
  html: string
  status(): string | null
  rows(): { repository: string; task: number; state: string; text: string; cells: Record<string, string> }[]
  waitFor(description: string, predicate: () => boolean, timeoutMs?: number): Promise<void>
  close(): void
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function openPage(server: Booted): Promise<Page> {
  const response = await fetch(`${server.origin}/`, { headers: { cookie: server.cookie } })
  assert.equal(response.status, 200, 'the page answers with the session')
  const html = await response.text()
  assert.ok(
    html.includes('data-board-status="connecting"'),
    'the server renders the connecting list, not an empty board'
  )
  const dom = new JSDOM(html, { url: `${server.origin}/` })
  const g = globalThis as Record<string, unknown>
  Object.assign(g, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node
  })
  const frames: string[] = []
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root: Root = createRoot(container)
  flushSync(() =>
    root.render(
      createElement(MissionControlLiveList, {
        clock: server.clock.now,
        createSocket: () => {
          const socket = new WebSocket(`${server.origin.replace('http', 'ws')}${LIVE_ROUTE}`, {
            headers: { cookie: server.cookie, origin: server.origin }
          })
          socket.on('message', (data) => frames.push(String(data)))
          return socket as unknown as ConnectionSocket
        }
      })
    )
  )
  const document = dom.window.document
  const page: Page = {
    document,
    frames,
    html,
    status: () => document.querySelector('[data-board-status]')?.getAttribute('data-board-status') ?? null,
    rows: () =>
      [...document.querySelectorAll('[data-task-row]')].map((row) => ({
        repository: row.getAttribute('data-repository') ?? '',
        task: Number(row.getAttribute('data-task')),
        state: row.getAttribute('data-state') ?? '',
        text: row.textContent ?? '',
        cells: Object.fromEntries(
          [...row.querySelectorAll('[data-cell]')].map((cell) => [
            cell.getAttribute('data-cell') ?? '',
            cell.textContent ?? ''
          ])
        )
      })),
    async waitFor(description, predicate, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (predicate()) return
        await sleep(15)
      }
      throw new Error(
        `timed out waiting for ${description}; the page says "${page.status()}" with ${page.rows().length} rows`
      )
    },
    close() {
      root.unmount()
      dom.window.close()
    }
  }
  return page
}

const repo = (name: string, source: StudioRepository['source']): StudioRepository => ({
  root: `/private/acceptance/${name}`,
  remote: { owner: 'acme', repo: name },
  source
})
const folderSource: StudioRepository['source'] = {
  ok: true,
  spec: { kind: 'folder', folderRoot: '/private/acceptance/logs', repoDir: '/private/acceptance/logs/widgets' }
}
const serverSource: StudioRepository['source'] = {
  ok: true,
  spec: { kind: 'server', url: 'https://log.invalid/events', readHeaders: { authorization: `Bearer ${READ_SECRET}` } }
}

/** What the server says about a task, the one thing the page may show. */
function serverTasks(server: Booted) {
  return server.pictures.snapshots().flatMap((s) => s.picture.tasks.map((t) => ({ remote: s.remote, ...t })))
}

// ---------------------------------------------------------------------------
// Scenarios

const results: string[] = []
async function scenario(name: string, run: () => Promise<void>): Promise<void> {
  process.stdout.write(`… ${name}\n`)
  await run()
  results.push(name)
}

async function twoMachineFolderReplay(): Promise<void> {
  const mac = recorded('green-one-round', 'mac')
  const vps = recorded('paused-and-resumed', 'vps')
  const lines = [...mac.map((raw) => ({ stream: 'mac', raw })), ...vps.map((raw) => ({ stream: 'vps', raw }))]
  const server = await boot({
    repositories: [repo('widgets', folderSource)],
    source: fixtureSource('folder', lines),
    startAt: lastRecordedAt([...mac, ...vps]) + MIN
  })
  const page = await openPage(server)
  try {
    const expected = serverTasks(server)
    assert.ok(expected.length >= 2, 'both machines recorded a task')
    await page.waitFor('every replayed task as a row', () => page.rows().length === expected.length)
    for (const task of expected) {
      const row = page.rows().find((r) => r.task === task.task)
      assert.ok(row, `task ${task.task} is a row`)
      assert.equal(row.state, task.state, `task ${task.task} shows the server's state, not one the page worked out`)
      assert.ok(row.text.includes('acme/widgets'), 'the row names its repository')
      assert.ok(
        row.text.includes(task.title ?? 'Title not recorded'),
        'the row shows the recorded title or the fallback'
      )
    }
    // A folder cannot read its rotated slots, so the picture is declared source-limited, never plainly live.
    await page.waitFor('the folder coverage limit', () => page.status() === 'source-limited')
    // Rows keep the server's state order.
    const ranks = ['needs_you', 'presumed_dead', 'stopped_itself', 'needs_a_look', 'running', 'ready_to_merge']
    const order = page.rows().map((r) => ranks.indexOf(r.state))
    assert.deepEqual(
      order,
      [...order].sort((a, b) => a - b),
      'rows follow the state order'
    )
    assert.ok(!page.rows().some((r) => /0s ago/.test(r.cells['last-sign'] ?? '') && r.cells['last-sign'] === 'unknown'))
  } finally {
    page.close()
    await server.stop()
  }
}

async function serverLateOpeningAndLiveChange(): Promise<void> {
  const task = 41
  const t0 = Date.parse('2026-11-01T10:00:00.000Z')
  const history = [loopStarted(task, t0, 'mac'), loopStarted(42, t0 + 1_000, 'vps')]
  const server = await boot({
    repositories: [repo('widgets', serverSource)],
    source: fixtureSource(
      'server',
      history.map((raw) => ({ stream: 'server', raw }))
    ),
    startAt: t0 + 2 * MIN
  })
  try {
    // Late opening: the page opens after the whole history was applied, and its first picture already holds it.
    const early = await openPage(server)
    await early.waitFor('the catching-up status before the follower is live', () => early.status() === 'catching-up')
    assert.equal(early.rows().length, 2, 'rows show while the source is still catching up')
    assert.notEqual(early.status(), 'empty', 'a source that is catching up is never read as empty')
    server.followed[0]?.sink.state?.({ state: 'live' })
    await early.waitFor('live', () => early.status() === 'live' || early.status() === 'source-limited')

    // A line arriving live changes a visible row without a reload.
    const before = early.frames.length
    server.clock.advance(MIN)
    server.followed[0]?.sink.line({
      raw: record(
        task,
        { kind: 'dev_review_loop', event: 'stop_condition_met', loop_id: `loop-${task}`, round: 1, condition: 'green' },
        server.clock.now(),
        'mac'
      ),
      position: '3'
    })
    await early.waitFor(
      'the task frame to change the row',
      () => early.rows().find((r) => r.task === task)?.state === 'ready_to_merge'
    )
    assert.ok(early.frames.length > before, 'the change arrived as a frame')
    assert.ok(
      early.frames.slice(before).some((f) => JSON.parse(f).type === 'task'),
      'one whole task frame carried it'
    )

    // Task ages advance on the page's own clock while no frame arrives.
    const quiet = early.frames.length
    server.clock.advance(2 * MIN)
    await early.waitFor('the age to advance locally', () =>
      /\b(2|3)m ago\b/.test(early.rows().find((r) => r.task === 42)?.cells['last-sign'] ?? '')
    )
    assert.equal(early.frames.length, quiet, 'no frame was needed for the age to move')
    early.close()

    // A page opened later gets the same history from the shared picture, not a second follower.
    const late = await openPage(server)
    await late.waitFor('the late page to show both tasks', () => late.rows().length === 2)
    assert.equal(server.followed.length, 1, 'a second browser never starts a second follower')
    assert.equal(late.rows().find((r) => r.task === task)?.state, 'ready_to_merge')

    // Nothing secret reached the browser: not the read credential, not the launch secret, not a local path.
    const seen = [late.html, ...late.frames]
    for (const route of [REPOSITORIES_ROUTE, TASK_LIST_ROUTE]) {
      seen.push(await (await fetch(`${server.origin}${route}`, { headers: { cookie: server.cookie } })).text())
    }
    for (const text of seen) {
      assert.ok(!text.includes(READ_SECRET), 'the read credential value is never sent')
      assert.ok(!text.includes(LAUNCH_SECRET), 'the launch secret is never sent')
      assert.ok(!text.includes('/private/acceptance'), 'no local path is sent')
      assert.ok(!/authorization/i.test(text), 'no credential header name is sent')
    }
    late.close()
  } finally {
    await server.stop()
  }
}

async function browserReconnectAndUpstreamDrop(): Promise<void> {
  const t0 = Date.parse('2026-11-01T10:00:00.000Z')
  const server = await boot({
    repositories: [repo('widgets', serverSource)],
    source: fixtureSource('server', [{ stream: 'server', raw: loopStarted(7, t0, 'mac') }]),
    startAt: t0 + MIN
  })
  const page = await openPage(server)
  try {
    server.followed[0]?.sink.state?.({ state: 'live' })
    await page.waitFor('live with the row', () => page.status() === 'live' && page.rows().length === 1)

    // The upstream drops: the rows stay and the page says so; it never looks like a live empty board.
    server.followed[0]?.sink.state?.({ state: 'waiting-to-reconnect', reason: 'the Log server is unreachable' })
    await page.waitFor('disconnected after the upstream dropped', () => page.status() === 'disconnected')
    assert.equal(page.rows().length, 1, 'the last picture stays visible')
    assert.ok(!page.document.body.textContent?.includes('No tasks in this Log'))
    server.followed[0]?.sink.state?.({ state: 'live' })
    await page.waitFor('live again', () => page.status() === 'live')

    // The browser's own socket drops: same rule, then a fresh snapshot on the session cookie alone.
    const connections = server.sockets.length
    for (const socket of server.sockets) socket.terminate()
    await page.waitFor('disconnected after the browser dropped', () => page.status() === 'disconnected')
    assert.equal(page.rows().length, 1, 'the last picture stays visible while reconnecting')
    await page.waitFor(
      'a reconnect on a new socket',
      () => server.sockets.length > connections && page.status() === 'live',
      15_000
    )
    assert.equal(page.rows().length, 1)
    assert.equal(JSON.parse(page.frames.at(-1) ?? page.frames[0] ?? '{}').type !== undefined, true)
    assert.ok(
      page.frames.filter((f) => JSON.parse(f).type === 'snapshot').length >= 2,
      'the reconnect began with a fresh snapshot'
    )
  } finally {
    page.close()
    await server.stop()
  }
}

async function silenceAtFiveAndTenMinutes(): Promise<void> {
  const t0 = Date.parse('2026-11-01T10:00:00.000Z')
  const server = await boot({
    repositories: [repo('widgets', serverSource)],
    source: fixtureSource('server', [{ stream: 'server', raw: loopStarted(9, t0, 'mac') }]),
    startAt: t0 + MIN
  })
  const page = await openPage(server)
  try {
    server.followed[0]?.sink.state?.({ state: 'live' })
    await page.waitFor('a running row', () => page.rows().find((r) => r.task === 9)?.state === 'running')
    assert.ok(!('quiet' in (page.rows()[0]?.cells ?? {})), 'a task heard from a minute ago is not quiet')

    // Five minutes of silence: only the server's clock turns it amber; the page never decides.
    server.clock.set(t0 + 5 * MIN + 1_000)
    server.timers.fire()
    await page.waitFor('the quiet flag at five minutes', () => 'quiet' in (page.rows()[0]?.cells ?? {}))
    assert.equal(page.rows()[0]?.state, 'running')

    // Ten minutes: presumed dead.
    server.clock.set(t0 + 10 * MIN + 1_000)
    server.timers.fire()
    await page.waitFor('presumed dead at ten minutes', () => page.rows()[0]?.state === 'presumed_dead')
    assert.ok(page.rows()[0]?.text.includes('Presumed dead'))
  } finally {
    page.close()
    await server.stop()
  }
}

async function emptyAndCredentialFailure(): Promise<void> {
  const t0 = Date.parse('2026-11-01T10:00:00.000Z')
  const empty = await boot({
    repositories: [repo('widgets', serverSource)],
    source: fixtureSource('server', []),
    startAt: t0
  })
  const page = await openPage(empty)
  try {
    await page.waitFor('catching up, not empty', () => page.status() === 'catching-up')
    assert.ok(!page.document.body.textContent?.includes('No tasks in this Log'))
    empty.followed[0]?.sink.state?.({ state: 'live' })
    await page.waitFor('a confirmed empty source', () => page.status() === 'empty')
    assert.ok(page.document.body.textContent?.includes('No tasks in this Log.'))
  } finally {
    page.close()
    await empty.stop()
  }

  const refused = await boot({
    repositories: [
      repo('widgets', {
        ok: false,
        code: 'missing_read_credential',
        message:
          'the read credential is missing — set LOG_READ_TOKEN in the environment Studio is launched from (the value is never shown).'
      })
    ],
    source: fixtureSource('server', []),
    startAt: t0
  })
  const refusedPage = await openPage(refused)
  try {
    await refusedPage.waitFor('the credential failure', () => refusedPage.status() === 'credential-failure')
    assert.ok(!refusedPage.document.body.textContent?.includes('No tasks in this Log'))
  } finally {
    refusedPage.close()
    await refused.stop()
  }
}

function existingScreensStayIntact(): void {
  const run = spawnSync(process.execPath, ['test', join(APP_DIR, 'src/app/studio-shell.test.ts')], { encoding: 'utf8' })
  assert.equal(run.status, 0, `the CMS theme and placeholder screens regressed:\n${run.stdout}\n${run.stderr}`)
}

async function main(): Promise<number> {
  try {
    await scenario('two-machine recorded replay from a local-folder source', twoMachineFolderReplay)
    await scenario('late opening, live change, local ages and no exposed credential', serverLateOpeningAndLiveChange)
    await scenario('upstream drop and browser reconnect keep the last picture', browserReconnectAndUpstreamDrop)
    await scenario('five- and ten-minute silence', silenceAtFiveAndTenMinutes)
    await scenario('confirmed empty source and credential failure', emptyAndCredentialFailure)
    await scenario('the CMS theme and placeholder screens remain intact', async () => existingScreensStayIntact())
  } catch (error) {
    process.stdout.write(`FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    return 1
  }
  process.stdout.write(`PASS: ${results.length} fixture scenarios through the real host, session, protocol and page\n`)
  if (process.argv.includes('--fixtures-only')) return 0
  // Held in a constant so Studio's type program does not follow the CLI's sources.
  const runner = (await import(INSTALL_RUNNER)) as { runInstalledStudioProof: () => Promise<number> }
  return await runner.runInstalledStudioProof()
}

if (import.meta.main) process.exit(await main())
