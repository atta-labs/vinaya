/**
 * `vinaya dispatch <role> --agent claude|codex|gemini --prompt-file <path>`.
 * Thin argv-parsing shim over
 * `dispatchRole` (`../lib/dispatch.js`) — the real spawn/timeout/attribution
 * logic lives there. Calls `flushOutbox`/`flushOutboxToWebhook`
 * (`../lib/log-flush.js`/`../lib/log-webhook-flush.js`) directly when
 * `--task`/`--pr` is given, per the Principal's ruling that this command's
 * three-vendor/spawn/signal shape is exempt from the one-lib-call rule
 * (`apps/cli/specs/surface.md`) — no shared `flushLog` extraction here, that
 * is `sharedCommandShell`'s own future task.
 *
 * **The trailing flush's destination is `logPublish`,
 * never `--task`/`--pr` directly.** `--task`/`--pr` only pick WHICH
 * task's own local outbox to drain — same as `vinaya log flush`'s own
 * `--issue`/`--pr` for that half. Before this fix, this command posted the
 * outbox straight onto the dispatched task's own Issue/PR unconditionally,
 * ignoring `vinaya.config.json`'s `logPublish` entirely: a configured
 * `webhookUrl` was silently never honored here, and there was no way to
 * configure "publish nowhere" for this call site the way the round-end
 * auto-flush already allows. `resolveRoundEndFlushTarget`/
 * `describeSkippedRoundEndFlush` (`../lib/config.js`) are the same two
 * functions the round-end auto-flush uses, so a repo that configures
 * `logPublish` gets identical behavior — including the refusal to publish
 * back onto the very task/Issue being flushed — from every flush call site.
 * With no `logPublish` configured (the ordinary default for every existing
 * repo), this command now publishes nowhere and says so on stderr, rather
 * than defaulting to the task's own Issue/PR.
 *
 * A resolved `webhookUrl` is additionally gated against
 * `loadTrustAnchorConfig()` (round-2 security review, BLOCKER) the same way
 * `defaultFlushOutbox` (`../lib/dev-review-loop.js`) gates the round-end
 * auto-flush: this command is not always human-run, since a dispatched
 * role's own nested `vinaya dispatch` call reaches this exact trailing-flush
 * code with no human approving that run, so a PR-controlled working-tree
 * `webhookUrl` is never honored on its own — only the repository's
 * default-branch copy of the SAME `webhookUrl` authorizes the POST.
 *
 * `flushOutbox`/`flushOutboxToWebhook` never call `process.exit` — unlike
 * the `logFlushCommand` this used to call directly, a real command-calling-
 * command case `surface.md`'s Exemptions table used to carry for this row
 * (retired by that same task). A thrown
 * `LogFlushError`/`WebhookFlushError` is caught and logged to stderr, never
 * fatal: a flush failure does not undo the dispatch's own effect (the child
 * already ran, and its log lines are already durably written to the local
 * outbox for a later `vinaya log flush` retry).
 */

import { readFileSync } from 'node:fs'
import { ROLE_VALUES, type Role } from '@attalabs/aeg-core'
import { AGENT_VENDOR_NAMES, dispatchRole, isAgentVendor, type AgentVendor } from '../lib/dispatch.js'
import {
  describeSkippedRoundEndFlush,
  loadConfig,
  loadTrustAnchorConfig,
  resolveLogPublishMaxChunksPerFlush,
  resolveRoundEndFlushTarget,
  resolveTrustAnchorWebhookTarget,
  type VinayaConfig
} from '../lib/config.js'
import { printJson } from '../lib/envelope.js'
import { flushOutbox, issueFromPr, LogFlushError } from '../lib/log-flush.js'
import { flushOutboxToWebhook, WebhookFlushError } from '../lib/log-webhook-flush.js'

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
  /** O3 (task 3, `#560`): threads `DispatchOpts.unattended` — see that field's own doc comment. Off by default: a manual `vinaya dispatch` invocation is attended unless this flag says otherwise. */
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

  if (parsed.task !== undefined && parsed.pr !== undefined) {
    process.stderr.write(
      'vinaya dispatch: --task and --pr are mutually exclusive (ambiguous flush target) — pass exactly one\n'
    )
    process.exit(1)
  }

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

  if (parsed.task !== undefined || parsed.pr !== undefined) {
    const outboxTask = parsed.task !== undefined ? parsed.task : issueFromPr(String(parsed.pr))
    const config = loadConfig()
    const skipReason = describeSkippedRoundEndFlush(config, outboxTask)
    if (skipReason) {
      process.stderr.write(`vinaya dispatch: ${skipReason}\n`)
    } else {
      const target = resolveRoundEndFlushTarget(config, outboxTask)
      if (target === null) {
        process.stderr.write(
          `vinaya dispatch: no logPublish target configured in vinaya.config.json — skipping publish; telemetry stays in the local outbox for #${outboxTask} (retry later with \`vinaya log flush\`).\n`
        )
      } else if ('webhookUrl' in target) {
        // Same trust-anchor gate `defaultFlushOutbox` (`../lib/dev-review-loop.js`)
        // applies to the round-end auto-flush — required here too, not just
        // there: this command's own doc comment above documents a dispatched
        // role's nested `vinaya dispatch` call reaching this exact code path
        // with no human approving the run, so a working-tree `webhookUrl`
        // (the PR's own `vinaya.config.json`) is never honored on its own.
        // Only the repository's default-branch copy of the SAME `webhookUrl`
        // authorizes the POST.
        let anchorConfig: VinayaConfig | null
        try {
          anchorConfig = loadTrustAnchorConfig()
        } catch {
          anchorConfig = null
        }
        const anchorTarget = resolveTrustAnchorWebhookTarget(target.webhookUrl, anchorConfig)
        if (!anchorTarget) {
          process.stderr.write(
            `vinaya dispatch: trailing flush's configured logPublish.webhookUrl is not present on the repository's default branch (or doesn't match it) — refusing to POST there automatically, since a PR under review cannot grant itself a new outbound destination; merge it to the default branch first.\n`
          )
        } else {
          try {
            const outcome = await flushOutboxToWebhook(outboxTask, anchorTarget.webhookUrl, anchorTarget.headers)
            if (!outcome.flushed) {
              process.stderr.write('vinaya dispatch: trailing webhook flush — nothing to flush\n')
            }
          } catch (err) {
            const message = err instanceof WebhookFlushError || err instanceof Error ? err.message : String(err)
            process.stderr.write(
              `vinaya dispatch: trailing webhook flush failed (non-fatal — retry with \`vinaya log flush\`): ${message}\n`
            )
          }
        }
      } else {
        try {
          const outcome = await flushOutbox(target, {
            outboxTask,
            maxChunksPerFlush: resolveLogPublishMaxChunksPerFlush(config)
          })
          if (outcome.flushed && outcome.deferredChunkCount > 0) {
            process.stderr.write(
              `vinaya dispatch: trailing flush bounded — ${outcome.deferredChunkCount} chunk(s) remain queued in the outbox (non-fatal — retry with \`vinaya log flush\`).\n`
            )
          }
        } catch (err) {
          const message = err instanceof LogFlushError || err instanceof Error ? err.message : String(err)
          process.stderr.write(
            `vinaya dispatch: log flush failed (non-fatal — retry with \`vinaya log flush\`): ${message}\n`
          )
        }
      }
    }
  }

  if (handle.failureReason) process.exit(1)
}

import type { SurfaceExemption } from '../lib/surface-exemption'

export const SURFACE_EXEMPTIONS: Record<string, SurfaceExemption> = {
  dispatch: { date: '2026-09-16', callsToday: 12, retiresVia: 'sharedCommandShell' }
}
