---
name: aeg
sidebar_title: Operating Model (aeg)
description: The front door to Agentic Execution Governance (AEG) — the operating model every agent works inside. Load at the start of ANY session in this repo, before doing anything substantive, regardless of role. Covers what AEG is, the four truth domains, forge-derived status, the tranche topology file, where the plan vs the flow vs governance live, the dispatch gates, the brief, the anti-regression rules, the orient-from-root layout (`aeg-root/` model + `aeg-project/` state), and the model-vs-product distinction. Ends by routing to the aeg-roles skill and the reading order. Does NOT cover role specifics (see aeg-roles + roles/*.md) or brief authoring (see brief-authoring).
---

<!-- CANONICAL SOURCE. This file is the canonical home of the `aeg` skill, inside the AEG unit (aeg-root/skills/). provides for an agent-specific GENERATED VIEW under `.claude/skills/` (or another agent's equivalent), rebuilt from this file rather than authored by hand — but no such generator exists yet, and this repo has no generated view of this skill: agents are pointed at aeg-root/ directly (this repo's root agent-context file). Edit THIS file; if a generator is ever built, regenerate rather than hand-editing its output. -->

# AEG — the operating model (front door)

**Load this first, every session, before anything substantive — whatever your role.** It is the one-read picture of how work happens in this repo. When you finish it you will know what AEG is, what is true and where it is stored, and which role doc to open next. It does not reproduce the role docs or the brief rules — it points to them.

AEG = **Agentic Execution Governance.** It is a small set of accountable roles coordinating AI agents through briefs, independent review, and blocking escalation. It is **governance + orchestration of delegated AI execution** — it is *not* project management: there is no plan, timeline, or resource tracking inside AEG (that lives in the backlogs / a company tool, outside the flow).

AEG is **agent-agnostic and tool-agnostic.** The roles below describe *what an agent must do*, not which agent does it — any capable coding agent can take a role by reading its doc. The model names no vendor as a dependency.

---

## 1. AEG is two things sharing one name (don't confuse them)

- **AEG the model** — this operating model: the governance/flow constitution. It lives at repo-root `aeg-root/` (the model exists once, at the root only) and governs the whole repo. *This skill is the model.*
- **AEG the product** — a deployed UI (**Studio**) that *visualizes* a repo's AEG execution, plus the CLI that lays the AEG structure into any repo. That product is **Vinaya**. The CLI and Studio are maintained as separate source trees, in separate repositories — an adopter installing Vinaya gets the CLI; Studio, where it runs, is a hosted or self-run separate deployment, not something this project's own repo layout says anything about.

When someone says "AEG," default to the model unless the context is clearly the product (the UI, the website, the scaffolder).

## 2. Forge-native, orchestrator-independent

AEG runs on **the Repo + the Git forge (GitHub/GitLab) + plain git worktrees**, and depends on **no orchestration tool**. It can be run entirely by hand. An orchestrator may *automate* the dispatch/escalation slice, but knowledge flows one way: **a tool may know AEG; AEG does not know the tool.** Never assume an orchestrator exists; never make the model depend on one. *(In this repo, the optional orchestrator is Cetana — but the model never names it as a requirement.)*

## 3. The four truth domains — every fact lives in exactly one place

1. **The Git forge** (Issue / branch / PR / review / merge state) = **all live execution status, DERIVED not stored.** A task *is* a forge Issue. There is no status field and no `status:*` label anywhere — status is *read* from the forge:
   - branch `task/<tranche>/<n>` exists → in-flight
   - PR open → in-review · review = CHANGES_REQUESTED → changes-requested
   - PR merged → merged · `aeg:blocked` label → blocked
   Labels are only `tier:*`, `aeg:blocked`, `needs:*-input` — never status.
2. **The Repo** = code, specs, skills, PM docs, role docs, the thin tranche topology files, decisions. The source of truth for **plan and governance** (not live status).
3. **The PR body** = the **just-in-time brief** — a task's full execution context, pasted (not committed), never in the Issue.
4. **Local filesystem** = orchestration-tool runtime, worktrees, dev servers. Ephemeral, never canonical.

Conversation logs / thinking are **not** artifacts — never cite them as authority.

## 4. Where the plan / the flow / governance live

- **The plan (backlogs)** → a unit's `specs/`: `specs/<unit>-backlog.md` (per unit / per project) and a repo-level backlog in the root `specs/`. **Out of the flow.** The Planner *may* read it to compose a tranche but the flow never operates on it.
- **The flow + governance (the model)** → the **root** `aeg-root/`: the constitution, the role docs, the skills, the tranche files. Exists **once**, at the repo root only.
- **The living state** → forge-native, never the model: active/blocked/next is derived from Issue/branch/PR state, and completed-work history, lessons, per-project operational state, and ratification items live on the forge.
- **`roadmap.md` is retired**. Never read or write it.

A unit's `aeg-project/` carries only that unit's *living state* — never a copy of the model. The AEG skills are part of the model and live at `aeg-root/skills/` (canonical); the `.claude/skills/` copies are a generated view.

## 5. The tranche — AEG's top-level artifact

A tranche (`aeg-root/tranches/<name>.md`) is a **thin topology file**: task→Issue map, `depends-on` / `conflicts-with` edges, grouping. **No status, no PR numbers, no dates, no priority, no estimates.** It is the active slice of work the Planner pulled from a backlog. The link from backlog → tranche is a *human* (the Planner), not a file. (Full model: `aeg-root/tranche-model.md`.)

## 6. Conflicts and the two dispatch gates

Conflicts are **package-level, and mostly derived, not hand-declared** (collision domains live-derived from `package.json`'s `packages/*` workspace members, plus a built-in cross-cutting default set — `vinaya.config.json`'s `blastRadius.extraDomains` adds anything beyond that; the legacy static `.aeg/packages` file is retired) — there is **no dynamic path-overlap scanner**. When unsure two tasks collide, declare the conflict and serialize. Two gates, both forge-answerable with zero stored state:
- never start a task whose `depends-on` isn't **merged**;
- never start a task while a `conflicts-with` sibling's **PR is open**.

## 7. The brief

The brief is the task's full execution context: **just-in-time, pasted not committed, lands in the PR body**, frozen at dispatch, amended only via escalation. If it isn't in the brief, it doesn't exist. Authoring rules: the **brief-authoring** skill. Brief Step 0 is always worktree creation (`git worktree add .worktrees/task/<tranche>/<n> -b task/<tranche>/<n> --no-track origin/main`).

## 8. Roles (one line each — load the role doc for detail)

Principal → Planner → Brief Author → Developer → Reviewer (code + security) → merge, plus the non-conversational Archivist. The Planner turns intent plus a backlog slice into a tranche; the Brief Author writes one task's brief. **Do not operate from this list — load your role doc.** The **aeg-roles** skill routes you to the right one.

## 9. Tiers, decisions, ratification (the governance layer)

- **Tiers**: Tier 0 trivial · Tier 1 implementation · Tier 3 project/roadmap. No Tier 2. When in doubt, Tier 3.
- **Decisions** are recorded in the change that makes them — the pull-request body is the durable record. Historical entries sit in a frozen archive outside the harness; nothing reads it and no new entries are added.
- **Ratification windows**: 1–2 daily; the Principal resolves Type 1s, Tier 3 merges, `severity:product` escalations.
- **verify-docs** (`packages/aeg-core/bin/verify-docs.ts`; in this repo it runs at authoring time — `open-pr.ts` / `bun run verify-docs --pr` — with its CI counterparts the `brief-shape`/`doc-coverage` checks in `.github/workflows/vinaya-checks.yml`; in the attalabs reference implementation it is a step of that repo's consolidated gate job) is a real blocking gate: changed specs need a `Status:` block, Tier 1+ code needs a doc change, Tier 3 states its reasoning in the pull request.

## 10. The anti-regression rules — never violate

- ❌ Never write task status anywhere (file, Issue field, label) — it is derived from the forge.
- ❌ Never add execution metadata (status, PR #, dates) to the tranche topology file — topology only.
- ❌ Never put the brief in the Issue — it lives in the PR body.
- ❌ Never put planning metadata (priority, estimates, points) on an Issue — that's the roadmap, outside AEG.
- ❌ Never build a dynamic conflict scanner — declare conservatively and serialize.
- ❌ Never read or write `roadmap.md` — retired.
- ❌ Never put a backlog anywhere but a `specs/` folder.
- ❌ Never let a Developer review its own work — review is a separate fresh-context invocation.

## 11. What to do next (the reading order)

After this skill, load in order: **`aeg-roles`** (routes you to your role doc) → your **`aeg-root/roles/<role>.md`** → the altitude you're working at — **`aeg-root/milestone-model.md`** (declaring or reading a goal), **`aeg-root/tranche-model.md`** (planning or executing across a batch), and/or **`aeg-root/task-model.md`** (executing one task) — → the session-start forge queries below. When anything disagrees, `state-machine.md` wins.

## 12. Session-start forge queries — deriving current state

Execution state is **derived from the forge, never read from a file** — there is no state file, no status doc, no hand-maintained state Issue. (`coordination.md`, which once carried a session-start protocol plus a pinned per-project state-Issue layer, is retired: its queries cited label names that don't exist in any adopter, and the state-Issue layer duplicated what Milestones and tranche labels already derive — the one live instance drifted stale and was closed.) Substitute your repo's label namespace — the queries below use this repo's `vinaya/` prefix:

**"What's active?"** — two independent queries, not a sequence:
```bash
gh issue list --label "vinaya/tranche:<slug>" --state open
```
```bash
gh pr list --state open
```

**"What's blocked?"**
```bash
gh issue list --label "vinaya/blocked" --state open
```

**"What needs the Principal?"** — two independent queries, not a sequence:
```bash
gh issue list --label "vinaya/needs:principal-input" --state open
```
```bash
gh pr list --label "vinaya/needs:principal-input" --state open
```

**"What merged recently?"** — `gh pr list --state merged --limit 20`

**"Is a specific task dispatchable?"** — don't hand-derive it: `bun packages/aeg-core/bin/verify-dispatch.ts <tranche> <n>` (or the shipped `dispatch-readiness` check in an adopter repo) answers with the exact blocker.

Anything genuinely non-derivable — a pending manual operation, a known production issue — is an **ordinary open Issue, closed when resolved**: never a hand-edited-in-place state document, never a label pretending to be a status field.

No brief, no audit finding, no "next steps" recommendation is valid without a forge check. Forge state > file state > memory. Always.
