/**
 * `vinaya sync` (`apps/cli/specs/log-sync.md`): the one library function
 * behind the command (`apps/cli/specs/surface.md` — a command calls exactly
 * one effects-layer function). It resolves this repository's log
 * destination exactly as the sink itself does (`resolveLogDestinationFrom`,
 * attended/unattended alike — never forced either way), picks the folder or
 * server source for it, opens the durable cache under this repository's
 * runtime directory, runs the bounded sync engine, and prints the run's
 * summary. It reads the destination and writes only its own cache
 * directory: it never appends to the folder, never POSTs to the server, and
 * never touches the forge.
 */

import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { type RepoRef, resolveRepo } from '@attalabs/aeg-forge-state'
import type { LogCache, LogSource } from '@attalabs/aeg-core'
// `syncSource`/`SyncSummary` are not re-exported from the package root
// (`packages/aeg-core/src/index.ts`, out of this task's surface) — only from
// its `./log` subpath export, which the package's own `exports` map already
// publishes.
import { type SyncSummary, syncSource } from '@attalabs/aeg-core/log'
import { loadConfig, loadTrustAnchorConfigAsync, resolveLogsHeaderValues, type VinayaConfig } from './config.js'
import { toEnvelope } from './envelope.js'
import {
  LOG_DESTINATION_ANCHOR_DEADLINE_MS,
  logsCredentialMissing,
  resolveLogDestinationFrom,
  withDeadline,
  type ResolvedLogDestination
} from './log-sink.js'
import { CACHE_FILE_NAME, createSqliteCache } from './log-cache-sqlite.js'
import { createFolderLogSource } from './log-sync-folder-source.js'
import { createServerLogSource, type RejectedDiagnostic, type ServerLogSource } from './log-sync-server-source.js'
import { isUnattendedProcess, repoRootSync, runtimeDirForRepoAsync } from './run-paths.js'

/** The cache directory's own name under this repository's runtime directory (O3, Decisions). */
export const LOGS_CACHE_DIR_NAME = 'logs-cache'

/**
 * Deletes the cache database and its write-ahead-log and shared-memory side
 * files from `dir` — exactly these three names, never a glob. The caller has
 * already closed any handle: a side file left behind makes the next open fail
 * with "disk I/O error" on macOS.
 */
export function deleteCacheFiles(dir: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = join(dir, `${CACHE_FILE_NAME}${suffix}`)
    if (existsSync(file)) unlinkSync(file)
  }
}

export type SyncRunOptions = {
  rebuild: boolean
  json: boolean
}

export type LogSyncDeps = {
  resolveRepo: () => Promise<RepoRef | null>
  /** The destination this repository resolves — the sink's own attended/unattended decision, never forced (O1). */
  resolveDestination: (repo: RepoRef | null) => Promise<ResolvedLogDestination>
  /** The working tree's raw `logs.readHeaders` (`${VAR}` references intact), or `undefined` when none is configured. */
  readHeadersRaw: () => Record<string, string> | undefined
  /** Substitutes `${VAR}` references in a header map from the process environment. */
  resolveHeaders: (headers: Record<string, string> | undefined) => Record<string, string> | undefined
  /** This repository's cache directory (O3) — created if missing. Never the whole runtime directory. */
  cacheDir: (repo: RepoRef | null) => Promise<string>
  /** Deletes ONLY the cache database and its `-wal`/`-shm` side files inside `dir`, if present — never anything else in it (O3 `--rebuild`). */
  deleteCacheFile: (dir: string) => void
  /** Opens the durable cache at `dir`. */
  openCache: (dir: string) => LogCache & { close?: () => void }
  folderSource: (folder: string, repo: RepoRef | null) => LogSource
  serverSource: (url: string, headers: Record<string, string> | undefined, env: NodeJS.ProcessEnv) => ServerLogSource
  env: NodeJS.ProcessEnv
  now: () => Date
  /** Bound override — test-only seam. `undefined` runs the engine's own default (50 pages). */
  maxPages?: number
  /** Look-back-span override — test-only seam. `undefined` runs the engine's own default (1000 positions). */
  lookback?: number
  stdout: (text: string) => void
  stderr: (text: string) => void
}

/** The `${VAR}` names a header template references — never a value (O4), the same convention `log selftest` uses. */
function credentialVarNames(headers: Record<string, string> | undefined): string[] {
  const names = new Set<string>()
  for (const value of Object.values(headers ?? {})) {
    for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) names.add(match[1] as string)
  }
  return [...names]
}

function formatRejected(rejected: RejectedDiagnostic): string {
  if (!rejected.available) return `lost events (server-reported): unavailable — ${rejected.reason}`
  if (rejected.reasons.length === 0)
    return `lost events (server-reported): none in the last ${rejected.window} position(s)`
  const byReason = rejected.reasons.map((r) => `${r.reason}×${r.count}`).join(', ')
  return `lost events (server-reported): ${rejected.reasons.reduce((n, r) => n + r.count, 0)} in the last ${rejected.window} position(s) (${byReason})`
}

type SyncReport =
  | { ok: false; reason: string }
  | {
      ok: true
      rebuild: boolean
      destination: { kind: 'folder'; folder: string } | { kind: 'server'; url: string }
      summary: SyncSummary
      rejected?: RejectedDiagnostic
    }

function printReport(report: SyncReport, json: boolean, deps: Pick<LogSyncDeps, 'stdout' | 'stderr'>): void {
  if (json) {
    deps.stdout(`${JSON.stringify(toEnvelope(report), null, 2)}\n`)
    return
  }
  if (!report.ok) {
    deps.stderr(`vinaya sync: ${report.reason}\n`)
    return
  }
  const { summary } = report
  const lines: string[] = []
  const where =
    report.destination.kind === 'folder' ? `folder ${report.destination.folder}` : `server ${report.destination.url}`
  lines.push(`vinaya sync → ${where}${report.rebuild ? ' (rebuilt)' : ''}`)
  if (report.rebuild) {
    lines.push(
      "Rebuilt the cache from scratch — cache.sqlite was deleted and this run started from the beginning of what the destination still retains. An event already rotated out of a folder's single backup slot, or no longer retained by the destination, cannot be recovered; it shows up as a gap below, never silently."
    )
  }
  lines.push(`Pages read: ${summary.pagesRead}`)
  lines.push(`Rows stored: ${summary.rowsStored}`)
  lines.push(`Duplicates: ${summary.duplicates}`)
  lines.push(`Edits: ${summary.edits}`)
  lines.push(`Deletions: ${summary.deletions}`)
  lines.push(`Gaps: ${summary.gaps}`)
  lines.push(`Quarantined: ${summary.quarantined}`)
  if (report.rejected) lines.push(formatRejected(report.rejected))
  if (summary.moreAvailable) lines.push('More is available — run `vinaya sync` again to continue.')
  deps.stdout(`${lines.join('\n')}\n`)
  if (summary.failure !== null) {
    deps.stderr(
      `vinaya sync: stopped early — ${summary.failure}. The progress made before the failure is kept; a second run resumes from the stored cursor.\n`
    )
  }
}

/**
 * Runs `vinaya sync` (O1–O6): resolves the destination, opens the cache,
 * runs the bounded engine, prints the summary, and returns the exit code —
 * 0 on a completed or bounded-but-progressing run, 1 when the run failed
 * part way (progress kept), 2 for a usage/configuration problem (no
 * destination, or a missing/unresolvable read credential) before anything
 * was attempted.
 */
export async function runLogSync(opts: SyncRunOptions, deps: LogSyncDeps = realLogSyncDeps()): Promise<number> {
  const repo = await deps.resolveRepo()
  const destination = await deps.resolveDestination(repo)

  if (destination.kind === 'none') {
    printReport({ ok: false, reason: destination.reason }, opts.json, deps)
    return 2
  }

  let readHeaders: Record<string, string> | undefined
  if (destination.kind === 'server') {
    const raw = deps.readHeadersRaw()
    if (raw === undefined) {
      printReport(
        {
          ok: false,
          reason:
            "no read credential is configured — set `logs.readHeaders` in vinaya.config.json to the server's read token (referenced by variable name), so `vinaya sync` can read events back."
        },
        opts.json,
        deps
      )
      return 2
    }
    if (logsCredentialMissing(raw, deps.env)) {
      const vars = credentialVarNames(raw)
      printReport(
        {
          ok: false,
          reason: `the read credential is configured, but this host holds no value for it — set ${vars.join(', ')} to the server's read token (the value is never printed).`
        },
        opts.json,
        deps
      )
      return 2
    }
    readHeaders = deps.resolveHeaders(raw)
  }

  const dir = await deps.cacheDir(repo)
  // No handle is open here: the cache is opened only below and closed in the `finally` after the sync.
  if (opts.rebuild) deps.deleteCacheFile(dir)

  const cache = deps.openCache(dir)
  const source =
    destination.kind === 'folder'
      ? deps.folderSource(destination.folder, repo)
      : deps.serverSource(destination.url, readHeaders, deps.env)

  let summary: SyncSummary
  try {
    summary = await syncSource(source, cache, { now: deps.now(), maxPages: deps.maxPages, lookback: deps.lookback })
  } finally {
    cache.close?.()
  }

  const rejected = destination.kind === 'server' ? await (source as ServerLogSource).rejected() : undefined

  printReport(
    {
      ok: true,
      rebuild: opts.rebuild,
      destination:
        destination.kind === 'folder'
          ? { kind: 'folder', folder: destination.folder }
          : { kind: 'server', url: destination.url },
      summary,
      rejected
    },
    opts.json,
    deps
  )
  return summary.failure !== null ? 1 : 0
}

export function realLogSyncDeps(): LogSyncDeps {
  const config: VinayaConfig | null = loadConfig()
  return {
    resolveRepo: () => resolveRepo(),
    resolveDestination: async (repo) => {
      const unattended = isUnattendedProcess(process.env)
      const trustAnchorConfig = unattended
        ? await withDeadline(
            loadTrustAnchorConfigAsync(undefined, { quiet: true }),
            LOG_DESTINATION_ANCHOR_DEADLINE_MS,
            null
          )
        : null
      const defaultFolder = join(await runtimeDirForRepoAsync(repo), 'logs')
      return resolveLogDestinationFrom({
        localConfig: config,
        trustAnchorConfig,
        unattended,
        env: process.env,
        defaultFolder,
        repoRoot: repoRootSync()
      })
    },
    readHeadersRaw: () => config?.logs?.readHeaders,
    resolveHeaders: (headers) => resolveLogsHeaderValues(headers, process.env),
    cacheDir: async (repo) => {
      const dir = join(await runtimeDirForRepoAsync(repo), LOGS_CACHE_DIR_NAME)
      mkdirSync(dir, { recursive: true })
      return dir
    },
    deleteCacheFile: deleteCacheFiles,
    openCache: (dir) => createSqliteCache(dir),
    folderSource: (folder, repo) => createFolderLogSource({ folderRoot: folder, repo }),
    serverSource: (url, headers, env) =>
      createServerLogSource({ fetchImpl: fetch, eventsUrl: url, readHeaders: headers, env }),
    env: process.env,
    now: () => new Date(),
    stdout: (text) => {
      process.stdout.write(text)
    },
    stderr: (text) => {
      process.stderr.write(text)
    }
  }
}
