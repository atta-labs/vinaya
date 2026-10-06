/**
 * The stdio↔unix-socket bridge (O1) — the ONLY part of the dev-tools route that
 * runs inside the agent's sandbox. The per-dispatch MCP registration names this
 * as the server `command`; the agent's MCP client spawns it and speaks
 * newline-delimited JSON-RPC to its stdin/stdout, and the bridge relays those
 * bytes, unchanged, to the driver's dev-tools host
 * (`dev-tools-host.ts`) over the unix socket the driver opened in the
 * dispatch's scratch directory.
 *
 * It holds nothing — no credential, no gate, no catalog. It is a dumb pipe, so
 * that even though it runs confined, the tools it fronts run entirely in the
 * driver process. If it cannot reach the socket (the driver closed the host, or
 * the path is wrong) it exits non-zero with a one-line diagnostic, which the
 * agent's MCP client reports as the server failing to start.
 */

import net from 'node:net'

/** Parses `--socket <path>` out of the bridge's own argv. */
export function parseBridgeArgs(args: readonly string[]): { socketPath: string } | { error: string } {
  const idx = args.indexOf('--socket')
  if (idx === -1 || idx === args.length - 1) {
    return { error: 'vinaya dev-tools bridge: missing required --socket <path>' }
  }
  const socketPath = args[idx + 1]
  if (!socketPath || socketPath.length === 0) {
    return { error: 'vinaya dev-tools bridge: --socket requires a non-empty path' }
  }
  return { socketPath }
}

/** Relays this process's stdin/stdout to the socket at `socketPath`. Resolves when either side closes. */
export function runDevToolsBridge(socketPath: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const socket = net.connect(socketPath)
    socket.on('error', (err) => {
      process.stderr.write(`vinaya dev-tools bridge: cannot reach the driver socket — ${err.message}\n`)
      process.exitCode = 1
      resolve()
    })
    socket.on('connect', () => {
      process.stdin.pipe(socket)
      socket.pipe(process.stdout)
    })
    const done = (): void => resolve()
    socket.on('close', done)
    process.stdin.on('end', () => socket.end())
  })
}

/** The `vinaya task-tools dev-bridge --socket <path>` entry point. */
export async function devToolsBridgeCommand(args: string[]): Promise<void> {
  const parsed = parseBridgeArgs(args)
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n`)
    process.exitCode = 2
    return
  }
  await runDevToolsBridge(parsed.socketPath)
}
