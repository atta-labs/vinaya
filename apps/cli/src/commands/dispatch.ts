/**
 * `vinaya dispatch <role> --agent claude|codex|gemini --prompt-file <path>`.
 * Thin argv-parsing shim over
 * `dispatchRole` (`../lib/dispatch.js`) — the real spawn/timeout/attribution
 * logic lives there, including where its own log lines are delivered (the
 * `logs` setting, `../lib/log-sink.js`). This command runs no flush of its
 * own after the dispatch returns: events reach their configured destination
 * live, as `dispatchRole` emits them, so there is nothing left to ship in a
 * trailing step.
 */

import { readFileSync } from 'node:fs'
import { ROLE_VALUES, type Role } from '@attalabs/aeg-core'
import { AGENT_VENDOR_NAMES, dispatchRole, isAgentVendor, type AgentVendor } from '../lib/dispatch.js'
import { loadConfig } from '../lib/config.js'
import { printJson } from '../lib/envelope.js'

type ParsedArgs = {
  role: string | undefined
  agent: string | undefined
  model: string | undefined
  promptFile: string | undefined
  task: number | undefined
  pr: number | undefined
  round: number | undefined
  resume: string | undefined
  roleLogPath: string | undefined
  json: boolean
  /** Threads `DispatchOpts.unattended` — see that field's own doc comment. Off by default: a manual `vinaya dispatch` invocation is attended unless this flag says otherwise. */
  unattended: boolean
  /** Any `--flag`-shaped or stray positional token this parser does not
   * recognize — `dispatchCommand` refuses rather than silently dropping it.
   * Found live: an unrecognized `--tranche` flag on this command was
   * silently ignored while every other flag still took effect, so a
   * malformed manual-recovery command actually started a real developer
   * while appearing (by the presence of an unknown flag) like it might not
   * have. */
  unknown: string[]
}

const KNOWN_FLAGS = [
  '--agent',
  '--model',
  '--prompt-file',
  '--task',
  '--pr',
  '--round',
  '--resume',
  '--role-log-path',
  '--json',
  '--unattended'
]

function parseArgs(args: string[]): ParsedArgs {
  const role = args[0]
  let agent: string | undefined
  let model: string | undefined
  let promptFile: string | undefined
  let task: number | undefined
  let pr: number | undefined
  let round: number | undefined
  let resume: string | undefined
  let roleLogPath: string | undefined
  let json = false
  let unattended = false
  const unknown: string[] = []
  for (let i = 1; i < args.length; i++) {
    const a = args[i]
    if (a === '--agent') agent = args[++i]
    else if (a === '--model') model = args[++i]
    else if (a === '--prompt-file') promptFile = args[++i]
    else if (a === '--task') task = Number(args[++i])
    else if (a === '--pr') pr = Number(args[++i])
    else if (a === '--round') round = Number(args[++i])
    else if (a === '--resume') resume = args[++i]
    else if (a === '--role-log-path') roleLogPath = args[++i]
    else if (a === '--json') json = true
    else if (a === '--unattended') unattended = true
    else if (a !== undefined) unknown.push(a)
  }
  return { role, agent, model, promptFile, task, pr, round, resume, roleLogPath, json, unattended, unknown }
}

export async function dispatchCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args)

  if (parsed.unknown.length > 0) {
    process.stderr.write(
      `vinaya dispatch: unrecognized flag${parsed.unknown.length > 1 ? 's' : ''} ${parsed.unknown.map((f) => `'${f}'`).join(', ')} — expected one of ${KNOWN_FLAGS.join(', ')}\n`
    )
    process.exit(1)
  }

  if (!parsed.role || !(ROLE_VALUES as readonly string[]).includes(parsed.role)) {
    process.stderr.write(
      `vinaya dispatch: invalid role '${parsed.role ?? '(none)'}' — expected one of ${ROLE_VALUES.join(', ')}\n`
    )
    process.exit(1)
  }
  const role = parsed.role as Role

  const agentRaw = parsed.agent ?? loadConfig()?.dispatch?.agent
  if (!agentRaw) {
    process.stderr.write(
      'vinaya dispatch: --agent <claude|codex|gemini> is required (or set dispatch.agent in vinaya.config.json)\n'
    )
    process.exit(1)
  }
  if (!isAgentVendor(agentRaw)) {
    process.stderr.write(
      `vinaya dispatch: invalid vendor '${agentRaw}' — expected one of ${AGENT_VENDOR_NAMES.join(', ')}\n`
    )
    process.exit(1)
  }
  const agent: AgentVendor = agentRaw

  if (!parsed.promptFile) {
    process.stderr.write('vinaya dispatch: --prompt-file <path> is required\n')
    process.exit(1)
  }
  const promptFile = parsed.promptFile

  let prompt: string
  try {
    prompt = readFileSync(promptFile, 'utf8')
  } catch (err) {
    process.stderr.write(
      `vinaya dispatch: could not read --prompt-file '${promptFile}': ${err instanceof Error ? err.message : String(err)}\n`
    )
    process.exit(1)
    return
  }

  const handle = await dispatchRole(role, agent, prompt, {
    task: parsed.task,
    pr: parsed.pr,
    round: parsed.round,
    resumeId: parsed.resume,
    model: parsed.model,
    promptFile,
    roleLogPath: parsed.roleLogPath,
    unattended: parsed.unattended
  })

  if (parsed.json) {
    printJson({
      exitCode: handle.exitCode,
      durationMs: handle.durationMs,
      usage: handle.usage,
      resumeId: handle.resumeId,
      timedOut: handle.timedOut,
      failureReason: handle.failureReason ?? null
    })
  } else if (handle.failureReason) {
    process.stderr.write(`vinaya dispatch: ${role} via ${agent} failed (${handle.failureReason})\n`)
  } else {
    process.stdout.write(
      `vinaya dispatch: ${role} via ${agent} completed in ${handle.durationMs}ms (resumeId: ${handle.resumeId ?? 'none'})\n`
    )
  }

  if (handle.failureReason) process.exit(1)
}

import type { SurfaceExemption } from '../lib/surface-exemption'

export const SURFACE_EXEMPTIONS: Record<string, SurfaceExemption> = {
  dispatch: { date: '2026-09-22', callsToday: 4, retiresVia: 'sharedCommandShell' }
}
