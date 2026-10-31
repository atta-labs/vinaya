/**
 * One role step of a Harbor container trial on the Atta Engine backend: the
 * role's single agent step, written as a one-step Flow into the trial's
 * scratch directory and run through the Engine's public process-run start
 * (`startProcessRun`), its agent launched by the Engine's role launcher
 * (`createRoleLauncher`) from the settings the role's adapter generates from
 * the process's own grants file for that role.
 *
 * Nothing else of the dev-review Flow runs: no mechanical step, no gate, no
 * forge read or write. The role's driver-run tools are served by the trial's
 * own dev-tools host, the same fake-forge host the standalone trial starts,
 * which the generated MCP settings reach through a bridge script in the
 * scratch directory. The checkpoint store is a SQLite file in that same
 * scratch directory, removed with it. The role logs in as the standalone
 * container trial does: Claude from the subscription token alone, Codex from
 * the login the Harbor agent staged in the container's Codex home.
 *
 * What the run records is read back into the same handle the standalone
 * dispatch returns: the turn result or review result from the adapter's own
 * structured output, the usage from the stream, so the trial record is built
 * the same way on both backends.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateClaudeSettings } from '../../../../../harness/adapters/agents/claude-code/settings'
import { generateCodexConfig } from '../../../../../harness/adapters/agents/codex/config'
import { loadRoleGrants, withModel } from '../../../../../harness/adapters/agents/manifest'
import type { GeneratedAgentConfig } from '../../../../../harness/adapters/agents/policy'
import { grantVariables } from '../../../../../harness/adapters/agents/variables'
import {
  createRoleLauncher,
  type ProcessRunOptions,
  startProcessRun
} from '../../../../../harness/dev-process/engine-runtime/run-process'
import { SqliteCheckpointer } from '../../../../../harness/dev-process/engine-runtime/sqlite-checkpointer'
import type { LoadedProcess } from '../../../../../harness/dev-process/loader/load-process'
import type { DispatchHandle } from '../dispatch'
import { readClaudeTurnOutput, readCodexTurnOutput } from '../dev-review-loop/turn-result'
import { DEV_TOOLS_MCP_SERVER_NAME } from '../task-tools/dev-tools-names'
import type { BridgeInvocation } from '../task-tools/dev-tools-registration'
import { containerClaudeLogin } from '../worker-boundary'
import { git } from './staging'

/**
 * The spawn the Engine's executor launches an agent with, as the runtime
 * takes it. Read through the runtime's own options: the CLI's source imports
 * no packed Atta module, not even for a type.
 */
export type SpawnFn = NonNullable<ProcessRunOptions['spawnFn']>

/** The process folder whose role grants an Engine role step launches from. */
export const ENGINE_ROLE_GRANTS_ROOT = join(import.meta.dir, '../../../../../processes/vinaya/executing')

/** The Engine roles a role trial runs, by the process's own role names. */
export type EngineTrialRole = 'developer' | 'code-reviewer' | 'security-reviewer'

/** The one agent step of a role trial's Flow. */
export const ENGINE_ROLE_STEP_ID = 'role-step'

/**
 * What the launched agent's environment carries from the trial's own: its
 * path and home. Claude's login is added to the role's own environment, never
 * read through this list.
 */
export const ENGINE_ROLE_ENV_ALLOWLIST = ['PATH', 'HOME'] as const

export interface EngineRoleStepRequest {
  role: EngineTrialRole
  adapter: 'claude-code' | 'codex'
  prompt: string
  /** The case repository the role works in; the Flow's working-directory root. */
  workingTree: string
  /** The trial's scratch directory, outside the working tree: the Flow, the generated settings and the checkpoint file. */
  scratch: string
  /** The exact model id; absent, the adapter's own default. */
  model?: string
  timeoutMs: number
  /** The structured output the role returns, as the standalone dispatch requests it. */
  outputSchema: Record<string, unknown>
  /** The bridge to the trial's dev-tools host, as the standalone dispatch's MCP settings name it. */
  devToolsBridge: BridgeInvocation
  /** The spawn the executor launches the agent with; a test passes a stub agent. */
  spawnFn?: SpawnFn
  observeStdoutLine?: (line: string) => void
}

/** The executor's own spawn: the agent process with the argv, working directory and environment the executor built. */
export const ENGINE_SPAWN: SpawnFn = (command, args, options) => spawn(command, args, options)

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/** The Flow of a role trial: the role's one agent step, nothing before or after it. */
export function roleStepFlow(role: EngineTrialRole): string {
  return [
    'schema_version: "2.0"',
    'id: vinaya-role-trial',
    'display_name: Vinaya role trial',
    'description: One role step of a Harbor role trial.',
    'experimental: true',
    'benchmarked: false',
    'defaults:',
    '  model: process-supplied',
    'agents:',
    `  - role: ${role}`,
    'steps:',
    `  - id: ${ENGINE_ROLE_STEP_ID}`,
    '    type: agent',
    `    role: ${role}`,
    '    prompt_template: "{{question}}"',
    `    permission: ${role}/grants.yaml`,
    '    working_directory: "."',
    '    max_turns: 200',
    ''
  ].join('\n')
}

/** The one-step process a role trial runs: its Flow in the scratch directory, no other declared file. */
function roleStepProcess(scratch: string, role: EngineTrialRole): LoadedProcess {
  const folder = join(scratch, 'process')
  mkdirSync(folder, { recursive: true })
  const flowPath = join(folder, 'role-step.flow.yaml')
  writeFileSync(flowPath, roleStepFlow(role))
  return {
    folder,
    identity: { id: 'vinaya-role-trial', version: '1', flow: 'role-step.flow.yaml', roles: [role] },
    flowKey: 'default',
    flowPath,
    flowPaths: { default: flowPath },
    rolePaths: [],
    digest: ''
  }
}

/** The adapter's generated settings for the role, from the process's grants file, pointed at the trial's tool host. */
export function generatedRoleConfig(request: EngineRoleStepRequest, generatedDir: string): GeneratedAgentConfig {
  const grants = withModel(loadRoleGrants(join(ENGINE_ROLE_GRANTS_ROOT, request.role, 'grants.yaml')), request.model)
  mkdirSync(generatedDir, { recursive: true })
  const outputSchemaPath = join(generatedDir, 'turn-output.schema.json')
  writeFileSync(outputSchemaPath, JSON.stringify(request.outputSchema))
  // The generated MCP settings name one command with no arguments: a script that runs the trial's bridge.
  const bridge = join(request.scratch, 'dev-tools-bridge')
  writeFileSync(
    bridge,
    `#!/bin/sh\nexec ${[request.devToolsBridge.command, ...request.devToolsBridge.args].map(shellQuote).join(' ')}\n`,
    { mode: 0o700 }
  )
  const paths = {
    generatedDir,
    outputSchemaPath,
    outputSchema: request.outputSchema,
    mcpCommand: bridge,
    variables: grantVariables(request.workingTree, request.scratch)
  }
  return request.adapter === 'claude-code' ? generateClaudeSettings(grants, paths) : generateCodexConfig(grants, paths)
}

/** The name the Engine's adapters give the driver-run tools' MCP server in a role's generated settings. */
export const ENGINE_DEV_TOOLS_SERVER = 'vinaya_dev_tools'

/**
 * One stream line with the Engine's name for the dev-tools server replaced by
 * the standalone dispatch's (`DEV_TOOLS_MCP_SERVER_NAME`): a Claude `tool_use`
 * name, or a Codex `mcp_tool_call` item's server. The same tool call then
 * reads as the same trace entry on both backends. Any other line is returned
 * unchanged.
 */
export function withStandaloneToolNames(line: string): string {
  let event: Record<string, unknown>
  try {
    event = JSON.parse(line) as Record<string, unknown>
  } catch {
    return line
  }
  if (event === null || typeof event !== 'object') return line
  const enginePrefix = `mcp__${ENGINE_DEV_TOOLS_SERVER}__`
  let renamed = false
  const message = event.message as { content?: unknown } | undefined
  if (event.type === 'assistant' && Array.isArray(message?.content)) {
    for (const block of message.content as Record<string, unknown>[]) {
      if (block?.type === 'tool_use' && typeof block.name === 'string' && block.name.startsWith(enginePrefix)) {
        block.name = `mcp__${DEV_TOOLS_MCP_SERVER_NAME}__${block.name.slice(enginePrefix.length)}`
        renamed = true
      }
    }
  }
  const item = event.item as Record<string, unknown> | undefined
  if (item?.type === 'mcp_tool_call' && item.server === ENGINE_DEV_TOOLS_SERVER) {
    item.server = DEV_TOOLS_MCP_SERVER_NAME
    renamed = true
  }
  return renamed ? JSON.stringify(event) : line
}

/** A spawn that hands every complete stdout line to `line` as well as to the executor. */
function teeStdout(spawnFn: SpawnFn, line: (text: string) => void): SpawnFn {
  return (command, args, options) => {
    const child = spawnFn(command, args, options)
    let pending = ''
    child.stdout?.on('data', (chunk) => {
      pending += chunk.toString()
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const text of lines) if (text.trim() !== '') line(text)
    })
    child.on('close', () => {
      if (pending.trim() !== '') line(pending)
      pending = ''
    })
    return child
  }
}

/**
 * The stream's own token counts, in the standalone dispatch's handle shape.
 * On Claude Code they are the sum of each assistant message's usage, each
 * message counted once however many events carry it, so a session cut off
 * before its closing `result` event still counts every message it made; a
 * stream whose assistant messages carry no usage falls back to its `result`
 * events. On Codex they are the sum of its `turn.completed` events. A stream
 * with none of these has no usage.
 */
export function usageOfStream(adapter: 'claude-code' | 'codex', lines: readonly string[]) {
  let input = 0
  let output = 0
  let read = 0
  let creation = 0
  let seen = false
  const messages = new Map<string, Record<string, unknown>>()
  const results: Record<string, unknown>[] = []
  for (const text of lines) {
    let event: Record<string, unknown>
    try {
      event = JSON.parse(text) as Record<string, unknown>
    } catch {
      continue
    }
    if (event === null || typeof event !== 'object') continue
    const usage = (event.usage ?? {}) as Record<string, unknown>
    const count = (key: string) => (typeof usage[key] === 'number' ? (usage[key] as number) : 0)
    if (adapter === 'claude-code' && event.type === 'assistant') {
      const message = (event.message ?? {}) as Record<string, unknown>
      if (message.usage !== null && typeof message.usage === 'object') {
        // One message can stream as several events, one per content block, each carrying its usage; the last counts.
        const id = typeof message.id === 'string' ? message.id : `event-${messages.size}`
        messages.set(id, message.usage as Record<string, unknown>)
      }
    }
    if (adapter === 'claude-code' && event.type === 'result') results.push(usage)
    if (adapter === 'codex' && event.type === 'turn.completed') {
      seen = true
      // Codex counts cached input inside its input, as the standalone dispatch's handle keeps it.
      input += count('input_tokens')
      output += count('output_tokens')
      read += count('cached_input_tokens')
    }
  }
  if (adapter === 'claude-code') {
    for (const usage of messages.size > 0 ? messages.values() : results) {
      const count = (key: string) => (typeof usage[key] === 'number' ? (usage[key] as number) : 0)
      seen = true
      input += count('input_tokens')
      output += count('output_tokens')
      read += count('cache_read_input_tokens')
      creation += count('cache_creation_input_tokens')
    }
  }
  return seen ? { usage: { input, output }, cacheUsage: { read, creation } } : { usage: null, cacheUsage: null }
}

/**
 * Runs the role's one step on the Engine and reads it back as a dispatch
 * handle. A run that does not complete is a failed dispatch, never a result.
 */
export async function runEngineRoleStep(request: EngineRoleStepRequest): Promise<DispatchHandle> {
  mkdirSync(request.scratch, { recursive: true })
  // Claude logs in from the container's subscription token alone, as the standalone container dispatch does.
  const claudeLogin = containerClaudeLogin(process.env, request.adapter === 'claude-code')
  if (request.adapter === 'claude-code' && claudeLogin === null)
    throw new Error('container mode authenticates Claude only from the subscription token in CLAUDE_CODE_OAUTH_TOKEN')
  const generatedDir = join(request.scratch, 'generated', request.role)
  const launcher = createRoleLauncher(generatedRoleConfig(request, generatedDir), {
    generatedDir,
    allowedPermissions: [`${request.role}/grants.yaml`],
    timeoutMs: request.timeoutMs,
    // The Codex home is the generated directory: it gets a copy of the container's staged Codex login.
    stageCodexLogin: request.adapter === 'codex'
  })
  const roles = { [request.role]: { ...launcher, env: { ...launcher.env, ...claudeLogin } } }
  const transcript: string[] = []
  const spawnFn = teeStdout(request.spawnFn ?? ENGINE_SPAWN, (raw) => {
    const line = withStandaloneToolNames(raw)
    transcript.push(line)
    request.observeStdoutLine?.(line)
  })
  const checkpointer = new SqliteCheckpointer({
    path: join(request.scratch, 'checkpoints.sqlite'),
    revision: git(request.workingTree, ['rev-parse', 'HEAD']).trim(),
    model: request.model ?? '',
    agent: request.adapter
  })
  const started = Date.now()
  let outcome: Awaited<ReturnType<typeof startProcessRun>>
  try {
    outcome = await startProcessRun({
      process: roleStepProcess(request.scratch, request.role),
      question: 'Run the role trial.',
      bindings: { actions: {}, decisions: {}, roles },
      checkpointer,
      workingDirectoryRoot: request.workingTree,
      spawnFn,
      envAllowlist: [...ENGINE_ROLE_ENV_ALLOWLIST],
      stepPrompts: { [ENGINE_ROLE_STEP_ID]: () => request.prompt }
    })
  } finally {
    checkpointer.close()
  }
  const durationMs = Date.now() - started
  const stdout = transcript.join('\n')
  const read = request.adapter === 'claude-code' ? readClaudeTurnOutput(stdout) : readCodexTurnOutput(stdout)
  const adapter =
    request.adapter === 'claude-code' ? ('claude --json-schema' as const) : ('codex --output-schema' as const)
  const completed = outcome.reason === 'completed'
  // The executor stops the agent at the launcher's time limit; a step that ends there unfinished timed out.
  const timedOut = !completed && durationMs >= request.timeoutMs
  return {
    exitCode: completed ? 0 : 1,
    // The run's own account of a step that did not complete; the caller redacts it before publication.
    ...(outcome.reason === 'failed' ? { stderr: outcome.error } : {}),
    durationMs,
    ...usageOfStream(request.adapter, transcript),
    resumeId: read.sessionId,
    timedOut,
    ...(completed ? {} : { failureReason: timedOut ? ('timeout' as const) : ('crash' as const) }),
    ...(request.role === 'developer'
      ? { turnOutput: { adapter, raw: read.raw, event: read.event } }
      : { reviewOutput: { adapter, raw: read.raw, event: read.event, terminal: read.terminal, errors: read.errors } })
  }
}
