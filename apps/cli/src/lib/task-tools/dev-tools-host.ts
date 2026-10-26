/**
 * Hosts the dev-tools MCP server (`dev-tools-server.ts`) on a unix-domain
 * socket, IN THE DRIVER PROCESS, outside any agent sandbox (O1). The driver
 * calls `startDevToolsHost` before it dispatches a Developer turn, writes the
 * socket path into the agent's per-dispatch MCP registration (a bridge command,
 * `dev-tools-bridge.ts`), and `close()`s the host when the turn returns.
 *
 * Every tool handler therefore runs here — in the trusted controller, holding
 * the forge login and running the real gates — never in the sandboxed child.
 * The child only ever reaches a bridge that relays bytes to this socket.
 *
 * The socket lives inside an owner-only private directory the driver creates
 * (mode 0700) with the socket itself mode 0600, so no other local user can
 * reach it, while the driver's own confined bridge still can; a unix socket
 * connect is a filesystem operation on that path, not a network egress the
 * domain allowlist gates.
 */

import net from 'node:net'
import { chmodSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { platform } from 'node:os'
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { devToolsSocketRoot } from './dev-tools-registration.js'
import { createDevToolsMcpServer, type DevToolContext, type DispatchCapability } from './dev-tools-server.js'
import type { GrantedRole } from './role-grants.js'

export type DevToolsHost = {
  /** The unix-socket path the bridge connects to — write this into the per-dispatch MCP registration. */
  socketPath: string
  /** Stops accepting connections, ends live ones, and removes the socket file. Idempotent; a close fault never throws. */
  close: () => Promise<void>
}

export type StartDevToolsHostOptions = {
  socketPath: string
  serverVersion: string
  context: DevToolContext
  /** The dispatched role; the host serves only the tools `role-grants.ts` grants it. */
  role: GrantedRole
  capability?: DispatchCapability
  /** The dispatch controller process; only its descendants may bind this role host. */
  controllerPid?: number
}

async function unixPeerPid(socket: net.Socket): Promise<number | null> {
  const fd = (socket as unknown as { _handle?: { fd?: number } })._handle?.fd
  if (typeof fd !== 'number') return null
  try {
    const { dlopen, FFIType, ptr } = await import('bun:ffi')
    const library = dlopen(platform() === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
      getsockopt: {
        args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32
      }
    })
    const credential = new Uint8Array(platform() === 'darwin' ? 4 : 12)
    const length = new Uint32Array([credential.byteLength])
    const status = library.symbols.getsockopt(
      fd,
      platform() === 'darwin' ? 0 : 1,
      platform() === 'darwin' ? 2 : 17,
      ptr(credential),
      ptr(length)
    )
    library.close()
    return status === 0 ? new DataView(credential.buffer).getInt32(0, true) : null
  } catch {
    return null
  }
}

function parentPid(pid: number): number | null {
  try {
    if (platform() === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const afterName = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const value = Number(afterName[1])
      return Number.isInteger(value) && value > 0 ? value : null
    }
    const result = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' })
    const value = Number(result.stdout.trim())
    return result.status === 0 && Number.isInteger(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function descendsFrom(pid: number, ancestor: number): boolean {
  const seen = new Set<number>()
  for (let current: number | null = pid; current !== null && !seen.has(current); current = parentPid(current)) {
    if (current === ancestor) return true
    seen.add(current)
  }
  return false
}

/**
 * Starts listening on `socketPath`. Each accepted connection gets its own
 * `serve` loop over the SAME context (the driver's own), so a bridge that
 * reconnects (the agent restarting its MCP client) is handled without rebuilding
 * the host. A stale socket file from a crashed prior run is removed first.
 */
export async function startDevToolsHost(opts: StartDevToolsHostOptions): Promise<DevToolsHost> {
  // Create the socket's parent directory owner-only (mode 0700) so no other
  // local user can traverse into it and reach the socket — the socket itself is
  // then chmod'd 0600 below. `mode` is subject to the process umask, so chmod
  // after to pin 0700 regardless of umask; recursive is a no-op when it exists
  // (a reused per-task directory across rounds), and we re-pin its mode then.
  const socketDir = dirname(opts.socketPath)
  mkdirSync(socketDir, { recursive: true, mode: 0o700 })
  chmodSync(socketDir, 0o700)
  if (dirname(socketDir) === devToolsSocketRoot()) chmodSync(devToolsSocketRoot(), 0o700)
  try {
    rmSync(opts.socketPath, { force: true })
  } catch {
    // A missing or unremovable stale socket is handled by listen() itself below.
  }

  const connections = new Set<net.Socket>()
  const netServer = net.createServer(async (socket) => {
    const peerPid = await unixPeerPid(socket)
    if (opts.capability && (peerPid === null || !descendsFrom(peerPid, opts.controllerPid ?? process.pid))) {
      opts.capability.audit?.({ role: opts.role, tool: '<connection>', reason: 'missing' })
      socket.destroy()
      return
    }
    const server = createDevToolsMcpServer({
      serverVersion: opts.serverVersion,
      context: opts.context,
      role: opts.role,
      capability: opts.capability,
      trustedCapability: opts.capability?.value
    })
    connections.add(socket)
    socket.on('close', () => connections.delete(socket))
    // A per-connection error (the bridge dying mid-call) must never crash the
    // driver — log to stderr and drop the connection.
    socket.on('error', (err) => {
      process.stderr.write(`vinaya-dev-tools host: connection error — ${err.message}\n`)
    })
    void server.serve(socket, socket).catch((err) => {
      process.stderr.write(
        `vinaya-dev-tools host: serve ended with an error — ${err instanceof Error ? err.message : String(err)}\n`
      )
    })
  })

  await new Promise<void>((resolve, reject) => {
    netServer.once('error', reject)
    netServer.listen(opts.socketPath, () => {
      netServer.removeListener('error', reject)
      // Make the socket owner-only (mode 0600) so only the driver's own user can
      // connect — belt-and-braces with the 0700 parent directory above.
      try {
        chmodSync(opts.socketPath, 0o600)
      } catch {
        // A platform that cannot chmod a socket (or a vanished path) still has
        // the 0700 parent directory as the access boundary.
      }
      resolve()
    })
  })

  let closed = false
  const close = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (closed) return resolve()
      closed = true
      if (opts.capability) opts.capability.revoked = true
      for (const socket of connections) socket.destroy()
      connections.clear()
      netServer.close(() => {
        try {
          rmSync(opts.socketPath, { force: true })
        } catch {
          // Best-effort cleanup — the scratch directory is removed with the turn anyway.
        }
        resolve()
      })
    })

  return { socketPath: opts.socketPath, close }
}
