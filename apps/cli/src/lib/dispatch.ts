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
 * **The generic "no specific, identifiable forge outcome" gap this module
 * doc used to disclose is closed:**
 * `DispatchOutcomeSchema`'s `completed` variant (`packages/aeg-core/src/log/schema.ts`)
 * carries no invented identifier at all — a
 * successful dispatch's `outcome_received` line now reports `{ type:
 * 'completed' }` honestly, never the `{ type: 'plan', issues: [] }`
 * placeholder borrowed from an unrelated variant this module used to emit.
 *
 * Every attempt also emits a `role_attempt`
 * `'attempted'` line (`kind: 'role_attempt'`) — the run's own normalized
 * outcome (`completed`/`incomplete`/`infrastructure_failed`/`timed_out`/
 * `capability_refused`, from `classifyRoleAttemptOutcome`, below), its retry
 * ordinal (`LaunchRecord.attempt`, the same per-scope counter this file
 * already keeps for recovery), and the same `effect_id`/`model`/`usage`
 * every `dispatch` line for the same attempt carries — and a `usage`
 * `'observed'` line (`kind: 'usage'`) carrying input/output/cache broken out
 * separately, `semantics: 'cumulative'` (one dispatch is one full vendor
 * invocation; the parsed line already represents that invocation's own
 * running total, never a delta between two observations), and an explicit
 * `unknown_reason` string whenever a vendor's own stream gives this launcher
 * nothing to report — never a bare `null` with no account of why.
 */

import { randomUUID, createHash } from 'node:crypto'
import {
  accessSync,
  constants as fsConstants,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { chmodSync, createWriteStream } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { resolveRepo } from '@attalabs/aeg-forge-state'
import { homedir, hostname as osHostname } from 'node:os'
import { parseIssueDocumentation, redact, summarizeTranscript } from '@attalabs/aeg-core'
import type { IssueDocumentationSource, Role, RoleAttemptOutcome, TranscriptSummary } from '@attalabs/aeg-core'
import { createLogSink, outboxPathFor, telemetryOutboxRoot } from './log-sink.js'
import { appendRoleLine } from './loop-log.js'
import { loadConfig } from './config.js'
import {
  runPath,
  RUNTIME_DIR_ENV_KEY,
  runtimeDirForRepo,
  runtimeDirForThisRepo,
  type RunScope,
  scopeFromSegment,
  tasksExecutionRoot
} from './run-paths.js'
import { dirname, join } from 'node:path'
import { buildWorkerEnv, resolveWorkerBoundaryLaunch, RUNTIME_CREDENTIAL_ENV_KEYS } from './worker-boundary.js'
import { repoRoot } from './diff-evidence.js'

/**
 * Terminal colour, applied only at the point a line is written to a real
 * interactive stream — never where the line is produced, so
 * the dispatch-output tee (`openOutputTee`, which never sees these lines at
 * all) and any piped/non-TTY consumer keep reading exactly the bytes they
 * read before this task. `NO_COLOR` (https://no-color.org) is honored by
 * presence alone, any value including empty, not by its truthiness.
 */
const ANSI_RESET = '\x1b[0m'

/** One fixed colour per role, never per vendor — the reader is separating who is speaking, not which binary ran. */
const ROLE_ANSI: Record<Role, string> = {
  planner: '\x1b[34m', // blue
  developer: '\x1b[36m', // cyan
  'code-reviewer': '\x1b[35m', // magenta
  security: '\x1b[31m', // red
  principal: '\x1b[33m', // yellow
  archivist: '\x1b[32m', // green
  architect: '\x1b[93m' // bright yellow
}

/** The coordinator's own colour — distinct from every role above, so a lifecycle/loop line reads as the loop's without reading the text. */
const LOOP_ANSI = '\x1b[90m' // bright black / grey

export function colourEnabled(stream: { isTTY?: boolean }): boolean {
  return Boolean(stream.isTTY) && process.env.NO_COLOR === undefined
}

/**
 * `[role] <line>` — one call per already-split physical line; a caller with
 * multi-line rendered text splits it first so every line carries its own
 * prefix. Coloured only when `stream` is a live TTY and `NO_COLOR` is
 * unset (`colourEnabled`); otherwise the same prefixed text with no escape
 * codes, which is what a piped consumer or a non-interactive run sees.
 */
export function colourAgentLine(role: Role, line: string, stream: { isTTY?: boolean }): string {
  const prefixed = `[${role}] ${line}`
  return colourEnabled(stream) ? `${ROLE_ANSI[role]}${prefixed}${ANSI_RESET}` : prefixed
}

/**
 * The loop/lifecycle style — no added prefix, since this family's own
 * text already names the role (`[vinaya dispatch <id>] <role> via <agent>:
 * …`, or the loop's own `vinaya dev-review-loop: …`); restyled, never
 * stacked with a second prefix. Same TTY/`NO_COLOR` gate as `colourAgentLine`.
 */
export function colourLoopLine(line: string, stream: { isTTY?: boolean }): string {
  return colourEnabled(stream) ? `${LOOP_ANSI}${line}${ANSI_RESET}` : line
}

export const AGENT_VENDOR_NAMES = ['claude', 'codex', 'gemini'] as const
export type AgentVendor = (typeof AGENT_VENDOR_NAMES)[number]

export function isAgentVendor(value: string): value is AgentVendor {
  return (AGENT_VENDOR_NAMES as readonly string[]).includes(value)
}

/**
 * The three-value vocabulary `aeg-root/roles/planner.md` names for a task's
 * "Suggested agent-class" (high/mid/fast) — the Planner's sizing judgment,
 * confirmed or overridden by whoever dispatches at brief time
 * (`aeg-root/skills/brief-authoring/SKILL.md`). Not a model catalogue: this
 * is the fixed, small vocabulary a rationale field is written in, never an
 * enumeration of every model any vendor accepts.
 */
export const AGENT_CLASS_VALUES = ['high', 'mid', 'fast'] as const
export type AgentClass = (typeof AGENT_CLASS_VALUES)[number]

export function isAgentClass(value: string): value is AgentClass {
  return (AGENT_CLASS_VALUES as readonly string[]).includes(value)
}

export type DispatchOpts = {
  task?: number
  pr?: number
  round?: number
  /** The vendor's own session/thread identifier from a prior dispatch's `resumeId`, to resume that exact session instead of starting fresh. */
  resumeId?: string
  /**
   * The model to run, passed to `agent`'s own binary through that vendor's
   * own `--model` flag — confirmed present on all three vendors' own
   * `--help` output, not assumed. Omitted entirely (no flag added) when the
   * caller names none: the vendor then runs whatever its own default model
   * is, exactly as before this task. The caller's choice here always wins
   * over any class-derived default a higher layer (`dispatch-task.ts`)
   * might otherwise have resolved — this function never re-derives one.
   */
  model?: string
  /**
   * The prompt's source file path — required by the brief's stated shape.
   * Unused by any of the three vendors' own invocation today (all three
   * accept the prompt on stdin, confirmed above); kept for a future vendor
   * whose headless mode needs a real file argument instead, and so the
   * caller's `--prompt-file` value has one obvious place to travel through.
   */
  promptFile: string
  /**
   * O6: when given, every lifecycle line this call
   * writes to the terminal (`writeLifecycle`) and every rendered agent-event
   * line is ALSO mirrored, plainly (no ANSI), to this path — the driver's
   * own role-prefixed stream, appended across relaunches. The caller
   * (`dev-review-loop.ts`) resolves this once per loop run, from the same
   * `~/.vinaya/loops/<owner>-<repo>/<issue>.log` convention
   * `loop-log.ts` names.
   */
  roleLogPath?: string
  /**
   * O1/O2: the child's own working
   * directory — never set before this, which meant every dispatched
   * role's shell ran from wherever THIS process's own `cwd` happened to be,
   * not from any content this task actually names. `dev-review-loop.ts`'s
   * reviewer dispatch is the first caller to pass one (a per-reviewer
   * scratch copy of the round's shared, read-only candidate — see
   * `dev-review-loop/reviewer-isolation.ts`); every other caller omits it,
   * which keeps `spawn`'s own default (inherit this process's `cwd`)
   * unchanged for the developer role and every pre-existing dispatch site.
   */
  cwd?: string
  /**
   * O1/O3: marks this dispatch as an unattended start —
   * a driver launching a Developer, Reviewer or operational agent with
   * nobody watching each tool call, as opposed to an Operator running
   * `vinaya dispatch` by hand. Attribution only by itself: whether an
   * unattended start actually REQUIRES `apps/cli/specs/isolation.md`'s
   * OS-level boundary is the separate, declared `dispatch.requireWorkerIsolation`
   * config setting (`config.ts`) — `true` by default on Darwin (the declared
   * supported environment, where O3's "fail closed" is now the automatic
   * default this objective's own unconditional wording names), `false`
   * elsewhere unless a repo opts in explicitly (round 2 review, HIGH — see
   * that config field's own doc comment for why an unconditional default
   * everywhere would only ever refuse on an unsupported host, never protect
   * anything). When BOTH `unattended` is `true` here AND the resolved
   * setting is `true`, the dispatch REFUSES, before ever spawning, if the
   * boundary cannot be established on this host
   * (`worker-boundary.ts`'s `isWorkerBoundaryAvailable`) — never a silent
   * fallback to full environment inheritance (isolation.md §3, "Refusal
   * conditions"). On a host where the setting resolves off (Linux, absent an
   * explicit override), this field changes nothing observable — the plain
   * `vinaya dispatch` CLI command, this file's own pre-existing test suite
   * (`apps/cli/tests/lib/dispatch.test.ts`), and the pre-existing
   * `dev-review-loop`/`dispatch-task` automated-loop dispatch sites (which
   * DO set this field, for attribution) all keep their exact pre-task-3
   * behavior there.
   */
  unattended?: boolean
  /**
   * Round 6 fix, live-reproduced: additional ABSOLUTE directories this
   * dispatch's own confined child needs to READ+WRITE beyond the
   * outbox/resume-record files every unattended dispatch already gets —
   * `dev-review-loop.ts`'s own reviewer/security dispatch is the one caller
   * with a need today: it tells a reviewer, via its OWN prompt text, to
   * write `findings.txt`/`report.txt`/`objectives.txt` into
   * `reviewerWorkDir`'s own
   * `tasks-execution/<task>/rounds/<n>/<role>-work[-retry<n>]`
   * directory (`reviewer-dispatch.ts`) — a path this module has no
   * hardcoded opinion about, so the caller names it directly, the same
   * "generic primitive, caller supplies the repo/dispatch-specific shape"
   * posture `extraWritableFiles` already takes. Found live: with no
   * grant here, a confined reviewer/security dispatch on the declared
   * supported host could not write its own findings — `dev-review-loop`'s
   * own real fixture test hung waiting for a report file no confined
   * dispatch had permission to create. Unlike the single-file outbox/resume
   * grant, `reviewerWorkDir`'s own path is ALREADY uniquely scoped per
   * task/round/role/attempt by its own naming convention, so a directory-
   * level (`subpath`) grant here — not the narrower per-file `literal` one —
   * carries no cross-task/cross-role exposure.
   */
  extraWritableDirs?: readonly string[]
  /**
   * The objectives/brief/ruling/policy identity
   * this attempt is being judged against, when the caller already resolved
   * one (`dev-review-loop.ts`'s own `ReviewInputManifest`, for a reviewer
   * dispatch) — threaded straight into every line this call logs
   * (`meta.input_versions`). Omitted by every caller with no such identity
   * to give (the generic launcher never resolves one itself) — those lines
   * carry the honest all-`null` default they always did.
   */
  inputVersions?: {
    objectivesVersion?: string | null
    briefHash?: string | null
    rulingOrdinal?: number | null
    policyDigest?: string | null
  }
}

/**
 * `'signal'`: the driver's own shutdown path terminated this
 * launch's child on `SIGTERM`/`SIGINT` — distinct from `'crash'` (the child
 * died on its own) so recovery can read it as a cancelled attempt, never an
 * infrastructure failure of the child's own making.
 *
 * `'unbound'`: the child exited — on a timeout kill or on
 * its own, any exit code — having never once bound a vendor session
 * (`launch.resumeId` stayed `null` for the whole run, and the completed
 * `stdoutBuf` still parses to no session either). Distinct from `'crash'`/
 * `'timeout'`, which both mean the vendor came up and did SOME work before
 * dying: a dispatch that never produced a working vendor session at all
 * (measured live: a `sandbox-exec` child whose vendor output file stayed at
 * 0 bytes for its entire life) is a different, more actionable failure —
 * recovery should not treat it the same as an ordinary crash mid-session.
 */
/**
 * `'connection-failed'` (O2) — the vendor's
 * own stdout carried at least one connection-retry signal
 * (`sawVendorConnectionRetry`, below) before the child ended non-zero or
 * timed out, AND a session was already bound: the vendor could not reach
 * its backend, never a developer decision, and the session it bound is
 * still resumable. Classified from a launch that DID bind a session only —
 * one that never bound at all keeps reading `'unbound'`, since there is no
 * exact session for the driver's own re-dispatch (O2's whole point) to
 * resume. Confirmed live, `claude` CLI 2.1.197: pointing `ANTHROPIC_BASE_URL`
 * at an unreachable host produces
 * `{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,...}`
 * lines on stdout — never stderr, so this reads the SAME buffer
 * `parseUsage`/`parseResumeId` already scan, never violating this file's own
 * "stderr content never decides success or failure" rule (`handleChildExit`'s
 * own doc comment, above). Vendor-agnostic by construction — Codex/Gemini's
 * own stream shapes never emit this marker, so the scan is always a no-op
 * for them, never a guessed classification for an unconfirmed vendor's own
 * shape (the vendor tables themselves are unchanged).
 */
export type DispatchFailureReason = 'timeout' | 'crash' | 'refused' | 'signal' | 'unbound' | 'connection-failed'

export type DispatchHandle = {
  exitCode: number | null
  durationMs: number
  usage: { input: number; output: number } | null
  /** The vendor's own session/thread identifier, parsed from a successful dispatch's stdout — `null` on any failure path or an unparseable shape. */
  resumeId: string | null
  timedOut: boolean
  /** Set only when the dispatch did not reach a normal `outcome_received`. */
  failureReason?: DispatchFailureReason
  /**
   * The same `effect_id` this attempt's own `dispatch`/`role_attempt`/`usage`
   * lines already carry — optional so a hand-built fixture value in an
   * existing test keeps type-checking, but always set on a real return from
   * `dispatchRole`. Lets a caller that only sees this handle (never the
   * `log()` calls themselves) correlate a failure it detects downstream
   * back to the exact attempt that produced it, rather than inventing a
   * fresh, unjoinable id.
   */
  effectId?: string
}

/**
 * Four hours — matches `dispatch.timeoutMs`'s documented default in
 * `VinayaConfigSchema`. Raised from the original one hour:
 * a real dispatched agent turn was found live still working past the
 * thirty-minute mark, and a one-hour ceiling gives too little margin before
 * a genuinely working agent is killed mid-task. The ceiling itself stays —
 * an unbounded dispatch is how a hung agent runs forever unnoticed — just
 * long enough now that reaching it is a real signal, not routine noise.
 */
export const DEFAULT_TIMEOUT_MS = 14_400_000

/**
 * Default grace window between `SIGTERM` and `SIGKILL` once the ceiling
 * fires — overridable via `dispatch.killGraceMs` (`VinayaConfigSchema`) so a
 * test proving the escalation itself happens does not have to pay this real
 * wall time to observe it.
 */
const SIGKILL_GRACE_MS = 5_000

/** How often a still-running dispatch announces that it is alive. */
export const HEARTBEAT_INTERVAL_MS = 60_000

/**
 * How long before the deadline the approaching-timeout warning fires.
 * Capped at 5 minutes so a short `dispatch.timeoutMs` (e.g. a test's 2500ms)
 * still gets a warning inside its own ceiling rather than one scheduled past
 * it and never firing.
 */
export function timeoutWarningLeadMs(timeoutMs: number): number {
  return Math.min(300_000, Math.floor(timeoutMs / 2))
}

/**
 * Tees the child's raw stdout/stderr bytes to a machine-local file so a
 * human can read what the agent is doing while it is still running —
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
export function openOutputTee(
  effectId: string,
  scope: RunScope = 'unscoped'
): {
  write: (chunk: Buffer) => void
  end: () => void
  path: string | null
} {
  const inert = { write: () => {}, end: () => {}, path: null }
  // Refuse anything that is not a plain id BEFORE it reaches `join`, so a
  // traversal string can never resolve outside the intended directory.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(effectId)) return inert
  try {
    const dir = runPath(runtimeDirForThisRepo(), scope, { area: 'output' })
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

/**
 * O1: the one shell surface a dispatched agent must never use — a
 * backgrounded command — refused before the tool call executes, not asked
 * nicely in a prompt. Confirmed live against this machine's own
 * `~/.claude/settings.json` and the installed `claude` binary itself (not
 * guessed): `permissions.deny` rules match only a Bash call's COMMAND TEXT
 * (`Bash(<pattern>)`) — there is no bare permission-rule syntax for a
 * structured field like `tool_input.run_in_background`. A `PreToolUse` hook
 * is the one mechanism that receives the tool's full structured input and
 * can decide on that field: its output contract
 * (`hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision:
 * 'allow'|'deny'|'ask', permissionDecisionReason }`) and the
 * `{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":…}]}]}`
 * wiring shape are both read straight out of the installed binary's own
 * strings (it ships an equivalent example hook, `matcher: 'Bash'` running a
 * read-only-`gh` script) — not assumed.
 *
 * This is generated fresh per `dispatchRole` call (this function's own
 * "per-dispatch" — every dispatch, every role, always the same content) and
 * wired in only for `claude`: Codex's `exec --help` exposes no
 * settings-injection or hook flag at all, and Gemini's own `hooks`/`--policy`
 * subsystem needs its own live confirmation this task's boundary doesn't
 * reach, so neither is silently claimed as covered.
 */
export const BACKGROUND_DENY_REASON =
  'Dispatched sessions cannot run shell commands in the background — run this command in the foreground instead.'

/**
 * Round-2 HIGH: `run_in_background === true` is the SDK's own
 * flag for a backgrounded tool call, but a dispatched agent can background a
 * process by shell shape alone, with `run_in_background` left `false` — a
 * trailing `&` (never `&&`, a legitimate chain operator), or a command that
 * launches its process through `nohup`, `disown`, or `setsid`. This is the
 * shared detector the hook script below embeds verbatim (as a string — it
 * runs inside a generated `.mjs` file, not this module), so the fixtures in
 * `dispatch.test.ts` exercise the exact same source the shipped hook runs,
 * never a parallel reimplementation that could silently drift from it.
 *
 * Quote-stripping is naive (no escape handling) — good enough to keep a
 * quoted `&` inside an `echo` argument, e.g. `echo "job &"`, from a false
 * deny, without attempting a full shell parse.
 */
export function backgroundShapeDetectorSource(): string {
  return [
    'function stripQuoted(s) {',
    "  return s.replace(/'[^']*'/g, '').replace(/\"[^\"]*\"/g, '');",
    '}',
    'function commandBackgrounds(command) {',
    "  if (typeof command !== 'string') return false;",
    '  const bare = stripQuoted(command).trimEnd();',
    '  if (/(^|[^&])&$/.test(bare)) return true;',
    '  if (/(^|[;&|]|\\s)nohup\\s/.test(bare)) return true;',
    '  if (/\\bdisown\\b/.test(bare)) return true;',
    '  if (/(^|[;&|]|\\s)setsid\\s/.test(bare)) return true;',
    '  return false;',
    '}'
  ].join('\n')
}

/**
 * The runtime twin of `isWholeSuiteTestPlanLine`
 * (`@attalabs/aeg-core`'s `issue-validation.ts`) — same four whole-suite
 * shapes (a bare `bun test`, `bun test` on a directory, any `bunx turbo
 * test` form, `vitest run` on a package), reimplemented here rather than
 * imported because this source runs embedded, as a string, inside the
 * generated `.mjs` hook script (same posture as `backgroundShapeDetectorSource`
 * above) — a dispatched agent's own Bash calls, never an Issue body. A
 * dispatched developer's own Test plan already names the file(s) their own
 * work proves; the pre-push hook and CI are the only sanctioned whole-suite
 * runs (`roles/developer.md`).
 */
export function wholeSuiteTestCommandDetectorSource(): string {
  return [
    'function maskQuoted(s) {',
    "  return s.replace(/'[^']*'/g, (m) => 'x'.repeat(m.length)).replace(/\"[^\"]*\"/g, (m) => 'x'.repeat(m.length));",
    '}',
    // A shell comment or a chained `;`/`&&`/`||`/newline statement can plant
    // a real test-file path AFTER (or beside) the runner invocation it never
    // actually reaches — `bun test # apps/cli/foo.test.ts` and
    // `bun test; echo apps/cli/foo.test.ts` both still run a bare `bun test`
    // as their effective first command. Judging the whole raw string let
    // both through (security review, found live); judging one statement at
    // a time, comments stripped, does not. A newline is a statement
    // separator here too (round 4 security review, HIGH, found live): a
    // command whose text embeds `\n` followed by a forbidden git subcommand
    // otherwise passes as one un-split statement, since `;`/`&&`/`||` never
    // appear in it at all.
    'function stripLineComment(s) {',
    '  const idx = maskQuoted(s).indexOf("#");',
    '  return idx === -1 ? s : s.slice(0, idx);',
    '}',
    'function commandStatements(command) {',
    '  const masked = maskQuoted(command);',
    '  const statements = [];',
    '  let last = 0;',
    '  const re = /;|&&|\\|\\||\\n/g;',
    '  let m;',
    '  while ((m = re.exec(masked)) !== null) {',
    '    statements.push(command.slice(last, m.index));',
    '    last = m.index + m[0].length;',
    '  }',
    '  statements.push(command.slice(last));',
    '  return statements;',
    '}',
    'function commandRunsWholeSuite(command) {',
    "  if (typeof command !== 'string') return false;",
    '  for (const raw of commandStatements(command)) {',
    '    const stmt = stripLineComment(raw);',
    '    if (/\\bbunx\\s+turbo\\s+test\\b/i.test(stmt)) return true;',
    '    if (/\\bbun\\s+test\\b/i.test(stmt) || /\\bvitest\\s+run\\b/i.test(stmt)) {',
    '      if (!/[^\\s\'"]+\\.(?:test|spec)\\.[jt]sx?\\b/i.test(stmt)) return true;',
    '    }',
    '  }',
    '  return false;',
    '}'
  ].join('\n')
}

export const SUITE_RUN_DENY_REASON =
  'Dispatched sessions cannot run a test runner with no test-file argument — name the specific *.test.*/*.spec.* file(s) this Part proves. The pre-push hook’s selected-tests run and CI are the only sanctioned whole-suite runs.'

/**
 * Round 3 security review, HIGH — found live: `buildRolePermissions`'s own
 * `deny` entries (`Bash(git push --force*)`, `Bash(git commit --no-verify*)`,
 * etc.) are literal command-string-PREFIX matches, exactly like every other
 * entry the settings-file engine supports (this file's own doc comment on
 * `buildRolePermissions` already cites the confirmed-live `Bash(<prefix>)`/
 * `Bash(<prefix>:*)`/`Bash(<glob> *)` grammar) — so an ordinary alternate
 * spelling never matches ANY deny entry at all and resolves through the
 * broader `Bash(git push:*)`/`Bash(git commit:*)` allow with an empty
 * `permission_denials` array: `git push origin --force` (the flag after the
 * remote/branch, not right after `push`), `git push origin +feature:main`
 * (git's own force-refspec syntax — no `--force`/`-f` flag exists at all),
 * `git commit -am fix --no-verify` (the flag after other short options).
 * A prefix-matched string can never generalize over argument ORDER the way
 * this needs to. Detected here instead — the SAME `PreToolUse` hook
 * mechanism `commandRunsWholeSuite` (above) already proves live for exactly
 * this class of check (a whole-suite test run has the identical
 * argument-order problem: `bun test --coverage <file>` is fine, `bun test`
 * alone is not, and no fixed prefix distinguishes them) — real token
 * inspection in JS, not a settings-file pattern. Reuses `commandStatements`/
 * `stripLineComment` from `wholeSuiteTestCommandDetectorSource`'s own
 * embedded copy (both already land in the SAME generated script), rather
 * than a second inline reimplementation.
 */
function gitForceOrSkipVerifyDetectorSource(): string {
  return [
    'function statementTokens(stmt) {',
    '  return stmt.trim().split(/\\s+/).filter(Boolean);',
    '}',
    'function commandForcesGitOrSkipsVerify(command) {',
    "  if (typeof command !== 'string') return false;",
    '  for (const raw of commandStatements(command)) {',
    '    const stmt = stripLineComment(raw);',
    '    const tokens = statementTokens(stmt);',
    "    if (tokens[0] !== 'git') continue;",
    '    const sub = tokens[1];',
    "    if (sub === 'push') {",
    '      for (let i = 2; i < tokens.length; i++) {',
    '        const t = tokens[i];',
    "        if (t === '-f' || t === '--force') return true;",
    "        if (t === '--force-with-lease' || t.indexOf('--force-with-lease=') === 0) return true;",
    "        if (t === '--no-verify') return true;",
    // A push refspec argument starting with `+` (e.g. `+feature:main`,
    // `+HEAD:main`) is git's OWN force-push syntax — no `--force`/`-f` flag
    // is present at all in this shape, confirmed against git's own
    // `git-push` documentation ("a plus sign ... has the same effect as
    // --force").
    "        if (t.charAt(0) === '+' && t.length > 1) return true;",
    '      }',
    "    } else if (sub === 'commit') {",
    '      for (let i = 2; i < tokens.length; i++) {',
    '        const t = tokens[i];',
    "        if (t === '--no-verify' || t === '-n') return true;",
    // A combined short-flag cluster (`-an`, `-na`, …) containing `n` — git
    // commit's own short options never use `n` for anything else, so any
    // cluster carrying it is `-n`/`--no-verify` combined with other flags.
    "        if (/^-[a-zA-Z]+$/.test(t) && t.slice(1).indexOf('n') !== -1) return true;",
    '      }',
    '    }',
    '  }',
    '  return false;',
    '}'
  ].join('\n')
}

export const GIT_FORCE_OR_SKIP_VERIFY_DENY_REASON =
  'Dispatched sessions cannot force-push (in any spelling, including a `+refspec`) or skip commit/push hooks (`--no-verify`/`-n`) — this is enforced by argument inspection, not a settings-file pattern, so no flag ordering or alternate spelling defeats it.'

/**
 * Defense in depth beside the pre-push hook, not the only guard: the
 * pre-push hook only ever sees an actual `git push`, at the git
 * level, after a dispatched session has already committed and staged it;
 * this catches the ATTEMPT one layer earlier, at the Bash tool call itself,
 * before either subcommand ever runs. Origin: a developer session worked in
 * the shared main checkout (rather than its own worktree) and ran a hard
 * reset and pushes there, because the write-access policy only ever GRANTS
 * a path inside the worktree and never DENIES one outside it (see
 * `writeAccessHookScript`'s own O4 fix, alongside this one) — this closes
 * the git-command half of that same gap.
 *
 * Resolved via real `git` calls (`-C <dir>`, so this never depends on the
 * hook process's own cwd matching the command's), never a settings-file
 * pattern — the same reasoning `gitForceOrSkipVerifyDetectorSource`'s own
 * doc comment gives for needing real argument inspection over a fixed
 * prefix. `cwd` starts at `process.cwd()` (this dispatch's own working
 * directory — `spawnCwd` at `dispatchRole`'s own call site) and is updated
 * by a leading `cd <dir>` statement before it, so `cd
 * /path/to/main-checkout && git push` is caught even when the session's own
 * ambient cwd is the worktree; a `cd` target this naive regex cannot parse
 * (quoted, env-var expansion) simply leaves `cwd` unchanged rather than
 * throwing.
 *
 * Fails OPEN on every uncertainty — the SAME posture
 * `checkMainBranchRefusal`'s own doc comment states for its `defaultBranch:
 * null` case ("a check whose job is refusing risky actions must not itself
 * risk refusing a legitimate one it cannot actually evaluate"): a detached
 * HEAD, an unresolvable `origin/HEAD`, or a `cwd` that is not a git
 * checkout at all each read as "nothing to refuse," never a false deny.
 * This hook and `checkMainBranchRefusal`/`check-main-branch-refusal.ts`
 * deliberately read the identical two `git symbolic-ref` facts the same
 * way, so neither can disagree with the other about what counts as "on the
 * default branch."
 */
function defaultBranchCommitOrPushDetectorSource(): string {
  return [
    "const cp = require('child_process');",
    "const path = require('path');",
    'function gitOutput(cwd, args) {',
    '  try {',
    "    return cp.execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();",
    '  } catch { return null; }',
    '}',
    'function currentBranchAt(cwd) {',
    "  const b = gitOutput(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);",
    "  return b === null || b === '' ? null : b;",
    '}',
    'function defaultBranchAt(cwd) {',
    "  const ref = gitOutput(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);",
    "  if (ref === null || ref === '') return null;",
    "  const branch = ref.slice('origin/'.length);",
    "  return branch === '' ? null : branch;",
    '}',
    'function commandCommitsOrPushesOnDefaultBranch(command) {',
    "  if (typeof command !== 'string') return false;",
    '  let cwd = process.cwd();',
    '  for (const raw of commandStatements(command)) {',
    '    const stmt = stripLineComment(raw).trim();',
    '    const cdMatch = /^cd\\s+(\\S+)/.exec(stmt);',
    '    if (cdMatch) { cwd = path.resolve(cwd, cdMatch[1]); continue; }',
    '    const tokens = statementTokens(stmt);',
    "    if (tokens[0] !== 'git') continue;",
    '    const sub = tokens[1];',
    "    if (sub !== 'commit' && sub !== 'push') continue;",
    '    const current = currentBranchAt(cwd);',
    '    if (current === null) continue;',
    '    const def = defaultBranchAt(cwd);',
    '    if (def === null) continue;',
    '    if (current === def) return true;',
    '  }',
    '  return false;',
    '}'
  ].join('\n')
}

export const COMMIT_PUSH_ON_DEFAULT_BRANCH_DENY_REASON =
  "Dispatched sessions cannot commit or push while the shell's working directory is a checkout on this repo's default branch — do this from a worktree instead. This is defense in depth beside the pre-push hook, not the only guard."

/**
 * The subagent tool (`Agent`/`Task` — both names are checked, as a
 * dispatched session may see either) defaults `run_in_background` to true,
 * so an unattended developer session that never sets it explicitly would
 * otherwise background every subagent it spawns — the same failure mode
 * `BACKGROUND_DENY_REASON` closes for Bash, applied to the other tool that
 * can start background work.
 */
export const SUBAGENT_BACKGROUND_DENY_REASON =
  'Dispatched sessions cannot run a subagent in the background — pass run_in_background: false (or omit it) and run it in the foreground instead.'

function denyOutput(reason: string): string {
  return (
    '      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: ' +
    "'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: " +
    JSON.stringify(reason) +
    ' } }));'
  )
}

/** `denyOutput`'s counterpart — used only by `writeAccessHookScript`, which grants rather than refuses. */
function allowOutput(reason: string): string {
  return (
    '      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: ' +
    "'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: " +
    JSON.stringify(reason) +
    ' } }));'
  )
}

function backgroundDenyHookScript(): string {
  return [
    "let d = '';",
    "process.stdin.on('data', (c) => { d += c });",
    "process.stdin.on('end', () => {",
    '  try {',
    '    const e = JSON.parse(d);',
    backgroundShapeDetectorSource(),
    wholeSuiteTestCommandDetectorSource(),
    gitForceOrSkipVerifyDetectorSource(),
    defaultBranchCommitOrPushDetectorSource(),
    '    const input = e.tool_input || {};',
    "    if (e.tool_name === 'Bash' && (input.run_in_background === true || commandBackgrounds(input.command))) {",
    denyOutput(BACKGROUND_DENY_REASON),
    "    } else if (e.tool_name === 'Bash' && commandRunsWholeSuite(input.command)) {",
    denyOutput(SUITE_RUN_DENY_REASON),
    "    } else if (e.tool_name === 'Bash' && commandForcesGitOrSkipsVerify(input.command)) {",
    denyOutput(GIT_FORCE_OR_SKIP_VERIFY_DENY_REASON),
    "    } else if (e.tool_name === 'Bash' && commandCommitsOrPushesOnDefaultBranch(input.command)) {",
    denyOutput(COMMIT_PUSH_ON_DEFAULT_BRANCH_DENY_REASON),
    "    } else if ((e.tool_name === 'Agent' || e.tool_name === 'Task') && input.run_in_background === true) {",
    denyOutput(SUBAGENT_BACKGROUND_DENY_REASON),
    '    }',
    '  } catch {',
    '    // not a JSON line — never block on a shape this hook does not understand',
    '  }',
    '  process.exit(0);',
    '});',
    ''
  ].join('\n')
}

/**
 * True for a `## Documentation` source shaped as a URL — the only shape a
 * `WebFetch` call can ever answer for. An in-repo path (a spec, a role doc)
 * is read via `Read`, which this task's O2 names no hook for; mechanizing
 * "was this URL fetched" only ever applies to the URL-shaped subset. Same
 * `https?://` test `doc-owners.ts`'s `isUrlPointer` already uses, duplicated
 * rather than imported — that module is out of this task's surface and the
 * test is a one-line literal, not a shared grammar worth a cross-file wire.
 */
function isDocumentationUrl(source: string): boolean {
  return /^https?:\/\//i.test(source.trim())
}

/**
 * Which of `sources`' URL-shaped entries never appear (as a normalized
 * prefix match — a trailing slash or `#fragment` on either side never
 * causes a false miss) in `fetchedUrls` — the `WebFetch` URLs the
 * `PostToolUse` hook already recorded for this session. Pure, exported for
 * unit testing; the generated Stop hook script below duplicates this exact
 * logic inline (it must run standalone, no workspace module resolution —
 * same posture `backgroundShapeDetectorSource` already takes).
 */
export function unreadDocumentationSources(
  sources: IssueDocumentationSource[],
  fetchedUrls: string[]
): IssueDocumentationSource[] {
  const normalize = (u: string) => u.trim().split('#')[0]!.replace(/\/+$/, '')
  const fetched = new Set(fetchedUrls.map(normalize))
  return sources.filter((s) => isDocumentationUrl(s.source) && !fetched.has(normalize(s.source)))
}

/**
 * Extracts the `## Documentation` sources this dispatch's own prompt names,
 * for a `developer` dispatch only — the entry-gate obligation `roles/
 * developer.md` states is the Developer's alone, never another role's. A
 * fresh (round 1) developer dispatch's prompt IS the frozen brief text
 * (`dispatch-task.ts`'s `prep.brief`), which now carries `## Documentation`
 * verbatim (`brief-render.ts`'s `renderDocumentation`) right after
 * Objectives. A resumed/round-2+ prompt (a review-finding fix, never the
 * full brief again) simply has no such heading, `parseIssueDocumentation`
 * returns not-ok, and this degrades to `[]` — no re-imposed obligation on a
 * later round, since the sources were already read to reach round 1's PR.
 */
function documentationSourcesFromPrompt(role: Role, prompt: string): IssueDocumentationSource[] {
  if (role !== 'developer') return []
  const parsed = parseIssueDocumentation(prompt)
  if (!parsed.ok || parsed.value.kind !== 'sources') return []
  return parsed.value.sources
}

/**
 * The `PostToolUse` hook that records every `WebFetch` URL for this session
 * — O2. Appends one JSON line (`{url}`) per call to a per-run log
 * file keyed by `VINAYA_RUN_ID` (never a fixed global path: two tasks
 * dispatched concurrently, an observed live pattern on this box, would
 * otherwise share one file and each would see the other's fetches). Exit
 * code 2 is not honored on `PostToolUse` at all (confirmed against
 * code.claude.com/docs/en/hooks: "There is no way to block or undo a tool
 * call after it succeeds") — this hook only ever records, and always exits
 * 0, matching that constraint rather than attempting a block it structurally
 * cannot perform.
 */
function documentationLogHookScript(dir: string): string {
  return [
    "const fs = require('fs');",
    "let d = '';",
    "process.stdin.on('data', (c) => { d += c });",
    "process.stdin.on('end', () => {",
    '  try {',
    '    const e = JSON.parse(d);',
    "    const runId = process.env.VINAYA_RUN_ID || '';",
    "    if (runId && e.tool_name === 'WebFetch' && e.tool_input && typeof e.tool_input.url === 'string') {",
    `      const logPath = ${JSON.stringify(join(dir, 'documentation-log-'))} + runId + '.jsonl';`,
    "      try { fs.appendFileSync(logPath, JSON.stringify({ url: e.tool_input.url }) + '\\n', { mode: 0o600 }); } catch {}",
    '    }',
    '  } catch {',
    '    // not a JSON line — never fail a hook whose only job is to record',
    '  }',
    '  process.exit(0);',
    '});',
    ''
  ].join('\n')
}

/**
 * The `Stop` hook that refuses to let the turn end while a `## Documentation`
 * source named in this dispatch's own brief was never fetched —
 * O2. Reads the per-run sources file `writeDispatchSettings` wrote (dormant,
 * exit 0, when absent or empty: a task whose brief carried no Documentation
 * section, or none of it URL-shaped, owes nothing here) and the log file the
 * `PostToolUse` hook above wrote, and exits 2 — "prevents Claude from
 * stopping, continues the conversation" (code.claude.com/docs/en/hooks) —
 * naming every unread source on stderr when the two disagree. Enforcement is
 * this hook's, never the Developer's own judgement call about whether it
 * read enough.
 */
function documentationStopHookScript(dir: string): string {
  return [
    "const fs = require('fs');",
    "let d = '';",
    "process.stdin.on('data', (c) => { d += c });",
    "process.stdin.on('end', () => {",
    '  try {',
    '    JSON.parse(d);',
    "    const runId = process.env.VINAYA_RUN_ID || '';",
    '    if (!runId) { process.exit(0); }',
    `    const sourcesPath = ${JSON.stringify(join(dir, 'documentation-sources-'))} + runId + '.json';`,
    `    const logPath = ${JSON.stringify(join(dir, 'documentation-log-'))} + runId + '.jsonl';`,
    '    let sources = [];',
    "    try { sources = JSON.parse(fs.readFileSync(sourcesPath, 'utf8')); } catch { sources = []; }",
    '    if (!Array.isArray(sources) || sources.length === 0) { process.exit(0); }',
    '    let fetchedUrls = [];',
    '    try {',
    "      fetchedUrls = fs.readFileSync(logPath, 'utf8')",
    "        .split('\\n')",
    '        .filter(Boolean)',
    '        .map((line) => { try { return JSON.parse(line).url; } catch { return null; } })',
    "        .filter((u) => typeof u === 'string');",
    '    } catch { fetchedUrls = []; }',
    "    const normalize = (u) => String(u).trim().split('#')[0].replace(/\\/+$/, '');",
    '    const fetched = new Set(fetchedUrls.map(normalize));',
    '    const isUrl = (s) => /^https?:\\/\\//i.test(String(s).trim());',
    '    const unread = sources.filter((s) => isUrl(s.source) && !fetched.has(normalize(s.source)));',
    '    if (unread.length > 0) {',
    "      const names = unread.map((s) => '- ' + s.source + ' (governs: ' + s.mechanism + ')').join('\\n');",
    "      process.stderr.write('The brief\\'s `## Documentation` section names a source not yet fetched via WebFetch. Fetch it before ending the turn, and record the mechanism/version it confirms:\\n' + names + '\\n');",
    '      process.exit(2);',
    '    }',
    '  } catch {',
    '    // an unreadable/malformed hook payload never blocks a Stop this hook cannot evaluate',
    '  }',
    '  process.exit(0);',
    '});',
    ''
  ].join('\n')
}

/**
 * The ceiling this repo's own doctrine commands can genuinely need —
 * `roles/developer.md` records the real gate suite running "past ten
 * minutes" on a real Test Plan, above the installed binary's own default
 * `BASH_MAX_TIMEOUT_MS` ceiling (10 minutes, confirmed live against the
 * installed binary's strings) — and the Bash tool's own hard client-side cap
 * (1800000ms / 30 minutes, from its tool description). Set to that same
 * hard cap: raising it further would have no effect, and this is already
 * above every doctrine command on record.
 */
const DISPATCH_BASH_MAX_TIMEOUT_MS = '1800000'

/**
 * Bump this whenever the allow/deny shape below changes, OR the behavior of
 * a hook `writeDispatchSettings` wires alongside it changes (the bump to
 * `v2`: `writeAccessHookScript` now denies a `directory`-scoped Write/Edit
 * outside its granted worktree instead of falling through, and
 * `backgroundDenyHookScript` now also denies a `git commit`/`git push`
 * whose working directory is a checkout on the default branch — neither
 * touches `buildRolePermissions`'s own `allow`/`deny` arrays, but both are
 * as much "the written policy" as those arrays are) —
 * `writeDispatchSettings`'s own first lifecycle line for a role names it, so
 * a run's own log says which policy shape it started under without needing
 * to diff `dispatch.ts` against the run's own timestamp.
 */
export const PERMISSION_POLICY_VERSION = 'v2'

type RolePermissions = { allow: string[]; deny: string[] }

const EMPTY_ROLE_PERMISSIONS: RolePermissions = { allow: [], deny: [] }

/**
 * The settings-file counterpart to `writeDispatchSettings`'s
 * existing hooks — an explicit, per-role `permissions.allow`/`deny` block, so
 * a dispatched role's Bash calls resolve against a WRITTEN policy rather than
 * falling through to whatever permission mode the host process happens to
 * default to (`isolation.md` §2's "second, narrower precedent" — this is a
 * third). Confirmed live against the installed `claude` binary (2.1.258):
 * `permissions.allow`/`deny` entries use the SAME `Bash(<prefix>)`/
 * `Bash(<prefix>:*)`/`Bash(<glob> *)` grammar `denyOutput`'s own doc comment
 * already cites for `~/.claude/settings.json`, and a `deny` entry wins over a
 * broader `allow` entry that also matches — verified live in an isolated
 * fixture repo: `{"allow":["Bash(git commit:*)"],"deny":["Bash(git commit
 * --no-verify*)"]}` let a plain `git commit` through with an empty
 * `permission_denials` array, and refused `git commit --no-verify -am …`
 * with a populated one, from the SAME settings file, under the SAME (default,
 * non-interactive `-p`) permission mode — proving the narrower deny overrides
 * the broader allow rather than the command merely falling through to
 * "unlisted." A command this fixture never runs through this mechanism at
 * all — no `--permission-mode` flag on record here either — is why an
 * UNLISTED command still resolves through the host's own interactive
 * classifier exactly as before this task; only a role's own doctrine-named
 * commands get an explicit answer.
 *
 * **This function covers Bash only — never `Write`/`Edit`.** A round-2 review
 * live-verified that `permissions.allow` entries shaped `Write(<path>/**)` /
 * `Edit(<path>/**)` / `Write(<exact/file>)` do NOT grant a real, non-interactive
 * `Write`/`Edit` call on the installed binary (2.1.258): every path-scoped
 * variant tried (a trailing `/**`, `/*`, a bare directory, a `//`-prefixed
 * absolute form, an exact relative filename) still left the call denied; only
 * the degenerate `Write(*)` (equivalent to no scoping at all) or a bare
 * `Write`/`Edit` with no parenthesized argument ever came back with an empty
 * `permission_denials` array. So a real Write/Edit grant, scoped to a
 * directory or an exact file, is expressed a different way entirely — see
 * `buildWriteAccessScope` and `writeAccessHookScript`, below, which use the
 * SAME `PreToolUse` hook mechanism `backgroundDenyHookScript` already proves
 * live for Bash/Agent/Task, matched on `Write|Edit` instead.
 *
 * `developer` gets the version-control/forge/package/test commands
 * `roles/developer.md`/`roles/developer/reference.md` name it running
 * (worktree creation, fetch, add/commit/push, `gh pr`/`issue` read+write, the
 * package manager, the test runner, this repo's own `verify-*` bin scripts
 * and its `vinaya` CLI entry point) — plus a deny list for exactly what
 * `roles/developer.md`/`reference.md` forbid: a force push in any of its
 * spellings, `--no-verify` on a commit or push, `git stash` (worktree
 * discipline — stash refs are shared across a repo's worktrees), a hard
 * reset, and `rm -rf`/`sudo`, neither of which any doctrine command needs.
 *
 * `code-reviewer`/`security` get read-only git/`gh` commands
 * (`roles/reviewer.md`: "CI is your input, never your job — read it, don't
 * reproduce it: no `bun install`, no re-running tests or checks"). A
 * forge-write/package/test command a Reviewer has no doctrine reason to run
 * is explicitly denied, the same defense-in-depth posture the Developer's own
 * deny list takes, rather than left to fall through as merely unlisted.
 *
 * Every other role (`planner`/`principal`/`archivist`/`architect`) gets no
 * rules at all — this task's own Objectives name only these three roles, and
 * an empty policy leaves an unlisted command resolving exactly as it did
 * before this task, never a silent new restriction on a role this brief
 * never asked to scope.
 */
export function buildRolePermissions(role: Role): RolePermissions {
  if (role === 'developer') {
    return {
      allow: [
        'Bash(git worktree add:*)',
        'Bash(git worktree list:*)',
        'Bash(git fetch:*)',
        'Bash(git status:*)',
        'Bash(git diff:*)',
        'Bash(git log:*)',
        'Bash(git show:*)',
        'Bash(git add:*)',
        'Bash(git commit:*)',
        'Bash(git push:*)',
        'Bash(git config:*)',
        'Bash(git branch:*)',
        'Bash(git checkout:*)',
        'Bash(git merge:*)',
        'Bash(git rebase:*)',
        'Bash(gh pr create:*)',
        'Bash(gh pr edit:*)',
        'Bash(gh pr view:*)',
        'Bash(gh pr comment:*)',
        'Bash(gh pr diff:*)',
        'Bash(gh issue view:*)',
        'Bash(gh issue comment:*)',
        'Bash(bun install:*)',
        'Bash(bun run:*)',
        'Bash(bun test:*)',
        'Bash(bun packages/aeg-core/bin/verify-dispatch.ts:*)',
        'Bash(bun packages/aeg-core/bin/verify-docs.ts:*)',
        'Bash(bun packages/aeg-core/bin/verify-task.ts:*)',
        'Bash(bun apps/cli/src/index.ts:*)'
      ],
      deny: [
        'Bash(git push --force*)',
        'Bash(git push -f*)',
        'Bash(git push --force-with-lease*)',
        'Bash(git push --no-verify*)',
        'Bash(git commit --no-verify*)',
        'Bash(git commit -n*)',
        'Bash(git stash*)',
        'Bash(git reset --hard*)',
        'Bash(rm -rf*)',
        'Bash(sudo*)'
      ]
    }
  }
  if (role === 'code-reviewer' || role === 'security') {
    return {
      allow: [
        'Bash(git diff:*)',
        'Bash(git log:*)',
        'Bash(git show:*)',
        'Bash(git grep:*)',
        'Bash(git status:*)',
        'Bash(git fetch:*)',
        'Bash(gh pr view:*)',
        'Bash(gh pr diff:*)',
        'Bash(gh issue view:*)'
      ],
      deny: [
        'Bash(git push:*)',
        'Bash(git commit:*)',
        'Bash(git add:*)',
        'Bash(gh pr create:*)',
        'Bash(gh pr edit:*)',
        'Bash(gh pr merge:*)',
        'Bash(bun install:*)',
        'Bash(bun test:*)',
        'Bash(bun run:*)'
      ]
    }
  }
  return EMPTY_ROLE_PERMISSIONS
}

export type WriteAccessScope = { kind: 'directory'; allowedDir: string } | { kind: 'exact-files'; paths: string[] }

/**
 * The real grant behind O1's Write/Edit half, now that `buildRolePermissions`'s
 * own doc comment records that a `permissions.allow` path pattern never
 * actually grants one — a directory for the developer (its own worktree), or
 * the three hand-off files for a reviewer/security dispatch, each inside its
 * own `extraWritableDirs` entry. Every role outside these three (or a role
 * whose reviewer dispatch carries no `extraWritableDirs` at all) gets `null`
 * — no hook wiring, no file written, matching `buildRolePermissions`'s own
 * "no rules at all" posture for a role this task's Objectives never named.
 *
 * Paths are realpath'd here, once, before they are ever written to disk or
 * compared against — the same "every substituted path must be canonicalized"
 * discipline `isolation.md` §3 already states for its own Seatbelt profile:
 * a worktree or work directory that resolves through a symlinked alias (this
 * host's own `/tmp` → `/private/tmp` is the standing example) would otherwise
 * make every real Write/Edit call's own resolved path fail to match the
 * unresolved directory this function was handed. A path that does not exist
 * yet degrades to its own raw, unresolved form rather than throwing — never
 * fatal to the dispatch this scope is only ever a defense-in-depth layer for.
 */
export function buildWriteAccessScope(
  role: Role,
  allowedDir: string,
  extraWritableDirs: readonly string[]
): WriteAccessScope | null {
  const real = (p: string): string => {
    try {
      return realpathSync(p)
    } catch {
      return p
    }
  }
  if (role === 'developer') return { kind: 'directory', allowedDir: real(allowedDir) }
  if (role === 'code-reviewer' || role === 'security') {
    if (extraWritableDirs.length === 0) return null
    const paths = extraWritableDirs.flatMap((dir) => {
      const realDir = real(dir)
      return ['findings.txt', 'report.txt', 'objectives.txt'].map((f) => join(realDir, f))
    })
    return { kind: 'exact-files', paths }
  }
  return null
}

export const WRITE_OUTSIDE_WORKTREE_DENY_REASON =
  "Dispatched sessions cannot write or edit a file outside the developer's own worktree — this policy grants a path inside the worktree and denies everything else, rather than falling through to the host's own classifier for an out-of-scope path."

/**
 * The `PreToolUse` hook that grants a real `Write`/`Edit` call — matched on
 * `Write|Edit`, never folded into `backgroundDenyHookScript`'s own
 * `Bash|Agent|Task` matcher, since the two check entirely different tool
 * shapes. Reads the per-run scope file `writeDispatchSettings` wrote (keyed
 * by `runId`, same reasoning `documentationLogHookScript`'s own doc comment
 * gives: two tasks dispatched concurrently on this box must never share one
 * file) and resolves `tool_input.file_path`'s own containing directory via
 * `fs.realpathSync` before comparing — a target file that does not exist yet
 * (the normal case for a fresh `Write`) still has a real, existing parent
 * directory to resolve through.
 *
 * **A `directory`-scoped path outside the written scope now
 * DENIES, rather than falling through.** Before this task, EVERY out-of-scope
 * path (both scope kinds) fell through silently, "exactly like
 * `backgroundDenyHookScript`'s own 'silent otherwise' posture" — this hook's
 * job was only ever to GRANT a real capability the built-in engine cannot
 * express, never to add a new restriction. The origin incident (a developer
 * session working in the shared main checkout instead of its own worktree)
 * showed that posture leaves the door open: an out-of-worktree Write/Edit
 * simply resolved through the host's own default classifier, which can allow
 * it in a non-interactive dispatch. `directory` scope (the developer role's
 * own worktree grant, `buildWriteAccessScope`) now denies explicitly outside
 * it — a real, written restriction, not a silent gap. `exact-files` scope
 * (a reviewer/security dispatch's own three hand-off files) is UNCHANGED: it
 * still falls through silently outside its own narrow allowlist, since O4
 * scopes this rule to "a developer session," and a reviewer/security dispatch
 * was never granted a directory to begin with — denying every path outside
 * three exact filenames would be a far broader new restriction than O4 asks
 * for, on a role this task's Objectives never named.
 */
function writeAccessHookScript(dir: string): string {
  return [
    "const fs = require('fs');",
    "const path = require('path');",
    "let d = '';",
    "process.stdin.on('data', (c) => { d += c });",
    "process.stdin.on('end', () => {",
    '  try {',
    '    const e = JSON.parse(d);',
    "    if (e.tool_name !== 'Write' && e.tool_name !== 'Edit') { process.exit(0); }",
    "    const runId = process.env.VINAYA_RUN_ID || '';",
    '    if (!runId) { process.exit(0); }',
    `    const scopePath = ${JSON.stringify(join(dir, 'write-access-'))} + runId + '.json';`,
    '    let scope;',
    "    try { scope = JSON.parse(fs.readFileSync(scopePath, 'utf8')); } catch { process.exit(0); }",
    '    const filePath = e.tool_input && e.tool_input.file_path;',
    "    if (typeof filePath !== 'string') { process.exit(0); }",
    '    let real;',
    '    try {',
    '      const realParent = fs.realpathSync(path.dirname(filePath));',
    '      real = path.join(realParent, path.basename(filePath));',
    '    } catch { real = filePath; }',
    '    let allowed = false;',
    "    if (scope.kind === 'directory') {",
    '      const base = scope.allowedDir.endsWith(path.sep) ? scope.allowedDir : scope.allowedDir + path.sep;',
    '      allowed = real === scope.allowedDir || real.startsWith(base);',
    "    } else if (scope.kind === 'exact-files' && Array.isArray(scope.paths)) {",
    '      allowed = scope.paths.includes(real);',
    '    }',
    '    if (allowed) {',
    allowOutput("in-scope for this role's written write-access policy"),
    "    } else if (scope.kind === 'directory') {",
    denyOutput(WRITE_OUTSIDE_WORKTREE_DENY_REASON),
    '    }',
    '  } catch {',
    '    // an unreadable/malformed hook payload never blocks a call this hook cannot evaluate',
    '  }',
    '  process.exit(0);',
    '});',
    ''
  ].join('\n')
}

/**
 * Writes this dispatch's settings file and the hook script it references,
 * owner-only inside an owner-only directory (same hardening posture as
 * `openOutputTee`'s tee file). Never throws: an unwritable home degrades to
 * `null` — no `--settings` flag added, matching this module's "never throws"
 * posture — rather than failing the dispatch over a missing deny rule.
 *
 * The `env` block and the widened `PreToolUse` matcher are dispatch's OWN
 * execution posture, carried on the settings file every
 * dispatched session loads — so a session started with no operator export
 * (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`/`BASH_MAX_TIMEOUT_MS`, previously a
 * manual pre-launch step) inherits the same posture automatically. The
 * matcher covers every tool that can start background work: `Bash` (a
 * backgrounded shell command) and the subagent tool, under both names a
 * dispatched session may see it by (`Agent`, `Task` — confirmed live against
 * the installed binary's own strings) — its own `run_in_background` flag
 * defaults to true, so an agent that never sets it explicitly would
 * otherwise background every subagent it spawns.
 *
 * `documentation` (O2) wires the second enforcement pair this
 * settings file carries: a `PostToolUse` hook that logs every `WebFetch` URL
 * and a `Stop` hook that refuses to let the turn end while a URL-shaped
 * `## Documentation` source this dispatch's own brief named was never
 * fetched. Both scripts are static/generic (the same content on every call,
 * like `deny-background-bash.mjs`) — only the per-run SOURCES file this
 * writes is call-specific, keyed by `runId` rather than a fixed name,
 * because two tasks dispatched concurrently on this box (an observed live
 * pattern, not hypothetical) would otherwise share one file and each would
 * see the other's obligation. `runId` must be the same id threaded onto the
 * child's `VINAYA_RUN_ID` env var by the caller, or the hooks can never find
 * the file this call wrote. An empty/absent `documentation` list writes no
 * sources file at all — the Stop hook reads that as "nothing owed" and never
 * blocks, the same seam-is-dormant-when-absent posture `doc-owners.ts`
 * already uses.
 *
 * `role` feeds `buildRolePermissions` to add this same file's third
 * enforcement block, `permissions.allow`/`deny` — see that function's own
 * doc comment for the per-role shape and the live proof behind it.
 * `role`/`allowedDir`/`extraWritableDirs` together feed `buildWriteAccessScope`
 * to wire a FOURTH block, the `Write|Edit` `PreToolUse` hook — see that
 * function's own doc comment for why a settings-file path pattern could not
 * carry this grant instead.
 *
 * **This call's own directory is scoped by `role` (round-2 security review,
 * CRITICAL fix).** Before this fix, `dir` was keyed by task/PR scope alone —
 * a single `settings.json` (and the hook scripts and per-run files beside
 * it) shared by EVERY role dispatched for the same task. `dev-review-loop.ts`
 * dispatches its code-reviewer and security roles CONCURRENTLY
 * (`Promise.all`), each calling this function with a DIFFERENT `role` and
 * `extraWritableDirs` — whichever call's `writeFileSync` landed last won for
 * BOTH already-spawned `claude --settings <path>` processes, since both
 * pointed at the identical path and the vendor process reads it at its own
 * startup, not at the moment this function returns. That race could hand
 * one role the other's own Bash allow/deny list and Write/Edit hand-off-file
 * scope — exactly the "keep read access and their own hand-off files and
 * nothing more" boundary O1 exists to hold. Nesting `role` as this
 * directory's own final path segment gives every concurrently-dispatched
 * role its own exclusive settings file and hook scripts — no shared
 * mutable path for two roles to race on at all.
 */
export function writeDispatchSettings(
  runId: string,
  documentation: IssueDocumentationSource[] = [],
  scope: RunScope = 'unscoped',
  role: Role = 'developer',
  allowedDir = '.',
  extraWritableDirs: readonly string[] = []
): string | null {
  try {
    const dir = join(runPath(runtimeDirForThisRepo(), scope, { area: 'hooks' }), role)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    const scriptPath = join(dir, 'deny-background-bash.mjs')
    writeFileSync(scriptPath, backgroundDenyHookScript(), { mode: 0o600 })
    const documentationLogScriptPath = join(dir, 'documentation-log.mjs')
    writeFileSync(documentationLogScriptPath, documentationLogHookScript(dir), { mode: 0o600 })
    const documentationStopScriptPath = join(dir, 'documentation-stop.mjs')
    writeFileSync(documentationStopScriptPath, documentationStopHookScript(dir), { mode: 0o600 })
    if (documentation.length > 0) {
      const sourcesPath = join(dir, `documentation-sources-${runId}.json`)
      writeFileSync(sourcesPath, JSON.stringify(documentation), { mode: 0o600 })
    }
    const writeAccessScope = buildWriteAccessScope(role, allowedDir, extraWritableDirs)
    const writeAccessScriptPath = join(dir, 'write-access.mjs')
    const preToolUseHooks = [
      {
        matcher: 'Bash|Agent|Task',
        hooks: [{ type: 'command', command: `bun "${scriptPath}"` }]
      }
    ]
    if (writeAccessScope !== null) {
      writeFileSync(writeAccessScriptPath, writeAccessHookScript(dir), { mode: 0o600 })
      const writeAccessPath = join(dir, `write-access-${runId}.json`)
      writeFileSync(writeAccessPath, JSON.stringify(writeAccessScope), { mode: 0o600 })
      preToolUseHooks.push({
        matcher: 'Write|Edit',
        hooks: [{ type: 'command', command: `bun "${writeAccessScriptPath}"` }]
      })
    }
    const settingsPath = join(dir, 'settings.json')
    const settings = {
      env: {
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
        BASH_MAX_TIMEOUT_MS: DISPATCH_BASH_MAX_TIMEOUT_MS
      },
      permissions: buildRolePermissions(role),
      hooks: {
        PreToolUse: preToolUseHooks,
        PostToolUse: [
          {
            matcher: 'WebFetch',
            hooks: [{ type: 'command', command: `bun "${documentationLogScriptPath}"` }]
          }
        ],
        Stop: [
          {
            hooks: [{ type: 'command', command: `bun "${documentationStopScriptPath}"` }]
          }
        ]
      }
    }
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 })
    return settingsPath
  } catch {
    return null
  }
}

type UsageParser = (stdout: string) => { input: number; output: number } | null

/** A vendor's own genuine receipt of which model executed, or `null` when this vendor's stdout carries no such field — never guessed from the requested `--model` value. */
type ModelParser = (stdout: string) => string | null

/**
 * Claude's own confirmed-live receipt of which model actually ran: a real
 * `claude -p --output-format json` run's stdout carries a top-level
 * `modelUsage` object whose key IS the resolved, canonical model name —
 * `{"modelUsage":{"claude-sonnet-5":{"canonicalModel":"claude-sonnet-5",…}}}`
 * even when the alias `sonnet` (never `claude-sonnet-5`) was the requested
 * `--model` value (confirmed live: requesting `sonnet` still keys
 * `modelUsage` by `claude-sonnet-5`). Scanned from the end, same reason
 * `parseClaudeUsage` is. More than one key (a run spanning two models) joins
 * both rather than picking one arbitrarily.
 */
export function parseClaudeModel(stdout: string): string | null {
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i] as string) as { modelUsage?: Record<string, unknown> }
      const keys = obj.modelUsage ? Object.keys(obj.modelUsage) : []
      if (keys.length > 0) return keys.join(',')
    } catch {
      // not a JSON line — keep scanning backwards, never a guessed shape
    }
  }
  return null
}

/**
 * Codex's own `--json` stream carries no model field in any event, at any
 * verbosity — confirmed live against a real `codex exec --json --model
 * gpt-5.6-sol -` run's full event stream (`thread.started`, `turn.started`,
 * `item.completed`, `turn.completed`): none of the four carries a `model`
 * key anywhere. There is no vendor receipt to read for this vendor, ever —
 * this is a fact about Codex's own output shape, not a gap in this parser.
 */
function parseCodexModel(_stdout: string): string | null {
  return null
}

/**
 * Gemini's own confirmed-live receipt: the terminal `result` event's
 * `stats.models` object is keyed by the resolved model name(s) that actually
 * ran — confirmed live: requesting the alias `--model gemini-flash-latest`
 * produced `stats.models` keyed by `gemini-3.8-flash`, a DIFFERENT string
 * than the one requested. Scanned from the end, same reason `parseGeminiUsage`
 * is. More than one key (a run spanning two models, observed live after a
 * mid-run retry) joins both rather than picking one arbitrarily.
 */
export function parseGeminiModel(stdout: string): string | null {
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i] as string) as { stats?: { models?: Record<string, unknown> } }
      const keys = obj.stats?.models ? Object.keys(obj.stats.models) : []
      if (keys.length > 0) return keys.join(',')
    } catch {
      // not a JSON line — keep scanning backwards, never a guessed shape
    }
  }
  return null
}

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

/** The `usage` family's own richer shape — input/output/cache, each independently nullable, plus an explicit reason whenever nothing was observed. Never defaults an unread unit to `0`. */
export type UsageObservation = {
  units: { input: number | null; output: number | null; cache: number | null }
  unknownReason: string | null
}
type UsageUnitsParser = (stdout: string) => UsageObservation

const NO_USAGE_UNITS: UsageObservation['units'] = { input: null, output: null, cache: null }

/**
 * Same terminal-line scan as `parseClaudeUsage`, extended to also read the
 * Anthropic Messages API's own cache fields — `cache_creation_input_tokens`/
 * `cache_read_input_tokens`, present (0 when unused) on every real `usage`
 * object this vendor emits, summed into one `cache` figure since the log's
 * `usage` family carries one cache count, not the two-way creation/read
 * split. Never a second scan of `stdout`: reads the exact JSON object
 * `parseClaudeUsage` already parses, just more of its fields.
 */
export function parseClaudeUsageUnits(stdout: string): UsageObservation {
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i] as string) as {
        usage?: {
          input_tokens?: unknown
          output_tokens?: unknown
          cache_creation_input_tokens?: unknown
          cache_read_input_tokens?: unknown
        }
      }
      const u = obj.usage
      if (u && typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number') {
        const cacheCreation = typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0
        const cacheRead = typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0
        return {
          units: { input: u.input_tokens, output: u.output_tokens, cache: cacheCreation + cacheRead },
          unknownReason: null
        }
      }
    } catch {
      // not a JSON line — keep scanning backwards, never a guessed shape
    }
  }
  return {
    units: NO_USAGE_UNITS,
    unknownReason: 'claude emitted no stream-json line carrying a `usage.input_tokens`/`usage.output_tokens` pair'
  }
}

/**
 * Codex's own `usage` object carries more than `input_tokens`/`output_tokens`
 * (module doc above: "the same field names as Claude's… `usage: {
 * input_tokens, output_tokens, … }`") — `cached_input_tokens`, when present,
 * is read the same defensive way the other optional fields on this object
 * already are: absent reads as "nothing cached," never as "unknown," since
 * the object itself DID parse.
 */
export function parseCodexUsageUnits(stdout: string): UsageObservation {
  const lines = stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = (lines[i] ?? '').trim()
    if (!raw) continue
    try {
      const obj = JSON.parse(raw) as {
        type?: unknown
        usage?: { input_tokens?: unknown; output_tokens?: unknown; cached_input_tokens?: unknown }
      }
      if (obj.type === 'turn.completed' && obj.usage) {
        const u = obj.usage
        if (typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number') {
          const cache = typeof u.cached_input_tokens === 'number' ? u.cached_input_tokens : null
          return { units: { input: u.input_tokens, output: u.output_tokens, cache }, unknownReason: null }
        }
      }
    } catch {
      // not a JSON line — Codex's own stdout is JSONL only, but never trust it blindly
    }
  }
  return {
    units: NO_USAGE_UNITS,
    unknownReason: 'codex emitted no parseable `turn.completed` event carrying a usage pair'
  }
}

/**
 * Gemini's own confirmed-live shape (module doc above) is a per-model
 * `stats.models.<model>.tokens` breakdown, never a single `{ input, output }`
 * pair — this vendor's usage is always reported as explicitly unknown here,
 * naming that confirmed shape, rather than guessing at field names inside
 * `tokens` that were never verified against a real run.
 */
export function parseGeminiUsageUnits(_stdout: string): UsageObservation {
  return {
    units: NO_USAGE_UNITS,
    unknownReason:
      'gemini reports token usage per-model under stats.models.<model>.tokens, confirmed live to carry no single input/output pair — this launcher does not yet read that per-model shape'
  }
}

/**
 * O2 — true when `stdout` carries at least
 * one `{"type":"system","subtype":"api_retry",...}` line: the vendor's own
 * signal that it could not reach its backend and was retrying internally
 * before this process ever saw the child exit or time out. Confirmed live
 * (claude CLI 2.1.197, `ANTHROPIC_BASE_URL` pointed at an unreachable host).
 * Scans the SAME `stdoutBuf` every other vendor-output reader here already
 * does — never stderr (this file's own "stderr content never decides
 * success or failure" rule, `handleChildExit`'s doc comment) — and is
 * vendor-agnostic: Codex/Gemini never emit this shape, so it is always
 * `false` for them, never a guess about a vendor's own unconfirmed output.
 */
export function sawVendorConnectionRetry(stdout: string): boolean {
  for (const line of stdout.split('\n')) {
    if (!line.includes('"api_retry"')) continue
    try {
      const obj = JSON.parse(line) as { type?: unknown; subtype?: unknown }
      if (obj.type === 'system' && obj.subtype === 'api_retry') return true
    } catch {
      // not a JSON line — keep scanning
    }
  }
  return false
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
 * recorded, keyed by repo + role + vendor + the task/PR this run was
 * attributed to — so a later, separate `vinaya dispatch` invocation (a
 * different terminal, possibly days later) can find the id needed to
 * answer a stopped agent through `--resume <id> --prompt-file <answer>`,
 * instead of the id living only in the window that printed it (a
 * Principal ruling: answer through the resume path that already
 * exists — `--resume`/`--prompt-file` are already parsed — never a live
 * channel held open on a blocking read).
 *
 * The repo segment — `${owner}-${repo}`, or `unresolved`
 * when `resolveRepo()` can't (mirrors `outboxPathFor`'s own repo-null
 * convention, `log-sink.ts`) — is load-bearing, not decoration: `task` here
 * is the caller's resolved forge Issue number (`dispatchTask` passes its
 * own `issue`, never the tranche-local ordinal `n` — see its own call
 * site), and two DIFFERENT repositories can both have an Issue numbered the
 * same. Without the repo segment, tranche A's task 9 (repo X, some Issue)
 * and tranche B's task 9 (repo Y, the same Issue number) would overwrite the same
 * `developer-claude-issue12.json`, handing an operator resuming one the
 * other's session.
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
/**
 * Same guard `log-sink.ts`'s private `isSafeRepoSegment` applies before
 * splicing a `resolveRepo()` result into its own outbox path — duplicated
 * here rather than imported, since `log-sink.ts` is out of this task's
 * `## Surface`. `resolveRepo()` can return an `AEG_REPO` env value parsed by
 * `parseOwnerRepo` (`@attalabs/aeg-forge-state`), which accepts anything
 * shaped `owner/repo` — including a `repo` half containing `../` — so a
 * segment failing this check is treated exactly like a null `resolveRepo()`
 * result (`unresolved`), never spliced unchecked into a filesystem path.
 */
/**
 * Which task folder this dispatch's own files belong in. The scope used to
 * be part of a FILENAME in one flat per-repository directory
 * (`<role>-<agent>-issue<n>.json`), which is why a confined role's write
 * grant on that directory exposed every sibling task's and role's record;
 * it is the folder now, so a grant on this dispatch's own file reaches
 * nothing else.
 */
function scopeOf(task?: number, pr?: number): RunScope {
  if (task !== undefined) return task
  if (pr !== undefined) return { pr }
  return 'unscoped'
}

/**
 * This dispatch's own vendor session record:
 * `<runtimeDir>/tasks-execution/<scope>/sessions/<role>-<agent>.json`.
 *
 * The repository segment the old path carried is gone from the filename
 * because the runtime directory itself is already per-repository (a
 * configured one belongs to one repo; the default one keeps the segment) —
 * so two repositories sharing an Issue number still get two records, for
 * the same reason as before.
 */
function resumeRecordPathFor(
  role: Role,
  agent: AgentVendor,
  repo: { owner: string; repo: string } | null,
  task?: number,
  pr?: number
): string {
  return runPath(runtimeDirForRepo(repo), scopeOf(task, pr), {
    area: 'sessions',
    file: `${role}-${agent}.json`
  })
}

export type ResumeRecord = {
  resumeId: string
  role: Role
  agent: AgentVendor
  repo: { owner: string; repo: string } | null
  task: number | null
  pr: number | null
  round: number | null
  effectId: string
  capturedAt: string
}

/**
 * A launch's lifecycle status (O1). `'launched'` is written to the durable
 * record BEFORE the child is spawned, so a launch has a durable identity the
 * instant it begins — even the attempt that a crash interrupts before the
 * vendor ever reports a session. `'completed'` once the child exits cleanly;
 * `'interrupted'` when a timeout, a crash, or a capability refusal ended it.
 * The vendor session id binds onto the SAME record the moment the stream
 * first reports it, WITHOUT changing status (a still-`'launched'` record can
 * already carry a bound `resumeId`). An interrupted launch is never deleted —
 * it keeps its intent record, and any session id already bound, so recovery
 * (`dev-review-loop/developer-dispatch.ts`) can reconcile it rather than
 * losing session identity to the interruption.
 */
export type LaunchStatus = 'launched' | 'completed' | 'interrupted'

/**
 * The durable launch record `dispatchRole` writes for one attempt (O1) — the
 * "run, attempt, role" launch intent, plus the vendor session id bound onto
 * it as soon as it is observable, plus the child identity recovery probes to
 * find a still-live launch (O3). Machine-local, in the same `~/.vinaya/`
 * home the tee and the outbox already use, keyed by repo+role+vendor+scope,
 * for the SAME reason this module keeps the vendor session id out of the
 * Vinaya Log's own `DispatchOutcomeSchema` (see this file's module doc): no
 * strict, versioned schema — the log's, or the control store's own
 * (`packages/aeg-core/src/control-store/records.ts`) — carries
 * a `role`, an `attempt`, or a vendor `sessionId` field, and this record is
 * this launcher's own concern, not a control-store ownership epoch the
 * generic launcher has no business claiming (the loop's own control-store
 * adoption is deferred — `apps/cli/specs/loop.md`).
 */
export type LaunchRecord = {
  runId: string
  role: Role
  agent: AgentVendor
  repo: { owner: string; repo: string } | null
  task: number | null
  pr: number | null
  round: number | null
  /** The "attempt" half of "run, attempt, role" — a monotonic per-scope counter, incremented from the prior launch record for this same repo+role+vendor+scope, so a resumed or re-dispatched attempt is distinguishable from the one it followed. */
  attempt: number
  effectId: string
  /** The dispatcher's own pid — this process, the one that launched. */
  dispatcherPid: number
  /** The spawned vendor child's pid, set the moment `spawn` returns — the identity recovery probes to tell a still-live launch from a finished one (O3). `null` until the child is actually spawned (a pre-spawn refusal never sets it). */
  childPid: number | null
  /** The child's own process start time, snapshotted (`getProcessSnapshot`) the instant `spawn` returns — O3. Compared back against the SAME pid's current start time at recovery time so a pid the OS has since recycled for an unrelated process is never mistaken for this launch's own child. `null` when the snapshot could not be taken (never blocks the dispatch). */
  childStartedAt: string | null
  /** The child's own command name, snapshotted alongside `childStartedAt` — the second identity signal O3 asks for ("start time and/or command line"). `null` when unavailable. */
  childCommand: string | null
  host: string
  startedAt: string
  status: LaunchStatus
  /** The vendor session id, bound the moment the stream first reports it (O1) — `null` until then, and left `null` on an attempt interrupted before its session was ever observable (the honest "no session to resume" case recovery pauses on). */
  resumeId: string | null
  boundAt: string | null
  finishedAt: string | null
  failureReason: DispatchFailureReason | null
}

/**
 * The three-way read of a launch record, mirroring the control store's own
 * `ParsedRecord` discipline (`packages/aeg-core/src/control-store/records.ts`):
 * `'corrupt'` (something is written but does not parse as a launch record) is
 * never conflated with `'absent'` (nothing was ever written) — the exact
 * distinction recovery needs to tell "no launch to reconcile" apart from "a
 * launch happened but its record is unreadable."
 */
export type ParsedLaunch =
  | { status: 'ok'; record: LaunchRecord }
  | { status: 'absent' }
  | { status: 'corrupt'; reason: string }

function coerceLaunchRecord(json: unknown): LaunchRecord | null {
  if (typeof json !== 'object' || json === null) return null
  const o = json as Record<string, unknown>
  // A launch record — or a pre-this-task `ResumeRecord` on disk, tolerated so
  // an in-flight resume survives this task landing — is identified by its
  // `role`/`agent` strings; every lifecycle field missing from an old record
  // is filled with the honest default (`resumeId` present → `'completed'`,
  // since only a successful dispatch ever wrote the old shape).
  if (typeof o.role !== 'string' || typeof o.agent !== 'string') return null
  const resumeId = typeof o.resumeId === 'string' && o.resumeId.length > 0 ? o.resumeId : null
  const status: LaunchStatus =
    o.status === 'launched' || o.status === 'completed' || o.status === 'interrupted'
      ? o.status
      : resumeId
        ? 'completed'
        : 'launched'
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)
  const failureReason =
    o.failureReason === 'timeout' ||
    o.failureReason === 'crash' ||
    o.failureReason === 'refused' ||
    o.failureReason === 'signal' ||
    o.failureReason === 'unbound'
      ? o.failureReason
      : null
  return {
    runId: typeof o.runId === 'string' ? o.runId : '',
    role: o.role as Role,
    agent: o.agent as AgentVendor,
    repo: typeof o.repo === 'object' && o.repo !== null ? (o.repo as { owner: string; repo: string }) : null,
    task: num(o.task),
    pr: num(o.pr),
    round: num(o.round),
    attempt: typeof o.attempt === 'number' ? o.attempt : 1,
    effectId: typeof o.effectId === 'string' ? o.effectId : '',
    dispatcherPid: num(o.dispatcherPid) ?? 0,
    childPid: num(o.childPid),
    // Absent on any record written before this task — `null` is the honest
    // "no identity captured" reading, never a fabricated match or mismatch.
    childStartedAt: typeof o.childStartedAt === 'string' ? o.childStartedAt : null,
    childCommand: typeof o.childCommand === 'string' ? o.childCommand : null,
    host: typeof o.host === 'string' ? o.host : '',
    startedAt: typeof o.startedAt === 'string' ? o.startedAt : typeof o.capturedAt === 'string' ? o.capturedAt : '',
    status,
    resumeId,
    boundAt: typeof o.boundAt === 'string' ? o.boundAt : typeof o.capturedAt === 'string' ? o.capturedAt : null,
    finishedAt: typeof o.finishedAt === 'string' ? o.finishedAt : null,
    failureReason
  }
}

/**
 * Overwrites the one launch record for this repo+role+vendor+scope. Never
 * throws, matching this module's "never throws" posture: an unwritable home
 * degrades to no durable record, the same failure mode `openOutputTee`
 * already accepts for its own file. Only the most recent launch for a scope
 * is ever the one worth reconciling, so there is nothing to append to.
 */
function writeLaunchRecord(record: LaunchRecord): string | null {
  try {
    const path = resumeRecordPathFor(
      record.role,
      record.agent,
      record.repo,
      record.task ?? undefined,
      record.pr ?? undefined
    )
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    chmodSync(dirname(path), 0o700)
    writeFileSync(path, JSON.stringify(record, null, 2), { mode: 0o600 })
    return path
  } catch {
    return null
  }
}

/**
 * Reads back the launch record last written for this exact
 * repo+role+vendor+scope — `'absent'` when none exists, `'corrupt'` when one
 * exists but does not parse (never conflated, per `ParsedLaunch`). Never
 * throws (same posture as `writeLaunchRecord`). Recovery
 * (`dev-review-loop/developer-dispatch.ts`, O3) reads this to reconcile a
 * prior launch before continuing.
 */
export function readLaunchRecord(
  role: Role,
  agent: AgentVendor,
  repo: { owner: string; repo: string } | null,
  task?: number,
  pr?: number
): ParsedLaunch {
  let raw: string
  try {
    raw = readFileSync(resumeRecordPathFor(role, agent, repo, task, pr), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent' }
    return {
      status: 'corrupt',
      reason: `unreadable launch record: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    return {
      status: 'corrupt',
      reason: `invalid JSON (torn write?): ${err instanceof Error ? err.message : String(err)}`
    }
  }
  const record = coerceLaunchRecord(json)
  if (!record) return { status: 'corrupt', reason: 'not a launch record (missing role/agent)' }
  return { status: 'ok', record }
}

/**
 * The bound-session view of the launch record, for the callers that only need
 * a resumable vendor session id (the loop's own round-1 attach/resume seams,
 * O4) — `null` when no launch exists, its record is corrupt, or the
 * launch was interrupted before its session was ever bound (no session to
 * resume). An interrupted-but-bound launch now yields its session id here,
 * where before this task only a cleanly-completed one did — the session
 * identity a mid-turn crash used to lose (O1).
 */
export function readResumeRecord(
  role: Role,
  agent: AgentVendor,
  repo: { owner: string; repo: string } | null,
  task?: number,
  pr?: number
): ResumeRecord | null {
  const parsed = readLaunchRecord(role, agent, repo, task, pr)
  if (parsed.status !== 'ok') return null
  const r = parsed.record
  if (!r.resumeId) return null
  return {
    resumeId: r.resumeId,
    role: r.role,
    agent: r.agent,
    repo: r.repo,
    task: r.task,
    pr: r.pr,
    round: r.round,
    effectId: r.effectId,
    capturedAt: r.boundAt ?? r.startedAt
  }
}

/** A pid's own identity facts, read fresh off the OS — never trusted from a launch record alone (O3): `ppid` is what tells recovery whether a still-alive child is still parented to the driver that spawned it (O2), `startedAt`/`command` are what tells it whether this pid is even the SAME process the launch record named, rather than one the OS has since recycled for something unrelated. */
export type ProcessSnapshot = { ppid: number; startedAt: string | null; command: string | null }

/** One `ps -o <format> -p <pid>` field, trimmed — `null` when `ps` refuses the pid (it doesn't exist) or prints nothing. `=` suffixes on every format string suppress the header row on both BSD (macOS) and GNU (Linux) `ps`, so a single blank/absent line unambiguously means "no such process." */
function psField(pid: number, format: string): string | null {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', format], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const line = out
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0)
    return line ?? null
  } catch {
    return null
  }
}

/**
 * O3: a live snapshot of `pid`'s own identity — `null` when no process
 * answers at that pid at all. `ppid`/`comm` are single-token fields, safe to
 * read with their own `ps` call each; `lstart` carries embedded spaces (a
 * full timestamp), so it is never combined with the others into one
 * multi-field `-o` format that a naive whitespace split could misparse.
 * Uses the system `ps` rather than a dependency: every supported platform
 * (macOS, Linux) ships one.
 */
export function getProcessSnapshot(pid: number): ProcessSnapshot | null {
  const ppidRaw = psField(pid, 'ppid=')
  if (ppidRaw === null) return null
  const ppid = Number.parseInt(ppidRaw, 10)
  if (!Number.isFinite(ppid)) return null
  return { ppid, startedAt: psField(pid, 'lstart='), command: psField(pid, 'comm=') }
}

/**
 * O3 (a HIGH security-review finding): does `snapshot` (a LIVE
 * re-read of a pid) still match the identity `record` captured for that
 * same pid at spawn time? The one identity guard both callers that ever
 * treat a pid as this launch's own child now share — `dev-review-loop/
 * developer-dispatch.ts`'s `classifyChildLiveness` (recovery, reading a
 * PRIOR launch back) and `terminateLaunchedChildOnShutdown` below (the
 * driver's own shutdown path, acting on a launch it is ENDING) — so a
 * recycled pid is refused identically on both paths, never signaled just
 * because the recovery-side check happens to live somewhere else. A field
 * `record` DID capture must be read back and agree; one it never captured
 * (any record written before this task) has nothing to check and is
 * trusted as before — the `ppid`/liveness half of the decision is each
 * caller's own concern, not this function's.
 */
export function matchesCapturedIdentity(
  record: Pick<LaunchRecord, 'childStartedAt' | 'childCommand'>,
  snapshot: ProcessSnapshot
): boolean {
  if (record.childStartedAt !== null) {
    if (snapshot.startedAt === null || record.childStartedAt !== snapshot.startedAt) return false
  }
  if (record.childCommand !== null) {
    if (snapshot.command === null || record.childCommand !== snapshot.command) return false
  }
  return true
}

/** Bounded grace between the two escalating signals `terminateChildWithGrace` sends — the same order of magnitude as `SIGKILL_GRACE_MS` (the dispatch timeout's own escalation), reused here for a driver-initiated termination rather than a child that overran its own ceiling. */
const TERMINATE_GRACE_MS = 2_000

function pidAliveHere(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Blocking, in-process sleep — the same `Atomics.wait` idiom `dev-review-loop/gate-reading.ts`'s own `sleepSyncMs` already uses, restated here rather than imported across that module boundary (its own doc comment: moved out of `dev-review-loop.ts` verbatim, kept self-contained). */
function sleepSyncMs(ms: number): void {
  if (ms <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * `SIGTERM`, a bounded grace period, then `SIGKILL` only if still alive —
 * the same escalation `dispatchRole`'s own timeout path already applies to
 * a child that overran its ceiling, reused here for a driver-initiated
 * termination: the driver's own shutdown path (O1) terminating its
 * dispatched child, and recovery (O2) reaping a child abandoned by a driver
 * that died without reaching that shutdown path. Best-effort throughout: a
 * pid already gone by either signal is silently treated as done, never an
 * error — the goal (no orphan survives) is already met in that case.
 */
export function terminateChildWithGrace(pid: number, graceMs: number = TERMINATE_GRACE_MS): void {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  sleepSyncMs(graceMs)
  if (pidAliveHere(pid)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone between the check and the signal — fine.
    }
  }
}

/** How long `captureSettledChildSnapshot` polls for a spawned child's OWN exec chain to land before trusting its identity — bounded, same order of magnitude as `TERMINATE_GRACE_MS`. */
const IDENTITY_SETTLE_BUDGET_MS = 1_000
/** Poll interval within that budget. */
const IDENTITY_SETTLE_POLL_MS = 20

/**
 * O3 (a MAJOR code-review finding): `childCommand`/`childStartedAt`
 * used to be captured from a single `getProcessSnapshot` read the instant
 * `spawn()` returned. A vendor CLI installed through a typical npm shebang
 * launcher (`#!/usr/bin/env node`) does not settle into its final image in
 * that one kernel-triggered exec: the kernel execs `env` off the shebang
 * line, and `env` itself then performs a SECOND, user-space `execve` into
 * `node`. A read taken before that second exec lands can capture `env`'s own
 * identity rather than the process that actually survives — precisely the
 * two-hop race `writeIdentityStableFakeBinary`'s doc comment (in
 * `dispatch.test.ts`) claimed only a synthetic test binary could hit; a real
 * `#!/usr/bin/env node` install hits it too. A pid's start time is set once,
 * at fork, and does not move across `execve` — only `comm` is unstable here
 * — so this polls until two consecutive reads agree on `command`, or the
 * budget elapses, and keeps the latest read either way. Never returns `null`
 * once a live process has answered at least once; still returns the FIRST
 * read if the process is gone by the next poll (a vendor CLI that exits
 * within this budget is not the case this guards).
 */
export function captureSettledChildSnapshot(pid: number): ProcessSnapshot | null {
  let snapshot = getProcessSnapshot(pid)
  if (snapshot === null) return null
  const deadline = Date.now() + IDENTITY_SETTLE_BUDGET_MS
  while (Date.now() < deadline) {
    sleepSyncMs(IDENTITY_SETTLE_POLL_MS)
    const next = getProcessSnapshot(pid)
    if (next === null) return snapshot
    if (next.command === snapshot.command) return next
    snapshot = next
  }
  return snapshot
}

/**
 * O1: called by the driver's own `SIGTERM`/`SIGINT` handler,
 * before it exits. A launch record still reading `'launched'` (a dispatch
 * genuinely in flight when the signal arrived) has its child terminated —
 * on this host, best-effort — and is patched to `'interrupted'`, so the
 * next start finds a truthful record and no orphan left behind for it to
 * trip over (the Defect this task closes). A record that already reads
 * `'completed'`/`'interrupted'` (the dispatch's own exit handler in this
 * same file already settled it before the signal arrived) is left
 * untouched — there is nothing left to terminate or reclassify. A missing
 * or corrupt record is likewise left alone: there is no in-flight launch to
 * account for.
 *
 * Round 4 security review, HIGH: the signal handlers register early — a
 * driver killed before it ever reaches its OWN recovery step still has this
 * called on its next start's shutdown, against whatever record is on disk,
 * which could be a stale one an EARLIER process instance left behind
 * (itself `SIGKILL`ed before reaching this same path). `record.childPid` is
 * therefore never signaled on identity alone: `getProcessSnapshot` re-reads
 * the live pid and `matchesCapturedIdentity` — the SAME identity guard
 * `classifyChildLiveness` applies on the recovery side — must agree before
 * `terminateChildWithGrace` ever runs. No live process at that pid, or one
 * that fails the identity match (the OS has recycled it for something
 * unrelated), is left untouched: there is nothing of this launch's own left
 * to terminate, and the record is patched exactly as if there had been.
 */
export function terminateLaunchedChildOnShutdown(
  role: Role,
  agent: AgentVendor,
  repo: { owner: string; repo: string } | null,
  task?: number,
  pr?: number
): void {
  const parsed = readLaunchRecord(role, agent, repo, task, pr)
  if (parsed.status !== 'ok') return
  const record = parsed.record
  if (record.status !== 'launched') return

  if (record.childPid !== null && record.host === osHostname()) {
    const snapshot = getProcessSnapshot(record.childPid)
    if (snapshot !== null && matchesCapturedIdentity(record, snapshot)) {
      terminateChildWithGrace(record.childPid)
    }
  }

  writeLaunchRecord({
    ...record,
    status: 'interrupted',
    finishedAt: new Date().toISOString(),
    failureReason: 'signal'
  })
}

/** The next per-scope attempt number — one past the prior launch record for this scope, or `1` when none exists or it is corrupt (a corrupt prior never blocks a fresh attempt from starting). */
function nextAttempt(
  role: Role,
  agent: AgentVendor,
  repo: { owner: string; repo: string } | null,
  task?: number,
  pr?: number
): number {
  const parsed = readLaunchRecord(role, agent, repo, task, pr)
  return parsed.status === 'ok' ? parsed.record.attempt + 1 : 1
}

/**
 * `recoverUsageFromDispatchTee`'s I/O, injected the same way
 * `MeteringCapabilityDeps` is (`claude-code-transcript.ts`) — a fixture
 * stands in a fake env, a fake set of launch-record files, and fake tee
 * bytes without touching this machine's real `~/.vinaya/`.
 */
export type DispatchTeeRecoveryDeps = {
  env: Record<string, string | undefined>
  /** Every session-record JSON file path this run's runtime directory currently holds, across every task folder, role and agent — the `tasks-execution/<scope>/sessions/` layout, already walked. */
  listLaunchRecordPaths: () => string[]
  readFile: (path: string) => string
}

/** Real, runtime-directory-backed deps for production use — never throws; an unreadable/absent task folder degrades to an empty list, matching this module's "never throws" posture. */
export function realDispatchTeeRecoveryDeps(): DispatchTeeRecoveryDeps {
  return {
    env: process.env,
    listLaunchRecordPaths: () => {
      const runtime = runtimeDirForThisRepo()
      const out: string[] = []
      let scopes: string[]
      try {
        scopes = readdirSync(tasksExecutionRoot(runtime))
      } catch {
        return out
      }
      for (const scope of scopes) {
        const sessionsDir = runPath(runtime, scopeFromSegment(scope), { area: 'sessions' })
        let files: string[]
        try {
          files = readdirSync(sessionsDir)
        } catch {
          continue
        }
        for (const f of files) if (f.endsWith('.json')) out.push(join(sessionsDir, f))
      }
      return out
    },
    readFile: (path: string) => readFileSync(path, 'utf8')
  }
}

export type DispatchTeeRecovery = { summary: TranscriptSummary; teePath: string }

/**
 * Walks every launch record this machine currently holds
 * (`deps.listLaunchRecordPaths`) and returns the first one satisfying
 * `predicate`, or `null` if none does — a torn/unreadable file along the
 * way is skipped, never thrown. The one shared walk both
 * `recoverUsageFromDispatchTee` and `launchRecordMatchesRun` build their own
 * narrower match on top of, so the two never drift into two slightly
 * different readings of the same on-disk record.
 */
function findMatchingLaunchRecord(
  deps: DispatchTeeRecoveryDeps,
  predicate: (record: LaunchRecord) => boolean
): LaunchRecord | null {
  for (const path of deps.listLaunchRecordPaths()) {
    let raw: string
    try {
      raw = deps.readFile(path)
    } catch {
      continue
    }
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      continue
    }
    const record = coerceLaunchRecord(json)
    if (record && predicate(record)) return record
  }
  return null
}

/**
 * True only when a launch record exists naming EXACTLY this
 * `(runId, role, task)` triple — the cross-check `broker.ts`'s
 * `authenticateWorkerInvocation` needs before trusting a dispatched child's
 * own claimed `VINAYA_TASK`. `VINAYA_ROLE`/`VINAYA_TASK` are read from the
 * SAME caller-controlled environment this module's own doc already warns a
 * compromised or merely buggy Worker can set to anything (this file's
 * header comment); accepting them alone never proves the controller
 * actually dispatched this child for the task it claims. A launch record is
 * written by the controller itself, before the child is ever spawned
 * (`dispatchRole`, below) — `runId` is the one identifier `dispatchRole`
 * generates and the child never chooses, so a forged `task` for a REAL
 * `runId` finds no launch record at that (runId, role, task) triple: the
 * one the controller actually wrote sits at the child's true task, not the
 * one it is now claiming.
 */
export function launchRecordMatchesRun(
  deps: DispatchTeeRecoveryDeps,
  runId: string,
  role: Role,
  task: number
): boolean {
  return findMatchingLaunchRecord(deps, (r) => r.runId === runId && r.role === role && r.task === task) !== null
}

/**
 * O1: recovers a dispatched session's real usage from the
 * coordinator's own tee'd copy of that session's stdout (`openOutputTee`),
 * for the case its OWN transcript pointer never resolved at all — the
 * sanctioned `no-transcript-resolved` case `resolveMeteringCapability`
 * (`claude-code-transcript.ts`, out of this task's surface) already
 * produces, unchanged. The tee holds the vendor's raw stream — for Claude,
 * `--output-format stream-json`, the identical per-message
 * `{type:"assistant", message:{id, usage}}` shape a real transcript file
 * carries — so `summarizeTranscript` (aeg-core's already-shipped,
 * already-tested dedup-by-message-id-then-sum reader) applies to it
 * unchanged; this function's own job is only to find the right file.
 *
 * Matched by `VINAYA_RUN_ID` alone — the one identifier this process and
 * its own dispatcher already agree on (set on the child's env at spawn,
 * read back here) — never by guessing which repo or which vendor launched
 * it. `null` on anything short of a full recovery: no run/role/task
 * attribution in this process's own env, no launch record naming that
 * exact run, no tee file, or a tee holding zero usable messages. Never
 * estimates — a `null` here changes nothing about the caller's existing
 * incapable verdict.
 */
export function recoverUsageFromDispatchTee(deps: DispatchTeeRecoveryDeps): DispatchTeeRecovery | null {
  const runId = deps.env.VINAYA_RUN_ID
  const role = deps.env.VINAYA_ROLE
  const taskRaw = deps.env.VINAYA_TASK
  if (!runId || !role || !taskRaw) return null
  const task = Number(taskRaw)
  if (!Number.isInteger(task)) return null

  const record = findMatchingLaunchRecord(
    deps,
    (r) => r.runId === runId && r.role === role && r.task === task && !!r.effectId
  )
  const effectId = record?.effectId ?? null
  // Same shape the tee was refused for at write time (`openOutputTee`) — a
  // launch record is this module's own, never untrusted input, but the
  // `effectId` field still gets the same guard before it reaches a path
  // join, on principle.
  if (!effectId || !/^[A-Za-z0-9_-]{1,128}$/.test(effectId)) return null

  const teePath = runPath(runtimeDirForThisRepo(), scopeOf(task), { area: 'output', file: `${effectId}.log` })
  let teeText: string
  try {
    teeText = deps.readFile(teePath)
  } catch {
    return null
  }

  const summary = summarizeTranscript(teeText)
  return summary.messageCount > 0 ? { summary, teePath } : null
}

type VendorSpec = {
  binary: string
  /** `model` appended via this vendor's own `--model` flag when given, omitted entirely otherwise — never a separate switch elsewhere. */
  args: (model?: string) => string[]
  resumeArgs: (id: string, model?: string) => string[]
  parseUsage: UsageParser
  /** The `usage` family's own richer read of the SAME stdout `parseUsage` scans — input/output/cache, honest `unknownReason` when nothing was observed. */
  parseUsageUnits: UsageUnitsParser
  /** This vendor's own genuine receipt of which model ran (O2), or `null` when it emits none — never the requested `--model` value echoed back. */
  parseModel: ModelParser
  parseResumeId: (stdout: string) => string | null
  /** One line of this vendor's own stream, rendered for a human, or `null` for an event worth nothing on screen. */
  renderEvent: (obj: Record<string, unknown>) => string | null
  /**
   * This vendor's own model for each `AgentClass`, used only when a caller
   * names no explicit model and a task's rationale resolves to a class.
   * Deliberately partial, not a model catalogue: filled only where a
   * real, non-stale mapping exists — Claude's own `--model` help text
   * documents these three as aliases that always track its "latest" model
   * per tier, so the mapping never goes stale as new Claude models ship.
   * Codex and Gemini publish no such alias layer (`codex --help`/
   * `gemini --help` show a bare `--model <value>` with no enumerated or
   * aliased values, confirmed live) — inventing a version-pinned mapping
   * for either would be exactly the stale catalogue this task's own
   * Stop-and-escalate condition names, so both stay empty: a task naming
   * neither vendor's own model runs that vendor's default, same as before
   * this task, rather than resolving to a name that will go stale.
   */
  classModels: Partial<Record<AgentClass, string>>
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
    // `--model <model>` confirmed live via `claude --help`: "Provide an
    // alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a
    // model's full name (e.g. 'claude-fable-5')." Placed after the
    // established flags, never before them — no vendor here parses these
    // options positionally, confirmed by the existing resume-argv tests
    // this task leaves passing unchanged when no model is given.
    args: (model) => ['-p', '--verbose', '--output-format', 'stream-json', ...(model ? ['--model', model] : [])],
    resumeArgs: (id, model) => [
      '-p',
      '-r',
      id,
      '--verbose',
      '--output-format',
      'stream-json',
      ...(model ? ['--model', model] : [])
    ],
    parseUsage: parseClaudeUsage,
    parseUsageUnits: parseClaudeUsageUnits,
    parseModel: parseClaudeModel,
    parseResumeId: parseClaudeResumeId,
    renderEvent: renderClaudeEvent,
    // Confirmed live (`claude --help`): these are the vendor's own aliases
    // for "the latest model at this tier" — never a version-pinned name, so
    // this mapping does not go stale as Claude ships new models.
    classModels: { high: 'opus', mid: 'sonnet', fast: 'haiku' }
  },
  codex: {
    binary: 'codex',
    // `-m, --model <MODEL>` confirmed live via `codex exec --help` — a bare
    // string with no enumerated or aliased values (unlike `--sandbox`,
    // which does list `[possible values: ...]` in the same help output).
    args: (model) => ['exec', ...(model ? ['--model', model] : []), '--json', '-'],
    resumeArgs: (id, model) => ['exec', 'resume', id, ...(model ? ['--model', model] : []), '--json', '-'],
    parseUsage: parseCodexUsage,
    parseUsageUnits: parseCodexUsageUnits,
    parseModel: parseCodexModel,
    parseResumeId: parseCodexResumeId,
    renderEvent: renderCodexEvent,
    // No non-stale alias layer to resolve a class into (see `VendorSpec`'s
    // own doc comment) — a real invocation's own configured model
    // (`codex doctor`) is a version-pinned string, not a "latest" alias.
    classModels: {}
  },
  gemini: {
    binary: 'gemini',
    // Verified against a real run, not assumed (the Issue's own trap): gemini
    // emits `init`, then a `message` per turn carrying `role`/`content`, then
    // a terminal `result` whose `stats` holds the token counts.
    // `-m, --model <string>` confirmed live via `gemini --help` — same bare,
    // unaliased shape as Codex's (contrast `--output-format`, which does
    // list `[choices: ...]` in the same help output).
    args: (model) => ['-p', '', ...(model ? ['--model', model] : []), '--output-format', 'stream-json', '--skip-trust'],
    resumeArgs: (id, model) => [
      '-p',
      '',
      '--resume',
      id,
      ...(model ? ['--model', model] : []),
      '--output-format',
      'stream-json',
      '--skip-trust'
    ],
    parseUsage: parseGeminiUsage,
    parseUsageUnits: parseGeminiUsageUnits,
    parseModel: parseGeminiModel,
    parseResumeId: parseGeminiResumeId,
    renderEvent: renderGeminiEvent,
    // No non-stale alias layer either — a real run's own default (confirmed
    // live) is a dated model string, not a "latest" alias.
    classModels: {}
  }
}

/**
 * Confirmed live, not assumed: `claude --model`'s own help text names
 * `fable`/`opus`/`sonnet` as aliases (haiku is the same family's fourth
 * tier), and its "full name" example (`claude-fable-5`) establishes the
 * `claude-` prefix every full Claude model name carries. A real `gemini`
 * run's own `stats.models` keys (`gemini-3.1-flash-lite`,
 * `gemini-3.5-flash`) confirm its own `gemini-`/`gemma-` prefix
 * (`gemini gemma` is a documented subcommand for the latter family).
 * Codex publishes no equivalent naming convention to check against — a real
 * run's own configured model (`codex doctor`: `gpt-5.6-sol`) is one instance,
 * not a rule, so Codex is never treated as a shape to detect, only as the
 * vendor a wrongly-shaped Claude/Gemini model can be refused FROM.
 */
const CLAUDE_MODEL_ALIASES = new Set(['fable', 'opus', 'sonnet', 'haiku'])

export function identifyVendorFromModelShape(model: string): AgentVendor | null {
  const lower = model.toLowerCase()
  if (CLAUDE_MODEL_ALIASES.has(lower) || lower.startsWith('claude-')) return 'claude'
  if (lower.startsWith('gemini-') || lower.startsWith('gemma-')) return 'gemini'
  return null
}

/**
 * A task's suggested agent-class resolved to this vendor's own concrete
 * model — `null` when this vendor has no verified, non-stale mapping
 * for that class (see `VendorSpec.classModels`'s own doc comment), never a
 * guessed model name.
 */
export function resolveClassModel(agent: AgentVendor, agentClass: AgentClass): string | null {
  return VENDOR_TABLE[agent].classModels[agentClass] ?? null
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
 * The generic launcher's own honest classification
 * — never `@attalabs/aeg-core`'s `normalizeOutcome`, which requires
 * `artifactsPresent`/`postconditionsMet` this generic function has no way to
 * check (that verification is a per-role caller's own concern, e.g. the
 * dev-review-loop's PR-open check — out of this file's boundary). Mirrors
 * the SAME manner-of-death precedence `normalizeOutcome` documents (refused,
 * then timed out, then crashed, take priority over a bare exit code), but
 * stops at `completed`/`incomplete` on the two signals this file actually
 * observes — a clean exit is `completed` here, the honest limit of what a
 * generic launcher can say; a caller with a real postcondition to check
 * reads this alongside its own, never as a replacement for it.
 */
export function classifyRoleAttemptOutcome(
  refused: boolean,
  timedOut: boolean,
  crashed: boolean,
  exitCode: number | null
): RoleAttemptOutcome {
  if (refused) return 'capability_refused'
  if (timedOut) return 'timed_out'
  if (crashed) return 'infrastructure_failed'
  return exitCode === 0 ? 'completed' : 'incomplete'
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
 * **`run_id` alone is not unique to one dispatch (a code-review finding).**
 * A dispatched role's own `vinaya dispatch` call (a nested
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
    }),
    inputVersions: () => opts.inputVersions
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
  const outboxPath = outboxPathFor({ outboxRoot: telemetryOutboxRoot }, repo, issue)

  const effectId = randomUUID()
  const vendor = VENDOR_TABLE[agent]
  const start = Date.now()
  /** Every lifecycle line this call writes goes through this one point — restyled, never re-prefixed. O6: also mirrored, plainly, to `opts.roleLogPath` when the caller named one. */
  const writeLifecycle = (msg: string): void => {
    process.stderr.write(`${colourLoopLine(msg, process.stderr)}\n`)
    if (opts.roleLogPath) appendRoleLine(opts.roleLogPath, role, msg)
  }
  const roundField = opts.round !== undefined ? { round: opts.round } : {}
  // O2: never the vendor name (`agent`) — that is the defect this task
  // closes. This is a REQUEST label, never an observation: `requested:<x>`
  // when a model was named, `'default'` when none was — both explicitly
  // marked placeholders for "here is what was asked for, not confirmed as
  // what ran," distinguishable on read from the bare, unprefixed model name
  // `outcomeModel` below records once the vendor's own receipt confirms it.
  // Used for every log line before the child's own report can be read
  // (`dispatched`, every `dispatch_failed` path) and as the fallback for
  // `outcome_received` when the vendor gives no receipt at all (Codex,
  // always; Claude/Gemini, on an unparseable payload).
  const resolvedModel = opts.model !== undefined ? `requested:${opts.model}` : 'default'

  // O1: persist the launch intent — run, attempt, role — BEFORE anything
  // else can spawn, refuse, or fail. From here on every exit path patches
  // this ONE record rather than writing a fresh one, so an interrupted
  // attempt keeps its intent (and any session id later bound onto it) instead
  // of losing session identity to the interruption. `dispatcherPid`/`host`
  // are the identity a pre-spawn attempt still has; `childPid`/`resumeId`
  // fill in only once the child is spawned and the stream reports its session.
  let launch: LaunchRecord = {
    runId,
    role,
    agent,
    repo,
    task: opts.task ?? null,
    pr: opts.pr ?? null,
    round: opts.round ?? null,
    attempt: nextAttempt(role, agent, repo, opts.task, opts.pr),
    effectId,
    dispatcherPid: process.pid,
    childPid: null,
    childStartedAt: null,
    childCommand: null,
    host: osHostname(),
    startedAt: new Date(start).toISOString(),
    status: 'launched',
    resumeId: null,
    boundAt: null,
    finishedAt: null,
    failureReason: null
  }
  /** Merge `patch` into the launch record and rewrite it durably — never throws (see `writeLaunchRecord`); a lost write degrades to a staler record, never a failed dispatch. */
  const patchLaunch = (patch: Partial<LaunchRecord>): void => {
    launch = { ...launch, ...patch }
    writeLaunchRecord(launch)
  }
  writeLaunchRecord(launch)

  // O4: refused before any spawn, by name, naming the vendor that rejected
  // it and what it accepts — never a bare rejection. Checked before the
  // binary-on-PATH check below so a wrongly-shaped model is refused even
  // when the vendor binary itself is present and executable.
  if (opts.model !== undefined) {
    const foreignVendor = identifyVendorFromModelShape(opts.model)
    if (foreignVendor !== null && foreignVendor !== agent) {
      const durationMs = Date.now() - start
      const priorSize = sizeOfSafe(outboxPath)
      log({
        kind: 'dispatch',
        event: 'dispatch_failed',
        payload: {},
        target_role: role,
        model: resolvedModel,
        ...roundField,
        effect_id: effectId,
        reason: 'refused',
        usage: null,
        duration_ms: durationMs
      })
      log({
        kind: 'role_attempt',
        event: 'attempted',
        payload: {},
        actor: agent,
        attempt: launch.attempt,
        effect_id: effectId,
        model: resolvedModel,
        outcome: classifyRoleAttemptOutcome(true, false, false, null),
        usage: null,
        duration_ms: durationMs
      })
      log({
        kind: 'usage',
        event: 'observed',
        payload: {},
        model: resolvedModel,
        source: agent,
        semantics: 'cumulative',
        units: NO_USAGE_UNITS,
        unknown_reason: 'dispatch refused before any vendor process started (model shape mismatch)',
        duration_ms: durationMs
      })
      writeLifecycle(
        `[vinaya dispatch ${effectId}] ${role} via ${agent}: refused — model '${opts.model}' is a ${foreignVendor} model; ` +
          `${agent} does not accept it. ${agent} accepts its own model names (never a ${foreignVendor} alias or a ` +
          `'${foreignVendor}-'/'gemma-' full name).`
      )
      patchLaunch({ status: 'interrupted', finishedAt: new Date().toISOString(), failureReason: 'refused' })
      await waitForDispatchLine(outboxPath, priorSize, runId, effectId, 'dispatch_failed')
      return {
        exitCode: null,
        durationMs,
        usage: null,
        resumeId: null,
        timedOut: false,
        failureReason: 'refused',
        effectId
      }
    }
  }

  const binaryPath = resolveExecutable(vendor.binary)
  if (binaryPath === null) {
    const durationMs = Date.now() - start
    const priorSize = sizeOfSafe(outboxPath)
    log({
      kind: 'dispatch',
      event: 'dispatch_failed',
      payload: {},
      target_role: role,
      model: resolvedModel,
      ...roundField,
      effect_id: effectId,
      reason: 'refused',
      usage: null,
      duration_ms: durationMs
    })
    log({
      kind: 'role_attempt',
      event: 'attempted',
      payload: {},
      actor: agent,
      attempt: launch.attempt,
      effect_id: effectId,
      model: resolvedModel,
      outcome: classifyRoleAttemptOutcome(true, false, false, null),
      usage: null,
      duration_ms: durationMs
    })
    log({
      kind: 'usage',
      event: 'observed',
      payload: {},
      model: resolvedModel,
      source: agent,
      semantics: 'cumulative',
      units: NO_USAGE_UNITS,
      unknown_reason: 'dispatch refused before any vendor process started (binary not resolvable on PATH)',
      duration_ms: durationMs
    })
    patchLaunch({ status: 'interrupted', finishedAt: new Date().toISOString(), failureReason: 'refused' })
    await waitForDispatchLine(outboxPath, priorSize, runId, effectId, 'dispatch_failed')
    return {
      exitCode: null,
      durationMs,
      usage: null,
      resumeId: null,
      timedOut: false,
      failureReason: 'refused',
      effectId
    }
  }

  const baseArgs = opts.resumeId ? vendor.resumeArgs(opts.resumeId, opts.model) : vendor.args(opts.model)
  // Computed here, once — both the settings-write fail-closed check below
  // and the boundary-resolution block further down read the SAME value,
  // never two independently-evaluated `loadConfig()` calls that could
  // observe a config change mid-dispatch and disagree with each other.
  const requireIsolation = loadConfig()?.dispatch?.requireWorkerIsolation ?? process.platform === 'darwin'
  // O1: claude only — see `writeDispatchSettings`'s own doc comment for why
  // Codex/Gemini are not silently included. Computed here, once, before the
  // 'dispatched' log line — moved up from inside the spawn `Promise`
  // so the SAME final `spawnArgs` (baseArgs plus `--settings`)
  // is what an unattended start's boundary resolution wraps below, rather
  // than wrapping a pre-settings argv and reconciling the two later.
  const documentationSources = documentationSourcesFromPrompt(role, prompt)
  if (agent !== 'claude' && documentationSources.some((s) => isDocumentationUrl(s.source))) {
    // round 2 security review, LOW — the PostToolUse/Stop hook
    // pair below is Claude-only, same limitation `deny-background-bash.mjs`
    // already has; unlike that hook, an unenforced Documentation obligation
    // is silent otherwise, so this dispatch names it rather than leaving
    // the operator to discover it only by a source never actually read.
    writeLifecycle(
      'vinaya dispatch-role: the Documentation read-gate (Issue #625, O2) is Claude-only — ' +
        `agent '${agent}' gets no WebFetch log/Stop hook, so this brief's URL-shaped ` +
        `'## Documentation' source(s) are not mechanically enforced for this dispatch.`
    )
  }
  // The directory a Developer's `Write`/`Edit` rules are
  // scoped to — the same `opts.cwd` precedence `boundaryAllowedDir` (below)
  // resolves from, but this policy is written on EVERY host and EVERY run
  // (unlike the Darwin/unattended-only OS boundary), so it needs a value even
  // when neither `opts.cwd` nor `repoRoot()` resolves — `process.cwd()` is
  // never wrong for a settings-file glob the way it would be for the OS
  // boundary's own hard refusal-on-unresolvable semantics (left untouched,
  // below, out of this task's own surface).
  const permissionAllowedDir = opts.cwd ?? repoRoot() ?? process.cwd()
  const dispatchSettingsPath =
    agent === 'claude'
      ? writeDispatchSettings(
          runId,
          documentationSources,
          scopeOf(opts.task, opts.pr),
          role,
          permissionAllowedDir,
          opts.extraWritableDirs ?? []
        )
      : null
  // The first lifecycle line this role's dispatch writes —
  // every earlier `writeLifecycle` call in this function sits behind an
  // early-return refusal branch (binary not resolvable, non-Claude
  // Documentation degrade) that a normal Claude dispatch never reaches.
  if (dispatchSettingsPath !== null) {
    writeLifecycle(
      `[vinaya dispatch ${effectId}] ${role} via ${agent}: permission policy ${PERMISSION_POLICY_VERSION} written to ${dispatchSettingsPath}`
    )
  }
  // Round 5 review, MEDIUM: an unattended, isolation-required Claude dispatch
  // whose settings write failed (a disk/permission fault under this task's
  // own hooks directory) previously dropped `--settings`
  // silently and launched anyway — the PreToolUse background-deny hook the
  // brief names a trap to preserve would never load, with no refusal and no
  // surfaced error, unlike O3's own boundary-unavailable path. Fail closed
  // here the same way: refuse before any spawn, exactly as the
  // binary-not-resolvable and boundary-unavailable refusals below do.
  if (agent === 'claude' && opts.unattended === true && requireIsolation && dispatchSettingsPath === null) {
    const durationMs = Date.now() - start
    const priorSize = sizeOfSafe(outboxPath)
    log({
      kind: 'dispatch',
      event: 'dispatch_failed',
      payload: {},
      target_role: role,
      model: resolvedModel,
      ...roundField,
      effect_id: effectId,
      reason: 'refused',
      usage: null,
      duration_ms: durationMs
    })
    writeLifecycle(
      `[vinaya dispatch ${effectId}] ${role} via ${agent}: refused — unattended start requires the PreToolUse ` +
        "background-deny hook's settings file, which could not be written into this task's own hooks directory"
    )
    patchLaunch({ status: 'interrupted', finishedAt: new Date().toISOString(), failureReason: 'refused' })
    await waitForDispatchLine(outboxPath, priorSize, runId, effectId, 'dispatch_failed')
    return {
      exitCode: null,
      durationMs,
      usage: null,
      resumeId: null,
      timedOut: false,
      failureReason: 'refused',
      effectId
    }
  }
  const spawnArgs = dispatchSettingsPath ? [...baseArgs, '--settings', dispatchSettingsPath] : baseArgs

  // O1/O3: an unattended start must run inside the proven
  // boundary — refused, before the 'dispatched' event and before any spawn,
  // when it cannot be established (`DispatchOpts.unattended`'s own doc
  // comment) — but only when `dispatch.requireWorkerIsolation` (`config.ts`)
  // resolves `true`, the "declared, visible setting" this tranche's
  // milestone names. Round 2 review, HIGH: an unconditional off-by-default
  // left O3's "fail closed" as opt-in everywhere, including the ONE
  // environment the boundary actually works on — the default is now
  // platform-conditional (`config.ts`'s own doc comment on this field):
  // `true` on Darwin (the declared supported environment, where nothing
  // needs to change for O3 to hold as the automatic default), `false`
  // elsewhere (where forcing it on would only ever refuse, never protect
  // anything, since no mechanism exists there yet). An explicit config value
  // always wins either way. This repo's own CI/operational host (Linux)
  // keeps today's exact behavior unless a repo explicitly opts in.
  let boundaryLaunch: ReturnType<typeof resolveWorkerBoundaryLaunch> | null = null
  let boundaryAllowedDir: string | null = null
  if (opts.unattended === true && requireIsolation) {
    // O2 (round 2 review, CRITICAL): when no real worktree exists yet
    // (`opts.cwd` omitted — the round-1 Developer bootstrap, whose own Step 0
    // is `git worktree add`), `boundaryAllowedDir` falls back to the shared
    // repo root — which must be READ-ONLY, never read+write, or a confined
    // Developer could rewrite `vinaya.config.json`/`aeg-root/` doctrine and
    // persistently defeat this very boundary (see
    // `WorkerBoundaryLaunchOpts.bootstrapWritableSubpaths`'s own doc
    // comment). Only the `developer` role's own bootstrap genuinely needs
    // `git worktree add`'s two write targets; any other role falling back to
    // the repo root (a Reviewer with no candidate built yet) gets a
    // read-only repo root and nothing else.
    const usingRepoRootFallback = opts.cwd === undefined
    boundaryAllowedDir = opts.cwd ?? repoRoot()
    boundaryLaunch =
      boundaryAllowedDir === null
        ? { ok: false, reason: 'no worktree/repo root could be resolved to confine this dispatch to' }
        : resolveWorkerBoundaryLaunch({
            binaryPath,
            args: spawnArgs,
            allowedDir: boundaryAllowedDir,

            // O1: claude only — the one vendor whose OAuth
            // credential shape `stageOAuthCredential` knows how to stage;
            // Codex/Gemini get no staging attempt (`oauthConfigDir` stays
            // `null` on the resolved launch, same as before this task).
            stageOAuthCredential: agent === 'claude',
            // Round 5 review, CRITICAL fix: scoped to THIS dispatch's own
            // exact FILE, never its containing directory. The round-4 fix
            // (scoping to the repo-segment DIRECTORY, `dirname(outboxPath)`/
            // `dirname(resumeRecordPathFor(...))`) closed the cross-repo
            // exposure but left every sibling task's outbox line and every
            // sibling role's own resume record in that SAME directory
            // (`outboxPathFor`/`resumeRecordPathFor` share one flat
            // directory per repo across every task and role) readable and
            // writable by this confined dispatch — verified live to include
            // a concurrently-running review's own resume record, whose
            // `resumeId` the vendor binary's own `--resume` flag accepts.
            // `vinayaHomeWritableFiles` grants exactly these two paths via
            // `(literal ...)`, never `(subpath ...)`, so no sibling file in
            // the shared directory is exposed. `writeLaunchRecord`'s own
            // `mkdirSync(dirname(path), { recursive: true })` still needs
            // that containing directory to exist — pre-created here, by the
            // TRUSTED, unsandboxed controller, the same way
            // `writeDispatchSettings` pre-creates its own directory before
            // this resolution runs, so the confined child's own
            // `mkdirSync(..., {recursive:true})` on an already-existing
            // directory needs only the `metadataOnlyDirs` traversal grant
            // this same resolution already derives from these paths' own
            // parents.
            extraWritableFiles: (() => {
              const resumePath = resumeRecordPathFor(role, agent, repo, opts.task, opts.pr)
              try {
                mkdirSync(dirname(outboxPath), { recursive: true })
              } catch {
                // best-effort — an unwritable destination is a pre-existing
                // condition this resolution's own later steps already handle
                // by narrowing what gets exposed, never by widening the
                // grant to compensate.
              }
              try {
                mkdirSync(dirname(resumePath), { recursive: true })
              } catch {
                // best-effort, same reasoning as above.
              }
              // Absolute, not relative to one root: the session record now
              // lives in this task's own folder under `runtimeDir`, which a
              // repository can configure anywhere, while the telemetry
              // outbox line stays under the Vinaya home. Two roots, so a
              // single base to resolve against can no longer name both.
              const files = [outboxPath, resumePath]
              // Round 6 review, security CRITICAL fix: `documentationLogHookScript`'s
              // own `PostToolUse` hook (`writeDispatchSettings`, above) appends one
              // line per `WebFetch` call to `documentation-log-<runId>.jsonl` inside
              // `dispatch-settings` — but that whole directory sits in
              // `vinayaHomeReadOnlySubdirs` below, read-only, since nothing else in
              // it is ever rewritten by the confined child. Live-reproduced: a write
              // into a read-only-granted directory fails `Operation not permitted`,
              // so the hook's own `try/catch` silently swallows it — every WebFetch
              // of a Documentation source goes unrecorded, `documentationStopHookScript`
              // always reads it as unfetched, and the Stop hook refuses forever,
              // exactly the fail-closed contract `roles/developer.md` describes but
              // never resolvable, breaking O3 for any confined developer whose brief
              // names a URL-shaped `## Documentation` source. Named here, alongside
              // the outbox/resume-record files, as the one file in that otherwise
              // read-only directory the confined child genuinely writes.
              if (dispatchSettingsPath) {
                files.push(join(dirname(dispatchSettingsPath), `documentation-log-${runId}.jsonl`))
              }
              return files
            })(),
            // Round 6 fix, live-reproduced: `extraWritableDirs`'s
            // own doc comment (above, on `DispatchOpts`) has the finding —
            // `dev-review-loop.ts`'s reviewer/security dispatch is the one
            // caller today, naming its own `reviewerWorkDir`, already
            // uniquely scoped per task/round/role/attempt.
            extraWritableDirs: opts.extraWritableDirs ?? [],
            // Round 4 review, BLOCKER: the confined child's own `--settings
            // <path>` argv (added above, before this resolution) points at
            // `writeDispatchSettings`'s `dispatch-settings` directory, which
            // was never carved into either list — a confined Claude dispatch
            // could not read the settings file it was handed. Read-only:
            // this directory is written by the trusted controller before
            // this resolution runs, and nothing inside the sandbox ever
            // needs to rewrite it.
            extraReadOnlyDirs: dispatchSettingsPath ? [dirname(dispatchSettingsPath)] : [],
            ...(usingRepoRootFallback
              ? { bootstrapWritableSubpaths: role === 'developer' ? ['.git', '.worktrees'] : [] }
              : {})
          })
    if (!boundaryLaunch.ok) {
      const durationMs = Date.now() - start
      const priorSize = sizeOfSafe(outboxPath)
      log({
        kind: 'dispatch',
        event: 'dispatch_failed',
        payload: {},
        target_role: role,
        model: resolvedModel,
        ...roundField,
        effect_id: effectId,
        reason: 'refused',
        usage: null,
        duration_ms: durationMs
      })
      writeLifecycle(
        `[vinaya dispatch ${effectId}] ${role} via ${agent}: refused — unattended start requires the worker isolation boundary, which is unavailable: ${boundaryLaunch.reason}`
      )
      patchLaunch({ status: 'interrupted', finishedAt: new Date().toISOString(), failureReason: 'refused' })
      await waitForDispatchLine(outboxPath, priorSize, runId, effectId, 'dispatch_failed')
      return { exitCode: null, durationMs, usage: null, resumeId: null, timedOut: false, failureReason: 'refused' }
    }

    // O2: the boundary resolved, but a confined `agent` child
    // still has no way to authenticate — no vendor API key on the parent's
    // own environment (`RUNTIME_CREDENTIAL_ENV_KEYS[agent]`), and no OAuth
    // session credential was found to stage (`boundaryLaunch.launch.oauthConfigDir`).
    // This is exactly this task's own Origin: a confined `claude` dispatch
    // on a subscription/OAuth-only Mac with no `ANTHROPIC_API_KEY` launched
    // anyway, tried OAuth/keychain (both denied by the boundary), and hung
    // silently to the dispatch ceiling with 0-byte output. Refuse here,
    // before any spawn, naming the reason — the same shape every other
    // pre-spawn refusal above already takes.
    const runtimeCredentialKeys = RUNTIME_CREDENTIAL_ENV_KEYS[agent] ?? []
    const hasRuntimeApiKey = runtimeCredentialKeys.some((key) => Boolean(process.env[key]))
    const hasStagedOAuthCredential = boundaryLaunch.launch.oauthConfigDir !== null
    if (!hasRuntimeApiKey && !hasStagedOAuthCredential) {
      const durationMs = Date.now() - start
      const priorSize = sizeOfSafe(outboxPath)
      log({
        kind: 'dispatch',
        event: 'dispatch_failed',
        payload: {},
        target_role: role,
        model: resolvedModel,
        ...roundField,
        effect_id: effectId,
        reason: 'refused',
        usage: null,
        duration_ms: durationMs
      })
      writeLifecycle(
        `[vinaya dispatch ${effectId}] ${role} via ${agent}: refused — unattended start inside the worker boundary has ` +
          `no resolvable credential (no ${runtimeCredentialKeys.length > 0 ? runtimeCredentialKeys.join('/') : 'known runtime env key'} ` +
          'set on the parent environment, and no OAuth session credential could be staged)'
      )
      boundaryLaunch.launch.cleanup()
      patchLaunch({ status: 'interrupted', finishedAt: new Date().toISOString(), failureReason: 'refused' })
      await waitForDispatchLine(outboxPath, priorSize, runId, effectId, 'dispatch_failed')
      return { exitCode: null, durationMs, usage: null, resumeId: null, timedOut: false, failureReason: 'refused' }
    }
  }

  {
    const priorSize = sizeOfSafe(outboxPath)
    log({
      kind: 'dispatch',
      event: 'dispatched',
      payload: {},
      target_role: role,
      model: resolvedModel,
      ...roundField,
      effect_id: effectId,
      prompt_hash: promptHashOf(prompt)
    })
    await waitForDispatchLine(outboxPath, priorSize, runId, effectId, 'dispatched')
  }

  const timeoutMs = loadConfig()?.dispatch?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const killGraceMs = loadConfig()?.dispatch?.killGraceMs ?? SIGKILL_GRACE_MS

  return new Promise<DispatchHandle>((resolve) => {
    // O1/O2: an unattended start with a resolved boundary spawns the WRAPPED
    // command (`sandbox-exec -f <profile> <binary> <args…>`) with a
    // NAMED-ALLOWLIST environment (`buildWorkerEnv` — never `{ ...process.env }`)
    // and `cwd` set to the exact directory the profile confines it to.
    // Attended dispatch (`boundaryLaunch === null`) keeps the pre-task-3
    // shape byte for byte: the real binary, the full parent environment,
    // `opts.cwd` only when the caller named one. `spawnArgs` (baseArgs plus
    // `--settings`, and `dispatchSettingsPath`/`documentationSources` behind
    // it) are computed once, above, before the boundary resolution — see
    // that computation's own comment for why.
    const resolvedBoundary = boundaryLaunch?.ok ? boundaryLaunch.launch : null
    const spawnCommand = resolvedBoundary ? resolvedBoundary.command : binaryPath
    const spawnCommandArgs = resolvedBoundary ? resolvedBoundary.args : spawnArgs
    const spawnCwd = resolvedBoundary ? (boundaryAllowedDir ?? opts.cwd) : opts.cwd
    const attribution = {
      VINAYA_RUN_ID: runId,
      VINAYA_ROLE: role,
      VINAYA_TASK: opts.task !== undefined ? String(opts.task) : undefined,
      VINAYA_ROUND: opts.round !== undefined ? String(opts.round) : undefined,
      // Round 2 review, MAJOR: the runtime directory THIS trusted controller
      // already resolved, so the child never resolves one of its own and the
      // two can never disagree. A child that re-derived it would reach a
      // different answer whenever `loadTrustAnchorConfig()` came back null
      // (gh offline or unauthenticated) — falling back to the default while
      // the controller honoured a configured value, and so reading a tree
      // nobody wrote to. It also saves the child a network round trip.
      [RUNTIME_DIR_ENV_KEY]: runtimeDirForRepo(repo)
    }
    const child = spawn(spawnCommand, spawnCommandArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(spawnCwd ? { cwd: spawnCwd } : {}),
      env: resolvedBoundary
        ? // O1 (round 2 review, BLOCKER): named-through by vendor, never a
          // blanket credential spread — `RUNTIME_CREDENTIAL_ENV_KEYS`'s own
          // doc comment records what is (Claude, `ANTHROPIC_API_KEY`,
          // verified live) and is not (Codex/Gemini, disclosed as unverified
          // on this host) confirmed.
          //
          // Round 2 security review, HIGH: `WORKER_ENV_ALLOWLIST_KEYS`
          // passes `TMPDIR` through from the parent unmodified, still naming
          // the real host temp base the profile never grants — only
          // `resolvedBoundary.tmpDir` (the profile's own scratch dir) is
          // read+write inside the confinement. `TMPDIR`/`TMP`/`TEMP` are
          // overridden here, in `attribution` (which always wins over the
          // allowlisted value, per `buildWorkerEnv`'s own doc comment), so a
          // confined `mkdir -p "$TMPDIR/x"` — a pattern common across
          // `bun install`/`npm`/most POSIX toolchains — resolves to a path
          // the profile actually grants.
          buildWorkerEnv(
            process.env,
            {
              ...attribution,
              TMPDIR: resolvedBoundary.tmpDir,
              TMP: resolvedBoundary.tmpDir,
              TEMP: resolvedBoundary.tmpDir,
              // O1: only set when a real OAuth session
              // credential was actually staged (`resolveWorkerBoundaryLaunch`'s
              // `stageOAuthCredential` opt, claude-only) — repoints the
              // confined child's own config-dir lookup at the staged COPY
              // (`worker-boundary.ts`'s `stageOAuthCredential`), never the
              // real, denied `<realHome>/.claude`. The key is omitted
              // entirely (not set to `undefined`) when nothing was staged,
              // so an API-key-only dispatch's env is unaffected.
              ...(resolvedBoundary.oauthConfigDir ? { CLAUDE_CONFIG_DIR: resolvedBoundary.oauthConfigDir } : {})
            },
            RUNTIME_CREDENTIAL_ENV_KEYS[agent] ?? []
          )
        : { ...process.env, ...attribution }
    })

    // O1/O3: bind the child's own identity onto the launch record right
    // after `spawn` returns it — this is what recovery probes to tell a
    // still-live launch from a finished one, so it must be durable even if
    // the driver dies in the very next tick (a crash between spawn and
    // session binding). The snapshot (O3) is taken via
    // `captureSettledChildSnapshot`, not a single immediate read: a vendor
    // CLI launched through a shebang (`#!/usr/bin/env node`) can still be
    // mid-exec the instant `spawn` returns, and a snapshot taken right then
    // can describe the launcher rather than the process that survives — see
    // that function's own doc comment. Recovery compares a LATER snapshot of
    // the same pid back against these two fields to tell this exact,
    // settled process apart from whatever the OS has since recycled the pid
    // for.
    if (typeof child.pid === 'number') {
      const snapshot = captureSettledChildSnapshot(child.pid)
      patchLaunch({
        childPid: child.pid,
        childStartedAt: snapshot?.startedAt ?? null,
        childCommand: snapshot?.command ?? null
      })
    }

    let settled = false
    let timedOut = false
    // Set synchronously the moment the OS reports the child has exited —
    // O5. This is read by the heartbeat below to stop reporting
    // elapsed time about a process that is gone; it is set well before
    // `finish()` runs (which only happens after `handleChildExit`'s own
    // awaits complete), closing the race the round-2 security review found:
    // `finish()` alone clearing the timer left a window where the heartbeat
    // could still fire once for an already-dead child.
    let childExited = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let stdoutBuf = ''
    const MAX_STDOUT_BYTES = 1_000_000

    // `'exit'` (below) can fire before the LAST already-in-flight `'data'`
    // chunk from the DIRECT child is delivered — the OS process-exit
    // notification and the pipe's own data delivery are two independent
    // event sources, and nothing orders one ahead of the other (CI, round
    // 3: observed live as an intermittent empty `usage`/`resumeId` on a
    // vendor that had already flushed a complete line before exiting).
    // `STDOUT_DRAIN_GRACE_MS` gives that last chunk a bounded chance to
    // land before `stdoutBuf` is read for `usage`/`resumeId` — resolved
    // immediately, with no added latency, the instant `'end'` actually
    // fires (the overwhelmingly common case for a child that closes its
    // own stdout); bounded rather than awaiting `'end'` outright so a
    // vendor's own grandchild inheriting and holding the pipe open (the
    // exact scenario `'exit'` was chosen over `'close'` to survive — see
    // that doc comment below) still returns promptly instead of hanging.
    let stdoutEnded = false
    const STDOUT_DRAIN_GRACE_MS = 200
    function waitForStdoutDrain(): Promise<void> {
      if (stdoutEnded) return Promise.resolve()
      return new Promise((res) => {
        const timer = setTimeout(res, STDOUT_DRAIN_GRACE_MS)
        child.stdout.once('end', () => {
          clearTimeout(timer)
          res()
        })
      })
    }

    const outputTee = openOutputTee(effectId, scopeOf(opts.task, opts.pr))
    if (outputTee.path !== null) {
      writeLifecycle(`[vinaya dispatch ${effectId}] ${role} via ${agent}: output teed to ${outputTee.path}`)
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
        // O1: bind the vendor session id onto the launch record the MOMENT the
        // stream first reports it — not only at exit — so an attempt the
        // driver's own death interrupts mid-turn still carries a resumable
        // session for recovery, instead of losing it to the interruption.
        // Bound once (`launch.resumeId === null` guards it); parsed per line
        // through the SAME vendor reader the exit path uses, never a second
        // shape. Wrapped so a binding failure can never end the run it observes.
        if (launch.resumeId === null) {
          try {
            const id = vendor.parseResumeId(line)
            if (id !== null) patchLaunch({ resumeId: id, boundAt: new Date().toISOString() })
          } catch {
            // not a session-bearing line — keep reading, never fatal
          }
        }
        try {
          const rendered = vendor.renderEvent(JSON.parse(line) as Record<string, unknown>)
          if (rendered) {
            const out = rendered
              .split('\n')
              .map((l) => colourAgentLine(role, l, process.stderr))
              .join('\n')
            process.stderr.write(`${out}\n`)
            // Security (round 2 review, HIGH): `rendered` is agent output, the
            // same untrusted-bytes hazard `openOutputTee`'s `redact` pass
            // exists for — route this sink through it too before it reaches disk.
            if (opts.roleLogPath) appendRoleLine(opts.roleLogPath, role, redact(rendered, homedir()))
          }
        } catch {
          // not a JSON line, or a renderer that refused it — never fatal
        }
      }
    })
    child.stdout.once('end', () => {
      stdoutEnded = true
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
    //
    // O5: verifies the child is actually still alive
    // (`childExited`) before reporting elapsed time, rather than measuring
    // wall-clock alone — a real production case measured a heartbeat that
    // kept printing "still running" at 60s/120s/180s/240s about a
    // `sandbox-exec` child whose vendor output stayed empty for its whole
    // life, because nothing here ever checked the child. `childExited` is
    // set synchronously the moment the `exit` event fires, below — this
    // guard is therefore self-clearing on the very next tick even in the
    // (already-closed) race window before `finish()` itself clears the
    // timer.
    const heartbeatTimer: ReturnType<typeof setInterval> = setInterval(() => {
      if (childExited) {
        clearInterval(heartbeatTimer)
        return
      }
      const elapsedS = Math.round((Date.now() - start) / 1000)
      writeLifecycle(
        `[vinaya dispatch ${effectId}] ${role} via ${agent}: still running — ${elapsedS}s elapsed (ceiling ${Math.round(timeoutMs / 1000)}s)`
      )
    }, HEARTBEAT_INTERVAL_MS)

    const warnLeadMs = timeoutWarningLeadMs(timeoutMs)
    const warnTimer: ReturnType<typeof setTimeout> = setTimeout(
      () => {
        writeLifecycle(
          `[vinaya dispatch ${effectId}] ${role} via ${agent}: approaching timeout — SIGTERM in ~${Math.round(warnLeadMs / 1000)}s unless it finishes first`
        )
      },
      Math.max(timeoutMs - warnLeadMs, 0)
    )

    const timeoutTimer = setTimeout(() => {
      timedOut = true
      writeLifecycle(`[vinaya dispatch ${effectId}] ${role} via ${agent}: ceiling reached — sending SIGTERM`)
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        writeLifecycle(
          `[vinaya dispatch ${effectId}] ${role} via ${agent}: still alive after SIGTERM — sending SIGKILL`
        )
        child.kill('SIGKILL')
      }, killGraceMs)
    }, timeoutMs)

    async function finish(handle: DispatchHandle, event: string, priorSize: number): Promise<void> {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      if (killTimer) clearTimeout(killTimer)
      clearInterval(heartbeatTimer)
      clearTimeout(warnTimer)
      outputTee.end()
      // O1: the boundary's own profile/scratch-dir temp files never outlive
      // the dispatch that created them — best-effort, matching every other
      // filesystem-bookkeeping concern in this file (`removeIfPresent`,
      // `reviewer-isolation.ts`'s own posture).
      resolvedBoundary?.cleanup()
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
      childExited = true
      clearInterval(heartbeatTimer)
      const durationMs = Date.now() - start
      const priorSize = sizeOfSafe(outboxPath)
      log({
        kind: 'dispatch',
        event: 'dispatch_failed',
        payload: {},
        target_role: role,
        model: resolvedModel,
        ...roundField,
        effect_id: effectId,
        reason: 'crash',
        usage: null,
        duration_ms: durationMs
      })
      log({
        kind: 'role_attempt',
        event: 'attempted',
        payload: {},
        actor: agent,
        attempt: launch.attempt,
        effect_id: effectId,
        model: resolvedModel,
        outcome: classifyRoleAttemptOutcome(false, false, true, null),
        usage: null,
        duration_ms: durationMs
      })
      log({
        kind: 'usage',
        event: 'observed',
        payload: {},
        model: resolvedModel,
        source: agent,
        semantics: 'cumulative',
        units: NO_USAGE_UNITS,
        unknown_reason: 'the vendor process errored before any output could be read',
        duration_ms: durationMs
      })
      // O1: an interrupted attempt keeps its intent record — patched, never
      // deleted; any session id already bound mid-stream is preserved by the
      // merge, so recovery can still resume it.
      patchLaunch({ status: 'interrupted', finishedAt: new Date().toISOString(), failureReason: 'crash' })
      void finish(
        { exitCode: null, durationMs, usage: null, resumeId: null, timedOut: false, failureReason: 'crash', effectId },
        'dispatch_failed',
        priorSize
      )
    })

    async function handleChildExit(code: number | null, durationMs: number): Promise<void> {
      // Bounded wait for any already-in-flight stdout chunk to land before
      // `stdoutBuf` is read below (`waitForStdoutDrain`'s own doc comment) —
      // `durationMs` was already captured at the real moment of exit, above,
      // unaffected by this wait.
      await waitForStdoutDrain()

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
      // The SAME survives-the-manner-of-death
      // treatment `usage` already gets, extended to the vendor's own model
      // receipt and the richer `usage`-family units — read once here, from
      // the same buffer, and reused by whichever branch below actually logs.
      const reportedModel = vendor.parseModel(stdoutBuf)
      const attemptModel = reportedModel ?? resolvedModel
      const usageUnits = vendor.parseUsageUnits(stdoutBuf)
      // O5: this dispatch never produced a working vendor
      // session — checked against the SAME two sources every other resumeId
      // read in this function already uses (the stream-bound `launch.resumeId`,
      // then a final read of the completed buffer), so "never bound" here
      // means exactly what it means everywhere else in this file.
      const neverBoundSession = launch.resumeId === null && vendor.parseResumeId(stdoutBuf) === null

      if (timedOut) {
        const priorSize = sizeOfSafe(outboxPath)
        log({
          kind: 'dispatch',
          event: 'dispatch_failed',
          payload: {},
          target_role: role,
          model: resolvedModel,
          ...roundField,
          effect_id: effectId,
          reason: 'timeout',
          usage,
          duration_ms: durationMs
        })
        log({
          kind: 'role_attempt',
          event: 'attempted',
          payload: {},
          actor: agent,
          attempt: launch.attempt,
          effect_id: effectId,
          model: attemptModel,
          outcome: classifyRoleAttemptOutcome(false, true, false, code),
          usage,
          duration_ms: durationMs
        })
        log({
          kind: 'usage',
          event: 'observed',
          payload: {},
          model: attemptModel,
          source: agent,
          semantics: 'cumulative',
          units: usageUnits.units,
          unknown_reason: usageUnits.unknownReason,
          duration_ms: durationMs
        })
        // O1: keep the intent record, and bind whatever session the child did
        // report before the ceiling killed it (mid-stream, or a final line in
        // `stdoutBuf`) — an interrupted attempt no longer loses its session.
        //
        // O5: a dispatch that never bound a session at all is
        // named `'unbound'` here, distinct from an ordinary `'timeout'` that
        // at least got a vendor session running — this is CLI-local
        // bookkeeping (`DispatchHandle.failureReason`/the launch record),
        // never the `dispatch_failed` log event's own `reason` field above
        // (that field's schema lives in `@attalabs/aeg-core`, out of this
        // task's surface, and keeps reporting the real event class —
        // `'timeout'` — unchanged).
        //
        // O2: `'connection-failed'` only when
        // a session WAS bound — a re-dispatch needs an exact session to
        // resume, and `'unbound'` already covers the no-session case with
        // its own, more specific meaning.
        const failureReason = neverBoundSession
          ? 'unbound'
          : sawVendorConnectionRetry(stdoutBuf)
            ? 'connection-failed'
            : 'timeout'
        if (neverBoundSession) {
          writeLifecycle(
            `[vinaya dispatch ${effectId}] ${role} via ${agent}: never produced a working vendor session before the ceiling was reached — failing now as 'unbound', not reporting further elapsed time`
          )
        }
        patchLaunch({
          status: 'interrupted',
          finishedAt: new Date().toISOString(),
          failureReason,
          resumeId: launch.resumeId ?? vendor.parseResumeId(stdoutBuf)
        })
        void finish(
          { exitCode: code, durationMs, usage, resumeId: null, timedOut: true, failureReason, effectId },
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
          model: resolvedModel,
          ...roundField,
          effect_id: effectId,
          reason: 'crash',
          usage,
          duration_ms: durationMs
        })
        log({
          kind: 'role_attempt',
          event: 'attempted',
          payload: {},
          actor: agent,
          attempt: launch.attempt,
          effect_id: effectId,
          model: attemptModel,
          outcome: classifyRoleAttemptOutcome(false, false, true, code),
          usage,
          duration_ms: durationMs
        })
        log({
          kind: 'usage',
          event: 'observed',
          payload: {},
          model: attemptModel,
          source: agent,
          semantics: 'cumulative',
          units: usageUnits.units,
          unknown_reason: usageUnits.unknownReason,
          duration_ms: durationMs
        })
        // O1: same as the timeout path — interrupted, intent kept, session
        // bound from whatever the child managed to report before it crashed.
        //
        // O5: same `'unbound'` distinction as the timeout branch
        // above — a child that exited on its own without ever binding a
        // session names that failure specifically, rather than the generic
        // `'crash'` every other non-zero exit gets.
        //
        // O2: same `'connection-failed'`
        // classification as the timeout branch above.
        const failureReason = neverBoundSession
          ? 'unbound'
          : sawVendorConnectionRetry(stdoutBuf)
            ? 'connection-failed'
            : 'crash'
        if (neverBoundSession) {
          writeLifecycle(
            `[vinaya dispatch ${effectId}] ${role} via ${agent}: exited (code ${code}) without ever producing a working vendor session — failing now as 'unbound'`
          )
        }
        patchLaunch({
          status: 'interrupted',
          finishedAt: new Date().toISOString(),
          failureReason,
          resumeId: launch.resumeId ?? vendor.parseResumeId(stdoutBuf)
        })
        void finish(
          { exitCode: code, durationMs, usage, resumeId: null, timedOut: false, failureReason, effectId },
          'dispatch_failed',
          priorSize
        )
        return
      }

      // O1: the session id, bound onto the launch record already if the stream
      // reported it mid-run, or read now from the completed buffer as the
      // fallback. The SAME record the launch intent was written to is marked
      // `completed`, never a fresh success-only record.
      const resumeId = launch.resumeId ?? vendor.parseResumeId(stdoutBuf)
      patchLaunch({
        status: 'completed',
        finishedAt: new Date().toISOString(),
        resumeId
      })
      if (resumeId !== null) {
        writeLifecycle(
          `[vinaya dispatch ${effectId}] ${role} via ${agent}: resumable — session recorded (attempt ${launch.attempt})`
        )
      }
      // O2: the vendor's own genuine receipt of what ran, read only now that
      // the child has actually produced output — never guessed from the
      // requested `--model` value, and always preferred over it when present,
      // even when no model was named at all (a vendor's own default is still
      // a real observation once reported). Falls back to the pre-completion
      // request label (`resolvedModel`) only when this vendor emits no
      // receipt (Codex, always) or the payload didn't parse.
      const priorSize = sizeOfSafe(outboxPath)
      log({
        kind: 'dispatch',
        event: 'outcome_received',
        payload: {},
        target_role: role,
        model: attemptModel,
        ...roundField,
        effect_id: effectId,
        // O1: no invented forge identifier — see module doc.
        outcome: { type: 'completed' },
        usage,
        duration_ms: durationMs
      })
      log({
        kind: 'role_attempt',
        event: 'attempted',
        payload: {},
        actor: agent,
        attempt: launch.attempt,
        effect_id: effectId,
        model: attemptModel,
        outcome: classifyRoleAttemptOutcome(false, false, false, code),
        usage,
        duration_ms: durationMs
      })
      log({
        kind: 'usage',
        event: 'observed',
        payload: {},
        model: attemptModel,
        source: agent,
        semantics: 'cumulative',
        units: usageUnits.units,
        unknown_reason: usageUnits.unknownReason,
        duration_ms: durationMs
      })
      void finish(
        { exitCode: code, durationMs, usage, resumeId, timedOut: false, effectId },
        'outcome_received',
        priorSize
      )
    }

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
      // Set BEFORE the async `handleChildExit` runs (O5) — the
      // heartbeat above reads this on its very next tick, which can land
      // before `handleChildExit`'s own awaits (and therefore `finish()`,
      // which also clears this timer) complete.
      childExited = true
      clearInterval(heartbeatTimer)
      void handleChildExit(code, Date.now() - start)
    })

    child.stdin.write(prompt)
    child.stdin.end()
  })
}
