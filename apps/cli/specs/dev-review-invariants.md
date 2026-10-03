# The standalone developer-review loop — invariant map and defect oracle

Status: draft

Scope: the standalone developer-review loop as it ships today
(`apps/cli/specs/loop.md`), frozen as the behavioral oracle for the
Atta Engine productionization described in the Linear "Tech spec —
Developer-review on Atta Engine", revision 7. That design keeps the
standalone path as oracle, fallback and regression source, but does not
treat it as the ideal design: every valid guarantee must be preserved,
and every demonstrated weakness must be replaced on purpose. This file
says which behaviors are which. It changes no production behavior and
designs no Engine state machine.

The data lives in
`apps/cli/tests/fixtures/dev-review-architecture-invariants.json`. Its
architecture test,
`apps/cli/tests/conformance/dev-review-invariant-coverage.test.ts`,
keeps the data honest against the checkout.

## The surface

The surface is found by listing directories, never by scanning source
text:

- implementation: `apps/cli/src/commands/dev-review-loop.ts`,
  `apps/cli/src/lib/dev-review-loop.ts`, every `.ts` file in
  `apps/cli/src/lib/dev-review-loop/`, and every non-test `.ts` file in
  `packages/aeg-core/src/dev-review-loop/`;
- tests: `apps/cli/tests/commands/dev-review-loop.test.ts`, every
  `apps/cli/tests/lib/dev-review-loop*` test file, every test file in
  `apps/cli/tests/lib/dev-review-loop/`, and the `*.test.ts` files beside
  the policy layer in `packages/aeg-core/src/dev-review-loop/`.

At the baseline revision `d01194ea` this gives **15 implementation
modules and 26 test files**, listed by path in the fixture's `baseline`
block. Two files on the surface are neither: `fakes.ts`, the policy
layer's test fakes, and `dev-review-loop-harness.ts`, the in-process
harness. They are declared as support files, each with a reason.

One module and its test landed after the baseline: the driver-side
publication of each Developer turn (`developer-publication.ts`). They are
recorded under `addedSinceBaseline` and classified from loop.md's
existing "Publishing each Developer turn" section, so the checkout now
holds 16 modules and 27 test files. The test fails when a file appears or
disappears without a matching entry, so the baseline can never drift
silently.

Every surface file is either cited by at least one invariant (as a
source or as a test) or listed under `exclusions` with a concrete reason
why it encodes no loop behavior. There are two exclusions:
`packages/aeg-core/src/dev-review-loop/index.ts`, a re-export barrel, and
`dev-review-loop-real-process-debt.test.ts`, a ratchet over another test
file's source text. An invariant may also cite a file outside the
surface, such as `dispatch.ts` for the Documentation read-gate and
reviewer permissions, where the behavior is actually decided there.

## One entry per observed behavior

Each invariant records:

- **behavior**: what the loop does, derived from the implementation and
  its tests, never from a name alone;
- **classification**: one of five values (below);
- **owner**: the layer that owns the behavior in the target design
  (revision 7, section 16.2). `vinaya-policy` covers the controller and
  policy libraries; `engine-runtime` covers scheduling, joins,
  checkpoints, interrupts and locks; `provider-adapter` covers vendor
  invocation, sessions and sandboxing; `governed-operation` covers
  authorized, idempotent effects; `log` covers telemetry;
  `operator-control` covers inspect, resume, cancel and escalation.
  `standalone-only` marks a behavior that belongs to the standalone driver
  and does not carry into the Engine path;
- **authority**: what kind of state decides it. `control-state` is the
  pause record, the escalation and resolution records, the loop-state
  record, the driver lock and the publication record — the state that
  resume and recovery read. `forge` is repository and pull-request facts
  and marked comments. `pure-policy` is a deterministic function of its
  inputs. `effect` is an external or filesystem mutation. `telemetry` is
  the Vinaya Log and the per-task driver log;
- **scenarios**: which of the design's Phase A scenarios exercise it
  (happy path, revisions, invalid reviews, stale evidence, reviewer
  failure, developer failure, context pressure, cancellation, restart,
  uncertain effects, isolation refusal, Operator intervention);
- **sources** (path and symbol), **tests** (paths), and the **loop.md
  sections** that state it.

### The five classifications

| Classification | Meaning |
| -- | -- |
| `product-guarantee` | loop.md promises it, deterministic code outside the worker enforces it, and at least one test is its oracle. The Engine path must preserve it. |
| `implementation-accident` | Incidental structure or ordering that nothing promises. The Engine path need not reproduce it. |
| `named-defect` | The code contradicts loop.md, or a weakness has been demonstrated. Each entry cites both sides in the defect register. The Engine path must correct it, not copy it. |
| `advisory` | Enforced only inside the worker, through hooks, permission rules or prompt text, so a worker can bypass it. It never counts as a product guarantee (revision 7, sections 16.3 and 16.7). |
| `principal-ruling-required` | Spec and code are silent or in conflict on a policy choice. The entry is recorded with its ruling status and is never decided here. |

## Control state versus telemetry

The Vinaya Log is never control truth. Every resume and recovery path
reads the control store, the pause and escalation records, or forge
comments written by the Principal's account. No path reads the Log or the
per-task driver log back to make a decision. Telemetry entries are
therefore classified on their own terms. A telemetry defect, such as a
duplicated `round_started` or a five-second wait for the event's own line
when the destination records nothing, can add latency or noise, but it
never changes a transition.

## Registers

The **defect register** (`defects`) holds 24 entries. Each one names the
code locator and the spec section it contradicts, or the weakness it
demonstrates. The most consequential are:

- `--resume` and `--cancel` accept the mere presence of a ruling;
- a resolution is consumed before the one-driver lock check;
- reviewer isolation is cleaned up while a sibling reviewer is still
  running;
- reviewer candidate immutability rests on same-uid permission bits;
- cited finding ids are discarded in favor of positional ids;
- the conflict prompt instructs a push that the driver's own publication
  preconditions refuse;
- reviewers can be dispatched on a head whose CI never passed the gate;
- the below-50 extra developer turn is re-granted after a restart.

The **ambiguity register** (`ambiguities`) holds 13 questions, all marked
`awaiting-principal`. Among them:

- exit precedence when several exits apply;
- what counts as a reappearance;
- whether stale-driver pauses resume unattended;
- whether CI that is stuck pending, or absent entirely, is a developer
  failure or an infrastructure pause;
- whether a reviewer with no verified candidate should pause the round.

No agent may resolve one of these by editing this map. Only a Principal
ruling can, and that ruling's status is then recorded on the entry.

## Changing the map

When a loop module or test file is added, removed or renamed, update the
fixture in the same change: map the file to an invariant or exclude it
with a reason. When a defect is fixed, keep its entry and set its status
to `fixed`, so the register remains a record of what the Engine path must
not regress to. Run the architecture test by naming it: it prints the
module and test totals, the unmapped and unresolved path counts (both
must be zero), and the count of invariants under each classification,
authority and scenario.
