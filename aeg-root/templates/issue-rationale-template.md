---
sidebar_title: "Template: Issue rationale"
---
# Template — Issue rationale (the Planner's eight fields)

> AEG terms used below (tranche, brief, dispatch, spec, plan, gate) are defined in the [glossary](../glossary.md).

**Copy the block below the divider into the task Issue's body and replace every `[…]` placeholder with real content.** This is the shape the Issue gate (`vinaya issue create`/`vinaya issue edit`) and `vinaya check coherence`'s R1 check parse: a header block, a `## Objectives` section, all eight producer fields of the `aeg-root/contracts/planner-developer.md` contract in bold-inline form (`**<Field>** — …`; the `### <Field>` heading form is equally valid, except for **Dependency rationale**, which is bold-inline only), then the judgment sections the brief render fills its surface map, Parts, Test plan and stop conditions from. The contract and `aeg-root/roles/planner/reference.md` §§ "The Planner's rationale" and "Rationale grammar" remain the source of truth for what each field must *contain* — this file packages the shape; it does not lower the reasoning bar. A field filled with boilerplate is still a malformed rationale, even though it parses. A conformance test fills every placeholder below with a minimal task and runs the result through the Issue gate, so this shape and the gate cannot drift apart.

**Two forms, one block.** The block below is the **full form**, the one every tranche task Issue (labeled `vinaya/tranche:<slug>`) carries: all eight rationale fields. A **single-fix Issue** — one with no `vinaya/tranche:*` label, dispatched by `vinaya task run --issue <n>` — carries the **single-fix form**: the same block with three fields deleted, because each is tranche prose that no gate checks and the brief render does not need:

| Field | Full form (tranche task) | Single-fix form (no tranche label) |
|---|---|---|
| Boundary, with its `Pinned files:` | required | required |
| Sizing | required | omitted |
| Project(s) + blast radius | required | omitted — the `**Project:**` header field and `## Surface` carry the blast radius; a fix that reaches a shared package no declared project owns still needs a second project or a `blast-radius-ack:` line |
| Dependency rationale | required | omitted — the render states that the Issue declares no edge; write it only if the fix does have a `Depends-on` or `Conflicts-with` edge |
| Traps to avoid | required | required |
| Suggested agent-class | required | required — dispatch reads the agent class from it |
| Stop-and-escalate | required | required |
| Docs to keep coherent | required | required |

Every other section — the header block, `## Objectives`, `## Documentation`, `## Premises`, `## Surface`, `## Parts`, `## Test plan`, `## Stop conditions` — is the same in both forms, under the same grammar. A single-fix Issue's title takes the commit-type form `Type(scope): Description`, which the brief render reuses as the pull request's title. Facts about the code go in `## Premises`, where the gate checks them, never in prose.

---

[TITLE — the Issue title, repeated: tranche slug, task number, an em dash, then the outcome title]

**Tier:** [TIER — 0, 1 or 3]
**Project:** [PROJECT — the registered project names this task touches, comma-separated, matching the blast radius stated in the "Project(s) + blast radius" field below]
**Type:** [TYPE — the commit-type word this task belongs to: build, chore, docs, feat, fix, perf, refactor, revert, style or test]

## Objectives

O1. [OBJECTIVE — one observable outcome this task makes true, as a sentence, with no file path; the dispatch act's render maps it to files.]
O2. [SECOND OBJECTIVE — numbered contiguously from O1, one line per objective, as many as this task genuinely has.]

## Documentation

- [SOURCE — an in-repository path, or an official public documentation URL that answers an unauthenticated fetch, the task must read] — [MECHANISM — what that source governs in this task] ([CITED OBJECTIVES — the objective ids it informs, e.g. O1])

[DOCUMENTATION NOTE — one bullet per source; every link the task gives belongs here. A task no external or in-repository source governs replaces the bullets with the single line `None`.]

## Planner's rationale

**Boundary** — [BOUNDARY — what this task is and what it is NOT: what was deliberately split out, where the edges sit.] Pinned files: [PINNED FILES — every real file the task touches, each backticked, each under a `## Surface` `in:` glob; the brief render pins these and refuses a Boundary that names none.] Out: [OUT — what was deliberately left out, including any importer of a pinned file that stays outside the Surface.]

**Sizing** — [SIZING — that the task passed the four "too big?" tests (one verification story; one agent can hold it; bounded file surface; single failure mode), or how a larger candidate was split when it failed one. Name the single verification story.]

**Project(s) + blast radius** — [BLAST RADIUS — every project touched, each registered in `.vinaya/projects.md`; for a shared-package change, which consumers are in the blast radius and whether each needs re-verification only or actual edits.]

**Dependency rationale** — [DEPENDENCY RATIONALE — why each `Depends-on: #<n>` / `Conflicts-with: #<n>` edge exists, naming the overlap on both sides; or "No Depends-on; no Conflicts-with", with the check that established it.]

**Traps to avoid** — [TRAPS — concrete pitfalls the dig surfaced that would otherwise bite the executing agent, phrased as "do NOT do X; do Y instead".]

**Suggested agent-class** — [AGENT CLASS — high, mid or fast, with a one-line reason tied to this task's real difficulty.]

**Stop-and-escalate** — [STOP-AND-ESCALATE — the conditions under which the executing agent stops and escalates rather than improvises, e.g. "if making X work requires changing shared contract Y, escalate severity:strategy".]

**Docs to keep coherent** — [DOCS — each spec, skill or doc this task will make incoherent, by its repository path, derived from reading them; for a surface no doc covers, the `no-doc-surface` sentinel followed by the reason.]

## Surface

in: [SURFACE IN — directory-level globs this task touches, comma-separated, e.g. `packages/aeg-core/src`, `apps/cli/src/commands`; no file path]
out: [SURFACE OUT — directory-level globs explicitly excluded from this task's surface, comma-separated]

## Parts

Part 1 (O1) — [PART OUTCOME — one observable outcome this Part makes true, naming outcomes and symbols, with no file path.]
Part 2 (O2) — [SECOND PART OUTCOME — numbered contiguously from 1, one line per Part, as many as this task genuinely has.]

## Test plan

[TEST PLAN NOTE — a fenced command list, one command per line, each naming the test file or `vinaya check` it runs and its expected observable after a literal `→`, plus any auth-gated or visual item the Principal checks as a principal checkbox line. A pure-logic task with no runtime-observable surface replaces the whole section's content with the single line `Test plan: unit-tests-only`.]

```
[COMMAND — a command the dispatched Developer can run, naming the test file or check it runs] → [EXPECTED — the observable it prints]
```

## Stop conditions

- [STOP CONDITION — the condition under which the executing agent stops and escalates rather than improvises]

## Origin

[ORIGIN — where this task came from: Principal-directed, backlog item, incident follow-up — with dates and the records that motivated it.]
