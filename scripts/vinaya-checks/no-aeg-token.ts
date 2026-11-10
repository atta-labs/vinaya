#!/usr/bin/env bun
/**
 * atta-labs/no-aeg-token — a custom vinaya check that ratchets the retired
 * three-letter prefix out of this repository.
 *
 * Contract: emit one JSON line on stderr per finding via `emitCheckError`,
 * then exit 0 (pass) or 1 (findings or an undecidable state). The RUNNER
 * enforces the timeout. This file is standalone (no import from the vinaya
 * CLI's own source tree).
 *
 * What it counts: for every file `git ls-files` lists, the case-insensitive
 * occurrences of the token in the file's path plus in its text content —
 * inside longer identifiers too (`loadAegDocs`, `AEG_REPO`). Binary files
 * (a NUL byte in their first 8000 bytes) and anything that is not a regular
 * file contribute no content count. Untracked files are never read.
 * Occurrences inside the guard's own name (its check id and its file names)
 * are removed before counting, so registering the guard costs no budget.
 *
 * What it compares: the data file beside this script holds an `allowlist` of
 * globs, each with its reason, whose files are never counted, and a
 * `baseline` of per-file counts for everything else. A file counting more
 * than its baseline — or a file with no baseline row counting any — fails.
 * A file counting less passes, and the check prints the lower number to
 * record; a higher stale baseline is never an error, so a task that cleans a
 * file never has to edit the data file.
 */

import { execFileSync } from 'node:child_process'
import { closeSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { join } from 'node:path'

type CheckError = {
  schema: 1
  check: string
  severity: 'error' | 'warning'
  message: string
  agent_recovery_prompt: string
  file?: string
  line?: number
}

export type AllowlistEntry = { glob: string; reason: string }
export type GuardData = { allowlist: AllowlistEntry[]; baseline: Record<string, number> }

/** A file above its allowed count; `allowed` is 0 for a file with no baseline row. */
export type Excess = { file: string; count: number; allowed: number }
/** A file below its baseline row; `count` is the number to record (0 means drop the row). */
export type Lowered = { file: string; count: number; allowed: number }
export type Outcome = { excess: Excess[]; lowered: Lowered[]; counted: number }

const CHECK_NAME = 'atta-labs/no-aeg-token'
export const DATA_FILE = 'scripts/vinaya-checks/no-aeg-token.baseline.json'

const TOKEN_RE = /aeg/gi
/** The guard's own name, as it appears in its check id, its file names and its changeset. */
const GUARD_NAME_RE = /no-aeg-token/gi
const BINARY_SNIFF_BYTES = 8000

class Undecidable extends Error {
  constructor(
    message: string,
    readonly recovery: string,
    readonly file?: string
  ) {
    super(message)
  }
}

function emitCheckError(error: CheckError): void {
  process.stderr.write(`${JSON.stringify(error)}\n`)
}

/** Case-insensitive occurrences of the token, with the guard's own name removed first. */
export function countToken(text: string): number {
  return text.replace(GUARD_NAME_RE, '').match(TOKEN_RE)?.length ?? 0
}

export function isBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, BINARY_SNIFF_BYTES)
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true
  return false
}

/** Validate the data file's shape; throws `Undecidable` naming what is wrong. */
export function parseGuardData(text: string, file = DATA_FILE): GuardData {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Undecidable(
      `${file} is not valid JSON: ${(error as Error).message}`,
      `Fix the JSON in ${file}, then re-run this check.`,
      file
    )
  }
  const doc = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const allowlist = doc.allowlist
  const baseline = doc.baseline
  const allowlistOk =
    Array.isArray(allowlist) &&
    allowlist.every(
      (e) =>
        e &&
        typeof e === 'object' &&
        typeof (e as AllowlistEntry).glob === 'string' &&
        (e as AllowlistEntry).glob.trim() !== '' &&
        typeof (e as AllowlistEntry).reason === 'string' &&
        (e as AllowlistEntry).reason.trim() !== ''
    )
  const baselineOk =
    !!baseline &&
    typeof baseline === 'object' &&
    !Array.isArray(baseline) &&
    Object.values(baseline).every((n) => Number.isInteger(n) && (n as number) >= 0)
  if (!allowlistOk || !baselineOk) {
    throw new Undecidable(
      `${file} must hold an \`allowlist\` of { glob, reason } entries, each non-empty, and a \`baseline\` object of non-negative whole counts.`,
      `Restore the shape of ${file}, then re-run this check.`,
      file
    )
  }
  return { allowlist: allowlist as AllowlistEntry[], baseline: baseline as Record<string, number> }
}

export function allowlisted(file: string, allowlist: AllowlistEntry[]): boolean {
  return allowlist.some((entry) => new Bun.Glob(entry.glob).match(file))
}

/** The token count of one tracked file: its path, plus its content when it is a regular text file. */
export function countFile(root: string, file: string): number {
  let count = countToken(file)
  const absolute = join(root, file)
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(absolute)
  } catch {
    // Tracked but deleted in the working tree: nothing left to read.
    return count
  }
  if (!stat.isFile()) return count
  const fd = openSync(absolute, 'r')
  try {
    const head = new Uint8Array(BINARY_SNIFF_BYTES)
    const read = readSync(fd, head, 0, BINARY_SNIFF_BYTES, 0)
    if (isBinary(head.subarray(0, read))) return count
  } finally {
    closeSync(fd)
  }
  count += countToken(readFileSync(absolute, 'utf8'))
  return count
}

/** Compare each tracked, non-allowlisted file's count with its baseline row. */
export function evaluate(files: string[], data: GuardData, count: (file: string) => number): Outcome {
  const excess: Excess[] = []
  const lowered: Lowered[] = []
  const seen = new Set<string>()
  let counted = 0
  for (const file of files) {
    if (allowlisted(file, data.allowlist)) continue
    seen.add(file)
    const n = count(file)
    counted += n
    const allowed = data.baseline[file] ?? 0
    if (n > allowed) excess.push({ file, count: n, allowed })
    else if (n < allowed) lowered.push({ file, count: n, allowed })
  }
  // A baseline row whose file is gone (or now allowlisted) records a count that fell to nothing.
  for (const [file, allowed] of Object.entries(data.baseline)) {
    if (!seen.has(file) && allowed > 0) lowered.push({ file, count: 0, allowed })
  }
  lowered.sort((a, b) => a.file.localeCompare(b.file))
  return { excess, lowered, counted }
}

export function trackedFiles(root: string): string[] {
  let out: string
  try {
    out = execFileSync('git', ['ls-files', '-z'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch {
    throw new Undecidable(
      '`git ls-files` failed — the tracked files could not be listed.',
      'Run `git ls-files` by hand to see the real error, fix the cause, and re-run this check.'
    )
  }
  return out.split('\0').filter(Boolean)
}

/** Run the whole check over the repository at `root` with the given data. */
export function checkRepository(root: string, data: GuardData): Outcome {
  return evaluate(trackedFiles(root), data, (file) => countFile(root, file))
}

function repositoryRoot(): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    throw new Undecidable(
      'Not inside a git repository — the tracked files could not be listed.',
      'Run this check from inside the repository checkout.'
    )
  }
}

function main(): void {
  let outcome: Outcome
  try {
    const root = repositoryRoot()
    let text: string
    try {
      text = readFileSync(join(root, DATA_FILE), 'utf8')
    } catch {
      throw new Undecidable(
        `${DATA_FILE} is missing.`,
        `Restore ${DATA_FILE} from the main branch, then re-run this check.`,
        DATA_FILE
      )
    }
    outcome = checkRepository(root, parseGuardData(text))
  } catch (error) {
    if (!(error instanceof Undecidable)) throw error
    emitCheckError({
      schema: 1,
      check: CHECK_NAME,
      severity: 'error',
      message: error.message,
      agent_recovery_prompt: error.recovery,
      ...(error.file ? { file: error.file } : {})
    })
    process.exit(1)
  }

  for (const row of outcome.lowered) {
    process.stdout.write(
      row.count === 0
        ? `${CHECK_NAME}: ${row.file} fell from ${row.allowed} to 0 — drop its row from ${DATA_FILE}.\n`
        : `${CHECK_NAME}: ${row.file} fell from ${row.allowed} to ${row.count} — record "${row.file}": ${row.count} in ${DATA_FILE}.\n`
    )
  }

  if (outcome.excess.length === 0) {
    process.stdout.write(
      `${CHECK_NAME}: no file holds the token more times than its baseline allows (${outcome.counted} counted outside the allowlist).\n`
    )
    process.exit(0)
  }

  for (const row of outcome.excess) {
    emitCheckError({
      schema: 1,
      check: CHECK_NAME,
      severity: 'error',
      message: `${row.file} holds the retired token ${row.count} time(s) in its path and content; its allowed count is ${row.allowed}.`,
      agent_recovery_prompt: `Remove the added occurrences (any letter case, also inside identifiers) from ${row.file} so it holds at most ${row.allowed}. Never raise its row in ${DATA_FILE}; the count may only fall.`,
      file: row.file
    })
  }
  process.exit(1)
}

if (import.meta.main) main()
