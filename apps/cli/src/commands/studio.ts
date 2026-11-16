import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import {
  prepareShippedStudio,
  STUDIO_APP_RELPATH,
  STUDIO_ENTRY_FILENAME,
  STUDIO_PACKAGE_NAME
} from '../lib/studio-bundle.js'

/** Studio listens on the user's own machine only. */
export const STUDIO_HOST = '127.0.0.1'
export const PRIMARY_PORT = 3008
export const FALLBACK_PORT = 3108

/** The one-time bootstrap route Studio's server answers before any other request; the launcher's address carries its secret. */
export const BOOTSTRAP_ROUTE = '/__studio/bootstrap'

/** Where a checkout's Studio host is bundled for Node before it starts, beside Next's own output. */
const CHECKOUT_HOST_RELPATH = join('.next', 'studio-host', 'entry.mjs')

/**
 * The Log follower and the folder source the Studio server loads at run time, each built for Node beside the host (a
 * checkout's host folder, the packed bundle's server folder). `entry` is relative to the repository root; `out` is the
 * file name the server (`picture-service.ts`) loads from its own folder.
 */
export const STUDIO_LOG_RUNTIME_FILES = [
  { entry: 'harness/kernel/log/client/log-follow.ts', out: 'log-follow.mjs' },
  { entry: 'harness/kernel/log/client/log-sync-folder-source.ts', out: 'log-sync-folder-source.mjs' }
] as const

/** The `bun build` arguments that bundle one TypeScript entry for Node, leaving the named packages external. */
export function studioBuildArgs(entry: string, outfile: string, externals: readonly string[] = []): string[] {
  const flags = externals.map((name) => `--external=${name}`)
  return ['build', entry, '--target=node', '--format=esm', ...flags, `--outfile=${outfile}`]
}

const GIT_TIMEOUT_MS = 5_000
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
 *   2. shipped — this installed package's own `studio-standalone/` deployment bundle, assembled at pack time by
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

  const shipped = prepareShippedStudio(moduleUrl)
  return shipped ? { kind: 'shipped', ...shipped } : { kind: 'missing' }
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
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(base)) if (!isWithheldFromStudio(name)) env[name] = value
  return { ...env, HOSTNAME: STUDIO_HOST, PORT: String(port) }
}

/**
 * Studio reads a Log and shows it; it never writes one or acts on the forge. The Log ingest token, forge tokens and
 * provider API keys stay out of its environment. The read credential a repository's `logs.readHeaders` names is not
 * among them, so it still resolves.
 */
const WITHHELD_NAMES = new Set(['VINAYA_LOG_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN'])
function isWithheldFromStudio(name: string): boolean {
  return WITHHELD_NAMES.has(name) || /_API_KEY$/.test(name)
}

/** A fresh one-time launch secret: 256 random bits, base64url. */
export function createLaunchSecret(): string {
  return randomBytes(32).toString('base64url')
}

/** The address the launcher opens: the bootstrap route carrying the launch secret. */
export function bootstrapUrl(origin: string, secret: string): string {
  return `${origin}${BOOTSTRAP_ROUTE}?token=${secret}`
}

export type LaunchRepository = { root: string; remote: { owner: string; repo: string } | null }

/** Every `--repo <path>` / `--repo=<path>`, in order. A flag with no value is an error. */
export function parseRepoFlags(args: string[]): { paths: string[] } | { error: string } {
  const paths: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    let raw: string | undefined
    if (arg === '--repo') raw = args[++i]
    else if (arg.startsWith('--repo=')) raw = arg.slice('--repo='.length)
    else continue
    if (!raw) return { error: '--repo needs the path of a local checkout.' }
    paths.push(raw)
  }
  return { paths }
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS
    }).trim()
  } catch {
    return null
  }
}

/** `owner/repo` from an `origin` URL, whatever the host or scheme; null when it does not name one. */
export function remoteIdentity(url: string): { owner: string; repo: string } | null {
  const m = url.trim().match(/[:/]([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/)
  return m?.[1] && m[2] ? { owner: m[1], repo: m[2] } : null
}

/**
 * The checkouts one launch observes, from local git only: each path (the current directory when no `--repo` is given)
 * becomes its canonical top-level folder, so a nested folder or a linked worktree resolves the same way anywhere, and
 * its `origin` URL becomes the owner/repo identity. Nothing asks the forge.
 */
export function resolveLaunchRepositories(
  cwd: string,
  paths: string[]
): { repositories: LaunchRepository[] } | { error: string } {
  const repositories: LaunchRepository[] = []
  for (const path of paths.length > 0 ? paths : ['.']) {
    const from = resolve(cwd, path)
    const top = git(from, ['rev-parse', '--show-toplevel'])
    if (!top) return { error: `${from} is not inside a git checkout.` }
    const root = realpathSync(top)
    if (repositories.some((r) => r.root === root)) continue
    const url = git(root, ['remote', 'get-url', 'origin'])
    repositories.push({ root, remote: url ? remoteIdentity(url) : null })
  }
  return { repositories }
}

export type SpawnPlan = {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  /** Runs once before `command`, to bundle a checkout's host for Node. */
  prepare?: { command: string; args: string[] }
  /** Runs after `prepare`: builds the follower and the folder source the host loads from its own folder. */
  prepareRuntime?: { command: string; args: string[] }[]
}

/**
 * How each shape starts: the same Studio host (`apps/vinaya-studio/src/server`), which reads `HOSTNAME` and `PORT` from
 * its environment, never the app's `dev` script (it fixes host and port and would never let the fallback port apply),
 * and its launch context from standard input (`--context-stdin`). Both shapes run the host bundled for Node: the
 * installed package from its shipped folder, a checkout from a bundle made just before it starts, in development mode.
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
      command: 'node',
      args: [CHECKOUT_HOST_RELPATH, '--dir', target.appDir, '--dev', '--context-stdin'],
      cwd: target.appDir,
      env,
      prepare: {
        command: 'bun',
        args: studioBuildArgs(join('src', 'server', 'entry.ts'), CHECKOUT_HOST_RELPATH, ['next', 'ws'])
      },
      prepareRuntime: STUDIO_LOG_RUNTIME_FILES.map(({ entry, out }) => ({
        command: 'bun',
        args: studioBuildArgs(
          join(target.appDir, '..', '..', ...entry.split('/')),
          join(dirname(CHECKOUT_HOST_RELPATH), out)
        )
      }))
    }
  }
  return {
    command: 'node',
    args: [join(target.serverDir, STUDIO_ENTRY_FILENAME), '--dir', target.serverDir, '--context-stdin'],
    cwd,
    env
  }
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
  /** A test seam for the launch secret. */
  secret?: string
  /** A test seam for the repository resolution. */
  repositories?: (cwd: string, paths: string[]) => { repositories: LaunchRepository[] } | { error: string }
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
  const repoFlags = parseRepoFlags(args)
  if ('error' in repoFlags) {
    error(repoFlags.error)
    return { exitCode: 2 }
  }
  const selected = (deps.repositories ?? resolveLaunchRepositories)(cwd, repoFlags.paths)
  if ('error' in selected) {
    error(selected.error)
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

  const plan = planLaunch(target, cwd, port, deps.env ?? process.env)
  for (const step of [...(plan.prepare ? [plan.prepare] : []), ...(plan.prepareRuntime ?? [])]) {
    const prepared = spawnSync(step.command, step.args, {
      cwd: plan.cwd,
      env: plan.env,
      stdio: 'inherit'
    })
    if (prepared.status !== 0) {
      error('Studio could not be bundled for this checkout.')
      return { exitCode: 1 }
    }
  }
  const secret = deps.secret ?? createLaunchSecret()
  const child = spawn(plan.command, plan.args, { cwd: plan.cwd, env: plan.env, stdio: ['pipe', 'inherit', 'inherit'] })
  // The launch context travels over the child's standard input only: not an argument, an environment variable or a URL.
  child.stdin?.on('error', () => {})
  child.stdin?.end(JSON.stringify({ secret, repositories: selected.repositories }))
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
  const link = bootstrapUrl(url, secret)
  let opened = false
  try {
    opened = await (deps.openBrowser ?? openInBrowser)(link)
  } catch {
    opened = false
  }
  // A browser that cannot be opened never fails the launch; the address is printed once instead.
  if (!opened) log(`Studio is running. Open ${link} in your browser. The link works once.`)
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
