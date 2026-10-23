# The standalone developer-review loop — invariant map and defect oracle

Status: draft

Scope: the standalone developer-review loop as it ships today
(`apps/cli/specs/loop.md`), frozen as the behavioral oracle for the
Atta Engine productionization described in the Linear "Tech spec —
Developer-review on Atta Engine", revision 17, section 16. That design keeps the
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
  (revision 17, section 16.2). `vinaya-policy` covers the controller and
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
- **scenarios**: which of the scenario corpus's categories exercise it
  (happy path, revisions, invalid reviews, stale evidence, reviewer
  failure, developer failure, context pressure, cancellation, restart,
  uncertain effects, isolation refusal, Operator intervention). The
  evaluation program that section 16.16 of the design now points to reuses
  this corpus and this register;
- **sources** (path and symbol), **tests** (paths), and the **loop.md
  sections** that state it.

### The five classifications

<!-- AEG:CLAIM: apps/cli/tests/conformance/dev-review-invariant-coverage.test.ts contains:function unknownClassifications(inv: Inventory): string[] { -->
The register uses one classification vocabulary: the five values below, the
four kinds section 16.17's Outcome A asks the oracle to decide between
(guarantees, implementation accidents, known defects, advisory mechanisms)
plus the policy questions only the Principal settles. The architecture test
refuses any other value, in the invariant register and in the defect
register alike.

| Classification | Meaning |
| -- | -- |
| `product-guarantee` | The loop promises it (in loop.md, or through a shipped fix the entry records), deterministic code outside the worker enforces it, and at least one test is its oracle. When its scope is `product`, the Engine path must preserve it; at any other scope it is recorded and kept where it lives (see the scope rule below). |
| `implementation-accident` | Incidental structure or ordering, an emergent property of how the loop is run, or care for the repository, its tests or its tooling, that nothing promises. The Engine path need not reproduce it, and it maps to a scenario only where one exercises it. |
| `named-defect` | The code contradicts loop.md, the design or its own promise, or a weakness has been demonstrated. Each entry cites both sides in the defect register and records whether its fix shipped. When its scope is `product`, the Engine path must correct it, not copy it; at any other scope it is fixed where it lives. |
| `advisory` | Enforced only inside the worker, through hooks, permission rules or prompt text, so a worker can bypass it; or a residual risk, stated and never claimed closed. It never counts as a product guarantee (revision 17, sections 16.3 and 16.7). |
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

Findings recorded for a while under a second vocabulary — `guarantee`,
`defect`, `accident` and `hygiene` — were each read and folded into the five
above, and each folded entry's reason records its old value: every `guarantee`
is enforced by the controller outside the worker with a test as its oracle, so
it is a `product-guarantee`; every `defect` is a `named-defect` cited in the
defect register; `accident` and `hygiene` are `implementation-accident`.

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
The Engine runner keeps it: its recovery reads reach only the forge, the prior
launch record and the held verdict files, and the round journal comes from
`fetchLoopHistory`. The functions the two runners share for the heartbeat, the
exit record, the driver lock's keep-or-clear rule and the journal seeding
(`INV-116`, `INV-106`, `INV-101`) are named in
`dev-review-loop/driver-lifecycle.ts`, where the register's sources now point.

The Engine runner also completes a task through the standalone functions: it runs
the security scan before the reviewers and hands its output to the security
prompt only (`INV-070`), runs the `[live]` Test Plan lines of an approved head
(`INV-164`), writes `merged_ready` only after a successful publish and ends
every other leg `stopped` (`INV-021`, `INV-041`), and opens the deferred-findings
Issue from the publish step. The scan's command resolver is
`dev-review-loop/security-scan-command.ts`, shared by both runners.

<!-- AEG:CLAIM: apps/cli/tests/fixtures/dev-review-architecture-invariants.json contains:"path": "apps/cli/src/lib/dev-review-loop/unpushed-work.ts", -->
The Engine runner decides every round through the shared assessment as well:
a red gate is a gate observation (`INV-010`, `INV-016`), the time budget is
checked on gate and mechanical-failure observations (`INV-020`), a confidence
below 50 or a missing one is the assessment's extra turn (`INV-011`), a
rejected turn result earns one correction turn (`INV-013`, `INV-031`,
`INV-125`), a reviewer with no usable review gets one fresh attempt
(`INV-057`), the review-input manifest is one snapshot per round, re-read
before anything is held (`INV-062`, `INV-063`), a turn that publishes nothing
is resumed once and stalls are bounded (`INV-023`, `INV-033`, `INV-042`), and
the Flow's ceilings come from the review policy's round cap (`INV-005`). The
reader of a Developer's unpushed work is `dev-review-loop/unpushed-work.ts`,
shared by both runners, where `INV-042`'s source now points.

<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-loop/round-assess.ts contains:export async function waitForOwnLoopLine( -->
<!-- AEG:CLAIM: apps/cli/tests/fixtures/dev-review-architecture-invariants.json contains:"id": "INV-111", -->
Telemetry entries are therefore classified on their own terms (`INV-111`
and its neighbours). A telemetry defect, such as the per-event wait in
`waitForOwnLoopLine` for the event's own line, is recorded for the latency
it adds, and the map records no transition that depends on it.

## Registers

<!-- AEG:CLAIM: apps/cli/tests/fixtures/dev-review-architecture-invariants.json contains:"id": "DEF-51", -->
The **defect register** (`defects`) holds one entry per `named-defect`
invariant. Each one names the code or doctrine locator and the spec or
doctrine section it contradicts, or the weakness it demonstrates. Both
registers' sizes are stated under "Register counts" below. The most
consequential defects are:

- `--resume` and `--cancel` accept the mere presence of a ruling;
- a resolution is consumed before the one-driver lock check;
- reviewer isolation is cleaned up while a sibling reviewer is still
  running;
- reviewer candidate immutability rests on same-uid permission bits;
- cited finding ids are discarded in favor of positional ids;
- the conflict prompt instructs a push that the driver's own publication
  preconditions refuse;
- reviewers can be dispatched on a head whose CI never passed the gate;
- the below-50 extra developer turn is re-granted after a restart;
- once the infrastructure retry bound is spent, a bare `--resume` needs a
  Principal ruling, where the design asks for an Operator-remediation pause
  (`INV-084`, `DEF-52`).

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

The **ambiguity register** (`ambiguities`) holds thirteen questions, each ruled by
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

## Re-checked against revision 17

<!-- AEG:CLAIM: apps/cli/tests/fixtures/dev-review-architecture-invariants.json contains:"revision": 17, -->
<!-- AEG:CLAIM: apps/cli/tests/conformance/dev-review-invariant-coverage.test.ts contains:function staleReasonCitations(inv: Inventory): string[] { -->
The register's normative design is revision 17 of the Engine specification,
and the fixture's `normativeDesign` names it with the sections the register
rests on. This file, `apps/cli/specs/dev-review-engine-state-machine.md` and
`apps/cli/specs/dev-review-engine-capability-matrix.md` state the same
revision, and the architecture test fails when any of the four disagrees.
Every entry, defect and ambiguity was re-read against revision 17's section
16; every reason that cited a section now cites revision 17, and the test
fails on a reason citing another revision or a section the fixture does not
list. The contracts revision 17 changed or added since the register was last
pinned, and the entries they touched:

- **A pause is a durable, nonterminal interrupt, resolved one of three ways**
  (sections 16.4 and 16.11: automatic recovery, Operator remediation,
  Principal ruling). The pause record, escalation and lock entries
  (`INV-076`, `INV-086`, `INV-106`) and the automatic-recovery entries
  (`INV-023`, `INV-057`, `INV-109`, `INV-140`, `INV-144`) keep their
  classification with reasons stating it; `INV-163`'s host-repair pause is the
  Operator-remediation pause. `INV-084` changed classification: past the
  retry bound the standalone path asks for a Principal ruling where revision
  17 asks for Operator remediation and says infrastructure is never a stop for
  the Principal, so it is now a `named-defect` (`DEF-52`). The rulings
  `AMB-10` and `AMB-11` already agree with the three-way split.
- **Cutover gates 16 and 17** (section 16.18). Gate 16 requires the Engine
  path to resume and run through Atta Engine's public start and resume with
  Vinaya's injected executor; the self-driven watcher and round sequence
  (`INV-090`, `INV-099`) are the oracle for the behavior, not the mechanism
  kept. Gate 17, the Principal's approval of the default-backend change, has
  no standalone behavior to register.
- **The beyond-Surface publication rule** (section 16.12). Publication never
  refuses a path beyond the Surface and the controller rebuilds its record;
  both runners do both through the shared live Developer context (`INV-033`, `INV-068`), and protected
  paths stay refused unless the frozen scope names them (`INV-120`,
  `INV-137`).
- **Two secret classes** (section 16.15). Controller-held secrets never enter
  controller-composed model context or events (`INV-078`, `INV-126`); a secret
  an agent meets through an authorized open read must be contained
  (`INV-065`). The staged Codex login stays an `advisory` residual risk
  (`INV-135`), and same-user reach stays recorded as cutover gates 14 and 15
  (`INV-136`).
- **The evaluation program takes over section 16.16.** No entry's contract
  changed; the program reuses this register and the scenario corpus, and its
  register check reads the counts below.
- **The outcome exits of section 16.17.** Outcome A's exit — no target
  guarantee lacks an owner, a representation, a failure behavior and a test
  oracle — is what the architecture exit test checks over every
  `product-guarantee`. Outcome C's authoritative actor attribution is the
  basis of `INV-122`.

## Register counts

<!-- AEG:CLAIM: apps/cli/tests/conformance/dev-review-invariant-coverage.test.ts contains:function computedCounts(inv: Inventory): Map<string, number> { -->
The architecture test computes every count below from the fixture and fails
when a row here differs, is missing, or names a count it does not compute.

| Count | Value |
| -- | -- |
| invariants | 164 |
| invariants classified product-guarantee | 82 |
| invariants classified implementation-accident | 10 |
| invariants classified named-defect | 52 |
| invariants classified advisory | 7 |
| invariants classified principal-ruling-required | 13 |
| invariants in product scope | 139 |
| invariants in reference-process scope | 10 |
| invariants in implementation scope | 15 |
| defects | 52 |
| defects open | 38 |
| defects fixed | 14 |
| defects in product scope | 41 |
| defects in reference-process scope | 8 |
| defects in implementation scope | 3 |
| ambiguities | 13 |

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
next free identifier in each register it enters, one of the five
classifications, a scope and a summary of its evidence, and update the
register counts above in the same change. Recording a finding never changes
an existing entry's classification or scope silently: a reclassification
records its old value and its basis in the entry's reason.
