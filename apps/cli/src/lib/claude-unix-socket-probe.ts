/** Linux preflight for the Unix-socket boundary relied on by driver-run tools. */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createConnection, createServer } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const PROBE_TIMEOUT_MS = 10_000
const DENIED_MARKER = 'VINAYA_UNIX_SOCKET_DENIED'

type ProbeResult = { ok: true } | { ok: false; reason: string }

/**
 * The raw sandbox runtime has no Claude `credentials.files` setting. Render
 * the exact written dispatch sandbox block into its equivalent runtime
 * filesystem/network config, refusing a changed or weaker shape.
 */
export function runtimeConfigFromClaudeSettings(settingsPath: string): Record<string, unknown> {
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
    sandbox?: {
      enabled?: boolean
      failIfUnavailable?: boolean
      allowUnsandboxedCommands?: boolean
      network?: { allowedDomains?: string[]; strictAllowlist?: boolean }
      filesystem?: { denyRead?: string[]; allowRead?: string[]; allowWrite?: string[] }
      credentials?: { files?: Array<{ path: string; mode: string }> }
    }
  }
  const sandbox = settings.sandbox
  if (
    sandbox?.enabled !== true ||
    sandbox.failIfUnavailable !== true ||
    sandbox.allowUnsandboxedCommands !== false ||
    sandbox.network?.strictAllowlist !== true ||
    !Array.isArray(sandbox.network.allowedDomains) ||
    !Array.isArray(sandbox.filesystem?.denyRead) ||
    !Array.isArray(sandbox.filesystem.allowRead) ||
    !Array.isArray(sandbox.filesystem.allowWrite) ||
    !Array.isArray(sandbox.credentials?.files) ||
    sandbox.credentials.files.some((file) => file.mode !== 'deny' || typeof file.path !== 'string')
  ) {
    throw new Error('the written Claude settings do not carry the required confined sandbox shape')
  }
  return {
    network: { allowedDomains: sandbox.network.allowedDomains, deniedDomains: [] },
    filesystem: {
      denyRead: [...sandbox.filesystem.denyRead, ...sandbox.credentials.files.map((file) => file.path)],
      allowRead: sandbox.filesystem.allowRead,
      allowWrite: sandbox.filesystem.allowWrite,
      denyWrite: []
    }
  }
}

function connectToLiveSocket(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    socket.setTimeout(2_000)
    socket.once('connect', () => {
      socket.destroy()
      resolve()
    })
    socket.once('error', reject)
    socket.once('timeout', () => {
      socket.destroy()
      reject(new Error('outside-sandbox socket control timed out'))
    })
  })
}

function runSandboxProbe(
  runtimeCli: string,
  configPath: string,
  scriptPath: string,
  socketPath: string
): Promise<{
  code: number | null
  output: string
  timedOut: boolean
}> {
  return new Promise((resolve) => {
    let output = ''
    let timedOut = false
    const child = spawn(process.execPath, [runtimeCli, '--settings', configPath, process.execPath, scriptPath], {
      detached: true,
      env: { ...process.env, VINAYA_UNIX_PROBE_SOCKET: socketPath },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-2_000)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }
    }, PROBE_TIMEOUT_MS)
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, output: error.message, timedOut: false })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code, output, timedOut })
    })
  })
}

/**
 * A live same-UID server proves the socket exists and is reachable outside
 * confinement. The sandboxed child must itself report EPERM/EACCES from its
 * AF_UNIX connect; ENOENT, a missing runtime, a timeout, and a successful
 * connection all refuse. This deliberately tests a shell child, not the
 * driver-owned MCP bridge (which may live outside the command sandbox).
 */
export async function probeClaudeLinuxUnixSocket(settingsPath: string, scratchDir: string): Promise<ProbeResult> {
  const probeDir = mkdtempSync(join(scratchDir, 'unix-probe-'))
  const socketPath = join(probeDir, 'live.sock')
  const configPath = join(probeDir, 'srt-settings.json')
  const scriptPath = join(probeDir, 'connect.mjs')
  const server = createServer((socket) => socket.end())
  let connections = 0
  server.on('connection', () => connections++)
  try {
    const config = runtimeConfigFromClaudeSettings(settingsPath)
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 })
    writeFileSync(
      scriptPath,
      `import { createConnection } from 'node:net'\n` +
        'const socket = createConnection(process.env.VINAYA_UNIX_PROBE_SOCKET)\n' +
        'socket.setTimeout(3000)\n' +
        `socket.once('connect', () => { console.log('VINAYA_UNIX_SOCKET_CONNECTED'); process.exit(20) })\n` +
        `socket.once('error', (error) => {\n` +
        `  if (error.code === 'EPERM' || error.code === 'EACCES') { console.log('${DENIED_MARKER}'); process.exit(0) }\n` +
        `  console.log('VINAYA_UNIX_SOCKET_ERROR:' + error.code); process.exit(21)\n` +
        '})\n' +
        `socket.once('timeout', () => process.exit(22))\n`,
      { mode: 0o600 }
    )
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    await connectToLiveSocket(socketPath)
    if (connections !== 1) throw new Error('outside-sandbox socket control did not connect')
    const runtimeIndex = createRequire(import.meta.url).resolve('@anthropic-ai/sandbox-runtime')
    const runtimeCli = join(dirname(runtimeIndex), 'cli.js')
    const result = await runSandboxProbe(runtimeCli, configPath, scriptPath, socketPath)
    if (result.code !== 0 || result.timedOut || !result.output.includes(DENIED_MARKER) || connections !== 1) {
      return {
        ok: false,
        reason: `the Linux Claude sandbox did not prove AF_UNIX denial (${result.timedOut ? 'timeout' : `exit ${result.code}`}; ${result.output.trim().slice(0, 300) || 'no denial marker'})`
      }
    }
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      reason: `the Linux Claude AF_UNIX preflight failed: ${error instanceof Error ? error.message : String(error)}`
    }
  } finally {
    server.close()
    rmSync(probeDir, { recursive: true, force: true })
  }
}
