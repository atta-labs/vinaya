# The Vinaya Log — header, families, and the outbox

Status: draft

One `log(e)`, one sink, one outbox per task. The full design is the Linear "Tech spec — The Vinaya Log"; this file is the durable, in-repo reference for what has shipped — the schema, the header, and the append — not a restatement of the whole spec.

## The envelope: `schema: 1` and `schema: 2` (`task-log-v1` 1)

`meta.schema` is a discriminated union. `1` is the original header — every field below in "The header, on every line," nothing more — and stays exactly as it was: a line already on disk, or a fixture recorded before `task-log-v1`, keeps parsing without a schema violation just because it predates the fields below. `buildHeader` (`packages/aeg-core/src/log/envelope.ts`) builds `2` for every event from this task forward; `1` is a read-side compatibility shape only, never something a caller asks `buildHeader` to produce.

`schema: 2` adds:

```
event_id: string        // stable per-event identity, generated once per log() call
process_id: string      // opaque per-process identifier — distinct from run_id, which
                         // correlates a whole dispatch chain across processes
actor_id: string | null // opaque, UNVALIDATED role/actor claim from the environment —
                         // deliberately not checked against ROLE_VALUES; a doctrine role
                         // name and a role this schema has never heard of are equally
                         // valid here. subject.role (unchanged) keeps its own closed
                         // Role-union-or-'unattributed' meaning — the two fields answer
                         // different questions at different trust levels.
lineage: {
  run: string | null       // this process's run identity — VINAYA_RUN when a caller sets
                           // one (devReviewLoop sets it to its own loop_id, task-log-v1
                           // task 6), else this process's own run_id (never null)
  attempt: number | null   // VINAYA_ATTEMPT
  parent: string | null    // VINAYA_PARENT_EVENT — the event_id this one continues from
}
input_versions: {
  objectives_version: string | null  // mirrors review-input-manifest.ts's field set —
  brief_hash: string | null          // independent of subject.objectives_version
  ruling_ordinal: number | null      // (kept, unchanged); a producer may set either,
  policy_digest: string | null       // both, or neither
}
provenance: 'parent_attributed' | 'env_correlated' | 'self_reported' | 'unavailable'
                         // trust ordering the spec names: parent-generated attribution
                         // is stronger than worker-controlled environment correlation;
                         // self-reported text proves no authorization. buildHeader never
                         // upgrades itself to 'parent_attributed' on its own — it derives
                         // 'env_correlated' when VINAYA_ROLE/VINAYA_TASK are present,
                         // else 'unavailable'; only a caller that structurally knows it
                         // just spawned this exact child (a future dispatch.ts change,
                         // not wired by this task) can assert a stronger value.
```

Every new field is declared here and honestly `null`/`'unavailable'` until a later task in this tranche (`control-store-v1`, `worker-isolation-v1`) starts setting it for real — "provenance fields are declared here, enforced later" (this task's own Planner rationale).

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

## The families shipped so far

`kind` is a closed union of `'dispatch' | 'dev_review_loop' | 'forge_write' | 'gate' | 'operation' | 'usage' | 'role_attempt' | 'handoff' | 'effect'`. `command`/`tokens` are still refused by name — `command` folds into `operation`, `tokens` into `usage`, so neither is a separate `kind`. Every event carries `duration_ms?` and a `payload` field; every family puts its real content in named top-level fields instead, so `payload` ships as an empty, `.strict()` object (an extra key inside it is still a schema violation).

**`dispatch`** — `target_role`, `model`, `round?`, `effect_id` on every event:

- `dispatched` — `prompt_hash`
- `outcome_received` — `outcome: DispatchOutcome` (a `type`-discriminated union: `pr_opened`, `round_pushed`, `verdict`, `escalation`, `brief`, `plan`, `archive`), `usage: { input, output } | null`
- `dispatch_failed` — `reason: 'timeout' | 'crash' | 'refused' | 'unattributed_write'`, `usage: { input, output } | null` — a run's token record survives the manner of its death: the parent parses whatever the child had already printed to stdout at the moment it ends the child (a SIGTERM/SIGKILL timeout, a non-zero exit), the same `stdoutBuf` a clean `outcome_received` reads, rather than hardcoding `null` on every non-clean exit. `null` here means the buffer genuinely carried no parseable usage line, not that the path never looked.

**`dev_review_loop`** — `loop_id` on every event, twelve events: `loop_started`, `round_started`, `gate_result_read`, `verdicts_read`, `findings_compared`, `stop_condition_met`, `paused`, `resumed`, `cancelled` (`task-log-v1` task 6, O2 — the `resolveEscalation(..., 'cancel', ...)` twin of `resumed`, always `by: 'principal'`: a cancel always requires an authenticated ruling, unlike a `resumed` bare infrastructure recovery), `unpushed_work_resume` (`branch`, `detail` — the driver's own mid-round resume of a developer who stopped without pushing, `doctrine-fixes-v1` task 1, `#543`, O2), `round_ended`, `journal_finalized`. Field-for-field these match the spec's §5.2 block exactly; this file does not re-list every field to avoid a second copy drifting from the source. `resumed.by` (`task-log-v1` task 6, O2) widens additively from the spec's `'principal'`-only literal to `'principal' | 'driver'`: a bare `--resume` past an `'infrastructure'` recoverable hiccup authenticates as the driver's own recovery (`resolveEscalation`'s `authenticatedBy: 'driver-self'`), never a ruling this run never actually read — `devReviewLoop` logs `resumed` once, right after `resolveEscalation` succeeds, before the round loop re-enters; `cancelDevReviewLoop` logs `cancelled` once, right before its own trailing flush.

**`forge_write`** (task 2, Issue #405) — `op: ForgeOpSchema` (`pr.create`, `pr.comment`, `pr.body.replace`, `pr.refreeze`, `issue.create`, `issue.edit`, `issue.comment`, `milestone.create`, `milestone.edit`, `milestone.close`, `label.add`, `label.remove`) and `target: { issue?: number; pr?: number }` on every event:

- `validated` — the payload passed its schema check, about to be posted
- `refused` — `reason: string`; the forge write failed (or a pre-flight check refused it)
- `written` — `comment_ids: string[]`; every comment id the forge returned

`vinaya log flush` (below) is the one caller today, using only `issue.comment`/`pr.comment`; the other ten ops are shaped for future forge-write call sites, not yet wired to one.

`dispatchRole` (task 3, `vinaya-log-v1`, Issue #406) is the `dispatch` family's real caller, in `apps/cli/src/lib/dispatch.ts` — not `dispatch-role.ts`, this file's own earlier forward-looking guess at the filename. `devReviewLoop`/`cancelDevReviewLoop` (`apps/cli/src/lib/dev-review-loop.ts`) are the `dev_review_loop` family's real callers.

**`effect`/`operation` real callers (`task-log-v1` task 6, O1).** `EffectExecutor` (`apps/cli/src/lib/effects.ts`) — the shared effect executor every idempotent forge write already runs through (`postPauseComment`/`postIssuePauseComment`, `pause-resume.ts`) — logs `effect` `attempted` before its poster runs, `observed` with the poster's own outcome (`'success' | 'failure' | 'uncertain'`) right after, and `verified` once the write is durably recorded; an idempotent replay of an already-`'verified'` record logs `verified` again with no new `attempted`, and a reconciliation that comes back `'ambiguous'` logs `observed` with `outcome: 'uncertain'` rather than silently doing nothing — a gap is a line in the log, never a fabricated success. `effect_id` is the SAME control-store key the write's own retry identity is keyed on, so every line for one write — across a crash, a retry, an idempotent replay — shares one identity. The broker (`apps/cli/src/lib/broker.ts`) logs one `operation` event for `authenticateWorkerInvocation`/`authenticateOperatorInvocation` (`operation: 'authenticate-invocation'`) and one for `requestEffect`'s own grant/target/replay checks (`operation`/`target` from the request), `result: 'ok'` when every check passes, `'refused'` naming the throwing error's own class otherwise — before ever reaching the effect executor's own sequence.

**`dispatchRole`'s own `outcome_received` lines carry a placeholder `outcome`.** `DispatchOutcomeSchema`'s seven variants each require role/action-specific identifying data (a PR number, a head sha, a comment id) that a generic headless launcher cannot honestly produce from an exit code and a vendor's own usage blob alone. Until the schema gains a variant for "completed, no specific forge outcome recorded here," a successful dispatch's `outcome_received` line carries `{ type: 'plan', issues: [] }` — the one member satisfiable with no invented identifier — and this must not be read as "a plan was cut." See `apps/cli/src/lib/dispatch.ts`'s own module doc for the full reasoning.

**Review finding metadata (`task-log-v1` 1)** — a `verdict` outcome's `findings` array widens additively. The pre-existing `id`/`severity`/`state?` shape stays exactly as it was (`id` is this finding's identity AS REPORTED in one round's comment — stable within that comment only; a reviewer's own positional numbering is never advertised as stable across rounds). New, all optional: `severity_scale` (a free string, not a closed enum — this doctrine already has two, code-review's and security's, and a third reviewer type should never need a schema change to name its own), `policy_treatment` (`'blocking' | 'non_blocking' | 'unavailable'` — a separate fact from `severity`: the same reported severity can bind or not bind a verdict depending on the effective review policy's threshold at review time), `confidence` (`0..1`, self-reported, never treated as calibrated correctness), `confidence_scale`, `confidence_source`. None of the four are required — an old finding missing them all still parses.

## Six more families (`task-log-v1` 1)

Additive to the three above — nothing about `dispatch`/`dev_review_loop`/`forge_write` changed. Every one of these six carries `meta`/`subject` (the same versioned envelope) and `.strict()` payloads, same as before.

- **`gate`** — one gate runner's attempted check: `check`, `check_version`, `policy_version`, `input_fingerprint`, one event `checked` with `outcome: 'pass' | 'fail' | 'wait' | 'skip' | 'invalid_input' | 'unavailable_dependency' | 'timeout' | 'cancelled'` and an optional `reason`.
- **`operation`** — a normalized operation/tool call (the spec's "command dispatcher"): `operation`, `target`, one event `completed` with `result: 'ok' | 'error' | 'refused' | 'timeout' | 'cancelled' | 'unavailable'` and `error_class`. Never raw secret-bearing arguments — `redact()` still runs over the full event regardless.
- **`usage`** — the spec's "usage collector": `model`, `source`, `semantics: 'cumulative' | 'delta'`, one event `observed` with `units: { input, output, cache }` (each `nonnegative().nullable()` — unknown usage is `null`, never coerced to `0`) and `unknown_reason`.
- **`role_attempt`** — a role ATTEMPT's own normalized outcome, distinct from `dispatch`'s parent-side view of dispatching one: `actor` (opaque, NOT `RoleSchema` — this family is not limited to the closed doctrine `Role` union), `attempt`, one event `attempted` with `outcome: 'completed' | 'incomplete' | 'infrastructure_failed' | 'cancelled' | 'timed_out' | 'capability_refused'` and the same nullable `usage` shape `dispatch_failed` already uses. Named `role_attempt`, not `role`, so it never collides with this module's own `Role`/`RoleSchema` export.
- **`handoff`** — a human handoff/escalation, raised then resolved: `class` (`'authority' | 'strategy' | 'product'`, reusing `dispatch`'s own `escalation` outcome enum rather than inventing a second name for the identical concept), `reason`; `raised` carries `requested_decision`, `resolved` carries `resolution`/`resolved_by` — two disjoint `.strict()` shapes, not one shape with everything optional.
- **`effect`** — the spec's "shared effect executor": a generic external effect's `attempted`/`observed`/`verified` outcome (`'success' | 'failure' | 'uncertain'` on the latter two), keyed by `effect_id` and an opaque `target: { kind, ref }`. Additive to, and does not replace, `forge_write` above, which stays exactly as it was — one specific effect this schema does not yet generalize `forge_write` into. Fail-open observation only ("telemetry never substitutes for required intent," the spec's own words) — never the fail-closed control store `control-store-v1` adds.

## The storage contract (`task-log-v1` task 2, Issue #562)

`packages/aeg-core/src/log/store.ts` is the typed storage contract the sink and the flush share: one `LogStore` interface — `append`, `readPage`, `acknowledge`, `size` — plus the pure helpers both backends build on (`recordIdentity`, `classifyStoredLine`, `readPageFrom`) and a deterministic in-memory fixture backend (`createFixtureStore`). It is policy-layer pure — no filesystem, no network, no process (`apps/cli/specs/surface.md` "The rule") — so the adversarial fault cases below are provable against the fixture with no I/O.

<!-- AEG:CLAIM: packages/aeg-core/src/log/store.ts contains:export interface LogStore -->

- **Stable identity across retry, concurrent append and a lost acknowledgement (O2).** `recordIdentity` reads a `schema: 2` line's `event_id` (generated once per `log()` call), falling back to `${run_id}:${seq}` for a `schema: 1` line — the same pair the flush's `<!-- aeg:log:… -->` marker is keyed on. `append` is idempotent by that identity: re-appending an already-stored batch is a no-op (reported in `AppendOutcome.duplicates`), so a retry after a lost acknowledgement collapses to one record rather than a duplicate.
- **Acknowledged records alone are removed (O2).** `acknowledge(identities)` removes exactly the identities it is handed — never a positional truncation that could drop a record the forge never confirmed.
- **Overflow is reported, not silent (O2).** A capacity-bounded store's `append` returns an `OverflowDiagnostic` naming the dropped identities — the observable loss the outbox rotation's single overwritten `<name>.1.ndjson` slot never surfaced.
- **Read-back validates version and provenance, and keeps unknown-version records (O3).** `classifyStoredLine` / `readPage` run the full `LogEventSchema` (validating a `schema: 2` line's provenance), re-apply `redact()` at the read (transport) boundary, and — for a line whose `meta.schema` is outside `KNOWN_SCHEMA_VERSIONS` (`1`, `2`) — return an `unknown_version` record that keeps the line verbatim for diagnosis rather than dropping it or failing the whole page. A known version that fails validation is `invalid` (corrupt), a distinct outcome from `unknown_version`.

**Both backends implement the contract.** The deterministic fixture backend (`createFixtureStore`) is the in-memory twin the tests exercise (`packages/aeg-core/src/log/store.test.ts`). The GitHub adapter behind `vinaya log flush` (`apps/cli/src/lib/log-flush.ts`) is the real one: the sink's append (below) is its write side, `classifyStoredLine` its read/transport-redaction side, and its marker-keyed truncation its acknowledgement side. Redaction runs at BOTH boundaries — `log()` redacts before the append (sink), `classifyStoredLine` redacts again before a post (transport) — so a secret is filtered even if one boundary's pattern set has a gap.

## The outbox

One file per task Issue under the machine-local home `~/.vinaya/` already used by `config.json` and `tokens-collect-trust.json` — never in the repository (doctrine forbids task state in the tree; per-task worktrees would fragment a repo-local file):

```
~/.vinaya/outbox/<owner>-<repo>/<issue-or-none>.ndjson
~/.vinaya/outbox/unresolved/<issue-or-none>.ndjson   // when the origin remote cannot be resolved
```

`<issue-or-none>` is `subject.issue` when it resolved to a number, else the literal `none`. The append is hardened the same way the Stop hook's own scratch-then-rename write is, adapted for an append rather than a full-file replace (a rename would drop every earlier line): `mkdirSync(dir, { recursive: true, mode: 0o700 })`; `lstatSync` the target and refuse — write nothing — when it exists and is not a regular file or is a symlink; `openSync(path, 'a', 0o600)` and one `writeSync` ending in `\n`; close. The file rotates to `<name>.1.ndjson` (overwriting an older one) once it crosses 8 MiB, before the append that would have exceeded it — one rotation slot, not a numbered series.

Before that overwrite, `reportRotationOverflow` reads whatever the existing `<name>.1.ndjson` backup holds and reports the loss (O2): each line's identity via the storage contract's own `recordIdentity`, folded into an `OverflowDiagnostic` (`{ reason: 'capacity', dropped, droppedIdentities }`), emitted through the sink's one-per-process `warn`. No prior backup (the first-ever rotation) reports nothing.

<!-- AEG:CLAIM: apps/cli/src/lib/log-sink.ts contains:function reportRotationOverflow( -->

`log()` never throws. Every failure path — an invalid payload, an unwritable directory, a symlinked target — returns without writing, and at most one line reaches `process.stderr` per process, guarded by a module-level flag: a broken outbox must never spam a gate or redden a check.

## The flush

The flush's own body — chunking, posting, the audit trail, truncation — is `flushOutbox` (`apps/cli/src/lib/log-flush.ts`), a lib function that takes an Issue or pull-request target and returns what it posted; it never calls `process.exit`, so it is safe to call in-process as well as from a one-shot command (task 3, Issue #482, O1). `vinaya log flush --issue <n> | --pr <n>` (`apps/cli/src/commands/log.ts`) is argv parsing around it: exactly one of `--issue`/`--pr` is required, and the command translates `flushOutbox`'s return value and thrown `LogFlushError` into this process's exit code and stdout/stderr. `--pr <n>` resolves the Issue from that PR's body `Closes #N` line — the same anchor every gate reads (`extractIssue`) — and refuses with a check error naming the missing line when the body carries none; it then flushes that Issue's outbox but posts the comments on the PR. The outbox stays keyed by Issue only, never by PR — `--pr` is a routing convenience over the same file `--issue` would read.

The developer review loop's round-end flush (`apps/cli/specs/loop.md`) calls `flushOutbox` the same way, in-process — never `vinaya log flush` as a subprocess of its own CLI entry, which `apps/cli/specs/surface.md`'s "commands never call commands" rule forbids as much through a child process as through a direct call. `commands/dispatch.ts`'s own trailing flush (`--task`/`--pr`) calls the identical function directly too, for the identical reason. Both callers catch a thrown `LogFlushError` and treat it as non-fatal — a flush failure never undoes the effect that produced the lines still waiting to be flushed.

Each comment opens with, on its own line:

```
<!-- aeg:log:<run_id>:<seq_from>-<seq_to> -->
```

followed by a blank line and one fenced block tagged `ndjson`, one outbox line per line, verbatim. Splitting happens in two passes: first at `run_id` boundaries — a maximal run of *consecutive* lines sharing one `run_id`, never a global group-by-run_id — then, within each such run, at the size limit `FORGE_COMMENT_MAX_CHARS = 65536` (a chunk closes before adding the next line would push it, plus the marker and fence overhead, past the limit). Splitting at consecutive-only boundaries is what keeps every chunk's `seqFrom-seqTo` genuinely contiguous even when two run_ids interleave in the file: two runs of the same `run_id` separated by another run_id's lines become two separate chunks, never one range that silently spans the gap. A single outbox line too large to fit in one comment by itself is refused by its seq, never split across two comments. Several comments per flush are the normal case, not the exception.

**Idempotent retry (`task-log-v1` task 2, Issue #562, O2).** The retriable one-shot `vinaya log flush` command opts into an idempotency read (`flushOutbox`'s `skipRemotelyAccepted` option): before posting, it reads the target's existing comments once and collects every `<!-- aeg:log:<run_id>:<seq_from>-<seq_to> -->` marker already on the forge. A chunk whose marker is already present was accepted by a prior attempt that died before truncating (a lost acknowledgement); the retry acknowledges it — truncates its lines — without posting a second copy, closing the "flush retries can repeat remotely accepted batches" defect. The read is tolerant: a forge-read failure falls back to posting everything (its pre-fix behavior), because telemetry never blocks the governed effect. The in-process driver callers (the round-end flush, `dispatch.ts`'s trailing flush) leave the option OFF — they already read the task's comments through their own `fetchLoopHistory`, so this path adds no second forge read to a loop round.

**Order, and why:** before any post, the flush's own line is written through `log()` — `kind: 'forge_write', event: 'validated'` — into the very outbox it is about to flush, landing there before truncation. Each chunk is then posted with `gh issue comment`/`gh pr comment --body-file <tmp>` (`<tmp>` written with the `wx` flag, removed in `finally`; the body is never passed on argv). After the last chunk succeeds, one `written` line (`comment_ids`: every id gh returned) is logged the same way; if any chunk fails, one `refused` line (`reason`: gh's stderr, verbatim) is logged instead and no further chunks are attempted. Only then is the outbox truncated — to exactly the original lines never confirmed posted, plus everything appended to the live file since the flush started (the `validated`/`written`/`refused` line just logged, and anything a concurrent process appended meanwhile). A gh failure therefore leaves every unposted original line in place; a fully successful flush leaves only its own `validated`/`written` lines, which ride to the next flush. A symlinked or non-regular-file outbox is refused the same way the sink refuses to write one — `lstat`, never a stat-then-open race.

`log()` fills `subject.issue` from `VINAYA_TASK`, never from an argument, and is fire-and-forget (`resolveRepo().then(...)`, no returned promise) — so the flush's own `validated`/`written`/`refused` lines land in the correct outbox only because the flush scopes `VINAYA_TASK` to the Issue it is flushing for the duration of each call, restoring whatever value the calling process's own `VINAYA_TASK` carried before — load-bearing for an in-process caller like the loop's round-end flush, which sets `VINAYA_TASK` to its own task for the whole run and must see that value restored, not the flushed Issue's, once the call returns. A microtask/macrotask drain (`setImmediate`) was tried and abandoned — it proved unreliable across hosts (passed under `node` on the built CLI, failed under `bun` running the TS source directly). What actually ships instead:
<!-- AEG:CLAIM: apps/cli/src/lib/log-flush.ts contains:async function waitForOwnLine( -->
polling the outbox file for its own line to land (`waitForOwnLine`, bounded at 2000ms) — matched on this process's own `run_id` (`currentRunId()`, exported from `log-sink.ts`) plus the expected `kind`/`event`/`op`/`target`, not merely "the file grew," since an unrelated concurrent `vinaya` process appending to the same outbox at the same moment would otherwise trip a bare size check with a line that isn't this call's own. A timeout on the pre-post `validated` line refuses the whole flush before anything is posted; a timeout on the post-post `written`/`refused` line only warns — truncation still runs, since skipping it there would risk re-posting already-successful comments on the next flush.

## Attribution

`VINAYA_RUN_ID`, `VINAYA_ROLE`, `VINAYA_TASK`, `VINAYA_ROUND` are read from `process.env` by the sink, never passed as an argument — a caller cannot override its own attribution. Absent: `role: 'unattributed'`, `issue: null`, a `run_id` generated once per process (`crypto.randomUUID()`). `host` is `'ci'` when `GITHUB_ACTIONS` is set, else `'hook'`/`'loop'` from `VINAYA_HOST`, else `'cli'`. A session not started through `vinaya dispatch` (task 3, shipped) is `unattributed`, which is the truth about it — the same class of honesty as `role: 'unattributed'` anywhere else in this doctrine.

`VINAYA_RUN`, `VINAYA_ATTEMPT`, `VINAYA_PARENT_EVENT` (`task-log-v1` 1) are read the same way, into `meta.lineage` on a `schema: 2` header. `VINAYA_ATTEMPT`/`VINAYA_PARENT_EVENT` read back `null` on every current line, honestly, until a later task sets them.

**`lineage.run` (`task-log-v1` task 6, O1/O2).** `devReviewLoop` sets `VINAYA_RUN` to its own run's `loop_id` at the very top of `runDevReviewLoopBody`, before this process logs a single line — every `dev_review_loop` event it emits AND every `effect`/`operation` event a downstream call into `effects.ts`/`broker.ts` fires in the SAME process (a pause post, an escalation write) therefore share one `lineage.run`, which is this task's own title made literal: "one correlated history." A caller that never sets `VINAYA_RUN` still gets an honest, non-`null` value — the sink defaults `lineage.run` to this process's own `run_id` (already the identity every line this process writes shares via `meta.run_id`) rather than leaving the slot `null` for want of an opt-in producer. A DIFFERENT process — a `--resume` continuing a paused run, a `--cancel` invocation, a driver re-exec — mints its own fresh `loop_id`/`run_id` and therefore its own `lineage.run`, distinct from whatever process paused it: `lineage.run` correlates one PROCESS's own lines, not a task's entire cross-restart history (`subject.issue`, unchanged, is what already ties every process's lines to the same task).

`vinaya dispatch <role> --agent claude|codex|gemini` (`apps/cli/src/lib/dispatch.ts`) is the real mechanism: it sets all four variables on the CHILD process's environment only — via `spawn`'s own `env` option, never by mutating the parent's `process.env` — and separately calls `createLogSink({ env: () => ({ ...process.env, VINAYA_ROLE, VINAYA_TASK, VINAYA_ROUND }) })` once per dispatch so its OWN `dispatched`/`outcome_received`/`dispatch_failed` lines carry the same attribution without ever touching the parent's real environment. `--task` is optional: given, the line's `issue` is that number; absent, `issue: null` and `role` still comes from the `<role>` argument — never `unattributed`, since the role is always known at the point of dispatch. The child inherits the SAME `run_id` the parent's three lines used, so every `vinaya` call the child makes in turn (its own Stop hook, a nested dispatch) joins under it.

## Redaction

`redact(value, home)` (pure — `home` is passed in, never read under `packages/aeg-core/src/log/`) walks every string field: a GitHub token (`gho_`, `ghp_`, `github_pat_`) or an `Authorization: Bearer <token>` value becomes `<redacted>`; an absolute path under `home` is rewritten to `~/…`. Applied to the full event, header included, before it is serialized to the outbox line.
