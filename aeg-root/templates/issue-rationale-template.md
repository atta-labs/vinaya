---
sidebar_title: "Template: Issue rationale"
---
# Template — Issue rationale (the Planner's eight fields)

**Copy the block below the divider into the task Issue's body and replace every `[…]` placeholder with real content.** This is the rationale grammar that the ring-0 creation gate (`vinaya issue create`/`vinaya issue edit`) and `vinaya check coherence`'s R1 check parse: a `## Objectives` section above all eight producer fields of the `aeg-root/contracts/planner-brief.md` contract, in bold-inline form (`**<Field>** — …`; the `### <Field>` heading form is equally valid). The contract and `aeg-root/roles/planner.md` § "The Planner's rationale" remain the source of truth for what each field must *contain* — this file packages the shape; it does not lower the reasoning bar. A field filled with boilerplate is still a malformed rationale, even though it parses.

---

[tranche-slug] [n] — [task title, repeated from the Issue title]

**Tier:** [0 | 1 | 3]
**Project:** [project(s), comma-separated, matching the blast radius stated in the "Project(s) + blast radius" field below]
**Type:** [build | chore | docs | feat | fix | perf | refactor | revert | style | test — the commit-type word this task belongs to; free-text metadata, not a forge label]

## Objectives

O1. [OBJECTIVE — one observable outcome this task makes true, as a sentence — never a file path; the Brief Author maps it to files.]
O2. [OBJECTIVE — numbered contiguously from O1, one line per objective, as many as this task genuinely has.]

## Planner's rationale

**Boundary** — [BOUNDARY — what this task is and, crucially, what it is NOT: what was deliberately split out, where the edges sit. Make the in/out sets concrete enough that the Brief Author can bound a file surface from them.]

**Sizing** — [SIZING — state that the task passed the four "too big?" tests (one verification story; one agent can hold it; bounded file surface; single failure mode) — or how a larger candidate was split when it failed one. Name the single verification story.]

**Project(s) + blast radius** — [PROJECTS + BLAST RADIUS — every project touched, resolving against `.vinaya/projects.md`. For shared-package changes: which consumers are in the blast radius, and whether each needs re-verification only or actual edits.]

**Dependency rationale** — [DEPENDENCY RATIONALE — *why* each `depends-on` / `conflicts-with` edge exists, not just that it does. "No `depends-on`; no `conflicts-with`" is a valid value — state it explicitly, with the check that established it.]

**Traps to avoid** — [TRAPS — concrete pitfalls the dig surfaced that would otherwise bite the executing agent, phrased as "do NOT do X; do Y instead". Highest-value field — never generic advice.]

**Suggested agent-class** — [high | mid | fast — with a one-line reason tied to this task's real difficulty, e.g. "mid — mechanical repackaging, but the changes touch live gates and need round-trip proof".]

**Stop-and-escalate** — [STOP-AND-ESCALATE — the conditions under which the executing agent must stop and escalate rather than improvise, e.g. "if making X work requires changing shared contract Y, escalate severity:strategy".]

**Docs to keep coherent** — [DOCS — which specs/skills/docs this task will make incoherent and must update, derived from reading them, not from memory — or state "No docs touched." explicitly.]

## Surface

in: [directory-level glob list, comma-separated, e.g. `packages/aeg-core/src`, `apps/cli/src/commands` — never a file path]
out: [directory-level glob list explicitly excluded from this task's surface — comma-separated, or empty]

## Parts

Part 1 (O1) — [OUTCOME — one observable outcome this Part makes true, naming outcomes and symbols, never a file path.]
Part 2 (O2) — [OUTCOME — numbered contiguously from 1, one line per Part, as many as this task genuinely has.]

## Test plan

[Either the sentinel below, for a pure-logic task with no runtime-observable surface —]

Test plan: unit-tests-only

[— or a fenced command list, one command per line, each with its expected observable after a literal `→`, plus any auth-gated/visual `[principal]` items:]

```
[command] → [expected observable]
```

- [ ] **[principal]** [auth-gated / vendor-key-dependent / visual check, if any]

## Stop conditions

- [the condition under which the executing agent must stop and escalate rather than improvise]

## Origin

[ORIGIN — where this task came from: Principal-directed, backlog item, incident follow-up — with dates and the Issue/PR references that motivated it.]
