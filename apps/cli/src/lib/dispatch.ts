/**
 * `dispatchRole` — the Vinaya Log's `dispatch` family chokepoint (Linear
 * "Tech spec — The Vinaya Log" rev 4, §8, §20; `apps/cli/specs/log.md`).
 * Starts one of three vendors' headless CLI as a child process with
 * attribution (`VINAYA_RUN_ID`/`VINAYA_ROLE`/`VINAYA_TASK`/`VINAYA_ROUND`) set
 * on its environment only — never on this process's own `process.env` — and
 * records `dispatched` / `outcome_received` / `dispatch_failed` through
 * `log()`, using the SAME `run_id` the child's own later `vinaya` calls (its
 * Stop hook, a nested dispatch inside a loop) will carry, so a report joins
 * them.
 *
 * Vendor headless flags were confirmed against each binary's own `--help` on
 * the authoring machine, not guessed:
 *
 *   - `claude -p --output-format json` — print mode, prompt via stdin (no
 *     positional argument), a single JSON object on stdout whose
 *     `usage.input_tokens`/`usage.output_tokens` matches the shape
 *     `claude-stop-hook-emitter.ts`'s transcript-parsing precedent expects.
 *     Confirmed live: a real `claude -p --output-format json` run's stdout
 *     carried exactly that shape on this machine — no `usage: null` fallback
 *     was needed.
 *   - `codex exec --json -` — the trailing `-` is Codex's own documented
 *     stdin sentinel (never the prompt text on argv), one JSONL event per
 *     line. Confirmed live: the terminal `turn.completed` event carries
 *     `usage: { input_tokens, output_tokens, ... }` — the same field names
 *     as Claude's, so it is parsed the same way rather than left `null`.
 *   - `gemini -p '' --output-format json --skip-trust` — `-p ''` triggers
 *     headless mode while leaving the real prompt to arrive on stdin (Gemini
 *     appends stdin to whatever `-p` carries); `--skip-trust` is Gemini's own
 *     documented flag for unattended/automated environments, confirmed by its
 *     own workspace-trust refusal message rather than guessed. Confirmed
 *     live: Gemini's stdout is a `{ session_id, response, stats: { models:
 *     { <model>: { tokens: {...} } } } }` shape — per-model token buckets,
 *     never a single `{ input, output }` pair. That does not match this
 *     family's `usage` shape and is never guessed into one; `usage: null` is
 *     recorded for every Gemini dispatch until a real reader exists for its
 *     own shape.
 *
 * **Known gap, disclosed rather than silently worked around (see this task's
 * PR body): `DispatchOutcomeSchema` (`packages/aeg-core/src/log/schema.ts`,
 * out of this task's surface) has no member representing "the process exited
 * cleanly with no specific, identifiable forge outcome" — every one of its
 * seven variants requires role/action-specific identifying data (a PR
 * number, a head sha, a comment id) this generic launcher cannot honestly
 * produce from an exit code and a vendor's own usage blob alone, and
 * fabricating one would violate the log's own stated invariant ("a
 * fabricated zero is not" a legal value — tech spec §5.1). Until the schema
 * gains a generic variant, a successful dispatch's `outcome_received` line
 * carries `{ type: 'plan', issues: [] }` — the one member satisfiable with no
 * invented identifier (an empty list asserts nothing false) — as an
 * explicitly labeled placeholder, never to be read as "a plan was cut."**
 */

import { randomUUID, createHash } from 'node:crypto'
import { accessSync, constants as fsConstants, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { chmodSync, createWriteStream } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { resolveRepo } from '@attalabs/aeg-forge-state'
import { homedir } from 'node:os'
import { redact } from '@attalabs/aeg-core'
import type { Role } from '@attalabs/aeg-core'
import { createLogSink, outboxPathFor } from './log-sink.js'
import { loadConfig, GLOBAL_VINAYA_HOME } from './config.js'
import { join } from 'node:path'

export const AGENT_VENDOR_NAMES = ['claude', 'codex', 'gemini'] as const
export type AgentVendor = (typeof AGENT_VENDOR_NAMES)[number]

export function isAgentVendor(value: string): value is AgentVendor {
  return (AGENT_VENDOR_NAMES as readonly string[]).includes(value)
}

export type DispatchOpts = {
  task?: number
  pr?: number
  round?: number
  /** The vendor's own session/thread identifier from a prior dispatch's `resumeId`, to resume that exact session instead of starting fresh. */
  resumeId?: string
  /**
   * The prompt's source file path — required by the brief's stated shape.
   * Unused by any of the three vendors' own invocation today (all three
   * accept the prompt on stdin, confirmed above); kept for a future vendor
   * whose headless mode needs a real file argument instead, and so the
   * caller's `--prompt-file` value has one obvious place to travel through.
   */
  promptFile: string
}

export type DispatchFailureReason = 'timeout' | 'crash' | 'refused'

export type DispatchHandle = {
  exitCode: number | null
  durationMs: number
  usage: { input: number; output: number } | null
  /** The vendor's own session/thread identifier, parsed from a successful dispatch's stdout — `null` on any failure path or an unparseable shape. */
  resumeId: string | null
  timedOut: boolean
  /** Set only when the dispatch did not reach a normal `outcome_received`. */
  failureReason?: DispatchFailureReason
}

/**
 * Four hours — matches `dispatch.timeoutMs`'s documented default in
 * `VinayaConfigSchema`. Raised from the original one hour (O4, Issue #450):
 * a real dispatched agent turn was found live still working past the
 * thirty-minute mark, and a one-hour ceiling gives too little margin before
 * a genuinely working agent is killed mid-task. The ceiling itself stays —
 * an unbounded dispatch is how a hung agent runs forever unnoticed — just
 * long enough now that reaching it is a real signal, not routine noise.
 */
export const DEFAULT_TIMEOUT_MS = 14_400_000

/** Grace window between `SIGTERM` and `SIGKILL` once the ceiling fires. */
const SIGKILL_GRACE_MS = 5_000

/** How often a still-running dispatch announces that it is alive (O1). */
export const HEARTBEAT_INTERVAL_MS = 60_000

/**
 * How long before the deadline the approaching-timeout warning fires (O3).
 * Capped at 5 minutes so a short `dispatch.timeoutMs` (e.g. a test's 2500ms)
 * still gets a warning inside its own ceiling rather than one scheduled past
 * it and never firing.
 */
export function timeoutWarningLeadMs(timeoutMs: number): number {
  return Math.min(300_000, Math.floor(timeoutMs / 2))
}

/**
 * Tees the child's raw stdout/stderr bytes to a machine-local file so a
 * human can read what the agent is doing while it is still running (O2) —
 * never inside the repository tree (a dispatch's own worktree could be
 * mid-rebase or reviewed by someone else) and never a replacement for the
 * in-memory `stdoutBuf` the exit handler parses for outcome data. Failure to
 * create the file (an unwritable home, a full disk) degrades to a silent
 * no-op tee, matching this module's "never throws" posture — losing the
 * human-readable copy is not a reason to fail the dispatch itself.
 */
/** Hard ceiling on one run's teed output. A four-hour run's stdout is unbounded otherwise. */
export const MAX_TEE_BYTES = 8 * 1024 * 1024

/**
 * A run's own output, teed to a file a human can read WHILE the run is alive.
 *
 * Three properties are load-bearing, and all three are security properties —
 * this file persists the full stdout AND stderr of a credentialed subprocess
 * that runs arbitrary shell commands mid-task (`env`, reading a `.env`,
 * `gh auth token`), so its raw bytes are exactly the bytes that must never
 * reach disk unscrubbed:
 *
 *  1. **Redacted.** Every chunk goes through `@attalabs/aeg-core`'s `redact` —
 *     the same function every outbox line already passes through — so a
 *     GitHub token or an `Authorization: Bearer` value is replaced before it
 *     is written, and an absolute path under the home directory is rewritten
 *     to `~/…`. Chunk boundaries can split a token, so a tail of the previous
 *     chunk is carried and re-scanned rather than trusting chunk alignment.
 *  2. **Owner-only, and inside its own directory.** The file is created 0600
 *     in a 0700 directory, and `effectId` is refused unless it is a plain
 *     identifier — a caller passing a traversal string gets no file at all,
 *     rather than a file written wherever the string resolved to.
 *  3. **Bounded, and never fatal.** Writing stops at `MAX_TEE_BYTES`, and a
 *     write-time failure (a full disk mid-run) degrades this to a no-op
 *     instead of throwing: an async `stream.write` error would otherwise be
 *     unhandled and take down the dispatch this tee only observes.
 */
export function openOutputTee(effectId: string): {
  write: (chunk: Buffer) => void
  end: () => void
  path: string | null
} {
  const inert = { write: () => {}, end: () => {}, path: null }
  // Refuse anything that is not a plain id BEFORE it reaches `join`, so a
  // traversal string can never resolve outside the intended directory.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(effectId)) return inert
  try {
    const dir = join(GLOBAL_VINAYA_HOME, 'dispatch-output')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // `mkdirSync`'s mode applies only when it creates the directory — an
    // existing one keeps whatever permissions it already had, which for a
    // directory created before this hardening is world-readable.
    chmodSync(dir, 0o700)
    const path = join(dir, `${effectId}.log`)
    const stream = createWriteStream(path, { flags: 'a', mode: 0o600 })
    let broken = false
    let written = 0
    let carry = ''
    // A stream error is asynchronous; without this listener it is an
    // unhandled 'error' event, which is fatal to the process.
    stream.on('error', () => {
      broken = true
    })
    const home = homedir()
    return {
      write: (chunk: Buffer) => {
        if (broken || written >= MAX_TEE_BYTES) return
        try {
          const text = carry + chunk.toString('utf8')
          // Keep a tail unwritten so a secret straddling two chunks is still
          // matched whole on the next pass; flush it at `end`.
          const cut = Math.max(0, text.length - 256)
          const emit = redact(text.slice(0, cut), home)
          carry = text.slice(cut)
          if (emit.length === 0) return
          written += Buffer.byteLength(emit)
          stream.write(emit)
        } catch {
          broken = true
        }
      },
      end: () => {
        try {
          if (!broken && carry.length > 0) stream.write(redact(carry, home))
          stream.end()
        } catch {
          broken = true
        }
      },
      path
    }
  } catch {
    return inert
  }
}

type UsageParser = (stdout: string) => { input: number; output: number } | null

export function parseClaudeUsage(stdout: string): { input: number; output: number } | null {
  // `stream-json` prints one event per line and the terminal event carries
  // `usage`; scanned from the end for the same reason `parseCodexUsage` is.
  // A single whole-blob `json` payload is one line, so it parses here too —
  // this reads both forms rather than trading one for the other.
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i] as string) as {
        usage?: { input_tokens?: unknown; output_tokens?: unknown }
      }
      const u = obj.usage
      if (u && typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number') {
        return { input: u.input_tokens, output: u.output_tokens }
      }
    } catch {
      // not a JSON line — keep scanning backwards, never a guessed shape
    }
  }
  return null
}

/** Codex's `--json` mode prints one event per line; the terminal `turn.completed` event carries `usage`. Scanned from the end since it is always the last event of a successful turn. */
function parseCodexUsage(stdout: string): { input: number; output: number } | null {
  const lines = stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = (lines[i] ?? '').trim()
    if (!raw) continue
    try {
      const obj = JSON.parse(raw) as {
        type?: unknown
        usage?: { input_tokens?: unknown; output_tokens?: unknown }
      }
      if (obj.type === 'turn.completed' && obj.usage) {
        const u = obj.usage
        if (typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number') {
          return { input: u.input_tokens, output: u.output_tokens }
        }
      }
    } catch {
      // not a JSON line — Codex's own stdout is JSONL only, but never trust it blindly
    }
  }
  return null
}

/** Gemini's own JSON stdout is a per-model `stats.models.*.tokens` breakdown, not a single `{ input, output }` pair (confirmed live, module doc above) — never guessed into one. */
export function parseGeminiUsage(stdout: string): { input: number; output: number } | null {
  // The terminal `result` event's `stats` carries the counts; scanned from the
  // end for the same reason the other two parsers are. This previously always
  // returned null, so a gemini dispatch reported no usage at all.
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i] as string) as {
        stats?: { input_tokens?: unknown; output_tokens?: unknown }
      }
      const st = obj.stats
      if (st && typeof st.input_tokens === 'number' && typeof st.output_tokens === 'number') {
        return { input: st.input_tokens, output: st.output_tokens }
      }
    } catch {
      // not a JSON line — keep scanning backwards
    }
  }
  return null
}

export function parseClaudeResumeId(stdout: string): string | null {
  // Same two-form tolerance as `parseClaudeUsage`: the terminal event of a
  // `stream-json` run carries `session_id`, and a whole-blob `json` payload
  // is simply the single line.
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i] as string) as { session_id?: unknown }
      if (typeof obj.session_id === 'string') return obj.session_id
    } catch {
      // not a JSON line — keep scanning backwards
    }
  }
  return null
}

function parseCodexResumeId(stdout: string): string | null {
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as { type?: unknown; thread_id?: unknown }
      if (obj.type === 'thread.started' && typeof obj.thread_id === 'string') return obj.thread_id
    } catch {
      // not a JSON line — same defensive posture as parseCodexUsage
    }
  }
  return null
}

function parseGeminiResumeId(stdout: string): string | null {
  try {
    const obj = JSON.parse(stdout) as { session_id?: unknown }
    return typeof obj.session_id === 'string' ? obj.session_id : null
  } catch {
    return null
  }
}

/**
 * Where a successful dispatch's own vendor resume identifier is durably
 * recorded, keyed by role + vendor + the task/PR this run was attributed to
 * — so a later, separate `vinaya dispatch` invocation (a different
 * terminal, possibly days later) can find the id needed to answer a stopped
 * agent through `--resume <id> --prompt-file <answer>`, instead of the id
 * living only in the window that printed it (O8, Issue #454; Principal
 * ruling: answer through the resume path that already exists — `--resume`/
 * `--prompt-file` are already parsed — never a live channel held open on a
 * blocking read).
 *
 * Deliberately NOT the Vinaya Log's own `dispatch` family:
 * `DispatchOutcomeSchema` (`packages/aeg-core/src/log/schema.ts`) has no
 * member for "here is a vendor session id" — every variant names a specific
 * forge outcome (`pr_opened`, `verdict`, …) — and the schema, `.strict()`
 * throughout, is out of this task's own surface (see this file's module doc
 * on the `outcome_received` placeholder). A second, narrower durable file —
 * machine-local, the same `~/.vinaya/` home `dispatch-output`'s tee already
 * uses — is the destination that needs no schema change.
 */
function resumeRecordPathFor(role: Role, agent: AgentVendor, task?: number, pr?: number): string {
  const scope = task !== undefined ? `issue${task}` : pr !== undefined ? `pr${pr}` : 'unscoped'
  return join(GLOBAL_VINAYA_HOME, 'dispatch-resume', `${role}-${agent}-${scope}.json`)
}

type ResumeRecord = {
  resumeId: string
  role: Role
  agent: AgentVendor
  task: number | null
  pr: number | null
  round: number | null
  effectId: string
  capturedAt: string
}

/**
 * Overwrites the one record for this role+vendor+scope with the latest
 * resume id — only the most recently produced session is ever the one worth
 * resuming, so there is nothing to append to. Never throws, matching this
 * module's "never throws" posture: an unwritable home degrades to no durable
 * record, the same failure mode `openOutputTee` already accepts for its own
 * file.
 */
function recordResumeState(record: ResumeRecord): string | null {
  try {
    const dir = join(GLOBAL_VINAYA_HOME, 'dispatch-resume')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    const path = resumeRecordPathFor(record.role, record.agent, record.task ?? undefined, record.pr ?? undefined)
    writeFileSync(path, JSON.stringify(record, null, 2), { mode: 0o600 })
    return path
  } catch {
    return null
  }
}

type VendorSpec = {
  binary: string
  args: readonly string[]
  resumeArgs: (id: string) => string[]
  parseUsage: UsageParser
  parseResumeId: (stdout: string) => string | null
  /** One line of this vendor's own stream, rendered for a human, or `null` for an event worth nothing on screen. */
  renderEvent: (obj: Record<string, unknown>) => string | null
}

/**
 * One line of the vendor's own stream, rendered for a human, or `null` for an
 * event that carries nothing worth showing.
 *
 * Vendor-agnostic by construction: each vendor already declares how to read
 * its own structured channel (`parseUsage`, `parseResumeId`), and this is the
 * third member of that same family. The operator sees the agent working
 * whichever vendor was dispatched, and no vendor's format leaks past its own
 * renderer.
 *
 * The cause this exists for is NOT vendor-specific: the child is spawned onto
 * pipes, so no vendor sees a TTY and every one of them falls back to a
 * buffered batch mode that prints nothing until it exits. Requesting the
 * streaming form of the structured channel is what restores the view without
 * a pseudo-terminal — which this bundled CLI cannot carry (`node-pty` is a
 * native addon) and which would cost `parseUsage` the structured figures it
 * reads.
 */
export function renderClaudeEvent(obj: Record<string, unknown>): string | null {
  const type = obj.type
  if (type === 'assistant' || type === 'user') {
    const msg = obj.message as { content?: unknown } | undefined
    const content = Array.isArray(msg?.content) ? (msg?.content as Record<string, unknown>[]) : []
    const out: string[] = []
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
        out.push(block.text.trim())
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        const input = block.input as Record<string, unknown> | undefined
        // The one field that says WHICH thing the tool acted on, when there
        // is one — a path, a command, a pattern. Never the whole payload:
        // a file write's `content` is the file, and belongs in the tee.
        const subject =
          (typeof input?.file_path === 'string' && input.file_path) ||
          (typeof input?.command === 'string' && input.command) ||
          (typeof input?.pattern === 'string' && input.pattern) ||
          (typeof input?.path === 'string' && input.path) ||
          ''
        const trimmed = subject.length > 120 ? `${subject.slice(0, 117)}...` : subject
        out.push(trimmed ? `⚙ ${block.name}: ${trimmed}` : `⚙ ${block.name}`)
      }
      // Every other block kind — a tool result above all — renders nothing:
      // results are the bulk of a run and the tee already holds them verbatim.
    }
    return out.length > 0 ? out.join('\n') : null
  }
  if (type === 'system' && obj.subtype === 'init') return '⏵ session started'
  if (typeof obj.stop_reason === 'string') return `⏹ ${obj.stop_reason}`
  return null
}

/** Codex prints one event per line under `--json`; its item text is the human-facing part. */
export function renderCodexEvent(obj: Record<string, unknown>): string | null {
  const type = typeof obj.type === 'string' ? obj.type : ''
  if (type.endsWith('.completed') || type.endsWith('.started')) return `⏵ ${type}`
  const item = obj.item as { text?: unknown } | undefined
  return typeof item?.text === 'string' && item.text.trim().length > 0 ? item.text.trim() : null
}

/** Gemini's streaming shape is not yet verified against a real run; show nothing rather than guess a field. */
export function renderGeminiEvent(obj: Record<string, unknown>): string | null {
  if (obj.type === 'init') return '⏵ session started'
  if (obj.type === 'message' && obj.role === 'assistant') {
    const text = typeof obj.content === 'string' ? obj.content.trim() : ''
    return text.length > 0 ? text : null
  }
  if (obj.type === 'result') {
    const status = typeof obj.status === 'string' ? obj.status : 'finished'
    return `⏹ ${status}`
  }
  return null
}

const VENDOR_TABLE: Record<AgentVendor, VendorSpec> = {
  claude: {
    binary: 'claude',
    // `stream-json` is the SAME structured channel as `json`, emitted one
    // event per line as it happens instead of one blob at exit — so the
    // operator sees the work and `parseUsage` still reads real figures.
    // `--verbose` is required by the CLI whenever `-p` is paired with
    // `stream-json`; without it the flag combination is refused.
    args: ['-p', '--verbose', '--output-format', 'stream-json'],
    resumeArgs: (id) => ['-p', '-r', id, '--verbose', '--output-format', 'stream-json'],
    parseUsage: parseClaudeUsage,
    parseResumeId: parseClaudeResumeId,
    renderEvent: renderClaudeEvent
  },
  codex: {
    binary: 'codex',
    args: ['exec', '--json', '-'],
    resumeArgs: (id) => ['exec', 'resume', id, '--json', '-'],
    parseUsage: parseCodexUsage,
    parseResumeId: parseCodexResumeId,
    renderEvent: renderCodexEvent
  },
  gemini: {
    binary: 'gemini',
    // Verified against a real run, not assumed (the Issue's own trap): gemini
    // emits `init`, then a `message` per turn carrying `role`/`content`, then
    // a terminal `result` whose `stats` holds the token counts.
    args: ['-p', '', '--output-format', 'stream-json', '--skip-trust'],
    resumeArgs: (id) => ['-p', '', '--resume', id, '--output-format', 'stream-json', '--skip-trust'],
    parseUsage: parseGeminiUsage,
    parseResumeId: parseGeminiResumeId,
    renderEvent: renderGeminiEvent
  }
}

/**
 * Resolves the vendor binary to an absolute path, or `null` when it is
 * absent from `PATH` (`which` exits non-zero) or present but not executable
 * (`accessSync` throws) — both refused by name before any spawn attempt, and
 * before the `dispatched` log line (O1; Part 1 defeat cases).
 */
function resolveExecutable(binary: string): string | null {
  try {
    const path = execFileSync('which', [binary], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    if (!path) return null
    accessSync(path, fsConstants.X_OK)
    return path
  } catch {
    return null
  }
}

function promptHashOf(prompt: string): string {
  return `sha256:${createHash('sha256').update(prompt).digest('hex')}`
}

/**
 * `log()` is fire-and-forget (`log-sink.ts`'s own `.then()` chain, no
 * returned promise — task 1's shipped, frozen interface). Without waiting
 * for a line to actually land, a caller that exits promptly after a failed
 * dispatch (`dispatchCommand`'s own `process.exit(1)`) can abandon the write
 * mid-flight, silently losing the very `dispatch_failed` line O2 requires.
 * This mirrors `apps/cli/src/commands/log.ts`'s `waitForOwnLine` discipline
 * (that helper is private to that file, so this is its own scoped copy),
 * matched on `run_id` + `effect_id` + `kind` + `event` — not `run_id` alone.
 *
 * **`run_id` alone is not unique to one dispatch (code-review finding,
 * PR #441).** A dispatched role's own `vinaya dispatch` call (a nested
 * dispatch — no loop feature required, reachable today) inherits its
 * parent's `VINAYA_RUN_ID` via the child's env (by design, so a report can
 * join every line under one run) — `createLogSink`'s own `runId = deps.env().
 * VINAYA_RUN_ID || randomUUID()` picks that inherited value straight back
 * up. Two dispatches sharing one `run_id` racing this same outbox file could
 * match EACH OTHER's `dispatched`/`outcome_received` line on `run_id` +
 * `kind` + `event` alone, resolving early on a line that was never this
 * call's own — reintroducing the exact "a concurrent process's write read as
 * mine" bug class this polling exists to close (`log.ts`'s own
 * `tailHasOwnLine` doc comment). `effect_id` (`randomUUID()`, generated once
 * per `dispatchRole` call, present on every line that call logs) is the
 * value actually unique per invocation; matching on it too closes this.
 */
function hasOwnDispatchLine(path: string, priorSize: number, runId: string, effectId: string, event: string): boolean {
  let buf: Buffer
  try {
    buf = readFileSync(path)
  } catch {
    return false
  }
  if (buf.byteLength <= priorSize) return false
  for (const raw of buf.subarray(priorSize).toString('utf8').split('\n')) {
    if (!raw) continue
    try {
      const obj = JSON.parse(raw) as {
        meta?: { run_id?: unknown }
        effect_id?: unknown
        kind?: unknown
        event?: unknown
      }
      if (obj.meta?.run_id === runId && obj.effect_id === effectId && obj.kind === 'dispatch' && obj.event === event) {
        return true
      }
    } catch {
      // not a JSON line — never trusted blindly
    }
  }
  return false
}

async function waitForDispatchLine(
  path: string,
  priorSize: number,
  runId: string,
  effectId: string,
  event: string,
  timeoutMs = 2000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (hasOwnDispatchLine(path, priorSize, runId, effectId, event)) return
    await new Promise((r) => setTimeout(r, 5))
  }
  // Best-effort durability wait, not a correctness gate — `log()` itself
  // never throws, and a timeout here (an unwritable outbox, an unresolvable
  // repo) is already `log()`'s own silently-warned failure mode.
}

function sizeOfSafe(path: string): number {
  try {
    return readFileSync(path).byteLength
  } catch {
    return 0
  }
}

/**
 * Starts `agent`'s headless mode for `role`, attributes the child's
 * environment, and records the dispatch through `log()`. Never throws — a
 * missing/non-executable binary, a crash, or a timeout all resolve the
 * returned promise with a `DispatchHandle` describing the failure, matching
 * `log()`'s own "never throws" posture (`log-sink.ts`).
 */
export async function dispatchRole(
  role: Role,
  agent: AgentVendor,
  prompt: string,
  opts: DispatchOpts
): Promise<DispatchHandle> {
  const { log, runId } = createLogSink({
    env: () => ({
      ...process.env,
      VINAYA_ROLE: role,
      VINAYA_TASK: opts.task !== undefined ? String(opts.task) : undefined,
      VINAYA_ROUND: opts.round !== undefined ? String(opts.round) : undefined
    })
  })

  // Mirrors `log()`'s own repo resolution so this file knows where to poll
  // for its own lines. Primes `resolveRepo()`'s process-wide cache, so
  // `log()`'s own internal call below resolves the identical value — the
  // one case that could still diverge is an `AEG_REPO`/remote value that
  // fails `log-sink.ts`'s private `isSafeRepoSegment` guard (an
  // intentionally malicious value), where the wait below simply times out
  // harmlessly rather than mis-locating the file.
  const repo = await resolveRepo().catch(() => null)
  const issue = opts.task ?? null
  const outboxPath = outboxPathFor({ outboxRoot: () => join(GLOBAL_VINAYA_HOME, 'outbox') }, repo, issue)

  const effectId = randomUUID()
  const vendor = VENDOR_TABLE[agent]
  const start = Date.now()
  const roundField = opts.round !== undefined ? { round: opts.round } : {}

  const binaryPath = resolveExecutable(vendor.binary)
  if (binaryPath === null) {
    const durationMs = Date.now() - start
    const priorSize = sizeOfSafe(outboxPath)
    log({
      kind: 'dispatch',
      event: 'dispatch_failed',
      payload: {},
      target_role: role,
      model: agent,
      ...roundField,
      effect_id: effectId,
      reason: 'refused',
      usage: null,
      duration_ms: durationMs
    })
    await waitForDispatchLine(outboxPath, priorSize, runId, effectId, 'dispatch_failed')
    return { exitCode: null, durationMs, usage: null, resumeId: null, timedOut: false, failureReason: 'refused' }
  }

  {
    const priorSize = sizeOfSafe(outboxPath)
    log({
      kind: 'dispatch',
      event: 'dispatched',
      payload: {},
      target_role: role,
      model: agent,
      ...roundField,
      effect_id: effectId,
      prompt_hash: promptHashOf(prompt)
    })
    await waitForDispatchLine(outboxPath, priorSize, runId, effectId, 'dispatched')
  }

  const timeoutMs = loadConfig()?.dispatch?.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise<DispatchHandle>((resolve) => {
    const child = spawn(binaryPath, opts.resumeId ? vendor.resumeArgs(opts.resumeId) : vendor.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        VINAYA_RUN_ID: runId,
        VINAYA_ROLE: role,
        VINAYA_TASK: opts.task !== undefined ? String(opts.task) : undefined,
        VINAYA_ROUND: opts.round !== undefined ? String(opts.round) : undefined
      }
    })

    let settled = false
    let timedOut = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let stdoutBuf = ''
    const MAX_STDOUT_BYTES = 1_000_000

    const outputTee = openOutputTee(effectId)
    if (outputTee.path !== null) {
      process.stderr.write(`[vinaya dispatch ${effectId}] ${role} via ${agent}: output teed to ${outputTee.path}\n`)
    }

    // Whatever has arrived since the last complete line. The vendor's stream
    // is line-delimited but a chunk can split one, so a partial tail is held
    // back rather than parsed and discarded.
    let renderCarry = ''
    child.stdout.on('data', (chunk: Buffer) => {
      // Teed off the SAME chunk the parser below consumes, never taken from
      // it: `stdoutBuf` still sees every byte, capped exactly as before.
      outputTee.write(chunk)
      if (stdoutBuf.length < MAX_STDOUT_BYTES) stdoutBuf += chunk.toString('utf8')

      // Show the work as it happens. Rendering must never be able to end the
      // run it is only observing, so every failure here is swallowed: a
      // malformed line, an unexpected shape, a renderer that throws.
      renderCarry += chunk.toString('utf8')
      const lines = renderCarry.split('\n')
      renderCarry = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim().length === 0) continue
        try {
          const rendered = vendor.renderEvent(JSON.parse(line) as Record<string, unknown>)
          if (rendered) process.stderr.write(`${rendered}\n`)
        } catch {
          // not a JSON line, or a renderer that refused it — never fatal
        }
      }
    })
    // Still never inspected for outcome (O2/constraints: stderr content
    // never decides success or failure, only exit code does) — but no
    // longer discarded outright, so a human reading the tee file sees it.
    child.stderr.on('data', (chunk: Buffer) => {
      outputTee.write(chunk)
    })

    // Print mode (O1's motivating trap) may emit nothing on stdout until
    // the very end — the heartbeat is deliberately independent of the
    // child's own output, so liveness is reported even when there is
    // nothing yet to tee.
    const heartbeatTimer: ReturnType<typeof setInterval> = setInterval(() => {
      const elapsedS = Math.round((Date.now() - start) / 1000)
      process.stderr.write(
        `[vinaya dispatch ${effectId}] ${role} via ${agent}: still running — ${elapsedS}s elapsed (ceiling ${Math.round(timeoutMs / 1000)}s)\n`
      )
    }, HEARTBEAT_INTERVAL_MS)

    const warnLeadMs = timeoutWarningLeadMs(timeoutMs)
    const warnTimer: ReturnType<typeof setTimeout> = setTimeout(
      () => {
        process.stderr.write(
          `[vinaya dispatch ${effectId}] ${role} via ${agent}: approaching timeout — SIGTERM in ~${Math.round(warnLeadMs / 1000)}s unless it finishes first\n`
        )
      },
      Math.max(timeoutMs - warnLeadMs, 0)
    )

    const timeoutTimer = setTimeout(() => {
      timedOut = true
      process.stderr.write(`[vinaya dispatch ${effectId}] ${role} via ${agent}: ceiling reached — sending SIGTERM\n`)
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        process.stderr.write(
          `[vinaya dispatch ${effectId}] ${role} via ${agent}: still alive after SIGTERM — sending SIGKILL\n`
        )
        child.kill('SIGKILL')
      }, SIGKILL_GRACE_MS)
    }, timeoutMs)

    async function finish(handle: DispatchHandle, event: string, priorSize: number): Promise<void> {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      if (killTimer) clearTimeout(killTimer)
      clearInterval(heartbeatTimer)
      clearTimeout(warnTimer)
      outputTee.end()
      // The corresponding `log()` call already ran, with `priorSize` taken
      // right before it — this just confirms it landed before the caller
      // can possibly exit the process out from under it.
      await waitForDispatchLine(outboxPath, priorSize, runId, effectId, event)
      resolve(handle)
    }

    child.on('error', () => {
      // A spawn-time error surfacing asynchronously after we already
      // committed to `dispatched` (e.g. the binary vanished between the
      // pre-check and the spawn) — reported as a crash, never as `refused`,
      // since `refused` is reserved for the pre-spawn check above.
      const durationMs = Date.now() - start
      const priorSize = sizeOfSafe(outboxPath)
      log({
        kind: 'dispatch',
        event: 'dispatch_failed',
        payload: {},
        target_role: role,
        model: agent,
        ...roundField,
        effect_id: effectId,
        reason: 'crash',
        usage: null,
        duration_ms: durationMs
      })
      void finish(
        { exitCode: null, durationMs, usage: null, resumeId: null, timedOut: false, failureReason: 'crash' },
        'dispatch_failed',
        priorSize
      )
    })

    // `exit`, never `close`: `close` waits for every stdio stream to see
    // EOF, which never happens when the vendor's own child spawns a
    // background helper that inherits its stdout/stderr (found live,
    // authoring this task — a `cat > /dev/null &`-shaped grandchild in a
    // test fixture held the pipe open forever after a SIGKILL, hanging
    // `dispatchRole`'s returned promise permanently even though the direct
    // child was already dead). `exit` fires the moment the process itself
    // terminates, independent of any descendant still holding the pipe —
    // the correct signal for a process-supervisor ceiling that must never
    // hang regardless of what the vendor's own process tree does.
    child.on('exit', (code) => {
      const durationMs = Date.now() - start

      // O10 — a run's token record survives the manner of its death. The
      // parent captures usage from `stdoutBuf` HERE, at the moment it ends
      // the child, on every exit path (a clean success, a timeout kill, a
      // non-zero crash) — never only on the success path below. `stdoutBuf`
      // already accumulates every byte the child printed before it died
      // (capped at `MAX_STDOUT_BYTES`), so a partial-but-complete usage line
      // a vendor flushed just before SIGTERM/SIGKILL landed is not lost
      // merely because the run itself didn't exit cleanly. `parseUsage` on
      // an empty or usage-less buffer already returns `null` — the same
      // honest "no figures" outcome the timeout/crash paths hardcoded
      // before, just no longer hardcoded when real figures ARE present.
      const usage = vendor.parseUsage(stdoutBuf)

      if (timedOut) {
        const priorSize = sizeOfSafe(outboxPath)
        log({
          kind: 'dispatch',
          event: 'dispatch_failed',
          payload: {},
          target_role: role,
          model: agent,
          ...roundField,
          effect_id: effectId,
          reason: 'timeout',
          usage,
          duration_ms: durationMs
        })
        void finish(
          { exitCode: code, durationMs, usage, resumeId: null, timedOut: true, failureReason: 'timeout' },
          'dispatch_failed',
          priorSize
        )
        return
      }

      if (code !== 0) {
        const priorSize = sizeOfSafe(outboxPath)
        log({
          kind: 'dispatch',
          event: 'dispatch_failed',
          payload: {},
          target_role: role,
          model: agent,
          ...roundField,
          effect_id: effectId,
          reason: 'crash',
          usage,
          duration_ms: durationMs
        })
        void finish(
          { exitCode: code, durationMs, usage, resumeId: null, timedOut: false, failureReason: 'crash' },
          'dispatch_failed',
          priorSize
        )
        return
      }

      const resumeId = vendor.parseResumeId(stdoutBuf)
      if (resumeId !== null) {
        const resumeRecordPath = recordResumeState({
          resumeId,
          role,
          agent,
          task: opts.task ?? null,
          pr: opts.pr ?? null,
          round: opts.round ?? null,
          effectId,
          capturedAt: new Date().toISOString()
        })
        if (resumeRecordPath !== null) {
          process.stderr.write(
            `[vinaya dispatch ${effectId}] ${role} via ${agent}: resumable — session recorded at ${resumeRecordPath}\n`
          )
        }
      }
      const priorSize = sizeOfSafe(outboxPath)
      log({
        kind: 'dispatch',
        event: 'outcome_received',
        payload: {},
        target_role: role,
        model: agent,
        ...roundField,
        effect_id: effectId,
        // See module doc: placeholder pending a generic `DispatchOutcome`
        // variant — never to be read as "a plan was cut."
        outcome: { type: 'plan', issues: [] },
        usage,
        duration_ms: durationMs
      })
      void finish({ exitCode: code, durationMs, usage, resumeId, timedOut: false }, 'outcome_received', priorSize)
    })

    child.stdin.write(prompt)
    child.stdin.end()
  })
}
