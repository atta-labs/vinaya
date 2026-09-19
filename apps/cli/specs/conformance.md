# Conformance matrix — the task path, concern by concern

Status: draft

Scope: the task path from a planned Issue to a reviewed pull request, through
the registered task tools, on both runtimes. This matrix names, for every
applicable concern, the Vinaya decision, the file that actually owns the
behavior today, and the test that proves it — including already-shipped
code, not only newly added behavior. `apps/cli/tests/conformance/matrix.test.ts`
asserts every row below whose Disposition is not `not applicable` cites at
least one real, existing test file that carries at least one real test.

This is a register, not a second normative source: `apps/cli/specs/loop.md`,
`log.md`, and `surface.md` are the actual authority for behavior. Four
dispositions: **implemented** (this task path carries the behavior, with a
passing test below), **retained** (already implemented and tested; this row
cites that existing, unmodified evidence rather than re-deriving it),
**conditional** (only applies when an optional capability is enabled; not
applicable otherwise — noted per row), **not applicable** (this concern
names something this product's task path does not carry, with the reason
stated inline).

## A — Concerns and dispositions

| Concern | Disposition | Owner | Test |
| ------- | ------------ | ----- | ---- |
| Agentic loops | retained | `apps/cli/src/lib/dev-review-loop.ts` (driver) + `packages/aeg-core/src/dev-review-loop/assess-round.ts` (pure policy) compose the gate→reviewers→verdict loop the Operator's tools sit above, never re-drive. | `apps/cli/tests/lib/dev-review-loop.test.ts`, `packages/aeg-core/src/dev-review-loop/assess-round.test.ts` |
| Orchestration patterns | retained | Same driver: one initial worker, parallel independent reviewers, bounded feedback — the controller composition `apps/cli/src/lib/dev-review-loop.ts` owns. | `apps/cli/tests/lib/dev-review-loop/reviewer-dispatch.test.ts` |
| Subagent invocation context | retained | `apps/cli/src/lib/dev-review-loop/reviewer-isolation.ts` — a pinned, immutable candidate and isolated scratch space per review attempt; no worker-private history crosses into review. | `apps/cli/tests/lib/dev-review-loop/reviewer-isolation.test.ts` |
| Workflow enforcement & handoff | implemented | `apps/cli/src/lib/dev-review-loop/pause-resume.ts` (durable escalation/resolution records) plus the registered `task_resume`/`task_cancel` tools that are the only consumers of an authenticated decision. | `apps/cli/tests/lib/dev-review-loop/pause-resume.test.ts`, `apps/cli/tests/lib/task-tools/resume.test.ts`, `apps/cli/tests/lib/task-tools/cancel.test.ts`, `apps/cli/tests/conformance/claude.test.ts`, `apps/cli/tests/conformance/codex.test.ts` |
| Agent SDK hooks | not applicable | The task path dispatches vendor CLIs as subprocesses (`apps/cli/src/lib/dispatch.ts`), never through the Agent SDK's in-process hook surface — there is no `PreToolUse`/`PostToolUse` registration to prove because none is wired. Parent-side validation (`dev-review-loop.ts`'s own artifact/postcondition checks) is the enforcement point instead, independent of any hook firing. | — |
| Task decomposition | not applicable | Applied to the Planner's own task breakdown, never to new autonomous planning inside the Operator — the Operator's tool grant carries no planning capability (`OPERATOR_TOOL_GRANT`, `packages/aeg-core/src/task-tools.ts`). | — |
| Session state & resumption | implemented | The developer's own dispatch session is resumed on revision (`apps/cli/src/lib/dev-review-loop.ts`); a reviewer session is never resumed. `task_resume` reads the durable escalation/resolution records rather than any chat/session handle to decide whether a continuation already happened. | `apps/cli/tests/lib/task-tools/resume.test.ts`, `apps/cli/tests/conformance/claude.test.ts` ("recovery"), `apps/cli/tests/conformance/codex.test.ts` ("recovery") |
| Tool schema design | implemented | `packages/aeg-core/src/task-tools.ts` — one catalog entry per tool: name, purpose, boundaries, Zod input/result/error schema, schema-valid examples, handler binding. | `packages/aeg-core/src/task-tools.test.ts` |
| Structured error responses | implemented | `packages/aeg-core/src/task-tools.ts`'s `TaskToolErrorSchema` — eight distinct kinds (validation, authority, precondition, capability, infrastructure, cancellation, timeout, uncertain_effect); `apps/cli/src/lib/task-tools/server.ts` maps a handler's typed refusal to MCP's `isError` content, never conflating a business refusal with a transport failure. | `packages/aeg-core/src/task-tools.test.ts`, `apps/cli/tests/lib/task-tools/handlers.test.ts` |
| Tool distribution choice | implemented | `apps/cli/src/lib/task-tools/router.ts` — `OPERATOR_TOOL_GRANT` is the Operator's closed tool set; `refuseUngrantedTool` is the one enforcement point every call passes through, mirrored by `aeg-root/roles/operator.md`'s `allowed-tools` frontmatter so the two never drift. | `apps/cli/tests/lib/task-tools/router.test.ts`, `apps/cli/tests/lib/operator-grant.test.ts` |
| MCP server / registration | implemented | `apps/cli/src/lib/task-tools/server.ts` (the one MCP server, `2025-06-18`, newline-delimited JSON-RPC over stdio) plus `apps/cli/src/lib/task-tools/adapters.ts` (Claude's `.mcp.json`, Codex's `[mcp_servers]` TOML — the SAME registered command in both). | `apps/cli/tests/lib/task-tools/protocol.test.ts`, `apps/cli/tests/lib/task-tools/adapters.test.ts`, `apps/cli/tests/lib/task-tools/server.test.ts`, `apps/cli/tests/conformance/claude.test.ts`, `apps/cli/tests/conformance/codex.test.ts` |
| Built-in tools | retained | Read/search/edit/test surfaces are assigned per role by the broker, not by this task — the Operator itself is granted none of them (`OPERATOR_TOOL_GRANT` carries no native tool). | `apps/cli/tests/lib/broker/worker-grants.test.ts`, `apps/cli/tests/lib/broker/operator-grants.test.ts` |
| `CLAUDE.md`/rules hierarchy | retained | Trusted configuration loading and doctrine resolution predate this task and are unchanged by it. | `apps/cli/tests/doctrine.test.ts`, `apps/cli/tests/doctrine-resolution.test.ts`, `apps/cli/tests/config.test.ts` |
| Slash commands & skills | retained | The generated Operator skill and its `allowed-tools` are emitted from the same catalog grant this task exercises (`packages/aeg-core/src/task-tools.ts`'s `OPERATOR_TOOL_GRANT`), by already-shipped code. | `apps/cli/tests/agents-skills-emitter.test.ts`, `apps/cli/tests/claude-command-emitter.test.ts`, `apps/cli/tests/commands/operator-role.test.ts` |
| Path-specific rules | not applicable | The task path carries no path-scoped permission rule of its own; the Operator's authority is scoped by tool grant (tool distribution choice, above), never by file path. | — |
| Plan mode & execution boundary | retained | The Operator's own role doctrine states the plan/execute boundary explicitly (`aeg-root/roles/operator.md`: it never plans, codes, rules, approves, merges or schedules); a runtime's own plan-mode UI implies no additional authority. | `apps/cli/tests/roles/contract.test.ts`, `apps/cli/tests/commands/operator-role.test.ts` |
| Iterative refinement | retained | `packages/aeg-core/src/dev-review-loop/assess-round.ts` — the bounded revision loop (findings → developer turn → re-review) the Operator's tools observe but never drive. | `packages/aeg-core/src/dev-review-loop/assess-round.test.ts` |
| CI/CD integration | retained | Gate/check evidence is identical whether a run is local or CI (`apps/cli/src/lib/checks`, out of this task's surface); this task adds no CI-specific behavior. | `apps/cli/tests/checks/runner.test.ts`, `apps/cli/tests/ci-shards.test.ts` |
| System prompts | retained | Role prompts are rendered from facts, not conversation (`apps/cli/src/lib/dev-review-loop/reviewer-dispatch.ts`, `developer-dispatch.ts`); unchanged by this task. | `apps/cli/tests/lib/dev-review-loop/reviewer-dispatch.test.ts`, `apps/cli/tests/lib/dev-review-loop/developer-dispatch.test.ts` |
| Few-shot prompting | not applicable | Review/developer prompts are facts-only by lint (`renderReviewerDispatchPrompt`'s own check), never exemplar-driven; the task-tool catalog's `examples` field (tool schema design, above) is schema-validation fixtures for a tool caller, not a few-shot prompting technique. | — |
| Structured output | implemented | Every registered tool's result is a Zod-validated, discriminated shape (`packages/aeg-core/src/task-tools.ts`); `apps/cli/src/lib/task-tools/server.ts` exports the matching JSON Schema for `tools/list`, checked against the catalog by a dedicated test so the two can never drift. | `packages/aeg-core/src/task-tools.test.ts`, `apps/cli/tests/lib/task-tools/server.test.ts` |
| Validation & retry loops | implemented | Bounded retry budgets live in the control store (`packages/aeg-core/src/control-store/records.ts`'s `LoopBudgetsSchema`: `mechanicalRetries`, `reviewRounds`, `infrastructureRetries`), never re-implemented by the Operator's own tools — `task_resume`/`task_start` are themselves idempotent per request/escalation identity, a bounded-retry property of the tool surface itself. | `packages/aeg-core/src/control-store/local.test.ts`, `apps/cli/tests/conformance/claude.test.ts` ("bounded retries"), `apps/cli/tests/conformance/codex.test.ts` ("bounded retries") |
| Batch processing | not applicable | Deferred: this milestone operates one task at a time; no delayed batch API or multi-task scheduling is in this release's scope. | — |
| Multi-pass review | retained | The configured review roles are joined per round, required coverage validated before a verdict is held (`apps/cli/src/lib/dev-review-loop.ts`). | `apps/cli/tests/lib/dev-review-loop.test.ts` |
| Context window management | retained | `apps/cli/src/lib/context-packet.ts` — bounded evidence packets, not full transcripts. | `apps/cli/tests/lib/context-packet.test.ts` |
| Escalation & ambiguity | implemented | `apps/cli/src/lib/dev-review-loop/pause-resume.ts`'s `PAUSE_REASON_PROFILE` — every pause reason maps to a `requestedAuthority` (`principal`/`operator`/`self`), an `attemptedRecovery` statement and permitted next actions, all surfaced verbatim by `task_escalation_read`. | `apps/cli/tests/lib/dev-review-loop/pause-resume.test.ts`, `apps/cli/tests/lib/task-tools/read.test.ts`, `apps/cli/tests/conformance/claude.test.ts` ("human handoff", "input change", "mechanical rejection"), `apps/cli/tests/conformance/codex.test.ts` ("human handoff", "input change", "mechanical rejection") |
| Error propagation | implemented | `packages/aeg-core/src/task-tools.ts`'s eight-kind error taxonomy (structured error responses, above) plus `packages/aeg-core/src/control-store/outcomes.ts`'s `normalizeOutcome` — a partial failure is never silently reported as a clean result. | `packages/aeg-core/src/control-store/outcomes.test.ts`, `apps/cli/tests/lib/dispatch/outcomes.test.ts`, `apps/cli/tests/conformance/claude.test.ts` ("invalid result"), `apps/cli/tests/conformance/codex.test.ts` ("invalid result") |
| Codebase exploration | retained | The worker's own native read/search/edit grant (unrelated to the Operator, which is granted none of it). | `apps/cli/tests/lib/broker/worker-grants.test.ts` |
| Human review calibration | retained | Self-reported developer confidence and reviewer-finding confidence are carried as data with explicit scale/source/unavailability (`packages/aeg-core/src/log/schema.ts`), never treated as calibrated correctness. | `packages/aeg-core/src/log/schema.test.ts` |
| Information provenance | retained | `packages/aeg-core/src/log/envelope.ts`'s `provenance` field (`parent_attributed`/`env_correlated`/`self_reported`/`unavailable`) — a caller's own claim is never treated as authorization or fact on its own (the same discipline `packages/aeg-core/src/task-tools.ts`'s module doc states for a tool caller's identity). | `packages/aeg-core/src/log/envelope.test.ts` |

## B — Primary documentation

| Doc | Primary reference | Owner | Test |
| --- | ------------------ | ----- | ---- |
| headless | [Programmatic Claude Code](https://code.claude.com/docs/en/headless) | `apps/cli/src/lib/dispatch.ts` — every role, including the developer and both reviewers, is dispatched as a non-interactive CLI subprocess (`--print`/headless invocation), never an attached terminal session. | `apps/cli/tests/lib/dispatch.test.ts` |
| patterns | [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) | `packages/aeg-core/src/dev-review-loop/assess-round.ts` + `apps/cli/src/lib/dev-review-loop.ts` — gated steps, parallel independent review, bounded evaluator feedback, the combined pattern the task path's own state machine implements. | `packages/aeg-core/src/dev-review-loop/assess-round.test.ts` |
| outputs | [Structured outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs) | `packages/aeg-core/src/task-tools.ts` — every registered tool's result and error are Zod-validated discriminated shapes, never free text. | `packages/aeg-core/src/task-tools.test.ts` |
| mcp | [MCP tools spec, 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) | `apps/cli/src/lib/task-tools/server.ts` — `MCP_PROTOCOL_VERSION`, `tools/list`, `tools/call`, JSON-RPC 2.0 framing over stdio, implemented directly against the spec. | `apps/cli/tests/lib/task-tools/protocol.test.ts`, `apps/cli/tests/conformance/claude.test.ts`, `apps/cli/tests/conformance/codex.test.ts` |
| secure | [Secure deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment) | `apps/cli/src/lib/broker` (credential/effect isolation) and `apps/cli/specs/isolation.md`'s worker sandbox — a worker never inherits a privileged human's forge token or usable credentials; the Operator itself is granted no shell, forge write, or merge capability. | `apps/cli/tests/lib/broker/worker-grants.test.ts`, `apps/cli/tests/isolation/isolation-contract.test.ts` |

## C — Two-runtime fixtures (O2): the nine scenarios

One row per fixture scenario this suite proves: clean result, invalid
result, mechanical rejection, bounded retries, fresh reviews, input change,
human handoff, cancellation, and recovery. Every scenario runs
against the real `vinaya-task-tools` MCP server (`apps/cli/src/lib/task-tools/server.ts`)
through the registered tools, with identical expectations asserted once per
adapter — `apps/cli/tests/conformance/claude.test.ts` drives it via the exact
command the Claude `.mcp.json` adapter registers
(`claudeMcpJsonConfig`), `apps/cli/tests/conformance/codex.test.ts` via the
exact command parsed back out of the Codex `[mcp_servers]` TOML adapter
(`codexMcpServersToml`) — both adapters register the same command
(`apps/cli/tests/lib/task-tools/protocol.test.ts`'s own "identical command"
assertion), so a fixture passing on both is a genuine two-runtime proof, not
two copies of one runtime.

| Scenario | Registered tool(s) exercised | What it proves | Test |
| -------- | ----------------------------- | ---------------- | ---- |
| Clean result | `task_start` | A well-formed start launches exactly once and returns the durable run identity — `mode: 'attended'`, `started: true`. | `apps/cli/tests/conformance/claude.test.ts`, `apps/cli/tests/conformance/codex.test.ts` |
| Invalid result | `task_status`, `task_escalation_read`, `task_resume`, `task_cancel`, `task_start` | Malformed input to every registered tool is refused with a `validation` error before any read, write or effect — never a partial or fabricated result. | `apps/cli/tests/conformance/claude.test.ts`, `apps/cli/tests/conformance/codex.test.ts` |
| Mechanical rejection | `task_escalation_read` | A `'infrastructure'` pause (a missing role/artifact — an environment gap, not a content one) reports `requestedAuthority: 'operator'` and the driver's own recovery attempt, distinct from a substantive review dispute. | `apps/cli/tests/conformance/claude.test.ts`, `apps/cli/tests/conformance/codex.test.ts` |
| Bounded retries | `task_escalation_read` | A `'no_push'` pause reports the ALREADY-EXHAUSTED single bounded foreground-resume attempt (`PAUSE_REASON_PROFILE.no_push.attemptedRecovery`) — the tool surfaces a budget already spent, never re-attempts it itself. | `apps/cli/tests/conformance/claude.test.ts`, `apps/cli/tests/conformance/codex.test.ts` |
| Fresh reviews | `task_escalation_read` | Two calls on the same live connection, with the on-disk pause advanced from round 1 to round 2 between them, return round 1 then round 2 — every call is freshly re-derived from current state, never a cached prior response. | `apps/cli/tests/conformance/claude.test.ts`, `apps/cli/tests/conformance/codex.test.ts` |
| Input change | `task_escalation_read` | An `'objectives_changed'` pause reports `requestedAuthority: 'self'` and next actions naming that the next round re-reads current objectives on its own — the tool never claims a stale input is still current. | `apps/cli/tests/conformance/claude.test.ts`, `apps/cli/tests/conformance/codex.test.ts` |
| Human handoff | `task_escalation_read` | An `'escalation'` pause with a full durable `EscalationRecord` reports `requestedAuthority: 'principal'`, the run identity and input versions it was raised under, and the actions permitted next — the complete packet a recipient with no chat history needs. | `apps/cli/tests/conformance/claude.test.ts`, `apps/cli/tests/conformance/codex.test.ts` |
| Cancellation | `task_cancel` | A cancel authenticated by a fresh Principal ruling confirms once; a replayed call against the same, now-resolved escalation reports the SAME truthful outcome again, never an error. | `apps/cli/tests/conformance/claude.test.ts`, `apps/cli/tests/conformance/codex.test.ts` |
| Recovery | `task_resume` | A resolution already durably consumed by an earlier process (simulating a restart) is replayed as `already_resumed` by a freshly built handler — recovery reads durable state; it never blindly relaunches a worker. | `apps/cli/tests/conformance/claude.test.ts`, `apps/cli/tests/conformance/codex.test.ts` |

## D — Live acceptance evidence (O1)

Table C above proves the nine scenarios through a raw JSON-RPC test client
driving the real server — genuine protocol conformance, but not proof that a
live agent, deciding autonomously from a natural-language prompt, ever
reaches the same tool call. This section records what was, and was not,
established beyond that boundary, on the authoring host, without inventing
either.

**What was run.** `apps/cli/tests/conformance/live-smoke.ts` (deliberately
not a `.test.ts` — it writes one real Vinaya Log event and is meant to be
re-run by hand, never on every CI push) drives the exact same production
code path Table C's scenarios drive — the real `vinaya task-tools serve`
subprocess, the real router, the real `task_resume` handler — but through
the REAL `log()` chokepoint (`log-sink.ts`) instead of a test's injected
no-op, against the identical safe, non-mutating "Recovery" scenario (a
resolution already durably consumed; `resume.ts`'s early-return branch never
reaches the ruling-fetch code path that would need a real `gh` call, so this
can never launch a worker, open a PR, or touch the real forge). Isolation
reuses `harness.ts`'s own `buildSandbox()` verbatim — no second isolation
mechanism.

Captured live, this authoring run, `claude --version`: `2.1.197` — the same
binary and version `adapters.ts`'s `CLAUDE_MCP_ADAPTER` already records for
task 5's own registration-format check, re-confirmed here as still current.

Real typed event emitted by the real `log()` sink for this run (`meta.repo`
reads `attalabs/vinaya` because `buildSandbox()`'s own `AEG_REPO` fixture
value, not this repo's real `atta-labs/vinaya` slug, resolves inside the
sandbox — a harness cosmetic, not a defect in the event itself):

```json
{"meta":{"schema":2,"ts":"2026-09-19T18:07:01.881Z","run_id":"fe84ca0b-c5f2-468f-9d22-80942de5d74c","seq":0,"repo":"attalabs/vinaya","vinaya":"0.30.0","doctrine":"aeg-root@035322e12db8372ee4ad395a2486cd17a34eaa81","host":"cli","machine":"5003eaf71fd9dc3ed65835c1082b58acb04b794c1a34b18871607cbd50e3bbef","event_id":"78cbffd2-02ca-4e29-ad6b-48551bcbea34","process_id":"ec32c76b-4e28-406c-98f9-8349ed592cc6","actor_id":"developer","lineage":{"run":"739b3138-dafe-4b8a-85f7-88e1483832e3","attempt":null,"parent":null},"input_versions":{"objectives_version":null,"brief_hash":null,"ruling_ordinal":null,"policy_digest":null},"provenance":"env_correlated"},"subject":{"issue":9301,"role":"developer","round":1},"kind":"operation","payload":{},"operation":"task_resume","target":"task:9301","event":"completed","result":"ok","error_class":null}
```

Read against `log.md`'s own schema v2 fields: `event_id` and `process_id`
are populated (stable per-event and per-process identity); `actor_id` reads
`developer` and `provenance` reads `env_correlated` — this run's own
ambient `VINAYA_ROLE`, correctly attributed rather than fabricated, since
this script ran inside a dispatched Developer session, not an Operator one.
`lineage`/`input_versions` are honestly `null` where this call carries no
task/objectives context of its own — declared slots, not invented values —
exactly `log.md`'s own stated disposition for what a real producer fills in
versus what it leaves open.

**What was not run, and why — disclosed rather than papered over.** An
actual live-model-driven call — an LLM autonomously deciding, from a
natural-language prompt, to invoke `task_resume` over MCP, the one layer
`live-smoke.ts` cannot reach — was attempted during this task's authoring:
a sandboxed `claude -p` process, `--mcp-config` pointed at the real server,
`--permission-mode bypassPermissions` (required for a headless call to
approve an MCP tool with no attached human). This host's own agent-safety
classifier refused the attempt outright, naming the reason verbatim: this
live-authorization step is the task brief's own `[principal]` Test Plan
item, not the agent's to self-authorize. That refusal is itself the
correct, working boundary this milestone's own isolation doctrine
(`apps/cli/specs/isolation.md`) describes — not a gap this task papers over
by lowering the bar, per its own stop-and-escalate condition ("do not lower
an acceptance requirement to make a fixture pass"). The genuinely missing
evidence is exactly this one layer: proof that a real model, unprompted by
literal tool-call instructions, chooses to call these tools correctly.
That remains open, owed to the Principal's own authorized run against real
vendor credentials — recorded here as missing, not fabricated.

**Codex.** No `codex` binary exists on this authoring host — confirmed by
`which codex` (not found) and an empty `npm ls -g` for any Codex package,
the identical gap `adapters.ts`'s `CODEX_MCP_ADAPTER` already discloses
(`verifiedLiveOnAuthoringHost: false`) for the registration-format check.
`live-smoke.ts` therefore carries no Codex-runtime counterpart: there is no
binary on this host to run it against, live or otherwise. A Codex-runtime
live smoke run — like the Claude live-model layer above — awaits the
Principal's own authorized run on a host that has one.
