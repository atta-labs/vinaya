---
sidebar_title: The Task Model
section: Overview
---
# Tasks — the altitude below the tranche

**Status:** draft
**Extracted from:** `tranche-model.md` §3, which kept only a short pointer here once this file existed — same discipline that section already applied to `state-machine.md`'s derivation table (keep the rules, point to the machine, never hold two copies of either).

A **task** is a forge Issue. It is the bottom altitude — nothing sits below it. For where this fits relative to the other two altitudes, see `tranche-model.md` (one above) and `milestone-model.md` (two above).

---

## 1. What a task is, and is not

A task **is** its Issue — not a row in a file, not an entry in a tracker AEG maintains. It carries the Planner's rationale (Boundary, Sizing, Project(s)+blast radius, Dependency rationale, Traps to avoid, Suggested agent-class, Stop-and-escalate) in the Issue body, written once at plan time. Nothing downstream — not the Brief Author, not the Developer, not the Reviewer — repeats that rationale elsewhere; every role reads it from the Issue, which is its only home.

A task's status is **not a field anyone writes.** It is computed by asking the forge what is true right now: Issue state, branch existence, PR state, review decision. This is the change that removed AEG's original fatal flaw — a hand-edited status column that raced, drifted, and lied under parallelism. `blocked` is the one state with no native forge fact behind it, so it is a label (cheap, native, doesn't race) — every other state below is read straight off the forge.

---

## 2. The status vocabulary — what Studio displays, derived from the forge

Eight states, computed, never stored: `todo`, `in-flight`, `in-review`, `changes-requested`, `merged`, `blocked`, `dropped`, `incoherent`. This is the read-side projection — what a dashboard shows to answer "where is this task right now," not the operational sequence (§3 is that). The full rule chain that decides which forge fact produces which status lives at [`/docs/state-machine`](https://vinaya.attalabs.dev/docs/state-machine), rendered from `packages/aeg-core/src/state-machine-model.ts` — the deriver itself, not a hand-maintained second copy.

A closed-without-merge Issue never resolves to `todo` — `todo` implies not-started, and a closed Issue is terminal. The one law under all eight states: a task reaches `merged` only via a PR that names it (`Closes #N`); a `COMPLETED` close without that merge is `incoherent`, not done.

---

## 3. Flow stages — what actually happens, in order

This is the operational sequence — distinct from §2's derived-status vocabulary the same way a Milestone's flow (`milestone-model.md` §5) is distinct from its `planned`/`active`/`complete` display state. Today each stage below is a human or a thin dispatch script deciding to start the next one; the Developer, Reviewer, and every other role read prose to know what to do. Nothing about the sequence itself changes once the Atta Engine can run it as a compiled flow — same stages, same order, same role per stage; only the transition mechanism moves from a human dispatching the next turn to the engine calling the next node.

1. **Brief** — the Brief Author turns the task's Issue (already fully shaped by the Planner) into one executable brief: the context, the boundary, the definition of done. Just-in-time, never written before the task is picked up, never stored in the Issue (`tranche-model.md` §7).
2. **Code** — the Developer executes the brief: provisions the worktree/branch (`task/<tranche>/<n>`), implements, commits in small frequent steps, runs the tier-appropriate Task Done checklist, opens the PR with the brief pasted into the PR body. This is the stage that actually produces the change.
3. **Review** — code-reviewer pass (`roles/reviewer.md`) and security pass (`roles/security.md`), each emitting a structured verdict. A REQUEST CHANGES or FAIL loops back to **Code** — bounded by a revision ceiling so the loop always ends, never open-ended.
4. **Verify** — the tagged Test Plan runs for real: the `[agent]` items the Developer executes against the running app, the `[principal]` items a human confirms. This is the gap between "CI is green" and "the feature actually works" — static review alone cannot exercise an auth-gated, key-dependent, or browser-rendered path.
5. **Merge** — the PR merges once Review and Verify are both satisfied. This is the boundary, not a stage with its own actor: merging is the mechanical consequence of the two gates above clearing, not a separate decision.
6. **Archive** — the Archivist closes out: the Issue is explicitly closed (never left to GitHub's advisory auto-close), docs coherence is confirmed, the per-project pinned state Issue is updated for every project the task listed, the provenance block is assembled and posted to the merged PR. This is the task's terminal stage — nothing follows it at this altitude.

Orphaned task (a branch exists, no PR, gone stale) is the one named exception to this straight line: a close-out/sweep step flags it and a human deletes the branch, returning the task to `todo` — a real, owned recovery path, not a silent drop.

---

For the full thirteen-phase prose walkthrough this section condenses (idea origination through post-merge variations and anti-patterns), see `process.md`. For the tranche altitude above this one, see `tranche-model.md`. For the milestone altitude above that, see `milestone-model.md`.
