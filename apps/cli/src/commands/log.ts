/**
 * `vinaya log flush` (task 2, Issue #405; reduced to argv parsing by task 3,
 * Issue #482, O1). The flush's own body — chunking, posting, the audit
 * trail, truncation — lives in `../lib/log-flush.js`'s `flushOutbox`; this
 * command parses `--issue`/`--pr`/`--json`, calls that one function, and
 * translates its return value / thrown `LogFlushError` into this process's
 * exit code and stdout/stderr. `apps/cli/specs/log.md` § The flush is the
 * durable reference for the flush's own contract.
 */

import { CHECK_SCHEMA_VERSION, type CheckError, emitCheckError } from '../checks/contract.js'
import { flushOutbox, LogFlushError, type LogFlushErrorCode, type LogFlushTarget } from '../lib/log-flush.js'
import { printJson } from '../lib/envelope.js'

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
    agent_recovery_prompt: 'No action required for the posted comments; re-run `vinaya log flush` if the audit trail must be complete.'
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

  const outcome = await flushOutbox(target).catch((err: unknown) => {
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
    printJson({ posted: outcome.chunkCount, comment_ids: outcome.commentIds, target: outcome.target })
  } else {
    process.stdout.write(`log flush: posted ${outcome.chunkCount} comment(s), ${outcome.commentIds.length} confirmed\n`)
  }
}
