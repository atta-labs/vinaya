---
sidebar_title: "Template: Task brief"
---
# Template — Task brief (the 12-section shape)

**This file is the render's shape reference, not a hand-fill-in-the-blanks template any more.** The brief is no longer hand-authored: the Planner's dispatch act runs `vinaya task dispatch`, which mechanically renders every section below from the task Issue's own rationale and judgment sections (see `aeg-root/roles/planner.md` § The dispatch act and § The Planner's rationale) and posts the result, frozen, as the Issue's `aeg:brief:v1` comment. This file exists so a reader can see the 12-section shape the render fills — the required sections, their order, and the fields the gates read — without reverse-engineering it from the renderer's source. The brief is **never committed as a repo file** on its own; it is posted as the Issue comment, and a reference copy rides along inside a collapsed `<details>` block in the Developer's PR report when the Developer opens the PR.

The brief itself carries no anchor comments: it rides into the PR body as the *reference copy*, and the anchored gate-read fields live in the Developer's PR report (`aeg-root/templates/pr-report-template.md`) — anchoring the same fields twice in one body would recreate the very ambiguity anchors exist to remove.

---

**For:** [model + environment, e.g. "your-model (coding-agent CLI on a dev machine, dispatched locally, unattended)"]
**Reason:** [why this capability level fits this task — real reasoning against the task, not "because it's good"]
**Owner:** [who owns the task — the Principal, by default]
**Goal:** [one sentence: what ships]
**Project:** [project(s), comma-separated, resolving against `.vinaya/projects.md` — required in a multi-project repo]
**Tier:** [0 | 1 | 3 — declare last, after §4 is complete]

You are the AEG Developer. Read `aeg-root/roles/developer.md` first[, then the host repo's own execution-discipline skill, e.g. `.claude/skills/executor-protocol/SKILL.md`]. Both mandatory.

## Objectives

[Copy the Issue's `## Objectives` section here byte-for-byte — `checkObjectivesCopy` refuses a brief whose section does not match the Issue's, compared normalised (whitespace never fails it; a changed word does). Every numbered Part in §6 must cite at least one `O<n>` from this list, and every `O<n>` here must be cited by at least one Part — `checkObjectivesCoverage` refuses either gap.]

## Documentation

[Copied verbatim from the Issue's own `## Documentation` section — every normative source this task depends on (a doc URL, an in-repo spec), each against the mechanism it governs: `- <source> — <mechanism>`. A task with no externally-normative source states the explicit `None` sentinel instead of an empty section. Placed immediately after Objectives, before the Developer holds a complete plan, so it is read first rather than skimmed as appendix evidence after the fact (Issue #625). Every source named here must be read before Step 0 — `aeg-root/roles/developer.md`'s entry gate names the obligation; a `PostToolUse`/`Stop` hook pair enforces it mechanically, not the Developer's own judgement.]

## 2. Context — read before doing anything

- **Tranche:** [`tranche-slug`], task [n], Issue #[N]. Branch `task/[tranche-slug]/[n]`. `Depends-on: [—|ids]`, `Conflicts-with: [—|ids]`. Confirm `READY TO DISPATCH` at your own Step 0.
- **Read Issue #[N] in full** for the complete rationale — do not re-derive it.
- [CONTEXT — the Planner's rationale carried forward (boundary, blast radius, traps), what was previously validated, what is settled and must not be re-litigated, and everything your own Dig confirmed about the current surface. If it isn't in the brief, it doesn't exist. No behavioural fact about code belongs here as prose — a `Premise:` pin or a fenced command with its executed output is the only form (skill §2's rule).]

## 3. Technical dependencies

[DEPENDENCIES — every technical precondition by name: shared exports/APIs that must already exist, schema/migration preconditions, capability preconditions, external services/credentials. "None new." is a valid value.]

## 4. Technical surface map

**Create:**
- [exact file paths to create]

**Modify:**
- [exact file paths to modify, with what changes in each]

<!-- AEG:CLAIM: packages/aeg-core/src/brief-render.ts contains:'**Out of surface:** ' + -->
**Out of surface:** [adjacent files/dirs the executor must NOT touch, named explicitly — `vinaya brief render` fills this verbatim from the Issue's `## Surface` `out:` list, never a hand-authored placeholder]

#### Premise pins

**Premise:**
- [path/inside/the/surface.ts] contains: [literal substring the brief's reasoning depends on]
- [another/surface/path.ts] absent: [literal substring pinned absent]

## 5. Pre-flight checks

**Step 0 (mandatory, verbatim):**

```
git worktree add .worktrees/task/[tranche-slug]/[n] -b task/[tranche-slug]/[n] --no-track origin/main && cd .worktrees/task/[tranche-slug]/[n] && git config push.autoSetupRemote true && bun install --frozen-lockfile --silent
```

1. Clean status; parent `origin/main`; branch suffix literal-matches topology `#` column (`[n]`).
2. `vinaya check dispatch-readiness` → `READY TO DISPATCH`/pass required; else STOP. (Known gap: its prior-tranche-archival predicate always reports empty — confirm that fact yourself regardless. On this repo's toolchain, the unabridged derivation is `bun packages/aeg-core/bin/verify-dispatch.ts [tranche-slug] [n]`.)
3. [any task-specific pre-flight checks — required tools present, reference files readable, re-digs to confirm the §2 citations]

On any failure: STOP and report.

## 6. Numbered parts — commit after EACH part; push once, before opening the PR

<!-- AEG:CLAIM: packages/aeg-core/src/brief-render.ts contains:function renderPartCitation(part: IssuePart): string { -->
[Rendered from the Issue's `## Parts` section — `vinaya brief render` fills one numbered Part per `Part <k> (O<n>[, O<m>]) — <outcome>` line, citation reconstructed verbatim, files grouped by package as today. Hand-authoring the same: exact files + exact function/type signatures + constraints — not prose. A Part that depends on a fact about current code opens with the fenced command that establishes it, followed by the executed output (skill §2's rule). Cite at least one `O<n>` from the Objectives section above; an administrative Part with no objective of its own (a changeset commit, the final push) may omit the citation.]

1. **Part 1** (O[n]) — [exact files + exact function/type signatures + constraints — not prose.]
2. **Part 2** (O[n]) — [next bounded unit of work]

## 7. Documentation-update list

[DOC LIST — every doc artifact this brief must touch, by file name — or "No doc updates required (Tier 0)." A Tier 1+ brief with an empty list is malformed. Never list a new file for a one-off report/finding.]

## 8. Verification before claiming done

<!-- AEG:CLAIM: apps/cli/src/lib/artifacts.ts contains:bunx turbo test --affected --concurrency=1 || exit 1 -->

- [the repo's static gates, by command, and nothing else — this repo: `bun run typecheck`, `bun run format-and-lint`, and the production build. Do NOT ask for a test-suite run per Part: the managed `pre-push` hook runs `bunx turbo test --affected` itself, once, on the one push, and refuses the push when it fails. A brief that also asks for it per Part buys nothing and pays the suite's full wall-clock on every Part.]
- [every blast-radius consumer named in §4 re-verified, by name]
- `roles/developer.md`'s tier checklist genuinely satisfied, and `PR_BODY="$(cat <body-file>)" vinaya check doc-coverage` green. (On this repo's toolchain, `PR_BODY="$(cat <body-file>)" bun packages/aeg-core/bin/verify-docs.ts --pr` runs both as one command.)

## 9. Test Plan

<!-- AEG:CLAIM: packages/aeg-core/src/brief-render.ts contains:...facts.testPlan.lines, -->
[Rendered from the Issue's `## Test plan` section — `vinaya brief render` copies it verbatim, never re-deriving one from the surface file list.]

- [ ] **[agent]** [scriptable, non-auth check — the exact command + the concrete observable; evidence pasted, not paraphrased]
- [ ] **[principal]** [auth-gated / vendor-key / visual check — what the Principal does and what they should observe]

[Pure-logic tasks with no runtime surface in §4 declare the `unit-tests-only` sentinel on the Test Plan field instead of a checklist — one form or the other, never both.]

## 10. Stop conditions

<!-- AEG:CLAIM: packages/aeg-core/src/brief-render.ts contains:`${facts.rationale.stopAndEscalate}` -->
[Rendered from the Issue's `## Stop conditions` bullets, plus the Stop-and-escalate rationale field verbatim — never the field alone.]

STOP and report if: pre-flight fails; [the Planner's stop-and-escalate conditions, substance-verbatim]; [task-specific stop conditions]; about to touch files outside the §4 surface; any destructive action not explicitly authorized.

## 11. Constraints

- [each Planner trap as an explicit "do NOT do X; do Y instead"]
- [forbidden patterns for this task — deferred features, off-limits paths]
- Never write status anywhere; never add execution metadata to the tranche file.

> **Autonomy:** Do not stop to ask clarifying questions. For any ambiguity not covered by a Section 10 stop condition, choose the most reasonable option consistent with this brief, record the choice in the PR body at open, or in a PR comment after open, and continue. Halt only for the explicit Section 10 stop conditions — and when you halt, record the blocker in a PR comment or an Issue comment rather than waiting interactively for input.

## 12. Deliverable

- PR title (exact): `[[tranche-slug]] [n] — [task title]`
- Open the PR only via `vinaya pr create --body-file <path> --title "<title above>"`.
- PR body = the Developer's PR report (start from `aeg-root/templates/pr-report-template.md`), with this entire brief pasted as the reference copy inside a collapsed `<details>` block, and `Closes #[N]` at the top of the header block.
- [what to state in the PR body: decisions made, confirmations required by §8]
- Pre-open gate: tier checklist satisfied, and `PR_BODY="$(cat <body-file>)" vinaya check doc-coverage` green (on this repo's toolchain, `PR_BODY="$(cat <body-file>)" bun packages/aeg-core/bin/verify-docs.ts --pr` runs both).
- Include `git diff main --stat` and a token report (if unavailable, state so).
- Then STOP. Review and Verification are separate invocations.
