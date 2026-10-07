# The target Atta-Engine developer-review workflow — state machine and node contracts

Status: draft

Scope: the final, provider-neutral state model, transitions, terminal
outcomes, node contracts, human-handoff contract, cancellation behavior, and
effect-once boundaries for the Atta-backed developer-review workflow (Linear
"Tech spec — Developer-review on Atta Engine", revision 9, section 16). This
is the TARGET contract production execution must satisfy. It does not
implement that execution, does not assess provider or runtime capabilities,
and does not alter the standalone loop — `apps/cli/specs/loop.md` remains the
standalone behavioral oracle, unchanged by this file.

The data lives in
`apps/cli/tests/lib/dev-review-loop/dev-review-engine-state-contract.fixture.ts`.
Its contract test,
`apps/cli/tests/lib/dev-review-loop/dev-review-engine-state-contract.test.ts`,
keeps the data internally honest: every state has an owner, every transition
a trigger and a deterministic guard, every terminal outcome explicit
persistence and resumption behavior, every node contract every required
field, and zero provider name anywhere outside the one declared adapter
extension-point list.

## Why this file exists, and what it consumes

<!-- AEG:CLAIM: apps/cli/tests/fixtures/dev-review-architecture-invariants.json contains:"rulingStatus": "ruled", -->
This model encodes only two kinds of fact: product guarantees the standalone
loop already demonstrates (`apps/cli/specs/dev-review-invariants.md`'s
`product-guarantee` entries), and the thirteen policy questions frozen as
`ambiguities` in
`apps/cli/tests/fixtures/dev-review-architecture-invariants.json` — every
one of which now carries `rulingStatus: "ruled"` and a `ruling` field
recording the Principal's answer. No entry in this file represents a
Developer's own policy choice; where a transition's behavior follows
directly from one of those thirteen rulings, the transition or node
contract names it (`AMB-01` through `AMB-13` all appear at least once).

## The states (O1)

<!-- AEG:CLAIM: apps/cli/tests/lib/dev-review-loop/dev-review-engine-state-contract.fixture.ts contains:export const ENGINE_STATES: EngineState[] = [ -->
Fifteen named positions `Progress.currentNode` may hold, each with an
**owner** (the layer that decides what happens while control sits there) and
an **authority** (what kind of state that decision reads):

| State | Owner | Authority |
| ----- | ----- | --------- |
| `prepare_run` | vinaya-policy | control-state |
| `reconcile_external_state` | engine-runtime | control-state |
| `prepare_sources` | governed-operation | effect |
| `dispatch_developer` | provider-adapter | effect |
| `await_developer` | engine-runtime | control-state |
| `validate_developer_output` | vinaya-policy | pure-policy |
| `run_mechanical_gates` | governed-operation | effect |
| `classify_gate_failure` | vinaya-policy | pure-policy |
| `dispatch_reviewers` | provider-adapter | effect |
| `validate_reviewer_outputs` | vinaya-policy | pure-policy |
| `assess_round` | vinaya-policy | pure-policy |
| `build_revision_handoff` | vinaya-policy | pure-policy |
| `raise_human_handoff` | operator-control | control-state |
| `publish_ready_for_merge` | governed-operation | effect |
| `cancel_run` | operator-control | control-state |

This covers every behavior category O3 names: **developer**
(`dispatch_developer`/`await_developer`), **reviewer** (`dispatch_reviewers`),
**mechanical gate** (`run_mechanical_gates`/`classify_gate_failure`),
**human handoff** (`raise_human_handoff`), **publication**
(`publish_ready_for_merge`), **restart** (`reconcile_external_state`), and
**cancellation** (`cancel_run`) — none of their fifteen descriptions names a
provider.

### Control state versus telemetry

Exactly as `apps/cli/specs/dev-review-invariants.md` records for the
standalone loop (`INV-096`), this model never treats the Vinaya Log as
checkpoint or recovery authority. Every state above with `authority:
control-state` is what resume and recovery read; the Log (tech spec §
16.13) observes what happened and emits events describing it, but a
transition's guard never reads a Log event to decide anything — "the Log
observes what happened. It never decides what may happen next" (tech spec
§ 16.2).

## The transitions (O1)

Thirty-three edges, each with a `trigger` (the event or condition that fires
it) and a `guard` — a deterministic predicate the controller evaluates,
never a model's own judgement call. The register below names only the edges
whose specific shape follows from a Principal ruling; the fixture carries
the full set.

| Edge | From → To | Ruling followed |
| ---- | --------- | ---------------- |
| T14–T16 | `classify_gate_failure` → `dispatch_developer` / `run_mechanical_gates` / `raise_human_handoff` | **AMB-10** — stuck-pending or absent CI is never the developer's fault; it is retried as infrastructure, bounded, and a check waiting on the Principal is waited on, never sent to the developer. The same classification routes a commit-hook refusal of the driver's own commit the other way (**AMB-05**): that one is always `developer_fault`, sent back at once. |
| T18–T19 | `dispatch_reviewers` → `dispatch_reviewers` / `raise_human_handoff` | **AMB-09** — a reviewer with no verified candidate is re-staged and retried, bounded; only after that bound is exhausted does it become an infrastructure retry, which itself resumes unattended. A reviewer never runs unisolated. |
| T24 | `assess_round` → `raise_human_handoff` | **AMB-01** — when several exits apply in the same round, the most severe wins in a fixed order (escalation, then a Principal-owned item, then repeat, then max-rounds, then infrastructure); every applicable reason is still recorded, only the top one is shown. |
| T30 | `raise_human_handoff` → `reconcile_external_state` | **AMB-11** — a `stale_driver` pause resumes unattended, within its own bound, exactly like infrastructure; every other pause reason requires an authenticated ruling. |

`assess_round` itself also encodes **AMB-02** (a resolved finding
re-reported as open, or with no state, counts as a reappearance — silence
never hides a regression) and **AMB-03** (`journal_finalized.rounds` counts
distinct reviewed rounds, not attempts). `reconcile_external_state` encodes
**AMB-13** (the stale-driver check fetches the remote and compares against
the repository's actual default branch, never a hard-coded name).
`publish_ready_for_merge` encodes **AMB-06** (an identical judged head
re-checks only mergeability, never re-review) and **AMB-07** (a republish
after a restart only appends to an existing deferred-findings record, never
shrinks it). `prepare_run` encodes **AMB-08** (the bootstrap task-branch push
may skip repository hooks but never bypasses the Broker). `dispatch_developer`
encodes **AMB-04** (a resume may select a different qualifying developer
model than the paused attempt used, recorded rather than assumed).

The rulings share one principle the Principal stated directly:
**infrastructure is never a stop for a human.** It is a bounded retry with
backoff that resumes by itself; only an escalation, a Principal-owned item
and exhausting max-rounds stop for the Principal.

## The terminal outcomes (O1)

<!-- AEG:CLAIM: apps/cli/tests/lib/dev-review-loop/dev-review-engine-state-contract.fixture.ts contains:export const TERMINAL_OUTCOMES: TerminalOutcome[] = [ -->
Five, never collapsed into one value: `ready_for_merge`, `paused`, `failed`,
`cancelled`, `exhausted`. Each carries explicit **persistence** (what
control-state records the instant it is reached) and **resumption**
(whether and how a later action can continue past it — never implied merely
because a graph node can rerun):

- **`ready_for_merge`** — terminal; never resumed. A later task or round
  starts a new run instead.
- **`paused`** — the one outcome with real resumption: typed external input,
  revalidated for authority and freshness before it changes anything. A
  stale ruling, a changed patch, or a superseded objective set refuses to
  resume the old checkpoint silently (tech spec § 16.11). `stale_driver`
  (AMB-11) is the sole exception that resumes unattended.
- **`failed`** — terminal; a stable error class is recorded. Only a new,
  distinguishable run continues the work.
- **`cancelled`** — terminal; every owned process tree and in-flight effect
  was terminated or fenced. A repeated cancel call replays the same outcome
  idempotently rather than re-entering the run.
- **`exhausted`** — terminal; names which budget ran out (rounds, turns,
  time, token, cost), kept distinct from `failed`/`cancelled`/`paused` so
  exhaustion is never reported as success and never silently reclassified as
  one of the other three (tech spec § 16.14).

## The node contracts (O2)

Every one of the fifteen states above that performs work also carries a
complete node contract: typed input, typed output, side-effect
classification, retry policy, timeout policy, failure behavior,
cancellation behavior, and the Log event kinds it owns emitting (`<kind>:
<event>`, every one a family `apps/cli/specs/log.md` already ships — this
model invents no new Log family). The contract test enforces that no field
is missing; this section explains the two load-bearing ones.

### Side-effect classification and effect-once boundaries

<!-- AEG:CLAIM: apps/cli/tests/lib/dev-review-loop/dev-review-engine-state-contract.fixture.ts contains:export type SideEffectClass = (typeof SIDE_EFFECT_CLASSES)[number] -->
Five classes (tech spec § 16.12): `none`, `pure-read-only`, `replay-safe`,
`idempotent-keyed`, `reconcilable-not-replayable`. `publish_ready_for_merge`
and `reconcile_external_state` are `reconcilable-not-replayable` on purpose —
a graph node being able to rerun is never the same claim as an effect being
safe to repeat. A crash after a remote publish succeeds but before the local
acknowledgement lands creates an **uncertain** effect; the next entry to
`reconcile_external_state` resolves it by its own stable identity, and it is
never blindly re-executed merely because the node containing it can run
again. `prepare_sources` and `dispatch_developer`/`dispatch_reviewers` are
`idempotent-keyed`: a retry is keyed by source id or attempt id, so a retry
after a lost acknowledgement collapses to one record rather than a
duplicate.

### Human handoff is durable, not an error string

`raise_human_handoff`'s contract is the human-handoff contract in full: a
stable pause identity, the exact decision required, compact authoritative
evidence, attempted automated recovery, allowed actions and their schemas,
and expiry/staleness conditions — all durably written before anything is
reported anywhere (tech spec § 16.11). Its own failure behavior closes a gap
the standalone loop's defect register names: if the escalation record itself
cannot be written, the pause is re-raised on the next driver start rather
than left silently unrecoverable (**AMB-12**).

### Cancellation

`cancel_run` terminates every owned process tree with bounded escalation and
fences every in-flight effect, and a repeated cancel call on an
already-cancelled run is idempotent. Cancellation is reachable from every
in-flight state (`T32`), not only from a pause — the model never requires a
run to be paused before it can be cancelled.

## Provider-neutral core (O3)

<!-- AEG:CLAIM: apps/cli/tests/lib/dev-review-loop/dev-review-engine-state-contract.fixture.ts contains:export const PROVIDER_ADAPTER_EXTENSION_POINTS = [ -->
None of the fifteen states, thirty-three transitions, five terminal outcomes
or fifteen node contracts names a provider, a model, a hook, a plugin, a
tool-block format, or a vendor session shape. The core exposes three typed
ports instead (tech spec § 16.3's `AgentRuntime`, `ToolCatalog`,
`SourceProvider`), and the ONLY place a provider name is permitted to appear
is the explicit extension-point list naming which adapters implement each
port today (`claude-code-adapter`, `codex-adapter`). This is confinement,
not absence: a provider adapter translates the portable invocation into
each runtime's own configuration — instructions, sandbox, tool discovery,
session continuation, hook/plugin integration where supported — and that
translation lives entirely behind the port, never inside a state,
transition guard, or node contract field. Hooks are adapter mechanisms, not
product guarantees (tech spec § 16.3): a guarantee is product-level only
when Vinaya can enforce or verify it outside the worker process, which is
exactly what every `authority: control-state` / `authority: effect` node
above does.

## Changing this model

When a Principal ruling supersedes one of the thirteen cited above, or a
new ambiguity is ruled, update the fixture in the same change and cite the
new ruling from the transition or node contract it changes — never silently
re-decide the model's shape without a citation. Run the contract test by
naming it: it prints the state, transition, terminal-outcome and
node-contract counts, and the missing-contract-field and
provider-specific-core-field counts, both of which must read zero.
