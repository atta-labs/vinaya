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
import {
  type BridgeInvocation,
  claudeDevToolName,
  claudeDevToolsArgs,
  codexDevToolsConfigToml,
  devToolsMcpConfigFileBody
} from './dev-tools-registration.js'

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

/**
 * The one-shot instruction the proof session runs — call the tool, echo the
 * stamped `output` back verbatim. The tool's model-facing name differs by
 * vendor, so the prompt does too:
 *
 *  - Claude exposes an MCP tool as `mcp__<server>__<tool>` and the proven
 *    macOS PASS used that literal name (ruling 1040-2/round-1) — keep it.
 *  - Codex namespaces the SAME tool as `<server>__<tool>` (no `mcp__`
 *    prefix). Round-2 bug: naming the Claude form made the Codex model unable
 *    to find any such tool, so it answered the prompt directly and the
 *    driver-run server received no call (exit 0, echoed text null, TOOL CALL
 *    null). Describe the tool by its server and bare name instead, so the
 *    model calls whatever namespaced handle Codex actually assigned it.
 */
function proofPrompt(agent: ProofAgent): string {
  if (agent === 'claude') {
    return (
      `Call the \`mcp__${DEV_TOOLS_MCP_SERVER_NAME}__${PROOF_TOOL}\` tool now with no arguments. ` +
      'When it returns, reply with EXACTLY the value of the `output` field it returned, and nothing else — no quotes, no commentary.'
    )
  }
  return (
    `You have exactly one MCP tool available, named \`${PROOF_TOOL}\`, provided by the MCP server \`${DEV_TOOLS_MCP_SERVER_NAME}\`. ` +
    'Call that tool now with no arguments (an empty JSON object). ' +
    'When it returns, reply with EXACTLY the value of the `output` field it returned, and nothing else — no quotes, no commentary.'
  )
}

/**
 * Codex's own `--json` events, reduced to what the proof must SHOW so a macOS
 * run reveals whether the bridge started, whether the tool was listed, and
 * whether a call was attempted or refused (ruling round-2): every
 * `mcp_tool_call` item, any error event (an MCP server that failed to start
 * surfaces here), and the final agent message.
 */
type CodexDiagnostics = {
  mcpToolCalls: Record<string, unknown>[]
  errorEvents: Record<string, unknown>[]
  finalMessage: string | null
}

/** The parsed shape the agent's stream-json run yields, reduced to what the proof reports. */
type AgentOutcome = {
  exitCode: number | null
  isError: boolean | null
  permissionDenials: unknown[]
  resultText: string | null
  /** Codex-only event detail (null for Claude, whose `result` event carries everything the proof needs). */
  codex: CodexDiagnostics | null
}

/** Reads Claude's newline-delimited stream-json, pulling the terminal `result` event's fields. */
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

/**
 * Reads Codex's `--json` stream (one event per line — `thread.started`,
 * `turn.started`, `item.completed`, `turn.completed`; confirmed-live schema in
 * `dispatch.ts`). Codex emits NO Claude-style terminal `result` event, which
 * is why the old Claude parser reported `resultText: null` even on a clean
 * exit-0 Codex run (ruling round-2). The final agent message is the last
 * `agent_message` item's text — that is the value the proof's stamp check
 * reads. `mcp_tool_call` items and error events are collected for display.
 */
export function parseCodexProofStream(
  stdout: string
): Pick<AgentOutcome, 'isError' | 'permissionDenials' | 'resultText'> & { codex: CodexDiagnostics } {
  const mcpToolCalls: Record<string, unknown>[] = []
  const errorEvents: Record<string, unknown>[] = []
  let finalMessage: string | null = null
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    const type = typeof event.type === 'string' ? event.type : ''
    // A top-level error event — a `[mcp_servers.*]` entry that failed to
    // start (bad command, socket refused) is reported here, the single
    // clearest signal of whether the bridge came up.
    if (type === 'error' || type.endsWith('.error')) {
      errorEvents.push(event)
      continue
    }
    const item = (event.item ?? null) as Record<string, unknown> | null
    const itemType = item && typeof item.type === 'string' ? item.type : ''
    if (itemType === 'mcp_tool_call') mcpToolCalls.push(item as Record<string, unknown>)
    else if (itemType === 'error') errorEvents.push(item as Record<string, unknown>)
    else if (itemType === 'agent_message' && typeof item?.text === 'string') finalMessage = item.text
  }
  return {
    // No vendor `is_error` flag exists in Codex's stream; an error event is
    // the honest signal that the turn did not complete cleanly.
    isError: errorEvents.length > 0 ? true : null,
    permissionDenials: [],
    resultText: finalMessage,
    codex: { mcpToolCalls, errorEvents, finalMessage }
  }
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
  const allowed = claudeDevToolName(PROOF_TOOL)
  if (agent === 'claude') {
    // The SAME per-dispatch registration the real dispatch uses
    // (`dev-tools-registration.ts`): a driver-written `--mcp-config` file with
    // `--strict-mcp-config`, so the worktree's committed `.mcp.json` is never
    // loaded. The proof allows only the one read-only tool.
    const mcpConfigPath = join(scratchDir, 'dev-tools.mcp.json')
    writeFileSync(mcpConfigPath, devToolsMcpConfigFileBody(bridge))
    const args = [
      '-p',
      '--verbose',
      '--output-format',
      'stream-json',
      ...claudeDevToolsArgs(mcpConfigPath, [allowed]),
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
  // The SAME registration the real dispatch stages (`dev-tools-registration.ts`):
  // the sandbox config followed by the `[mcp_servers.<name>]` table, in the one
  // staged `config.toml` that a confined Codex reads from its `CODEX_HOME`.
  const combinedToml = codexDevToolsConfigToml(bridge, confinement.codexSandboxToml)
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
  // The SAME argv a real Developer dispatch uses (`dispatch.ts` VENDOR_TABLE):
  // `--json` so the proof can read Codex's own events (ruling round-2), the
  // prompt read from stdin (`-`), and `--strict-config`/`--skip-git-repo-check`/
  // `--dangerously-bypass-hook-trust` so the proof runs exactly the production
  // path rather than a reduced one. `--sandbox workspace-write` matches the
  // real fresh-exec argv; on macOS the sandbox itself still comes from the
  // staged `config.toml` `sandbox_mode`.
  return {
    command: 'codex',
    args: [
      'exec',
      '--sandbox',
      'workspace-write',
      '--strict-config',
      '--dangerously-bypass-hook-trust',
      '--skip-git-repo-check',
      '--json',
      '-'
    ],
    env: buildWorkerEnv(process.env, { CODEX_HOME: codexHome, ...confinedTmpEnv(confinement.confined, scratchDir) })
  }
}

/** Runs the agent child, returning its outcome + raw stderr (or an ENOENT-style spawn failure the caller discloses). */
function runAgent(
  agent: ProofAgent,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin: string | null,
  cwd: string
): Promise<{ outcome: AgentOutcome; stderr: string } | { spawnError: string }> {
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
      const parsed = agent === 'codex' ? parseCodexProofStream(stdout) : { ...parseAgentStream(stdout), codex: null }
      resolve({ outcome: { exitCode, ...parsed }, stderr })
    })
    // Always close stdin — a child reading its prompt from argv would still
    // wait on EOF and hang to the timeout otherwise (ruling bug 1). Both
    // agents now read the prompt from stdin (`claude -p`, `codex exec … -`).
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
  // Both agents now read the one-shot prompt from stdin — `claude -p` and
  // `codex exec … -` alike (ruling round-2: Codex no longer takes it as argv).
  const stdin = proofPrompt(agent)

  process.stdout.write(`\n=== O1 dev-tools proof — agent: ${agent} ===\n`)
  process.stdout.write(`driver pid (hosts the server): ${process.pid}\n`)
  process.stdout.write(`sandbox: ${confinement.confined ? 'ON' : 'OFF (disclosed)'} — ${confinement.detail}\n`)
  process.stdout.write(`server: ${DEV_TOOLS_MCP_SERVER_NAME} on unix socket ${socketPath}\n`)
  process.stdout.write(
    `registration: ${agent === 'claude' ? '--strict-mcp-config --mcp-config <file>' : 'staged config.toml [mcp_servers]'} → bridge ${JSON.stringify(bridge)}\n`
  )

  const ran = await runAgent(agent, launch.command, launch.args, launch.env, stdin, cwd)
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
    // Codex emits no Claude-style `result` event — print its own events so a
    // macOS run SHOWS whether the bridge started, whether the tool was listed
    // and whether a call was attempted or refused (ruling round-2).
    if (agent === 'codex' && ran.outcome.codex) {
      const { mcpToolCalls, errorEvents, finalMessage } = ran.outcome.codex
      process.stdout.write("\nCODEX OWN EVENTS (what the agent's own --json stream reported):\n")
      process.stdout.write(`  mcp_tool_call items (${mcpToolCalls.length}):\n`)
      if (mcpToolCalls.length === 0) {
        process.stdout.write('    (none — the agent made no MCP tool call)\n')
      } else {
        for (const item of mcpToolCalls) process.stdout.write(`    ${JSON.stringify(item)}\n`)
      }
      process.stdout.write(`  error events (${errorEvents.length}):\n`)
      if (errorEvents.length === 0) {
        process.stdout.write('    (none — no MCP server startup error reported on the event stream)\n')
      } else {
        for (const err of errorEvents) process.stdout.write(`    ${JSON.stringify(err)}\n`)
      }
      process.stdout.write(`  final agent message: ${JSON.stringify(finalMessage)}\n`)
      const stderrTail = ran.stderr.trim()
      if (stderrTail.length > 0) {
        process.stdout.write('  stderr tail (MCP startup errors often land here, not on the event stream):\n')
        for (const l of stderrTail.split('\n').slice(-8)) process.stdout.write(`    ${l}\n`)
      }
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
