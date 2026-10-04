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
 * The socket path lives inside the dispatch's own scratch directory (writable
 * from inside both agents' sandboxes), so a confined bridge can connect to it;
 * a unix socket connect is a filesystem operation on that path, not a network
 * egress the domain allowlist gates.
 */

import net from 'node:net'
import { rmSync } from 'node:fs'
import { createDevToolsMcpServer, type DevToolContext } from './dev-tools-server.js'

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
}

/**
 * Starts listening on `socketPath`. Each accepted connection gets its own
 * `serve` loop over the SAME context (the driver's own), so a bridge that
 * reconnects (the agent restarting its MCP client) is handled without rebuilding
 * the host. A stale socket file from a crashed prior run is removed first.
 */
export async function startDevToolsHost(opts: StartDevToolsHostOptions): Promise<DevToolsHost> {
  try {
    rmSync(opts.socketPath, { force: true })
  } catch {
    // A missing or unremovable stale socket is handled by listen() itself below.
  }

  const server = createDevToolsMcpServer({ serverVersion: opts.serverVersion, context: opts.context })

  const connections = new Set<net.Socket>()
  const netServer = net.createServer((socket) => {
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
      resolve()
    })
  })

  let closed = false
  const close = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (closed) return resolve()
      closed = true
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
