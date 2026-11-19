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

import { isEntryPoint } from '../../../../kernel/gates/checks/entry-point.js'
import { existsSync, readFileSync, readdirSync, realpathSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { resolveRepo } from '../../../../kernel/adapters/code-host/github/resolve-repo'
import { loadConfig, loadTrustAnchorConfigAsync, resolveCiTrustAnchorProbeRef } from '../config/compose.js'
import {
  defaultRuntimeDir,
  repoSegment as sdkRepoSegment,
  resolveSettings
} from '../../../../../packages/log-sdk/src/writer/settings.js'
import { printJson } from '../../../../kernel/effects/envelope.js'
import {
  appendHardenedLine,
  describeFolderFallback,
  isUnattributedStreamName,
  LOG_DESTINATION_ANCHOR_DEADLINE_MS,
  outboxPathFor,
  resolveLogDestinationFrom,
  telemetryOutboxRoot,
  withDeadline
} from '../../../../kernel/log/log-sink.js'
import { drainOutboxToWebhook, type WebhookDrainOutcome } from '../../../../kernel/log/client/log-webhook-drain.js'
import {
  isInsideRepo,
  isUnattendedProcess,
  repoRootSync,
  runtimeDirForRepoAsync
} from '../../../../kernel/run-paths.js'
import { resolveOtlpAddress } from '../../../../kernel/log/otlp-address.js'
import { sendLocalCopy } from '../../../../../packages/log-sdk/src/sender/send.js'

type RepoRef = { owner: string; repo: string } | null

/** The `<owner>-<repo>` directory segment both the folder and the outbox key by, or `unresolved` — the exact rule `outboxPathFor` applies. */
function repoSegment(repo: RepoRef): string {
  return repo ? `${repo.owner}-${repo.repo}` : 'unresolved'
}

/** `subject.issue` for a file token, or `null` for the unattributed `none` bucket and for a caller-named unattributed stream (`none-<label>`, `isUnattributedStreamName`) — the inverse of `outboxPathFor`'s own naming. Any other token is not one this delivery path ever wrote, so it is skipped. A folder's unattributed stream is moved into the one `none` retry queue, the queue a drain reads for unattributed events. */
function issueFromToken(token: string): number | null | undefined {
  if (token === 'none' || isUnattributedStreamName(token)) return null
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
    const match = /^(none(?:-[a-z0-9]+)*|\d+)(?:\.1|\.draining)?\.ndjson$/.exec(name)
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

function physicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error
    return join(physicalPath(dirname(path)), basename(path))
  }
}

function localCopyFolder(configured: string | undefined, fallback: string, root: string | null): string {
  if (!configured || isInsideRepo(configured, root)) return fallback
  if (root && isInsideRepo(physicalPath(configured), realpathSync(root))) return fallback
  return configured
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
  const otlpAnchored = unattended || Boolean(process.env.GITHUB_ACTIONS || process.env.CI)
  const probe = resolveCiTrustAnchorProbeRef()
  const trustAnchorConfig =
    unattended || (otlpAnchored && !probe)
      ? await withDeadline(
          loadTrustAnchorConfigAsync(undefined, { quiet: true }),
          LOG_DESTINATION_ANCHOR_DEADLINE_MS,
          null
        )
      : null
  const defaultFolder = join(await runtimeDirForRepoAsync(repo), 'logs')
  const repoRoot = repoRootSync()
  const destination = resolveLogDestinationFrom({
    localConfig,
    trustAnchorConfig: unattended ? trustAnchorConfig : null,
    unattended,
    env: process.env,
    defaultFolder,
    repoRoot
  })

  const legacy =
    destination.kind === 'server'
      ? await deliverServerLogs(repo, defaultFolder, destination).catch(
          (): SendReport => ({
            destination: destination.url,
            tasks: [],
            totals: { moved: 0, delivered: 0, chunks: 0, rejected: 0 },
            failures: [{ issue: null, reason: 'could not enumerate Log server backlog' }]
          })
        )
      : undefined
  const serverReason =
    destination.kind === 'server'
      ? undefined
      : destination.kind === 'none'
        ? destination.reason
        : destination.fallbackReason
          ? describeFolderFallback(destination.fallbackReason)
          : 'this repository is configured to write log events to a local folder, not a server'
  const reason = serverReason ? `vinaya log send: no server destination to deliver to — ${serverReason}.` : undefined
  const address = resolveOtlpAddress({
    localConfig,
    trustAnchorConfig: probe ? null : trustAnchorConfig,
    unattended,
    env: process.env
  })
  const repository = repo ? `${repo.owner}/${repo.repo}` : undefined
  async function deliverOtlp(url: string, headers: Record<string, string> | undefined) {
    try {
      const sdk = !otlpAnchored && repoRoot ? resolveSettings({ repoRoot, repository }) : undefined
      if (sdk && !sdk.ok) throw new Error('SDK settings unavailable')
      const settings = otlpAnchored ? trustAnchorConfig?.logs : (sdk?.settings.logs ?? localConfig?.logs)
      const runtime = otlpAnchored
        ? (trustAnchorConfig?.runtimeDir ?? defaultRuntimeDir(repository))
        : sdk?.settings.runtimeDir
      const folder = localCopyFolder(
        (settings || undefined)?.folder,
        runtime ? join(runtime, 'logs') : defaultFolder,
        repoRoot
      )
      const target = join(folder, sdkRepoSegment(repository))
      if (
        !repoRoot ||
        [target, join(target, '.otlp-delivery')].some((path) =>
          isInsideRepo(physicalPath(path), realpathSync(repoRoot))
        )
      )
        throw new Error('Unsafe SDK Log directory')
      return await sendLocalCopy({ folder, repository, url, headers })
    } catch {
      return {
        sent: 0,
        setAside: [],
        failures: [{ file: undefined, offset: undefined, reason: 'SDK Log directory unavailable or unsafe' }]
      }
    }
  }
  const otlp = address.kind === 'address' ? await deliverOtlp(address.url, address.headers) : { reason: address.reason }
  const failed =
    (!legacy && address.kind === 'none') ||
    Boolean(legacy?.failures.length) ||
    ('failures' in otlp && otlp.failures.length > 0)

  if (jsonOutput) printJson({ sent: Boolean(legacy) || address.kind === 'address', reason, ...legacy, otlp })
  else {
    if (legacy) printServerReport(legacy)
    else if (reason) process.stderr.write(`${reason}\n`)
    if ('reason' in otlp) process.stdout.write(`OpenTelemetry: ${otlp.reason}.\n`)
    else {
      process.stdout.write(
        `OpenTelemetry: sent ${otlp.sent} line(s), set aside ${otlp.setAside.length}, failed ${otlp.failures.length}.\n`
      )
      for (const item of [...otlp.setAside, ...otlp.failures]) {
        const location =
          item.file === undefined ? '' : ` ${item.file}${item.offset === undefined ? '' : `@${item.offset}`}`
        process.stderr.write(`OpenTelemetry${location}: ${item.reason}\n`)
      }
    }
  }
  if (failed) process.exit(1)
}

async function deliverServerLogs(
  repo: RepoRef,
  defaultFolder: string,
  destination: Extract<ReturnType<typeof resolveLogDestinationFrom>, { kind: 'server' }>
): Promise<SendReport> {
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

  return report
}

function printServerReport(report: SendReport): void {
  process.stdout.write(`vinaya-log-send → ${report.destination}\n\n`)
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
}

// `log send` deliberately composes several lib helpers rather than routing
// through one chokepoint: it resolves the destination the sink's own way
// (config + run-paths + the pure `resolveLogDestinationFrom`), moves folder
// files into the retry queue with the sink's own hardened append, and drains
// through `drainOutboxToWebhook`. There is no single lib function that both
// resolves a destination AND delivers a repository's local backlog, and
// inventing a façade to satisfy the one-call rule would only hide the wiring a
// reader needs to see. The retirement target is a future `log-delivery.ts` that
// owns "deliver everything local for this repo" behind one call.

// Run as a program (`vinaya-log-send`): started through the shared program entry.
if (isEntryPoint(import.meta.url, 'log-send')) {
  const { runProgram } = await import('../../tools/program-entry.js')
  await runProgram('log-send', async (argv: string[]) => {
    await logSendCommand(argv)
  })
}
