# The standalone developer-review loop — invariant map and defect oracle

Status: draft

Scope: the standalone developer-review loop as it ships today
(`apps/cli/specs/loop.md`), frozen as the behavioral oracle for the
Atta Engine productionization described in the Linear "Tech spec —
Developer-review on Atta Engine", revision 9. That design keeps the
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

<!-- AEG:CLAIM: apps/cli/tests/conformance/dev-review-invariant-coverage.test.ts contains:return readdirSync(abs, { withFileTypes: true }) -->
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

<!-- AEG:CLAIM: apps/cli/tests/conformance/dev-review-invariant-coverage.test.ts contains:expect(implementation).toEqual(expectedImpl) -->
One module and its test landed after the baseline: the driver-side
publication of each Developer turn (`developer-publication.ts`). They are
recorded under `addedSinceBaseline` and classified from loop.md's
existing "Publishing each Developer turn" section, so the checkout now
holds 16 modules and 27 test files. The test fails when a file appears or
disappears without a matching entry, so the baseline can never drift
silently.

<!-- AEG:CLAIM: apps/cli/tests/fixtures/dev-review-architecture-invariants.json contains:"path": "apps/cli/src/lib/dev-review-loop/turn-result.ts", -->
<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-loop/turn-result.ts contains:export function confidenceFromRecords( -->
The Developer's turn result moved onto each CLI's native structured
output (`turn-result.ts`, with its test), also recorded under
`addedSinceBaseline`. The confidence entry, `INV-013`, now names that
result as the confidence's only source: the driver reads the newest result
its controller accepted with status `completed`, and anything else — a
rejected result, a `blocked` or `needs_ruling` one, or none at all — reads
absent, never a made-up number. The guarantee is unchanged; only its
source moved from the file the Developer wrote to the structured output
the CLI returns.

<!-- AEG:CLAIM: apps/cli/tests/conformance/dev-review-invariant-coverage.test.ts contains:const excluded = new Set(inv.exclusions.filter((e) => e.reason.trim().length > 0).map((e) => e.path)) -->
<!-- AEG:CLAIM: apps/cli/tests/fixtures/dev-review-architecture-invariants.json contains:"path": "packages/aeg-core/src/dev-review-loop/index.ts", -->
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
- **classification**: what the finding is (below);
- **scope**: whose the finding is (below);
- **owner**: the layer that owns the behavior in the target design
  (revision 9, section 16.2). `vinaya-policy` covers the controller and
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
| `product-guarantee` | loop.md promises it, deterministic code outside the worker enforces it, and at least one test is its oracle. When its scope is `product`, the Engine path must preserve it; at any other scope it is recorded and kept where it lives (see the scope rule below). |
| `implementation-accident` | Incidental structure or ordering that nothing promises. The Engine path need not reproduce it. |
| `named-defect` | The code contradicts loop.md, or a weakness has been demonstrated. Each entry cites both sides in the defect register. When its scope is `product`, the Engine path must correct it, not copy it; at any other scope it is fixed where it lives. |
| `advisory` | Enforced only inside the worker, through hooks, permission rules or prompt text, so a worker can bypass it. It never counts as a product guarantee (revision 9, sections 16.3 and 16.7). |
| `principal-ruling-required` | Spec and code are silent or in conflict on a policy choice. The entry is recorded with its ruling status and is never decided here. |

### The classification and scope fields

<!-- AEG:CLAIM: apps/cli/tests/conformance/dev-review-invariant-coverage.test.ts contains:if (!e.summary?.trim()) out.push(`${e.id}: summary`) -->
<!-- AEG:CLAIM: apps/cli/tests/conformance/dev-review-invariant-coverage.test.ts contains:`defects by scope: ${SCOPES.map((s) => `${s} ${defectsByScope[s]}`).join(', ')}` -->
Every entry of the invariant register and of the defect register carries two
separate fields and a summary, and the architecture test fails on an entry
missing any of the three. An invariant's summary is its `behavior`; a defect's
is its `summary`. The classification says what the finding is; the scope says
whose it is, so a process-specific defect and product-level hygiene stay
distinguishable. The test prints the count of entries under each
classification and under each scope, for the invariant register and for the
defect register.

The classification vocabulary was extended, not replaced. The five values
above keep their meaning and their counts, and an entry's recorded
classification is never changed silently. Findings recorded since the register
froze use the five values below, which name nearly the same ideas more plainly:
`guarantee` is the new name for `product-guarantee`, `defect` for
`named-defect`, and `advisory` is shared. `accident` widens
`implementation-accident` to cover an emergent property of how the loop is
run, and a scenario mapping is required of `guarantee` and `defect` but is
optional for `accident` and `hygiene`. The section citations in the existing
entries' reasons were written against revision 7 of the design and are kept as
recorded; they were not re-checked against revision 9.

| Classification | Meaning |
| -- | -- |
| `guarantee` | A promise the loop keeps through deterministic code outside the worker, with at least one test as its oracle, and a mapping to the corpus scenario that will exercise it. |
| `defect` | A demonstrated weakness: the code contradicted its own promise, or a failure was observed. It cites the defect register, records whether its fix shipped, and maps to a corpus scenario. |
| `accident` | Incidental structure, or an emergent property of how the loop is run, that nothing promises and that need not be reproduced. |
| `hygiene` | Care for the repository, its tests or its tooling that protects no product behavior. It is kept so it is not lost, and it is never an Engine contract. |
| `advisory` | A residual risk or a control enforceable only inside the worker, stated and never claimed closed. |

| Scope | Meaning |
| -- | -- |
| `product` | The behavior belongs to the product the Engine path delivers, whichever process runs it. |
| `reference-process` | The behavior belongs to the process around the product, not to a loop module: how tasks are numbered, how many loops an operator starts, and the role doctrine the agents read — what it tells a reviewer, a Developer or a Planner, and whether each rule it states has a check behind it. |
| `implementation` | The behavior belongs to this standalone implementation (its launcher, its test selection, its test hygiene) and does not carry into the Engine path. |

Only a `product`-scope guarantee becomes an Engine contract. A guarantee or a
defect of any other scope is recorded and fixed where it lives, and the Engine
path does not inherit it. Existing entries were given a scope from their owner:
those owned by `standalone-only` are `implementation` scope, every other
entry is `product` scope. Later entries carry the scope their finding states.
A rule the Issue write gate, the controller or the rendered brief must keep is
`product` scope, whichever repository runs the loop; a sentence of role
doctrine that contradicts the controller, the policy or another rule is
`reference-process` scope, fixed in the doctrine where it lives.

## Control state versus telemetry

<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-loop/pause-resume.ts contains:export function recoverLoopState( -->
<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-loop/pause-resume.ts contains:export function readPauseState(root: string, task: number): PauseState | null { -->
<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-loop/journal-history.ts contains:export function fetchLoopHistory(prNumber: number | null): ReconstructedJournal { -->
<!-- AEG:CLAIM: apps/cli/tests/fixtures/dev-review-architecture-invariants.json contains:"id": "INV-096", -->
The map treats the Vinaya Log as telemetry, never as control truth. The
recovery reads the audit traced are the control store's loop state
(`recoverLoopState`), the pause record (`readPauseState`), and comments
written by the Principal's account (`fetchLoopHistory`). That finding is
recorded as `INV-096`, a product guarantee, and the Engine path must keep
it.

<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-loop/round-assess.ts contains:export async function waitForOwnLoopLine( -->
<!-- AEG:CLAIM: apps/cli/tests/fixtures/dev-review-architecture-invariants.json contains:"id": "INV-111", -->
Telemetry entries are therefore classified on their own terms (`INV-111`
and its neighbours). A telemetry defect, such as the per-event wait in
`waitForOwnLoopLine` for the event's own line, is recorded for the latency
it adds, and the map records no transition that depends on it.

## Registers

<!-- AEG:CLAIM: apps/cli/tests/fixtures/dev-review-architecture-invariants.json contains:"id": "DEF-51", -->
The **defect register** (`defects`) holds 51 entries: 24 `named-defect` and
27 `defect`, of which 40 are `product` scope, 8 `reference-process` and 3
`implementation`. Each one names the code or doctrine locator and the spec or
doctrine section it contradicts, or the weakness it demonstrates. The
invariant register holds 162 entries, 137 of them `product` scope, 10
`reference-process` and 15 `implementation`. The most consequential are:

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

<!-- AEG:CLAIM: apps/cli/tests/fixtures/dev-review-architecture-invariants.json contains:"id": "INV-162", -->
`INV-145` to `INV-162`, with `DEF-35` to `DEF-51`, record a study of the role
doctrine against the code and a study of how single-fix Issues degenerated.
They cover the doctrine the agents read, the Issue write gate and the brief
the controller renders, which the register held almost nothing about. All are
`open`. The `product`-scope ones are rules the Engine path inherits: the Issue
write gate resolves a Project against the registry, checks that every
Documentation source exists, accepts only Test plan lines the Developer can
run, prints the conflict warning the doctrine describes and grades only
content a gate checks; the documentation-claim binding check runs where the
doctrine says; a rendered brief carries no instruction a tool refuses; both
agent adapters are refused the same commands; a prompt names the installed
command, never a repository path; and a reported test failure is checked by
the controller. The `reference-process`-scope ones are fixed in the doctrine:
a reviewer's blocking severities come from policy, and every severity it
names rests on a check that runs and sits on its role's scale; reviewer and
Developer instructions describe the loop and the controller that run them;
planner doctrine names only commands that exist; and every Issue the loop
runs passed a read-the-code-first step. `INV-162` is an advisory, not a
defect: the role doctrine's rule lines grew from 248 to 437 in eight weeks
while the registered checks stayed at 38, and a rule with no check behind it is a
smell, never a guarantee.

The **ambiguity register** (`ambiguities`) holds 13 questions, each ruled by
the Principal: the entry's `rulingStatus` is `ruled` and its `ruling` field
holds the ruling. Among them:

- exit precedence when several exits apply: the most severe wins;
- what counts as a reappearance: any resolved finding re-reported as open or
  with no state;
- whether stale-driver pauses resume unattended: they do, within a retry bound;
- whether CI that is stuck pending, or absent entirely, is a developer
  failure or an infrastructure pause: neither is the developer's fault;
- whether a reviewer with no verified candidate should pause the round: it
  re-stages and retries, and never runs unisolated.

The rulings share one principle: infrastructure is never a stop for a human.
It is a bounded retry with backoff that resumes by itself; only an
escalation, a principal item and max rounds stop for the Principal.

No agent may resolve one of these by editing this map. Only a Principal
ruling can, and that ruling's status is then recorded on the entry.

## Changing the map

<!-- AEG:CLAIM: apps/cli/tests/conformance/dev-review-invariant-coverage.test.ts contains:`unmapped paths: ${unmapped.length}`, -->
When a loop module or test file is added, removed or renamed, update the
fixture in the same change: map the file to an invariant or exclude it
with a reason. When a defect is fixed, keep its entry and set its status
to `fixed`, so the register remains a record of what the Engine path must
not regress to. Run the architecture test by naming it: it prints the
module and test totals, the unmapped and unresolved path counts (both
must be zero), the count of invariants under each classification,
scope, authority and scenario, and the count of defect-register entries
under each classification and scope. When a finding is recorded, give it the
next free identifier in each register it enters, a classification, a scope
and a summary of its evidence; recording it never changes an existing
entry's classification or scope.
