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

`Role` is the doctrine-facing spelling from the spec's Role union: `planner | brief-author | developer | code-reviewer | security | principal | archivist | architect` — not the `roles/*.md` filenames `resolveDoctrineRootInfo` resolves those names to.

## The two families this task ships

`kind` is a closed union of `'dispatch' | 'dev_review_loop'` — the other four families (`gate`, `forge_write`, `command`, `tokens`) are out of scope here and refused by the schema. Every event carries `duration_ms?` and a `payload` field; both families put their real content in named top-level fields instead, so `payload` ships as an empty, `.strict()` object (an extra key inside it is still a schema violation).

**`dispatch`** — `target_role`, `model`, `round?`, `effect_id` on every event:

- `dispatched` — `prompt_hash`
- `outcome_received` — `outcome: DispatchOutcome` (a `type`-discriminated union: `pr_opened`, `round_pushed`, `verdict`, `escalation`, `brief`, `plan`, `archive`), `usage: { input, output } | null`
- `dispatch_failed` — `reason: 'timeout' | 'crash' | 'refused' | 'unattributed_write'`

**`dev_review_loop`** — `loop_id` on every event, ten events: `loop_started`, `round_started`, `gate_result_read`, `verdicts_read`, `findings_compared`, `stop_condition_met`, `paused`, `resumed`, `round_ended`, `journal_finalized`. Field-for-field these match the spec's §5.2 block exactly; this file does not re-list every field to avoid a second copy drifting from the source.

Both `dispatchRole` and `devReviewLoop` (the two chokepoints that will call `log()` for these families) land in a later task; this task ships the schema and the sink with zero real callers, proved by the same test that will fail on the first caller outside `apps/cli/src/lib/dispatch-role.ts` and `apps/cli/src/lib/dev-review-loop.ts`.

## The outbox

One file per task Issue under the machine-local home `~/.vinaya/` already used by `config.json` and `tokens-collect-trust.json` — never in the repository (doctrine forbids task state in the tree; per-task worktrees would fragment a repo-local file):

```
~/.vinaya/outbox/<owner>-<repo>/<issue-or-none>.ndjson
~/.vinaya/outbox/unresolved/<issue-or-none>.ndjson   // when the origin remote cannot be resolved
```

`<issue-or-none>` is `subject.issue` when it resolved to a number, else the literal `none`. The append is hardened the same way the Stop hook's own scratch-then-rename write is, adapted for an append rather than a full-file replace (a rename would drop every earlier line): `mkdirSync(dir, { recursive: true, mode: 0o700 })`; `lstatSync` the target and refuse — write nothing — when it exists and is not a regular file or is a symlink; `openSync(path, 'a', 0o600)` and one `writeSync` ending in `\n`; close. The file rotates to `<name>.1.ndjson` (overwriting an older one) once it crosses 8 MiB, before the append that would have exceeded it — one rotation slot, not a numbered series.

`log()` never throws. Every failure path — an invalid payload, an unwritable directory, a symlinked target — returns without writing, and at most one line reaches `process.stderr` per process, guarded by a module-level flag: a broken outbox must never spam a gate or redden a check.

## The flush marker (reserved)

Task 2 flushes the outbox to one Issue comment per push, marked:

```
<!-- aeg:log:<run_id>:<seq_from>-<seq_to> -->
```

This task does not implement the flush — the grammar is reserved here so the outbox's `run_id`/`seq` fields are already shaped for it.

## Attribution

`VINAYA_RUN_ID`, `VINAYA_ROLE`, `VINAYA_TASK`, `VINAYA_ROUND` are read from `process.env` by the sink, never passed as an argument — a caller cannot override its own attribution. Absent: `role: 'unattributed'`, `issue: null`, a `run_id` generated once per process (`crypto.randomUUID()`). `host` is `'ci'` when `GITHUB_ACTIONS` is set, else `'hook'`/`'loop'` from `VINAYA_HOST`, else `'cli'`. A session not started through `vinaya dispatch` (task 3) is `unattributed`, which is the truth about it — the same class of honesty as `role: 'unattributed'` anywhere else in this doctrine.

## Redaction

`redact(value, home)` (pure — `home` is passed in, never read under `packages/aeg-core/src/log/`) walks every string field: a GitHub token (`gho_`, `ghp_`, `github_pat_`) or an `Authorization: Bearer <token>` value becomes `<redacted>`; an absolute path under `home` is rewritten to `~/…`. Applied to the full event, header included, before it is serialized to the outbox line.
