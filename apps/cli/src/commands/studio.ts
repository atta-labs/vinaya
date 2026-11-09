import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import net from 'node:net'
import { dirname, join } from 'node:path'
import { packageRoot } from '../lib/package-root.js'
import {
  repairStudioNodeModules,
  STUDIO_APP_RELPATH,
  STUDIO_BUNDLE_DIRNAME,
  STUDIO_PACKAGE_NAME,
  studioServerDir
} from '../lib/studio-bundle.js'

/** Studio listens on the user's own machine only. */
export const STUDIO_HOST = '127.0.0.1'
export const PRIMARY_PORT = 3008
export const FALLBACK_PORT = 3108

const WAIT_FOR_PORT_MS = 120_000
const POLL_MS = 150

export type StudioTarget =
  | { kind: 'checkout'; appDir: string }
  | { kind: 'shipped'; bundleRoot: string; serverDir: string }
  | { kind: 'missing' }

/**
 * The one resolution seam, in this order:
 *   1. checkout — walk up from `cwd` for `apps/vinaya-studio/package.json` named `@vinaya/studio`; Studio runs from
 *      its source, for development.
 *   2. shipped — this installed package's own `studio-standalone/` folder, assembled at pack time by
 *      `scripts/bundle-studio.ts`. `moduleUrl` is a parameter so a test can hand in a fake install root.
 *   3. missing — neither found.
 */
export function resolveStudioTarget(cwd: string, moduleUrl: string = import.meta.url): StudioTarget {
  let dir = cwd
  for (;;) {
    const appDir = join(dir, ...STUDIO_APP_RELPATH.split('/'))
    const manifest = join(appDir, 'package.json')
    if (existsSync(manifest)) {
      try {
        if ((JSON.parse(readFileSync(manifest, 'utf-8')) as { name?: unknown }).name === STUDIO_PACKAGE_NAME) {
          return { kind: 'checkout', appDir }
        }
      } catch {
        // an unreadable manifest is not Studio — keep walking up
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  const bundleRoot = join(packageRoot(moduleUrl), STUDIO_BUNDLE_DIRNAME)
  const serverDir = studioServerDir(bundleRoot)
  if (existsSync(join(serverDir, 'server.js'))) return { kind: 'shipped', bundleRoot, serverDir }

  return { kind: 'missing' }
}

export type PortChoice = { ok: true; port: number } | { ok: false; message: string }

/** True when nothing is listening on the loopback address at `port`. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer()
    tester.once('error', () => resolve(false))
    tester.once('listening', () => tester.close(() => resolve(true)))
    tester.listen(port, STUDIO_HOST)
  })
}

/** True once something accepts a connection on the loopback address at `port`. */
export function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: STUDIO_HOST })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      socket.destroy()
      resolve(false)
    })
  })
}

/**
 * Which port Studio takes: an explicit port exactly, or a refusal when it is taken; otherwise the primary port, or
 * the fallback when the primary is taken, or a refusal when both are.
 */
export async function choosePort(
  explicit: number | null,
  free: (port: number) => Promise<boolean> = isPortFree,
  ports: { primary: number; fallback: number } = { primary: PRIMARY_PORT, fallback: FALLBACK_PORT }
): Promise<PortChoice> {
  if (explicit !== null) {
    return (await free(explicit))
      ? { ok: true, port: explicit }
      : { ok: false, message: `Port ${explicit} is taken. Pick another with --port, or leave the port unset.` }
  }
  if (await free(ports.primary)) return { ok: true, port: ports.primary }
  if (await free(ports.fallback)) return { ok: true, port: ports.fallback }
  return { ok: false, message: `Ports ${ports.primary} and ${ports.fallback} are both taken. Pick one with --port.` }
}

/** The `--port <n>` or `--port=<n>` flag: null when absent, an error message when it is not a port. */
export function parsePortFlag(args: string[]): { port: number | null } | { error: string } {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    let raw: string | undefined
    if (arg === '--port') raw = args[i + 1]
    else if (arg.startsWith('--port=')) raw = arg.slice('--port='.length)
    else continue
    const port = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : Number.NaN
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { error: `--port needs a number from 1 to 65535, got "${raw ?? ''}".` }
    }
    return { port }
  }
  return { port: null }
}

/**
 * The environment the Studio server starts with. Loopback and the chosen port are set AFTER the caller's
 * environment is spread, so a caller's `HOSTNAME` or `PORT` can never make Studio listen on another interface.
 */
export function studioEnv(base: NodeJS.ProcessEnv, port: number): NodeJS.ProcessEnv {
  return { ...base, HOSTNAME: STUDIO_HOST, PORT: String(port) }
}

export type SpawnPlan = { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }

/**
 * How each shape starts. A checkout runs the app's own dev server with host and port on the command line — not the
 * app's `dev` script, which fixes both and would never let the fallback port apply. The shipped server reads
 * `HOSTNAME` and `PORT` from its environment.
 */
export function planLaunch(
  target: Exclude<StudioTarget, { kind: 'missing' }>,
  cwd: string,
  port: number,
  base: NodeJS.ProcessEnv
): SpawnPlan {
  const env = studioEnv(base, port)
  if (target.kind === 'checkout') {
    return {
      command: 'bun',
      args: ['run', 'next', 'dev', '--hostname', STUDIO_HOST, '--port', String(port)],
      cwd: target.appDir,
      env
    }
  }
  return { command: 'node', args: [join(target.serverDir, 'server.js')], cwd, env }
}

/** Opens `url` in the user's browser with the platform's own opener; resolves false when it cannot. */
export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const [command, args] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]]
  return new Promise((resolve) => {
    try {
      const child = spawn(command as string, args as string[], { stdio: 'ignore', detached: true })
      child.once('error', () => resolve(false))
      child.once('exit', (code) => resolve(code === 0))
      child.unref()
    } catch {
      resolve(false)
    }
  })
}

export type StudioDeps = {
  moduleUrl?: string
  env?: NodeJS.ProcessEnv
  ports?: { primary: number; fallback: number }
  free?: (port: number) => Promise<boolean>
  answers?: (port: number) => Promise<boolean>
  openBrowser?: (url: string) => Promise<boolean>
  waitMs?: number
  log?: (line: string) => void
  error?: (line: string) => void
}

export type StudioLaunch = { port: number; url: string; child: ChildProcess; exited: Promise<number> }

/**
 * Starts Studio and returns once it answers on its port and the browser has been asked to open. Resolves to an exit
 * code instead when Studio could not be started.
 */
export async function launchStudio(
  cwd: string,
  args: string[],
  deps: StudioDeps = {}
): Promise<StudioLaunch | { exitCode: number }> {
  const log = deps.log ?? ((line: string) => console.log(line))
  const error = deps.error ?? ((line: string) => console.error(line))

  const target = resolveStudioTarget(cwd, deps.moduleUrl)
  if (target.kind === 'missing') {
    error(
      'This package is missing Studio: no Studio app in this checkout and no shipped Studio in this install. ' +
        'Reinstall `@attalabs/vinaya`, or run this from a checkout of the vinaya repository.'
    )
    return { exitCode: 1 }
  }

  const flag = parsePortFlag(args)
  if ('error' in flag) {
    error(flag.error)
    return { exitCode: 2 }
  }
  const choice = await choosePort(flag.port, deps.free, deps.ports)
  if (!choice.ok) {
    error(choice.message)
    return { exitCode: 1 }
  }
  const { port } = choice
  const ports = deps.ports ?? { primary: PRIMARY_PORT, fallback: FALLBACK_PORT }
  if (flag.port === null && port !== ports.primary) {
    log(`[studio] port ${ports.primary} is taken — using ${port}`)
  }

  if (target.kind === 'shipped') repairStudioNodeModules(target.bundleRoot)

  const plan = planLaunch(target, cwd, port, deps.env ?? process.env)
  const child = spawn(plan.command, plan.args, { cwd: plan.cwd, env: plan.env, stdio: 'inherit' })
  let exitedEarly = false
  const exited = new Promise<number>((resolve) => {
    child.once('error', (e) => {
      error(`Could not start Studio: ${e.message}`)
      exitedEarly = true
      resolve(1)
    })
    child.once('exit', (code) => {
      exitedEarly = true
      resolve(code ?? 0)
    })
  })

  const probe = deps.answers ?? answers
  const deadline = Date.now() + (deps.waitMs ?? WAIT_FOR_PORT_MS)
  while (!(await probe(port))) {
    if (exitedEarly) return { exitCode: await exited }
    if (Date.now() > deadline) {
      child.kill()
      error(`Studio did not answer on port ${port} in time.`)
      return { exitCode: 1 }
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }

  const url = `http://${STUDIO_HOST}:${port}`
  let opened = false
  try {
    opened = await (deps.openBrowser ?? openInBrowser)(url)
  } catch {
    opened = false
  }
  // A browser that cannot be opened never fails the launch; the address is printed once instead.
  if (!opened) log(`Studio is running. Open ${url} in your browser.`)
  return { port, url, child, exited }
}

/** Runs the `studio` command: launches Studio and resolves with its exit code once it stops. */
export async function runStudio(cwd: string, args: string[], deps: StudioDeps = {}): Promise<number> {
  const launch = await launchStudio(cwd, args, deps)
  if ('exitCode' in launch) return launch.exitCode
  const stop = () => launch.child.kill()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    return await launch.exited
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

export async function studioCommand(args: string[]): Promise<void> {
  process.exitCode = await runStudio(process.cwd(), args)
}
