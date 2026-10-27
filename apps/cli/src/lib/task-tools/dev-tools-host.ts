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
 *
 * The owner-only mode keeps other users out, not other processes of the same
 * user. Where several dispatches share one user (the Engine runs every role's
 * host at once), the host is started with a `DispatchCapabilityTable`, and a
 * call is served only with a live capability of one of this role's dispatches,
 * presented from inside that dispatch's own process tree.
 */

import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { platform } from 'node:os'
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { devToolsSocketRoot } from './dev-tools-registration.js'
import {
  type CapabilityRefusalEvent,
  type CapabilityRefusalReason,
  createDevToolsMcpServer,
  type DevToolContext
} from './dev-tools-server.js'
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
  /**
   * The capabilities minted for this role's dispatches. With a table, every
   * call must carry a live capability of a dispatch whose launched process is
   * an ancestor of the connecting peer; without one, the host serves its single
   * caller as the standalone dispatch always has.
   */
  capabilities?: DispatchCapabilityTable
  /** Writes the one audit record of each refused call. */
  audit?: (event: CapabilityRefusalEvent) => void
}

/**
 * The capabilities of one role host: one per role dispatch, minted before the
 * dispatch launches, bound to the process it launched, and revoked when that
 * process ends (or when its time runs out).
 *
 * The value travels in the dispatch's bridge invocation and every call carries
 * it, but the value alone is not enough: a call is served only when the
 * connection's kernel-reported peer process descends from the process the
 * dispatch launched. A process of another dispatch, or any other same-user
 * process, that learns the value is refused as `replayed`.
 */
export type DispatchCapabilityTable = {
  /** Mints the capability of one dispatch that may run for `ttlMs`; it serves nothing until `bind`. */
  mint: (ttlMs: number) => string
  /** Binds a minted capability to the process its dispatch launched. */
  bind: (value: string, launchPid: number) => void
  /** Revokes one dispatch's capability: its process ended. */
  revoke: (value: string) => void
  /** Revokes every capability: the host is closing. */
  revokeAll: () => void
  /** Checks a call's capability for a connection whose peer is `peerPid` (null when it could not be read). */
  verify: (
    supplied: string | undefined,
    peerPid: number | null
  ) => { reason: CapabilityRefusalReason; detail: string } | null
}

export function createDispatchCapabilityTable(
  deps: { now?: () => number; descendsFrom?: (pid: number, ancestor: number) => boolean } = {}
): DispatchCapabilityTable {
  const now = deps.now ?? Date.now
  const descends = deps.descendsFrom ?? descendsFrom
  const entries = new Map<string, { expiresAt: number; launchPid: number | null; revoked: boolean }>()
  return {
    mint: (ttlMs) => {
      const value = randomUUID()
      entries.set(value, { expiresAt: now() + ttlMs, launchPid: null, revoked: false })
      return value
    },
    bind: (value, launchPid) => {
      const entry = entries.get(value)
      if (entry && !entry.revoked && entry.launchPid === null) entry.launchPid = launchPid
    },
    revoke: (value) => {
      const entry = entries.get(value)
      if (entry) entry.revoked = true
    },
    revokeAll: () => {
      for (const entry of entries.values()) entry.revoked = true
    },
    verify: (supplied, peerPid) => {
      if (supplied === undefined) return { reason: 'missing', detail: 'the call carried no capability' }
      const entry = entries.get(supplied)
      if (entry === undefined) {
        return { reason: 'replayed', detail: "the capability was not minted for this role's dispatches" }
      }
      if (entry.revoked) return { reason: 'revoked', detail: 'the dispatch the capability was minted for has ended' }
      if (now() >= entry.expiresAt) return { reason: 'expired', detail: "the capability's dispatch ran out of time" }
      if (entry.launchPid === null) {
        return { reason: 'replayed', detail: 'the capability is not bound to a launched dispatch yet' }
      }
      if (peerPid === null) {
        return { reason: 'replayed', detail: "the connection's peer process could not be read" }
      }
      if (!descends(peerPid, entry.launchPid)) {
        return {
          reason: 'replayed',
          detail: `peer process ${peerPid} is outside the dispatch launched as process ${entry.launchPid}`
        }
      }
      return null
    }
  }
}

type GetSockOpt = (fd: number, level: number, name: number, value: unknown, length: unknown) => number
let peerCredentialReader: Promise<{ getsockopt: GetSockOpt; ptr: (view: ArrayBufferView) => unknown } | null> | null =
  null

/** `getsockopt` from the C library, loaded once; null where it cannot be loaded. */
function loadPeerCredentialReader(): Promise<{
  getsockopt: GetSockOpt
  ptr: (view: ArrayBufferView) => unknown
} | null> {
  peerCredentialReader ??= (async () => {
    try {
      const { dlopen, FFIType, ptr } = await import('bun:ffi')
      const library = dlopen(platform() === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
        getsockopt: {
          args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
          returns: FFIType.i32
        }
      })
      return {
        getsockopt: library.symbols.getsockopt as unknown as GetSockOpt,
        ptr: ptr as (v: ArrayBufferView) => unknown
      }
    } catch {
      return null
    }
  })()
  return peerCredentialReader
}

/**
 * The process id the kernel reports for a unix-socket peer: `SO_PEERCRED` on
 * Linux, `LOCAL_PEERPID` on macOS. Neither Node nor Bun exposes it, so it is
 * read through `bun:ffi` from the C library on the socket's file descriptor,
 * which Bun keeps on the socket's private `_handle`. Every failure (a C library
 * that is not `libc.so.6`, as on musl; a Bun whose socket has no `_handle.fd`)
 * yields null, and a host with a capability table refuses a null peer, so the
 * reader fails closed. The id is read when the connection is accepted; a peer
 * that exits and whose id is reused before a call is a residual race the
 * dispatch's own process lifetime bounds, since its capability is revoked when
 * its launched process ends.
 */
async function unixPeerPid(socket: net.Socket): Promise<number | null> {
  const fd = (socket as unknown as { _handle?: { fd?: number } })._handle?.fd
  if (typeof fd !== 'number') return null
  const reader = await loadPeerCredentialReader()
  if (reader === null) return null
  try {
    const credential = new Uint8Array(platform() === 'darwin' ? 4 : 12)
    const length = new Uint32Array([credential.byteLength])
    const status = reader.getsockopt(
      fd,
      platform() === 'darwin' ? 0 : 1,
      platform() === 'darwin' ? 2 : 17,
      reader.ptr(credential),
      reader.ptr(length)
    )
    if (status !== 0) return null
    const pid = new DataView(credential.buffer).getInt32(0, true)
    return pid > 0 ? pid : null
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
    connections.add(socket)
    socket.on('close', () => connections.delete(socket))
    // A per-connection error (the bridge dying mid-call) must never crash the
    // driver — log to stderr and drop the connection.
    socket.on('error', (err) => {
      process.stderr.write(`vinaya-dev-tools host: connection error — ${err.message}\n`)
    })
    const { capabilities } = opts
    // The peer is read once, as the connection is accepted, and every call on it is checked against it.
    const peerPid = capabilities ? await unixPeerPid(socket) : null
    const server = createDevToolsMcpServer({
      serverVersion: opts.serverVersion,
      context: opts.context,
      role: opts.role,
      ...(capabilities
        ? {
            capability: {
              verify: (supplied: string | undefined) => capabilities.verify(supplied, peerPid),
              audit: opts.audit ?? (() => {})
            }
          }
        : {})
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
      opts.capabilities?.revokeAll()
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

/**
 * A role host that outlives its socket file: something outside the driver (a temp-directory sweep) may delete the
 * socket while the listening server keeps its unlinked inode, so no later bridge can connect. The host is replaced
 * only at a dispatch boundary, never during a turn, on the same socket path.
 */
export type ReplaceableDevToolsHost = {
  socketPath: string
  /** Closes the current host. */
  close: () => Promise<void>
  /**
   * At a dispatch boundary, before the next dispatch's capability is minted: when the socket file is missing, closes
   * this host, awaits its closure (which unlinks the path, so it must finish before the replacement listens), and
   * starts the replacement on the same path. Returns whether it replaced the host.
   */
  replaceIfSocketMissing: () => Promise<boolean>
  /**
   * Records a missing socket when the dispatch ends. The runtime keeps successful turns and pauses failed
   * ones without replay; pathname absence alone does not prove a completed turn lost its connection.
   */
  noteDispatchEnded: (capability: string) => boolean
  /** How many of this role's dispatches in a row lost their tools. */
  consecutiveLosses: () => number
  /** A completed turn remains valid even when its open socket was unlinked. */
  noteDispatchSucceeded?: () => void
}

type ClosableHost = Pick<DevToolsHost, 'close'>

export async function startReplaceableDevToolsHost(
  opts: StartDevToolsHostOptions,
  deps: {
    start?: (options: StartDevToolsHostOptions) => Promise<ClosableHost>
    socketExists?: (path: string) => boolean
  } = {}
): Promise<ReplaceableDevToolsHost> {
  const start = deps.start ?? startDevToolsHost
  const socketExists = deps.socketExists ?? existsSync
  const options = opts
  let current = await start(options)
  // Whether the started host made its socket file; one that never listens on a file has none to lose.
  let listening = socketExists(opts.socketPath)
  let losses = 0
  return {
    socketPath: opts.socketPath,
    close: () => current.close(),
    replaceIfSocketMissing: async () => {
      if (!listening || socketExists(opts.socketPath)) return false
      await current.close()
      current = await start(options)
      listening = socketExists(opts.socketPath)
      return true
    },
    noteDispatchEnded: (_capability) => {
      const lost = listening && !socketExists(opts.socketPath)
      losses = lost ? losses + 1 : 0
      return lost
    },
    noteDispatchSucceeded: () => {
      losses = 0
    },
    consecutiveLosses: () => losses
  }
}
