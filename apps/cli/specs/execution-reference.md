# Execution reference — product, process and adapter boundaries, event ownership

Status: draft

Scope: the maintained reference for where control passes on the task path
— a planned Issue to a reviewed pull request, through the registered task
tools, on both runtimes — and who owns each typed event that path emits.
This is a register, not a second normative source: `apps/cli/specs/isolation.md`
(process boundaries), `log.md` (event schema and families), `surface.md`
(the CLI's own layering) and `conformance.md` (the concern-by-concern
matrix and live acceptance evidence) are the actual authorities. This file
exists because none of the four states, in one place, "which boundary does
control cross here, and which file is on the hook for the event that
crossing produces" — the question this milestone's later, standalone
extraction of the task path will need answered without re-reading all four.

## A — Product boundary

The product this reference describes is the task path itself: an already
planned, forge-addressable task (a frozen brief on a tracking Issue) taken
through dispatch, the developer/reviewer round loop, and gate/verification
checks, to a pull request ready for the Principal to merge — nothing before
planning (the Planner's own brief authoring) and nothing after merge
(archival, retrospective). A task-scoped Operator sits above this same path
as a bounded, read-mostly client — it starts, reads status on, and requests
authenticated continuation or cancellation of a run; it plans nothing,
edits no code, changes no Objectives, posts no ruling, approves nothing,
and merges nothing (`aeg-root/roles/operator.md`; `packages/aeg-core/src/task-tools.ts`'s
`OPERATOR_TOOL_GRANT`). Studio reporting, multi-task batch scheduling,
automatic merge, and a whole-repository rewrite of this path into a
standalone product are explicitly outside this boundary — classified in
Section E, not silently absorbed into it.

## B — Process boundary

`apps/cli/specs/isolation.md` is the authority; this table is a condensed
pointer into it, not a restatement — read the source file for the full
permitted/forbidden lists and the security rationale behind each.

| Actor | Role | Boundary enforced by |
| ----- | ---- | --------------------- |
| Controller | Runs `devReviewLoop`/`task run`; holds the Operator's own forge login and model credentials; the only actor that spawns Worker, Reviewer and repository subprocesses | `apps/cli/src/lib/dispatch.ts`, `dev-review-loop.ts` |
| Worker (Developer) | Reads/writes its own worktree; runs the declared toolchain; pushes and opens a PR on its own branch only | `apps/cli/src/lib/worker-boundary.ts` (Seatbelt sandbox on Darwin under `dispatch.requireWorkerIsolation`) |
| Reviewer | Reads the repository at a judged head; writes findings to a driver-chosen work directory; never holds any forge-write credential | Same `worker-boundary.ts` profile, with every forge-write grant denied |
| Operator | The task-scoped external client described in Section A | `packages/aeg-core/src/task-tools.ts`'s `OPERATOR_TOOL_GRANT` + `apps/cli/src/lib/task-tools/router.ts`'s `refuseUngrantedTool` |
| Repository subprocess | Reads/writes only what the Controller explicitly constructs into its environment | `apps/cli/src/checks/runner.ts`'s `buildCheckEnv` (never `{ ...process.env }` spread) |
| Broker | Grants Worker `branch-push`/`pr-open`/`pr-comment` and Operator `task-execute`/`task-observe`; refuses `ruling-post`/`criteria-edit`/`protected-merge`/`review-publish` unconditionally to both | `apps/cli/src/lib/broker.ts` |

`dispatchRole` (`dispatch.ts`) is the one chokepoint every Worker/Reviewer
subprocess launch passes through, regardless of vendor — the process
boundary above is enforced at that one call site, never re-implemented per
vendor.

## C — Adapter boundary

Two runtime adapters, one shared server: `packages/aeg-core/src/task-tools.ts`'s
five registered tools are served by exactly one process
(`apps/cli/src/lib/task-tools/server.ts`, MCP protocol `2025-06-18`,
newline-delimited JSON-RPC over stdio) — `apps/cli/src/lib/task-tools/adapters.ts`'s
`claudeMcpJsonConfig`/`codexMcpServersToml` differ only in how each runtime
is TOLD to launch that one server (Claude's project-root `.mcp.json`;
Codex's user-home `~/.codex/config.toml`), never in the server, the
protocol, or the tool catalog itself (`protocol.test.ts`'s own "identical
command" assertion). This is the adapter boundary in full: everything below
it (the server, the router, the five tools) is runtime-agnostic; everything
above it (how a runtime discovers and launches that server) is the only
runtime-specific surface. `conformance.md`'s Table C is the proof this
boundary holds identically on both runtimes; Section D there records what a
live smoke run against it did and did not establish.

Unattended Codex developer dispatches use `workspace-write` with a task-scoped `CODEX_HOME`. Vinaya brokers the existing ChatGPT access token into the Codex parent and removes credential-shaped variables from its tool subprocess environment. The generated Documentation-gate lifecycle hooks are installed into that scoped home as a local Codex plugin — live-verified on this authoring host that a bare `hooks.json` file dropped at `CODEX_HOME` root is never discovered by the real Codex CLI at all; the real, documented, non-interactive path is `codex plugin marketplace add <local-dir>` followed by `codex plugin add <plugin>@<marketplace>`, confirmed live end to end (`codex plugin list --json` reporting the installed plugin as `installed: true, enabled: true`, with its `hooks.json` genuinely present at the path Codex's own plugin cache resolves to). `--dangerously-bypass-hook-trust` (already passed at every Codex launch) is the separate gate that then lets an enabled plugin's hooks fire without an interactive trust prompt. The operator's real Codex home is never exposed to repository commands.

The five registered tools and their handlers:

| Tool | Handler | What it does |
| ---- | ------- | ------------- |
| `task_start` | `apps/cli/src/lib/task-tools/start.ts` | Starts the dev-review-loop for an explicitly selected, already-frozen task, attended; idempotent per request identity. |
| `task_status` | `apps/cli/src/lib/task-tools/handlers.ts` | Reads a task's current loop state (running/paused/published/exited/no driver); never explains why. |
| `task_escalation_read` | `apps/cli/src/lib/task-tools/read.ts` | Reads the full escalation packet for a paused task — reason, round inputs, attempted recovery, permitted next actions; never resumes or cancels. |
| `task_resume` | `apps/cli/src/lib/task-tools/resume.ts` | Continues a paused run once a Principal ruling, read fresh from the forge, authenticates it. |
| `task_cancel` | `apps/cli/src/lib/task-tools/cancel.ts` | Stops a paused run, fencing in-flight effects it can no longer safely complete; repeated calls replay the same outcome idempotently. |

## D — Event ownership

`apps/cli/specs/log.md` is the schema authority; `packages/aeg-core/src/log/schema.ts`
is the source of truth for field shapes. This table names, for every
family the schema declares, the file(s) that actually call `log()` with
that kind today — "ownership" in the literal sense: which file is on the
hook when a family's shape needs to change.

| Kind | Producer(s) | Records |
| ---- | ----------- | ------- |
| `dispatch` | `apps/cli/src/lib/dispatch.ts` (`dispatchRole`) | A vendor CLI launch, its outcome, and the usage it reported. |
| `dev_review_loop` | `apps/cli/src/lib/dev-review-loop.ts` | The round-by-round loop lifecycle — start, gate, verdicts, pause/resume/cancel, journal. |
| `forge_write` | `apps/cli/src/lib/log-flush.ts` | A GitHub comment/PR/Issue mutation the flush path performs, validated/refused/written. |
| `gate` | `apps/cli/src/checks/runner.ts` | One check's terminal outcome (pass/fail/wait/skip/invalid/unavailable/timeout/cancelled). |
| `operation` | `apps/cli/src/lib/task-tools/resume.ts`, `cancel.ts`, `apps/cli/src/lib/broker.ts` | A normalized tool-call or broker-authorized operation's outcome (ok/error/refused/timeout/cancelled/unavailable) — this is the family a registered task tool's own call emits; `conformance.md` Section D captures one real instance. |
| `usage` | `apps/cli/src/lib/dispatch.ts` | Vendor token usage, every unit nullable rather than defaulted to zero when a vendor doesn't report one. |
| `role_attempt` | `apps/cli/src/lib/dispatch.ts`, `dev-review-loop.ts` | A dispatched role's own normalized attempt outcome, distinct from the Controller-side `dispatch` view of the same attempt. |
| `handoff` | none today | Declared in the schema (`raised`/`resolved`) for a human escalation; no file emits it yet — an honest gap, not an oversight this task closes. |
| `effect` | `apps/cli/src/lib/effects.ts` | A generic external effect's attempted/observed/verified outcome, additive to `forge_write`, never replacing it. |

Every event's own attribution is carried in its `meta` envelope
(`log/schema.ts` schema v2: `event_id`, `process_id`, `actor_id`,
`provenance`), never in this table — a kind's producer file is who calls
`log()`; the envelope's `actor_id`/`provenance` pair is who the caller's own
environment claims to be at that moment, trusted at the level `provenance`
states (`parent_attributed` highest, `self_reported` lowest,
`unavailable` when the claim itself could not be read). "Every recorded
event has an owner" (this milestone's own O2 phrasing) means both things:
a producer file owns emitting the kind (this table), and the event itself
carries a non-null, if not always maximally trusted, claim of who acted
(the envelope). `conformance.md` Section D's captured event shows both:
`operation`/`task_resume` owned by `resume.ts`, `actor_id: "developer"` at
`provenance: "env_correlated"`.

## E — Later or not applicable

| Concern | Disposition | Why |
| ------- | ----------- | --- |
| Batch APIs / multi-task scheduling | Not applicable | This milestone operates one task at a time end to end (`conformance.md`'s own "Batch processing" row); no delayed batch endpoint or scheduler exists or is implied by the registered tool catalog. |
| Extra helper agents | Not applicable | The Operator's own tool grant carries no planning or dispatch capability of its own (`OPERATOR_TOOL_GRANT`) — it observes and requests continuation of the SAME Controller-driven loop, never spawns a second, independent agent of its own. |
| Analytics | Later | `task-log-v1` shipped the typed, versioned event schema and its producers; no analytics or reporting consumer reads that data yet (Studio, explicitly out of this task's surface, is the first likely consumer). The schema is deliberately additive so a later analytics layer can be built without a second event-schema migration. |
| Whole-app extraction | Later | This file is written as the reference a later, standalone extraction of the task path would start from — boundaries and event ownership named once, here, rather than re-derived at extraction time. Extraction itself (packaging the task path as a separable product) is not attempted by this task. |
