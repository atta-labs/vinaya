/**
 * O6 — the one text log every driver (`task run`,
 * `dev-review-loop`) tees its own role-prefixed stream to, regardless of
 * where it was launched: the task's own `output/driver.log`
 * (`run-paths.ts`). A plain, human-readable `.log` text file — never
 * ndjson; this is narration for `vinaya task status --follow` to tail, not
 * a structured event the forge or a check reads, which is why it sits in
 * `output/` beside the raw agent output rather than anywhere near the
 * telemetry outbox.
 *
 * It used to live in a `loops/<owner>-<repo>/<issue>.log` tree of its own,
 * keyed by repo and issue; the task folder already carries both, so the
 * filename no longer has to.
 *
 * Appends across relaunches: nothing here ever truncates or overwrites an
 * existing file, and `appendRunStartMarker` names each new process's start
 * so a file spanning several relaunches (a pause, a resume, a crash
 * restart) still reads as one continuous, delineated narration.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { redact } from '../redact'
import { appendLoopLogLine, LOOP_LOG_MAX_BYTES } from './loop-log-append.js'
import type { NarrationKind } from './narration'
import { homedir } from 'node:os'
import { runPath, runtimeDirForThisRepo } from '../../run-paths.js'
import {
  type AgentLineMark,
  type AgentLineParts,
  formatAgentLine,
  formatLineMeta
} from '../../adapters/agents/agent-line.js'

export type LoopLogRepo = { owner: string; repo: string } | null

/** The runtime directory this driver log lives under — the same one every other file this task's run writes resolves through. */
export function loopsRoot(): string {
  return runtimeDirForThisRepo()
}

/**
 * `<runtimeDir>/tasks-execution/<issue>/output/driver.log`.
 *
 * `repo` is no longer part of the path: the runtime directory itself is
 * already per-repository (`run-paths.ts`'s `defaultRuntimeDir` keeps the
 * segment; a configured one belongs to one repo), so two repositories
 * sharing an Issue number still get two files. The parameter stays on the
 * signature because callers pass the repo they already resolved and
 * dropping it would ripple through the status command this task's Surface
 * excludes.
 */
export function loopLogPathFor(_repo: LoopLogRepo, issue: number, root: string = loopsRoot()): string {
  return runPath(root, issue, { area: 'output', file: 'driver.log' })
}

export { appendLoopLogLine, LOOP_LOG_MAX_BYTES }

/**
 * One agent record into the driver log: its primary line, then each detail as its own `·` record. `meta` adds, after
 * the ISO time, the action's call identifier on the primary line and a `command` mark on each detail that is the
 * shell command; every word of either record is what it would be without it.
 */
export function appendRoleLine(
  path: string,
  role: string,
  text: string,
  details: readonly string[] = [],
  mark: AgentLineMark = 'working',
  meta: Pick<AgentLineParts, 'callId' | 'commandFrom'> = {}
): void {
  appendLoopLogLine(
    path,
    formatAgentLine(role, redact(text, homedir()), {
      log: true,
      unicode: false,
      mark,
      ...(meta.callId !== undefined ? { meta: { call: meta.callId } } : {})
    })
  )
  details.forEach((detail, index) => {
    if (!detail) return
    const command = meta.commandFrom !== undefined && index >= meta.commandFrom
    appendLoopLogLine(
      path,
      `${new Date().toISOString()}${command ? formatLineMeta({ command: true }) : ''}  · ${redact(detail, homedir())}`
    )
  })
}

/** Marks a process's start in the log — the delineation `--follow`/a human reader needs to tell one relaunch's narration apart from the last. A first start reads "run started"; a relaunch of a task that already ran reads "Resumed". */
export function appendRunStartMarker(
  path: string,
  detail: { role: string; pid: number; runId?: string; resumed?: boolean }
): void {
  appendLoopLogLine(
    path,
    formatAgentLine(detail.role, detail.resumed ? 'Resumed' : 'run started', {
      log: true,
      unicode: false,
      mark: 'round'
    })
  )
}

export const marksByKind: Record<NarrationKind, AgentLineMark> = {
  starting: 'round',
  working: 'working',
  done: 'done',
  failed: 'failed',
  waiting: 'waiting',
  paused: 'waiting',
  blocked: 'waiting',
  information: 'working'
}

/**
 * One driver line, through the same renderer the agents' lines use: into the
 * loop log with a full timestamp, and onto stderr with a clock time. The line
 * carries no process id and no run id; those stay in the file name and in the
 * verbose detail.
 */
export function appendDriverLine(path: string, words: string, mark: AgentLineMark = 'working'): void {
  const text = redact(words, homedir())
  appendLoopLogLine(path, formatAgentLine('dev-review-loop', text, { log: true, unicode: false, mark }))
  console.error(formatAgentLine('dev-review-loop', text, { mark, unicode: Boolean(process.stderr.isTTY) }))
}

export type FollowLoopLogDeps = {
  /** Injectable so a test can tick this forward without a real wall-clock wait. */
  sleep: (ms: number) => Promise<void>
  write: (chunk: Buffer) => void
  /** `true` ends the follow loop — production never sets this (it runs until the process is killed, `Ctrl-C`); a test supplies one that flips true after a bounded number of ticks. */
  shouldStop: () => boolean
  pollIntervalMs: number
  /** Receives what the file already holds when the follow starts; absent, `write` does. */
  writeBacklog?: (chunk: Buffer) => void
  /** Called once per poll, after any new bytes were written: the follow view's clock for its still-in-stage lines. */
  tick?: () => void
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
 * `vinaya task status --follow`'s own read — `tail -f` semantics: prints
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
    ;(deps.writeBacklog ?? deps.write)(buf)
    lastSize = buf.length
  }
  while (!deps.shouldStop()) {
    await deps.sleep(deps.pollIntervalMs)
    readGrowth()
    deps.tick?.()
  }

  function readGrowth(): void {
    if (!existsSync(path)) return
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
