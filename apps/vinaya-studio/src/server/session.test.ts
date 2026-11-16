import { afterEach, describe, expect, test } from 'bun:test'
import { request } from 'node:http'
import { WebSocket } from 'ws'
import { createStudioHost, LIVE_HELLO, LIVE_ROUTE, type NextFactory, type StudioHost, TASK_LIST_ROUTE } from './host.ts'
import { BOOTSTRAP_ROUTE, bootstrapUrl, createLaunchSecret } from './session.ts'

const hosts: StudioHost[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.close()))
})

const fakeNext: NextFactory = () => ({
  prepare: async () => {},
  getRequestHandler: () => (req, res) => {
    res.end(`page:${req.url}`)
  }
})

async function start(options: { ttlMs?: number; clock?: () => number } = {}) {
  const secret = createLaunchSecret()
  const host = createStudioHost({
    dir: '.',
    hostname: '127.0.0.1',
    port: 0,
    dev: false,
    next: fakeNext,
    clock: options.clock,
    session: { secret, ttlMs: options.ttlMs }
  })
  hosts.push(host)
  const port = await host.listen()
  return { host, port, secret, origin: `http://127.0.0.1:${port}` }
}

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function send(port: number, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let body = ''
        res.on('data', (d) => (body += d))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

/** Exchanges the launch secret and returns the cookie a browser would then send. */
async function signIn(port: number, secret: string): Promise<string> {
  const reply = await send(port, `${BOOTSTRAP_ROUTE}?token=${secret}`)
  expect(reply.status).toBe(303)
  const cookie = String(reply.headers['set-cookie']).split(';')[0] as string
  expect(cookie).toContain('=')
  return cookie
}

function upgrade(url: string, headers: Record<string, string>): Promise<'open' | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers })
    ws.once('message', () => {
      ws.close()
      resolve('open')
    })
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
    ws.once('error', () => resolve(0))
  })
}

describe('the bootstrap exchange', () => {
  test('a valid link sets an HttpOnly same-site cookie and redirects to the clean address, uncached and unreferred', async () => {
    const { port, secret } = await start()
    const reply = await send(port, `${BOOTSTRAP_ROUTE}?token=${secret}`)
    expect(reply.status).toBe(303)
    expect(reply.headers.location).toBe('/')
    expect(String(reply.headers['set-cookie'])).toMatch(/HttpOnly/)
    expect(String(reply.headers['set-cookie'])).toMatch(/SameSite=Strict/)
    expect(String(reply.headers['set-cookie'])).not.toContain(secret)
    expect(reply.headers['cache-control']).toBe('no-store')
    expect(reply.headers['referrer-policy']).toBe('no-referrer')
    expect(reply.body).not.toContain(secret)
  })

  test('the link works once: reuse is refused and the session it made keeps working', async () => {
    const { port, secret } = await start()
    const cookie = await signIn(port, secret)
    expect((await send(port, `${BOOTSTRAP_ROUTE}?token=${secret}`)).status).toBe(403)
    expect((await send(port, TASK_LIST_ROUTE, { cookie })).status).toBe(200)
  })

  test('a wrong, malformed, missing or oversized token is refused and does not burn the real one', async () => {
    const { port, secret } = await start()
    for (const path of [
      `${BOOTSTRAP_ROUTE}?token=${createLaunchSecret()}`,
      `${BOOTSTRAP_ROUTE}?token=short`,
      `${BOOTSTRAP_ROUTE}?token=${'A'.repeat(500)}`,
      BOOTSTRAP_ROUTE
    ]) {
      const reply = await send(port, path)
      expect([400, 403]).toContain(reply.status)
      expect(reply.headers['set-cookie']).toBeUndefined()
    }
    expect((await send(port, `${BOOTSTRAP_ROUTE}?token=${secret}`)).status).toBe(303)
  })

  test('an expired link is refused', async () => {
    let now = 1_000
    const { port, secret } = await start({ ttlMs: 60_000, clock: () => now })
    now += 60_001
    const reply = await send(port, `${BOOTSTRAP_ROUTE}?token=${secret}`)
    expect(reply.status).toBe(403)
    expect(reply.headers['set-cookie']).toBeUndefined()
  })

  test('only a GET from this server exchanges: another method, Host, Origin or cross-site fetch is refused', async () => {
    const { port, secret } = await start()
    const path = `${BOOTSTRAP_ROUTE}?token=${secret}`
    expect((await send(port, path, {}, 'POST')).status).toBe(405)
    expect((await send(port, path, { host: 'evil.example' })).status).toBe(403)
    expect((await send(port, path, { origin: 'http://evil.example' })).status).toBe(403)
    expect((await send(port, path, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await send(port, path)).status).toBe(303)
  })

  test('the launcher link carries the secret on the bootstrap route only', () => {
    expect(bootstrapUrl('http://127.0.0.1:1', 'S')).toBe(`http://127.0.0.1:1${BOOTSTRAP_ROUTE}?token=S`)
  })
})

describe('protected requests', () => {
  test('no cookie reads nothing: neither a page nor task data', async () => {
    const { port } = await start()
    for (const path of ['/', TASK_LIST_ROUTE, '/_next/static/x.js']) {
      const reply = await send(port, path)
      expect(reply.status).toBe(401)
      expect(reply.body).not.toContain('page:')
      expect(reply.body).not.toContain('tasks')
    }
  })

  test('a forged cookie reads nothing', async () => {
    const { port, secret } = await start()
    const cookie = await signIn(port, secret)
    const name = cookie.split('=')[0]
    expect((await send(port, TASK_LIST_ROUTE, { cookie: `${name}=${'x'.repeat(43)}` })).status).toBe(401)
  })

  test('the session opens pages and data, and a safe GET needs no Origin', async () => {
    const { port, secret } = await start()
    const cookie = await signIn(port, secret)
    expect(await send(port, '/', { cookie })).toMatchObject({ status: 200, body: 'page:/' })
    expect((await send(port, TASK_LIST_ROUTE, { cookie })).status).toBe(200)
    expect((await send(port, '/', { cookie, 'sec-fetch-site': 'none' })).status).toBe(200)
  })

  test('a wrong Host, a mismatched or null Origin and a cross-site fetch are refused even with the cookie', async () => {
    const { port, secret, origin } = await start()
    const cookie = await signIn(port, secret)
    expect((await send(port, TASK_LIST_ROUTE, { cookie, host: 'localhost.evil.example' })).status).toBe(403)
    expect((await send(port, TASK_LIST_ROUTE, { cookie, host: `localhost:${port}` })).status).toBe(403)
    expect((await send(port, TASK_LIST_ROUTE, { cookie, origin: 'http://evil.example' })).status).toBe(403)
    expect((await send(port, TASK_LIST_ROUTE, { cookie, origin: 'null' })).status).toBe(403)
    expect((await send(port, TASK_LIST_ROUTE, { cookie, 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await send(port, TASK_LIST_ROUTE, { cookie, origin })).status).toBe(200)
  })

  test('a state-changing request must name this server as its Origin', async () => {
    const { port, secret, origin } = await start()
    const cookie = await signIn(port, secret)
    expect((await send(port, '/', { cookie }, 'POST')).status).toBe(403)
    expect((await send(port, '/', { cookie, origin }, 'POST')).status).toBe(200)
  })

  test('closing Studio ends the session', async () => {
    const { host, port, secret } = await start()
    const cookie = await signIn(port, secret)
    expect((await send(port, TASK_LIST_ROUTE, { cookie })).status).toBe(200)
    await host.close()
    await expect(send(port, TASK_LIST_ROUTE, { cookie })).rejects.toBeDefined()
  })
})

describe('application upgrades', () => {
  test('the cookie and the exact local Origin open the application socket', async () => {
    const { port, secret, origin } = await start()
    const cookie = await signIn(port, secret)
    const ws = new WebSocket(`ws://127.0.0.1:${port}${LIVE_ROUTE}`, { headers: { cookie, origin } })
    const first = await new Promise<string>((resolve, reject) => {
      ws.once('message', (d) => resolve(d.toString()))
      ws.once('error', reject)
    })
    ws.close()
    expect(first).toBe(LIVE_HELLO)
  })

  test('no cookie, no Origin, or a hostile, null or wrong Origin is refused', async () => {
    const { port, secret, origin } = await start()
    const cookie = await signIn(port, secret)
    const url = `ws://127.0.0.1:${port}${LIVE_ROUTE}`
    expect(await upgrade(url, { origin })).toBe(401)
    expect(await upgrade(url, { cookie })).toBe(403)
    expect(await upgrade(url, { cookie, origin: 'http://evil.example' })).toBe(403)
    expect(await upgrade(url, { cookie, origin: 'null' })).toBe(403)
    expect(await upgrade(url, { cookie, origin: `http://localhost:${port}` })).toBe(403)
  })
})
