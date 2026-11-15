import { afterEach, describe, expect, test } from 'bun:test'
import type { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { WebSocket } from 'ws'
import { createStudioHost, LIVE_HELLO, LIVE_ROUTE, type NextFactory, type StudioHost, TASK_LIST_ROUTE } from './host'

const hosts: StudioHost[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.close()))
})

/** A stand-in for Next: pages answer "page:<path>", and it listens for upgrades on the emitter it was given. */
function fakeNext(seen: { hmr: string[] }): NextFactory {
  return ({ httpServer }) => {
    ;(httpServer as unknown as EventEmitter).on('upgrade', (req: IncomingMessage, socket: { destroy(): void }) => {
      seen.hmr.push(req.url ?? '')
      socket.destroy()
    })
    return {
      prepare: async () => {},
      getRequestHandler: () => (req: IncomingMessage, res: ServerResponse) => {
        res.end(`page:${req.url}`)
      }
    }
  }
}

async function start(extra: Partial<Parameters<typeof createStudioHost>[0]> = {}) {
  const seen = { hmr: [] as string[] }
  const host = createStudioHost({
    dir: '.',
    hostname: '127.0.0.1',
    port: 0,
    dev: false,
    next: fakeNext(seen),
    ...extra
  })
  hosts.push(host)
  const port = await host.listen()
  return { host, port, seen }
}

function opened(url: string): Promise<{ ws: WebSocket; first: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once('message', (data) => resolve({ ws, first: data.toString() }))
    ws.once('error', reject)
  })
}

describe('createStudioHost', () => {
  test('importing starts no listener; a page request reaches Next', async () => {
    const { port } = await start()
    const res = await fetch(`http://127.0.0.1:${port}/some/page`)
    expect(await res.text()).toBe('page:/some/page')
  })

  test('the application upgrade is answered by the host and never reaches Next', async () => {
    const { port, seen } = await start()
    const { ws, first } = await opened(`ws://127.0.0.1:${port}${LIVE_ROUTE}`)
    expect(first).toBe(LIVE_HELLO)
    expect(seen.hmr).toEqual([])
    ws.close()
  })

  test('an upgrade on any other path is delegated to Next', async () => {
    const { port, seen } = await start()
    const ws = new WebSocket(`ws://127.0.0.1:${port}/_next/webpack-hmr`)
    await new Promise((resolve) => ws.once('error', resolve))
    expect(seen.hmr).toEqual(['/_next/webpack-hmr'])
  })

  test('the task-list endpoint carries no repository data', async () => {
    const { port } = await start()
    const res = await fetch(`http://127.0.0.1:${port}${TASK_LIST_ROUTE}`)
    expect(await res.json()).toEqual({ tasks: [] })
  })

  test('compose registers routes and receives the injected clock', async () => {
    const { port } = await start({
      clock: () => 42,
      compose: (c) => c.route('/api/now', (_req, res) => void res.end(String(c.clock())))
    })
    expect(await (await fetch(`http://127.0.0.1:${port}/api/now`)).text()).toBe('42')
  })

  test('an application upgrade from another origin, or to another host name, is refused', async () => {
    const { port } = await start()
    const foreign = new WebSocket(`ws://127.0.0.1:${port}${LIVE_ROUTE}`, { origin: 'http://evil.example' })
    await new Promise((resolve) => foreign.once('error', resolve))
    const rebound = new WebSocket(`ws://127.0.0.1:${port}${LIVE_ROUTE}`, { headers: { host: `evil.example:${port}` } })
    await new Promise((resolve) => rebound.once('error', resolve))
    const same = await opened(`ws://127.0.0.1:${port}${LIVE_ROUTE}`)
    expect(same.first).toBe(LIVE_HELLO)
    same.ws.close()
  })

  test('an application HTTP route refuses a foreign origin and a non-loopback host name', async () => {
    const { port } = await start()
    const url = `http://127.0.0.1:${port}${TASK_LIST_ROUTE}`
    expect((await fetch(url, { headers: { origin: 'http://evil.example' } })).status).toBe(403)
    expect((await fetch(url, { headers: { origin: `http://127.0.0.1:${port}` } })).status).toBe(200)
  })

  test('close ends open sockets and the listener within the grace', async () => {
    const { host, port } = await start()
    const { ws } = await opened(`ws://127.0.0.1:${port}${LIVE_ROUTE}`)
    const closed = new Promise((resolve) => ws.once('close', resolve))
    const started = Date.now()
    await host.close()
    await closed
    expect(Date.now() - started).toBeLessThan(4_000)
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow()
  })
})
