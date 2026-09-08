---
sidebar_title: Planner → Developer
title: Planner → Developer
order: 2
contract_id: planner-developer
description: Carries a brief to the agent that executes it, so nothing the plan knew is left implicit.
status: active
producer: planner
consumer: developer
carrier: issue-comment
summary: Ever handed someone a task and they missed something you thought was obvious?
---
# Contract: Planner → Developer

## The short version

This seam sits between the brief and the agent that executes it. It exists to close the gap where the plan assumes something is obvious and an executor never sees it stated.

**What crosses** — one brief, complete. The exact command that creates the isolated working copy and branch, to be run before anything else. The impact tier, which decides how much documentation and record-keeping the work owes. The projects it touches. The context: what the task is not, and the traps already found. What must exist and be merged before it can start. The bounded file surface it may touch. Pinned assertions about the current code, so a brief written yesterday cannot be executed against a surface that has moved. The documents it must update. The checklist it satisfies before opening a pull request. A test plan, each item marked as one an agent can run or one only a person can. The conditions that stop it. The constraints it may not weigh against convenience.

**The hand-off is malformed when** — any of those is missing. A brief without stop conditions is not a terse brief; it is one whose executor will invent them. A file surface described as "wherever else turns out to need it" is not bounded. A documentation list assembled from memory rather than reading is not a list. It is equally malformed to skim rather than read it, to treat a stop condition as advice, to execute past the file surface because nothing blocked it, or to paraphrase a verification result instead of pasting what the command printed.

**What it does not carry** — status, which is derived from branches and pull requests and never written; the planner's durable reasoning, which crossed the previous seam and lives on the issue; and any authority to amend the brief. The brief is frozen at dispatch; a change to it is an escalation, not an edit.

**How it physically runs** — the carrier is a frozen comment the dispatch command posts on the task's own tracking issue, before the Developer's worktree ever exists. That is the brief's permanent home: the executing agent reads it there, the reviewer reads it there to judge intent against outcome, and the close-out reads it there as evidence. It is never committed into the repository and never carried in the pull-request body, which holds only the Developer's report — a brief kept anywhere else goes stale before the work starts.


---

## Reference

**Status:** active
**Seam:** the hand-off from the Planner's dispatch act (producer) to the Developer (consumer).
**Single source of truth for this seam.** The Planner's role doc does **not** redefine what crosses this boundary — it points here. `aeg-root/roles/planner.md`'s dispatch act (producer side) and `aeg-root/roles/developer.md` (consumer side) each reference this file; this file is where the field-by-field hand-off lives, once.

---

## Why this file exists

A brief is the executable contract between intent and implementation. When the hand-off from the Planner's dispatch act to the Developer is described separately in each role doc, the descriptions drift: the dispatch act believes the Developer will infer certain things; the Developer misses the fields the dispatch act thought were obvious. This contract removes that drift structurally — there is exactly one description of what a brief must carry and what the Developer must do with each field.

The failure mode this prevents: a Developer who starts work without reading the full brief, or who treats stop conditions as suggestions, or who improvises past a surface-map boundary because nothing explicitly blocked them. Every field below is present in every well-formed brief; its absence is a signal the brief is malformed, not that the field is optional.

---

## The hand-off carrier

The task **Issue's `aeg:brief:v1` comment** — posted once, frozen, by `vinaya task dispatch` before the Developer starts, and read by the Developer as the whole brief. The brief is not in the Issue's own body (the body is task identity + the Planner's rationale + the Issue's judgment sections only — see below). It is not carried in the pull-request body either — that body holds only the Developer's report. The frozen Issue comment is the brief's permanent, durable home; the Reviewer and Archivist read it there as evidence of intent.

---

## The contract — field-by-field mapping

Every field below has exactly one named obligation for the Developer (right column). The left column names where the field lives before dispatch: either a section the Planner wrote directly onto the task Issue at plan time (the eight-field rationale, the `## Objectives` block, and the four judgment sections `## Surface` / `## Parts` / `## Test plan` / `## Stop conditions` — all Issue sections, not brief prose), or a section the dispatch act (`vinaya task dispatch`, via `renderBrief`) fills mechanically from the forge and the tree at dispatch time. A brief missing any right-column obligation is malformed — the dispatch act's own render refuses on a gap rather than emitting an incomplete brief. A Developer who drops a right-column obligation is executing incorrectly.

| Issue section / dispatch-act render | Developer consumes at | What the consumption means |
|---|---|---|
| **Worktree Step 0** (rendered verbatim `git worktree add` command, from the task's forge-derived branch id) | First action before any other command | The Developer must execute this exact command first. No exceptions. Never assume the right branch exists. Before executing it, the Developer independently re-verifies the branch-name suffix literal-matches the task's forge-derived id — the same check the dispatch act already ran before rendering the command. |
| **`Tier:` field** (rendered from the Issue's tier declaration) | PR-open checklist + `vinaya/tier:*` label | The Developer sets the matching `vinaya/tier:*` label on the Issue at PR open. The field is binding; the label is the scannable projection. |
| **`Project:` field** (rendered from the Issue's `Project(s) + blast radius`) | PR description + `verify-docs` | The Developer confirms the project resolves against `.vinaya/projects.md`. |
| **Context** (rendered from `Boundary` + `Traps to avoid`) | Mental model before any code | The Developer reads the boundary ("what this task is NOT") to know what to refuse to build, and the traps to know what not to do. |
| **Technical Dependencies** (rendered from `Dependency rationale`) | Verify all depends-on are merged | The Developer confirms every named dependency is on `main` before starting. A depends-on not yet merged is a hard stop. |
| **Technical Surface Map** (rendered from `## Surface` plus a `sha256` premise pin per file) | Bounds the diff | The Developer touches only files in the surface map. Files outside it are a stop-and-escalate. |
| **Premise pins (`Premise:` block, mandatory when the surface map names a real code surface)** | Re-asserted before Step 0, via `verify-dispatch --premise <body-file>`; re-asserted again pre-PR via `verify-task` | A failed premise means the surface moved since the Issue's rationale was written — the Developer stops and re-digs rather than executing against a stale mental model. This is a stop condition, not a silent re-guess. |
| **A fenced command with its executed output pasted beneath it (the only other form a behavioural fact about code may take in a brief)** | Re-run before the Part that depends on it; output pasted in that round's PR comment | The Developer re-runs the command and compares its own output against what the brief pasted. A mismatch is a brief defect, not a fact to transcribe — the Developer stops, `severity: strategy`, and never writes the brief's sentence into doctrine or code. |
| **Documentation-update list** (rendered from `Docs to keep coherent`, mechanically derived against `.vinaya/doc-owners`) | Self-check before opening PR + Reviewer doc check | The Developer updates every doc named in the list before claiming done. The list is a DoD obligation, not a recommendation — a named doc not updated is a BLOCKER at review. `verify-docs --pr` gates structural presence; the Reviewer gates content correctness. |
| **Task Done checklist** (the Developer's own tier checklist, not a rendered section) | Self-check before opening PR | The Developer runs every item before opening the PR. An unchecked item means the PR is not ready. |
| **`## Test plan`** tagged `[agent]` / `[principal]` | Runs `[agent]` items; leaves `[principal]` for Principal | The Developer runs every `[agent]` item and posts evidence. Does not tick `[principal]` boxes. |
| **`## Stop conditions`** | Halt triggers | The Developer stops and posts a blocker comment on the Issue when any condition is met. Never improvises past a stop condition. |
| **Constraints** (rendered from `Traps to avoid` plus the standing autonomy clause) | Hard rules during execution | The Developer treats these as absolute — not "guidelines." A violated constraint is a PR that must not merge. |

**Reading the table:** left is the producer obligation (the Issue's own gates refuse a task Issue missing a rationale field or judgment section at creation time; the dispatch act's render refuses a brief with a gap it cannot derive), right is the consumer obligation (Developer role doc and executor protocol enforce it). The role doc must not contradict this table.

---

## Producer obligations (the Planner's dispatch act)

- Every rendered field above must be present. A gap the render cannot derive from a stated fact is never defaulted — `vinaya task dispatch` refuses, naming the missing fact, rather than posting an incomplete brief.
- The brief is frozen at dispatch; amendments go through escalation (`severity:execution` or `severity:strategy` depending on what changed).
- The worktree Step 0 command must be exact — branch name, base ref (`origin/main`), and destination path must all be present. The branch name's suffix must literal-match the task's forge-derived id — character for character, no added prefix, no case change, no truncation.
- Stop conditions must be explicit, not inferred. Every known failure mode for this task belongs in the Issue's `## Stop conditions` section — the Developer will not invent stop conditions that aren't stated.
- The surface map must be bounded and named. "Wherever else turns out to need it" is not a surface map.
- **The documentation-update list must be populated from reading, not memory.** The Planner's Dig (`roles/planner.md`) must identify and read any relevant specs/skills/docs before cutting the Issue. The list for Tier 1+ must be non-empty unless the surface map genuinely touches no documented surface (state "No doc updates required" explicitly in that case).
- **A brief with a real code surface must carry a `Premise:` block pinning at least one checkable fact inside that surface.** A Tier 0 brief with zero code/runtime surface has nothing to pin.

## Task-status coherence precondition — hard STOP before authoring or executing any task

> **SUPERSEDED (2026-07-13).** This precondition (the per-task archival / row-adjacency gate) is no longer a hard-STOP for the Planner's dispatch act or the Developer — automated post-merge provenance posting made the drift signal it protected moot. The section below is preserved as historical record — do NOT enforce it.

~~The dispatch act MUST verify this precondition before dispatching any task. The Developer MUST verify it before step 0. **If any predicate fails for any in-scope prior, STOP and report to the Principal what is owed — do NOT dispatch, do NOT begin work, do NOT rationalize past it.**~~

**The archival bar.** A prior task is "done" when ALL THREE predicates hold:
1. Its forge Issue is **closed**
2. Its PR is **merged to main**
3. Its **provenance block** comment is present on the merged PR (posted by the Archivist)

"PR merged" alone is NOT the bar. A merged PR whose Issue is still open, or whose provenance block is absent, is an incomplete archival — the Archivist has not fully closed out.

**Scope of "prior task" — verify all three predicates for each:**
- **Mid-tranche task:** every earlier task in the same tranche that this task depends on (direct `depends-on` edges).
- **First task of an vinaya/tranche:** the entire previous tranche of that product must be archived — all Issues closed, all PRs in main, all tasks with provenance blocks, tranche file in `aeg-root/tranches/completed/`.
- **ALL tasks:** every cross-tranche dependency declared in the topology (e.g. a task in one project that depends on a task in another, from an earlier tranche) must also satisfy all three predicates.

**Hard STOP language:** *"Prior task [Y] does not pass the coherence gate: Issue #N is [open/closed], PR #M is [merged/unmerged], provenance block is [present/absent]. The Archivist must fully close out task [Y] before this task can proceed. Here is what is owed: [list]."*

**Accepted-backfill never bypasses this gate.** Deferring backfill of historical provenance on **already-closed tranches** is a permitted debt record; proceeding with a new task on an **unarchived active prior** is not. The accepted-gap clause is strictly limited to closed historical tranches; it cannot be cited to bypass the coherence precondition for tasks in an active tranche. An accepted historical backlog is a debt record, not a gate bypass. The coherence precondition applies to active prior tasks; it cannot be waived by citing accepted historical gaps.

The dispatch act's enforcement is the same forge-derived check the Developer runs (`vinaya check dispatch-readiness`) — see `aeg-root/roles/planner.md`'s dispatch act. The Developer's enforcement is at entry gate items 3–5 (see `aeg-root/roles/developer.md`). The dispatch-act gate fires one stage earlier than the Developer gate — catching the gap before a brief the Developer will immediately refuse is posted.

---

## Consumer obligations (the Developer)

- **Honor the documentation-update list.** Every doc named in the list must be updated as part of the task deliverable — not post-merge cleanup, not a follow-up task. A named doc not updated is a BLOCKER at review. If the list names a doc you cannot find or access, stop and report — do not silently skip it.
- **Row-existence precondition (hard STOP before step 0).** Before executing step 0, confirm via the forge (`vinaya/tranche:<slug>`-labeled Issue titled `[<slug>] <n> — …`, and its Milestone) that this task's row exists at all. This is distinct from and prior to the Issue-existence precondition below: a missing row means the plan that adds this task has not merged/opened yet. STOP: *"Task <id> is not present in tranche `<name>`'s forge-derived task list — the plan for this task hasn't merged/opened. Not dispatchable until it does."* This gate is enforced in `aeg-root/roles/developer.md` (entry gate, item 7).
- **Issue-existence precondition (hard STOP before step 0).** Before executing step 0, confirm via the forge that this task's Issue carries a real GitHub Issue number — not `#TBD`, not blank. If it is `#TBD` or blank, the task has no forge Issue and is not dispatchable. STOP: *"Task <id> in tranche `<name>` has no Issue (#TBD) — it is not dispatchable. The Planner must cut the Issue before this task can start."* This gate is enforced in `aeg-root/roles/developer.md` (entry gate, item 3).
- ~~**Prior-archival precondition (hard STOP before step 0).**~~ **SUPERSEDED (2026-07-13)** — no longer a Developer obligation. See the notice above the task-status coherence precondition section. Preserved as historical record: ~~Before executing step 0, apply the task-status coherence precondition above to every in-scope prior task. Verify all three predicates (Issue closed, PR in main, provenance block present) for each. If any predicate fails for any in-scope prior, STOP: report to the Principal exactly what is owed and do not begin work. If no prior task exists in scope (first task of a fresh tranche with no prior tranche on this product), this check passes trivially. This gate was enforced in `aeg-root/roles/developer.md` (entry gate, item 4) and the coherence signal it read is defined in `aeg-root/contracts/reviewer-archivist.md`.~~
- **Branch-ID verification precondition (hard STOP before step 0).** Before executing step 0, confirm via the forge that the Step 0 branch-name suffix literal-matches the task's forge-derived id — character for character, no added prefix, no case change, no truncation. If it doesn't, STOP: do not create the worktree/branch, report the mismatch to the Planner/Principal rather than silently using either name. This is the same check the dispatch act already ran before rendering the command — the Developer re-runs it independently rather than trusting the render was correct. This gate is enforced in `aeg-root/roles/developer.md` (entry gate, item 6).
- **Mechanized precondition check.** The three preceding preconditions (row-existence, Issue-existence, and the prior-tranche-archival check in `roles/developer.md` entry gate item 5) are all re-derivable in one run: `vinaya check dispatch-readiness`, run from the task branch. A `NOT READY` result names the exact failing precondition and is the same STOP described above. **Known gap:** the shipped check's prior-tranche-archival predicate always reports empty — confirm item 5 yourself rather than trusting its pass. (The prior-archival/row-adjacency precondition previously listed here was removed from this composed check.) **On this repo's toolchain**, the unabridged derivation (including the real prior-tranche-archival predicate) is `bun packages/aeg-core/bin/verify-dispatch.ts <tranche> <n>`.
- **Premise re-check (hard STOP before step 0).** If the brief carries a `Premise:` block, re-assert it before step 0 by confirming its stated facts still hold against the live forge/codebase. A failed premise means the surface moved since the Issue's rationale was written — STOP and re-dig, do not proceed on a stale mental model. **On this repo's toolchain**, `bun packages/aeg-core/bin/verify-dispatch.ts <tranche> <n> --premise <body-file>` (the body-file being the dispatched brief text) automates that re-assertion.
- Read the full brief before opening the worktree. Not a skim — every section.
- Execute step 0 first, always. Never branch from `HEAD` of the current local checkout.
- Verify all dependencies are merged before the first line of code.
- Stay within the surface map. Files outside it are a stop-and-escalate, not a judgment call.
- Run every `[agent]` Test Plan item and post the actual command output as evidence. Do not paraphrase verification results.
- Stop on any stop condition — post a blocker comment, do not improvise.
- Report tokens in the PR body at turn-end, per `aeg-root/roles/developer.md` — never append your own row to a ledger file.

---

## Changing this contract

A contract changes **as a unit**. You may not change what the Issue's sections and the dispatch act render without, in the same change, updating what the Developer consumes — because the property that makes the seam sound is that the producer's output side is *identical* to the consumer's input side. Concretely:

- A change to this file is a **Tier 3** change: it alters a cross-role contract, so the reasoning belongs in the pull request that makes it, where the reviewer and the close-out both read it.
- The same PR that edits this contract must verify both `aeg-root/roles/planner.md` (dispatch act) and `aeg-root/roles/developer.md` still point here and still match the table.
- Never edit one side's role doc to add/drop a hand-off field directly. Add/drop it **here**; the role docs inherit it by reference.

---

*This contract is the seam. The Planner's dispatch act fills the left column; the Developer drains the right. One source of truth, changed as a unit.*
