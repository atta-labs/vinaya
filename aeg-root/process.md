---
sidebar_title: Process
---
# Process: From idea to merged code

This document describes how work flows through the AEG operational model — from the moment the Principal has an idea to the moment that work merges to `main` with all specs and skills updated.

It is the canonical "how do we actually work?" document. Every other PM doc (`state-machine.md`, `tranche-model.md`, role docs) describes a slice of this process. This document stitches them together into a single readable walkthrough.

If you are starting a new session and need to understand the workflow, read this first. Then the `aeg` skill's session-start forge queries for orientation, then the role doc that applies to you, then any project-specific specs. Coined vocabulary used below (Dispatch, Impact tier, Ratification, …) is defined in the glossary at aeg-root/glossary.md.

---

## Where tasks come from: the tranche

The phases below are the **per-task** flow. Tasks do not appear from nowhere — they are produced by the **Planner**'s plan act when a tranche is planned: the Planner turns an intent plus a slice of tickets into a set of **forge Issues** (one per task) plus a thin topology file declaring their `depends-on` / `conflicts-with` edges (`tranche-model.md`, `roles/planner.md`). Each Issue that enters the flow below is a task the Planner already shaped — its rationale and judgment sections already written onto the Issue at plan time.

**Status is never stored.** Throughout every phase, a task's status is *derived* from the forge — Issue open/assigned, branch existence, PR open, review decision, merge — never written to a label or a file. When a phase below says a task "becomes in-review," it means *a PR was opened*, not that anyone set a status field.

---

## The phases

Every piece of work moves through some subset of these. Trivial work (Tier 0) skips most; complex work (Tier 3) hits all and may loop back from review. Numbered 1–13 for historical continuity with every cross-reference below and across `aeg-root/**`, but **not thirteen distinct phases any more**: the former Phases 3–5 (brief authoring, brief validation, dispatch) collapsed into one Planner phase, still numbered 3, performed by one command (`vinaya task dispatch`) — see Phase 3 below for why the numbers 4 and 5 are retired rather than reused. Every phase from 6 onward keeps its original number unchanged, so no downstream cross-reference in the doctrine tree needed to move.

```
1.  Idea origination
2.  Pressure-testing (optional; high-stakes only)
3.  Dispatch (brief authoring + validation + dispatch, one Planner phase — 4 and 5 retired into this one)
6.  Execution
7.  Escalation (optional; only when Developer blocks)
8.  Task Done verification
9.  Pull request opened
10. Review (agent passes, then human reviews)
11. Verification (runtime test plan execution — agent half + Principal half)
12. Merge
13. Tranche Close
```

> **Doctrine: CI green ≠ app boots ≠ feature works.** Phase 11 (Verification) exists because four consecutive features merged CI-green and were broken at runtime. The static gates of Phase 8 and the diff-reading reviews of Phase 10 cannot exercise an auth-gated / key-dependent / browser-rendered path. Phase 11 closes that gap with a tagged, executed test plan (see `roles/developer/reference.md` § Verification and).

After merge, the **Archivist** runs close-out (`roles/archivist.md`). That's the final step of the flow.

---

## Phase 1: Idea origination

**Who:** Principal and Planner.

The Principal brings an idea. The Planner pressure-tests, pushes back, surfaces related decisions, checks whether it's already specced. The Planner's job here is **not** to immediately agree and plan — it's to:
- Read the relevant specs to confirm the idea isn't already settled
- Push back if it's wrong, premature, or duplicative
- Identify the impact tier (0 / 1 / 3) — this drives everything downstream
- Identify the Type 1 (irreversible — Principal ratifies) vs Type 2 (reversible — Planner ratifies) profile

If already locked or specced, the conversation ends here. If genuinely new, it produces a shared understanding of what the work is, why now, its tier, and its decision profile — which the Planner then turns into Issues (the tranche).

**Artifacts:** usually none (conversation is ephemeral). A significant decision is stated in the pull request that carries the work.

**Exit:** the idea dies, or it's worth planning into a tranche.

---

## Phase 2: Pressure-testing (optional)

**When:** high-stakes only — architectural locks, project-direction shifts, decisions blocking weeks of downstream work, or when the Principal's instinct and the Planner's read disagree. **Not** for tactical decisions, naming, or style. The Principal may waive it and ratify in-session (the pull request notes the skip, for audit honesty).

**Who:** Planner orchestrates; external AI reviewers (vendor-diverse — independently hosted, each from a provider other than the one drafting the brainstorming brief) participate via pasted briefs.

The Planner writes a brainstorming brief (idea, sketch, alternatives, what to pushback on), pairs it with `reviewer-prompt.md`, and pastes to each reviewer. The Planner synthesizes. Converge on a flaw → back to Phase 1. Validate → proceed. **Max two rounds** — if two don't converge, the issue is framing, not a third round.

This phase pressure-tests an *idea*; Phase 10 reviews *shipped code*. Different things.

**Exit:** Planner and Principal agree the direction holds.

---

## Phase 3: Dispatch (brief authoring + validation + dispatch)

**Who:** Planner, in its dispatch act (`roles/planner/reference.md` § The dispatch act).

**Formerly three phases (brief authoring, brief validation, dispatch); now one.** The brief is no longer hand-authored just-in-time by a separate Brief Author role — its judgment content (the eight-field rationale, `## Objectives`, and the four judgment sections `## Surface`/`## Parts`/`## Test plan`/`## Stop conditions`) was already written onto the task Issue at plan time (Phase 1), and validated then, by the same ring-0 creation gate and R1 continuous check that grade every open task Issue (`roles/planner/reference.md` § Rationale grammar). What used to be three sequential human/CI steps is now one mechanical render plus one gate check, both performed by a single command.

Before dispatching a task, the Planner checks four gates (`roles/planner/reference.md` § The dispatch act):
1. **Issue exists** — a real forge Issue number, not `#TBD`, not blank.
2. **Dependencies merged** — every `depends-on` task's PR is on `main`.
3. **No open conflicting sibling** — no `conflicts-with` task has an open PR.
4. **Render complete** — the brief render can derive every mechanical section from the Issue and the tree with no gap.

`vinaya check dispatch-readiness`, run against the task, re-derives gates 1–3 mechanically in one command.

**Running the dispatch:** `vinaya task dispatch <tranche> <n> [--agent claude | codex | gemini]` performs the whole phase once the gates pass: it renders the brief (the same render `brief render` uses, from `aeg-root/templates/brief-template.md` and every derivable fact), posts it once, frozen, as the task Issue's own `aeg:brief:v1` comment, then — with `--agent` — starts the Developer through `dispatchRole`. Without `--agent` it prints the rendered brief and the manual dispatch instruction and exits `0`, so a human can paste it instead. `vinaya task dispatch` is deprecated: `vinaya task run <tranche> <n> --agent <claude | codex | gemini>` is the one command that now runs this whole phase AND the phases after it — preparation through this same render/freeze/post, then the developer/review loop — unattended, from one planned Issue to a reviewed pull request, exactly one developer started; a paused run resumes with the loop's own `vinaya dev-review-loop --resume <pr>`. The brief itself MUST include (all mechanically derived or refused on):
- Impact tier (0 / 1 / 3), rendered from the Issue's tier declaration
- Type 1 / Type 2 declaration if architectural decisions are expected, gated at dispatch (a PENDING Type 1 decision blocks dispatch)
- `principal_delegate:` if the work runs while the Principal is offline
- Spike flag (`spike: true`) if exploratory
- The mandatory worktree-first Step 0 (`git worktree add .worktrees/task/<tranche>/<n> -b task/<tranche>/<n> --no-track origin/main` — no exceptions), rendered from the task's forge-derived branch id
- An explicit documentation-update list tied to the tier, mechanically derived against `.vinaya/doc-owners`
- Optional `Ticket:` (reference-only provenance) and, in a multi-project repo, `Project:` (resolves against `projects.md`)
- Clear scope, stop conditions, Task Done checklist
- A deliverable section stating "done" means "passed Phase 11 verification," not "PR opened"

A brief with any `[NEEDS CLARIFICATION: …]` marker left in it is not dispatched — the Planner resolves the ambiguity on the Issue's rationale (or puts it to the Principal) and re-renders. A brief is self-contained and executable without further conversation.

**Where the brief lives:** the task Issue's own `aeg:brief:v1` comment, posted once, frozen, before the Developer starts — never in the PR body, which carries only the Developer's report. It is **not** committed and **not** put in the Issue's own body — the Issue body (written by the Planner at plan time) holds task identity + metadata + the rationale + judgment sections; the brief is a rendered comment on it, not a field of it.

**Artifacts:** the brief (a markdown block, not a committed file). The task's Issue already exists from tranche planning.

Before dispatch, a fresh-context Reviewer runs **Brief review mode** (`roles/reviewer.md`) on the rendered brief — a separate, time-boxed pass from the post-dispatch code review, under five minutes, returning one line, `BRIEF: READY` or `BRIEF: NOT READY`, with findings limited to two classes: a contradiction between two of the brief's own sentences, or a design the brief specifies that the party it constrains can defeat or that fails on an input the brief never named. `BRIEF: NOT READY` returns the rationale to the Planner rather than letting the render reach dispatch.

Once dispatched: **before starting, the Developer independently re-checks the same dispatch gates against the forge** (`roles/developer.md` entry gate) — every `depends-on` task's PR merged, no `conflicts-with` sibling's PR open, the branch-name suffix literal-matching the forge-derived id. If a gate isn't satisfied, it does not start (the task serializes). Opening the branch *is* the `todo → in-flight` transition; nobody writes a status label.

The branch name `task/<tranche>/<n>` is the convention that links the task to its branch and PR, so any role can derive its live status with one forge query.

**Exit:** the brief is rendered, has passed Brief review mode, is posted frozen on the Issue, and the Developer is working in its worktree.

---

## Phase 6: Execution

**Who:** Developer (the coding agent — spawned or pasted).

Per `roles/developer.md`, the Developer reads its role doc, derives live execution state from the forge (the `aeg` skill's session-start forge queries), reads the relevant skills (auto-loaded when matching code is touched) and project specs, confirms pre-flight (starting with the worktree), and works in small, frequent commits on the `task/<tranche>/<n>` branch. When dispatched by an automation layer, it streams progress events to that layer.

The Developer cannot author its own briefs, expand scope without escalation, modify files outside scope, skip verification hooks, skip the Task Done checklist, or **write status anywhere** (status is derived). If the brief is wrong or contradicts reality, it escalates (Phase 7) — it does not paper over confusion or improvise outside scope.

**Exit:** the work is done (Phase 8), or the Developer is blocked (Phase 7).

---

## Phase 7: Escalation (optional)

**When:** the Developer hits a decision not covered by the brief, finds the brief contradicts reality, or needs new information.

**Who initiates:** Developer.

The Developer escalates through the escalation mechanism — a manual escalation note, or, if dispatched by an automation layer, its request-input mechanism — tagged with a `severity` that routes it:

- `severity: execution` → Planner. Most common: a deprecated dependency, an unanticipated flag, a "null or throw?" call.
- `severity: strategy` → Planner. Less common: the brief's approach has a structural problem; the work touches an undiscussed area.
- `severity: product` → Principal. Rare: user-visible behavior the brief didn't address; a Type 1 decision is required.

The task is marked `blocked` (an `aeg:blocked` label — the one status with no native forge fact) until a reply arrives. The responder (Planner or Principal) formulates a reply and the Developer resumes.

**Type 1 during execution:** if the question needs an irreversible decision and the Principal isn't available, the Issue/PR stays labeled `needs:principal-input`; the next window resolves it. The Developer may terminate and resume via a follow-up dispatch after the window.

**Brief amendment:** if the brief itself is wrong in a way that blocks all paths, the Planner issues an amendment (logged as a separate event, not a brief edit — briefs are frozen after dispatch) or kills the task.

**Exit:** the Developer is unblocked and resumes.

---

## Phase 8: Task Done verification

**Who:** Developer.

Before opening the PR, the Developer runs the tier-appropriate Task Done checklist (`roles/developer.md`). The commands below are this repo's instances (Bun/JS) — substitute your repo's declared equivalents:
- **Tier 0:** typecheck + lint, tests if applicable, PR description follows template (and will carry the brief)
- **Tier 1:** Tier 0 + specs updated, skills updated if conventions shifted, `verify-docs --pr` passes
- **Tier 3:** Tier 1 + per-project PM updated if state changed, Lock entry if irreversible, `docs-index.md` regenerated

`verify-docs --pr` is a **real gate**, the same script CI runs. If any item fails, the Developer fixes or escalates — the PR does not open.

**Exit:** all Task Done items pass.

---

## Phase 9: Pull request opened

**Who:** Developer.

The Developer opens a PR with:
- Title in commitlint format (`Type: Subject`)
- **No brief in the body at all** — its permanent home is the task Issue's frozen `aeg:brief:v1` comment (posted at Phase 3, before the Developer ever started), which is where the Reviewer and Archivist read it
- A `Tier:` declaration (`Tier: 0|1|3`) so verify-docs reads the correct tier
- `Closes #N` linking the task's Issue (so the merge auto-closes it)
- Body following the PR template (what shipped, validated mechanism, what's not in scope, next steps)

**Opening the PR is itself the `in-flight → in-review` transition** — derived from the PR's existence, not written anywhere.

CI runs typecheck, lint, tests, `verify-docs` (the load-bearing doc gate — fails if tier-appropriate updates are missing), and pre-commit hooks. The Archivist posts advisory comments (synthesis hints, related-decision surfacing, hygiene) — advisory, not blocking.

**Exit:** PR is open, CI green (including verify-docs), advisory comments addressed or dismissed.

---

## Phase 10: Review

Two stages: independent **agent passes** (fresh-context), then **human reviews** (Principal + Planner). Agent passes run first and feed the human reviews — they do not replace them.

```
code-reviewer pass → security pass → Principal code review → Planner spec review → merge
```

### Stage A — Agent review passes

Each pass is a **separate fresh-context invocation** with no memory of writing the code (the independence rule). Manual: the Principal pastes the review prompt. Automated: the automation layer dispatches the `code-reviewer` and `security-reviewer` passes. The agent reads its role doc + the PR diff + **the brief, read from the task Issue's frozen `aeg:brief:v1` comment**, and emits a structured verdict. Review agents do not edit code, do not merge, and do not write status.

1. **Code-reviewer pass** — `roles/reviewer.md`. Brief conformance, scope violations, test honesty, code quality, doc coupling, lock awareness, multi-project reach. Emits `VERDICT: APPROVE | REQUEST CHANGES` (BLOCKER / MAJOR / MINOR).
2. **Security pass** — `roles/security.md`. Secret leakage, BYOK/crypto, auth/permissions, MCP/agent-tooling exposure, injection surfaces, dependency risk. Runs a config-security scan over the agent/MCP/hook config when that config is touched. Emits `VERDICT: PASS | FAIL` (CRITICAL / HIGH / MEDIUM / LOW).

A BLOCKER (code) or CRITICAL/HIGH (security) returns the PR to the Developer, who fixes on the **same branch**; the pass re-runs. (Pushing fixes returns the PR's review decision to open — the `changes-requested → in-review` transition, derived.) A verdict binds to the head it judged and the objectives list it judged against; a push or an objectives edit — including a mid-PR scope change made through `vinaya issue objectives edit` — voids the verdict, and a body edit alone changes nothing the gate reads. A voided verdict is named as such: `vinaya review status` prints `push after verdict — re-review required` for the head case, `objectives moved — re-review required` for the objectives case, and merge waits on a fresh review round either way. An escalation (`--escalate authority | strategy | product`) is its own review outcome, never a finding — it routes to Planner (`strategy`) or Principal (`authority`/`product`).

**A fix commit adds no mechanism beyond what the finding names.** The finding bounds the fix: a flag, a gate, a window, a config knob or a second code path that the finding did not ask for is new design, arriving inside a round that exists to close a defect and reviewed by nobody as design. A finding that genuinely cannot be answered without new mechanism is not a fix at all — it is escalated (`--escalate strategy`) and waits, and the mechanism it needs enters the work the way every other design does: as a constraint amended into the next brief. This is the round-count rule's twin. Rounds multiply when each one both closes something and opens something; a round that only closes is a round the loop can converge out of.

### Stage B — Human reviews

**Code review (Principal).** The Principal reviews the diff — does it match the brief, scope violations, honest tests, spot-check quality. The agent verdict is an input, not a substitute; the Principal can overrule either way.

**Spec review (Planner).** Do the specs describe what was built? Is the pull request's stated reasoning honest about what changed? Coherence, not technical correctness (that's the Principal's code review).

If both pass (and agent verdicts are APPROVE and PASS, and surfaced findings have been shown to the Principal at the go) → merge. If issues are found → back to the Developer with specific feedback. The loop ends by finding identity, never by round count — per the Review Cycle specification, round two judges only the lines changed since the previously judged head, for every non-blocking severity: a finding outside that delta is surfaced for the Principal's go rather than driving the verdict. A BLOCKER, CRITICAL or HIGH outside the delta still drives the verdict on any round; only MAJOR, MINOR, MEDIUM and LOW outside the delta are surfaced for the Principal's go. After round two the Principal decides, and there is no round three unless the Principal orders it. The loop pauses when a resolved finding reappears, when two consecutive rounds resolve no prior finding, or when one finding stays open three consecutive rounds while others resolve — every trigger is measured from the finding id sets, never from anyone's narrative of progress, and round five is a backstop, not a trigger. On a pause the Principal applies the `vinaya/needs:principal-input` label and works the stall menu cheapest first: a different role in the seat, resume with the trigger overridden, reseed the developer, abandon — a ruling re-enters the work as a constraint amended into the brief.

**Enforcement note:** the agent passes are **trusted discipline** today — Phase 10 requires them, but no CI bot dispatches them automatically yet. The mechanical CI gate is `verify-docs` (Phase 9). Automating review-agent dispatch is future work.

**Exit:** agent passes complete, both human reviews pass.

---

## Phase 11: Verification (runtime test plan)

**Who:** the Developer-agent (for `[agent]` items) and the Principal (for `[principal]` items). Verification is a *phase*, not a new actor — see `roles/developer/reference.md` § Verification.

A PR that has passed code review and security review still has not been run. The reviews read the diff; the static gates of Phase 8 prove the code compiles and types and tests; CI does not boot the app. Phase 11 boots it, executes the brief's **Test Plan** (a required brief field, rendered from the Issue's `## Test plan` section — see `roles/planner/reference.md` § The Planner's rationale), and posts the results onto the PR. Doctrine: **CI green ≠ app boots ≠ feature works** — runtime verification is its own gate.

The test plan is split by who can structurally execute each item:

- **`[agent]` items** (non-auth, scriptable — SSRF rejections, parse checks, route responses, render smoke). The Developer-agent boots the relevant dev server(s) from the PR's branch, runs each `[agent]` item, and posts the actual output as evidence on the PR. Paraphrase is not evidence; the command + the response body is.
- **`[principal]` items** (auth-gated, key-dependent, visual — a signed-in BYOK audit, a ModelPicker render behind Clerk, a card landing in the right column). The Principal runs each item in a browser with the dev server up and ticks the box on the PR. The agent **cannot** tick `[principal]` boxes and the Principal does **not** tick `[agent]` boxes — the asymmetry is the whole shape of the gate (mirror of the chat-vs-terminal token capture).

**`Test Plan: unit-tests-only`** is a first-class allowed value for pure-logic briefs (a parser, a sum function, a markdown normaliser — nothing the §4 Technical Surface Map lists as a runtime path). When the brief declares it, Phase 11 is satisfied by the CI unit-test gate alone; no runtime execution is required. Brief Validation rejects `unit-tests-only` on a brief whose §4 surface includes a runtime path.

**The merge gate.** A PR is not mergeable while any Test Plan checkbox is unticked — `[agent]` items waiting for evidence, or `[principal]` items waiting for Principal confirmation. An `[agent]` item that fails returns the PR to the Developer on the same branch (same loop as a `CHANGES_REQUESTED` review); a `[principal]` failure does the same. Re-running an item appends a fresh evidence comment; it does not edit the previous one.

**Enforcement note:** the `test-plan` check (a checkbox-state parse over the PR body) is **live and mandatory** — it runs unconditionally in CI on every pull request — in this repo as the `test-plan` check inside the `vinaya check --all --diff-only` job (`.github/workflows/vinaya-checks.yml`); in the attalabs reference implementation, as a step of that repo's consolidated gate job. On this repo's toolchain the same check is also reachable standalone as `bun packages/aeg-core/bin/verify-test-plan.ts`. It is not opt-in and not decided per-tranche. What remains **trusted discipline** is the judgment the parse cannot make — whether a ticked box was genuinely run. The doctrine (Phase 11 exists; the brief carries a tagged Test Plan; an unticked box means not-yet-mergeable) holds whether the CI enforcer is on or off. Brief Validation rejects a brief that touches a runtime surface and has no tagged Test Plan.

**Exit:** every `[agent]` Test Plan item has an evidence comment on the PR and is ticked; every `[principal]` item is ticked by the Principal. Or: the brief declared `Test Plan: unit-tests-only` and the §4 surface is pure-logic.

---

## Phase 12: Merge

**Who:** Principal (or the Planner if explicit per-PR delegation was set in the brief's `principal_delegate:` field).

The Principal merges. Tier 3 work merges during a ratification window (`roles/principal.md`); Tier 0/1 anytime. The merge **auto-closes the linked Issue** (via `Closes #N`) — and the merge *is* the `merged` status; nobody writes a label. An automation layer may surface a completion notification.

**Post-merge: the Archivist closes out** (`roles/archivist.md`) — confirms the Issue closed, docs coherent, `docs-index.md` regenerated. It **flags** (does not perform) orphaned branches and worktree removal. It writes no task status. (The hand-edited per-project state Issue is retired — non-derivable facts live as ordinary open Issues, closed when resolved; active state is derived from the forge.)

**Exit:** code is in main, Issue closed, close-out done.

---

## Phase 13: Tranche Close

**Who:** Principal (declares), Tranche Archivist (executes).

When the last task of a tranche has merged, the Principal declares it done and dispatches the Tranche Archivist with an explicit declaration that the tranche is closed. The Tranche Archivist (roles/tranche-archivist.md) owns all close-out steps. No automation or GitHub Actions required — self-contained, forge-agnostic.

**Steps (executed by the Tranche Archivist):**

1. **Verify the forge** — confirm all task PRs are merged, all task Issues are closed, no orphaned branches remain.

2. **Write the retrospective** — append a new section to `aeg-project/lessons.md` with observations on what went well, what stalled, carry-forward lessons, decisions made, and unbuilt tasks. Assembled from merged PR summaries and topology — not invented.

3. **Archive the tranche** — close the tranche's Milestone. That closed Milestone is the current signal to the Planner's readiness gate (`contracts/tranche-archivist-planner.md`) and to any reader that the tranche is no longer active. **Legacy exception:** for a tranche still carrying a pre-cutover topology file, also set `Lifecycle: complete` as the first line after the file's heading and move it from `aeg-root/tranches/` to `aeg-root/tranches/completed/` (one commit: `git mv`) — kept for tranches created before the forge-native cutover; a forge-native tranche carries no such file to move.

4. **Update state docs** — refresh `aeg-project/state.md` (last-updated date, current focus pointer, recently shipped section, clear any resolved pending-manual-ops). Active-work state is derived from the forge — no `now.md`.

5. **Surface pending Type 1 decisions** — query the `needs:principal-input` label for this tranche's open items. List them explicitly; the Principal ratifies at the next ratification window.

6. **Update docs-index.md** — if tranche tasks added, removed, or renamed files tracked in the index, confirm it reflects the current state.

7. **Post tranche provenance** — comment on the last merged task PR with a summary of tasks completed, duration, archival path, pending ratifications, and any dangling items.

**Artifacts:** no new commits beyond the tranche file move and state doc updates — those commits *are* the close-out. Lessons appended to `lessons.md`. Pending decisions surfaced (not ratified by the Archivist).

**Exit:** tranche is archived, state docs are current, pending decisions are surfaced, and the Principal has declared what's next (new tranche, pause, pivot, cross-cutting initiative).

---

## What happens after merge and tranche close

The Principal eventually removes the worktree (`git worktree remove …`) — deliberate friction; the worktree is sometimes useful for post-merge inspection. The specs and skills are now canonical repo state that future sessions read.

---

## Variations and special cases

### Spike work
`spike: true` → reduced Task Done (typecheck + lint, with what was tried and learned recorded in the pull request). Spike code does not merge — it rebases away or converts to a full Tier 1+ task in a separate brief.

### Tier 0 work (trivial)
Skips Phase 2; short brief; minimal checklist; light Phase 10 (a code-reviewer pass is cheap insurance, but the security pass and Planner spec review can be skipped when there's no config/auth surface and no spec change). Declare `Tier: 0` in the PR body so verify-docs doesn't require doc updates.

### Multi-developer parallel work
Each Developer gets its own worktree, branched from `origin/main`. Parallel safety is the dispatch gates: a task does not start while a `conflicts-with` sibling's PR is open, or before a `depends-on`'s PR merges (`tranche-model.md` §8). Conflicts are declared at planning time as package-level collision domains — the coordination lives in the tranche's edges, not in ad-hoc scope-checking. When unsure two tasks collide, the Planner declares the conflict and serializes.

### Cross-project tasks
A task may legitimately span multiple projects (one branch, one PR, `Project: a, b`) when the change is only verifiable as a unit (e.g. generalize a shared engine + migrate the first consumer). Review fans out across each project's lens; close-out updates each project's state. See `projects.md` and `roles/planner.md`.

### Rollback
A rollback is its own task with its own brief. The decision to roll back is a Type 1 decision (ratification window). The spec for the affected surface is updated to describe the state rolled back to.

---

## Anti-patterns

- **Going straight to dispatch without Phase 1** — a rationale written on top of an unexamined idea produces briefs that solve the wrong problem.
- **Dispatching a task whose gates aren't met, or forcing a render past a gap it flagged** — the Developer's own entry gate refuses it anyway; bypassing the gate manually just moves the failure one stage later.
- **Letting the Developer review its own work** — the Phase 10 agent passes are separate fresh-context invocations for a reason.
- **Writing status anywhere** — status is derived from the forge. Setting a label or editing the tranche file to record state recreates the racing status model the design eliminated.
- **Hand-writing brief content into the Issue's own body** — the Issue body is task identity + metadata + the Planner's rationale + judgment sections only; the brief itself is a mechanically rendered comment on it, posted by `vinaya task dispatch`, never typed by hand into either the Issue or the PR body.
- **Developer scope creep** — "while I'm here…" is a new task and a new brief.
- **Planner self-ratifying Type 1 decisions in solo sessions** — they queue as PENDING for a ratification window.
- **Skipping the Task Done checklist under deadline pressure** — it's the load-bearing discipline; skipping it is how the BYOK gap happened.
- **Treating "PR opened" as "done"** — done is "passed Phase 11 verification" (which requires Phase 10 review to have already passed).
- **Treating "review passed" as "ready to merge"** — review reads the diff; verification runs the booted app. CI green ≠ app boots ≠ feature works. An unticked Test Plan box is the merge gate even when the reviews are clean.
- **Inventing a Test Plan at verification time when the Issue's rationale omitted one** — the Test Plan is written onto the Issue at plan time and rendered mechanically at dispatch; verification *executes* the plan, it does not author it. A missing Test Plan is a rationale defect, caught by the ring-0 creation gate or the render's own refusal, not something verification improvises around.
- **Mis-tagging a `[principal]` Test Plan item as `[agent]`** to make the agent half look complete — the asymmetry is structural (the agent surface lacks auth/keys/eyes); reclassifying loses the point of the split.
- **Building a dynamic conflict scanner** to catch what the Planner missed — declare conflicts conservatively and serialize instead (`tranche-model.md` §9).

---

## How this process maps to file artifacts

For which files get mutated in which phase by which actor, see `state-machine.md` (the artifact + mutation matrix). For the roles, see `roles/principal.md`, `roles/planner.md`, `developer.md`, `reviewer.md`, `security.md`, `archivist.md`. For the tranche/task model, see `tranche-model.md` and `roles/planner.md`. For dispatching a task, see `roles/planner/reference.md` § The dispatch act.

---

## Spec format guidance

Specs produced during process phases follow this format. Adopted from GitHub Spec Kit's spec-template (May 12, 2026 evaluation).

### Required sections

**1. User stories (prioritized).** Priority (P1 must / P2 should / P3 nice), story ("As a [role], I want [action], so that [benefit]"), and an Independent Test (how it's verified in isolation).

**2. Acceptance scenarios.** Given/When/Then, one or more per story.

**3. Success criteria** — measurable, user-focused, technology-agnostic. ("User completes signup in under 60 seconds." NOT "function returns void" / "uses Drizzle.")

**4. Edge cases** — explicit enumeration, one bullet each.

**5. `[NEEDS CLARIFICATION]` markers** — wherever there's a real ambiguity, mark it inline; do not silently guess. Each is a candidate escalation point.

### When this format applies
New project specs and major feature specs (Tier 1 / Tier 3); the "Goal" section of dispatch briefs. NOT for Tier 0 tasks or narrative lessons/anti-patterns.

### Retroactive migration
Existing specs are not migrated wholesale; a spec adopts this format when it's next rewritten for other reasons.

### Why
Spec Kit's evaluation found the template produces measurably better-structured artifacts — explicit priority, visible ambiguities, success tied to user-observable outcomes. The repo adopts the format without adopting Spec Kit the tool. (The open question of whether an orchestrator eventually wraps Spec Kit templates as MCP tools was Cetana's; it retired with that product.)
