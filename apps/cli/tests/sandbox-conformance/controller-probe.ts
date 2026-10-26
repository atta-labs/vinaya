/**
 * The attack a controller-boundary probe runs inside a role's sandbox: a raw
 * connection to a role's tool socket — no bridge, no MCP client — that sends
 * `initialize` and one `tools/call`, carrying the capability given (or none),
 * and prints one verdict line:
 *
 *   CONTROLLER-PROBE {"reached":true,"succeeded":false,"check":"dispatch-capability"}
 *
 * `reached` is whether the socket answered at all (the sandbox may deny the
 * connection); `succeeded` is whether the call came back as a success; `check`
 * names the refusal when it did not. It imports nothing from the repository,
 * so it runs wherever the role can run `bun`.
 *
 * Usage: bun controller-probe.ts <socket> <tool> <arguments-json> [capability]
 */

import net from 'node:net'

const [socketPath, tool, argumentsJson, capability] = process.argv.slice(2)
const CAPABILITY_ARGUMENT = '__vinayaDispatchCapability'

function report(verdict: { reached: boolean; succeeded: boolean; check: string | null }): never {
  process.stdout.write(`CONTROLLER-PROBE ${JSON.stringify(verdict)}\n`)
  process.exit(verdict.succeeded ? 0 : 3)
}

if (!socketPath || !tool || !argumentsJson) {
  process.stderr.write('usage: controller-probe <socket> <tool> <arguments-json> [capability]\n')
  process.exit(2)
}

const args = JSON.parse(argumentsJson) as Record<string, unknown>
const socket = net.connect(socketPath)
let reached = false
let buffer = ''
setTimeout(() => report({ reached, succeeded: false, check: 'no-answer' }), 15_000)
socket.setEncoding('utf8')
socket.on('error', () => report({ reached, succeeded: false, check: null }))
socket.on('close', () => report({ reached, succeeded: false, check: 'closed' }))
socket.on('connect', () => {
  const call = { ...args, ...(capability ? { [CAPABILITY_ARGUMENT]: capability } : {}) }
  socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n`)
  socket.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: call } })}\n`
  )
})
socket.on('data', (chunk: string) => {
  reached = true
  buffer += chunk
  for (const line of buffer.split('\n')) {
    let message: { id?: number; result?: { isError?: boolean; structuredContent?: { error?: { check?: string } } } }
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (message.id !== 2 || !message.result) continue
    const served = message.result.isError === false
    report({
      reached,
      succeeded: served,
      check: served ? null : (message.result.structuredContent?.error?.check ?? null)
    })
  }
})
