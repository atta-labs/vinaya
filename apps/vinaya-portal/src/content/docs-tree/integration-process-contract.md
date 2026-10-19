# Process contract — Vinaya

Summary: How the Vinaya process fills in the Dev Process contract: what it owns, how it implements the six elements, the identities that bind them, its lifecycle, the authority it needs and every declaration.
Parent: Integration
Badges: Six elements · Identities · Lifecycle · Twelve declarations

## About Vinaya's process contract

This page answers the generic [Process contract](/docs/dev-process/process-contract) for the Vinaya process.

Vinaya is an opinionated process for planning software work, executing an Intent through independent review, and closing its records after merge. It owns its work-item grammar, roles, hand-offs, review topology, policy, closing rules and process-specific gates. The harness owns Runs, authority, generic gates, effects and common event emission. [Adapters](/docs/process/integration/adapters) perform external translations and operations.

## How it works

```steps
### A work item becomes a frozen Intent
A GitHub Issue, through its frozen brief, becomes the Intent. See [Thinking](/docs/process/thinking).

### The Developer produces an exact Change
One pull request against the declared parent branch. See [Executing](/docs/process/executing).

### Evidence and Reviews judge it
Mechanical checks run on the exact head; Code and Security review it in parallel. See [Gates](/docs/process/gates).

### The controller decides
Revise, pause, fail, cancel, exhaust, or publish the current revision as ready. The Principal merges.
```

## The six elements

| Generic element | Vinaya implementation |
| --- | --- |
| Intent | A frozen brief plus versioned objectives and rulings derived from a work item |
| Execution | Developer, Reviewer, Security, Operator and other role runs against the brief, including current rulings and revision instructions |
| Change | Repository, base revision, exact pull-request head and patch identity produced by change-producing Developer Executions |
| Evidence | Mechanical checks, tests and source receipts bound to the current Change, recomputed or attested as declared |
| Review | A fresh Code or Security assessment of one immutable review-input manifest, bound to the current Intent, Change and policy |
| Decision | The controller's assessment: revise, pause, fail, cancel, exhaust, or publish as ready for the Principal to merge |

The harness Run groups Vinaya's execution legs, nodes and attempts under pinned inputs. Merge is a Principal action after the process publishes the current Change as ready.

## Identities

```text
Run          run identity + task identity + controller epoch
             + pinned process, policy, brief, ruling ordinal, base and repository
Intent       task identity + frozen brief digest + objective version + ruling ordinal
Execution    run + role + round + attempt + session identity
Change       repository + base + head + patch identity
Evidence     evidence identity + change binding + producer + producer version
Review       role + attempt + intent/change/policy bindings
             + review-input manifest digest + reviewer
Decision     run + round + Intent version + change binding
             + accepted Evidence/Reviews + policy digest
```

A ruling invalidates the Evidence, Reviews and Decision that depend on it. A new head, base, patch, instruction, objective, ruling or policy version invalidates the artifacts bound to the value it replaces.

## Lifecycle

```text
work item → frozen Intent → Developer Execution → exact Change
          → mechanical Evidence → parallel Code and Security Reviews
          → controller assessment
              ├─ revise → same Developer session with current findings
              ├─ pause → Operator remediation or Principal ruling
              ├─ fail / cancel / exhaust
              └─ publish current revision as ready for Principal merge
```

## Authority

The Operator and the Principal are product actors. Vinaya requires Operator authority to start, to resume after remediation and to cancel, and Principal authority for plan approval, rulings, waivers, scope exceptions and merge. Vinaya does not define, grant or authenticate them. Workers receive neither Principal nor raw forge authority. See [Roles](/docs/process/roles).

## Declarations

| Declaration | Vinaya |
| --- | --- |
| Identity | A namespaced, versioned process package pinned into each Run. See [Loader](/docs/process/integration/loader). |
| Intent | A work item: a GitHub Issue. A Goal is a Milestone; a tranche is labelled Issues with dependency and conflict relations. Planned, backlog and hot Issues are entry lanes into one task contract. The frozen brief holds objectives, checked facts, Surface, required sources, parent revision and test plan. Objective changes and rulings make a new Intent version. |
| Execution | Each Execution declares role, capabilities, budget, stop conditions, round, attempt and session. |
| Change | One pull request implements one brief against the declared parent branch. The controller resolves head, base and patch identity and records provenance and the beyond-Surface record. |
| Evidence | Mechanical gates, CI on the current head, and delivery receipts for every required source. Facts are recomputed at dispatch and merge; producer-attested facts need explicit trust configuration. |
| Review | Code and Security, both required, in fresh isolated contexts, on the same immutable manifest. Missing, malformed, stale or mismatched output is no Review. |
| Decision | A pure, versioned controller assessment over reviewer observations, objective coverage, the gate result, pinned policy and prior finding fingerprints. |
| Scope | Surface is the boundary. Paths beyond it are recorded and judged, never refused for that alone. Protected paths stay refused unless the frozen scope names them. |
| Lifecycle | Revise continues the same Developer session; reviewers are always fresh; the round cap is pinned policy. |
| Effects | Push, pull request create and update, review post, comments and labels, through governed prepare, commit and reconcile. |
| Events | See [Logging](/docs/process/integration/logging). |
| Extensions | Brief parser, Surface parser, required-source provider and the 20 Vinaya-specific checks, as versioned extensions. |

Every fact holds one of five states, `known`, `absent`, `unavailable`, `invalid` or `inapplicable`, with provenance and revision-bound applicability.

## Gates

Vinaya binds the 12 generic gates and adds 20 checks of its own; 17 of its 37 core checks implement generic gates. The full list is under [Gates](/docs/process/gates).

## What's next

```cards
- [Adapters](/docs/process/integration/adapters) The adapters Vinaya uses
- [Loader](/docs/process/integration/loader) How Vinaya is loaded
- [Process contract](/docs/dev-process/process-contract) The generic contract this page answers
- [Gates](/docs/process/gates) The rings and all 37 checks
```
