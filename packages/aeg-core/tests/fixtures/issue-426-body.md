[plan-brief-v1] 1 — The Issue carries every judgment section of the brief; brief render refuses on a gap

**Tier:** 1
**Project:** aeg-core, cli, sources
**Type:** feat

## Objectives

O1. A task Issue body validated by `vinaya issue create` or `edit` carries four more sections under the rationale, Surface, Parts, Test plan and Stop conditions, each parsed by one function in @attalabs/aeg-core, and a task Issue at or above the cutover number is refused when any of them is missing or malformed.
O2. `vinaya brief render <tranche> <n>` fills every section of the brief from the Issue and the tree and refuses, naming the section, instead of printing any placeholder such as "named explicitly by the Brief Author".
O3. `verify-brief` and `brief-shape` pass a brief that is byte-identical to the render's output, so a rendered brief needs no hand edit to be dispatchable.

## Planner's rationale

**Boundary** — Four new parsers and one gate in `issue-validation.ts` behind a new cutover constant, the render filling §4/§6/§9/§10/§11 from the parsed sections instead of a hand-authored placeholder. Out: posting the brief anywhere (a later task), the Brief Author role/contract/skill (later tasks), the Objectives grammar, the PR body template.

**Sizing** — Passes the four tests: one verification story (a rendered brief passes `verify-brief` unedited); one agent can hold it (four small parsers on one grammar shape the repo already validates); a bounded file surface (`issue-validation.ts`, `brief-render.ts`, their tests, the gate wiring); a single failure mode (a malformed or missing section is refused, named).

**Project(s) + blast radius** — `Project: aeg-core, cli, sources`. `aeg-core` carries the parsers and the renderer; `cli` wires the gate and the render command; `sources` re-exports the function index. No shared-primitive fan-out beyond these three.

**Dependency rationale** — `Depends-on: —`; `Conflicts-with: #412, #413, #404` (all three merged by dispatch time). Nothing this task needs is still in flight.

**Traps to avoid** — Do NOT let a Parts line or a Surface entry name a file path; globs are directory-level, Parts name outcomes and symbols. Do NOT relax `checkNoBriefContent` beyond the four headings. Do NOT invent a citation grammar; `PART_CITATION_RE` is the one shape. Do NOT gate an Issue below 426; null fails closed. Do NOT write a second test-plan parser; reuse `checkTestPlan`/`extractFencedBlocks`. Do NOT leave any bracketed placeholder in render output.

**Suggested agent-class** — mid — four small parsers on a grammar shape the repo already validates, one render change with a mechanical proof.

**Stop-and-escalate** — If a judgment section cannot be expressed as data on the Issue without prose the gates cannot check, STOP and report the section rather than accepting free text; severity: strategy.

**Docs to keep coherent** — `apps/cli/specs/surface.md`, `aeg-root/roles/planner.md`, `aeg-root/contracts/planner-brief.md`, `aeg-root/templates/brief-template.md`.

## Surface

in: packages/aeg-core/src, apps/cli/src/commands, apps/cli/src/lib
out: aeg-root/skills/brief-authoring

## Parts

Part 1 (O1) — the template and the four parsers, gated by the new cutover constant.
Part 2 (O1) — the gate wiring: the builtin table entry and the config entry.
Part 3 (O2, O3) — the render fills §4/§6/§9/§10 from the parsed sections and refuses on a gap.
Part 4 (O2, O3) — docs and the surface index rows.

## Test plan

```
bun test packages/aeg-core/src/issue-validation.test.ts packages/aeg-core/src/brief-render.test.ts → 0 fail
bun apps/cli/src/index.ts brief render plan-brief-v1 1 --surfaces 'packages/aeg-core/src/issue-validation.ts' → exits 0, no bracketed placeholder in the output
```

## Stop conditions

- Pre-flight checks fail, or any premise pin fails to re-assert.
- Narrowing `checkNoBriefContent` lets any currently-refused fixture in `packages/aeg-core/tests/fixtures/` pass.
- A judgment section cannot be expressed as data on the Issue without prose the gates cannot check.
- The surface-index test needs an Exemptions change that adds a lib call the Principal has not ruled on.

## Origin

Principal-directed (2026-09-06): `roles/developer.md`'s own Verification-phase incident record (four consecutive features merged green and broke at runtime) is the same class of gap a hand-edited brief invites — a brief section a human typed and nobody re-derived. This task closes it for the four sections a brief cannot mechanically fill today.
