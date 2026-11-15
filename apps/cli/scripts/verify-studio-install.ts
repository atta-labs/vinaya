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
import { LIVE_HELLO, LIVE_ROUTE } from '../../vinaya-studio/src/server/live-protocol'

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

/** Opens the application WebSocket and resolves with the first frame, or rejects at the deadline. */
function firstFrame(url: string, deadlineMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
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
  const child = spawn(bin, ['studio', '--port', String(port)], {
    cwd,
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
    let page = ''
    const deadline = Date.now() + ANSWER_DEADLINE_MS
    while (!page && state.exitCode === null && Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5_000) })
        if (res.status === 200) page = await res.text()
        else await new Promise((resolve) => setTimeout(resolve, 500))
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
    if (!page) {
      return {
        ok: false,
        detail: `no page answered, exited early: ${state.exitCode ?? 'no'} — ${output.trim().slice(-300)}`
      }
    }

    let frame = ''
    try {
      frame = await firstFrame(`ws://127.0.0.1:${port}${LIVE_ROUTE}`, 10_000)
    } catch (error) {
      return { ok: false, detail: `${(error as Error).message} — ${output.trim().slice(-300)}` }
    }
    if (frame !== LIVE_HELLO) return { ok: false, detail: `the application upgrade answered "${frame}"` }

    // The opener runs just after the port answers; give it a moment to record the address.
    for (let i = 0; i < 20 && !existsSync(openedPath); i++) await new Promise((resolve) => setTimeout(resolve, 250))
    const opened = existsSync(openedPath) ? readFileSync(openedPath, 'utf-8').trim() : ''
    if (opened !== `http://127.0.0.1:${port}`) return { ok: false, detail: `the browser opener received "${opened}"` }

    return {
      ok: true,
      detail: `packed Studio served a page and an application WebSocket handshake on 127.0.0.1:${port}, and the browser was asked to open ${opened}`
    }
  } finally {
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

async function main(): Promise<number> {
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

if (import.meta.main) process.exit(await main())
