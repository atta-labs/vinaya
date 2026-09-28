// `vinaya log send` — deliver a repository's LOCAL log events to the configured
// server, once (O4).
//
// Two things end up written locally when they should have reached the server,
// and this command clears both by driving the SAME delivery path a live event
// already uses (`drainOutboxToWebhook`), never a url passed on the command line:
//
//   - Events written to the local DEFAULT FOLDER because an unattended run fell
//     back there (a `logs.url` configured but the trust-anchor read could not
//     confirm it — the Mac case before O1's deadline fix, and any genuinely
//     offline unattended run). Their bytes are moved into the retry queue and
//     drained.
//   - Events sitting in the retry queue itself, including a `<name>.draining.ndjson`
//     a dead drain left behind (O3): a task whose run has ended never logs
//     another event, so nothing else triggers its drain — this does.
//
// Delivery is dedup-safe: the server stores by `event_id` and ignores a line it
// already holds (`apps/log-server/specs/server.md`), so re-sending a chunk that
// was already accepted creates no duplicate. Running it twice is therefore
// harmless — the second run finds the folder emptied and the queue drained.

import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { resolveRepo } from '@attalabs/aeg-forge-state'
import { loadConfig, loadTrustAnchorConfigAsync } from '../lib/config.js'
import { printJson } from '../lib/envelope.js'
import {
  appendHardenedLine,
  describeFolderFallback,
  LOG_DESTINATION_ANCHOR_DEADLINE_MS,
  outboxPathFor,
  resolveLogDestinationFrom,
  telemetryOutboxRoot,
  withDeadline
} from '../lib/log-sink.js'
import { drainOutboxToWebhook, type WebhookDrainOutcome } from '../lib/log-webhook-drain.js'
import { isUnattendedProcess, repoRootSync, runtimeDirForRepoAsync } from '../lib/run-paths.js'

type RepoRef = { owner: string; repo: string } | null

/** The `<owner>-<repo>` directory segment both the folder and the outbox key by, or `unresolved` — the exact rule `outboxPathFor` applies. */
function repoSegment(repo: RepoRef): string {
  return repo ? `${repo.owner}-${repo.repo}` : 'unresolved'
}

/** `subject.issue` for a file token, or `null` for the unattributed `none` bucket — the inverse of `outboxPathFor`'s own `${issue ?? 'none'}` naming. A non-`none`, non-numeric token is not one this delivery path ever wrote, so it is skipped. */
function issueFromToken(token: string): number | null | undefined {
  if (token === 'none') return null
  return /^\d+$/.test(token) ? Number(token) : undefined
}

/**
 * The task tokens with deliverable files under `dir` — `<token>.ndjson`, its
 * rotation backup `<token>.1.ndjson`, and a leftover `<token>.draining.ndjson`.
 * A `.rejected.ndjson` file is deliberately excluded: its lines were set aside
 * because they could not be vouched for, and are kept, never posted. A
 * `.flush-lock` is not a `.ndjson` file and never matches.
 */
function deliverableTokens(dir: string): Set<string> {
  const tokens = new Set<string>()
  if (!existsSync(dir)) return tokens
  for (const name of readdirSync(dir)) {
    const match = /^(none|\d+)(?:\.1|\.draining)?\.ndjson$/.exec(name)
    if (match) tokens.add(match[1] as string)
  }
  return tokens
}

/**
 * Moves a folder file's lines into the retry queue for the same task, then
 * removes the folder file — the folder is a plain append destination with no
 * drain of its own, so the only way its events reach the server is through the
 * queue. Removing the source is what makes a second `vinaya log send` a no-op
 * rather than a re-append (the server would dedup either way, but the local
 * queue should not grow on every run). The queue append is the SAME hardened
 * write the sink itself uses (`appendHardenedLine`), so a folder file is never
 * delivered by a second, drifting copy of the queue's own write rules.
 */
function moveFolderFileIntoQueue(folderFile: string, queuePath: string): number {
  const content = readFileSync(folderFile, 'utf8')
  const lines = content.split('\n').filter((l) => l.length > 0)
  if (lines.length > 0) {
    const failure = appendHardenedLine(queuePath, `${lines.join('\n')}\n`)
    if (failure !== null) {
      throw new Error(`could not move ${folderFile} into the retry queue ${queuePath} — ${failure}`)
    }
  }
  unlinkSync(folderFile)
  return lines.length
}

type SendReport = {
  destination: string
  tasks: Array<{ issue: number | null; moved: number; delivered: number; chunks: number; rejected: number }>
  totals: { moved: number; delivered: number; chunks: number; rejected: number }
  failures: Array<{ issue: number | null; reason: string }>
}

export async function logSendCommand(args: string[]): Promise<void> {
  const jsonOutput = args.includes('--json')
  const repo = await resolveRepo()

  // Resolve the destination the SAME way a live event does — the sink's own
  // pure decision function over the sink's own inputs, never a url from argv.
  // A human running this command is attended, so a configured working-tree
  // `logs.url` is honoured directly; an unattended invocation (a script, CI)
  // goes through the trust-anchor gate, bounded by the identical deadline the
  // sink uses so the two can never disagree about where events go.
  const localConfig = loadConfig()
  const unattended = isUnattendedProcess(process.env)
  const trustAnchorConfig = unattended
    ? await withDeadline(
        loadTrustAnchorConfigAsync(undefined, { quiet: true }),
        LOG_DESTINATION_ANCHOR_DEADLINE_MS,
        null
      )
    : null
  const defaultFolder = join(await runtimeDirForRepoAsync(repo), 'logs')
  const destination = resolveLogDestinationFrom({
    localConfig,
    trustAnchorConfig,
    unattended,
    env: process.env,
    defaultFolder,
    repoRoot: repoRootSync()
  })

  if (destination.kind !== 'server') {
    // Nothing to send TO. Name why, using the sink's own words for a fallback
    // so this command and the one-line warning a run prints say the same thing.
    const why =
      destination.kind === 'none'
        ? destination.reason
        : destination.fallbackReason
          ? describeFolderFallback(destination.fallbackReason)
          : 'this repository is configured to write log events to a local folder, not a server'
    const message = `vinaya log send: no server destination to deliver to — ${why}.`
    if (jsonOutput) printJson({ sent: false, reason: message })
    else process.stderr.write(`${message}\n`)
    process.exit(1)
  }

  const segment = repoSegment(repo)
  const folderDir = join(defaultFolder, segment)
  const outboxDir = join(telemetryOutboxRoot(), segment)

  // Every task with something local to deliver: a folder file (from the
  // fallback) OR a queue file (a backlog, or a dead drain's leftover).
  const tokens = new Set<string>([...deliverableTokens(folderDir), ...deliverableTokens(outboxDir)])

  const report: SendReport = {
    destination: destination.url,
    tasks: [],
    totals: { moved: 0, delivered: 0, chunks: 0, rejected: 0 },
    failures: []
  }

  for (const token of [...tokens].sort()) {
    const issue = issueFromToken(token)
    if (issue === undefined) continue

    let moved = 0
    try {
      // Backup slot first, then the live file — oldest events ahead of newer,
      // the same order a drain itself delivers a rotated queue in.
      const queuePath = outboxPathFor({ outboxRoot: telemetryOutboxRoot }, repo, issue)
      for (const suffix of ['.1.ndjson', '.ndjson']) {
        const folderFile = join(folderDir, `${token}${suffix}`)
        if (existsSync(folderFile)) moved += moveFolderFileIntoQueue(folderFile, queuePath)
      }
      const outcome: WebhookDrainOutcome = await drainOutboxToWebhook(issue, destination.url, destination.headers)
      report.tasks.push({
        issue,
        moved,
        delivered: outcome.lineCount,
        chunks: outcome.chunks,
        rejected: outcome.rejected
      })
      report.totals.moved += moved
      report.totals.delivered += outcome.lineCount
      report.totals.chunks += outcome.chunks
      report.totals.rejected += outcome.rejected
    } catch (err) {
      report.failures.push({ issue, reason: err instanceof Error ? err.message : String(err) })
    }
  }

  if (jsonOutput) {
    printJson({ sent: true, ...report })
    process.exit(report.failures.length > 0 ? 1 : 0)
  }

  process.stdout.write(`vinaya log send → ${report.destination}\n\n`)
  if (report.tasks.length === 0 && report.failures.length === 0) {
    process.stdout.write('Nothing to send — the local folder and the retry queue hold no undelivered events.\n')
    return
  }
  for (const task of report.tasks) {
    const who = task.issue === null ? '(unattributed)' : `#${task.issue}`
    process.stdout.write(
      `· ${who}: delivered ${task.delivered} line(s) in ${task.chunks} POST(s)` +
        `${task.moved > 0 ? ` (${task.moved} from the local folder)` : ''}` +
        `${task.rejected > 0 ? `, ${task.rejected} set aside` : ''}\n`
    )
  }
  for (const failure of report.failures) {
    const who = failure.issue === null ? '(unattributed)' : `#${failure.issue}`
    process.stderr.write(`✗ ${who}: ${failure.reason}\n`)
  }
  process.stdout.write(
    `\nSent ${report.totals.delivered} line(s) across ${report.tasks.length} task(s). ` +
      'The server deduplicates by event id, so nothing was posted twice.\n'
  )
  if (report.failures.length > 0) process.exit(1)
}

import type { SurfaceExemption } from '../lib/surface-exemption'

// `log send` deliberately composes several lib helpers rather than routing
// through one chokepoint: it resolves the destination the sink's own way
// (config + run-paths + the pure `resolveLogDestinationFrom`), moves folder
// files into the retry queue with the sink's own hardened append, and drains
// through `drainOutboxToWebhook`. There is no single lib function that both
// resolves a destination AND delivers a repository's local backlog, and
// inventing a façade to satisfy the one-call rule would only hide the wiring a
// reader needs to see. The retirement target is a future `log-delivery.ts` that
// owns "deliver everything local for this repo" behind one call.
export const SURFACE_EXEMPTIONS: Record<string, SurfaceExemption> = {
  'log send': { date: '2026-09-28', callsToday: 13, retiresVia: 'logDeliveryChokepoint' }
}
