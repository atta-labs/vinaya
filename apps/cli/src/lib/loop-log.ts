/**
 * O6 (task-run-v1 task 15) — the one text log every driver (`task run`,
 * `dev-review-loop`) tees its own role-prefixed stream to, regardless of
 * where it was launched: `~/.vinaya/loops/<owner>-<repo>/<issue>.log`. Same
 * repo-directory convention `log-sink.ts`'s `outboxPathFor` already uses
 * (`<owner>-<repo>`, or `unresolved`), a separate root (`loops/`, not
 * `outbox/`) and a plain, human-readable `.log` text file — never ndjson;
 * this is narration for `vinaya task status --follow` to tail, not a
 * structured event the forge or a check reads.
 *
 * Appends across relaunches: nothing here ever truncates or overwrites an
 * existing file, and `appendRunStartMarker` names each new process's start
 * so a file spanning several relaunches (a pause, a resume, a crash
 * restart) still reads as one continuous, delineated narration.
 */

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { GLOBAL_VINAYA_HOME } from './config.js'

export type LoopLogRepo = { owner: string; repo: string } | null

export function loopsRoot(): string {
  return join(GLOBAL_VINAYA_HOME, 'loops')
}

/** `~/.vinaya/loops/<owner>-<repo>/<issue>.log`, or `.../unresolved/<issue>.log` when `repo` could not be resolved — the same fallback `outboxPathFor` takes, never a value spliced from an unvalidated source (callers pass the same already-resolved `repo` `log()`/`dispatchRole` themselves trust). */
export function loopLogPathFor(repo: LoopLogRepo, issue: number, root: string = loopsRoot()): string {
  const dirName = repo ? `${repo.owner}-${repo.repo}` : 'unresolved'
  return join(root, dirName, `${issue}.log`)
}

/** Matches `dispatch.ts`'s own `openOutputTee` cap — past this, further lines are silently dropped rather than growing the file unbounded. Narration, not evidence: losing the tail of a very long run is an acceptable cost for never blocking or crashing the driver over disk growth. */
export const LOOP_LOG_MAX_BYTES = 8 * 1024 * 1024

/**
 * Appends one line (a trailing `\n` is added) to `path`, creating the file
 * and its parent directory as needed. Never throws — a narration write must
 * never be able to break the driver it is narrating, the same posture
 * `log-sink.ts`'s `appendLine` and `dispatch.ts`'s `openOutputTee` both
 * take. `O_NOFOLLOW` refuses to follow a symlink at `path` (the same
 * traversal/symlink hardening every other append-to-a-forge-adjacent-path
 * primitive in this codebase applies).
 */
export function appendLoopLogLine(path: string, line: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const fd = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
      0o600
    )
    try {
      const stat = fstatSync(fd)
      if (stat.isFile() && stat.size < LOOP_LOG_MAX_BYTES) {
        writeSync(fd, `${line}\n`)
      }
    } finally {
      closeSync(fd)
    }
  } catch {
    // Best-effort — see module doc comment.
  }
}

/** `[<role>] <text>` — the same prefix shape `colourAgentLine` renders to the terminal, minus the ANSI wrapping (a log file is read later, never through a TTY). */
export function appendRoleLine(path: string, role: string, text: string): void {
  for (const line of text.split('\n')) {
    appendLoopLogLine(path, `[${role}] ${line}`)
  }
}

/** Marks a fresh process's start in the log — the delineation `--follow`/a human reader needs to tell one relaunch's narration apart from the last. */
export function appendRunStartMarker(path: string, detail: { role: string; pid: number; runId?: string }): void {
  const parts = [`role=${detail.role}`, `pid=${detail.pid}`, ...(detail.runId ? [`run_id=${detail.runId}`] : [])]
  appendLoopLogLine(path, `=== run started ${new Date().toISOString()} ${parts.join(' ')} ===`)
}

export type FollowLoopLogDeps = {
  /** Injectable so a test can tick this forward without a real wall-clock wait. */
  sleep: (ms: number) => Promise<void>
  write: (chunk: Buffer) => void
  /** `true` ends the follow loop — production never sets this (it runs until the process is killed, `Ctrl-C`); a test supplies one that flips true after a bounded number of ticks. */
  shouldStop: () => boolean
  pollIntervalMs: number
}

const defaultFollowLoopLogDeps: FollowLoopLogDeps = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  write: (chunk) => {
    process.stdout.write(chunk)
  },
  shouldStop: () => false,
  pollIntervalMs: 500
}

/**
 * `vinaya task status --follow`'s own read (O6) — `tail -f` semantics: prints
 * whatever `path` already holds, then polls for growth and prints only the
 * new bytes, indefinitely (until `deps.shouldStop()`, which production never
 * sets). A file that shrinks (a future rotation) is treated as restarted
 * from byte 0, never as an error. A file that does not exist yet (no driver
 * has ever run for this task) is simply polled until it appears — no
 * refusal, no special first-run message: the wait itself is the correct
 * "nothing to show yet" state.
 */
export async function followLoopLog(path: string, overrides: Partial<FollowLoopLogDeps> = {}): Promise<void> {
  const deps: FollowLoopLogDeps = { ...defaultFollowLoopLogDeps, ...overrides }
  let lastSize = 0
  if (existsSync(path)) {
    const buf = readFileSync(path)
    deps.write(buf)
    lastSize = buf.length
  }
  while (!deps.shouldStop()) {
    await deps.sleep(deps.pollIntervalMs)
    if (!existsSync(path)) continue
    const stat = statSync(path)
    if (stat.size < lastSize) lastSize = 0
    if (stat.size > lastSize) {
      const fd = openSync(path, 'r')
      try {
        const buf = Buffer.alloc(stat.size - lastSize)
        readSync(fd, buf, 0, buf.length, lastSize)
        deps.write(buf)
        lastSize = stat.size
      } finally {
        closeSync(fd)
      }
    }
  }
}
