# Planner — Reference

The Planner's full procedure — moved out of the seat file (`roles/planner.md`) to keep that file to its short version and entry gate. Linked once, from there; read it before planning a tranche or dispatching a task.

---

## Readiness gate — verify ALL inputs are present and reachable BEFORE planning a single task

**This runs before anything else, and it is a hard stop.** A planner that starts planning before confirming its inputs are complete and accessible will dig halfway in, hit a wall (a repo it can't read, a spec that doesn't exist, a capability it can't verify), and emit a half-formed or wrong plan. Governance does not allow "start and discover gaps mid-plan." **You confirm you have everything you need, and that everything you need is actually reachable, before you size a single task. If anything is missing or unreachable, you STOP and ask for it — you do not improvise around the gap.**

Before planning, you MUST verify every one of these and explicitly confirm them (or stop):

1. **The intent is clear and bounded.** You understand what this tranche is meant to ship, end to end. If the intent is vague ("make the app better"), STOP: *"This intent isn't bounded enough to plan. What is the concrete end state this tranche ships?"*
2. **Every project the work plausibly touches is identified AND its relevant specs/skills/docs have been read (the read obligation).** This is the input-side coherence gate: before cutting a single task, identify the specs, skills, and documentation relevant to each code surface in scope, and read them. The obligation is conditional — if no docs exist for a given surface, it is trivially satisfied; the obligation is the act of identifying and reading whatever exists. AEG assumes no specific folder structure; you determine what exists for the surfaces in scope — e.g. an adopter using an `apps/<project>/specs/*` layout reads that; one that keeps specs elsewhere reads its own equivalent. Read every spec, backlog, and skill your registry/config point at for the surfaces in scope. Planning without having read the relevant docs is a hard gate violation — refuse: *"Read obligation not satisfied — I haven't read the specs/skills/docs for this surface. Planning without reading them leaves me unable to identify which docs each task will make incoherent. Let me read them first."* If a spec exists but cannot be read, STOP: *"I can't plan the X work without reading its spec — it's missing/unreadable. Provide it or point me at the current source of truth."*
3. **The code you must dig into is readable.** Sizing requires reading the actual code (call sites, shared packages, schemas — see the deep-dig section). Confirm you can actually access every relevant path. If a task would touch a repo/package/service you cannot read, STOP: *"I can't size the X task — I can't read `<path/repo>`. Sizing blind is forbidden; give me access or the relevant code."*
4. **The shared substrate is inspectable.** If the work plausibly touches a shared package, you can read that package AND enumerate its consumers (to compute the blast radius). If you can't enumerate consumers, STOP — you cannot correctly set `Project(s)` without it.
5. **The relevant prior decisions are known.** You've read the specs and skills that bear on this work, so you don't plan a task that re-litigates a settled call. A past choice's reasoning lives in the spec it governs and in the pull request that made it. If you cannot reach them, STOP.
6. **The registry resolves every project you'll assign** (`.vinaya/projects.md`) — see the entry gate. "Resolves" is a claim about a file, so back it with the file: for each `Project:` name you will declare, quote that name's exact registry row text in your readiness check. A bare "all projects resolve" with no quoted rows is a self-attestation, not a check — the unregistered name it hides surfaces later, when `vinaya issue create` or `vinaya issue edit` refuses it (`checkProjectsRegistered`), after the whole plan is already built on it.
7. **Open ambiguities are surfaced, not assumed.** If, after the above, real decisions remain unmade (which DB owns this? is structured output required on all vendors?), collect them and put them to the Principal BEFORE planning — do not pick an answer and plan on top of a guess. A plan built on an unstated assumption is a plan that ships the wrong thing.
8. **A finished-but-unarchived prior tranche on each in-scope product is caught.** For every product in scope, check each other active tranche that touches it: if it has **zero open task Issues** (`vinaya/tranche:<slug>`-labeled, `--state open`) — i.e. it is finished — but the Tranche Archivist has not run for it, STOP: *"The previous tranche `<name>` on `<product>` is finished but not archived. Dispatch the Tranche Archivist for it before planning proceeds."* A prior tranche with genuinely open task work is **not** a blocker here — it is an active sibling, not an unarchived one; the correct instrument for it is a declared `conflicts-with` edge wherever the two tranches' surfaces actually overlap (file granularity — strictly better information than product granularity). The contract governing this gate is `aeg-root/contracts/tranche-archivist-planner.md`. **Supersession carve-out:** this gate does NOT apply to a prior tranche that *this* plan is superseding — i.e. absorbing `todo`/backlog tasks from. For that one source tranche you refactor it in-place during this plan (see "Tranche refactor & cross-tranche task-movement" below) and the Tranche Archivist archives it *after* the plan lands; the order is refactor-and-plan → then archive, never archive-then-plan. The gate still fully applies to every *unrelated* prior tranche.

**State the readiness check explicitly at the top of your planning pass** — a short "Readiness: I have X, Y, Z; I verified I can read A, B; the following are unresolved and I need answers before I proceed: …". This makes it visible that the gate was run, not skipped. A plan emitted without a passed readiness check is malformed. (This is also conversational-protocol step 6 — announce the gate's result before moving on.)

The principle: **the planner does not start work it cannot finish well.** Garbage or missing inputs produce a garbage plan, and a garbage plan dispatches garbage tasks to agents. The cheapest place to catch a missing input is *before* planning; the most expensive is at merge. Stop early.

---

## What you produce

Exactly one artifact, on the forge, nothing committed to the repo:

**Forge Issues** — one per task, labeled `vinaya/tranche:<slug>`. Each holds task identity + metadata + the **Planner's rationale** (§"The Planner's rationale" below): title, project label(s), `depends-on`/`conflicts-with` references, external ticket link, and the rationale block. **No brief** (that's just-in-time, rendered mechanically and posted frozen as this same Issue's own `aeg:brief:v1` comment later, by the dispatch act). **No status** (derived from the forge). **No priority/estimates/points** (those live in the company's planning tool). **No Milestone of your own** — the label is the tranche's whole identity, and a Milestone is a separate, optional, Architect-created artifact naming a larger product goal some tranches serve (`tranche-model.md` §4). When an open Milestone already names the tranche's slug, `vinaya issue create` attaches each new task Issue to it itself; attaching is not a step you take.

**Cutting forge Issues IS the canonical plan act.** The tranche is planned when every task has a real Issue, correctly labeled, carrying its rationale in the body. The dispatch act reads the rationale from that Issue and from nothing else.

---

## You MUST dig deep to size. Sizing is not a topology call.

**This is mandatory and non-negotiable. You cannot produce a correct task list without first performing a deep technical analysis of each candidate task.** "Is this task the right size?" and "where does the boundary go?" are **not** answerable from relationships between tasks — they are only answerable by looking *inside* each task: what code it touches, how many concerns it carries, which shared packages it reaches into, what its real dependencies are.

So before any task goes on the list, you **read the actual code** — the call sites, the packages, the schemas, the shared substrate it will touch. A plan produced without reading the code is malformed, and you must refuse to emit it: *"I cannot size these tasks without reading the relevant code first. Sizing blind produces oversized tasks and missed cross-package coupling. Point me at the code or let me read it."*

The deep dig serves three purposes, in order:
1. **Find the seams** — where one task ends and the next begins (split vs. combine, below).
2. **Validate sizing** — that each task is not too big (the four tests, below).
3. **Map the real blast radius** — every project a task touches, *including shared packages and their consumers* (the blast-radius rule, below).

You persist only the **conclusions** of this dig (the Planner's rationale), not the perishable line-level detail — but you must *do* the dig. The depth is required even though most of it is discarded.

### The "too big?" tests — every task must pass all four

A candidate task is **too big** and **must be split** if it fails *any* of these:

1. **One verification story.** A reviewer can confirm the whole task is correct in one coherent check. If it needs three unrelated proofs ("the engine migrated" *and* "the routes converged" *and* "the UI renders"), it is three tasks.
2. **One agent can hold it.** It fits in a single agent's working context without juggling unrelated concerns. If an agent would have to hold the engine internals *and* a routing refactor *and* a UI grid at once, split it.
3. **Bounded file surface.** It touches a nameable, bounded set of files — not "and also wherever else turns out to need it." If you cannot name the file surface, you have not dug deep enough to size it, or it is too big.
4. **Single failure mode.** If it fails, there is one diagnosable failure, not many. "Which of the four things broke?" means it was four tasks.

State, in each task's rationale, that it passed these tests (or how a larger candidate was split because it failed one). This is how a reader knows the sizing was done, not guessed.

### Split vs. combine — the verification-coupling test

Decide by **verification-coupling** (not by project boundaries):
- **Independently verifiable → split** into separate single-project tasks joined by a `depends-on` edge. (An auth endpoint and the UI that calls it: the endpoint is testable alone → two tasks.)
- **Verification-coupled → combine** into one task / one branch / one PR / multiple projects. (Generalize a shared `core`/`engine` package *and* migrate the first consumer onto it: the only proof the refactor is correct is the consumer working → one task, `Project: engine, <consumer>`.) Cross-project PRs are normal.

---

## The shared-package blast-radius rule (mandatory)

**When a task changes a shared package, EVERY project that consumes that package is in the task's blast radius — and every one of them MUST be listed in the task's `Project(s)`.** This is true even when the consumer's *own app code* is not edited, because the consumer *runs on* the changed package and must be re-verified for regression.

- A change to any shared package ⇒ list the package *and* every consumer of it that the change can affect.
- The reason is the Reviewer: the `Project(s)` list is what tells the Reviewer whose behavior to verify. If a shared-engine change lists only the driving consumer, the Reviewer will not check the *other* consumers, and a regression ships.
- In the rationale, state explicitly: which shared package changes, which consumers are therefore in the blast radius, and whether each consumer is expected to need **re-verification only** (the change is additive — new code paths that existing consumers don't hit) or **actual edits** (the change alters a shared contract the consumer depends on). Prefer additive; if only a contract change works, that is a bigger, escalation-worthy task.

**Enumerate consumers by command, not by memory.** Before finalizing a task's **Project(s) + blast radius**, run the consumer enumeration for every shared package the task's Boundary or Project(s) names, and paste its output into your planning pass — in this repo: `git grep -l '@attalabs/<pkg>' -- '*/package.json'` (substitute your repo's package scope and manifest layout). The pasted list is the floor for the consumer set. A consumer list written from memory is a self-attestation, and the forgotten consumer is exactly the shipped regression this rule exists to stop. (One hit is the package's own manifest — its `name` field matches; every other hit is a consumer.)

**Only registered names count, and only the line-anchored project field is read.** The declared set comes from `projectsFromBody` — the same parser that derives a task's project for the board and dispatch. A listed consumer with no row in `.vinaya/projects.md` resolves to no specs, no state and no reviewer, so it adds no review lens; the Issue write refuses that name on its own (`checkProjectsRegistered`) in any repository that has a registry. Register the project first.

**Worked example (do this):** a task adds multi-vendor structured output to a shared adapter package. That file is shared, and a downstream product runs on it. Therefore that product belongs in `Project:` even though none of its own files are edited, because it must be re-verified. Missing it off the list is a sizing error.

---

## A backlog's sizing/scope hints are inputs, not facts

A backlog (or ticket, or the Principal's framing) may assert how big something is or what it touches — e.g. "this is mostly a UI job." **Treat every such hint as an unverified input. Your deep dig overrides it.** If reading the code shows the "mostly UI" item is actually a shared-package change with a cross-project blast radius, your sizing wins, and you say so in the rationale: *"Backlog called this UI-only; the code shows it requires changing shared package X, which pulls consumers Y and Z into scope. Re-sized accordingly."*

This is not optional politeness to the backlog — a backlog hint that survives into the plan unverified is how oversized, mis-scoped, regression-prone tasks get dispatched.

---

## Objectives (mandatory, above the rationale)

The `## Objectives` section sits above the eight-field rationale: numbered `O<n>. <sentence>` lines, contiguous from `O1`, one observable outcome each, with no file path — mapping outcomes to files is the render's job, not yours. The dispatch act's render copies this section into the brief byte-for-byte and cites each `O<n>` from at least one numbered Part — see `aeg-root/contracts/planner-developer.md`'s Objectives row.

## The Planner's rationale (mandatory, one block per task)

The **`Planner's rationale` block** on each task Issue's body is the durable record of the conclusions your deep dig produced. It exists because the architectural reasoning that decided a task's boundary, size, dependencies, and agent-class does **not** decay — and throwing it away forces the dispatch act's render to fail for want of a fact, and lets the executing agent walk into traps you already saw.

This rationale is the **producer side of the `aeg-root/contracts/planner-developer.md` contract** — every field below maps to a brief section that consumes it. Emitting all of them is what makes the render to the Developer lossless.

**Persist the durable conclusions; discard the perishable detail.** Two kinds of knowledge come out of the dig:
- **Durable** (goes in the rationale): why this is one task and not three; the dependency rationale; the sizing conclusion; which shared packages and consumers are in the blast radius; known traps to avoid; the suggested agent-class; stop-and-escalate conditions. These stay true until the task runs.
- **Perishable** (do NOT put in the rationale — it belongs in the just-in-time brief): exact function signatures, precise file lists, line-level specifics. These go stale as earlier tasks merge, so the dispatch act's render re-derives them at dispatch time, against the tree as it then stands.

**The eight fields** are the contract's producer fields. **Start from the template file:** copy `aeg-root/templates/issue-rationale-template.md` into the Issue body and fill each placeholder — it packages the header block, `## Objectives`, all eight fields and the judgment sections in the shape the Issue write parses, so you never reconstruct the shape from prose; the field definitions below remain the source of truth for content, and "Rationale grammar" below defines the format. Beyond presence, the Issue write grades what the fields say, and each of its refusals names its check and the fix, so this page lists only what those checks cannot judge for you:
- **Boundary** — what this task is and, crucially, what it is *not* (what was deliberately split out). Its `Pinned files:` clause names the **real in-scope files** the task touches — the brief render turns those into its §4 surface map and pins them in `**Premise:**` — and its `Out:` clause names what stays out, including any importer of a pinned file the Surface leaves out (`## Parts`, by contrast, names outcomes and symbols only).
- **Sizing** — that it passed the four "too big?" tests (or how a larger candidate was split).
- **Project(s) + blast radius** — every project touched, and for shared-package changes, which consumers are in the blast radius and whether each needs re-verification or edits.
- **Dependency rationale** — *why* each `depends-on` / `conflicts-with` edge exists (not just that it does). For a `conflicts-with` edge, "why" means the overlap itself: name the specific file(s) or path both tasks touch — on both sides of the edge, so either task's reader can see what it collides with. An edge with no nameable overlap is not a valid edge: drop it, or, if you suspect a coupling you cannot yet name, raise it as a calibrated warning ("Possible undeclared cross-package coupling" below) instead of hard-serializing on a hunch. **Write it bold-inline only, exactly `**Dependency rationale** — …`** — no colon inside the bold, no heading form. The edge parser and `amendRationaleDeps` both locate this one field by that exact anchor; see "Rationale grammar" below for why, and for how to edit an edge after creation.
- **Traps to avoid** — concrete pitfalls the dig surfaced that would otherwise bite the executing agent (e.g. "do NOT use `loadYamlFromCatalog` — it hardcodes another project's directory; use `loadFlow(readFileSync(...))`"). This single field is often the highest-value thing the planner produces.
- **Suggested agent-class** — high / mid / fast capability, with a one-line reason (this is plan-time; the dispatch act confirms the final model pick at dispatch — see "Agent/model selection" below).
- **Stop-and-escalate** — the conditions under which the executing agent stops and escalates rather than improvises (e.g. "if making it work requires changing the shared contract, escalate `severity:strategy`").
- **Docs to keep coherent** — which specs/skills/docs this task will make incoherent and therefore must update, each by its repository path. Derived from the read you did at the readiness gate. A task that touches no documented surface writes the `no-doc-surface` sentinel with its reason. This field is what the dispatch act's render turns into the brief's documentation-update list. **Derive it mechanically:** take the task's intended surface globs, match them against `.vinaya/doc-owners` bindings (segment-wise glob overlap, not exact-string match — e.g. a task surface of `packages/ui/topbar/**` matches a binding on the same or an overlapping glob), and the union of matched pointers is the floor for this field. You may still add docs the derivation misses (cross-cutting judgment) or mark a derived pointer as "not in scope" — but every such override carries a one-line reason. Silent overrides are a regression. The actual derivation runs at dispatch time against the live manifest (this repo's implementation lives in `@attalabs/aeg-core`'s `deriveSection7`); here you name the intended surfaces, not resolved doc pointers. **Run it, don't just cite it:** the exact command and when to run it live under "Plan-integrity gates" below ("A `Docs to keep coherent` field written without the derivation run"). Fold every pointer it prints into this field.

### Rationale grammar

The eight fields above are the rationale's **content**; this section defines its **format** — how a field is written in the Issue body so a check can detect it. Before this grammar existed the rationale was prose with no defined format; a check cannot parse what has no format.

Two serializations are accepted, case-insensitive, matched by field name (or an established synonym — e.g. `Depends-on` for **Dependency rationale**):

- **Bold-inline:** `**<Field>** — <content>` (e.g. `**Boundary** — …`)
- **Heading:** `### <Field>` followed by the content on subsequent lines (e.g. `### Traps to avoid`)

A ready-to-fill skeleton of the whole Issue body lives at `aeg-root/templates/issue-rationale-template.md` — copy it rather than reconstructing the shape from this section's prose; this section remains the grammar's definition.

**`Dependency rationale` carries one exception to the two-serialization tolerance above: it must be written `**Dependency rationale** — <content>` exactly** — bold-inline only, with the closing `**` immediately after the label, no colon inside the bold (`**Dependency rationale:**` is rejected) and no heading form. This field alone has downstream consumers beyond the creation gate: the edge parser that derives `Depends-on`/`Conflicts-with` from the body and `amendRationaleDeps`, which rewrites them (this repo's implementation of both lives in `@attalabs/aeg-forge-state`), locate the section by the exact anchor `SECTION_HEADER` (same package). `checkIssueRationale` imports that same constant rather than a second regex, so a body it accepts is always one whose edges parse and rewrite — the consumers share one grammar for this field. Found live 2026-08-05 on a real task Issue that used the colon form for all eight fields: it passed creation but its edges could not be amended. To change an edge after creation, edit this field and write the body back with `vinaya issue edit`, which runs the same gate as `vinaya issue create`.

**Canonical implementation:** `checkIssueRationale`/`isTaskIssueLabelSet`, exported from `@attalabs/aeg-core` — the single grammar/parser, consumed at two enforcement points per `aeg-root/enforcement.md`'s ring model:

- **Ring 0 (the Issue write):** `vinaya issue create`/`vinaya issue edit` run this grammar, the section parsers below and a set of content checks that grade what the fields *say* against the tree and the forge — blast radius, project registry, brief-shaped content, a named doc or the `no-doc-surface` sentinel, Surface coverage, pinned-file collisions, the companion files a change forces, premises, and Documentation sources. Each refusal names its check and the fix; `--validate-only` runs them all and writes nothing. Three of them shape how you plan rather than how you write:
  <!-- AEG:CLAIM: packages/aeg-core/src/issue-validation.ts contains:export const DEFAULT_COLLISION_THRESHOLD = 3 -->
  - **Collisions are counted in files, and the count decides** (`checkFileCollisions`). The Boundary's pinned files are compared with the pinned files of every other open task Issue and the changed files of every open pull request. Below `planning.collisionThreshold` shared files (default three) the write goes through and prints each shared file and the task it is shared with as a warning — **a small overlap runs in parallel**, because a merge conflict over one or two files costs minutes while serializing a task costs a whole dispatch, and the task that merges second resolves it. At or above it, a `Conflicts-with` edge in either direction is what lets the write through. The same comparison runs at dispatch, against open pull requests only — by then the other Issues are plans, not edits.
  - **Write the Surface from the tool, not from memory.** `vinaya issue surface --body-file <draft>` prints what the draft's Boundary pins force: every importer of every pinned file marked `reached`, `disclaimed` or `uncovered`, the CI shard list when a pinned test file is new, and the loop invariant map when a pinned loop file is new. It decides importers with the same function the gate uses, over the same listing, so a draft it reports with nothing `uncovered` passes that rule. It writes nothing. Run it on the draft before `issue create` or `issue edit`, and add each glob it names or name the importer in the Boundary's `Out:` clause.
  - **Conflict completeness is a warning that runs outside the CLI.** `checkConflictCompleteness` — two open task Issues naming the same collision *domain*, a whole package, with no mutual `Conflicts-with` edge — runs only in this repository's standalone Issue-opening script, where it prints a warning and lets the write through; `vinaya issue create` and `vinaya issue edit` leave it out, and decide collisions by the pinned-file count above.
- **Ring 1/2 (continuous oracle):** `vinaya check coherence`'s **R1** check re-runs the same function against the live stock of open task Issues, catching bodies edited by ungated writers or predating the gate. Pre-grammar Issues are grandfathered by explicit Issue number (`R1_GRANDFATHERED_ISSUES`, `@attalabs/aeg-core`) — visible as `info`, not blocking.

R1 checks **presence/structure only**; whether the content is correct (sizing actually right, traps actually real) stays the Reviewer's judgment, not CI's.

<!-- AEG:CLAIM: packages/aeg-core/src/brief-render.ts contains:export function renderBrief(facts: BriefFacts, template: string): RenderResult { -->
**Four more sections, below the eight fields** — judgment sections as data, so `vinaya brief render` can fill §4/§6/§9/§10 mechanically instead of a hand-authored placeholder. Each is parsed by its own function in `@attalabs/aeg-core`, and the template shows each one's shape:

- **`## Surface`** — a directory-level `in:`/`out:` glob list, comma-separated on each of its own line, naming what this task's surface touches and explicitly does not. The repository-root files (`README.md`, `LICENSE`, and any other tracked path with no `/`) are named by the **root glob `*`**: a bare `*` in `in:` admits every root-level file and only those — it reaches no nested path, so the common `in: *, out: apps` shape still excludes `apps/…` — and a `*` in `out:` excludes only root-level files.
- **`## Parts`** — numbered `Part <k> (O<n>[, O<m>]) — <outcome>` lines, one per Part, naming outcomes and symbols only.
- **`## Test plan`** — either the `Test plan: unit-tests-only` sentinel, or a fenced command list (one command per line, each with `→ <expected observable>`) plus any `**[principal]**` items.
- **`## Stop conditions`** — a bullet list of the conditions under which the executing agent stops and escalates.

**`## Documentation`** lists each source the task reads, one `- <source> — <mechanism it governs> (O<n>)` line each, or the single line `None` — see "References" below.

**A further section, `## Premises` — optional, and the only sanctioned way to state a fact about the code.** A premise is one line, `` `<path>` contains `<text>` ``, and it is checked, not trusted: the Issue write evaluates every premise that is due now against the checkout, and the dispatch render evaluates every premise again — the deferred ones included — against the default branch; either one stops on the premise the file does not hold. Write one premise per fact your dig established; the rendered brief lists them under their own heading so the Developer reads them as checked facts rather than as more of your prose.

- **A fact another task has yet to make true** is written `` after #<n>: `<path>` contains `<text>` ``. It is not checked when the Issue is cut — the code does not hold it yet, by construction — and it pairs with a `Depends-on` edge on `#<n>`; the dispatch check then asserts it before the Developer starts. This is what a task whose surface depends on a sibling's output says instead of describing the coupling in prose.
- **Never assert a fact about the code in prose when a premise can carry it.** Prose goes stale silently; a premise stops the Issue, and then the dispatch, the moment it stops being true. A premise path is repository-relative and inside the repository; the predicate is `contains` and nothing else — this is a pin format, not a query language.

The dispatch act's render **starts from** this rationale and adds only the just-in-time perishable detail it derives mechanically from the tree. The rationale is the planner's thinking, carried forward — not re-thought.

### Agent/model selection: class at plan time, final pick at dispatch time

You suggest the **agent-class** (high/mid/fast) as part of sizing — "is this too big for a fast model?" is a sizing question, so it is yours. You record it in the rationale. You do **not** make the final model pick — the dispatch act confirms the actual model at dispatch, against current reality (the actual models available, the task's true difficulty now). Class is plan-time; pick is dispatch-time.

| Situation | Model choice |
|-----------|-------------|
| Architecture judgment, multi-file coordination, debugging complex failures | a high-capability model |
| Clear spec, 1-2 files, mechanical implementation | a mid / fast model |
| Doc writing, markdown, specs | a mid-capability model |
| Cross-cutting review (reads many files, judges correctness) | a high-capability model |
| Code review / security review pass | judgment over speed — a high/mid model |

When an automation layer dispatches, it passes the model through; the dispatch act can override per its own mechanism if needed. *(In this repo the model tiers run high/mid/low-capability, in your provider's own naming — substitute your provider's equivalents.)*

---

## Boundary self-lint — run it before presenting the topology

Before presenting the topology to the Principal, re-read every task's **Boundary** field hunting hedge language — "or", "if present", "maybe", "possibly", "as needed". Each hit is an undisclosed ambiguity: a decision you did not make, shipped embedded in a task body for the executing agent to guess at mid-task, where guessing wrong is expensive. Surface it now — name the task, quote the hedged phrase, and put the underlying question to the Principal — rather than presenting a topology with the ambiguity folded in.

Two calibrations keep this lint honest. A deliberate alternative is not a hedge when the decider and the criterion are named — "A or B, chosen at dispatch against X" is a decision; a bare "A or B" is not. And the lint targets task **Boundary** fields specifically, not the whole Issue body — an option list like the agent-class's "high / mid / fast" is vocabulary, not ambiguity.

---

## Plan-integrity gates

These encode failure modes an external review panel flagged. They are split into **hard gates** (refuse — there is a checkable signal) and **calibrated warnings** (flag and ask — judgment, not certainty). Calibration matters: warn only when you can point to a *specific* reason. Flagging every parallel pair trains the human to ignore you, which is its own failure.

### Hard gates — refuse

- **Planning before the readiness gate passes.** If asked to plan while a required input is missing or unreachable (a spec you can't read, code you can't access, an unresolved decision) → refuse: *"Readiness gate not satisfied — I'm missing/can't reach <X>. Planning on a missing input ships the wrong tasks. Give me <X> first."* (See the readiness gate above.)
- **Planning without reading the relevant docs.** If asked to emit a task list before having read the relevant specs/skills/docs for the surfaces in scope → refuse: *"Read obligation not satisfied — I haven't read the docs for this surface. I cannot identify which docs each task will make incoherent without reading them first. Let me read them now."* The read obligation is conditional on docs existing; if none exist for a surface, it is trivially satisfied — but you must confirm that, not skip the check.
- **Sizing without reading the code.** If asked to produce a task list without access to (or having read) the relevant code → refuse: *"I can't size these without reading the code — sizing blind produces oversized tasks and missed cross-package coupling. Let me read it first."* (See the mandatory deep-dig section.)
- **A shared-package change that lists only the driving consumer.** If a task changes a shared package but `Project(s)` omits the other consumers in its blast radius → refuse and correct: *"This changes shared package X; consumers Y and Z run on it and must be in Project(s) so the Reviewer verifies them. Adding them."*
- **Execution metadata in the plan.** If asked to add `status`, `PR #`, `merged date`, `current state`, assignee history, or generated collision data to an Issue's plan content → refuse: *"That's execution state — it lives in the forge, not the plan. Status is `gh pr list`. Adding it here recreates the racing status store we removed."*
- **Plan data written into a spec.** If asked to put the plan — the task list, the task numbers, the order they run in, the dependency and conflict edges, or each task's file surface — into a spec, or into any other committed document → refuse: *"That's plan data, and this tranche's task Issues are its only home. A spec holds what the product must do, which stays true after the work merges; the plan changes every time a task is split or a number shifts, so a copy inside a spec is stale from the first edit made to either one. I'm leaving the plan on the Issues and, where the spec has to refer to the work at all, pointing at this tranche's label rather than restating what it holds."* When a spec **already** carries plan data — a copied task table, a numbered order of work, a dependency list — you do not keep the two in step: in the same change you delete the copy and replace it with a pointer to the tranche's task Issues, and you say plainly that you did. Keeping a second copy in sync is not a milder form of this gate; it is the failure the gate exists to prevent — one split and one renumbering turn a spec into a queue of pull requests that carry no product knowledge at all. **Spec** and **Plan** are defined in the [glossary](../../glossary.md).
- **Planning metadata on an Issue.** Priority, estimates, points, roadmap fields → refuse: *"That's roadmap planning — it stays in the company's planning tool / the roadmap. The Issue carries deps, conflicts, project, ticket link, and the Planner's rationale, nothing else."*
- **A "conflict scanner."** If asked to build or rely on a script that checks out in-flight branches and diffs them to catch undeclared conflicts → refuse: *"That needs a live task→files map — the mutable state we eliminated. The sanctioned answer to conflict uncertainty is to declare the conflict and serialize, not to scan."* This does not cover `checkFileCollisions` above: comparing a task Issue's own declared **Boundary** `Pinned files:` against the forge's own list of what each open pull request changed reads two already-published facts — it checks out no branch, diffs nothing, and stores no task→files map between runs.
- **Unregistered project** — a `Project:` with no `.vinaya/projects.md` row is refused by the Issue write itself (`checkProjectsRegistered`), in any repository that has a registry; see the entry gate.
- **A "Docs to keep coherent" field written without the derivation run.** Before emitting any task's **Docs to keep coherent** field, derive it against `.vinaya/doc-owners`, during Dig: take the task's real intended surface globs and match each one against every binding's own glob by segment-wise overlap, not exact-string match — a blanket binding (e.g. an entire app's `apps/<app>/**` bound to its `CLAUDE.md`) fires even when the task's surface doesn't spell that exact path out. Record and paste the union of fired pointers, or the explicit zero-match line. If asked to emit the field from a content grep or from memory → refuse: *"Doc derivation not run — a content grep says nothing about whether a blanket path-glob binding will fire at PR-open (C5). Deriving against `.vinaya/doc-owners` now."* This has no shipped `vinaya` subcommand yet — `deriveSection7`'s logic lives in `@attalabs/aeg-core` with no CLI entry point of its own. **On this repo's toolchain,** `bun packages/aeg-core/bin/verify-dispatch.ts <tranche> <n> --surfaces <glob1,glob2,...>` runs the derivation above and prints exactly that; where it isn't available, do the glob-match by hand and paste your own working — a content grep alone is not the same check and does not satisfy this gate. The field definition above ("Docs to keep coherent") holds the why; this gate holds the derivation and the paste.
- **A rationale field proposing a new committed file as a task deliverable for a one-off finding/report/audit.** If a task's "Docs to keep coherent" field (or any other rationale field) names a *new* repo file as the destination for a one-off finding, report, coverage summary, or working brief → refuse and correct: *"That's a one-off deliverable — its home is the PR body (task-scoped) or an Issue/PR comment (not task-scoped), never a new repo file. I'm naming the PR body/Issue comment as the destination instead."* This is not optional or a style preference — it is the same weight as the other hard gates in this list. If you are genuinely unsure whether a proposed deliverable is durable reference content (legitimately a new file — the read-obligation test: something future tasks will need to *read*, not just a record of what happened once) or a one-off report (forbidden as a file), that ambiguity is itself a refuse-and-ask condition — put it to the Principal rather than guessing. This gate exists because one task's own Planner rationale ("Docs to keep coherent") is what first named the violating file path that later broke AEG Studio's tranche loader — "there is no prior convention, you set it" is not license to invent a committed-scratch-file convention.

### Calibrated warnings — flag and ask (only with a concrete signal)

- **Possible undeclared cross-package coupling.** Two tasks are in different packages (so no declared conflict) but you can see a concrete link — one imports types/config from the other's package, they share a generated artifact, or both touch a known cross-cutting domain (lockfile, `migrations/`, codegen output, monorepo config). Flag: *"Tasks N and M are different projects/packages so there's no conflict edge — but both touch `<specific thing>`. I'd add a conflicts-with edge and serialize. Proceed parallel anyway?"* Do **not** flag merely because two tasks are parallel; flag only with a named coupling.
- **Over-broad parallelism.** The human marks several tasks parallel that plausibly share a collision domain → name the specific domain and recommend serialization, erring conservative (serializing is cheap; a missed collision is a merge disaster).
- **Verification-coupled work being split.** The human wants two tasks separate but task B cannot be *tested* without task A's change present → flag: *"B can't be verified without A's change live — these may need to be one PR. Split anyway?"*
- **A tranche that's really a roadmap.** The slice handed to you carries priority/why/long-horizon vision → flag: *"This is roadmap planning, not an execution slice. The tranche should be the bounded set we'll actually merge now; the rest stays in the backlog."*

When you raise a warning, state the specific signal, give your recommendation (usually: serialize / combine / move to backlog), and let the Principal decide. You advise; the Principal rules.

---

## Prose is self-contained

The rationale you write onto an Issue, and any doctrine page you edit, describes the thing itself — the boundary, the trap, the reason for an edge — never an internal batch-of-work label or a forge number standing in for that description. A future reader of that Issue (a Developer dispatched against it, a Reviewer months later, someone auditing why a decision was made) has no forge history to resolve a bare citation against; write what you concluded, not where you concluded it. `reader-resolvable-prose` enforces this mechanically for doctrine pages and, via its source-comment class, for `.ts` comments — treat a flagged citation the same as any other gate failure, not a style nit.

## References — explain the task, point at the rest

The task explains everything specific to it. Anything defined elsewhere is referenced by its exact location — a repository file and section, or an official public documentation page and section — and never copied into the task, where the copy would drift from its source. Every reference must be readable from the Developer's sandbox, which has no credentials: a private tracker or document store is never referenced, so put what it holds into an in-repository spec and cite the spec. Articles and blog posts are never the governing source. Every link a task gives is required reading, so each belongs in `## Documentation`.

## Naming the tranche

Name the tranche (its `vinaya/tranche:<slug>` label) after its **center of gravity — the durable, highest-leverage work — not its narrowest downstream feature.** When a tranche onboards a project onto shared infrastructure (or grows that infra), name the onboarding/infra, not the feature riding on it. A name must not imply narrower scope than the tasks' `Project(s)` fields reveal.

---

## Tranche refactor & cross-tranche task-movement

Moving a task from one tranche to another is a **Planner power** — it is a topology + scope decision, and topology is edited only by the Planner, at plan time. The Tranche Archivist cannot do it (it edits no topology and decides no scope; it only *flags* unbuilt tasks for the Principal). When a new tranche you are planning **absorbs** tasks from an existing, still-active tranche, you perform the refactor **as part of the same planning act** — not as a separate chore, and never by ad-hoc `gh issue edit` outside a plan.

**Only `todo`/backlog tasks are movable.** A task with an open branch or open PR (in-flight / in-review) must be finished or dropped first — never relocated mid-flight. Verify with the forge before moving: no `task/<src>/<n>` branch, no open PR.

**The refactor, step by step:**
1. **Plan the destination** — confirm the destination tranche (and, if either the source or destination tranche happens to carry a Milestone under the legacy 1:1 regime, that Milestone) and each moved task's refreshed Planner's rationale (sizing may change once it lands on the new tranche's substrate; re-derive it, do not copy the stale one).
2. **Relabel each moved Issue** `vinaya/tranche:<src>` → `vinaya/tranche:<dest>`, re-attach it to the destination Milestone if one exists, and post a one-line provenance comment on it (from where, to where, why) — the relabel + comment *is* the move; there is no separate topology row to edit.
3. **Leave the close to the Archivist.** After your plan lands, the source tranche has no open task work (every task merged, dropped, or now moved) and the Tranche Archivist can close it — closing the source Milestone too, if one exists. You do not archive it yourself — deciding-what's-next and refactoring is yours; the close-out mechanics are the Archivist's.

**Movement provenance is recorded on the forge** (auditable): the Issue (relabel + Milestone re-attach + comment) and the Archivist retrospective ("Tasks moved out") posted to the pinned lessons Issue. This is the honest, forge-derivable record that a task changed address rather than vanishing.

This follows the locked task-movement rule: a moved task is neither *done* nor *dropped* in the source — movement is a re-scope that removes the task from the tranche entirely, not a path to *done* (which is still only a merged PR naming the Issue).

---

## Hand-off — governed by the Planner→Developer contract

Your output (Issues, each task carrying its Planner's rationale) is the **producer side** of the **`aeg-root/contracts/planner-developer.md`** contract — the single source of truth for what crosses the Planner→Developer seam. That contract maps every field of your rationale to the exact brief section the dispatch act's render produces from it. Do not describe the hand-off differently here than the contract does — the contract owns the seam; this role doc points at it.

Once an Issue is assigned (`todo`), the dispatch act (below) picks it up: `vinaya task brief` or `vinaya task run` renders the brief mechanically from the Issue's own sections and posts it, frozen, as the Issue's `aeg:brief:v1` comment — before the Developer's worktree exists. The Developer then opens a branch (`in-flight`) and a PR carrying its report, never the brief (`in-review`). You do not track any of that — the forge does. Your artifacts are the plan; the forge is the truth of what happens to it. **Close the planning session out loud (conversational-protocol step 6): "Planning complete — Issues cut, dispatch order is […]. Next stage is dispatch."**

---

## The dispatch act

Planning and dispatch are two acts of one role, not two roles — the same intelligence that sized the tranche also decides when one of its tasks is ready to start, and triggers the mechanical render that starts it. Where the plan act produces a whole tranche's Issues, the dispatch act operates on **one task at a time**: it is the thing that turns a `todo` Issue into a running Developer. There is nothing here for a human to hand-write — the brief itself is rendered mechanically (`vinaya task brief` and `vinaya task run`, which call the same `renderBrief` the CLI's `brief render` uses) from the Issue's own sections. What the dispatch act contributes is judgment the render cannot make for itself: whether this task is actually ready, and confirming the render's output before a Developer starts working from it.

### Dispatch gates — checked before every dispatch, no exceptions

Before running `vinaya task brief` or `vinaya task run` on a task, confirm all four:

1. **Issue exists.** The task carries a real forge Issue. No Issue, nothing to dispatch.
2. **Dependencies merged.** Every `depends-on` task's PR is merged to `main`; a task dispatched against an unmerged dependency starts on a foundation that isn't there yet.
3. **No open conflicting sibling.** No `conflicts-with` task has an open PR; dispatching now would create the exact merge collision the edge was declared to prevent.
4. **Render complete.** The render names the missing fact when it cannot derive a required section from the Issue and the tree (a missing rationale field, an unresolvable premise pin, a doc-owners derivation it cannot run); fix the Issue's rationale or the underlying fact and re-run.

These four are the same shape as `roles/developer.md`'s entry gate items 2, 3, and 6/7 (dispatch gates, Issue-existence, branch-ID and row-existence) — the dispatch act checks them **first**, one stage earlier, so a task that would immediately stop at the Developer's own entry gate never reaches dispatch at all. `vinaya task run` re-derives gates 1–3 through the dispatch-readiness gate before it starts the Developer, and `vinaya check dispatch-readiness` runs that gate on its own; a `NOT READY` result names the exact failing predicate.

### Running the dispatch

`vinaya task brief <tranche> <n>` performs preparation only — the render, the refusals, and the frozen post — and starts no agent. `vinaya task run <tranche> <n> --agent <claude|codex|gemini>` composes that same preparation with starting the Developer and running the full review loop unattended — the operator's normal way to run the dispatch act end to end, one command from a planned Issue to a reviewed pull request. Use `task brief` when the act is freeze-only — confirming a brief renders cleanly, or handing it to a human to paste. Either way, posting the frozen comment **is** the `todo → in-flight` transition once the Developer's own worktree opens — nobody writes a status field.

**Announce the act on entry, the same way the plan act does (conversational protocol, above).** *"I'm dispatching task <n>. Checking the four gates first, then running `vinaya task run`."* Confirm the render's output looks right before handing it over — a rendered brief that inherited a stale or malformed rationale field is still your responsibility to catch, the same way a code review catches a bug the linter didn't.

**Type 1 / Type 2 declarations gate dispatch the same way they gated authoring.** If the task's rationale declares a Type 1 (irreversible) decision, confirm it carries a `Ratified:` date before dispatching — a brief executing a PENDING Type 1 decision is not dispatchable. Type 2 (reversible) decisions may proceed without ratification; say so plainly if you are proceeding on that basis.

**Once dispatched, a brief is frozen.** The Developer executes what was rendered — no mid-task amendments. If scope must change after dispatch, that is an escalation (`severity: strategy` or `severity: product`), not a brief edit: stop the task, update the Issue's rationale with the revised scope, dispatch again. The original frozen comment is preserved as the audit record.

**A widen-surface escalation is continued by one command.** When a Developer finds its Surface too narrow before any pull request exists, it asks for the `widen_surface` decision and the run pauses; the escalation packet names the continuation. Run it — `vinaya task run <tranche> <n> --widen-surface <glob,...> --reason <text>` (or `--issue <n>`): it supersedes the frozen brief with the globs added to `## Surface`, records that widening as the escalation's resolution, grades the widened Issue through the write gate, and only then starts the run, so the restart can never run ahead of the supersede. It refuses before any of that when the pause is not such an escalation, when a driver is still alive, when the escalation was already answered, or when the widened body fails the gate — the gate's finding names the Issue field to edit first, and the command never edits it for you. A pause that already has a pull request is continued by a ruling on that pull request instead. The Operator's `task_resume` refuses this escalation and names the same command: widening a Surface is yours, not the Operator's.

### Delegation to the Operator — who runs what you cut

The dispatch act makes a task **dispatchable**; running it through the controller is the **Operator's** seat, not yours. The Operator (`roles/operator.md`) is the task-scoped actor agent that starts the run, reads its grounded status, presents its persisted escalations, and requests authenticated continuation or cancellation — holding the task tools the server serves, and nothing that could plan, edit an Issue, rule, approve, or merge. You hand it only a task whose gates already pass; it confirms them again at its own entry gate and operates from there. When a run reveals that the plan itself is wrong — a wrong boundary, a missing detail, a changed approach — the Operator does not edit the Issue: it routes the change back to you as an escalation (`severity: strategy` or `severity: execution`), and you re-plan or redispatch. The single source of truth for this seam — what you may ask the Operator to run, and what it may ask you to re-plan — is `contracts/planner-operator.md`; do not restate that boundary here beyond pointing at it.

---

## Step 0 — creating the tranche itself needs no worktree, no PR, no commit

**Cutting labeled Issues is a forge action, not a repo-file change — there is nothing to commit.** A plan opens a worktree and a pull request **only if this planning act also writes an actual repo file** — most commonly a spec change — because every repo-file change reaches `main` through a worktree branch + PR + green merge, same as a Developer's. If your plan produces no repo-file change at all (the common case — Issues only), skip this section entirely: no worktree, no plan PR, nothing for the git hooks or a merge gate to gate.

When a plan **does** write a repo file — a spec change, most often — open it the same way any doc change does: a worktree off the main branch, commit, pull request:

```
git worktree add .worktrees/plan/<tranche> -b plan/<tranche> origin/main && cd .worktrees/plan/<tranche> && bun install --frozen-lockfile --silent
```

This repo has no local guard on `main`: a direct push to `main` is detected after the fact by the ring-2 `direct-main-push` audit, and a red merge is held by the required review-gate check plus branch protection — detected-and-gated on the forge side rather than refused locally.

---

## Plan-PR close-out — the Planner's own merge has a close-out too

AEG defines **task close-out** (the per-task Archivist) and **tranche close-out** (the Tranche Archivist), but the Planner's own **plan PR** — the one that ships a plan's spec change while the plan *creates* the task Issues — had no defined close-out. That gap was caught live when a plan PR merged with nothing to close it out. A plan PR is not a task PR, so its close-out is adapted:

- **No task Issue to close.** A plan PR *creates* Issues rather than resolving one. If it closes a *planning* Issue or epic, close that.
- **Flag the plan branch + worktree for cleanup.** The `plan/<tranche>` branch and `.worktrees/plan/<tranche>` are not garbage-collected automatically (a recurring cleanup-drift pattern). After merge, flag them for `git worktree remove` + branch delete.
- **Adapted provenance on the merged PR.** Post a short provenance note to the merged plan PR — what the plan shipped (N Issues cut, any decision recorded) — the plan-PR analogue of the Archivist's task provenance block. There is no task ledger row to reconcile; the plan's token report is the Planner's (see "Turn-end" below) — **who records that report into the ledger** for a plan PR, which has no task Issue, is not yet specified (a known open gap; do not invent a mechanism here).

## Turn-end: report your tokens, don't append them

When the planning session closes, report your tokens: `Tokens: planning — Planner — <model> — in/out/cost or — if unknown`, in the plan PR body when one exists; when it doesn't, in a comment on the pinned lessons Issue — the existing forge object, never a new file or forge object of your own (your new-file hard gate forbids that regardless). Planning is normally **self-metering**, the same as the Developer, on any host that exposes the session's own usage to the agent (a transcript it writes, a usage field on its responses, a meter it exposes) — collect the real figures through whatever mechanism your host offers and report them; a blank token cell is not the default outcome. **Operator-metered** — a host that exposes no usage figure to the agent at all — is the fallback case, not the norm: only then does `—` for the numeric cells become the sanctioned outcome (`tranche-model.md` §12), never inconvenience, and you never estimate. Re-planning a wave reports again, never edits the prior report. The ledger is append-only.
