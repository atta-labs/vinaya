# Execution reference — product, process and adapter boundaries, event ownership

Status: draft

Scope: the maintained reference for where control passes on the task path
— a planned Issue to a reviewed pull request, through the registered task
tools, on both runtimes — and who owns each typed event that path emits.
This is a register, not a second normative source: `harness/kernel/isolation/isolation.md`
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
and merges nothing (`harness/processes/vinaya-strict/executing/operator/doctrine.md`; `harness/processes/vinaya-strict/integration/policies/roles.ts`'s
`OPERATOR_TOOL_GRANT`). Studio reporting, multi-task batch scheduling,
automatic merge, and a whole-repository rewrite of this path into a
standalone product are explicitly outside this boundary — classified in
Section E, not silently absorbed into it.

## B — Process boundary

`harness/kernel/isolation/isolation.md` is the authority; this table is a condensed
pointer into it, not a restatement — read the source file for the full
permitted/forbidden lists and the security rationale behind each.

| Actor | Role | Boundary enforced by |
| ----- | ---- | --------------------- |
| Controller | Runs `devReviewLoop`/`task run`; holds the Operator's own forge login and model credentials; the only actor that spawns Worker, Reviewer and repository subprocesses | `harness/processes/vinaya-strict/loops/dev-review/dispatch/dispatch.ts`, `dev-review-loop.ts` |
| Worker (Developer) | Reads/writes its own worktree; runs the declared toolchain; pushes and opens a PR on its own branch only | `harness/kernel/isolation/worker-boundary.ts` (Seatbelt sandbox on Darwin, always on where supported) |
| Reviewer | Reads the repository at a judged head; writes findings to a driver-chosen work directory; never holds any forge-write credential | Same `worker-boundary.ts` profile, with every forge-write grant denied |
| Operator | The task-scoped external client described in Section A | `harness/processes/vinaya-strict/integration/policies/roles.ts`'s `OPERATOR_TOOL_GRANT` + `harness/kernel/tools/host/seat-host.ts`'s seat host, gated by `harness/kernel/tools/host/router.ts`'s `refuseUngrantedTool` |
| Repository subprocess | Reads/writes only what the Controller explicitly constructs into its environment | `harness/kernel/gates/checks/runner.ts`'s `buildCheckEnv` (never `{ ...process.env }` spread) |
| Broker | Grants Worker `branch-push`/`branch-lease-push`/`pr-open`/`pr-comment` (a `branch-lease-push` only to a `refs/heads/task/` target, and requested only by the driver's own publication) and Operator `task-execute`/`task-observe`; refuses `ruling-post`/`criteria-edit`/`protected-merge`/`review-publish` unconditionally to both | `harness/kernel/tools/host/broker.ts` |

`dispatchRole` (`dispatch.ts`) is the one chokepoint every Worker/Reviewer
subprocess launch passes through, regardless of vendor — the process
boundary above is enforced at that one call site, never re-implemented per
vendor.

## C — Adapter boundary

Two runtime adapters, one shared server: `harness/kernel/tools/catalog/task-tools.ts`'s
six registered tools are served by exactly one program
(`harness/processes/vinaya-strict/integration/server.ts`, MCP protocol `2025-06-18`,
newline-delimited JSON-RPC over stdio), one seat per launch: the kernel's seat
host (`harness/kernel/tools/host/seat-host.ts`) serves the catalog entries,
handlers and grant the process's seat table gives the seat the launch's
`--seat` argument names, and a launch with none serves the Operator — `harness/processes/vinaya-strict/integration/adapters.ts`'s
`claudeMcpJsonConfig`/`codexMcpServersToml` register one server per declared
seat and differ only in how each runtime
is TOLD to launch that one server (Claude's project-root `.mcp.json`;
Codex's user-home `~/.codex/config.toml`), never in the server, the
protocol, or the tool catalog itself (`protocol.test.ts`'s own "identical
command" assertion). This is the adapter boundary in full: everything below
it (the server, the router, the six tools) is runtime-agnostic; everything
above it (how a runtime discovers and launches that server) is the only
runtime-specific surface. `conformance.md`'s Table C is the proof this
boundary holds identically on both runtimes; Section D there records what a
live smoke run against it did and did not establish.

For the Atta-backed developer-review workflow, the same split is judged
capability by capability in `dev-review-engine-capability-matrix.md`: which
capabilities the core contract requires of every adapter, which each
adapter supplies from its own documentation, and each adapter's confinement
on macOS and Linux with its named gaps. The contract between the controller
and its agents — tools, grants, staged inputs and agent results — lives in
`dev-review-capabilities-contracts.md`.

Unattended Codex developer dispatches use `workspace-write` with a task-scoped `CODEX_HOME`. Vinaya brokers the existing ChatGPT access token into the Codex parent and removes credential-shaped variables from its tool subprocess environment. The generated Documentation-gate lifecycle hooks are installed into that scoped home as a local Codex plugin — live-verified on this authoring host that a bare `hooks.json` file dropped at `CODEX_HOME` root is never discovered by the real Codex CLI at all; the real, documented, non-interactive path is `codex plugin marketplace add <local-dir>` followed by `codex plugin add <plugin>@<marketplace>`, confirmed live end to end (`codex plugin list --json` reporting the installed plugin as `installed: true, enabled: true`, with its `hooks.json` genuinely present at the path Codex's own plugin cache resolves to). `--dangerously-bypass-hook-trust` (already passed at every Codex launch) is the separate gate that then lets an enabled plugin's hooks fire without an interactive trust prompt. The operator's real Codex home is never exposed to repository commands.

The six registered tools and their handlers:

| Tool | Handler | What it does |
| ---- | ------- | ------------- |
| `task_start` | `harness/processes/vinaya-strict/loops/dev-review/run-control/start.ts` | Starts the dev-review-loop for an explicitly selected, already-frozen task, attended; idempotent per request identity. Also continues a stopped run, including a pause whose Principal ruling is already posted — which it hands to `task_resume`'s own authentication rather than relaunching past it. A pause still awaiting a ruling is refused, naming where the ruling goes, the marker and the command. |
| `task_status` | `harness/processes/vinaya-strict/loops/dev-review/run-control/handlers.ts` | Reads a task's current loop state (running/paused/published/exited/no driver); never explains why. Lists a planned backlog task — an open Issue with a frozen brief and no run yet — as `not started`, from one forge search per listing. |
| `task_escalation_read` | `harness/processes/vinaya-strict/loops/dev-review/run-control/read.ts` | Reads the full escalation packet for a paused task — reason, round inputs, attempted recovery, permitted next actions — for a pause raised before any pull request whose Developer asked for `widen_surface`, the Planner's `vinaya task run … --widen-surface <glob,...> --reason <text>` with the globs the Developer named; never resumes or cancels. |
| `task_resume` | `harness/processes/vinaya-strict/loops/dev-review/run-control/resume.ts` | Continues a paused run once a Principal ruling, read fresh from the forge, authenticates it. Refuses a pre-pull-request `widen_surface` escalation, naming the Planner's `task run … --widen-surface` command: widening a Surface supersedes the brief, which the Operator never does. |
| `task_cancel` | `harness/processes/vinaya-strict/loops/dev-review/run-control/cancel.ts` | Stops a paused run, fencing in-flight effects it can no longer safely complete; repeated calls replay the same outcome idempotently. |
| `task_pr_read` | `harness/processes/vinaya-strict/loops/dev-review/run-control/pr-read.ts` | Reads the selected task's pull request, its check rollup and its Principal-authored comments, resolved from the task's own branch; a read only, never a write. |

## D — Event ownership

`harness/kernel/log/log.md` is the schema authority; `harness/kernel/log/schema.ts`
is the source of truth for field shapes. This table names, for every
family the schema declares, the file(s) that actually call `log()` with
that kind today — "ownership" in the literal sense: which file is on the
hook when a family's shape needs to change. Each producer file named in the table is bound to a literal it still holds.

<!-- VINAYA:CLAIM: harness/processes/vinaya-strict/loops/dev-review/dispatch/dispatch.ts contains:runRecorder().turn( -->
<!-- VINAYA:CLAIM: harness/processes/vinaya-strict/loops/dev-review/standalone/dev-review-loop/run-setup.ts contains:kind: 'dev_review_loop' -->
<!-- VINAYA:CLAIM: harness/kernel/gates/checks/runner.ts contains:log.checks.notPassed( -->
<!-- VINAYA:CLAIM: harness/processes/vinaya-strict/loops/dev-review/run-control/resume.ts contains:action: 'task_resume' -->
<!-- VINAYA:CLAIM: harness/processes/vinaya-strict/loops/dev-review/run-control/cancel.ts contains:action: 'task_cancel' -->
<!-- VINAYA:CLAIM: harness/kernel/tools/host/broker.ts contains:operationRecord -->
<!-- VINAYA:CLAIM: harness/kernel/effects/effects.ts contains:writeAction -->
<!-- VINAYA:CLAIM: harness/processes/vinaya-strict/tools/task-contract/forge/forge-write.ts contains:writeForgeRefused -->
<!-- VINAYA:CLAIM: harness/processes/vinaya-strict/loops/dev-review/standalone/dev-review-loop/pause-resume.ts contains:writePersonAsked( -->
<!-- VINAYA:CLAIM: harness/kernel/log/client/log-custom.ts contains:custom.recorded( -->
<!-- VINAYA:CLAIM: harness/kernel/log/client/log-custom.ts contains:command.completed( -->
<!-- VINAYA:CLAIM: harness/processes/vinaya-strict/loops/dev-review/dispatch/dispatch.ts contains:action: 'claude-sandbox-confinement' -->
<!-- VINAYA:CLAIM: harness/kernel/log/client/cli-operation-log.ts contains:writeCommand -->

| Kind | Producer(s) | Records |
| ---- | ----------- | ------- |
| `dispatch` | none today | Declared in the schema so a stored line still parses; an agent turn is an `invoke_agent` span written through the run's Log handle (below), and no file emits this family. |
| `dev_review_loop` | `harness/processes/vinaya-strict/loops/dev-review/standalone/dev-review-loop/` phase modules (see the loop specification’s module map) | The round-by-round loop events — gate, verdicts, rounds; a run's own lifecycle (start, pause, resume, cancel, retry, stop rule, end, exit) is written through the run's Log handle (below), not as lines. |
| `forge_write` | none today | Declared in the schema so an already-posted comment line still parses; no file emits it — the comment-posting flush and the artifact commands are removed, and logs never reach a tracker or a code host. A forge write is recorded through the run's Log handle instead (below). |
| `gate` | none today | Declared in the schema so a stored line still parses; a run of checks is a `vinaya.checks {where}` span and one not-passed event per check that did not pass, written through the run's Log handle by `harness/kernel/gates/checks/runner.ts` (below), and no file emits this family. |
| `operation` | none today | Declared in the schema so a stored line still parses; every command the harness records, a refused custom event included, is one `log.command.completed` record written through the run's Log handle (below), and no file emits this family. |
| `usage` | none today | Declared in the schema so a stored line still parses; tokens are written with `log.usage.recorded` on the agent span (below), and no file emits this family. |
| `role_attempt` | none today | Declared in the schema so a stored line still parses; the attempt rides on the agent span's return or failure (below), and no file emits this family. |
| `handoff` | none today | Declared in the schema so a stored line still parses; a person the harness asks is a `vinaya.person {kind}` span written through the run's Log handle by `pause-resume.ts` (below), and no file emits this family. |
| `effect` | none today | Declared in the schema so a stored line still parses; an outside action's final outcome is one `log.action.verified` record written through the run's Log handle by `harness/kernel/effects/effects.ts` (below), and no file emits this family. |
| `custom` | none today | Declared in the schema so a stored line still parses; an operator-declared event is one `log.custom.recorded` record written through the run's Log handle by `harness/kernel/log/client/log-custom.ts` (`emitCustomEvent`, below), and no file emits this family. |

<!-- VINAYA:CLAIM: harness/processes/vinaya-strict/bin/run-engine.ts contains:recordUsage(turn, -->

Agents and usage are written through the run's Log handle, not as earlier-format events: each agent turn is one `invoke_agent {seat}` span opened with `log.agent.sent` and ended with `log.agent.returned` or `log.agent.failed`, and its tokens are written with `log.usage.recorded` on that span, with the reason when they are unknown. Four files write the agents subject (`harness/processes/vinaya-strict/loops/dev-review/dispatch/dispatch.ts`, `harness/processes/vinaya-strict/bin/run-engine.ts`, `dev-review-loop/round-loop.ts`, `harness/processes/vinaya-strict/executing/actions.ts`) and two the usage subject (`dispatch.ts`, `run-engine.ts`). `log-callers.test.ts` checks both ways: a file it names must write the subject, and a file that writes it must be named.

Outside actions, commands and forge writes are written through the same handle, and no earlier-format `effect`, `operation` or `forge_write` event is written for them. The effect executor (`harness/kernel/effects/effects.ts`) writes one `log.action.verified` per outside action: the operation, its target and `success`, `failure` or `uncertain`. A command that finished is one `log.command.completed` — the command, its target, and `ok`, `error`, `refused`, `timeout`, `cancelled` or `unavailable`, with the error kind when there is one — written by the broker (`harness/kernel/tools/host/broker.ts`: its authentication and its effects), the task tools' resume and cancel (`task_resume`, `task_cancel`, each filed under the task it acts on), the dispatch sandbox probes (`dispatch.ts`) and the CLI's one record per invocation (`harness/kernel/log/client/cli-operation-log.ts`, under the invocation's own run id). The forge write gate (`harness/processes/vinaya-strict/tools/task-contract/forge/forge-write.ts`) writes `log.forge.validated` when it checks a write that passes, `log.forge.refused` with why when it refuses one, and `log.forge.written` once the write is made — the action, its target and the reason, never the body, and a write made outside any task run carries its process's own run id. A Log that cannot be written never fails the action, the command or the write. A team's own declared event is written through the same handle by the custom-event writer (`harness/kernel/log/client/log-custom.ts`, which `vinaya-log-emit` calls): `log.custom.recorded` with the event `<namespace>.<name>` and its declared fields, or, for an event the declarations refuse, one `log.command.completed` for the command `log.emit` with result `refused` and the refusal code as its error kind; `vinaya-log-emit` then drains the run recorder, which sends the run's local copy to the configured OpenTelemetry address. `log-callers.test.ts` names the writer as the owner of the custom subject and an owner of the command subject. Each of the others writes through `harness/kernel/log/outside-log.ts`, which `log-callers.test.ts` names as an owner of the action, command and forge subjects beside the files above.

A person the harness asks, and their answer, are written through the same handle, and no earlier-format `handoff` event is written for them. The escalation record writer (`writeEscalationRecord` in `harness/processes/vinaya-strict/loops/dev-review/standalone/dev-review-loop/pause-resume.ts`) writes one `log.person.asked` once the record and its paused transition are both stored: the kind (authority, strategy or product, from the pause reason's class), a key naming the escalation, the pause reason as why, the decision `ruling`, and how to answer — `vinaya pr rule <pr> --file <ruling.md>` when the paused run has a pull request, otherwise the pause reason's first next action. The escalation resolver (`resolveEscalation`, same file) writes one `log.person.answered` (the answer as a short code, and who gave it) when a `resume` is consumed, under the escalation's own run id, so the person span is whole in the run's local copy whichever process resolves it: the next `--resume` start, the host-repair start, the Engine's ruling watch and its `--resume` start, the task tools' resume or `vinaya task run`. A cancel writes no answer. A Log that cannot be written never fails a pause or a resume. Both write through `harness/kernel/log/outside-log.ts`, which `log-callers.test.ts` names as an owner of the person subject beside `pause-resume.ts`.

A run's lifecycle is written through the same handle, on both runners, with the run functions: `log.run.started` when a process begins work on the run (the handle writes no second start for a run another process started, and carries it on), `log.run.ended` with the rounds, time and outcome, `log.run.paused` and `log.run.resumed` (a resume in a later process ends the pause the earlier one began), `log.run.cancelled`, `log.run.retried`, `log.run.stopRuleMet` and `log.run.exited`. The run's liveness is the handle's own `log.run.alive`, sent after two minutes with no record, so the driver keeps no heartbeat; the earlier `loop_started`, `journal_finalized`, `paused`, `resumed`, `cancelled`, `infrastructure_retry`, `stop_condition_met`, `driver_heartbeat` and `driver_exited` lines are never written for these moments, though the loop still builds the events as data. One file owns the run subject, `dev-review-loop/driver-lifecycle.ts`, and `log-callers.test.ts` checks it both ways like the others. <!-- VINAYA:CLAIM: harness/processes/vinaya-strict/loops/dev-review/standalone/dev-review-loop/driver-lifecycle.ts contains:log.run.started( -->

A run's rounds, review and change are written through the same handle, on both runners, by the same file. Each round is one `vinaya.round {n}` span: `log.round.started` (round, starting commit) when the assessment names it, `log.round.ended` (files changed, lines added and removed, outcome) when the round ends, even in a later process, and `log.phase.ended` for each phase's time. A round's review is `log.review.verdicts` and `log.review.findingsCompared`, its gate read `log.checks.read`, and a stated confidence `log.agent.confidenceStated`. The change is `log.change.saved` (a storage push), `log.change.pushed` (the ready push), `log.change.opened`, `log.change.conflicted` and `log.change.recovered`. A pull request the run watches is recorded by the run's own watch of it, whether the run waits for the merge or is paused: `log.change.merged` when it merges and `log.change.closed` when it is closed without merging, linked to the run's trace. The earlier `round_started`, `round_ended`, `phase_time`, `verdicts_read`, `findings_compared`, `gate_result_read`, `storage_push`, `ready_push`, `pr_opened`, `conflict_reentry` and `unpushed_work_resume` lines are never written for these moments, though the loop still builds the events as data. `dev-review-loop/driver-lifecycle.ts` owns these subjects too (`writeRunLifecycleEvent` for the events, `recordWatchedChangeEnded` for the merge or close), and `log-callers.test.ts` checks it both ways. <!-- VINAYA:CLAIM: harness/processes/vinaya-strict/loops/dev-review/standalone/dev-review-loop/driver-lifecycle.ts contains:log.round.started( --> <!-- VINAYA:CLAIM: harness/processes/vinaya-strict/loops/dev-review/standalone/dev-review-loop/driver-lifecycle.ts contains:export function recordWatchedChangeEnded( -->

Checks are written through the same handle. Every run of the registered checks (by a hook, on the command line, in the loop, in CI) is one `vinaya.checks {where}` span written with `log.checks.ran` (where, how many ran, passed, failed and skipped, and which failed), and each check that did not pass is one `log.checks.notPassed` event (the check, its version, its result and the reason); `harness/kernel/gates/checks/runner.ts` writes both, and a Log that cannot be written gives a warning and never changes a check's result. A check run inside a task run carries that run's id, and one outside any task run carries its process's own run id. The loop's own local checks, CI read and failed-test rerun are `log.checks.local`, `log.checks.ci` and `log.checks.rerun`, each a span with its real start and end, written by `dev-review-loop/driver-lifecycle.ts`. The earlier `gate` `checked` and `summary` lines and the `local_checks_run`, `ci_result_read` and `failed_tests_rerun` lines are never written for these moments, and `log-callers.test.ts` names the runner and the driver lifecycle module as the owners of the checks subject, both ways. <!-- VINAYA:CLAIM: harness/processes/vinaya-strict/loops/dev-review/standalone/dev-review-loop/driver-lifecycle.ts contains:log.checks.ci( -->

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
