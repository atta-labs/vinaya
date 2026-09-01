// Emitter for the Claude Code Stop hook that records each session's
// transcript pointer (task 10, #278) — the fact
// `packages/aeg-core/bin/report-tokens.ts`'s `resolveTranscriptPath()` needs
// to resolve capable in a fresh Claude Code adopter, not just in a repo that
// happens to carry its own hand-rolled equivalent (attalabs' own
// `.claude/hooks/track-transcript.sh`, never installed by vinaya itself).
//
// Two artifacts, two different never-clobber mechanisms, because they are
// different KINDS of file:
//
//   - `.claude/hooks/track-transcript.sh` is a marker-delimited managed
//     block — the exact mechanism `pre-commit`/`pre-push`/`commit-msg`
//     already use (lib/ops.ts's `ManagedBlockOp`). An adopter's existing
//     file at this path (e.g. a hand-rolled script doing the same job) keeps
//     its own lines; vinaya's block is appended, never a clobber. This is
//     the fourth managed-block host directory (`config.ts`'s
//     `CANONICAL_HOOK_BLOCK_PREFIXES` gains `.claude/hooks/` alongside
//     `.git/`, `.husky/`, `.vinaya/hooks/` — same discipline, one more
//     prefix, not a new mechanism).
//
//   - `.claude/settings.json` is refuse-if-foreign (`CreateFileOp`, the same
//     mechanism `.claude/commands/vinaya.md` already uses): strict JSON has
//     no comment syntax, so the marker-delimited convention cannot apply to
//     it without inventing a bespoke JSON-merge mechanism this task's Sizing
//     does not call for and that risks corrupting adopter-owned keys
//     (permissions, other hooks, env). A fresh adopter — no `settings.json`
//     yet, exactly the Part-4 scratch-repo proof — gets it written with the
//     Stop hook wired. An adopter who already has a `settings.json` is left
//     untouched, exactly like every other refused artifact, with the
//     install diff's standard refusal messaging as the guidance for wiring
//     it in by hand.

import type { CreateFileOp, ManagedBlockOp } from './ops.js'

export const CLAUDE_STOP_HOOK_GROUP = 'Claude Code Stop hook (transcript pointer)'

/** Stable id for the managed block inside the script file. */
export const CLAUDE_STOP_HOOK_MARKER = 'track-transcript'

/**
 * The canonical filename `report-tokens.ts`'s own docstring already names
 * ("a pointer file written by a `track-transcript.sh` Stop hook") — reused
 * verbatim, not invented here.
 */
export const CLAUDE_STOP_HOOK_SCRIPT_PATH = '.claude/hooks/track-transcript.sh'

export const CLAUDE_SETTINGS_PATH = '.claude/settings.json'

// Same preamble string as `artifacts.ts`'s private `HOOK_PREAMBLE` — kept as
// its own literal rather than imported, to avoid a circular import between
// this file and `artifacts.ts` (which imports `buildClaudeStopHookOps` from
// here) for one shared one-line constant.
const SH_PREAMBLE = '#!/usr/bin/env sh\n'

/**
 * The managed block's body (no shebang — `SH_PREAMBLE` supplies that only
 * when the host file is created fresh). Uses `node`, never `jq`: every
 * machine that can run `vinaya` at all already has node on PATH (the
 * generated git hooks assume the same via `npx`), so this adds no new
 * dependency the way a `jq`-based script would.
 *
 * Pointer FORMAT — session id and transcript path, tab-separated — and the
 * key algorithm (`sanitizeKey`'s `[^A-Za-z0-9]+` collapsed to one `-`, then
 * `-` plus a full SHA-256 hex digest of the uncollapsed `projectDir`) match
 * `packages/aeg-core/bin/report-tokens.ts`'s `sanitizeKey`/
 * `collisionResistantKey`/`transcriptPointerPath` byte-for-byte, confirmed by
 * reading that file's parser directly (Dig, task 10; re-confirmed `#315`,
 * which added the digest suffix — before it, distinct project directories
 * whose `sanitizeKey` output collapsed to the same string shared one pointer
 * file). Concatenation (`+`), not template interpolation, so `tmpDir`'s own
 * value (including a trailing slash, which `TMPDIR` commonly carries) is
 * reproduced exactly as `report-tokens.ts`'s own naive
 * `${tmpDir}/claude-transcript-...` concatenation does — neither side strips
 * it, so both sides agree on the same (possibly double-slashed, and that's
 * fine — the OS collapses it) path string.
 *
 * `#315` migration: this writer always writes the NEW (collision-resistant)
 * pointer name — never the pre-`#315` legacy name. The read side
 * (`resolveMeteringCapability`/`resolveTranscriptPath`) still falls back to
 * the legacy name when the new one is absent, so a pointer an unupgraded
 * copy of this same script already wrote stays readable; this writer itself
 * never needs to touch that legacy name.
 *
 * Never fails loudly: a hook whose job is optional convenience (the
 * probe/reporter degrade to `--transcript <path>` without it) must not turn
 * a missing `node`, a malformed hook payload, or a write failure into a
 * blocked `Stop` — `exit 0` unconditionally at the end, matching the
 * pre-existing hand-rolled `track-transcript.sh` this mirrors.
 *
 * Symlink-attack hardening (CWE-59, security review on this task's own PR):
 * the pointer path is fully predictable — a pure function of
 * `CLAUDE_PROJECT_DIR`/cwd and `TMPDIR` — in a directory (`/tmp` or
 * `TMPDIR`) other local users/processes on the same machine can typically
 * write to. A plain `fs.writeFileSync(pointerPath, ...)` opens with the
 * default `'w'` flag, which FOLLOWS an existing symlink and truncates
 * whatever it points at — a co-resident process that pre-plants a symlink
 * at the pointer path before a Stop event fires turns this hook into a
 * write primitive against anything the victim's OS user can write to.
 * Fixed the standard way: write the real content to a same-directory
 * scratch file opened with `wx` (`O_CREAT|O_EXCL`, explicit `0o600` mode —
 * refuses to write through an existing file OR symlink at the scratch
 * path), then `renameSync` it onto the pointer path. `rename(2)` replaces
 * the destination's directory entry atomically and does NOT dereference a
 * symlink sitting there — it unlinks the symlink itself and puts the real
 * file in its place, never writing through to the symlink's target. The
 * scratch filename carries the pid and a random suffix purely to avoid
 * colliding with a concurrent legitimate invocation, not as the security
 * boundary — `wx` is what makes even a fully predictable scratch name safe.
 */
export function renderTrackTranscriptScriptBody(): string {
  return `# Vinaya-managed Stop hook. Records this session's transcript_path (and
# session_id) so the token-report adapter can resolve it without scanning
# ~/.claude/projects/ for the newest file, which silently grabs another
# concurrent session's transcript when two worktrees are active at once.
node -e '
const fs = require("fs")
let data = ""
process.stdin.on("data", (c) => { data += c })
process.stdin.on("end", () => {
  let hook
  try {
    hook = JSON.parse(data)
  } catch {
    return
  }
  if (!hook.transcript_path) return
  const crypto = require("crypto")
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd()
  const tmpDir = process.env.TMPDIR || "/tmp"
  const digest = crypto.createHash("sha256").update(projectDir).digest("hex")
  const key = projectDir.replace(/[^A-Za-z0-9]+/g, "-") + "-" + digest
  const pointerPath = tmpDir + "/claude-transcript-" + key + ".txt"
  const content = (hook.session_id || "") + "\\t" + hook.transcript_path + "\\n"
  const scratchPath = pointerPath + "." + process.pid + "." + Math.random().toString(36).slice(2) + ".tmp"
  try {
    fs.writeFileSync(scratchPath, content, { mode: 0o600, flag: "wx" })
  } catch {
    return
  }
  try {
    fs.renameSync(scratchPath, pointerPath)
  } catch {
    try { fs.unlinkSync(scratchPath) } catch {}
  }
})
'
exit 0`
}

/**
 * `.claude/settings.json` seed — written only when the file does not exist
 * yet (refuse-if-foreign, see module doc). `$CLAUDE_PROJECT_DIR` is Claude
 * Code's own substitution, resolved at hook-run time, not here.
 */
export function renderClaudeSettingsWithStopHook(): string {
  const settings = {
    $schema: 'https://json.schemastore.org/claude-code-settings.json',
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: `$CLAUDE_PROJECT_DIR/${CLAUDE_STOP_HOOK_SCRIPT_PATH}`,
              timeout: 5
            }
          ]
        }
      ]
    }
  }
  return `${JSON.stringify(settings, null, 2)}\n`
}

/** Build the two ops for the Stop-hook artifact. */
export function buildClaudeStopHookOps(): [ManagedBlockOp, CreateFileOp] {
  return [
    {
      kind: 'managed-block',
      path: CLAUDE_STOP_HOOK_SCRIPT_PATH,
      marker: CLAUDE_STOP_HOOK_MARKER,
      body: renderTrackTranscriptScriptBody(),
      comment: 'hash',
      hostPreamble: SH_PREAMBLE,
      mode: 0o755,
      group: CLAUDE_STOP_HOOK_GROUP
    },
    {
      kind: 'create-file',
      path: CLAUDE_SETTINGS_PATH,
      content: renderClaudeSettingsWithStopHook(),
      group: CLAUDE_STOP_HOOK_GROUP
    }
  ]
}
