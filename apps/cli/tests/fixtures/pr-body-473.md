<!-- AEG:CLOSES:START -->
Closes #466
<!-- AEG:CLOSES:END -->

**For:** Claude (Sonnet `5`) (coding-agent CLI on a dev machine, dispatched locally, unattended)
<!-- AEG:PROJECT:START -->
**Project:** cli
<!-- AEG:PROJECT:END -->

## Decisions

- Test file name: the brief's Test Plan names `apps/cli/tests/checks/check-dispatch-readiness-premise.test.ts` for this check's coverage, but that file already exists and tests unrelated `check-dispatch-readiness.ts` `PREMISE_FILE` wiring — created `apps/cli/tests/checks/check-pr-premise-reassert.test.ts` instead rather than overwrite/collide with it.
- `packages/aeg-core/bin/open-pr.ts`: the brief's `§4` Modify list and Premise pin named this file, but the Boundary prose's own Out clause and Issue `#466`'s original `## Surface` (`out: packages/**`) both excluded it — left untouched per the repo owner's correction comment on the Issue (the Premise pin on it stays true since the file is unmodified).
- Registering the check requires a companion entry in `packages/aeg-core/src/gate-audience.ts`'s `CLI_CHECK_RING` mirror table (every one of the `29` pre-existing registered checks has one) — outside the brief's original Surface. Escalated on Issue `#466` (`severity:strategy`); the Principal ruled the Issue's Surface itself was wrong and widened it to include `packages/aeg-core/src/**`, then this one additive line was added.
- Two pre-existing hardcoded name-set tests (`registry-env.test.ts`, `repo-root-resolution.test.ts`) and two pre-existing hardcoded enforcement.md row-count tests (`markdown-table.test.ts`, `registry-parse.test.ts`) needed the new check/row added — a mechanical requirement of `turbo test --affected`, not a design choice.
- Check name: `pr-premise-reassert`.
- No `[principal]` Test Plan item: this change has no auth-gated, vendor-key-dependent, or visual/browser surface.
- `verify-docs.ts --pr` currently reports `2` `C7` findings against `enforcement.md` — a repo-internal-path citation and a retired-name citation, both in prose this diff never touches (`enforcement.md` lines `79`–`80`). Confirmed pre-existing: `git show origin/main:aeg-root/enforcement.md` carries byte-identical text at those lines before this branch's first commit, and this task's own `Step 0` `verify-dispatch` baseline already recorded `verify-docs-full` red (`5` findings) prior to any change here. Out of this task's Boundary (`aeg-root/enforcement.md`'s scope here is the one new registry row) to fix a doctrine-prose backlog spanning unrelated sections.

## Test plan

<!-- AEG:TEST-PLAN:START -->
```
bun test apps/cli/tests/checks/premise-reassert-logic.test.ts → `5` pass, `0` fail (regression — `reassertPremiseFile` itself is unchanged)
bun test apps/cli/tests/checks/check-pr-premise-reassert.test.ts → `6` pass, `0` fail (new check's own coverage)
bun apps/cli/src/index.ts check registry-gates → registry-gates: pass
bunx turbo test --affected --concurrency=1 → `1725` pass, `0` fail across `111` files
```
<!-- AEG:TEST-PLAN:END -->

## Premise

<!-- AEG:PREMISE:START -->
**Premise:**
- apps/cli/src/checks/registry.ts contains: name: 'pr-premise-reassert'
- packages/aeg-core/src/gate-audience.ts contains: 'pr-premise-reassert': 0
- aeg-root/enforcement.md contains: PR-body premise reassertion
<!-- AEG:PREMISE:END -->

## Evidence

Run `vinaya pr report --write <this-body-file>` and commit its output — this block is generated, never hand-typed.

<!-- AEG:EVIDENCE:START -->
Head: fd1fef59a407c9f625b711f06ecec01102e83fa0
Summary: `10 files changed, 230 insertions(+), 5 deletions(-)`

### Group A — recomputable

`git diff ce31153ffe16bffafea1b721d510c6af8468bb6a...fd1fef59a407c9f625b711f06ecec01102e83fa0 --numstat`

```
6	0	.changeset/premise-gate-cli-check-ring.md
1	0	aeg-root/enforcement.md
127	0	apps/cli/src/checks/bin/check-pr-premise-reassert.ts
20	0	apps/cli/src/checks/registry.ts
66	0	apps/cli/tests/checks/check-pr-premise-reassert.test.ts
1	0	apps/cli/tests/checks/registry-env.test.ts
1	0	apps/cli/tests/checks/repo-root-resolution.test.ts
2	1	packages/aeg-core/src/gate-audience.ts
3	1	packages/aeg-core/src/markdown-table.test.ts
3	3	packages/aeg-core/src/registry-parse.test.ts
```

### Group B — attested

`vinaya check --all --diff-only`

```
atta-labs/secret-scan: pass
branch-topology: pass
brief-shape: pass
changeset-coverage: pass
closes-n: pass
coherence: pass
dead-branch-push: pass
dispatch-readiness: pass
doc-coverage: pass
doc-coverage-push: pass
doctrine-no-procedures: pass
doctrine-portability: pass
  warning: aeg-root/enforcement.md:160: cites "apps/cli/src/checks/premise-reassert-logic.ts", a path that only exists in the authoring repository — not portable doctrine
  warning: aeg-root/enforcement.md:160: cites "apps/cli/src/checks/bin/check-pr-premise-reassert.ts", a path that only exists in the authoring repository — not portable doctrine
exec-bits: pass
first-push-dispatch: pass
issue-assignment: pass
main-branch-refusal: pass
no-disk-state: pass
pr-premise-reassert: pass
pr-report-density: pass
quoted-command: pass
reader-resolvable-prose: pass
registry-gates: pass
retired-vocabulary: pass
single-plan-pr: pass
surface-scope: pass
test-plan: pass
token-collection-wired: pass
token-report: pass
workspace-escape: pass
```

### Group C — Test Plan commands

#### C1: `bun test apps/cli/tests/checks/premise-reassert-logic.test.ts`

```
[... 171 earlier characters truncated ...]
d content passes with no errors [1.13ms]
(pass) reassertPremiseFile > fail case: a `contains` pin whose literal is no longer present fails, naming the pin [0.02ms]
(pass) reassertPremiseFile > missing-file case: PREMISE_FILE itself could not be read (body is null) fails with one path-naming error [0.09ms]
(pass) reassertPremiseFile > no-pins case: a file with no `Premise:` assertions fails rather than passing vacuously
(pass) reassertPremiseFile > multiple failed pins each produce their own error, all pass:false [0.11ms]

 5 pass
 0 fail
 21 expect() calls
Ran 5 tests across 1 files. [53.00ms]
```

#### C2: `bun test apps/cli/tests/checks/check-pr-premise-reassert.test.ts`

```
[... 210 earlier characters truncated ...]
yPremise > O3: an entirely empty body returns null [1.09ms]
(pass) reassertPrBodyPremise > O1: a `contains` pin that still matches the real tree passes [0.03ms]
(pass) reassertPrBodyPremise > O1: a `contains` pin the PR's own diff falsifies fails, naming the pin [0.25ms]
(pass) reassertPrBodyPremise > a `sha256` pin against a path that does not exist on disk fails, not silently [0.06ms]
(pass) reassertPrBodyPremise > a pin path escaping the containment root (symlink/`..`) is treated as unreadable, never followed [0.13ms]

 6 pass
 0 fail
 19 expect() calls
Ran 6 tests across 1 files. [52.00ms]
```

#### C3: `bun apps/cli/src/index.ts check registry-gates`

```
✓ registry-gates: pass (836ms)
```

#### C4: `bunx turbo test --affected --concurrency=1`

```
[... 8766440 earlier characters truncated ...]
ng it [0.37ms]
@attalabs/vinaya:test: (pass) quickstart realDeps — metering I/O hardening > refuses a FIFO pointer file without hanging [2.58ms]
@attalabs/vinaya:test: (pass) quickstart realDeps — metering I/O hardening > a legitimate pointer and transcript still resolve correctly [0.27ms]
@attalabs/vinaya:test: 
@attalabs/vinaya:test:  1725 pass
@attalabs/vinaya:test:  0 fail
@attalabs/vinaya:test:  4692 expect() calls
@attalabs/vinaya:test: Ran 1725 tests across 111 files. [280.88s]

 Tasks:    8 successful, 8 total
Cached:    8 cached, 8 total
  Time:    181ms >>> FULL TURBO

• turbo 2.10.9
```
<!-- AEG:EVIDENCE:END -->

## Scope

One new `apps/cli` check, `pr-premise-reassert`, that re-asserts a pull request body's `Premise:` pins against the live tree whenever the block is present, reusing the frozen `reassertPremiseFile`/`parsePremiseBlock`/`checkPremises` pin grammar unchanged, wired into `coreCheckRegistry()` and `aeg-root/enforcement.md`'s Ring `1` table. It requires one companion line in `@attalabs/aeg-core`'s `CLI_CHECK_RING` mirror table (`packages/aeg-core/src/gate-audience.ts`) — the one file Issue `#466`'s Surface was widened to allow — but changes no export of `@attalabs/aeg-core`, so no downstream consumer of that package needs re-verification. The check is silent on a body with no `Premise:` block and carries no branch-name condition anywhere, so no adopter's existing pull requests change behavior. Non-goal: `packages/aeg-core/bin/open-pr.ts`'s local `/^task\//` gate-selection step stays untouched, per the Issue owner's ruling that a registered check makes it redundant rather than wrong.

<!-- AEG:TIER:START -->
**Tier:** 1
<!-- AEG:TIER:END -->

## Token report

<!-- AEG:TOKENS:START -->
| Phase | Role | Agent/Model | Tokens in | Tokens out | Cost | Date |
|---|---|---|---|---|---|---|
| 1: develop | Developer | claude-sonnet-5 | 37003590 | 103098 | — | 2026-09-09 |
| 1: develop | Developer | claude-sonnet-5 | 42536783 | 110584 | — | 2026-09-09 |
<!-- AEG:TOKENS:END -->

---

<details>
<summary>Reference copy — dispatched brief (frozen, posted verbatim on Issue #466)</summary>

**For:** [model] (coding-agent CLI on a dev machine, dispatched locally, unattended)
**Reason:** **Suggested agent-class** — small — the pure logic and the pin grammar already exist; this is a bin, a row, a doc row and tests.
**Owner:** the Principal
**Goal:** A Premise block is enforced because it is there, not because of the branch name
**Project:** cli
**Tier:** 1

Closes #466

You are the AEG Developer. Read `aeg-root/roles/developer.md` first. Mandatory.

## Objectives

O1. A pull request body carrying a `Premise:` block has its pins re-asserted against the real tree whenever the block is present, so a pin the pull request's own diff falsifies fails instead of merging as decoration.
O2. The re-assertion is a registered check, so it holds in continuous integration rather than only at the local pull-request-open step, which is the reason this predicate has no backstop today.
O3. The trigger is the block's presence and nothing else, so a body without pins is silent and no branch name decides whether pins are enforced.

## 2. Context — read before doing anything

- **Tranche:** `premise-gate-v1`, task 1, Issue #466. Branch `task/premise-gate-v1/1`. `Depends-on: —`, `Conflicts-with: —`. Confirm `READY TO DISPATCH` at your own Step 0.
- **Read Issue #466 in full** for the complete rationale — do not re-derive it.
- **Boundary** — One new check, wired the way every other check here is wired. In: `apps/cli/src/checks/**`, for the new bin, the pure logic it calls, and the `registry.ts` row that registers it; `apps/cli/tests/checks/**` for its tests; and `aeg-root/enforcement.md`, whose row `registry-gates` cross-checks against the registry — a check registered without one fails G1–G6. Out: `packages/aeg-core/**`, whose `parsePremiseBlock`, `checkPremises` and `checkPremiseCoverage` are consumed unchanged — the pin grammar and its assertion kinds are frozen and this task must not restate them; `gatePlanForBranch`'s `/^task\//` arm in `packages/aeg-core/bin/open-pr.ts`, which stays as it is because a registered check makes the local step redundant rather than wrong; and `checkBriefSections`'s composition, which grades brief sections and is a different seam from re-asserting a pull request body's pins.
- **Traps to avoid** — `reassertPremiseFile` in `apps/cli/src/checks/premise-reassert-logic.ts` already exists and is already pure and unit-tested; it takes a body and a `fileReader` and emits the three failure shapes. Reuse it — this task is a second caller and a registry row, not a second implementation. Read `check-dispatch-readiness.ts`'s wiring of it first and mirror that split between pure logic and a bin that does the I/O. Do NOT re-implement the pin grammar: `parsePremiseBlock` and `checkPremises` are `@attalabs/aeg-core` exports and out of surface for a reason. Do NOT gate the new check on a branch name in any form — that is the entire defect, and a `/^task\//` or `/^fix\//` test anywhere in this change defeats the objective. The check must read the pull request body, not `PREMISE_FILE`: the existing caller re-asserts a file handed to a dispatch, and the gap here is a body that reaches the forge. A registry row without a matching `aeg-root/enforcement.md` row fails `registry-gates` G1–G6 — add both in the same change, and run `vinaya check registry-gates` locally before opening.

## 3. Technical dependencies

**Dependency rationale** — `Depends-on: —`. `Conflicts-with: —`. No open task edits `apps/cli/src/checks/**` or `aeg-root/enforcement.md`; `plan-brief-v1 9` and `11` are in flight on `apps/cli/src/lib/**`, `apps/cli/src/commands/**` and `packages/aeg-core/src/**`, none of which this task touches.

## 4. Technical surface map

**Create:**
- (none — every surface file already exists)

**Modify:**
- aeg-root/enforcement.md
- apps/cli/src/checks/registry.ts
- packages/aeg-core/bin/open-pr.ts

- consumer-tests: none — no consumer test path named yet for @attalabs/aeg-core (apps/cli), @attalabs/aeg-core (packages/sources); name one before dispatch, or confirm no consumer-facing behavior changed.

**Out of surface:** packages/**, apps/cli/src/commands/**, apps/cli/src/lib/**, .claude/**

#### Premise pins

**Premise:**
- aeg-root/enforcement.md sha256: 44103a98991b1097deeba0c13b49058c71b7596e170ef4b5a8c6d315eea1aebd
- apps/cli/src/checks/registry.ts sha256: 96c6c71aa1cc4308e54cc0c139447aac07f2c9e94f730d407ef263f73bbf8ea0
- packages/aeg-core/bin/open-pr.ts sha256: 34ec0b9344ad533875d86dbc3e62c44b4be105780f5b26154e9cfbdbb4da7dcb

## 5. Pre-flight checks

**Step 0 (mandatory, verbatim):**

```
git worktree add .worktrees/task/premise-gate-v1/1 -b task/premise-gate-v1/1 --no-track origin/main && cd .worktrees/task/premise-gate-v1/1 && git config push.autoSetupRemote true && bun install --frozen-lockfile --silent
```

1. Clean status; parent `origin/main`; branch suffix literal-matches the task id.
2. `bun packages/aeg-core/bin/verify-dispatch.ts <tranche> <n>` → `READY TO DISPATCH` (re-derived at render time: it was).

On any failure: STOP and report.

## 6. Numbered parts — commit after EACH part; push once, before opening the PR

1. **Part 1 (O1, O3):** A body's pins are re-asserted when the block is there, and nothing happens when it is not.

   Files (touches @attalabs/vinaya):
   - apps/cli/src/checks/registry.ts

   The pre-push hook runs the affected suite on your one push and refuses it on failure — do not run it yourself per Part.
2. **Part 2 (O2):** The re-assertion is registered and declared, so continuous integration runs it.

   Files (touches @attalabs/aeg-core):
   - packages/aeg-core/bin/open-pr.ts

   Files (touches the repo root):
   - aeg-root/enforcement.md

   The pre-push hook runs the affected suite on your one push and refuses it on failure — do not run it yourself per Part.

## 7. Documentation-update list

`.vinaya/doc-owners` derivation matched zero bindings against this task's surface — no mechanically-derived doc updates. Confirm no additional doc artifact applies before treating this list as final.

## 8. Verification before claiming done

- The pre-push hook already ran the affected suite on your one push and refused it on failure — do not additionally run it yourself; `vinaya pr report --write`/`--push` separately re-runs it with `--force` to attest the command and its output in the Evidence block.
- The full `bun run test` suite is CI's to run, on the one push — never run it locally.
- Every blast-radius consumer named in §4, re-verified by name.
- `roles/developer.md`'s tier checklist genuinely satisfied, and `PR_BODY="$(cat <body-file>)" bun packages/aeg-core/bin/verify-docs.ts --pr` green.

## 9. Test Plan

```
bun test apps/cli/tests/checks/premise-reassert-logic.test.ts
bun test apps/cli/tests/checks/check-dispatch-readiness-premise.test.ts
bun apps/cli/src/index.ts check registry-gates
bunx turbo test --affected --concurrency=1
```

## 10. Stop conditions

- Re-asserting on every branch would fail pull requests already open on the forge — stop and report which; a cutover by number is the Principal's call, never a fail-open check.
- The pull request body cannot be read at the point the check runs — stop and report; never pass silently on unreadable input.
- Closing this would require changing the pin grammar in `packages/aeg-core` — stop; that is frozen and out of surface.
- Your own dig contradicts this task's boundary or sizing — escalate `severity:strategy`, do not silently re-scope.

**Stop-and-escalate** — If re-asserting on every branch would fail pull requests already open on the forge, stop and report which ones rather than making the check fail-open; whether to cut over by number is the Principal's call, the same call `BRIEF_SECTIONS_SINCE_ISSUE` already is. If the pull request body is unavailable to a check at the point this one runs, stop and report — a check that silently passes when it cannot read its input is the fail-open shape this repo has had to close twice.

## 11. Constraints

> **Autonomy:** Do not stop to ask clarifying questions. For any ambiguity not covered by a Section 10 stop condition, choose the most reasonable option consistent with this brief, record the choice in the PR body at open, or in a PR comment after open, and continue. Halt only for the explicit Section 10 stop conditions — and when you halt, record the blocker in a PR comment or an Issue comment rather than waiting interactively for input.

## 12. Deliverable

- PR title (exact): `[premise-gate-v1] 1 — A Premise block is enforced because it is there, not because of the branch name`
- Open the PR only via `bun apps/cli/src/index.ts pr create --body-file <path> --title "<title above>"`.
- PR body = the Developer's PR report (start from `aeg-root/templates/pr-report-template.md`), with this entire brief pasted as the reference copy inside a collapsed `<details>` block, and `Closes #466` at the top of the header block.
- Pre-open gate: tier checklist satisfied, and `PR_BODY="$(cat <body-file>)" bun packages/aeg-core/bin/verify-docs.ts --pr` green.
- Include `git diff main --stat` and a token report (if unavailable, state so).
- Then STOP. Review and Verification are separate invocations.

</details>
