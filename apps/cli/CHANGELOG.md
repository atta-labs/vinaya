# @attalabs/vinaya

## 0.19.2

### Patch Changes

- 8a75420: Adds `aeg-root/milestone-model.md` and `aeg-root/task-model.md` — the milestone concept (`0.19.0`) had shipped as code with zero conceptual documentation until now, and the task concept's coverage was fragmented across `tranche-model.md` and `process.md`. Fixes `tranche-model.md`'s stale "the top of AEG" claim (no longer true since the milestone layer shipped), and adds a **Flow stages** section to all three doctrine files — the operational sequence (who acts, what closes it), distinct from the derived-status vocabulary Studio displays.
- 8a75420: `resolveAgentVendors` treated a manifest whose `agents` key was never written (any install predating the agent-vendor feature) the same as an explicit `--agents=none` — both resolved to an empty Set. That meant `vinaya upgrade`/`doctor` would never add `.claude/commands/vinaya.md`, `.gemini/commands/vinaya.toml`, or `.agents/skills/` to a pre-existing install, no matter how many `upgrade` runs it went through — the only way to get them was to re-run `vinaya init --agents=all` by hand. Found live: attalabs' own installed copy silently never got these files.
  
  `undefined` (the key never existed) now defaults to every vendor — the same default `vinaya init` gives a fresh install — while an explicit `agents: []` from `--agents=none` is still respected exactly, never widened. `isDefaultedAgentVendorPath` gates the same distinction in `upgrade`'s file-ownership check, so both halves agree.
- 8a75420: `bundle-doctrine.ts`'s `FILES` allowlist never got `milestone-model.md`/`task-model.md` added when they shipped — publishing would have bundled `tranche-model.md` but not its two new siblings, while `skills/aeg/SKILL.md`'s reading order (which does ship) pointed adopters at both. Fixed, with a regression test that runs the real script against the real `aeg-root/` and asserts every non-excluded top-level doctrine file actually lands in the bundled output.

## 0.19.1

### Patch Changes

- 1f5e395: Add `.claude/commands/vinaya.md` emitter producing a parameterized `/vinaya <role>` Claude Code command
- 6057590: Wire the three agent-native emitters (`.agents/skills/`, `.claude/commands/`, `.gemini/commands/`) into `init`/`upgrade`/`eject`/`doctor`. Add `vinaya init --agents=<comma-list|all|none>` (default `all`) and persist the selection into `vinaya.config.json`'s `managed.agents` so `upgrade`/`doctor` read it back instead of re-deriving a default.
- 4347c56: A tranche adopted into a real Milestone (`vinaya milestone adopt`) could permanently read as `complete`
  system-wide, even with real open Issues, because the retired one-tranche Milestone `adopt` closes
  (never deletes, by design — its provenance survives) still title-matches the legacy 1:1 exception every
  tranche reader checks first. `matchesLegacyMilestone`'s "kept forever, no exception" rule was written
  for a Milestone that never changes underneath a slug — true for every pre-migration Milestone, false
  the moment `adopt` exists.
  
  Found live: `vinaya-agentic-interface-v1`'s legacy Milestone (`#7`) sat closed with zero native issues
  after adoption; its real Issues (two open) live under the new consolidated "Flows become files"
  Milestone via the `vinaya/tranche:vinaya-agentic-interface-v1` label. `findMilestoneForSlug`,
  `listActiveTrancheSlugs`, `listArchivedTrancheSlugs`, and `indexTrancheMilestonesAsync` all reported it
  `complete` — which made `verify-coherence.topology-move.test.ts`'s live-forge assertion (some tranche
  resolves active) fail repo-wide, since every adopted tranche in the repo hit the same shadow. That test
  gates `verify-task`, which `open-pr.ts` runs unconditionally — so no task-branch PR could open in this
  repo until this fixed.
  
  `resolveLegacyFacts` now checks the slug's `vinaya/tranche:<slug>`-labeled Issues before trusting a
  closed legacy Milestone's `state`: a non-empty label population is this tranche's real, current
  identity and wins over the (possibly stale) Milestone read. An empty label population — a genuinely
  historical, pre-label-model tranche, or a legacy Milestone nobody has adopted away from — still resolves
  from the Milestone's own `state`, exactly as before. All four readers now fetch that slug's Issues
  regardless of legacy status, which the async index runs concurrently with everything else it already
  fetches.
- 5ebf782: Registers `reader-resolvable-prose` and `retired-vocabulary` as real, adopter-runnable core checks
  (`coreCheckRegistry()`), so an installed `vinaya check --all` actually runs them instead of only this
  monorepo's own internal dev loop.
  
  `reader-resolvable-prose`'s three repo-specific inputs — doctrine root, reader-facing page globs, and
  the legacy-slug archive location — now come from `vinaya.config.json`'s new `proseGates` key, read fresh
  on every check run. Unset entirely, both checks keep this repo's own prior hardcoded shape
  (`doctrineRoot: "aeg-root"`, a dormant reader-facing sweep), so an existing install sees no change until
  it opts in. `retired-vocabulary` gives `retired-vocabulary.test.ts`'s genuinely-retired vocabulary scan
  (never its forge-number/tranche-slug citation half, which stays `reader-resolvable-prose`'s job) a
  CheckSpec adapter for the first time, scoped to `<doctrineRoot>/**`.
  
  Both ship report-only (a `warning` finding, exit code always `0`), same rollout precedent as the G1/G2
  gates — registering them cannot newly fail any existing install's CI.
  
  Also fixes a latent bug the registration surfaced: `check-reader-resolvable-prose.ts`'s
  `REPO_ROOT`/`process.chdir()` computed its OWN installed-package location rather than the caller's repo
  root, and both new checks' human-readable summary line printed to stderr — the CheckError JSON channel —
  which the runner reads any non-JSON line on as `status: 'error'` regardless of exit code. Neither bug was
  reachable before this task, since neither check had ever run outside this monorepo's own dev loop or
  through the check runner at all.

## 0.19.0

### Minor Changes

- a438d2b: A Milestone now means a product goal, not a tranche. Previously a GitHub Milestone and a tranche were
  1:1, matched by title — a Milestone could hold exactly one tranche and nothing wider. It now holds
  many:
  
  - `vinaya milestone create` — makes a real product-goal Milestone, with an optional `Release:` target
    version, gated by `checkMilestoneShape` before any forge write.
  - A tranche's lifecycle (`planned`/`active`/`complete`) derives from its `vinaya/tranche:<slug>` label
    and Issue set, not from a Milestone title — `fetchMilestone` no longer requires a Milestone to exist
    at all for a tranche to resolve. A Milestone titled exactly a known tranche slug still resolves the
    old way, so nothing existing needs migrating.
  - The **Architect** role — a goal in, an ordered list of tranche intents out. Invoked manually; it
    never cuts task Issues itself, that stays the Planner's job one altitude down.
  - `vinaya milestone adopt` — moves an existing tranche's Issues into a real Milestone and closes (never
    deletes) the retired one-tranche Milestone, refusing atomically before any write on an unknown slug,
    an empty tranche, a closed/missing target, or a slug already adopted elsewhere.
  
  No `managed.*` config key was added for this — creating a milestone is one `vinaya milestone create`
  call per milestone, run by hand, not a desired-state declaration for an installer to converge on.

### Patch Changes

- 52f1611: Dependency and conflict edges now resolve through one shared implementation, and a cross-tranche
  `#NNN` dependency is resolved rather than assumed unmerged.
  
  `vinaya check dispatch-readiness` and `vinaya check first-push-dispatch` each carried their own copy
  of the resolver, and both hardcoded `merged: false` for any cross-tranche reference — while a comment
  in each claimed parity with `verify-dispatch`, which resolves the same edge by looking the Issue up.
  The effect was terminal rather than conservative: a task carrying a cross-tranche dependency could
  never pass the blocking gate, however long ago that dependency merged, while `verify-dispatch`
  reported it ready. The two CLI checks now share `checks/edge-resolve.ts`, and a parity test pins the
  answers both sides must give.
  
  Merged means the Issue was closed **by a merged pull request**, not merely closed. An Issue closed
  `NOT_PLANNED` was abandoned and shipped nothing; it no longer satisfies a dependency gate.
  
  A conflict edge still reports `openOrInFlight: false` for a cross-tranche reference. A conflict
  matters only while a pull request is genuinely open, and Issue state is not evidence of one.
  
  A failed lookup — missing auth, network, rate limit, malformed response, `gh` absent — still resolves
  to unmerged, so a forge outage blocks. The lookup cache is keyed by repository and Issue number
  rather than by number alone.
- efb570a: `vinaya pr create`, `vinaya pr edit`, and `open-pr.ts` now run the `body-bare-digits` check before
  any forge write, instead of only in CI after the pull request already exists.
  
  `body-bare-digits` is one of four checks marked `requiresOpenPr` — the other three (`closes-n`,
  `test-plan`, `evidence-fresh`) genuinely need a PR number or PR comments and cannot run earlier. This
  one is a pure function of body text with no such excuse: a bare digit outside a fenced code block or
  an `AEG:*` anchor was always knowable before the write, and the gate ran anyway only in
  `pull_request_target` CI, after the body had already reached GitHub. Two of the four workflows re-fire
  on a body edit, so a check that could have refused locally instead cost a live CI run and a second
  edit to fix.
  
  `gatePlanForBranch` in `open-pr.ts` now includes `body-bare-digits` in the base plan for every branch,
  not only task branches — the check itself, not a branch condition, exempts
  `changeset-release/main`. `vinaya pr create` and `vinaya pr edit` refuse with the same
  `CheckError` shape either command already uses for `validateForgeWrite` failures, before the `gh`
  call.
  
  No behavior change to what counts as a violation — `checkBareDigits` itself is unchanged. The
  `tests/fixtures/forge/pr-valid.md` fixture, which predates this gate, carried a bare version number
  and a bare `Closes #385`; both are now backticked/anchored so the fixture still represents a body that
  should pass.

## 0.18.0

### Minor Changes

- 3755a6a: `vinaya studio` accepts `--port <n>`. Without it the existing behaviour is unchanged: bind `3008`, or fall back to `3108` when that is taken. With it, the named port is bound and a taken port is a **refusal** rather than a silent move to the fallback — because a caller who names a port is doing so to know which server answered, and quietly binding a different one destroys exactly the certainty they were buying. Measured while adding this: with two Studio servers running, one on `*:3008` and one on `127.0.0.1:3008`, a `200` from `/studio` proved nothing about which process served it without inspecting the established connection.
  
  The flag applies to a published install, where this CLI launches the bundled standalone server and owns the port. In a workspace checkout it is refused with an explanation: that path execs Studio's own dev script, which chooses its own port and ignores argv, so accepting the flag there would report a port the server never binds.
  
  Both spellings are accepted, `--port 3208` and `--port=3208`. A malformed value exits `2` without starting anything: nothing after the flag, a non-number, one outside `1`-`65535`, a leading zero (a probable typo, refused rather than normalised), or the flag given twice with different values (an unresolvable instruction, refused rather than resolved by precedence).
- 70e887e: `vinaya init product` no longer creates a `project:<name>` label, and no longer needs a GitHub remote or credentials. Project is a **field, not a label**: the `project:*` label family was retired, `declaredProjects` resolves a task's project from the Issue body's `**Project:**` field, and `list-tasks.ts` explicitly ignores a residual `project:*` label. The command's only forge-reaching op was therefore creating a label no shipped consumer reads, while making an otherwise purely local command require a remote — and, when none was configured, emit a warning about skipping work that did not need doing. What it writes is unchanged: the `.vinaya/projects.md` row, still deliberately outside the ownership manifest so `eject` never reverses adopter-declared data. Existing repos keep whatever `project:*` labels they already have; nothing deletes a forge label that may be in use elsewhere. Adopters relying on `project:*` for issue filtering should apply it themselves going forward.

### Patch Changes

- 8dd1802: Three surfaces where a verification tool could return a confident answer that was wrong.
  
  - `vinaya review post` refuses unknown flags. A misspelled flag was silently dropped, so
    `--print-only` — which does not exist — posted a real verdict.
  - A new gate refuses any tracked file that is binary to git. A source file invisible to
    `git grep` is a hole under every text-based verification in the repo.
  - A new gate reports a name declared in more than one non-test source file of
    `@attalabs/aeg-core`'s `src/`. Its reach is that directory — not the whole package, and
    not the repo.
- 6c0b848: `vinaya doctor` now reports when `briefSchema` has lost a builtin the shipped default declares, naming each absent one per kind (`briefSchema.pr`, `briefSchema.issue`). `briefSchema` is adopter-owned and `vinaya upgrade` correctly never rewrites it — but nothing else looked at it either, so a builtin deleted to work around a defect stayed deleted and stayed permanently invisible: no command surfaced it and no later upgrade repaired it. Found live where `closesN` was dropped to get an upgrade PR open at all, merged in that state, and left `closes-n` silently unenforced on every task branch afterwards. Ownership means vinaya must not overwrite the key, not that it cannot report on it; the two were conflated. The finding is `info` severity and never affects `vinaya doctor`'s exit code — running without a builtin is legitimate configuration, and the goal is to make the divergence visible once rather than argue an adopter back to a shape they rejected. Only absence relative to the shipped default is reported: extra sections, builtin or custom matcher, are additions and are never named. A new `briefSchema.ack` key lists builtins whose omission is deliberate and silences exactly those; it grants nothing, gates nothing, and an un-acked accidental deletion keeps surfacing.
- 3e76d50: `vinaya eject` now strips a `.git/hooks`-managed hook when run from a linked git worktree. Hooks are never per-worktree: the hook's real home is the main checkout's shared hooks directory (`git rev-parse --git-common-dir`), which from a linked worktree is legitimately outside that worktree's own root. `planEject`/`applyEject` bounded every recorded path with `containedAbs`, which requires containment inside the repo root — correct for the whole files vinaya owns, and wrong for a shared hook. The failure was quieter than a refusal: `containedAbs` ACCEPTED the block path, because `resolve()` never sees that a linked worktree's `.git` is a gitlink file, so `<repoRoot>/.git/hooks/pre-commit` is textually contained. It just named a file that does not exist there, so `eject` recorded it as already removed, printed `gone (managed block already removed)`, and exited 0 having stripped nothing — while the real hook stayed armed in the shared directory. An "ejected" install therefore reported success and left an active commit-time execution surface behind. Managed-block paths now go through `containedManagedBlockAbs`, which re-bases the rule rather than relaxing it: a `.git/`-prefixed block must resolve inside the git common dir's own `hooks/` subtree. For a canonically spelled path that is strictly tighter than the old rule in an ordinary checkout, where the repo's `.git` is itself the common dir — `.git/config` and `.git/objects/…` were previously "contained" and are now refused, since no managed block belongs outside `hooks/`. The `.git/` discriminator is byte-exact — case-sensitive, and requiring the trailing separator — so a non-canonical spelling such as `.GIT/…` or a bare `.git` still takes the working-tree branch and skips both the resolution and the bound; that is pre-existing, unreachable from any vinaya-generated manifest (whose block paths are always one of three lower-case literals), and tracked separately. `.husky/*` is unaffected and still bounded by the repo root, its directory being tracked and present in every worktree checkout.
- aeb03aa: `vinaya upgrade` now warns when a regenerated `.github/workflows/*.yml` file's trigger type is about to change (e.g. `pull_request` → `pull_request_target`), before the adopter pushes. GitHub evaluates a `pull_request`-triggered workflow from the PR branch's own file and a `pull_request_target`-triggered one from the base branch's file — a PR that crosses that boundary matches neither, so the resulting PR's required `vinaya review gate` check can never report, permanently blocking merge on a repo that enforces it as required. The warning is print-only guidance, same as the existing branch-protection and CODEOWNERS recommendations — `upgrade` still applies the change; only the adopter's blindness to its consequence was the bug.

## 0.17.1

### Patch Changes

- 0ee0056: Add `.agents/skills/` emitter producing role skill pointers for Codex, Antigravity, and Grok Build
- 0584f82: `body-bare-digits` is dormant again on the Changesets release PR (`changeset-release/main`) — safely this time. The exemption now runs only from a new `vinaya-body-checks.yml`, a `pull_request_target` workflow that checks out and executes only trusted default-branch code, the same boundary `vinaya-review.yml` already uses for the required review gate. `vinaya-checks.yml`'s ordinary `pull_request` job never runs `body-bare-digits` at all — that check is `ownWorkflow: true` — because that job runs the pull request's own copy of the workflow file, which cannot safely resolve the exemption's live-fetched PR author.
  
  A new `vinaya.config.json` field, `releaseActor`, lets an adopter whose release PRs are opened by a custom token (rather than the stock `changesets/action` + ambient `GITHUB_TOKEN` identity) configure the expected author — resolved the same way `principals` already is, from the default branch via the GitHub API, never from local git or an env var.
- 8681fea: `vinaya doctrine --role <name>` now excludes roles whose frontmatter declares `actor: human` (`principal`) from its live-enumerated valid set. Every `--role` consumer — the CLI itself, and the `.agents/skills/`/`.claude/commands/`/`.gemini/commands/` emitters that shell out to it — is fixed by this one change: a third-party AI tool can no longer be told to act as the human-only Principal role.
- 6e4de2b: `vinaya init`/`vinaya doctor` now recommend protecting `.github/workflows/**` with a `CODEOWNERS` entry, alongside the existing branch-protection recommendation — printed guidance only, never applied and never a suggested identity. `vinaya-review.yml`'s `pull_request_target` boundary loads workflow files from the default branch specifically so a PR cannot rewrite the check that judges it; an unreviewed edit to that file on the default branch itself defeats the same boundary from the other side. `doctor` gained a matching diagnostic reporting whether `.github/CODEOWNERS` covers `.github/workflows/**`.
- 10bef23: Run review-authority workflows exclusively from trusted default-branch source, while keeping pull-request content checks unprivileged.

## 0.17.0

### Minor Changes

- 6dfe0f5: `vinaya issue create`/`vinaya issue edit` now run the three Issue-only content checks `packages/aeg-core/bin/open-issue.ts` has always gated task Issues on — `checkBlastRadiusScope`, `checkNoBriefContent`, `checkRationaleNamesDocs` — which had never been wired into the published CLI's own reimplementation of that validation path. Every adopter using `@attalabs/vinaya` (not only this repo) previously had only the 14 section-presence checks enforced on `issue create`/`edit`; a task Issue could carry a fully-formed but factually wrong rationale (an under-declared blast radius, brief-shaped content copied into the Issue, a rationale naming no doc it actually read) and pass. These three now run, unconditionally, immediately after the existing rationale-presence gate, for any Issue carrying a `vinaya/tranche:*` label.
  
  **Also retires the legacy `.aeg/packages` static collision-domain file, in both packages, with zero backward compatibility.** `checkBlastRadiusScope`'s domain list (`readSharedPackages`, in `open-issue.ts` AND the new `apps/cli` equivalent this same change adds) is now exactly: live-derived `packages/*` workspace members, the built-in cross-cutting default set, and `vinaya.config.json`'s `blastRadius.extraDomains`. A present `.aeg/packages` file is no longer read by the check at all — `vinaya doctor` still diagnoses it as a migration checklist, but it contributes nothing live. Principal decision: no adopter outside our own control depends on it, and it's being removed from the one real external consumer (attalabs) in this same wave.

## 0.16.0

### Minor Changes

- acb6021: `checkBlastRadiusScope` no longer requires a hand-authored `.aeg/packages` file. Its collision-domain list now derives live from `package.json`'s `packages/*` workspace members, plus a built-in cross-cutting default set (whichever lockfile exists, `turbo.json`/`biome.json`/`tsconfig.json`, `.github/workflows`, `.husky`). A legacy `.aeg/packages` file, if present, still adds its entries on top — additive, never replaced. `vinaya.config.json` gains an optional `blastRadius.extraDomains: string[]` field for anything beyond the automatic sources (a `migrations/` folder, a codegen output dir). `vinaya doctor` reports a present `.aeg/packages` as deprecated, naming exactly which entries (if any) still need migrating.
- 285a7ba: `vinaya doctrine --role <name>` resolves straight to a specific role's doctrine (`aeg-root/roles/<name>.md`) under the same root `vinaya doctrine` (no flag) already resolves — the same `resolveDoctrineRoot()` logic, one new join applied after root resolution succeeds. The requested name is validated against the role names actually enumerated under `roles/*.md` at request time, never a hardcoded list, so an unknown name fails cleanly with the valid names listed rather than a silent bad path. This is the shared foundation every future per-agent-CLI doctrine wrapper (Claude Code, Codex, Gemini CLI, …) builds on top of.

## 0.15.0

### Minor Changes

- 1207b4f: `vinaya review post --role code-reviewer|security` renders, posts, and self-verifies a code-review or security-review verdict comment from structured flags (verdict, findings, per-field text) instead of a hand-typed comment. It resolves the PR's real head itself (`gh pr view --json headRefOid`), renders every structural `VERDICT:`/`Judged head:` line from validated inputs — never from caller-supplied text — refuses a contradictory verdict (a BLOCKER/CRITICAL-or-HIGH finding paired with a clean verdict) before posting anything, and after posting re-fetches the comment and refuses to exit 0 unless it re-parses clean through the exact `extractCodeReviewVerdict`/`extractSecurityReviewVerdict` functions the merge gate calls. Closes the gap where a Reviewer's free-typed markdown could produce a shape the gate's line-anchored parser silently can't see, caught only by CI going red minutes later with no pointer back to what was wrong.

## 0.14.0

### Minor Changes

- da64fd0: `vinaya doctor` now flags `.vinaya/doc-owners` bindings whose code glob matches no tracked file in the repo, or whose doc pointer doesn't exist on disk — both silent gaps the diff-scoped C5 gate structurally cannot see on its own, since a glob matching nothing trivially satisfies "did the docs change" for every diff. Report-only, like every other `doctor` diagnostic — it never mutates `.vinaya/doc-owners` and is not a `vinaya check` gate.

## 0.13.1

### Patch Changes

- 7d23b7f: `vinaya doctor` now reports when no workflow under `.github/workflows/` appears to invoke the repo's own `package.json` test script. Vinaya requires a Test Plan on every pull request and enforces it as a blocking gate, but had no visibility into whether anything actually runs the tests that plan claims to cover. The diagnostic is a narrow heuristic — a short literal list of test-invocation substrings, scanned across every workflow file, not only the four vinaya-generated ones — and reports at `warn`, never `error`; it accepts false negatives rather than trying to be exhaustive.

## 0.13.0

### Patch Changes

- 8b2f8b6: `vinaya check --json` previously truncated its payload at the reading pipe's buffer, because the process exited on top of a pending asynchronous stdout write — a file redirect never exposed it, since a file's stdout write is synchronous. Any consumer piping the output, `vinaya pr report` among them, received unparseable JSON above that buffer. The payload now drains before the process exits, with exit codes unchanged.
- 3a9ef15: **Breaking:** `checkReviewGate`'s `ReviewGateInput` gains a required `headSha` field — the PR's current head commit (`gh pr view --json headRefOid`). A caller that does not supply it no longer compiles; an optional field that silently skipped the binding check on absence would fail open, the exact defect this closes (#73). `VerdictExtraction` gains `headSha: string | null`, parsed from a same-comment `Judged head: <sha>` line with the same anchor discipline as the `VERDICT:` marker itself (abbreviated or full sha, blockquote/list/heading/code-span excluded). `checkReviewGate` now requires both the code-review and security-review verdicts to be clean AND bound to the current head — a verdict that predates a later push, or carries no `Judged head:` line at all, fails the gate, naming both the verdict's sha and the current head. Every verdict already posted on an open PR carries no such binding and is fail-closed by this change: re-cast the verdict at the PR's current head, or a principal can apply the actor-verified `vinaya/waiver:review` label as a one-PR transition escape. `aeg-root/roles/reviewer.md` and `roles/security.md`'s `VERDICT:` output block both gain the `Judged head: <sha>` line.

## 0.12.0

### Minor Changes

- 4018b71: New `vinaya pr report --write <body-file>` emits the `AEG:EVIDENCE` block — a PR body's head sha, a width-invariant `git diff --numstat`, and the result of `vinaya check --all --diff-only` — from commands, never typed by hand. The new `evidence-fresh` core check refuses a PR body whose block doesn't match the head it's attached to: it recomputes and exact-compares the diff stat (closing fabrication for that fact) and checks the attested gate run for staleness only, against the PR's real head resolved via `gh` (never `HEAD`, which is the merge commit in CI). `ANCHOR_FIELDS` gains `EVIDENCE`; `aeg-root/templates/pr-report-template.md` and `aeg-root/roles/developer.md` both route their PR-body "evidence" section through the new anchor instead of free text.

### Patch Changes

- 5f3ed65: `Doc-neutral:` now clears a fired C5 doc-coverage binding in the merge-blocking check, not only in `verify-docs`. `evaluateC5` verifies the declaration by reading the matched file's diff, and both check bins called it without that argument — so the gate's own failure message instructed the user to declare `Doc-neutral:` while that declaration could never succeed in CI. Both bins now pass a shared per-file diff closure, against the ref that actually produced the changed-file list rather than the requested base (both re-resolve to `main` when `origin/main` yields nothing).

## 0.11.0

### Minor Changes

- dae964d: **⚠️ BREAKING BEHAVIOUR CHANGE — `vinaya check` now executes what the resolver decides. Read this before upgrading: a `vinaya.config.json` that worked yesterday can refuse to run anything today.**
  
  `vinaya check`'s execution moves off the flat `core + config` concat and onto the resolver that has fed `vinaya check --plan` since 0.9.0. Three behaviour changes land together:
  
  1. **Replace semantics.** A `checks` key that exactly matches a core check id now **REPLACES** that core check. Previously both ran — the core one and yours, under the same name, producing two conclusions. The core check no longer runs at all.
  
  2. **Namespace rejection.** A bare, un-namespaced key that matches no core check id is now **REJECTED**. Every non-override key must be `<yourname>/<id>`, with both segments matching `[a-z0-9][a-z0-9-]*` and `vinaya` reserved as a prefix. **Adding a prefix is not always enough:** if the bare name itself breaks that grammar — `my_check` (underscore), `QALint` (uppercase) — it still breaks it after prefixing, and needs a real rename.
  
  3. **`FAIL_CLOSED` is live.** A malformed `checks` entry or a rejected bare key now makes the whole run **refuse**: exit 1, loud, with **nothing executed**. Before this release, an invalid config still ran the core checks; after it, nothing runs. There is no `--skip-broken` escape hatch and no core-only fallback — a partially-applied ruleset that still prints green is exactly what this refuses to produce.
  
  **This can break an adopter's CI.** That is intended — an invalid registration silently running a subset of your gates is the failure mode being closed — but it means the upgrade is not a no-op for any repo whose `checks` block is not already clean.
  
  **Before upgrading, run `vinaya check --plan` on 0.9.0.** It prints the exact resolution this release executes: every `FAIL_CLOSED` row it shows is a run that will now refuse, and every `overridden` row is a core check that will now stop running. `--plan` and execution read the same resolution, so what the plan prints is what runs.
  
  **Diagnosing a refused config.** The two grace-period warnings 0.9.0 printed from `vinaya check` are gone from check output — a refused run prints its refusal instead. They live on permanently as `vinaya doctor` diagnostics: the override class at `warn`, the rejected-bare-key class at `error`, naming the rename requirement. A config that now runs nothing is still fully diagnosable through `vinaya doctor`.

## 0.10.0

### Minor Changes

- 264a8ae: The repo-wide coherence sweep stops re-fetching forge data it already holds. `verify-coherence.ts`'s `loadTrancheFiles` derived each tranche independently, so a repo with N Milestones paid N re-pulls of the entire Milestone list plus N serial `gh issue list` calls, and L4/L5 then re-issued those same N Issue queries a second time for the `milestone` field a `Tranche` drops. The sweep now enumerates every tranche first, indexes Milestones once (`indexTrancheMilestonesAsync`), fetches each tranche's labeled Issues exactly once at a bounded concurrency of 4, and derives both the task list and L4's Milestone-attachment facts from that single response. Measured against `atta-labs/vinaya` (6 Milestones): 21 `gh` calls and 26.4 s become 7 and 9.5 s, with byte-identical report JSON — the derivation, the checks, and the verdict are unchanged, only the round trips are gone. New `@attalabs/aeg-forge-state` exports for callers that hold forge data already: `indexTrancheMilestonesAsync`, `fetchTrancheIssuesAsync`, `trancheFromIssues`, `tasksFromIssues`, `issueMilestonesFromIssues`, and the `TrancheMilestoneIndex`/`GhIssue` types. Every existing export keeps its signature and behaviour. `indexTrancheMilestonesAsync` is paginated via the new `ghApiGetAllPagesAsync`: Milestones are append-only, so the single `per_page=100` page the older readers use is a countdown rather than a bound, and silent truncation in the index a repo-wide sweep enumerates from would drop tranches from every check with no error. The sweep also keys its Milestone fill-in on which tranches were actually produced rather than which were enumerated, so a PR that deletes or archives a topology file can no longer narrow the sweep — the deletion case fell through to a forge derivation as before, and an archival move (`tranches/x.md` to `tranches/completed/x.md`) keeps the PR head's own content and its `archived` flag. Forge unavailability is reported rather than thrown or absorbed, on every path: a lost Milestone index refuses the run when nothing local can be enumerated, and withholds L4/L5 — whose only active-tranche authority it is — when topology files keep the sweep non-empty, rather than letting an empty authority read as "no drift"; a per-tranche read that fails with no file to stand in names the omitted slugs. `ghApiGetAllPagesAsync` sets `per_page` itself rather than trusting the caller's path, because the page size IS its stop condition, and refuses to walk past a page ceiling instead of looping without bound. The sweep's two git readers now spawn `git` with an argv array rather than interpolating a ref and a path into a shell string: one of those paths is assembled from a Milestone title, so through a shell a title carrying a command substitution executed, while as one argv element it is only a filename git fails to resolve — which both readers already treat as absent.

### Patch Changes

- 6e3cf0f: The four generated workflows now invoke `npx --yes @attalabs/vinaya@<exact-installed-version>`, the same exact-version pin the generated git hooks already carried and from the same source (`ownVersion()`). Previously they emitted a bare `npx --yes @attalabs/vinaya`, which reads as "always latest" and is not: where `vinaya-checks.yml` carries an install step — which it does only when the adopter declares `ci.setup` — a repo carrying the CLI as a devDependency resolved `node_modules/.bin/vinaya` instead of the registry, measured as `0.8.2` inside such an adopter repo against `0.9.0` in `/tmp`. There, CI's version was an accident of a dependency no workflow referenced, and changing that dependency moved CI to registry latest with no commit and no diff. An adopter declaring no `ci.setup` gets no install step at all, so for them a bare spec resolved registry latest in all four workflows. The generated workflows are managed artifacts, so `vinaya upgrade` rewrites an existing install's unpinned workflows to the pinned shape and re-pins them on each version bump; `vinaya doctor` reports a stale pin as drift. The git hooks are unchanged.
- 32a01e2: The shipped token-report doctrine no longer names a host tool's script as the requirement. `aeg-root/tranche-model.md` §12 now states the obligation as three layers — every role reports its own turn's usage (portable), collected by whatever means its host offers (host-specific), into the `Tokens: …` grammar in the artifact its turn produced (portable) — so an adopter on any harness implements only the middle layer and inherits the rest unchanged. The role docs (`developer.md`, `archivist.md`, `planner.md`, `reviewer.md`, `security.md`, `tranche-archivist.md`), `state-machine.md` and `enforcement.md`'s registry row now cite `bin/report-tokens.ts` as *the Claude Code way* to satisfy collection rather than as the rule. The taxonomy that split roles by Anthropic product name ("terminal roles run in Claude Code" vs "claude.ai roles run in chat") is replaced by the capability it was actually describing: **self-metering** (the host exposes the session's own usage to the agent) vs **operator-metered** (it does not), both defined in `glossary.md`. Per-cell `—` optionality is now conditioned on that host capability rather than on the role, and `state-machine.md`'s stale, already-retracted `(terminal: /cost)` claim is gone.
  
  The obligation itself is unchanged and is not weakened: reporting stays mandatory, `—` stays sanctioned only where a host exposes no usage to the agent at all, and the no-estimate rules carry forward in substance, restated as one capability-conditioned rule rather than two role-specific ones.
  
  `@attalabs/aeg-core` gains `src/claude-code-transcript.ts`, which now homes `summarizeTranscript` — it parses one vendor's transcript JSONL and its `usage` field names, so it was never portable despite living beside the portable renderers. `TranscriptSummary` is now documented as the adapter seam: an adapter's whole contract is to produce that shape, and everything downstream of it (`formatTokensLine`, `parse-token-report.ts`'s grammar) is shared by every host. No exported name, type or behaviour changes — `summarizeTranscript` is still exported from the package root. `bin/report-tokens.ts` gains a declared `--transcript <path>` flag (previously reachable only by accident, as a bare positional) and reframes its missing-pointer error: naming your own transcript is a supported primary route, and a repo that installs no `track-transcript.sh` Stop hook — this one included — is not misconfigured for lacking a pointer file.

## 0.9.0

### Minor Changes

- 7d939d8: `vinaya studio` now launches for real in a published install. `bundle-studio.ts` fetches attalabs' CI-built standalone Studio bundle from its public release artifact (`atta-labs/attalabs`'s `vinaya-studio-artifact.yml` workflow, no token required) and assembles it into `studio-standalone/` at `prepack` time, instead of requiring a Studio source tree this repository never had. The default ports move from `3006`/`3106` (the retired `apps/vinaya/web`'s ports) to `3008`/`3108` (matching `apps/vinaya-studio/web`'s own docs). `packages/sources/src/commands.ts`'s `studio` row and `verify-published-lifecycle.ts`'s `studio` exercise both now describe and assert a real launch instead of the prior honest refusal.

## 0.8.2

### Patch Changes

- 9d730e1: Fix the `doc-coverage` check so an applied `vinaya/waiver:docs` label actually takes effect. It previously read `PR_LABELS`/`WAIVER_LABEL_ACTOR` from the environment, expecting the CI workflow to inject them — but no generated `vinaya-checks.yml`, old or current, ever set either var, so the waiver path was silently unreachable in every adopter's CI (caught live on atta-labs/attalabs#948). The check now resolves the label and its labeling actor live via `gh`, from `PR_NUMBER`, the same way `review-gate` already does — no workflow template change needed, and every already-generated `vinaya-checks.yml` is fixed in place.

## 0.8.1

### Patch Changes

- 30dc300: Recognize a hand-closed dependency Issue as valid when it was closed directly by a recognized Principal identity (verified via GitHub's own `ClosedEvent` actor, not claimed in prose), instead of only accepting a merged closing PR. `dispatch-gate` and `coherence` check A1 both gain this second, narrower recognition path — the default merged-PR path is unchanged.

## 0.8.0

### Minor Changes

- 9cfa0c7: Recover the `vinaya studio` command the extraction dropped.
  
  Four files (`commands/studio.ts`, `lib/studio-bundle.ts`, `scripts/bundle-studio.ts`, `tests/studio.test.ts`) lived at `apps/vinaya/cli/**` in the attalabs monorepo. The extraction moved the CLI to this repository without them, and attalabs then deleted the directory they were in — the command survived only in that repo's history, absent from both repos, the router, and the published tarball, with no gate noticing.
  
  They are recovered here against the two-repo reality: Studio's source (`apps/vinaya/web`) stayed in attalabs, so the workspace branch of `resolveStudioTarget` serves only checkouts that carry that tree, and no published build bundles the standalone Studio app. Rather than fixing import paths and shipping a command that resolves nothing, the recovered command refuses explicitly (exit 1, message naming the package) in every shape it cannot yet serve. `bundle-studio.ts` is recovered as pack-shape knowledge but deliberately not wired into `prepack` or the `files` allowlist — producing and shipping the bundle is the separate Studio-packaging task, so the published artifact's contents are unchanged.
  
  `@atta/vinaya-sources` gains the matching `studio` row in the `COMMANDS` registry, with an honest description of what the command does and does not yet do; `verify-published-lifecycle.ts` exercises the refusal for real against the packed artifact.

## 0.7.1

## 0.7.0

### Minor Changes

- a0d413a: Adopter-declared CI setup: a new optional `ci.setup` key in `vinaya.config.json`, emitted verbatim as an "Adopter CI setup" step in the generated workflows that execute `vinaya check` (checks, review, review-verdict — never the archivist, whose jobs spawn no adopter code).
  
  The generated jobs previously installed node and nothing else — correct for vinaya's own checks, which arrive whole via `npx`, and fatal for an adopter's custom checks, which are scripts in the adopter's own repository that may import the adopter's own code. Measured on the first non-greenfield adopter: both of its custom checks failed as `error (2ms)` spawn failures on every CI run while passing in the local hooks, turning a required check permanently red.
  
  The command is declared in the committed config, never inferred — vinaya cannot know an adopter's package manager or runtime. When the key is absent, the generated workflows are byte-identical to before it existed, so existing installs see no churn. Note for repos that do declare it: the generated workflows are managed artifacts, so the next `vinaya upgrade` after declaring the key rewrites their bytes — that is the intended delivery path, not drift.
  
  `@atta/vinaya-sources` gains the matching `ci` / `ci.setup` rows in the adopter-facing config reference.

## 0.6.0

### Minor Changes

- 7d074ac: Add `vinaya doctrine` — prints the absolute path of the bundled doctrine's front door (`aeg-root/skills/aeg/SKILL.md`), resolved at read time on the caller's own machine (`--json` for the enveloped `{ root, entry }` form) — and make the committed `VINAYA.md` doctrine pointer machine-independent: it now names the `@attalabs/vinaya` package and hands the reader that command, instead of interpolating the installing machine's absolute install path into committed content. The old shape broke for every clone but the installer's (and for the installer on their next upgrade, since npx's cache key rotates with the version), published the installing user's home directory into the repo, and made `doctor` report drift on every machine except the one that ran `init`. Existing adopters see one-time managed-file drift on `VINAYA.md` at their next `doctor`, and a rewrite on their next `upgrade` — the drift being reported is the machine-local path this release removes.
- edd7c17: Ring 0 now survives a clone (atta-labs/attalabs#927). Non-husky installs write git hooks into a TRACKED `.vinaya/hooks/` directory routed via `git config core.hooksPath .vinaya/hooks` instead of the unversioned `.git/hooks` — hook files travel with the repo into every clone and every linked worktree checkout, where before a fresh clone silently had zero ring-0 enforcement while the manifest still claimed the hooks existed.
  
  What changes for adopters:
  
  - **New installs** (`vinaya init`, no husky, no active raw `.git/hooks` hooks): hooks land in `.vinaya/hooks/` (commit them) and the installing clone is armed automatically. Each FRESH clone runs `git config core.hooksPath .vinaya/hooks` once — the one thing git cannot version. `vinaya doctor` reports an unarmed clone as an error and names that exact command; `vinaya upgrade` also arms it.
  - **Existing `.git/hooks` installs**: the next `vinaya upgrade` migrates — tracked copies land first, legacy hosts are stripped, the config is armed, and the manifest's hook paths are rewritten. The migration REFUSES (and says why, and `doctor` keeps warning) whenever arming would silently disable hooks vinaya does not own: adopter lines in a hook host, or any unmanaged active raw hook in `.git/hooks`.
  - **Husky installs**: unchanged.
  - **`vinaya eject`**: also unsets `core.hooksPath` when it still points at vinaya's own tracked dir.
  - The managed-manifest version bumps 1 → 2 (shape unchanged) so an older package meeting a migrated manifest refuses loudly instead of half-understanding the recorded hook locations.

### Patch Changes

- 562408b: Name the failing check on the run's Summary page of the generated Vinaya Checks workflow.
  
  The workflow's one aggregate check reports only "vinaya check --all --diff-only: failing" — it never says which of the registered checks failed, forcing a trip into the raw log. The generated job now tees the runner's per-check stdout (the `✓/·/✗ name: status` lines plus each finding's message) into a file, and a follow-up step appends it, fenced, to `$GITHUB_STEP_SUMMARY`.
  
  Two guards are load-bearing: `set -o pipefail` before the tee, because the job's default shell is `bash -e` without pipefail and an unguarded pipe would report a red suite green; and the summary step runs on `!cancelled()` rather than `always()`, because the concurrency group cancels superseded runs routinely and their half-captured output is noise. Both the published (`npx`) and vendored (`node <bin>`) shapes get the same capture.
- e3379ee: Correct `aeg-root/enforcement.md`'s ring-table implementation pointers to the mechanisms that actually run in a vinaya-governed repo — the managed `.git/hooks/pre-commit`/`pre-push` blocks, the validated `vinaya issue|pr` forge-write commands, the required review-gate check, and the `vinaya-*.yml` workflows — instead of the attalabs-only `.husky/*`, `.claude/hooks/*`, and `forge-lifecycle.yml` paths, which do not exist in an adopter repo (measured live by the `registry-gates` G1 check during the first tranche cut natively in atta-labs/vinaya). `aeg-root/` ships in the published tarball, so the stale pointers were the account every adopter got.
  
  Also records, in `apps/cli/specs/self-hosting.md` (unpublished), what that first forge-native walk measured: the authoring-time vs CI brief-shape divergence, the file-topology phrasing still present in some refusal text and baselines, and the Planner-surface gap (no CLI path for Milestone or tranche-label creation).
- 9fde689: Fix `vinaya upgrade` crashing (`ENOTDIR`) when run from inside a linked git worktree (atta-labs/attalabs#942) — it now resolves git-hook paths through `git rev-parse --git-common-dir`, the same fix `vinaya doctor` already had, lifted into a shared resolver both (and `init`, `quickstart`, `demo break`) now call.
  
  Every AEG-style adopter that develops in linked worktrees hit this: a worktree's `.git` is a gitlink file, not a directory, so the old `join(repoRoot, '.git/hooks/…')` tried to `mkdir` under a file and aborted the whole upgrade before any other managed artifact (e.g. the doctrine pointer) was written. Hooks are never actually per-worktree — every linked worktree shares the primary checkout's hooks directory — so the fix resolves the real shared path instead of guessing wrong and crashing.

## 0.5.0

### Minor Changes

- d4a12db: Remove the `vinaya studio` command and its bundled Studio assets from the published CLI.
  
  `studio` was a documented command in the README's command table. An adopter
  running it after upgrading now gets an unknown command — that is a breaking
  change for anyone using it, not an internal cleanup. The published tarball
  also shrinks from ~85.7 MB to ~743 kB as a direct result. Bumped `minor`
  rather than `patch`: pre-1.0 semver convention treats `minor` as the
  breaking-change slot, and a silent `patch` would misrepresent the removal's
  impact.
  
  Also bundled in this release, since none of it has been published yet:
  
  - Fix: resolve the vendored CLI correctly in generated git hooks
  - Fix: address code-review findings from the Studio-removal PR
  - Fix: make the reader-facing no-op sentinel structurally safe
  - Feat: add Changesets with a fixed-group cascade (the mechanism that
    produced this release)
