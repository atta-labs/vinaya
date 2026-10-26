/**
 * The stdio↔unix-socket bridge (O1) — the ONLY part of the dev-tools route that
 * runs inside the agent's sandbox. The per-dispatch MCP registration names this
 * as the server `command`; the agent's MCP client spawns it and speaks
 * newline-delimited JSON-RPC to its stdin/stdout, and the bridge relays those
 * bytes, unchanged, to the driver's dev-tools host
 * (`dev-tools-host.ts`) over the unix socket the driver opened in the
 * dispatch's scratch directory.
 *
 * It holds no credential, no gate and no catalog, so that even though it runs
 * confined, the tools it fronts run entirely in the driver process. Its one
 * edit to the bytes: given `--capability <value>` (the per-dispatch capability
 * the controller minted into this dispatch's bridge invocation), it adds that
 * value to the arguments of every `tools/call` it relays, and the host checks
 * it before anything else. If it cannot reach the socket (the driver closed the
 * host, or the path is wrong) it exits non-zero with a one-line diagnostic,
 * which the agent's MCP client reports as the server failing to start.
 */

import net from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import { DISPATCH_CAPABILITY_ARGUMENT } from './dev-tools-names.js'

/** Parses `--socket <path>` and the optional `--capability <value>` out of the bridge's own argv. */
export function parseBridgeArgs(
  args: readonly string[]
): { socketPath: string; capability?: string } | { error: string } {
  const idx = args.indexOf('--socket')
  if (idx === -1 || idx === args.length - 1) {
    return { error: 'vinaya dev-tools bridge: missing required --socket <path>' }
  }
  const socketPath = args[idx + 1]
  if (!socketPath || socketPath.length === 0) {
    return { error: 'vinaya dev-tools bridge: --socket requires a non-empty path' }
  }
  const capabilityIdx = args.indexOf('--capability')
  if (capabilityIdx === -1) return { socketPath }
  const capability = args[capabilityIdx + 1]
  if (!capability || capability.length === 0) {
    return { error: 'vinaya dev-tools bridge: --capability requires a non-empty value' }
  }
  return { socketPath, capability }
}

/**
 * One newline-delimited JSON-RPC message with `capability` added to the
 * arguments of a `tools/call`; every other line is returned unchanged.
 */
export function withDispatchCapability(line: string, capability: string): string {
  let message: unknown
  try {
    message = JSON.parse(line)
  } catch {
    return line
  }
  if (typeof message !== 'object' || message === null) return line
  const m = message as { method?: unknown; params?: unknown }
  if (m.method !== 'tools/call' || typeof m.params !== 'object' || m.params === null) return line
  const params = m.params as { arguments?: unknown }
  const args = typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}
  return JSON.stringify({
    ...m,
    params: { ...params, arguments: { ...args, [DISPATCH_CAPABILITY_ARGUMENT]: capability } }
  })
}

/** Relays this process's stdin/stdout to the socket at `socketPath`. Resolves when either side closes. */
export function runDevToolsBridge(socketPath: string, capability?: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const socket = net.connect(socketPath)
    socket.on('error', (err) => {
      process.stderr.write(`vinaya dev-tools bridge: cannot reach the driver socket — ${err.message}\n`)
      process.exitCode = 1
      resolve()
    })
    socket.on('connect', () => {
      if (capability === undefined) process.stdin.pipe(socket)
      else {
        const decoder = new StringDecoder('utf8')
        // Whatever has arrived since the last complete line: a chunk can split one.
        let carry = ''
        process.stdin.on('data', (chunk: Buffer | string) => {
          carry += typeof chunk === 'string' ? chunk : decoder.write(chunk)
          const lines = carry.split('\n')
          carry = lines.pop() ?? ''
          for (const line of lines) socket.write(`${withDispatchCapability(line, capability)}\n`)
        })
        process.stdin.on('end', () => {
          if (carry.length > 0) socket.write(withDispatchCapability(carry, capability))
          socket.end()
        })
      }
      socket.pipe(process.stdout)
    })
    const done = (): void => resolve()
    socket.on('close', done)
    // With a capability, stdin is read only once connected, and its own end handler flushes the last line first.
    if (capability === undefined) process.stdin.on('end', () => socket.end())
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
  await runDevToolsBridge(parsed.socketPath, parsed.capability)
}
