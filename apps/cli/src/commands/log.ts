/**
 * `vinaya log flush` (reduced to argv parsing by a later task). The flush's own body — chunking, posting, the audit
 * trail, truncation — lives in `../lib/log-flush.js`'s `flushOutbox`; this
 * command parses `--issue`/`--pr`/`--json`, calls that one function, and
 * translates its return value / thrown `LogFlushError` into this process's
 * exit code and stdout/stderr. `apps/cli/specs/log.md` § The flush is the
 * durable reference for the flush's own contract.
 */

import { CHECK_SCHEMA_VERSION, type CheckError, emitCheckError } from '../checks/contract.js'
import {
  flushOutbox,
  issueFromPr,
  LogFlushError,
  type LogFlushErrorCode,
  type LogFlushTarget
} from '../lib/log-flush.js'
import { flushOutboxToWebhook, WebhookFlushError } from '../lib/log-webhook-flush.js'
import { collectTaskLogArtifact, exportTaskLogArtifact } from '../lib/log-artifact.js'
import { printJson } from '../lib/envelope.js'
import { loadConfig, resolveLogPublishMaxChunksPerFlush, resolveLogPublishTarget } from '../lib/config.js'

function makeCheckError(check: string, message: string, agentRecoveryPrompt: string): CheckError {
  return { schema: CHECK_SCHEMA_VERSION, check, severity: 'error', message, agent_recovery_prompt: agentRecoveryPrompt }
}

/** Exit 2 (not `forge-write.ts`'s `refuse()`, which exits 1) — this command's own Test Plan pins the code. */
function refuse2(error: CheckError): never {
  emitCheckError(error)
  process.exit(2)
}

function emitAuditLineWarning(message: string): void {
  emitCheckError({
    schema: CHECK_SCHEMA_VERSION,
    check: 'log-flush-audit-line-unconfirmed',
    severity: 'warning',
    message,
    agent_recovery_prompt:
      'No action required for the posted comments; re-run `vinaya log flush` if the audit trail must be complete.'
  })
}

const RECOVERY_PROMPTS: Record<LogFlushErrorCode, string> = {
  'log-flush-pr-closes-n':
    'Add a `Closes #<N>` line to the PR body (the same anchor every gate reads), then re-run `vinaya log flush --pr <n>`.',
  'log-flush-symlink': 'Remove or replace the outbox target with a regular file, then re-run `vinaya log flush`.',
  'log-flush-line-too-large':
    'Split the offending event into smaller payload fields upstream — a single outbox line is never split across two comments.',
  'log-flush-corrupt-line':
    'Inspect the named line by hand (a manual edit, disk corruption, or a redact.ts gap) — nothing was posted or truncated.',
  'log-flush-audit-line-unconfirmed': 'Re-run `vinaya log flush` — nothing was posted or truncated.',
  'log-flush-gh-failed':
    'Fix the reported gh error (auth, rate limit, or network), then re-run `vinaya log flush` — unposted lines were preserved.'
}

type ParsedArgs = { issue: number | undefined; pr: number | undefined; json: boolean }

function parseArgs(args: string[]): ParsedArgs {
  let issueRaw: string | undefined
  let prRaw: string | undefined
  let json = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--issue') issueRaw = args[++i]
    else if (a === '--pr') prRaw = args[++i]
    else if (a === '--json') json = true
  }
  return {
    issue: issueRaw === undefined ? undefined : Number(issueRaw),
    pr: prRaw === undefined ? undefined : Number(prRaw),
    json
  }
}

export async function logFlushCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args)
  if ((parsed.issue !== undefined) === (parsed.pr !== undefined)) {
    refuse2(
      makeCheckError(
        'log-flush-args',
        'vinaya log flush requires exactly one of --issue or --pr.',
        'Re-run with exactly one of `--issue <n>` or `--pr <n>`.'
      )
    )
  }

  const target: LogFlushTarget = parsed.pr !== undefined ? { pr: parsed.pr } : { issue: parsed.issue as number }

  const config = loadConfig()

  // `logPublish.webhookUrl` (set) overrides GitHub-comment posting entirely
  // for every caller of this command — `--issue`/`--pr` still selects WHICH
  // task's local outbox to drain (the outbox is keyed by Issue only, same
  // as the GitHub path: `--pr` resolves its Issue via `Closes #N`), but the
  // destination is the configured webhook, not a comment on that Issue/PR.
  const webhookTarget = resolveLogPublishTarget(config)
  if (webhookTarget !== null && 'webhookUrl' in webhookTarget) {
    const outboxTask = parsed.pr !== undefined ? issueFromPr(String(parsed.pr)) : (parsed.issue as number)
    const outcome = await flushOutboxToWebhook(outboxTask, webhookTarget.webhookUrl, webhookTarget.headers).catch(
      (err: unknown) => {
        if (err instanceof WebhookFlushError) {
          refuse2(makeCheckError(err.code, err.message, 'Fix the reported error, then re-run `vinaya log flush`.'))
        }
        throw err
      }
    )
    if (!outcome.flushed) {
      process.stdout.write('log flush: nothing to flush\n')
      process.exit(0)
    }
    if (parsed.json) {
      printJson({ posted: outcome.lineCount, bytes: outcome.bytes, target: { webhookUrl: webhookTarget.webhookUrl } })
    } else {
      process.stdout.write(`log flush: posted ${outcome.lineCount} line(s), ${outcome.bytes} byte(s) to webhook\n`)
    }
    return
  }

  // Honors the same `logPublish.maxChunksPerFlush` bound
  // the round-end flush reads, so an adopter's configured per-target cap
  // applies uniformly regardless of which caller reaches `flushOutbox`.
  const maxChunksPerFlush = resolveLogPublishMaxChunksPerFlush(config)

  const outcome = await flushOutbox(target, { skipRemotelyAccepted: true, maxChunksPerFlush }).catch((err: unknown) => {
    if (err instanceof LogFlushError) {
      if (err.warning) emitAuditLineWarning(err.warning)
      refuse2(makeCheckError(err.code, err.message, RECOVERY_PROMPTS[err.code]))
    }
    throw err
  })

  if (!outcome.flushed) {
    process.stdout.write('log flush: nothing to flush\n')
    process.exit(0)
  }

  if (outcome.warning) emitAuditLineWarning(outcome.warning)

  if (parsed.json) {
    printJson({
      posted: outcome.chunkCount,
      comment_ids: outcome.commentIds,
      target: outcome.target,
      deferred: outcome.deferredChunkCount
    })
  } else {
    process.stdout.write(`log flush: posted ${outcome.chunkCount} comment(s), ${outcome.commentIds.length} confirmed\n`)
    // A non-zero count is bounded, per-flush "partial
    // coverage this round" — visible, never silent — not a failure of any
    // kind, so it is stdout, not a `CheckError`. Re-run the same command
    // (idempotent — `skipRemotelyAccepted: true` above) to post more.
    if (outcome.deferredChunkCount > 0) {
      process.stdout.write(
        `log flush: ${outcome.deferredChunkCount} chunk(s) remain queued in the outbox — re-run to post more.\n`
      )
    }
  }
}

/**
 * `vinaya log export-artifact <dest>`. Runs inside
 * the task-path `pull_request` job (`checksWorkflow`), which holds no
 * forge-write credential — this command only ever copies this run's own
 * local outbox to `dest` for the generated workflow's own
 * `actions/upload-artifact` step to pick up next. Always exits 0: an empty
 * outbox (no gate events this run) is a legitimate outcome, never a
 * failure of the check suite this step rides alongside.
 */
export async function logExportArtifactCommand(args: string[]): Promise<void> {
  const dest = args[0]
  if (!dest) {
    refuse2(
      makeCheckError(
        'log-export-artifact-args',
        'vinaya log export-artifact requires a destination file path.',
        'Re-run with a destination path: `vinaya log export-artifact <dest>`.'
      )
    )
  }
  const outcome = exportTaskLogArtifact(dest as string)
  if (outcome.written) {
    process.stdout.write(
      `log export-artifact: wrote ${outcome.lineCount} record(s), ${outcome.bytes} byte(s) to ${dest}\n`
    )
  } else {
    process.stdout.write('log export-artifact: no outbox content this run — nothing written\n')
  }
}

/**
 * `vinaya log collect-artifact <path> --pr <n>` (O1/O2/O3). Runs inside the
 * trusted collector workflow (`taskLogCollectorWorkflow`), a `workflow_run`
 * job on the default branch holding its own write credential. `<path>` is
 * an artifact already downloaded by that workflow's own
 * `actions/download-artifact` step, scoped to a specific, API-verified
 * run-id — the provenance guarantee this command's own content-level
 * validation (`collectTaskLogArtifact`) does not re-derive, only checks in
 * addition to. Exits 0 whenever validation ran, even if every line was
 * rejected (a full-gap outcome is reported, never a process failure) —
 * only a missing/malformed `--pr` is a usage refusal.
 */
export async function logCollectArtifactCommand(args: string[]): Promise<void> {
  let path: string | undefined
  let prRaw: string | undefined
  let repoRaw: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--pr') prRaw = args[++i]
    else if (a === '--repo') repoRaw = args[++i]
    else if (path === undefined) path = a
  }
  const pr = prRaw === undefined ? undefined : Number(prRaw)
  if (!path || pr === undefined || !repoRaw) {
    refuse2(
      makeCheckError(
        'log-collect-artifact-args',
        'vinaya log collect-artifact requires an artifact path, --pr <n>, and --repo <owner/repo>.',
        'Re-run with: `vinaya log collect-artifact <path> --pr <n> --repo <owner/repo>`.'
      )
    )
  }

  const target: LogFlushTarget = { pr: pr as number }
  const outcome = await collectTaskLogArtifact(path as string, target, repoRaw as string).catch((err: unknown) => {
    if (err instanceof LogFlushError) {
      if (err.warning) emitAuditLineWarning(err.warning)
      refuse2(makeCheckError(err.code, err.message, RECOVERY_PROMPTS[err.code]))
    }
    throw err
  })

  // `chunkCount` counts every chunk flushOutbox considered — a marker
  // already on the forge is ACKNOWLEDGED (truncated), not posted a second
  // time (O3 dedup) — so `commentIds.length` is the honest "actually
  // published new" figure, the same split `vinaya log flush`'s own output
  // already reports as "posted"/"confirmed".
  const newlyPublished = outcome.publish?.flushed === true ? outcome.publish.commentIds.length : 0

  if (!outcome.attempted) {
    process.stdout.write(`log collect-artifact: could not read artifact at ${path} — nothing to validate\n`)
    return
  }
  process.stdout.write(
    `log collect-artifact: published ${newlyPublished} chunk(s), ${outcome.gaps.length} gap(s)${outcome.rejectedForSize ? ' (artifact rejected for size)' : ''}\n`
  )
  for (const gap of outcome.gaps) {
    process.stdout.write(`  gap: ${gap.reason}\n`)
  }
}

import type { SurfaceExemption } from '../lib/surface-exemption'

export const SURFACE_EXEMPTIONS: Record<string, SurfaceExemption> = {
  'log flush': { date: '2026-09-16', callsToday: 7, retiresVia: 'sharedCommandShell' }
}
