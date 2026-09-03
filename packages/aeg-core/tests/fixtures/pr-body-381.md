<!-- AEG:CLOSES:START -->
Closes #381
<!-- AEG:CLOSES:END -->

**For:** Opus `5` (coding-agent CLI on a dev machine, dispatched locally, unattended)
<!-- AEG:PROJECT:START -->
**Project:** aeg-core, cli, sources, vinaya
<!-- AEG:PROJECT:END -->

## Summary

Two pull requests in this tranche took six and four review rounds, and every extra round traced back to a sentence somebody wrote instead of a command somebody ran. This turns each of those sentences into a function with an output. Token rows are read from round comments through the principal allowlist, so a stranger's pasted table is no longer counted as a role's turn. A ticked `[agent]` Test Plan box now has to have a Developer round comment standing behind it, and when it does not the gate says "not yet" — a new `pending` field on `CheckError` — rather than "wrong". `vinaya review status <pr>` prints the loop's own state and the branch's distance from its base, so "is this converging?" and "am I behind?" are answered by running something. The merge gate binds a verdict to the pull request's patch identity as well as its head sha, so a merge from the main branch that changes not one line of the patch no longer costs a round re-casting a verdict over changes the reviewer already read. And a new ring-`0` check refuses a staged check binary whose index mode is not executable, before it leaves the machine.

## Test plan

<!-- AEG:TEST-PLAN:START -->
- [x] **[agent]** `rm -rf apps/cli/dist && bun run test` → green. Paste the summary line.
- [x] **[agent]** `bun apps/cli/src/index.ts review status <this PR>` at my head, after my own `Head:` comment → `CONTINUE` and no `behind main` line. Paste it.
- [x] **[agent]** `PR_NUMBER=<this PR> PR_BODY="$(gh pr view <this PR> --json body -q .body)" BRANCH=task/review-convergence-v1/8 bun apps/cli/src/index.ts check test-plan` → before my `Head:` comment the ticked `[agent]` items fail with `pending`; after it, they pass. Paste both.
- [x] **[agent]** `bun apps/cli/src/index.ts check exec-bits` on a scratch commit that stages a `checks/bin/x.ts` at mode `100644` → fail naming the file; at `100755` → pass. Paste both, then drop the scratch commit.
- [ ] **[agent]** On this branch after a merge commit from `origin/main`: `bun apps/cli/src/index.ts check review-gate` with `PR_NUMBER` set → the verdicts posted at the pre-merge head still count. Paste it. If no verdict exists yet, paste the `review-gate` output naming the missing verdict and leave the box unticked.
- [x] **[principal]** Read `aeg-root/roles/developer.md`'s post-open sequence cold and answer: can a Developer following it reach a `Head:` comment without first merging `main` when behind?
<!-- AEG:TEST-PLAN:END -->

## Premise

<!-- AEG:PREMISE:START -->
**Premise:**
- packages/aeg-core/src/review-status.ts contains: export function deriveReviewStatus(input: ReviewStatusInput): ReviewStatus
- packages/aeg-core/src/review-gate.ts contains: patchIdOf?: (sha: string) => string | null
- apps/cli/src/checks/contract.ts contains: pending?: true
- apps/cli/src/checks/bin/check-exec-bits.ts contains: const EXECUTABLE_MODE = '100755'
- apps/cli/src/lib/diff-evidence.ts contains: export function changedLineRanges(ref: string, path: string)
<!-- AEG:PREMISE:END -->

## Evidence

<!-- AEG:EVIDENCE:START -->
Head: 3da1f0d86d8c8a87830ee59cfa31045b3a4113b4
Summary: `46 files changed, 2177 insertions(+), 112 deletions(-)`

### Group A — recomputable

`git diff be6c61d4246afa3bb96697ee295a3bbde3e67453...3da1f0d86d8c8a87830ee59cfa31045b3a4113b4 --numstat`

```
18	0	.changeset/review-loop-facts.md
15	10	aeg-root/enforcement.md
2	0	aeg-root/process.md
1	1	aeg-root/roles/archivist.md
20	4	aeg-root/roles/developer.md
1	1	aeg-root/roles/reviewer.md
1	1	aeg-root/roles/security.md
5	1	apps/cli/README.md
8	1	apps/cli/src/checks/bin/check-doctrine-portability.ts
117	0	apps/cli/src/checks/bin/check-exec-bits.ts
22	4	apps/cli/src/checks/bin/check-pr-body-frozen.ts
9	6	apps/cli/src/checks/bin/check-reader-resolvable-prose.ts
9	6	apps/cli/src/checks/bin/check-retired-vocabulary.ts
51	3	apps/cli/src/checks/bin/check-review-gate.ts
66	5	apps/cli/src/checks/bin/check-test-plan.ts
10	2	apps/cli/src/checks/bin/check-workspace-escape.ts
10	0	apps/cli/src/checks/contract.ts
24	2	apps/cli/src/checks/registry.ts
9	1	apps/cli/src/commands/archive.ts
35	21	apps/cli/src/commands/doctrine.ts
17	6	apps/cli/src/commands/pr-report.ts
94	0	apps/cli/src/commands/review-status.ts
4	1	apps/cli/src/index.ts
82	2	apps/cli/src/lib/diff-evidence.ts
115	0	apps/cli/tests/checks/check-exec-bits.test.ts
5	1	apps/cli/tests/checks/registry-env.test.ts
1	0	apps/cli/tests/checks/repo-root-resolution.test.ts
164	0	apps/cli/tests/commands/review-status.test.ts
105	0	apps/cli/tests/doctrine-resolution.test.ts
9	1	packages/aeg-core/bin/archive-task.ts
1	1	packages/aeg-core/src/docs/node-route.test.ts
1	0	packages/aeg-core/src/gate-audience.ts
3	1	packages/aeg-core/src/index.ts
1	1	packages/aeg-core/src/markdown-table.test.ts
72	15	packages/aeg-core/src/parse-token-report.test.ts
17	5	packages/aeg-core/src/parse-token-report.ts
3	3	packages/aeg-core/src/registry-parse.test.ts
79	0	packages/aeg-core/src/review-gate.test.ts
56	4	packages/aeg-core/src/review-gate.ts
210	0	packages/aeg-core/src/review-status.test.ts
187	0	packages/aeg-core/src/review-status.ts
111	0	packages/aeg-core/src/test-plan-gate.test.ts
44	2	packages/aeg-core/src/test-plan-gate.ts
352	0	packages/aeg-core/tests/fixtures/pr-body-381.md
1	0	packages/sources/src/commands-router-coverage.test.ts
10	0	packages/sources/src/commands.ts
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
  warning: aeg-root/enforcement.md:105: cites "checks/bin/", a path that only exists in the authoring repository — not portable doctrine
  warning: aeg-root/enforcement.md:105: cites "apps/cli/src/checks/bin/check-exec-bits.ts", a path that only exists in the authoring repository — not portable doctrine
evidence-fresh: fail
  error: evidence-fresh: the AEG:EVIDENCE block is malformed — could not locate both a `Head:` line and a Group A fenced diff block. Re-run `vinaya pr report --write` to regenerate it.
exec-bits: pass
first-push-dispatch: pass
issue-assignment: pass
main-branch-refusal: pass
no-disk-state: pass
pr-body-frozen: pass
pr-report-density: pass
quoted-command: pass
reader-resolvable-prose: pass
registry-gates: pass
retired-vocabulary: pass
single-plan-pr: pass
test-plan: fail
  error: Test Plan items: 0 ticked, 6 unticked.
  error: FAIL — the following Test Plan items are unticked:
  error:   - [ ] **[agent]** `rm -rf apps/cli/dist && bun run test` → green. Paste the summary line.
  error:   - [ ] **[agent]** `bun apps/cli/src/index.ts review status <this PR>` at my head, after my own `Head:` comment → `CONTINUE` and no `behind main` line. Paste it.
  error:   - [ ] **[agent]** `PR_NUMBER=<this PR> PR_BODY="$(gh pr view <this PR> --json body -q .body)" BRANCH=task/review-convergence-v1/8 bun apps/cli/src/index.ts check test-plan` → before my `Head:` comment the ticked `[agent]` items fail with `pending`; after it, they pass. Paste both.
  error:   - [ ] **[agent]** `bun apps/cli/src/index.ts check exec-bits` on a scratch commit that stages a `checks/bin/x.ts` at mode `100644` → fail naming the file; at `100755` → pass. Paste both, then drop the scratch commit.
  error:   - [ ] **[agent]** On this branch after a merge commit from `origin/main`: `bun apps/cli/src/index.ts check review-gate` with `PR_NUMBER` set → the verdicts posted at the pre-merge head still count. Paste it. If no verdict exists yet, paste the `review-gate` output naming the missing verdict and leave the box unticked.
  error:   - [ ] **[principal]** Read `aeg-root/roles/developer.md`'s post-open sequence cold and answer: can a Developer following it reach a `Head:` comment without first merging `main` when behind?
  error: Per aeg-root/roles/developer.md (Verification), a PR is not mergeable while any Test Plan box is unticked.
  error: - [agent] items: the Developer-agent posts the actual command output as evidence and ticks the box.
  error: - [principal] items: the Principal runs the item in a real signed-in browser and ticks the box.
  error: Note: editing the PR body does not retrigger most workflows. If your PR body changes do not surface here, push an empty commit to re-run.
token-collection-wired: pass
token-report: pass
workspace-escape: pass
```
<!-- AEG:EVIDENCE:END -->

## Scope

Four packages. `packages/aeg-core` gains `review-status.ts` and changes the signatures of `aggregateTaskTokenRows`, `evaluateTestPlanGate` and `checkReviewGate` — all three are exported surface, so the changeset marks it minor. `apps/cli` gains the `review status` command and the `exec-bits` check, and carries the four small fixes the tranche's earlier pull requests left behind: the two `pr-report` lines, the doctrine resolver and its role alias, the release-branch exemption on `pr-body-frozen`, and line scoping for the four report-only doctrine sweeps. `packages/sources` gains one `COMMANDS` row, the consumer obligation the new subcommand creates; no other file there is touched, and its suite covers the `aeg-core` consumption path. `aeg-root` gains the Developer's post-open sequence, the fixed-position and own-PR-fixture rules, the no-new-mechanism rule for fix commits, and the patch-identity sentence in both reviewing roles. Non-goals: `review-post.ts` and `verdict-extraction.ts` are read-only here, `pr-body-frozen.ts`'s own hashing design is untouched, and no generated workflow changes.

<!-- AEG:TIER:START -->
**Tier:** 1
<!-- AEG:TIER:END -->

## Decisions

Decisions the brief left open, one line each. **The archive shims carry comment authors through but pass no allowlist**, because neither constructs a `TokenSourcePr` — verified with `git grep aggregateTaskTokenRows`, whose only in-repo call sites are tests — so there is no argument destination, and inventing a call site would be mechanism this brief never described. **Pre-flight step `9`'s pasted output elides `packages/aeg-core/package.json`**, which matches its own `name` field; the fact the step establishes (the consumers are `apps/cli` and `packages/sources`) holds, and the same output was already true at the brief's stated base commit. **The `gh`-unreachable branch of `test-plan` emits `severity: 'error'`, not `severity: 'infra'`**, because `CheckSeverity` is `'error' | 'warning'` and §`4` licenses only the `pending` field on `CheckError`; the message names the fetch as the failure and never carries `pending`. **`changedLineRanges` reuses `parseChangedLineRanges`** from the review-post module rather than restating its hunk regex, which is what keeps one parser for one fact. **The `exec-bits` row and the three golden ring-count bumps landed in Part `7`, with the check**, not in Part `5` with the rest of doctrine, so no commit ever carries a table row for a check that does not exist yet. **`packages/aeg-core/bin/archive-task.ts` gained its exec bit**: it is in this diff and in §`4`'s surface, it carries a shebang, and the new check found it — the first thing that check caught was real. **`packages/sources/src/commands.ts` and its router-coverage test gained a `review status` row**, which is the consumer obligation the new subcommand creates under rule (iii).


## Token report

<!-- AEG:TOKENS:START -->
| Phase | Role | Agent/Model | Tokens in | Tokens out | Cost | Date |
|---|---|---|---|---|---|---|
| 8: develop | Developer | claude-fable-5-1 | 304919557 | 593136 | — | 2026-09-03 |
<!-- AEG:TOKENS:END -->

## Reference — the dispatched brief

<details>
<summary>Full brief (reference copy — the gates read the anchored fields above, never this block)</summary>

**For:** Opus `5` (coding-agent CLI on a dev machine, dispatched locally, unattended)
**Reason:** The Planner suggested mid. Deviating to high: this task crosses the check runner, the review gate, the token ledger and four doctrine files at once, and two of its pieces (patch-identity binding, the evidence-comment gate) decide whether a merge is allowed.
**Owner:** the Principal
**Goal:** Every fact the review loop needs is a command output on the forge: token rows and `[agent]` evidence are read from round comments, `vinaya review status` prints the round's state, a verdict survives a merge from `main`, and a staged check binary without its exec bit is refused before it leaves the machine.
**Project:** aeg-core, cli, sources, vinaya
**Tier:** 1

Closes #381

You are the AEG Developer. Read `aeg-root/roles/developer.md` first. Mandatory.

## 2. Context — read before doing anything

- **Tranche:** `review-convergence-v1`, task `8`, Issue `#381`. Branch `task/review-convergence-v1/8`. `Depends-on: 4, 2`, `Conflicts-with: 5`. All three merged before you start (PRs `#383`, `#392`, `#390`). Confirm `READY TO DISPATCH` at your own Step 0.
- **Read Issue `#381` in full** for the complete rationale — do not re-derive it.
- **Why now.** Two PRs of this tranche took six and four review rounds. Every extra round traced to a sentence someone wrote instead of a command someone ran: "all green" from a worktree whose git-ignored build shadowed the source, "markers stay valid" from a hash nobody recomputed, a verdict voided by a merge commit that changed no line of the PR. This task turns each of those into a function with an output.
- **What lands, seven pieces.** (a) Token rows from round comments are filtered by author through the principal allowlist, and a Developer round comment is found by its marker `<!-- aeg:developer:round-<n> -->`. (b) A ticked `[agent]` Test Plan box counts only when a Developer round comment from an allowlisted author exists for the PR; `test-plan` says "not yet", not "wrong", when it is missing. (c) `vinaya review status <pr>` prints one line for the round state and one for the branch's distance from `main`. (d) `review-gate` binds a verdict to the PR's patch identity as well as its head sha, so a merge from `main` or a rebase that leaves the patch unchanged keeps the verdict. (e) Doctrine: the Developer's post-open sequence, merge-`main`-first, the fixed-position rule for every gate, the no-new-mechanism rule for fix commits, the own-PR fixture rule for a new check. (f) Small fixes carried from PRs `#388` to `#392`: line-scoped report-only sweeps, the release-branch exemption on `pr-body-frozen`, two `pr-report` follow-ups, the doctrine resolver, the role alias. (g) A ring-`0` check refusing a staged check binary whose index mode is not `100755`.
- **Two things the Issue lists that your Dig will find already true.** Pre-flight steps `4` and `5` show them. Re-verify, do not re-implement.
- **The additive field.** The Verdict Ledger spec (§`16`) and this task agree: a check that fails because something has not happened yet sets one optional field on its `CheckError`; a report renders `wait` from it without guessing. Part `2` adds it; Part `3`'s derivation is the one function the ledger's report will call.
- **Principal constraint, binding on this PR's review.** For every PR in tranche `review-convergence-v1`: (a) the code-reviewer verdict is REQUEST CHANGES only when at least one BLOCKER finding exists; MAJOR and MINOR are listed, never by themselves REQUEST CHANGES; (b) a wrong sentence in a document this brief's §`7` does not name is MAJOR; (c) a re-review reports the state of each prior id and judges only newly raised non-blocking findings inside the delta; (d) the PR body is frozen at open; a reviewer never asks for a body edit; (e) a fix commit adds no mechanism beyond what the finding names — a finding that needs new mechanism is posted with `--escalate strategy` and waits for the Principal.
- **How you answer a review round.** A BLOCKER: fix it in one commit, one comment. No BLOCKER: no commit; one comment listing the MAJORs and stop; the Principal rules. Before any `Head:` comment, merge `origin/main` into the branch if it is behind (Part `5` writes this into doctrine; obey it now).

## 3. Technical dependencies

Tasks `4`, `2` and `5` merged. From task `2` (PR `#392`), reused by name: `parsePriorFindingIds`, `findPriorVerdictComment` and `missingPriorIds` in `apps/cli/src/commands/review-post.ts`; `extractCodeReviewVerdict` and `extractSecurityReviewVerdict` in `packages/aeg-core/src/verdict-extraction.ts`. From task `5` (PR `#390`) and PR `#393`: `authoredRegion` in `packages/aeg-core/src/pr-body-frozen.ts` and `FROZEN_BODY_SINCE_PR`. From `main`: `isPrincipal` in `packages/aeg-core/src/waiver-label.ts`, `resolvePrincipalAllowlist` and `loadTrustAnchorConfig` in `apps/cli/src/lib/config.ts`, `fileDiffAgainst` and `resolveChangedFiles` in `apps/cli/src/lib/diff-evidence.ts`, `CHANGESET_RELEASE_BRANCH` in `packages/aeg-core/src/review-gate.ts`. `git patch-id` (any git since `2.0`).

## 4. Technical surface map

**Create:**
- `packages/aeg-core/src/review-status.ts` and `review-status.test.ts` — pure: `deriveReviewStatus(input: { comments: { body: string; author: string | null }[]; headSha: string; principalAllowlist: string[]; maxRounds: number }): ReviewStatus` where `ReviewStatus = { state: 'CONTINUE' } | { state: 'PAUSE'; reason: 'reappearance' | 'zero-deaths' | 'stale' | 'max-rounds'; id?: string; round: number }`, and `parseDeveloperRoundMarker(body: string): number | null`.
- `apps/cli/src/commands/review-status.ts` — `reviewStatusCommand(args: string[])`: fetches comments, head, base via `gh pr view --json comments,headRefOid,baseRefName`, calls `deriveReviewStatus`, prints `CONTINUE` or `PAUSE: <reason>[ <id>]` and, when `git rev-list --count HEAD..origin/<base>` is greater than `0`, `behind main by <n> — merge first`; exit `0` on CONTINUE with `0` behind, `1` otherwise.
- `apps/cli/src/checks/bin/check-exec-bits.ts` — ring-`0` check `exec-bits`, `scope: 'diff'`: for every changed file under a `checks/bin/` directory, or whose first line starts with `#!`, read the index mode with `git ls-files -s -- <path>`; any mode other than `100755` fails with the `git update-index --chmod=+x <path>` recovery prompt.
- `apps/cli/tests/checks/check-exec-bits.test.ts`, `apps/cli/tests/commands/review-status.test.ts`.
- `.changeset/review-loop-facts.md` — `@attalabs/aeg-core`: minor, `@attalabs/vinaya`: minor.

**Modify:**
- `packages/aeg-core/src/parse-token-report.ts` — `TokenSourcePr.comments` becomes `{ body: string; author: string | null }[]`; `aggregateTaskTokenRows(prs, principalAllowlist: string[])` parses a comment's `Tokens:` lines only when `isPrincipal(author, principalAllowlist)`; `packages/aeg-core/src/parse-token-report.test.ts` — one body entry plus two allowlisted comment entries aggregate three rows; a non-allowlisted comment entry is ignored.
- `packages/aeg-core/src/test-plan-gate.ts` — `evaluateTestPlanGate(body, branch, evidence?: { developerRoundComments: number })`: a ticked `[agent]` item with `developerRoundComments === 0` fails with a message naming the round comment as the remedy and sets the new field; `packages/aeg-core/src/test-plan-gate.test.ts`.
- `packages/aeg-core/src/review-gate.ts` — `ReviewGateInput` gains `patchIdOf?: (sha: string) => string | null`; a verdict is bound when `isBoundToHead` holds or when `patchIdOf(extraction.headSha)` equals `patchIdOf(input.headSha)` and neither is `null`; `packages/aeg-core/src/review-gate.test.ts`.
- `packages/aeg-core/src/gate-audience.ts` — `exec-bits` added to `CLI_CHECK_RING` at ring `0`.
- `packages/aeg-core/src/index.ts` — export `review-status.ts` and the changed signatures.
- `packages/aeg-core/bin/archive-task.ts`, `apps/cli/src/commands/archive.ts` — pass comment authors through; pass the allowlist.
- `apps/cli/src/checks/contract.ts` — `CheckError` gains `pending?: true`.
- `apps/cli/src/checks/bin/check-test-plan.ts` — fetches the PR's comments through `gh pr view --json comments` when `PR_NUMBER` is set, counts Developer round markers from allowlisted authors, passes the count; the recovery prompt no longer says to paste evidence into the body.
- `apps/cli/src/checks/bin/check-review-gate.ts` — adds `baseRefName` to its `gh pr view` fields and supplies `patchIdOf` as `git diff origin/<base>...<sha> | git patch-id --stable` (fetching `<sha>` first; `null` when git fails).
- `apps/cli/src/checks/bin/check-pr-body-frozen.ts` — `CHANGESET_RELEASE_BRANCH` reports `info`, never `fail`, shaped as in `check-changeset-coverage.ts`.
- `apps/cli/src/checks/bin/check-reader-resolvable-prose.ts`, `check-retired-vocabulary.ts`, `check-doctrine-portability.ts`, `check-workspace-escape.ts` — under `--diff-only`, a finding prints only when its line falls inside a hunk of `fileDiffAgainst(base, path)` for that file; full-sweep mode unchanged; the hunk parser lives once in `apps/cli/src/lib/diff-evidence.ts` as `changedLineRanges(ref, path): Array<[number, number]> | null`.
- `apps/cli/src/checks/registry.ts` — one entry, `exec-bits`, shaped like `workspace-escape`, no env.
- `apps/cli/src/commands/pr-report.ts` — the comment above the `env: { ...process.env }` line states that Bun does not propagate runtime `process.env` mutations to a `spawnSync` child while Node does; `hasTokensAnchor` is evaluated on `withEvidence`, not `live`.
- `apps/cli/src/commands/doctrine.ts` — when the CLI runs from source (no `node_modules` segment in its package root), the repo root's `aeg-root/` is the doctrine and the package-relative bundle is ignored; `--role code-reviewer` resolves to `reviewer`; `apps/cli/tests/doctrine-resolution.test.ts` — a checkout carrying both roots; both role spellings.
- `apps/cli/src/index.ts` — `review status` subcommand.
- `apps/cli/tests/checks/registry-env.test.ts`, `apps/cli/tests/checks/repo-root-resolution.test.ts`, `apps/cli/tests/checks/bin-permissions.test.ts` — the new check's entries.
- `apps/cli/README.md` — the check list and the `review status` command.
- `aeg-root/roles/developer.md` — the post-open sequence (run every `[agent]` item that needed the PR number, merge `origin/main` if behind, one comment headed `Head: <sha>` carrying the `<!-- aeg:developer:round-<n> -->` marker and the outputs, tick own `[agent]` boxes as checkbox-character edits, never a `[principal]` box); the re-entry token sentence names the round comment.
- `aeg-root/roles/archivist.md` — the round comment as the token home for a re-entry turn.
- `aeg-root/roles/reviewer.md`, `aeg-root/roles/security.md` — one sentence each: a verdict also holds for a later head whose patch identity equals the judged head's.
- `aeg-root/process.md` — in the review phase: a fix commit adds no mechanism beyond what the finding names; new mechanism is escalated into the next brief.
- `aeg-root/enforcement.md` — the ring model gains the fixed-position rule (a gate reads its signal from a fixed position, never by scanning free text; a writer rendering caller text into a gate-read artefact refuses line breaks) and the own-PR fixture rule (a PR that adds a body-reading check ships a fixture test running it over that PR's own body); rows: `test-plan`, `review-gate`, `pr-body-frozen`, the four sweeps, new row `exec-bits`.

**Consumer tests (rule iii):** `apps/cli/tests/commands/review-post.test.ts`, `apps/cli/tests/checks/token-report-enforcement-logic.test.ts`; `packages/sources/src/doctrine-file-adapter.test.ts`; `packages/aeg-forge-state`: `consumer-tests: none — it does not import any symbol this task changes (pre-flight step 9 shows the enumeration)`.

**Out of surface:** `apps/cli/src/commands/review-post.ts` and `packages/aeg-core/src/verdict-extraction.ts` (task `2`'s, read-only here); `packages/aeg-core/src/pr-body-frozen.ts` and `brief-validation.ts` (tasks `5` and `10`); `apps/cli/src/checks/runner.ts`; every generated workflow under `.github/workflows/`; every file under `aeg-root/` not named above.

#### Premise pins

**Premise:**
- packages/aeg-core/src/parse-token-report.ts contains: export function aggregateTaskTokenRows(prs: TokenSourcePr[]): LedgerRow[]
- packages/aeg-core/src/parse-token-report.ts absent: aeg:developer:round
- packages/aeg-core/src/review-gate.ts contains: function isBoundToHead(extraction: { headSha: string | null }, headSha: string): boolean
- apps/cli/src/checks/bin/check-test-plan.ts contains: const result = evaluateTestPlanGate(body, branch)
- apps/cli/src/commands/doctrine.ts contains: if (!pkg.split(sep).includes('node_modules')) candidates.push(join(dirname(dirname(pkg)), 'aeg-root'))
- apps/cli/src/index.ts contains: (expected 'post')
- apps/cli/src/commands/pr-report.ts contains: hasTokensAnchor(live)
- apps/cli/src/checks/contract.ts contains: agent_recovery_prompt: string
- packages/aeg-core/src/index.ts absent: review-status

## 5. Pre-flight checks

**Step 0 (mandatory, verbatim):**

```
git worktree add .worktrees/task/review-convergence-v1/8 -b task/review-convergence-v1/8 origin/main && cd .worktrees/task/review-convergence-v1/8 && bun install --frozen-lockfile --silent
```

1. Clean status; parent `origin/main`; branch suffix literal-matches the task id `8`.
2. `bun packages/aeg-core/bin/verify-dispatch.ts review-convergence-v1 8 --premise <this-brief-file>` → `READY TO DISPATCH`; else STOP.
3. `rm -rf apps/cli/dist` before any check or test runs. A git-ignored build in `apps/cli/dist/` shadows the source check binaries; every command below and every `bun run test` runs from source, the way CI does.
4. Run the command below. The token parser already reads `Tokens:` lines from comments; what is missing is the author filter and the round marker (Part `1`).

   ```
   grep -n "for (const comment of pr.comments)\|^export type TokenSourcePr\|comments: string\[\]" packages/aeg-core/src/parse-token-report.ts
   ```

   Output the Brief Author obtained at authoring time, against `origin/main` at `d79cf8e3`:

   ```
   142:export type TokenSourcePr = {
   145:  comments: string[]
   162:    for (const comment of pr.comments) out.push(...parseTokensLines(comment))
   ```

5. Run the command below. The frozen-body shim already hashes the body it fetched from the forge; nothing in Part `6` touches that.

   ```
   grep -n "function fetchPr\|body: fetched.body" apps/cli/src/checks/bin/check-pr-body-frozen.ts
   ```

   Output the Brief Author obtained at authoring time:

   ```
   50:function fetchPr(prNumber: number): Fetched | null {
   95:    body: fetched.body,
   ```

6. Run the command below and read the function it names; Part `4` composes beside it, never replaces it.

   ```
   grep -n "isBoundToHead" packages/aeg-core/src/review-gate.ts
   ```

   Output the Brief Author obtained at authoring time:

   ```
   145:function isBoundToHead(extraction: { headSha: string | null }, headSha: string): boolean {
   203:  const codeReviewBound = isBoundToHead(codeReview, input.headSha)
   204:  const securityBound = isBoundToHead(security, input.headSha)
   ```

7. Run the command below; it lists which report-only sweeps already read the changed-file list. The other two are file-blind today; all four become line-scoped in Part `6`.

   ```
   grep -ln "resolveChangedFiles()" apps/cli/src/checks/bin/check-*.ts
   ```

   Output the Brief Author obtained at authoring time:

   ```
   apps/cli/src/checks/bin/check-changeset-coverage.ts
   apps/cli/src/checks/bin/check-reader-resolvable-prose.ts
   apps/cli/src/checks/bin/check-retired-vocabulary.ts
   ```

8. Run the command below; every file it prints registers a check by name, so `exec-bits` is added to each (Part `7`).

   ```
   git grep -l "doctrine-no-procedures" -- apps/cli/src apps/cli/tests packages/aeg-core/src/gate-audience.ts
   ```

   Output the Brief Author obtained at authoring time:

   ```
   apps/cli/src/checks/bin/check-doctrine-no-procedures.ts
   apps/cli/src/checks/registry.ts
   apps/cli/tests/checks/bin-permissions.test.ts
   apps/cli/tests/checks/registry-env.test.ts
   apps/cli/tests/checks/repo-root-resolution.test.ts
   packages/aeg-core/src/gate-audience.ts
   ```

9. Run the command below; it enumerates the workspace members depending on `@attalabs/aeg-core` — the consumers §`4` names tests for.

   ```
   grep -l '"@attalabs/aeg-core"' apps/*/package.json packages/*/package.json
   ```

   Output the Brief Author obtained at authoring time:

   ```
   apps/cli/package.json
   packages/sources/package.json
   ```

10. `bun apps/cli/src/index.ts check --plan` runs. Never use a globally installed `vinaya`.

On any failure: STOP and report.

## 6. Numbered parts — commit and push after EACH part (push-per-Part)

1. **Part 1 — token rows from round comments, author-filtered.** `parse-token-report.ts` per §`4`; `archive-task.ts` and `archive.ts` fetch `comments` with `author` and pass `resolvePrincipalAllowlist(loadTrustAnchorConfig())`. `parseDeveloperRoundMarker` lives in `review-status.ts` (Part `3`) and is exported from `index.ts` here so Part `2` can use it. Tests per §`4`.
2. **Part 2 — the evidence-comment gate.** `contract.ts` gains `pending?: true`. `test-plan-gate.ts` per §`4`: the failure message for a ticked `[agent]` item with no round comment names the comment as the remedy and the result carries `pending: true`; `check-test-plan.ts` fetches comments only when `PR_NUMBER` is set (`requiresOpenPr` already declares it) and emits `pending` on that error. Run the command below before writing the shim; its output is the env the runner forwards to it today.

   ```
   grep -n -A9 "name: 'test-plan'" apps/cli/src/checks/registry.ts | grep -E "PR_NUMBER|PR_BODY|BRANCH|GH_TOKEN|GITHUB_TOKEN|requiresOpenPr"
   ```

   Output the Brief Author obtained at authoring time:

   ```
   295-      // See `CheckSpec.requiresOpenPr`'s doc comment.
   ```

   Declare `PR_NUMBER`, `GITHUB_TOKEN` and `GH_TOKEN` as `{ optional: true }` on that entry, the shape `review-gate`'s entry uses; `apps/cli/tests/checks/registry-env.test.ts` grades the pairing.
3. **Part 3 — `vinaya review status`.** `review-status.ts` per §`4`. Round derivation: one round per allowlisted verdict comment pair grouped by `Judged head:`; `reappearance` when a finding id marked `resolved` in round `n` is marked `reproduced` in round `n+1`; `zero-deaths` when a round marks no prior id `resolved` and raises at least one new id; `stale` when the newest verdict's judged head is not the PR head and no Developer round marker is newer than it; `max-rounds` when the round count reaches `maxRounds` (`3`). The CLI prints the state line, then the behind-`main` line. Tests: one fixture per state, plus `CONTINUE`.
4. **Part 4 — patch-identity binding.** `review-gate.ts` and `check-review-gate.ts` per §`4`. Run the command below on any branch; it is the identity the gate compares. The Brief Author ran it on PR `#392`'s branch and again after a local merge of `origin/main` into it.

   ```
   git diff origin/main...HEAD | git patch-id --stable | cut -c1-40
   ```

   Output the Brief Author obtained at authoring time, before and after the merge commit:

   ```
   6a9a06098aa10ccdf9484e673422bbd61c83ecc9
   6a9a06098aa10ccdf9484e673422bbd61c83ecc9
   ```

   Tests: a verdict bound to a superseded sha with an equal patch id counts; with a different patch id it does not; `patchIdOf` returning `null` on either side falls back to sha binding alone.

   **Defeat cases:** a force-push that makes the judged head unreachable (`patchIdOf` returns `null`, sha binding alone applies, verdict not bound — correct); a merge from `main` with a hand-resolved conflict (patch changes, verdict not bound — correct); a base that moved under an identical patch with a semantic conflict (bound — the same limit GitHub's own stale-review rule has; CI at the new head is the guard); a staged check file with a shebang but no `checks/bin/` path (caught by the shebang branch of `exec-bits`); a symlink under `checks/bin/` (mode `120000`, fails — intended); a `PR_NUMBER` set to a closed PR for `test-plan` (comments still fetched; the gate reads them as any other PR); `gh pr view` unreachable in `check-test-plan.ts` (emit `severity:infra`, exit `1`, never `pending`).
5. **Part 5 — doctrine.** `developer.md`, `archivist.md`, `reviewer.md`, `security.md`, `process.md`, `enforcement.md` per §`4`. Every sentence about what a command does is checked against the command's own output at your head before it is written; a sentence the output contradicts is a stop condition, not a paraphrase. `doctrine-no-procedures` grades these files.
6. **Part 6 — carried fixes.** `pr-report.ts` two lines; `doctrine.ts` resolver and alias with tests; `check-pr-body-frozen.ts` release-branch exemption; the four sweeps line-scoped through `changedLineRanges` in `diff-evidence.ts`, one parser, no second hunk regex. Run the command below and confirm the two lines it prints are the ones you change.

   ```
   grep -n -E "env: \{ \.\.\.process\.env \}|hasTokensAnchor\(live\)" apps/cli/src/commands/pr-report.ts
   ```

   Output the Brief Author obtained at authoring time:

   ```
   281:    env: { ...process.env },
   701:  if (!tokens.collected || !hasTokensAnchor(live)) return { body: withEvidence, tokensSpliced: false }
   ```

7. **Part 7 — `exec-bits`, ring `0`.** The bin per §`4`, committed `100755`; registry entry; `CLI_CHECK_RING`; the two allowlist tests; `bin-permissions.test.ts` already grades every bin in that directory. Run the command below before and after; it is the check's own invariant on this repo.

   ```
   git ls-files -s apps/cli/src/checks/bin | grep -vc '^100755'
   ```

   Output the Brief Author obtained at authoring time:

   ```
   0
   ```

8. **Part 8 — docs, changeset, own-PR fixtures.** README, changeset. The own-PR fixture rule applies to this PR: `packages/aeg-core/tests/fixtures/pr-body-381.md` is this PR's body at open, and `test-plan-gate.test.ts` runs the new gate over it with `developerRoundComments: 0` (fails, `pending`) and `1` (passes).

## 7. Documentation-update list

- `aeg-root/roles/developer.md`, `aeg-root/roles/archivist.md`, `aeg-root/roles/reviewer.md`, `aeg-root/roles/security.md`, `aeg-root/process.md`, `aeg-root/enforcement.md` — as §`4` names.
- `apps/cli/README.md` — the check list and the command.
- `packages/aeg-core/CHANGELOG.md` and `apps/cli/CHANGELOG.md` via the changeset.
- Derivation against `.vinaya/doc-owners` (single binding `apps/cli/src/lib/ops.ts`): zero bindings fire; no `Doc-ack` needed.

## 8. Verification before claiming done

- `rm -rf apps/cli/dist && bun run typecheck && bun run format-and-lint && bun run test` (not bare `bun test`). Paste the summary line.
- From the repo root with `PR_BODY="$(cat <body-file>)"`, `BRANCH=task/review-convergence-v1/8` and `PR_NUMBER=<n>` exported once the PR exists: `bun apps/cli/src/index.ts check --all --diff-only`. `registry-gates`, `token-collection-wired` and `changeset-coverage` grade this diff; `brief-shape` grades this body under task `10`'s rules.
- `PR_BODY="$(cat <body-file>)" bun packages/aeg-core/bin/verify-docs.ts --pr` green.
- `git diff origin/main...HEAD --stat` shows only the files in §`4`.
- Blast radius: `packages/sources` consumes `aeg-core`; `bun run test` covers it; no `sources` file is edited.

## 9. Test Plan

- [ ] **[agent]** `rm -rf apps/cli/dist && bun run test` → green. Paste the summary line.
- [ ] **[agent]** `bun apps/cli/src/index.ts review status <this PR>` at your head, after your own `Head:` comment → `CONTINUE` and no `behind main` line. Paste it.
- [ ] **[agent]** `PR_NUMBER=<this PR> PR_BODY="$(gh pr view <this PR> --json body -q .body)" BRANCH=task/review-convergence-v1/8 bun apps/cli/src/index.ts check test-plan` → before your `Head:` comment the ticked `[agent]` items fail with `pending`; after it, they pass. Paste both.
- [ ] **[agent]** `bun apps/cli/src/index.ts check exec-bits` on a scratch commit that stages a `checks/bin/x.ts` at mode `100644` → fail naming the file; at `100755` → pass. Paste both, then drop the scratch commit.
- [ ] **[agent]** On this branch after a merge commit from `origin/main`: `bun apps/cli/src/index.ts check review-gate` with `PR_NUMBER` set → the verdicts posted at the pre-merge head still count. Paste it. If no verdict exists yet, paste the `review-gate` output naming the missing verdict and leave the box unticked.
- [ ] **[principal]** Read `aeg-root/roles/developer.md`'s post-open sequence cold and answer: can a Developer following it reach a `Head:` comment without first merging `main` when behind?

## 10. Stop conditions

STOP and report if: pre-flight fails; a `Premise:` pin fails; a doctrine sentence you are about to write is contradicted by the output of the command it describes; the Archivist's provenance assembly turns out to depend on the token line's position in the body for any other field — escalate `severity:strategy` rather than moving that field; `git patch-id` is unavailable on the runner image; adding `pending` to `CheckError` breaks a consumer outside §`4`; you are about to touch `review-post.ts`, `verdict-extraction.ts`, `pr-body-frozen.ts` or `brief-validation.ts`; any destructive action not explicitly authorized.

## 11. Constraints

- Do NOT count a comment's `Tokens:` line without `isPrincipal`; agents post under the Principal's `gh` identity, so an unfiltered read counts a stranger's paste.
- Do NOT de-duplicate token rows by shape; a Developer round line and a Reviewer verdict line are both ledger rows.
- Do NOT write a second hunk parser or a second `Judged head:` regex; reuse `diff-evidence.ts` and task `2`'s parsers.
- Do NOT recompute a body hash and post it as a marker; the frozen check's design belongs to task `5`.
- Do NOT add a flag, gate or window a review finding did not name; escalate instead.
- Do NOT run any check or test with `apps/cli/dist` present.
- Never use the globally installed `vinaya`; every command is `bun apps/cli/src/index.ts …` or a `bun packages/aeg-core/bin/*.ts` script from the repo root.
- **This PR obeys the frozen-body rule.** Body written once at open. Findings answered by commits and one comment per round. Evidence regeneration after a push is `bun apps/cli/src/index.ts pr report --push <n>`.
- Never write status anywhere; never add execution metadata to any tranche file.

> **Autonomy:** Do not stop to ask clarifying questions. For any ambiguity not covered by a Section 10 stop condition, choose the most reasonable option consistent with this brief, record the choice in the PR body at open, or in a PR comment after open, and continue. Halt only for the explicit Section 10 stop conditions — and when you halt, record the blocker in a PR comment or an Issue comment rather than waiting interactively for input.

## 12. Deliverable

- PR title (exact): `[review-convergence-v1] 8 — Token reports and re-run evidence are read from PR comments as well as the body`
- Open the PR only via `bun apps/cli/src/index.ts pr create --body-file <path> --title "<title above>"`.
- PR body = the Developer's PR report (start from `aeg-root/templates/pr-report-template.md`), with this entire brief pasted as the reference copy inside a collapsed `<details>` block, and a bare `Closes` line naming Issue `#381` at the top of the header block, inside the `AEG:CLOSES` anchor.
- Summary: one paragraph. Scope: one paragraph. `Tier: 1`. Decisions made that the brief left open, one line each.
- Pre-open gate: tier checklist satisfied, and `PR_BODY="$(cat <body-file>)" bun packages/aeg-core/bin/verify-docs.ts --pr` green.
- **After opening:** run every `[agent]` item that needed the PR number; if `git rev-list --count HEAD..origin/main` is greater than `0`, merge `origin/main` and push first; `bun apps/cli/src/index.ts pr report --push <n>`; post one comment headed `Head: <sha>` carrying `<!-- aeg:developer:round-1 -->` and every `[agent]` output; tick the `[agent]` boxes you ran, checkbox character only; never tick a `[principal]` box. Then stop. Review is a separate invocation.

</details>

