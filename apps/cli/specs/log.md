# The Vinaya Log — header, families, and the outbox

Status: draft

One `log(e)`, one sink, one outbox per task. The full design is the Linear "Tech spec — The Vinaya Log" (rev 4), §5, §8, §9, §20; this file is the durable, in-repo reference for what shipped in `vinaya-log-v1` task 1 — the schema, the header, and the append — not a restatement of the whole spec.

`packages/aeg-core/src/log/` is the policy layer: the zod schema (`LogEventSchema`), the pure envelope builder (`buildHeader`), and `redact`. No filesystem, no network, no process (`surface.md` "The rule"). `apps/cli/src/lib/log-sink.ts` is the one write: every environment read, remote read, package read, hostname and git call lives there, and it is the only file that opens the outbox path — proved by `apps/cli/tests/lib/log-callers.test.ts`.

## The header, on every line

```
meta: {
  schema: 1
  ts: string          // ISO 8601, UTC, millisecond precision
  run_id: string       // VINAYA_RUN_ID; generated per process when absent
  seq: number          // per-process counter from 0; a reader sorts by this, never by file position
  repo: string | null  // 'owner/name' from the origin remote; null when it cannot be resolved
  vinaya: string       // the CLI version that wrote the line
  doctrine: string     // 'aeg-root@<sha>' for a tree checkout, the package version for a bundle, 'unknown' when git is unreachable
  host: 'hook' | 'ci' | 'cli' | 'loop'
  machine: string      // sha256 of the hostname; never the name itself
}
subject: {
  issue: number | null          // VINAYA_TASK; null when absent or unparseable
  pr?: number
  sha?: string
  role: Role | 'unattributed'   // VINAYA_ROLE; never self-declared by the caller
  round?: number                // VINAYA_ROUND
  objectives_version?: string   // deviation from the spec's `number` — vinaya-log-v1 task 1
                                 // (PR #423) hashes the objectives block to a sha256 hex string
}
```

`Role` is the doctrine-facing spelling from the spec's Role union: `planner | developer | code-reviewer | security | principal | archivist | architect` — not the `roles/*.md` filenames `resolveDoctrineRootInfo` resolves those names to.

## The three families shipped so far

`kind` is a closed union of `'dispatch' | 'dev_review_loop' | 'forge_write'` — the other three families (`gate`, `command`, `tokens`) are out of scope here and refused by the schema. Every event carries `duration_ms?` and a `payload` field; every family puts its real content in named top-level fields instead, so `payload` ships as an empty, `.strict()` object (an extra key inside it is still a schema violation).

**`dispatch`** — `target_role`, `model`, `round?`, `effect_id` on every event:

- `dispatched` — `prompt_hash`
- `outcome_received` — `outcome: DispatchOutcome` (a `type`-discriminated union: `pr_opened`, `round_pushed`, `verdict`, `escalation`, `brief`, `plan`, `archive`), `usage: { input, output } | null`
- `dispatch_failed` — `reason: 'timeout' | 'crash' | 'refused' | 'unattributed_write'`, `usage: { input, output } | null` — a run's token record survives the manner of its death: the parent parses whatever the child had already printed to stdout at the moment it ends the child (a SIGTERM/SIGKILL timeout, a non-zero exit), the same `stdoutBuf` a clean `outcome_received` reads, rather than hardcoding `null` on every non-clean exit. `null` here means the buffer genuinely carried no parseable usage line, not that the path never looked.

**`dev_review_loop`** — `loop_id` on every event, ten events: `loop_started`, `round_started`, `gate_result_read`, `verdicts_read`, `findings_compared`, `stop_condition_met`, `paused`, `resumed`, `round_ended`, `journal_finalized`. Field-for-field these match the spec's §5.2 block exactly; this file does not re-list every field to avoid a second copy drifting from the source.

**`forge_write`** (task 2, Issue #405) — `op: ForgeOpSchema` (`pr.create`, `pr.comment`, `pr.body.replace`, `pr.refreeze`, `issue.create`, `issue.edit`, `issue.comment`, `milestone.create`, `milestone.edit`, `milestone.close`, `label.add`, `label.remove`) and `target: { issue?: number; pr?: number }` on every event:

- `validated` — the payload passed its schema check, about to be posted
- `refused` — `reason: string`; the forge write failed (or a pre-flight check refused it)
- `written` — `comment_ids: string[]`; every comment id the forge returned

`vinaya log flush` (below) is the one caller today, using only `issue.comment`/`pr.comment`; the other ten ops are shaped for future forge-write call sites, not yet wired to one.

`dispatchRole` (task 3, `vinaya-log-v1`, Issue #406) is the `dispatch` family's real caller, in `apps/cli/src/lib/dispatch.ts` — not `dispatch-role.ts`, this file's own earlier forward-looking guess at the filename. `devReviewLoop` (the `dev_review_loop` chokepoint) lands in a later task; that family still ships with zero real callers, proved by the same test that will fail on the first caller outside `apps/cli/src/lib/dispatch.ts` and `apps/cli/src/lib/dev-review-loop.ts`.

**`dispatchRole`'s own `outcome_received` lines carry a placeholder `outcome`.** `DispatchOutcomeSchema`'s seven variants each require role/action-specific identifying data (a PR number, a head sha, a comment id) that a generic headless launcher cannot honestly produce from an exit code and a vendor's own usage blob alone. Until the schema gains a variant for "completed, no specific forge outcome recorded here," a successful dispatch's `outcome_received` line carries `{ type: 'plan', issues: [] }` — the one member satisfiable with no invented identifier — and this must not be read as "a plan was cut." See `apps/cli/src/lib/dispatch.ts`'s own module doc for the full reasoning.

## The outbox

One file per task Issue under the machine-local home `~/.vinaya/` already used by `config.json` and `tokens-collect-trust.json` — never in the repository (doctrine forbids task state in the tree; per-task worktrees would fragment a repo-local file):

```
~/.vinaya/outbox/<owner>-<repo>/<issue-or-none>.ndjson
~/.vinaya/outbox/unresolved/<issue-or-none>.ndjson   // when the origin remote cannot be resolved
```

`<issue-or-none>` is `subject.issue` when it resolved to a number, else the literal `none`. The append is hardened the same way the Stop hook's own scratch-then-rename write is, adapted for an append rather than a full-file replace (a rename would drop every earlier line): `mkdirSync(dir, { recursive: true, mode: 0o700 })`; `lstatSync` the target and refuse — write nothing — when it exists and is not a regular file or is a symlink; `openSync(path, 'a', 0o600)` and one `writeSync` ending in `\n`; close. The file rotates to `<name>.1.ndjson` (overwriting an older one) once it crosses 8 MiB, before the append that would have exceeded it — one rotation slot, not a numbered series.

`log()` never throws. Every failure path — an invalid payload, an unwritable directory, a symlinked target — returns without writing, and at most one line reaches `process.stderr` per process, guarded by a module-level flag: a broken outbox must never spam a gate or redden a check.

## The flush

`vinaya log flush --issue <n> | --pr <n>` (`apps/cli/src/commands/log.ts`) posts a target's outbox as one or more comments and truncates only what the forge confirmed. Exactly one of `--issue`/`--pr` is required. `--pr <n>` resolves the Issue from that PR's body `Closes #N` line — the same anchor every gate reads (`extractIssue`) — and refuses with a check error naming the missing line when the body carries none; it then flushes that Issue's outbox but posts the comments on the PR. The outbox stays keyed by Issue only, never by PR — `--pr` is a routing convenience over the same file `--issue` would read.

Each comment opens with, on its own line:

```
<!-- aeg:log:<run_id>:<seq_from>-<seq_to> -->
```

followed by a blank line and one fenced block tagged `ndjson`, one outbox line per line, verbatim. Splitting happens in two passes: first at `run_id` boundaries — a maximal run of *consecutive* lines sharing one `run_id`, never a global group-by-run_id — then, within each such run, at the size limit `FORGE_COMMENT_MAX_CHARS = 65536` (a chunk closes before adding the next line would push it, plus the marker and fence overhead, past the limit). Splitting at consecutive-only boundaries is what keeps every chunk's `seqFrom-seqTo` genuinely contiguous even when two run_ids interleave in the file: two runs of the same `run_id` separated by another run_id's lines become two separate chunks, never one range that silently spans the gap. A single outbox line too large to fit in one comment by itself is refused by its seq, never split across two comments. Several comments per flush are the normal case, not the exception.

**Order, and why:** before any post, the flush's own line is written through `log()` — `kind: 'forge_write', event: 'validated'` — into the very outbox it is about to flush, landing there before truncation. Each chunk is then posted with `gh issue comment`/`gh pr comment --body-file <tmp>` (`<tmp>` written with the `wx` flag, removed in `finally`; the body is never passed on argv). After the last chunk succeeds, one `written` line (`comment_ids`: every id gh returned) is logged the same way; if any chunk fails, one `refused` line (`reason`: gh's stderr, verbatim) is logged instead and no further chunks are attempted. Only then is the outbox truncated — to exactly the original lines never confirmed posted, plus everything appended to the live file since the flush started (the `validated`/`written`/`refused` line just logged, and anything a concurrent process appended meanwhile). A gh failure therefore leaves every unposted original line in place; a fully successful flush leaves only its own `validated`/`written` lines, which ride to the next flush. A symlinked or non-regular-file outbox is refused the same way the sink refuses to write one — `lstat`, never a stat-then-open race.

`log()` fills `subject.issue` from `VINAYA_TASK`, never from an argument, and is fire-and-forget (`resolveRepo().then(...)`, no returned promise) — so the flush's own `validated`/`written`/`refused` lines land in the correct outbox only because the flush scopes `VINAYA_TASK` to the Issue it is flushing for the duration of each call. A microtask/macrotask drain (`setImmediate`) was tried and abandoned — it proved unreliable across hosts (passed under `node` on the built CLI, failed under `bun` running the TS source directly). What actually ships instead:
<!-- AEG:CLAIM: apps/cli/src/commands/log.ts contains:async function waitForOwnLine( -->
polling the outbox file for its own line to land (`waitForOwnLine`, bounded at 2000ms) — matched on this process's own `run_id` (`currentRunId()`, exported from `log-sink.ts`) plus the expected `kind`/`event`/`op`/`target`, not merely "the file grew," since an unrelated concurrent `vinaya` process appending to the same outbox at the same moment would otherwise trip a bare size check with a line that isn't this call's own. A timeout on the pre-post `validated` line refuses the whole flush before anything is posted; a timeout on the post-post `written`/`refused` line only warns — truncation still runs, since skipping it there would risk re-posting already-successful comments on the next flush.

## Attribution

`VINAYA_RUN_ID`, `VINAYA_ROLE`, `VINAYA_TASK`, `VINAYA_ROUND` are read from `process.env` by the sink, never passed as an argument — a caller cannot override its own attribution. Absent: `role: 'unattributed'`, `issue: null`, a `run_id` generated once per process (`crypto.randomUUID()`). `host` is `'ci'` when `GITHUB_ACTIONS` is set, else `'hook'`/`'loop'` from `VINAYA_HOST`, else `'cli'`. A session not started through `vinaya dispatch` (task 3, shipped) is `unattributed`, which is the truth about it — the same class of honesty as `role: 'unattributed'` anywhere else in this doctrine.

`vinaya dispatch <role> --agent claude|codex|gemini` (`apps/cli/src/lib/dispatch.ts`) is the real mechanism: it sets all four variables on the CHILD process's environment only — via `spawn`'s own `env` option, never by mutating the parent's `process.env` — and separately calls `createLogSink({ env: () => ({ ...process.env, VINAYA_ROLE, VINAYA_TASK, VINAYA_ROUND }) })` once per dispatch so its OWN `dispatched`/`outcome_received`/`dispatch_failed` lines carry the same attribution without ever touching the parent's real environment. `--task` is optional: given, the line's `issue` is that number; absent, `issue: null` and `role` still comes from the `<role>` argument — never `unattributed`, since the role is always known at the point of dispatch. The child inherits the SAME `run_id` the parent's three lines used, so every `vinaya` call the child makes in turn (its own Stop hook, a nested dispatch) joins under it.

## Redaction

`redact(value, home)` (pure — `home` is passed in, never read under `packages/aeg-core/src/log/`) walks every string field: a GitHub token (`gho_`, `ghp_`, `github_pat_`) or an `Authorization: Bearer <token>` value becomes `<redacted>`; an absolute path under `home` is rewritten to `~/…`. Applied to the full event, header included, before it is serialized to the outbox line.
