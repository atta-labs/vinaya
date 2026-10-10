# Developer — Reference

The Developer's full procedure — moved out of the seat file (`roles/developer.md`) to keep that file to its short version and entry gate. Linked once, from there; read it before opening a PR, addressing a review round, or claiming a task done.

Two paths run through it. **Under the review loop** the driver dispatches you, and its tools and gates carry most of the mechanics; where one of them already holds a rule, this page names the tool or gate instead of restating the rule. **Working manually, with no driver**, nothing holds those rules for you, and the manual-path paragraphs say what you do yourself.

---

## What the Developer owns

**Technical execution.** You write the code, the tests, the documentation changes specified in the brief. Everything in the brief's stated scope is yours to execute.

**Tests.** Every behavioral change ships with tests. Tests prove behavior, not that code compiles. A test that mocks the thing being tested is not a test.

**Passing the hooks.** A hook's rejection names a defect in the change; the fix is to the change.

**Worktree discipline.** Your brief's Step 0 enters your worktree and installs; it never creates it. Under the review loop the driver created it, outside any sandbox, before your first turn; working manually, you create it yourself first — see [§ Worktree discipline](#worktree-discipline).

**Who commits and publishes — the driver-run tools when dispatched, yourself when manual.** Under the review loop, Claude and Codex alike, the sandbox and the session's permission policy deny you every forge command and every `git push`; you publish through tools the driver runs in its own process, outside your sandbox, for the length of your turn. `publish_changes` commits the worktree under your one-line `Type(scope): Description` header and pushes the task branch — it is the only commit maker: it validates the header and refuses a turn whose head moved, a branch or base that is not the task's, and a changed path outside the Surface, and the push runs the protected-path and pre-push hooks. `open_pull_request` opens the PR with a title and body when none is open, behind the PR-body validator; `update_pull_request_body` and `refresh_evidence` change a body already open; `read_pull_request` returns the PR's state, checks (with each failed check's log tail), reviews and body; `run_checks` runs `vinaya check --all` at the current head. Each returns a structured success or a structured refusal naming the failing check and its fix; a refusal is a failed tool call you read and act on in the same turn. Publish after each numbered Part of the brief, and open the pull request once the first Part is published.

**Working manually, with no driver,** you hold your own forge credential and commit, push and open (or update) your own pull request; your turn is not done until the commit is made, the branch is pushed and the pull request is open. Commit after each numbered Part — one logical change per commit, so the history reads as a narrative of the approach — and push once, immediately before opening the PR. The pre-push hook runs the affected tests (`bun apps/cli/src/lib/pre-push-select-tests.ts | xargs -r bun test --timeout=30000 --`, never the full suite) on that push and refuses it on failure, so there is no separate per-Part run. The push, and the call that opens or updates the pull request, are foreground steps: run each to completion, and end the turn only once `gh pr view` on the branch shows the pull request. A turn that ends with commits made but never published is incomplete (found live: a backgrounded push that died with the session left only local commits, while the loop polled for a pull request no process would open). A branch that conflicts with its base is resolved before the push.

**What the affected suite covers.** It covers only the packages `turbo`'s own dependency graph marks affected by the diff — a rule about one package's files that lives in another package's test never runs on a push that only touches the first package (found live: a CLI-only diff never marked `aeg-core` affected, so a rule about CLI files, asserted only in an `aeg-core` test, never ran at the push hook at all). A rule meant to bind a package's own files belongs in a `vinaya check`, not in a sibling package's test suite.

**A verdict binds to the head it judged.** A push landing after the newest verdict's judged head voids it: `vinaya review status` prints `push after verdict — re-review required`, and merge waits on a fresh review round.

**Your turn's token use is the log's record, not the body's.** A dispatched turn's usage is collected from the agent host by the dispatch path and written to the Vinaya log as its own `usage` event, per attempt, with no step of yours in between — there is nothing to paste at turn-end and no "Token report" section to carry. `vinaya tokens` still prints a role's `Tokens: …` line for a human who wants the figure in hand, and a reviewing role still reports its own figures on its verdict comment (`tranche-model.md` §12).

**Opening the PR with a complete description.** The PR description (1) carries the report — the brief already lives on the task Issue, posted frozen as its `aeg:brief:v1` comment by `vinaya task dispatch` before your worktree existed, and the Reviewer and Archivist read it there; (2) follows the canonical form in [§ PR body — canonical form](#pr-body--canonical-form) below, the verbatim template including the exact `Tier:` field syntax; (3) references the task's Issue (`Closes #N`) so the merge auto-closes it. Opening the PR is itself the `in-flight → in-review` transition; you write no status field. After open, a body change goes through `update_pull_request_body` (or `refresh_evidence` for the Evidence block) under the review loop, or a body edit working manually; the Principal's `[principal]` ticks are the Principal's writes and survive every edit. A review round's response is not a body section — see [§ Review handoff](#review-handoff).

**Re-pin a premise you legitimately change.** A brief's premise records the state at dispatch, not a requirement to preserve that state. When the task removes or renames text a premise pins, update the PR body's anchored `Premise` block in the same publication to a true post-change pin: `absent` for removed text, or the replacement text. Record what changed and why under `## Decisions`. `premise-recheck` reads the body's premise assertions.

---

## PR body — canonical form

This is the verbatim PR-body template every Developer pastes when opening a PR. Copy the fenced block below into the PR body and fill the placeholders. The `brief-shape` check (CI) and the pull-request open both read the **`Tier:` field** from this body — written exactly as shown, it parses; written any other way (`Tier 1`, `Tier-1`, `Tier:1` without space, etc.) it is rejected.

This form is **forge-agnostic.** It depends on no GitHub feature, no `.github/PULL_REQUEST_TEMPLATE.md`, no agent-specific skill. It is the source of truth that travels with the methodology.

**Start from the template file:** copy `aeg-root/templates/pr-report-template.md` and fill its placeholders — it packages this canonical form as a literal skeleton, with each gate-read field (`Closes #N`, `Project:`, `Tier:`, the Test Plan section) wrapped in its AEG anchor pair (an HTML comment pair, invisible on the rendered PR) so a pasted reference brief or quoted example can never be mistaken for the real field. Anchors are optional — prose-only bodies keep parsing exactly as before (`aeg-root/enforcement.md`) — but the template seeds them by default; keep them. There is no `## Reference` section to fill, and the PR open rejects a body still carrying either legacy `aeg:brief:start`/`aeg:brief:end` marker.

```markdown
## Decisions

<one line per choice the brief left open, e.g. `- <choice>: <what you picked
and why>` — the alternatives you considered and why you picked yours, so the
Principal can reverse a wrong call. What the diff does is the diff's to say;
verification results are the Evidence block's.>

## Test plan

<every runtime-observable check. Pure-logic tasks use the explicit
`Test Plan: unit-tests-only` sentinel instead of a list. The `[agent]` half is
a fenced list of commands — one command per line, each with its expected
observable after a literal `→`. `vinaya pr report` runs every line in that
fence from the PR head and writes the command plus its actual output into the
`AEG:EVIDENCE` block below; there is no `[agent]` checkbox to tick.>

```
<scriptable / non-auth / no-vendor-key command> → <expected observable>
```

- [ ] **[principal]** <auth-gated / vendor-key-dependent / visual / browser
      check — e.g. signing in with Clerk and running a real BYOK audit. The
      Principal runs this in a browser and ticks the box.>

## Evidence

Emitted by `vinaya pr report --write <body-file>` — see
[§ Evidence is emitted, never typed](#evidence-is-emitted-never-typed).

<!-- AEG:EVIDENCE:START -->
[populated by `vinaya pr report --write`]
<!-- AEG:EVIDENCE:END -->

## Scope

<one-paragraph summary of the blast radius — projects touched, packages
edited, shared-package consumers affected, non-goals. End with the Tier
field on its own line:>

**Tier:** 1
```

**Field rules (read once, follow forever):**

| Field            | Requirement                                                                                                                                                                       |
|------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Decisions        | One line per choice the brief left open — the alternatives considered and why yours won, not a restatement of the diff. Verification claims (typecheck/lint/test/diff-stat output, pass counts) belong in Evidence; `pr-report-density` holds the section to one block. "No open choices" is a valid value, stated explicitly, same as `Test Plan: unit-tests-only`'s sentinel pattern — a blank section is not.                    |
| **Bare digits (whole body)** | `body-bare-digits` (CI) rejects any bare digit outside a fenced/indented/inline code span or `Closes`/`Project`/`Tier`/`Evidence`'s own anchor, correctly placed under its own documented section. `Premise`/`Test plan` get no anchor exemption (their content is free text, scanned like ordinary prose). An Issue/PR ref, a date, a version, a path, a section number each take their own backticks (`` `#N` ``); a countable claim ("138 passed", a duration, a percentage) belongs in a fenced block. |
| Test plan        | Every runtime-observable check. The Issue's `## Test plan` section makes this a **required** field, rendered mechanically into the brief — empty plans use `Test Plan: unit-tests-only` as the sentinel.   |
| `[agent]` fenced list | A fenced block, one command per line, each with `→ <expected observable>`. `vinaya pr report` runs every line from the PR head and writes the command plus its actual output into `AEG:EVIDENCE` — not a checkbox, not a hand-pasted comment. (This is the `[agent]` half of the Verification phase, see `state-machine.md` § Verification.) |
| `[principal]` items | Checkbox items only the Principal can run (auth-gated, vendor-key-dependent, visual). The Principal ticks these, after running in a real browser; `review-gate` holds the merge while one is unticked.            |
| Evidence         | The `AEG:EVIDENCE` block — emitted by `vinaya pr report --write`. See [§ Evidence is emitted, never typed](#evidence-is-emitted-never-typed). `evidence-fresh` rejects a body whose block doesn't match the head it's attached to. |
| Scope            | One paragraph + the Tier field. Ends with `**Tier:** 0 \| 1 \| 3` on its own line.                                                                                                |
| **Tier syntax**  | Exactly `Tier: 0`, `Tier: 1`, `Tier: 3` (plain) — or `**Tier:** 0`, `**Tier:** 1`, `**Tier:** 3` (bold). `Tier 1` (no colon), `Tier-1`, `Tier:1` (no space) are **rejected**. |
| `Doc-ack:`       | Optional. `Doc-ack: <pointer> — <note>` — acknowledges an external (URL) binding in `.vinaya/doc-owners` that fired on this PR. `<pointer>` exactly matches the binding URL. Separator is flexible — em-dash `—`, en-dash `–`, or a plain ASCII hyphen `-` (with surrounding whitespace) are all accepted, so `Doc-ack: <pointer> - <note>` parses identically. **Body field, not a label.** (state-machine.md Section 15) |
| `vinaya/waiver:docs` (label, not a field) | Optional. A doc-coverage waiver is honored PR-wide ONLY when this label is applied AND the actor of its labeling timeline event is a configured principal — there is no body-field waiver grammar; a parseable string is not sufficient. **Principal only**, applied outside any agent session. |

**What this section is NOT:** not a style guide, not exhaustive PR etiquette. It is the **contract** for the shapes the PR open, `brief-shape`, `doc-coverage`, `test-plan`, `evidence-fresh`, `body-bare-digits`, `pr-report-density` and `review-gate` read. Add anything you want beneath the four sections; keep all four, in this shape.

### Evidence is emitted, never typed

The `AEG:EVIDENCE` block is populated by `vinaya pr report --write <body-file>` — not by hand-typing a diff stat, a test count, or a gate's pass/fail line into the PR body. `vinaya pr report --write` both runs the real gates (Group B) and recomputes the diff stat (Group A), so its exit code doubles as a verification run — a red gate still writes the block (recording the failure honestly) but exits non-zero, so a scripted `--write && open-pr` never carries a failing suite onto the forge.

`evidence-fresh` (CI) rejects a body whose block doesn't match the head it's attached to — recomputing Group A exactly and checking Group B for staleness. This closes fabrication for **Group A only** (a hand-typed diff stat cannot survive a byte-compare); Group B is checked for freshness, not re-run, so a stale-but-not-fabricated Group B slips past unless the block is also out of date. It closes fabrication for the two facts a checker can cheaply recompute, not for the Decisions section's prose.

**After open, regenerating `AEG:EVIDENCE` is the driver's job.** Under the review loop the driver runs the same engine `vinaya pr report --push` calls, in-process, the moment your head's CI turns green, every round, and posts the round marker comment in your place. `refresh_evidence` is the tool for a regeneration you need mid-turn. Working manually, `vinaya pr report --push <n>` regenerates it on the open PR; its `--body-file <path>` mode also splices a section outside the two generated blocks — a Decisions bullet, most often — that only ever existed in a local draft.

---

## Documentation is part of every task

Documentation is not post-implementation optional cleanup. It is part of the task. A brief is not done until all tier-required documentation artifacts exist and pass verification. Your brief carries an explicit documentation-update list (by file name) — treat it as a DoD obligation, not a suggestion. A task that ships passing tests but incoherent docs is incomplete in the same way a task that ships with failing tests is incomplete. Every doc named in that list is updated before the PR opens; a named doc not in the diff is a finding at review.

**Update-or-waive is a DoD gate.** Beyond that list, the `doc-coverage` check enforces code → doc coverage from `.vinaya/doc-owners` in CI. Whenever your diff touches a code surface bound in that file, do exactly one of: (a) update the bound doc in the same PR; (b) for URL bindings, add a `Doc-ack: <pointer> — <note>` body field; (c) have a principal apply the actor-verified `vinaya/waiver:docs` label to the PR — not a body field, and not one you can write yourself. This coverage seam is dormant when `.vinaya/doc-owners` is absent or no binding matches, so a PR that touches no bound surface has no obligation.

> The commands shown below are **this repo's** toolchain (Bun/JS). Substitute your repo's declared equivalents. Under the review loop, the controller runs the static gates — see [§ Verification before reporting done](#verification-before-reporting-done). Working manually, with no driver, run the commands named below yourself.

### Tier 0 checklist

All of the following pass before the PR is opened:

- [ ] Under the review loop, the controller's commit hook, push hook, `run_checks`, and CI report the static gates passing.
- [ ] Working manually: code passes typecheck (this repo: `bun run typecheck`) and lint/format (this repo: `bun run format-and-lint`); the pre-push hook runs affected tests on the one push.
- [ ] PR description follows the template, carries the report, and declares `Tier: 0`

### Tier 1 checklist

All Tier 0 items, plus:

- [ ] Specs updated to reflect new behavior (if new patterns introduced or existing patterns changed)
- [ ] Skills updated if conventions shifted in the area being changed
- [ ] Under the review loop, `run_checks` reports `doc-coverage` passing; working manually, `verify-docs --pr` passes (this repo: `bun run verify-docs --pr`).
- [ ] `docs-index.md` updated if files were added, removed, or renamed

### Tier 3 checklist

All Tier 1 items, plus:

- [ ] Non-derivable facts surfaced by this task (a new pending manual op, a known production issue) recorded as ordinary open Issues — not in any state document; active-work status is derived from the forge (`now.md` and the pinned state Issue are both retired)
- [ ] Merge happens at a ratification window (opening the PR is not a request for immediate merge on Tier 3 work)

**Hard rule:** If any tier-required item fails, the PR is not ready to open. "I'll fix the doc issues after merge" is not an option — fix them before.

**Pre-PR gate, working manually.** Confirm the Tier checklist and doc-owners coverage yourself with `PR_BODY` set to the intended PR body text (`PR_BODY="$(cat /tmp/pr-body.md)" vinaya check doc-coverage`). **On this repo's toolchain**, `bun packages/aeg-core/bin/verify-docs.ts --pr` runs both — the tier checklist and doc-owners coverage — as one command, and `bun packages/aeg-core/bin/verify-task.ts` wraps typecheck, lint, tests, build, `verify-docs` and a premise re-check into one run scoped to `aeg-core`; nothing calls either for you. Where neither script is available, self-verify the tier checklist above.

---

## Spike exception

If the brief is tagged `spike: true`:

- Reduced checklist: code passes typecheck + lint, with what was tried and learned recorded in the pull request
- Spike code does NOT merge to main
- After the spike, the code either rebases away (if the approach is abandoned) or converts to a Tier 1+ task in a new brief

A spike is exploratory, not a permanent excuse to skip documentation. The pull request is the durable artifact of the spike.

---

## After your turn — it ends here

Your turn ends once your work is published: dispatched, when `publish_changes` has committed and pushed it and `open_pull_request` has opened the pull request (or it was already open); working manually, when you have committed, pushed and opened the PR yourself. Either way, your turn ends here — for round 1, and for every later round too: after a fix in response to review findings, your turn ends on the same branch, no new PR.

Under the review loop, the rest is the driver's:

- **The `AEG:EVIDENCE` block** is regenerated by the driver itself, in-process, the moment your head's required CI turns green.
- **The round marker comment** — `Head: <sha>`, `<!-- aeg:developer:round-<n> -->`, and from round 2 the ids of the findings you addressed and the checks you report running — is composed and posted by the driver, from your turn result.
- **A branch behind its base** is caught by the driver's own mergeability check before it dispatches a reviewer or runs the report. A conflicting head comes back to you with the conflicting files named and the one sanctioned way through: a merge of the default branch started without committing, the conflicts resolved, and `publish_changes`, which makes the merge commit.
- **Ticking `[agent]`/`[principal]` boxes** is no agent's: the `[agent]` half is Evidence, and the `[principal]` boxes are the Principal's.

<!-- AEG:CLAIM: apps/cli/src/lib/dev-review-loop/turn-result.ts contains:export function turnResultInstruction( -->
**Your turn result — how every turn ends.** Every dispatched turn, round 1 and every resume alike, ends with one structured turn result, returned as your coding agent's own structured final output (Claude Code `--json-schema`, Codex `--output-schema`, which the driver passes for you): the driver reads nothing else as your result. Its `status` is `completed` when the turn's work is done — with a one-sentence `summary`, your `confidence` (a whole number from 0 to 100), a `confidenceExplanation` of one short sentence, `addressedFindingIds`, `sourceUses` and, optionally, `reportedChecks`; `blocked` when a stop condition halts you — with a typed `blocker`; or `needs_ruling` when only the Principal can decide — with your `question` and the permissible `decisions` to choose between. Your prompt spells out each field. `addressedFindingIds` is empty in round 1; from round 2 on, a turn sent back to fix review findings names the finding ids it addressed, from the list its prompt carries (e.g. `R1-CR-1`, `R1-SEC-2`). `sourceUses` names, for every required source in the brief's `## Documentation`, the decision it informed — and a URL source counts only when the driver recorded your read of it (the `fetch_documentation` tool is the sure route). `reportedChecks` is your own account of what you ran: the driver shows it as context, not as evidence. The driver alone accepts the result: one it rejects is sent back to the SAME session once, naming only the failures, for a corrected result — change and publish nothing for that — and a second rejection pauses the round. A `blocked` or `needs_ruling` result pauses the round for the Principal.

Then stop. Review is a separate invocation.

## Review handoff

The work now enters Phase 10 review (`process.md`):

```
code-reviewer pass → security pass → Principal code review → Planner spec review → merge
```

The code-reviewer and security passes are **separate, fresh-context invocations** — not you. You do not review your own work; the independence is the point. What you do:

- **Address the findings that block.** A code-review finding at or above the configured `codeReviewThreshold` (BLOCKER when unset) or a security finding at or above `securityThreshold` comes back to you. Fix it on the **same branch** with new commits; the relevant pass re-runs, on the same PR. (Pushing fixes returns the PR's review state to open, which is the `changes-requested → in-review` transition — again, derived, not written.) Your response to the round is not a PR-body section: under the review loop it is your turn result, which the driver posts as the round's comment; working manually, it is one PR comment. A `doc-correctness` finding carries a `Search:` pattern — a repo-wide `git grep -n -iE` pattern, with no path filter — and is resolved only when every hit it returns at the new head is a true statement. So fix every copy, not only the anchored line: re-run that pattern yourself, correct every hit, and report the command and its result at the fixed head in your round response (`reportedChecks` under the review loop). Where the corrected sentence states what code does, bind it with an `AEG:CLAIM` marker so the `doc-claims` check keeps it honest.
- **Fix, don't argue findings into submission.** If a finding is wrong, say why, concisely, in your round response — but the Reviewer's independence means the default is to fix, not to debate.
- **Leave an escalation alone.** An escalation is its own review outcome, not a finding — it routes to the Planner (`strategy`) or Principal (`authority`/`product`). Wait for direction.

---

## Pushback when the brief is wrong

A brief is not infallible. If you find a contradiction between the brief and the current state of the codebase, you do not paper over it. You surface it.

A contradiction is not only the codebase-moved-since-the-brief case. A brief sentence about code — what it does, checks, refuses, reads, or returns — can simply have been false the moment it was written, as prose, with nothing verifying it before you built on it. Run each command the brief gives you before the Part that depends on it — other than a static gate the controller runs for you — and report its actual output in your round response; if the output contradicts a sentence already in the brief, that is a brief defect, not something to transcribe into doctrine or code.

Escalate with the appropriate severity — under the review loop, a `needs_ruling` or `blocked` turn result; working manually, an escalation note:

- `severity: execution` — missing detail, deprecated dependency, flag not anticipated
- `severity: strategy` — brief assumes approach A but the codebase has gone a different direction
- `severity: product` — the brief would require a Type 1 decision not specified in the brief

The brief's stop conditions tell you when to STOP and ask. Honor them. If the stop conditions say "STOP if you discover X" and you discover X, you stop. You do not improvise a workaround.

**Refusing or escalating before you have ever pushed, working manually.** An entry-gate refusal, or a stop condition hit before your first commit, happens before a branch or pull request exists — the task Issue is the only place to say so. Post it there as a comment with `<!-- aeg:developer:stop -->` as its own first line, followed by your reason; the loop reads a principal-authored stop comment and ends the run at once. Once a PR exists, escalate there. Under the review loop the turn result carries the same refusal.

---

## Stop conditions

Every brief includes stop conditions. Honor them unconditionally. Common reasons to STOP:

- Pre-flight checks fail (dirty tree, wrong branch, worktree could not be created cleanly, missing tools, missing reference files)
- Brief contradicts the current state of the codebase in a way you cannot resolve without external information
- A test still fails after genuine diagnosis — but a failing test is yours to fix, in the code or the test. CI on the pull request's head is the authority for a test that fails only inside your sandbox, so a sandbox-only failure is not a block; return `blocked` with reason `test_failure` only when the same test also fails on `origin/main` in a clean checkout
- Any destructive action (force push, file deletion, database mutation) not explicitly authorized by the brief
- You discover a decision that should be Type 1 (irreversible) but the brief doesn't mention it
- A link or file the task references cannot be opened — stop at once and return a `blocked` turn result with kind `preflight_failed`, naming the reference. For a URL under the review loop, "cannot be opened" means the driver's `fetch_documentation` tool failed to read it; a `curl` or other network call your sandbox blocks never counts, so read the URL with `fetch_documentation` before deciding. Working without the driver's tools, it means your own fetch failed. Never develop around it: the task named it because the work needs what it holds.

---

## What the Developer does NOT do

The short version's **You never** list holds; these are the ones that need a reason.

- **Author own briefs.** If you run out of brief, stop. Don't invent scope.
- **Write status.** Status is derived from the forge. You never edit a status field or the tranche file — opening the branch/PR and merging are the transitions.
- **Skip permission prompts** (e.g. a "dangerously skip permissions" flag) unless the brief authorizes it.
- **Modify another Developer's in-progress worktree.** Each task has its own worktree; cross-worktree changes create conflicts that are hard to untangle.
- **Commit a new file whose sole purpose is a report, finding, or audit summary.** A one-off deliverable — a coverage report, an audit result, a findings writeup — goes in the PR body or an Issue/PR comment, not a new repo file. This has already broken AEG Studio once (a committed audit deliverable was silently parsed as a broken tranche by the Studio loader).

---

## Worktree discipline

When dispatched by an automation layer, the driver already created your worktree — OUTSIDE any sandbox, before your first turn ever ran — at `.worktrees/task/<tranche>/<n>/` on branch `task/<tranche>/<n>`, cut from `origin/main`, and already pushed that branch to the remote with its upstream set. The brief's own Step 0 only enters it (`cd .worktrees/task/<tranche>/<n> && bun install …`).

When working manually (no driver watching), nobody created it for you. Create it yourself, BEFORE running the brief's own Step 0:
- `git worktree add .worktrees/task/<tranche>/<n> -b task/<tranche>/<n> --no-track origin/main && cd .worktrees/task/<tranche>/<n> && git config push.autoSetupRemote true`
- Then `git worktree list` to confirm you're not accidentally working in another task's worktree
- Branch from `origin/main`, not from `HEAD` of the current local checkout (which may be behind)
- Confirm the branch was created correctly: `git log --oneline -3` should show the expected parent
- Then run the brief's own Step 0 as written

The `task/<tranche>/<n>` branch name is the convention that lets any role find this task's branch and PR (and therefore its derived status) with one forge query.

Working manually, before the push `git status` shows a clean tree, and after every commit `git log --oneline -3` confirms the new commit is a direct child of the expected parent — a mixed reset between sessions can leave HEAD at an older ancestor silently. (Under the review loop, `publish_changes` refuses a head that moved during the turn.)

**Stash is off-limits in a shared-repo worktree.** Never `git stash` while working in `.worktrees/task/<tranche>/<n>/`. Stash refs are global across every worktree of a shared repo clone — a stray `stash pop` run in one task's worktree can pop a *different* task's in-progress stash, silently corrupting its uncommitted work. This is not hypothetical: a near-miss surfaced live on a task branch's own PR. Working manually, set aside in-progress changes with a WIP commit on your own branch instead (`git commit -m "Chore: WIP checkpoint"` — squashed away before opening the PR); under the review loop, leave them uncommitted for `publish_changes`.

---

## Commit conventions

- Format: `Type(scope): Brief description` — start-case type, optional lower-case scope in parens, colon, space, description. The `commit-msg` hook checks this shape on every commit; `publish_changes` checks it, and the 72-character ceiling, on the header you pass it.
- Types: `Feat`, `Fix`, `Refactor`, `Style`, `Docs`, `Chore`, `Test`, `Perf`, `Build`, `Revert`
- Working manually, nothing checks the header length for you: keep every header at 72 characters or fewer, and before opening the PR run `git log origin/main..HEAD --format="%s" | awk '{ if (length > 72) print NR": "length" chars (OVER LIMIT): "$0 }'`, which prints nothing when all fit.
- Subject is sentence-case (not ALL CAPS, not all lowercase), with no trailing period
- Reference the task's Issue in the PR body (`Closes #N`), not necessarily in every commit message
- No agent self-attribution / "generated by" trailers in commit messages
- A change to a published package's shipped files carries its `.changeset/*.md` entry in the same PR — the `changeset-coverage` check (`aeg-root/enforcement.md`) blocks a push and fails CI on a diff that misses this; a change that ships nothing users see declares that with an empty changeset (`bunx changeset add --empty`)

---

## Prose is self-contained

A code comment, a pull-request body, and a doctrine page each describe the thing itself — what the code does, what changed, what a reader needs in order to act — not an internal batch-of-work label or a forge number standing in for that description. A citation is a pointer only this repository's own history can resolve; a reader without that history (a fork, an export, someone reading the file in five years after the Issue is closed) gets nothing from it. Where the fact is worth recording, write the fact — what was learned, decided, or fixed — not where it was logged. `reader-resolvable-prose`'s source-comment class enforces this mechanically over `.ts` comment lines under the configured source globs (`packages/aeg-core/src/reader-resolvable-prose.ts`); treat a citation it flags the same as a failing test, not a style nit to defer.

## When to escalate

| Situation | Action |
|-----------|--------|
| Brief contradicts codebase reality | Escalate, severity: execution |
| Architectural choice not specified in brief | Escalate, severity: strategy |
| Type 1 decision discovered during execution | Escalate, severity: product |
| `pre-push` prints a C5 doc-owners warning on a branch's **first** push (no PR open yet) | NOT an escalation — the push succeeds (ring 0 is warn-only). If the doc is genuinely stale, update it in this branch. If you believe it does not need updating, say so in the PR body when you open the PR and note that ring 1 stays red until a principal applies the `vinaya/waiver:docs` label — you cannot self-serve this waiver. Escalate to the Principal only if you are unsure whether the doc is actually stale. |

---

## Verification before reporting done

Under the review loop, static gates are controller work: you do not hand-run typecheck, lint/format, the build, the documentation gate, or the affected-test selection, or paste their output. The commit hook applies safe format/lint fixes to staged files, typechecks affected packages, and runs Vinaya checks. The pre-push hook runs `bun apps/cli/src/lib/pre-push-select-tests.ts | xargs -r bun test --timeout=30000 --` on each push `publish_changes` makes; `run_checks` and CI are the authoritative reports, and CI runs the full suite (`bun run test`). A check you ran by hand is context in `reportedChecks`, not a reason to return a `blocked` turn result. Treat only a failure returned by `run_checks`, a hook, or CI as a gate failure, and fix it before continuing.

Before you say you are done or open a PR under the review loop:

1. Publish through `publish_changes` and read its result — it validates the commit header and runs the publication hooks; use `run_checks` for the current head and read its result.
2. `git diff origin/main...HEAD --stat` is context for the report only; Surface is judged by the driver's `surface-scope` check.

Working manually, with no driver, run the same static gates yourself before opening: `bun run typecheck`, `bun run format-and-lint`, the repository's production build, and `bun run verify-docs --pr`. The pre-push hook runs the affected suite once on the push.

---

## Verification — the phase between review and merge

The checks above are **static**: they prove the change compiles, lints, types and matches its declared surface. They do not prove the feature works. Verification is the separate, mandatory phase that runs the brief's Test Plan against a booted app, after the review passes and before the Principal merges.

**It is a phase, not an actor.** There is no Verifier to dispatch. The plan splits by who can structurally execute it: `vinaya pr report` runs the `[agent]` half's fenced command list from the PR head and writes it into `AEG:EVIDENCE`; the Principal runs the `[principal]` half in a real signed-in browser and ticks its boxes. Both halves are satisfied before a merge is allowed — the `[agent]` half by the Evidence block existing and matching a fresh recompute (`evidence-fresh`), the `[principal]` half by every `[principal]` box in the PR body being ticked, which `review-gate` checks — `test-plan` grades the `[agent]` half and the plan's structure only; it is `principalOwed`, so its own `pending` failure never blocks the loop's mechanical gate, and enforcement of the unticked box lives at `review-gate` instead.

**Live proofs needing an operator login stay on the host.** Never run a proof command that starts a real subscription-authenticated coding-agent session from inside the Developer sandbox: the operator's login is unreachable there. Build the command and its tests, list the exact command lines in the pull request's `[principal]` test-plan items, and leave the operator to run them on the host and add the resulting output.

**Why it exists:** four consecutive features once merged with green CI and were broken at runtime — a missing migration, a missing environment variable, a missing provider, an unexecuted test plan. The static gates ran and passed; the reviews read the diff; nobody booted the app. Verification is the phase that closes that gap.

### Refuse if it isn't your turn

- **No open PR** — nothing to verify; come back when one is open.
- **No `aeg:brief:v1` comment on the task Issue** — without a Test Plan there is no definition of "verified"; `vinaya task dispatch` posts the frozen brief comment first.
- **No Test Plan section in the brief** — the brief is malformed; flag it for correction and stop rather than inventing a plan at verification time.
- **The plan declares `unit-tests-only` but the diff touches a runtime surface** (a route, a page, a server action) — the brief was mis-declared; flag it for correction. This is the failsafe against quietly downgrading verification.

If the brief declares `unit-tests-only` and the diff really is pure logic, the phase is satisfied by the unit-test gate; record that as the outcome.

### The `[agent]` half — under the loop, the driver's; standalone, yours

**Under the automated dev-review loop, this already ran.** The driver's own per-round evidence report (see [§ After your turn — it ends here](#after-your-turn--it-ends-here)) executes the SAME §9 fenced command list, from the SAME PR head, into the SAME `AEG:EVIDENCE` block, the moment your head's CI turns green — every round, automatically.

**If you are working outside the loop** — dispatched by hand, with no driver watching this PR — the phase is still yours to run explicitly:

1. **Boot the app(s)** named in the brief from the worktree, and wait until each is reachable, if your §9 fenced commands need one running. If it does not boot, that is the failure — the plan never gets a chance to run.
2. **Run `vinaya pr report --push <n>`.** It executes every line in your §9 fenced command list from the PR head and writes each command plus its actual output into `AEG:EVIDENCE` — not a hand-pasted comment, not a checkbox tick. A command this tool did not run is not evidence. **Accepted risk, Principal default:** `pr report --push` executes the PR's own §9 commands on the machine running it, with no check of who is running it — only the PR's author runs it; nothing enforces that today.
3. **Stop there.** The `[principal]` items are not yours to execute; mark them as awaiting the Principal.

A failed `[agent]` command makes the PR unmergeable (`vinaya pr report`'s own exit code reflects it, and `evidence-fresh` binds the recorded output to the PR head). Fix on the same branch — under the loop, the next round's own automatic report overwrites the block with fresh output; standalone, re-run `vinaya pr report --push <n>` yourself — either way it overwrites, never appends a second copy.

### The `[principal]` half — not yours

The Principal executes the auth-gated, key-dependent and visual items in a browser and ticks those boxes. Never tick one because the `[agent]` items passed: they prove different properties. Never re-tag a `[principal]` item as `[agent]` to complete your half — that asymmetry is the whole point of the split, and erasing it is the failure this phase exists to prevent.

### What this phase does not do

It does not edit code (failures go back to you as the Developer), does not author tests (the plan comes from the brief), does not merge (only the Principal does), does not write status anywhere, and does not replace the code review or the security pass — a change can pass both and still be broken at runtime.

---

## Pre-merge gate

The merge waits on three conditions, which `review-gate` and `evidence-fresh` check in CI:

1. **Reviewer approved.** The PR carries an approving verdict — from a human, an installed review-bot GitHub App, or another agent.
2. **`[agent]` evidence fresh.** The `AEG:EVIDENCE` block's third group (the §9 fenced command list, run by `vinaya pr report`) matches a fresh recompute at the PR head.
3. **Principal confirmation.** The PR body's Test Plan section has no unchecked `- [ ] **[principal]**` lines.

Before any merge-adjacent action (commenting "MERGE", helping the Principal merge, or pushing a "fix CI" commit after review), read the three: under the review loop through `read_pull_request`; working manually through `gh pr view <n> --json reviews,statusCheckRollup,body`. If any is missing, say exactly which — your turn result under the loop, a PR comment working manually — and stop. The Principal decides what to do next.

---

## Anti-patterns

These are failures the Developer actively avoids. Several come from real incidents.

**Fallback approaches without proving the preferred approach is impossible.** If the brief says "use Library X," demonstrate X is impossible before switching to Y. Don't silently choose Y because it was easier.

**Editing docs to match broken implementations.** The implementation is broken; the doc is correct. Fix the implementation.

**Force-pushing without verifying merge will work (manual path).** Test with `git merge --dry-run` or open the PR first to see if there are conflicts.

**Pre-push verification that omits production build (manual path).** A dev-mode typecheck can pass while the production build fails under stricter resolution (e.g. a frozen-lockfile install). Run the production build too, where the repo has one.

**Reporting "all green" when you ran a subset of checks.** If you ran typecheck but not tests, say so. Don't round up. Partial verification plus a confident summary is how bugs reach main.

**Fabricating verification output.** This has happened. Report what a command actually printed — in `reportedChecks`, or a PR comment working manually — and elide long output openly rather than paraphrasing it.

**Marking items complete on a checklist without verification evidence.** A check means you ran the command and saw the expected output — not that you believe it should pass.

**Starting on the wrong branch (manual path).** Check `git branch` and `git log --oneline -3` before writing any code. Fix the branch before proceeding.
