/**
 * Tries to list and connect to a live driver-tool socket from inside Claude
 * Code's sandbox runtime, configured with the `sandbox` block the driver
 * writes for a confined Linux dispatch whose host opt-in
 * (`VINAYA_LINUX_SANDBOX_ALLOW_UNIX_SOCKETS=1`) turns the Unix-socket filter
 * off. The socket is created after the sandboxed command has started, as a
 * concurrent task's socket would be.
 *
 * Needs Linux with `bwrap` and `socat`, and fetches the pinned sandbox runtime
 * with `bun x` — test-only, the same launch the conformance suite uses.
 */

import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { devToolsSocketPath, devToolsSocketRoot } from '../../../src/lib/task-tools/dev-tools-registration.js'
import {
  CLAUDE_SANDBOX_ALLOWED_DOMAINS,
  type ClaudeSandboxSettings,
  checkLinuxSandboxTools,
  LINUX_SANDBOX_ALLOW_UNIX_SOCKETS_ENV,
  linuxUnixSocketFilterOptIn,
  resolveClaudeConfinement
} from '../../../src/lib/worker-boundary.js'
import { SANDBOX_RUNTIME_PACKAGE } from '../../sandbox-conformance/sandbox-launch.js'
import { spawnBudgetedAsync } from '../process-fixture.js'

export type DriverSocketReach = {
  /** The settings the driver resolved with the opt-in set. */
  readonly settings: ClaudeSandboxSettings
  readonly socketPath: string
  /** The sandboxed command's own output: one `LISTED:`/`LIST-DENIED:` line per directory, then `CONNECTED` or `DENIED:<code>`. */
  readonly stdout: string
  readonly stderr: string
  readonly status: number | null
  /** Connections the socket accepted from outside the sandbox (the driver's own check) before the sandboxed attempt. */
  readonly connectionsBefore: number
  /** Connections the socket accepted in total, after the sandboxed attempt. */
  readonly connectionsAfter: number
}

/** `true` when a `LISTED:` line in the output names the socket's directory or the socket itself. */
export function listingRevealsSocket(stdout: string, socketPath: string): boolean {
  const names = new Set([basename(dirname(socketPath)), basename(socketPath)])
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('LISTED:'))
    .some((line) =>
      line
        .slice(line.lastIndexOf('|') + 1)
        .split(',')
        .some((entry) => names.has(entry))
    )
}

export async function reachDriverSocketUnderOptIn(): Promise<DriverSocketReach> {
  const socketPath = devToolsSocketPath(`opt-in-victim:${randomUUID()}`)
  const socketDir = dirname(socketPath)
  const scratchDir = mkdtempSync(join(tmpdir(), 'vinaya-socket-opt-in-'))
  const server = createServer((socket) => socket.end())
  let connections = 0
  server.on('connection', () => connections++)
  try {
    const optIn = linuxUnixSocketFilterOptIn({
      env: { [LINUX_SANDBOX_ALLOW_UNIX_SOCKETS_ENV]: '1' },
      platform: 'linux',
      cwd: scratchDir,
      readFile: () => null
    })
    const resolution = resolveClaudeConfinement(
      {
        role: 'developer',
        agent: 'claude',
        worktreeDir: scratchDir,
        scratchDir,
        allowedHosts: CLAUDE_SANDBOX_ALLOWED_DOMAINS
      },
      { platform: 'linux', linuxTools: checkLinuxSandboxTools(), developerDir: null, unixSocketFilterOptIn: optIn }
    )
    if (!resolution.confined) throw new Error(`Claude's sandbox cannot run on this host: ${resolution.warning}`)
    const { settings } = resolution
    const settingsPath = join(scratchDir, 'settings.json')
    const scriptPath = join(scratchDir, 'reach.mjs')
    const readyPath = join(scratchDir, 'ready')
    const signalPath = join(scratchDir, 'signal')
    writeFileSync(
      settingsPath,
      JSON.stringify({
        network: {
          allowedDomains: settings.sandbox.network.allowedDomains,
          deniedDomains: [],
          allowAllUnixSockets: settings.sandbox.network.allowAllUnixSockets === true
        },
        filesystem: { ...settings.sandbox.filesystem, denyWrite: [] }
      })
    )
    writeFileSync(
      scriptPath,
      `import { createConnection } from 'node:net'\n` +
        `import { existsSync, readdirSync, writeFileSync } from 'node:fs'\n` +
        `writeFileSync(${JSON.stringify(readyPath)}, 'ready')\n` +
        `while (!existsSync(${JSON.stringify(signalPath)})) await new Promise((r) => setTimeout(r, 20))\n` +
        `for (const dir of ${JSON.stringify([devToolsSocketRoot(), socketDir])}) {\n` +
        `  try { console.log('LISTED:' + dir + '|' + readdirSync(dir).join(',')) }\n` +
        `  catch (e) { console.log('LIST-DENIED:' + dir + '|' + e.code) }\n` +
        '}\n' +
        `const socket = createConnection(${JSON.stringify(socketPath)})\n` +
        `socket.once('connect', () => { console.log('CONNECTED'); process.exit(1) })\n` +
        `socket.once('error', (e) => { console.log('DENIED:' + e.code); process.exit(0) })\n`
    )
    const runPromise = spawnBudgetedAsync(
      [
        process.execPath,
        'x',
        SANDBOX_RUNTIME_PACKAGE,
        '--settings',
        settingsPath,
        '-c',
        `${process.execPath} ${scriptPath}`
      ],
      { cwd: scratchDir },
      30_000,
      'Claude driver-socket reach under the Unix-socket opt-in'
    )
    const deadline = Date.now() + 15_000
    while (!existsSync(readyPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    if (!existsSync(readyPath)) {
      const run = await runPromise
      throw new Error(`the sandboxed command never started: ${run.stderr}`)
    }
    mkdirSync(socketDir, { recursive: true, mode: 0o700 })
    chmodSync(socketDir, 0o700)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    chmodSync(socketPath, 0o600)
    // The driver itself can reach its socket: the denial below is the sandbox's.
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(socketPath)
      socket.once('connect', () => {
        socket.destroy()
        resolve()
      })
      socket.once('error', reject)
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const connectionsBefore = connections
    writeFileSync(signalPath, 'go')
    const run = await runPromise
    await new Promise((resolve) => setTimeout(resolve, 50))
    return {
      settings,
      socketPath,
      stdout: run.stdout,
      stderr: run.stderr,
      status: run.status,
      connectionsBefore,
      connectionsAfter: connections
    }
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(socketDir, { recursive: true, force: true })
    rmSync(scratchDir, { recursive: true, force: true })
  }
}
