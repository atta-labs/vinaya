#!/usr/bin/env bun
/**
 * Proves, from a packed installation, that Studio serves a page and accepts an application WebSocket upgrade — the
 * Studio-only half of `verify-published-lifecycle.ts`, so a change to Studio can exercise installed behaviour without
 * the rest of the CLI lifecycle.
 *
 * Run with no arguments it packs this working tree (`npm pack`, whose `prepack` builds the CLI and Studio), installs the
 * tarball into a scratch directory outside the repository, and starts `vinaya studio` from there on a free loopback
 * port. `proveInstalledStudio` is the one proof both this script and the lifecycle's `studio` exercise run; importing
 * this module starts nothing.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join, relative, sep } from 'node:path'
// The route and frame come from the host itself, so the proof cannot drift from what Studio serves.
import { LIVE_ROUTE } from '../../vinaya-studio/src/server/live-protocol'
import { BOOTSTRAP_ROUTE } from '../src/commands/studio'

// The task list route the host registers (`TASK_LIST_ROUTE` in the host, which this script does not import: it pulls in `ws`).
const TASK_LIST_ROUTE = '/api/mission-control/tasks'

const CLI_PKG_DIR = join(import.meta.dir, '..')
const REPO_ROOT = join(CLI_PKG_DIR, '..', '..')

const ANSWER_DEADLINE_MS = 120_000
const STOP_GRACE_MS = 10_000

export type StudioProof = { ok: boolean; detail: string }

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/** Whether an application upgrade with these headers is refused or opens. */
function socketOutcome(url: string, headers: Record<string, string>): Promise<'refused' | 'open'> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers } as never)
    const timer = setTimeout(() => {
      socket.close()
      resolve('refused')
    }, 10_000)
    socket.onmessage = () => {
      clearTimeout(timer)
      socket.close()
      resolve('open')
    }
    socket.onerror = () => {
      clearTimeout(timer)
      resolve('refused')
    }
  })
}

/** Opens the application WebSocket and resolves with the first frame, or rejects at the deadline. */
function firstFrame(url: string, headers: Record<string, string>, deadlineMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers } as never)
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error('no frame before the deadline'))
    }, deadlineMs)
    socket.onmessage = (event) => {
      clearTimeout(timer)
      socket.close()
      resolve(String(event.data))
    }
    socket.onerror = () => {
      clearTimeout(timer)
      reject(new Error('the WebSocket handshake failed'))
    }
  })
}

/**
 * Starts the installed `bin studio` in `cwd` with `env`, then observes an HTTP page and an application WebSocket
 * handshake on the loopback address, that the browser opener was asked to open Studio's address, and that the server
 * stops on SIGTERM within a bound. `cwd` must lie outside this repository, so nothing can fall back to the source
 * checkout; the proof fails when it does not.
 */
export async function proveInstalledStudio(options: {
  bin: string
  cwd: string
  env: NodeJS.ProcessEnv
  scratchDir: string
}): Promise<StudioProof> {
  const { bin, cwd, env, scratchDir } = options
  const fromRepo = relative(REPO_ROOT, cwd)
  if (!fromRepo.startsWith(`..${sep}`) && fromRepo !== '..' && !/^[a-zA-Z]:/.test(fromRepo)) {
    return { ok: false, detail: `the working directory ${cwd} is inside the source checkout` }
  }
  if (!existsSync(bin)) return { ok: false, detail: `the installed command ${bin} does not exist` }

  const port = await freeLoopbackPort()
  // The browser opener is a stub earlier on PATH that records the address instead of opening anything.
  const stubDir = mkdtempSync(join(scratchDir, 'studio-opener-'))
  const openedPath = join(stubDir, 'opened.txt')
  for (const opener of ['open', 'xdg-open']) {
    writeFileSync(join(stubDir, opener), `#!/bin/sh\necho "$1" >> "${openedPath}"\n`, { mode: 0o755 })
  }
  const childEnv = { ...env, PATH: `${stubDir}${delimiter}${env.PATH ?? ''}` }
  // The launch observes a git checkout: a fresh one with the proof started from a nested folder of it, as a user's
  // shell may be. It lies in `cwd`, outside this repository.
  const repoDir = mkdtempSync(join(cwd, 'studio-checkout-'))
  execFileSync('git', ['init', '-q'], { cwd: repoDir })
  const nested = join(repoDir, 'packages', 'app')
  mkdirSync(nested, { recursive: true })
  const child = spawn(bin, ['studio', '--port', String(port)], {
    cwd: nested,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (d: Buffer) => {
      output += d.toString()
    })
  }
  const state: { exitCode: number | null } = { exitCode: null }
  child.on('close', (code) => {
    state.exitCode = code ?? 0
  })

  try {
    const origin = `http://127.0.0.1:${port}`
    // Anything that answers HTTP is up; an unauthenticated page is refused, so only the status says it is alive.
    let answered = false
    const deadline = Date.now() + ANSWER_DEADLINE_MS
    while (!answered && state.exitCode === null && Date.now() < deadline) {
      try {
        await fetch(`${origin}/`, { signal: AbortSignal.timeout(5_000) })
        answered = true
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
    if (!answered) {
      return {
        ok: false,
        detail: `no page answered, exited early: ${state.exitCode ?? 'no'} — ${output.trim().slice(-300)}`
      }
    }

    // Without the session nothing is readable: no page, no task data, no application socket.
    for (const path of ['/', TASK_LIST_ROUTE]) {
      const res = await fetch(`${origin}${path}`)
      if (res.status !== 401) return { ok: false, detail: `${path} without a session answered ${res.status}, not 401` }
    }
    if ((await socketOutcome(`ws://127.0.0.1:${port}${LIVE_ROUTE}`, { origin })) !== 'refused') {
      return { ok: false, detail: 'the application upgrade opened without a session' }
    }

    // The opener runs just after the port answers; give it a moment to record the one-time link.
    for (let i = 0; i < 20 && !existsSync(openedPath); i++) await new Promise((resolve) => setTimeout(resolve, 250))
    const opened = existsSync(openedPath) ? readFileSync(openedPath, 'utf-8').trim() : ''
    let link: URL
    try {
      link = new URL(opened)
    } catch {
      return { ok: false, detail: `the browser opener received "${opened}"` }
    }
    if (link.origin !== origin || link.pathname !== BOOTSTRAP_ROUTE || !link.searchParams.get('token')) {
      return { ok: false, detail: `the browser opener received "${opened.replace(/token=[^&]*/, 'token=…')}"` }
    }

    // A forged secret is refused and does not spend the real one.
    const forged = await fetch(`${origin}${BOOTSTRAP_ROUTE}?token=${'A'.repeat(43)}`, { redirect: 'manual' })
    if (forged.status !== 403) return { ok: false, detail: `a forged link answered ${forged.status}, not 403` }

    const exchange = await fetch(opened, { redirect: 'manual' })
    const cookie = exchange.headers.get('set-cookie')?.split(';')[0] ?? ''
    if (exchange.status !== 303 || exchange.headers.get('location') !== '/' || !cookie) {
      return { ok: false, detail: `the one-time link answered ${exchange.status} with no session cookie` }
    }
    if (/HttpOnly/i.test(exchange.headers.get('set-cookie') ?? '') === false) {
      return { ok: false, detail: 'the session cookie is not HttpOnly' }
    }
    const reused = await fetch(opened, { redirect: 'manual' })
    if (reused.status !== 403 || reused.headers.get('set-cookie')) {
      return { ok: false, detail: `reusing the one-time link answered ${reused.status}, not 403` }
    }

    const page = await fetch(`${origin}/`, { headers: { cookie } })
    if (page.status !== 200) return { ok: false, detail: `the protected page answered ${page.status} with the session` }
    const tasks = await fetch(`${origin}${TASK_LIST_ROUTE}`, { headers: { cookie } })
    if (tasks.status !== 200) return { ok: false, detail: `the task route answered ${tasks.status} with the session` }
    const hostile = await fetch(`${origin}${TASK_LIST_ROUTE}`, { headers: { cookie, origin: 'http://evil.example' } })
    if (hostile.status !== 403) return { ok: false, detail: `a hostile Origin answered ${hostile.status}, not 403` }

    const url = `ws://127.0.0.1:${port}${LIVE_ROUTE}`
    if ((await socketOutcome(url, { cookie, origin: 'http://evil.example' })) !== 'refused') {
      return { ok: false, detail: 'the application upgrade opened for a hostile Origin' }
    }
    let frame = ''
    try {
      frame = await firstFrame(url, { cookie, origin }, 10_000)
    } catch (error) {
      return { ok: false, detail: `${(error as Error).message} — ${output.trim().slice(-300)}` }
    }
    let first: { v?: unknown; type?: unknown; repositories?: unknown } = {}
    try {
      first = JSON.parse(frame)
    } catch {
      // reported below
    }
    if (first.v !== 1 || first.type !== 'snapshot' || !Array.isArray(first.repositories)) {
      return {
        ok: false,
        detail: `the application upgrade did not open with a version-1 snapshot: "${frame.slice(0, 120)}"`
      }
    }
    // The page the browser opens is the live list, still connecting when the server renders it; no secret is in it.
    const html = await page.text()
    if (!html.includes('data-board-status="connecting"')) {
      return { ok: false, detail: 'the protected page is not the live task list in its connecting state' }
    }
    const secret = link.searchParams.get('token') ?? ''
    if (html.includes(secret) || frame.includes(secret)) {
      return { ok: false, detail: 'the launch secret reached the page or the application socket' }
    }

    return {
      ok: true,
      detail: `packed Studio, started from a nested folder of a git checkout, refused every request without a session, exchanged its single-use link once (reuse and a forged link refused), then served its protected live-list page and an application WebSocket that opens with a snapshot on 127.0.0.1:${port}`
    }
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
    child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      if (state.exitCode !== null) return resolve()
      const killer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS)
      child.once('close', () => {
        clearTimeout(killer)
        resolve()
      })
    })
    rmSync(stubDir, { recursive: true, force: true })
  }
}

/** Packs this working tree, installs it into a scratch directory and runs the installed-Studio proof there. */
export async function runInstalledStudioProof(): Promise<number> {
  const root = mkdtempSync(join(tmpdir(), 'vinaya-studio-install-'))
  try {
    const installDir = join(root, 'install')
    const homeDir = join(root, 'home')
    const workDir = join(root, 'work')
    for (const dir of [installDir, homeDir, workDir]) mkdirSync(dir, { recursive: true })

    process.stdout.write(`packing ${CLI_PKG_DIR} (prepack builds the CLI and Studio)…\n`)
    const packed = execFileSync('npm', ['pack', '--pack-destination', root], { cwd: CLI_PKG_DIR, encoding: 'utf8' })
    const tarball = packed.trim().split('\n').at(-1) ?? ''
    if (!tarball.endsWith('.tgz')) throw new Error(`npm pack did not report a tarball filename (got: "${tarball}")`)

    process.stdout.write(`installing ${tarball} into ${installDir}…\n`)
    execFileSync('npm', ['init', '-y', '--silent'], { cwd: installDir, stdio: 'ignore' })
    execFileSync('npm', ['install', join(root, tarball), '--no-audit', '--no-fund', '--silent'], {
      cwd: installDir,
      stdio: 'inherit'
    })

    const result = await proveInstalledStudio({
      bin: join(installDir, 'node_modules', '.bin', 'vinaya'),
      cwd: workDir,
      env: { ...process.env, HOME: homeDir },
      scratchDir: root
    })
    process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'}: ${result.detail}\n`)
    return result.ok ? 0 : 1
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

if (import.meta.main) process.exit(await runInstalledStudioProof())
