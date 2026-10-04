/**
 * `vinaya task-tools dev-proof --agent <claude|codex>` — the O1 live proof,
 * committed as a repeatable command rather than a throwaway `/tmp` script
 * (Principal ruling 1040-2). It reproduces, end to end, the exact trust
 * boundary the whole dev-tools route rests on:
 *
 *   1. the DRIVER process (this command) starts the dev-tools MCP server
 *      (`dev-tools-server.ts`) on a unix-domain socket, OUTSIDE any agent
 *      sandbox (`dev-tools-host.ts`);
 *   2. it writes the SAME per-dispatch registration the loop uses — Claude
 *      through `--strict-mcp-config --mcp-config <file>`, Codex through a
 *      staged `config.toml` `[mcp_servers.<name>]` — each pointing the
 *      server `command` at the thin `task-tools dev-bridge --socket <path>`
 *      relay, the ONLY part that runs inside the sandbox;
 *   3. it dispatches a REAL agent session with that agent's own sandbox on
 *      where the host supports it (`resolveClaudeConfinement` /
 *      `resolveCodexConfinement`), disclosing `unconfined` with the exact
 *      reason where it does not (this VPS has no `bwrap`, so Claude runs
 *      unconfined per the Principal ruling of 2026-10-02; Codex refuses
 *      without `bwrap` and is not installed here at all);
 *   4. the agent calls `run_checks`; the handler runs in THIS process and
 *      stamps its output with this process's own pid, so the value the
 *      agent echoes back PROVES the answer came from the driver, not from a
 *      sandbox-spawned copy.
 *
 * The command prints the authoritative host-side tool call and result (what
 * the driver server received and returned) plus the agent's round-trip echo,
 * its exit status and its permission denials. The Principal runs the SAME
 * command, per agent, on macOS with both sandboxes on (§9) — a macOS failure
 * comes back as a ruling.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ownVersion } from '../artifacts.js'
import { buildCodexExecpolicyRules } from '../dispatch.js'
import {
  buildWorkerEnv,
  realConfinementPlatformDeps,
  resolveClaudeConfinement,
  resolveCodexConfinement,
  stageCodexPolicyHome
} from '../worker-boundary.js'
import { startDevToolsHost } from './dev-tools-host.js'
import { DEV_TOOLS_MCP_SERVER_NAME, type DevToolContext } from './dev-tools-server.js'

/** The one allowlisted tool the proof session may call — a read-only check, no publish, no forge write. */
const PROOF_TOOL = 'run_checks'

type ProofAgent = 'claude' | 'codex'

/** Parses `--agent <claude|codex>` out of the command's argv. */
export function parseDevProofArgs(args: readonly string[]): { agent: ProofAgent } | { error: string } {
  const idx = args.indexOf('--agent')
  if (idx === -1 || idx === args.length - 1) {
    return { error: 'vinaya task-tools dev-proof: missing required --agent <claude|codex>' }
  }
  const agent = args[idx + 1]
  if (agent !== 'claude' && agent !== 'codex') {
    return { error: `vinaya task-tools dev-proof: --agent must be 'claude' or 'codex', got ${JSON.stringify(agent)}` }
  }
  return { agent }
}

/** The per-dispatch dev-tools registration, as the agent's own config shape expects, pointing at the bridge relay. */
type BridgeInvocation = { command: string; args: string[] }

/**
 * The bridge the agent's MCP client spawns — the running vinaya entrypoint
 * (`process.execPath` + this process's own script), so the proof is
 * repo-local and runs identically whether invoked as `bun …/index.ts
 * task-tools dev-proof` or as the installed `vinaya` binary.
 */
export function devBridgeInvocation(socketPath: string): BridgeInvocation {
  const entry = process.argv[1] ?? 'vinaya'
  return { command: process.execPath, args: [entry, 'task-tools', 'dev-bridge', '--socket', socketPath] }
}

/** What the host-side handler recorded for the one tool call it answered. */
type RecordedCall = { tool: string; args: unknown; result: unknown }

/**
 * A `DevToolContext` whose `run_checks` stamps this process's pid into its
 * output and records the call, and whose every other tool refuses — the proof
 * never publishes or writes the forge, so only the read-only check is live.
 */
export function proofContext(recorded: RecordedCall[]): DevToolContext {
  const stamp = `dev-proof: answered in driver pid ${process.pid}`
  const deny = (tool: string): { ok: false; error: { check: string; output: string; fix: string } } => ({
    ok: false,
    error: {
      check: 'dev-proof-scope',
      output: `${tool} is out of scope for the O1 proof — only ${PROOF_TOOL} is allowed.`,
      fix: `Call ${PROOF_TOOL}.`
    }
  })
  return {
    publishChanges: async () => deny('publish_changes'),
    openPullRequest: async () => deny('open_pull_request'),
    updatePullRequestBody: async () => deny('update_pull_request_body'),
    refreshEvidence: async () => deny('refresh_evidence'),
    readPullRequest: async () => deny('read_pull_request'),
    runChecks: async () => {
      const result = { passed: true, output: stamp }
      recorded.push({ tool: PROOF_TOOL, args: {}, result })
      return { ok: true, result }
    }
  }
}

/** The one-shot instruction the proof session runs — call the tool, echo the stamped `output` back verbatim. */
const PROOF_PROMPT =
  `Call the \`mcp__${DEV_TOOLS_MCP_SERVER_NAME}__${PROOF_TOOL}\` tool now with no arguments. ` +
  'When it returns, reply with EXACTLY the value of the `output` field it returned, and nothing else — no quotes, no commentary.'

/** The parsed shape the agent's stream-json run yields, reduced to what the proof reports. */
type AgentOutcome = {
  exitCode: number | null
  isError: boolean | null
  permissionDenials: unknown[]
  resultText: string | null
}

/** Reads newline-delimited stream-json, pulling the terminal `result` event's fields. */
export function parseAgentStream(stdout: string): Pick<AgentOutcome, 'isError' | 'permissionDenials' | 'resultText'> {
  let isError: boolean | null = null
  let permissionDenials: unknown[] = []
  let resultText: string | null = null
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (event.type === 'result') {
      if (typeof event.is_error === 'boolean') isError = event.is_error
      if (Array.isArray(event.permission_denials)) permissionDenials = event.permission_denials
      if (typeof event.result === 'string') resultText = event.result
    }
  }
  return { isError, permissionDenials, resultText }
}

type ConfinementDisclosure = {
  confined: boolean
  detail: string
  settingsPath: string | null
  codexHome: string | null
  /** The Codex sandbox `config.toml` body (when confined), prepended before the `[mcp_servers]` table. */
  codexSandboxToml: string | null
}

/** Resolves + materializes the agent's own sandbox for this host, disclosing when it degrades to unconfined. */
function resolveProofConfinement(
  agent: ProofAgent,
  role: 'developer',
  worktreeDir: string,
  scratchDir: string
): ConfinementDisclosure {
  const request = { role, agent, worktreeDir, scratchDir, allowedHosts: [] as string[] }
  const deps = realConfinementPlatformDeps()
  if (agent === 'claude') {
    const resolved = resolveClaudeConfinement(request, deps)
    if (resolved.confined) {
      const settingsPath = join(scratchDir, 'sandbox-settings.json')
      writeFileSync(settingsPath, `${JSON.stringify(resolved.settings, null, 2)}\n`)
      return {
        confined: true,
        detail: "Claude Code's own sandbox is confining this proof session.",
        settingsPath,
        codexHome: null,
        codexSandboxToml: null
      }
    }
    return { confined: false, detail: resolved.warning, settingsPath: null, codexHome: null, codexSandboxToml: null }
  }
  const resolved = resolveCodexConfinement(request, deps)
  if (resolved.ok) {
    const codexHome = join(scratchDir, 'codex-home')
    mkdirSync(codexHome, { recursive: true })
    return {
      confined: true,
      detail: "Codex's own sandbox is confining this proof session.",
      settingsPath: null,
      codexHome,
      codexSandboxToml: resolved.configToml
    }
  }
  return { confined: false, detail: resolved.reason, settingsPath: null, codexHome: null, codexSandboxToml: null }
}

/**
 * The TMPDIR-family redirect a confined child's env carries (the SAME shape the
 * confined dispatch uses), keeping the agent's own working files inside the
 * granted scratch. Empty for an unconfined run.
 */
function confinedTmpEnv(confined: boolean, scratchDir: string): Record<string, string> {
  if (!confined) return {}
  return { TMPDIR: scratchDir, TMP: scratchDir, TEMP: scratchDir, CLAUDE_CODE_TMPDIR: scratchDir }
}

/** Builds the spawn command/args/env for the named agent, registering the dev-tools server per-dispatch. */
function buildAgentLaunch(
  agent: ProofAgent,
  bridge: BridgeInvocation,
  scratchDir: string,
  confinement: ConfinementDisclosure
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const allowed = `mcp__${DEV_TOOLS_MCP_SERVER_NAME}__${PROOF_TOOL}`
  if (agent === 'claude') {
    const mcpConfigPath = join(scratchDir, 'dev-tools.mcp.json')
    writeFileSync(
      mcpConfigPath,
      `${JSON.stringify({ mcpServers: { [DEV_TOOLS_MCP_SERVER_NAME]: { type: 'stdio', ...bridge } } }, null, 2)}\n`
    )
    const args = [
      '-p',
      '--verbose',
      '--output-format',
      'stream-json',
      '--strict-mcp-config',
      '--mcp-config',
      mcpConfigPath,
      '--allowedTools',
      allowed,
      ...(confinement.settingsPath ? ['--settings', confinement.settingsPath] : [])
    ]
    // F1 (round 2 security review, MEDIUM): never spread the driver/operator's
    // whole environment into the spawned agent — the agent's own sandbox
    // confines its tools' filesystem and network, never their env. Build the
    // child env from the SAME `buildWorkerEnv` named allowlist the confined
    // dispatch uses (`dispatch.ts`); it keeps HOME/PATH/USER/LOGNAME so
    // `claude -p` still authenticates and resolves its binary.
    return {
      command: 'claude',
      args,
      env: buildWorkerEnv(process.env, confinedTmpEnv(confinement.confined, scratchDir))
    }
  }
  // Codex: a CODEX_HOME carrying a real `auth.json` copy, the sandbox config and
  // the `[mcp_servers.<name>]` table — staged through the SAME
  // `stageCodexPolicyHome` the confined dispatch uses (ruling bug 2: a
  // hand-made home with no `auth.json` cannot authenticate). The mcp table
  // rides the staged `config.toml` so the one generated file carries both.
  const codexHome = confinement.codexHome ?? join(scratchDir, 'codex-home')
  const tomlArgs = `[${bridge.args.map((a) => JSON.stringify(a)).join(', ')}]`
  const mcpTable = [
    `[mcp_servers.${DEV_TOOLS_MCP_SERVER_NAME}]`,
    `command = ${JSON.stringify(bridge.command)}`,
    `args = ${tomlArgs}`,
    ''
  ].join('\n')
  const combinedToml = confinement.codexSandboxToml ? `${confinement.codexSandboxToml}\n${mcpTable}` : mcpTable
  const staged =
    confinement.codexSandboxToml !== null
      ? stageCodexPolicyHome({
          targetDir: codexHome,
          realHome: homedir(),
          execpolicyRules: buildCodexExecpolicyRules('developer') ?? '',
          sandboxConfigToml: combinedToml
        })
      : null
  if (staged === null) {
    // No operator `~/.codex/auth.json` to copy (this VPS; or no Codex login) —
    // write the registration alone so the command still runs and discloses.
    // Codex itself ENOENTs here anyway; the staged path is exercised on macOS.
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(join(codexHome, 'config.toml'), combinedToml)
  }
  return {
    command: 'codex',
    args: ['exec', '--skip-git-repo-check', PROOF_PROMPT],
    env: buildWorkerEnv(process.env, { CODEX_HOME: codexHome, ...confinedTmpEnv(confinement.confined, scratchDir) })
  }
}

/** Runs the agent child, returning its outcome (or an ENOENT-style spawn failure the caller discloses). */
function runAgent(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin: string | null,
  cwd: string
): Promise<{ outcome: AgentOutcome } | { spawnError: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c: string) => (stdout += c))
    child.stderr.on('data', (c: string) => (stderr += c))
    child.on('error', (err) => resolve({ spawnError: `${command}: ${err.message}` }))
    child.on('close', (exitCode) => {
      const parsed = parseAgentStream(stdout)
      if (parsed.resultText === null && stderr.trim().length > 0) {
        process.stderr.write(`dev-proof: ${command} stderr tail — ${stderr.split('\n').slice(-3).join(' / ')}\n`)
      }
      resolve({ outcome: { exitCode, ...parsed } })
    })
    // Always close stdin — a child reading its prompt from argv (Codex) still
    // waits on EOF and would hang to the timeout otherwise (ruling bug 1).
    if (stdin !== null) child.stdin.write(stdin)
    child.stdin.end()
  })
}

/** The command entry point: run the end-to-end proof for one agent and print it. */
export async function devToolsProofCommand(args: string[]): Promise<void> {
  const parsed = parseDevProofArgs(args)
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n`)
    process.exitCode = 2
    return
  }
  const { agent } = parsed
  const cwd = process.cwd()
  const scratchDir = mkdtempSync(join(tmpdir(), `vinaya-dev-proof-${agent}-`))
  const socketPath = join(scratchDir, 'dev-tools.sock')
  const recorded: RecordedCall[] = []
  const host = await startDevToolsHost({
    socketPath,
    serverVersion: ownVersion(),
    context: proofContext(recorded)
  })

  const confinement = resolveProofConfinement(agent, 'developer', cwd, scratchDir)
  const bridge = devBridgeInvocation(socketPath)
  const launch = buildAgentLaunch(agent, bridge, scratchDir, confinement)
  const stdin = agent === 'claude' ? PROOF_PROMPT : null

  process.stdout.write(`\n=== O1 dev-tools proof — agent: ${agent} ===\n`)
  process.stdout.write(`driver pid (hosts the server): ${process.pid}\n`)
  process.stdout.write(`sandbox: ${confinement.confined ? 'ON' : 'OFF (disclosed)'} — ${confinement.detail}\n`)
  process.stdout.write(`server: ${DEV_TOOLS_MCP_SERVER_NAME} on unix socket ${socketPath}\n`)
  process.stdout.write(
    `registration: ${agent === 'claude' ? '--strict-mcp-config --mcp-config <file>' : 'staged config.toml [mcp_servers]'} → bridge ${JSON.stringify(bridge)}\n`
  )

  const ran = await runAgent(launch.command, launch.args, launch.env, stdin, cwd)
  try {
    if ('spawnError' in ran) {
      process.stdout.write(`\nAGENT DISPATCH: could not spawn ${agent} on this host — ${ran.spawnError}\n`)
      process.stdout.write(
        agent === 'codex'
          ? 'This is expected on the VPS (no codex binary, no bwrap). Run this command on macOS with the sandbox on.\n'
          : 'Install/authenticate the agent CLI, or run this command on macOS.\n'
      )
      process.exitCode = 1
      return
    }
    const call = recorded[0]
    process.stdout.write('\nTOOL CALL received by the driver-run server:\n')
    process.stdout.write(`${JSON.stringify(call ? { tool: call.tool, arguments: call.args } : null)}\n`)
    process.stdout.write('RESULT returned to the agent (note the driver pid stamp):\n')
    process.stdout.write(`${JSON.stringify(call ? call.result : null)}\n`)
    process.stdout.write('\nAGENT round-trip:\n')
    process.stdout.write(`  exit code: ${ran.outcome.exitCode}\n`)
    process.stdout.write(`  is_error: ${ran.outcome.isError}\n`)
    process.stdout.write(`  permission_denials: ${JSON.stringify(ran.outcome.permissionDenials)}\n`)
    process.stdout.write(`  echoed result text: ${JSON.stringify(ran.outcome.resultText)}\n`)
    const echoedStamp =
      typeof ran.outcome.resultText === 'string' && ran.outcome.resultText.includes(`driver pid ${process.pid}`)
    const proven = call !== undefined && echoedStamp && ran.outcome.isError !== true
    process.stdout.write(
      `\nPROOF: ${proven ? 'PASS' : 'INCOMPLETE'} — ${proven ? 'the driver-run server answered a dispatched agent and the result reached it through the bridge.' : 'see the fields above.'}\n`
    )
    if (!proven) process.exitCode = 1
  } finally {
    await host.close()
    rmSync(scratchDir, { recursive: true, force: true })
  }
}
