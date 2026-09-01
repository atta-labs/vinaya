#!/usr/bin/env bun

/**
 * report-tokens — **the Claude Code collection adapter** for AEG's
 * token-report obligation, and only that. `aeg-root/tranche-model.md` §12
 * splits the obligation into three layers: every role reports its own turn's
 * usage (layer 1, portable), by whatever means its host offers (layer 2,
 * host-specific), into the `Tokens: …` grammar in the artifact its turn
 * produced (layer 3, portable). **This file is one instance of layer 2.**
 *
 * That means a repo running some other agent host is not missing anything by
 * not having this script. It satisfies the same obligation by reading its own
 * harness's usage figures — a session log, a usage field on an API response,
 * a meter the harness exposes, or an operator supplying the numbers — and
 * writing the same line. Doctrine cites this path as an example, never as the
 * requirement; if you find a doc that reads otherwise, the doc is the defect.
 *
 * What this adapter knows that nothing portable may: Claude Code writes each
 * session's transcript as JSONL with a per-assistant-message `usage` object,
 * and hands every hook its path as `transcript_path`. The JSONL parsing lives
 * in `../src/claude-code-transcript.ts` (host-coupled, like this file); the
 * rendering it feeds (`formatTokensLine`, `formatBreakdown`) and the grammar
 * that reads the result back (`src/parse-token-report.ts`) are portable and
 * shared by every host. The `bin/` vs `src/` split does not mark that seam —
 * `TranscriptSummary` does.
 *
 * Historical note (misc-hardening-v1 task 1, #675): this adapter exists
 * because §12 once claimed a role reports exact tokens "from `/cost`" — an
 * operator-typed slash command no unattended agent session can invoke. §12
 * records that retraction.
 *
 * Thin I/O shim: resolves the transcript path, reads it, and calls the pure
 * functions homed in `@attalabs/aeg-core`. Mirrors `bin/archive-task.ts`'s
 * split (I/O here, pure logic in `src/`).
 *
 * **Two ways in, both first-class.** `--transcript <path>` names the
 * transcript outright and is the whole of the resolution when given — the
 * right route whenever the caller already knows which transcript is theirs,
 * and the only route in a repo that installs no Claude Code hooks. Otherwise
 * the adapter reads a pointer file written by a `track-transcript.sh` Stop
 * hook, keyed by `CLAUDE_PROJECT_DIR`. It deliberately never scans
 * `~/.claude/projects/<slug>/` for the newest file: that breaks the moment
 * two worktrees run concurrent sessions, since whichever session wrote last
 * would win regardless of which one asked.
 */

import { createHash } from 'node:crypto'
import { summarizeTranscript } from '../src/claude-code-transcript'
import { hardenedMeteringDeps } from '../src/metering-io-guard'
import { formatBreakdown, formatTokensLine } from '../src/report-tokens'

/**
 * Collapses every run of non-alphanumeric characters to a single `-`. Kept
 * (unchanged) as the readable prefix of a pointer key and as the sole
 * derivation for a pre-migration (legacy) pointer filename — see
 * `legacyTranscriptPointerPath`. On its own it is not collision-resistant:
 * `/a/b` and `/a-b` both collapse to `-a-b` (`#315`). Exported because this
 * file's own tests exercise it directly.
 */
export function sanitizeKey(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, '-')
}

/**
 * Collision-resistant (`#315`), matching
 * `../src/claude-code-transcript.ts`'s `collisionResistantKey` byte-for-byte
 * (deliberately duplicated, not imported — see `transcriptPointerPath`'s own
 * doc comment in that file for why `bin/` cannot be imported from `src/`).
 * See that file's `collisionResistantKey` for the full reasoning on why the
 * digest is full-length, not truncated.
 */
function collisionResistantKey(value: string): string {
  const digest = createHash('sha256').update(value).digest('hex')
  return `${sanitizeKey(value)}-${digest}`
}

/**
 * The PRIMARY (post-migration, `#315`) pointer path — collision-resistant.
 * `resolveTranscriptPath` also consults `legacyTranscriptPointerPath` as a
 * fallback, so a pointer a not-yet-upgraded `track-transcript.sh` (or one
 * written before this fix shipped) already has on disk is still found
 * rather than orphaned.
 */
export function transcriptPointerPath(projectDir: string, tmpDir: string): string {
  return `${tmpDir}/claude-transcript-${collisionResistantKey(projectDir)}.txt`
}

/**
 * The pre-`#315` pointer filename — `sanitizeKey` alone, collision-prone.
 * Never the primary read target going forward; consulted only when
 * `transcriptPointerPath` is absent.
 */
function legacyTranscriptPointerPath(projectDir: string, tmpDir: string): string {
  return `${tmpDir}/claude-transcript-${sanitizeKey(projectDir)}.txt`
}

export type ResolveDeps = {
  env: Record<string, string | undefined>
  cwd: string
  exists: (path: string) => boolean
  readFile: (path: string) => string
}

/**
 * Resolves the transcript path to read. `--transcript <path>` (or a bare
 * positional path) wins outright and is a normal, supported route, not a
 * fallback: the caller has told us exactly which transcript is theirs, which
 * is strictly better evidence than any inference we could make. Only when no
 * path is given does this consult the Stop-hook pointer file.
 *
 * Throws rather than falling back to a `—` line. A `—` is sanctioned only for
 * an operator-metered role — one whose host exposes no usage to the agent at
 * all (`aeg-root/tranche-model.md` §12) — and such a role never invokes this
 * adapter. Reaching this code means the host *does* expose usage, so an
 * unresolvable transcript is a wiring problem to report, never a blank to
 * emit.
 *
 * A worktree reused across sessions (e.g. a Developer re-entry after
 * `CHANGES_REQUESTED`, `aeg-root/roles/developer.md`) can hold a pointer
 * file written by a *previous* session that hasn't been overwritten yet —
 * the new session's own Stop hook only fires after its first turn
 * completes. Reading that stale pointer silently would reproduce, one
 * session later, the exact wrong-session-attribution failure this reporter
 * exists to prevent. `CLAUDE_CODE_SESSION_ID` (set in every Claude Code
 * Bash tool call — confirmed empirically, not documented in the public hook
 * schema, so treated as a best-effort cross-check, never the primary
 * resolution path) lets the resolver catch this: when it disagrees with the
 * pointer's own stored session id, that pointer is stale and the resolver
 * throws rather than emit plausible-looking wrong numbers. When it's unset,
 * there is nothing to cross-check against, so the pointer is trusted as
 * before.
 */
export function resolveTranscriptPath(explicit: string | undefined, deps: ResolveDeps): string {
  if (explicit) return explicit

  const projectDir = deps.env.CLAUDE_PROJECT_DIR ?? deps.cwd
  const tmpDir = deps.env.TMPDIR ?? '/tmp'
  const primaryPointerPath = transcriptPointerPath(projectDir, tmpDir)
  const legacyPointerPath = legacyTranscriptPointerPath(projectDir, tmpDir)

  // `#315` migration: the primary (collision-resistant) path wins when both
  // exist. The legacy path is consulted ONLY when the primary is absent, so
  // a pointer written before this fix shipped is still found, not orphaned.
  const pointerPath = deps.exists(primaryPointerPath)
    ? primaryPointerPath
    : deps.exists(legacyPointerPath)
      ? legacyPointerPath
      : undefined

  if (!pointerPath) {
    throw new Error(
      `No transcript pointer at ${primaryPointerPath} (nor its pre-migration name ${legacyPointerPath}), ` +
        'so this adapter has nothing to auto-resolve. ' +
        'Name the transcript directly instead — `--transcript <path>` is a fully supported route, not a ' +
        'workaround, and is the normal one here. Your session transcript is the JSONL file the harness ' +
        'passes hooks as `transcript_path` (typically under ~/.claude/projects/<project-slug>/). ' +
        'The pointer is optional convenience: it exists only in repos that install a ' +
        "`track-transcript.sh` Stop hook, and even there it is absent until this session's first turn " +
        'completes. The hook may equally be configured in your own host settings rather than in the repo, so a repo that installs none of its own may still have a pointer. Lacking one is not a defect.'
    )
  }

  const contents = deps.readFile(pointerPath).trim()
  const [pointerSessionId, transcriptPath] = contents.split('\t')
  if (!transcriptPath) {
    throw new Error(`Transcript pointer file ${pointerPath} is malformed: "${contents}"`)
  }

  const currentSessionId = deps.env.CLAUDE_CODE_SESSION_ID
  if (currentSessionId && pointerSessionId && currentSessionId !== pointerSessionId) {
    throw new Error(
      `Transcript pointer at ${pointerPath} is stale: it was written for session ${pointerSessionId}, ` +
        `but this session is ${currentSessionId}. A previous session's Stop hook wrote this pointer, and this ` +
        "session's own Stop hook hasn't fired yet (it fires after your first turn completes). Name your own " +
        'transcript with `--transcript <path>` — a supported route, not a workaround — rather than reporting ' +
        "another session's figures as yours."
    )
  }

  return transcriptPath
}

export type ParsedArgs = {
  phase: string
  role: string
  model: string | undefined
  transcriptPath: string | undefined
}

export function parseArgs(argv: string[]): ParsedArgs {
  let phase: string | undefined
  let role: string | undefined
  let model: string | undefined
  let transcriptPath: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--phase') phase = argv[++i]
    else if (arg === '--role') role = argv[++i]
    else if (arg === '--model') model = argv[++i]
    // `--transcript <path>` is the named form of the bare positional below.
    // Both are first-class: naming your own transcript is the primary route
    // wherever the caller knows it, and the only one in a repo that installs
    // no Stop hook to write a pointer. The positional stays supported so
    // existing invocations keep working.
    else if (arg === '--transcript') transcriptPath = argv[++i]
    else if (arg && !arg.startsWith('--')) transcriptPath = arg
  }

  if (!phase || !role) {
    throw new Error(
      'Usage: bun packages/aeg-core/bin/report-tokens.ts --phase "<task-id>: develop" --role Developer ' +
        '[--model <id>] [--transcript <path> | <transcript-path>]\n' +
        '  --transcript  Read this transcript directly. Supported primary route — use it whenever you know\n' +
        '                which transcript is yours, and always in a repo with no track-transcript.sh hook.\n' +
        '  (omitted)     Resolve via the Stop-hook pointer file, if this repo installs that hook.'
    )
  }

  return { phase, role, model, transcriptPath }
}

export function main(argv: string[], deps: ResolveDeps): void {
  const { phase, role, model, transcriptPath } = parseArgs(argv)
  const resolvedPath = resolveTranscriptPath(transcriptPath, deps)
  const jsonl = deps.readFile(resolvedPath)
  const summary = summarizeTranscript(jsonl)

  // A zero-message summary (empty file, unparseable content, or a transcript
  // not yet flushed to disk) is indistinguishable, once formatted, from a
  // real session that genuinely spent 0 tokens — `formatTokensLine` takes
  // its numeric branch either way. Fail loud here instead, the same
  // discipline `resolveTranscriptPath` already applies to a missing
  // pointer: an unusable transcript is a wiring problem to report, not a
  // plausible-looking `0/0/—` to paste into a PR body.
  if (summary.messageCount === 0) {
    throw new Error(
      `Transcript at ${resolvedPath} yielded zero assistant messages with usage data — it's empty, ` +
        'unparseable, or not yet flushed to disk. Nothing to report; re-run once the session has produced at ' +
        'least one turn.'
    )
  }

  console.error(`[report-tokens] transcript: ${resolvedPath}`)
  console.error(formatBreakdown(summary))
  console.log(formatTokensLine({ phase, role, summary, modelOverride: model }))
}

if (import.meta.main) {
  main(process.argv.slice(2), hardenedMeteringDeps())
}
