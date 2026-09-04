# @atta/vinaya-sources

## 0.24.1

### Patch Changes

- Updated dependencies [dfbaa8e]
  - @attalabs/aeg-core@0.24.1
  - @attalabs/aeg-forge-state@0.24.1
  - @attalabs/aeg-types@0.24.1

## 0.24.0

### Patch Changes

- Updated dependencies [d79cf8e]
- Updated dependencies [c0eb05c]
- Updated dependencies [c7fb1c4]
- Updated dependencies [b8e3aaa]
- Updated dependencies [f6b1d26]
- Updated dependencies [f100d0b]
- Updated dependencies [6408682]
- Updated dependencies [be6c61d]
- Updated dependencies [539e3f0]
  - @attalabs/aeg-core@0.24.0
  - @attalabs/aeg-forge-state@0.24.0
  - @attalabs/aeg-types@0.24.0

## 0.23.0

### Patch Changes

- 12b7e33: **Breaking:** `checkReviewGate`'s `ReviewGateInput` gains a required `mechanicalChecks: MechanicalCheckStatus[]` field — every check-run reported for the PR's current head, excluding the caller's own review-gate check-run. A caller that does not supply it no longer compiles, the same required-not-optional discipline `headSha` already established (#73): an optional field that silently skipped the mechanical-check requirement on absence would fail open. `checkReviewGate` now also requires every reported mechanical check to be green (`bucket === 'pass'`) — an empty array does not count as clean, since there is no proof to point to. A red or absent mechanical check fails the gate the same way an unclean or unbound verdict does, naming which check is not green, or that none have reported yet. The `vinaya/waiver:review` label still short-circuits to pass unconditionally, regardless of mechanical-check state. Both `apps/cli/src/checks/bin/check-review-gate.ts` and `packages/aeg-core/bin/verify-review-gate.ts` now fetch check-run status via `gh pr checks --json name,bucket`, filtering out their own review-gate check-run name before calling in — that exclusion lives in the CLI shims, not in `aeg-core`'s pure logic, since `aeg-core` ships to every adopter under a different workflow name.
- Updated dependencies [dc803fb]
- Updated dependencies [12b7e33]
- Updated dependencies [e579bec]
  - @attalabs/aeg-core@0.23.0
  - @attalabs/aeg-forge-state@0.23.0
  - @attalabs/aeg-types@0.23.0

## 0.22.0

### Patch Changes

- Updated dependencies [36d69e7]
- Updated dependencies [089517a]
  - @attalabs/aeg-core@0.22.0
  - @attalabs/aeg-forge-state@0.22.0
  - @attalabs/aeg-types@0.22.0

## 0.21.0

### Minor Changes

- 448942a: `vinaya.config.json` gains an optional `projects` array — a config-native home for project metadata (`name`/`description?`/`path?`), alongside `.vinaya/projects.md` rather than instead of it. `vinaya init product <name>` now appends an entry here at the same time it appends the registry row, through the same plan/confirm diff discipline. `vinaya doctor` reports (at `info` severity, never an error) when a registry row and a `projects` entry name the same project but only one of the two exists.
  
  Additive only: an existing `vinaya.config.json` with no `projects` key still validates unchanged, and no gate or resolver reads this key — it is display metadata only.
- 9cf5409: New command: `vinaya pr verify-evidence <n>` — proves a pull request's
  `AEG:EVIDENCE` region was machine-generated, by regenerating the report against
  the working tree and comparing.
  
  `evidence-fresh` closes fabrication for Group A by recomputing the diff stat and
  byte-comparing it, but its own docstring records that a Group B section which was
  never actually run is not detected — only a stale one is. It cannot do more:
  `evidence-fresh` is registered in `coreCheckRegistry()` and `pr report` runs
  `vinaya check --all --diff-only`, so a check that regenerated the block would run
  the suite containing itself. This command lives outside the registry, which is
  what lets it close that gap without the recursion.
  
  The region is resolved through `resolveAnchoredRegion` — the shared masked
  resolver — never a raw `indexOf`, so a decoy anchor pair inside a fence or a
  collapsed `<details>` block cannot be certified while every other gate reads the
  real one. A pair that survives only inside `<details>` reports `HIDDEN` rather
  than being treated as absent: nothing can verify a block whose digits
  `body-bare-digits` blanks.
  
  Comparison is a multiset of repo-relative, control-stripped lines. Absolute
  paths are stripped for both the local root and a foreign one, so a block
  generated in CI compares against one generated on a laptop; C0 control
  characters are removed before any line is compared or echoed, so a body cannot
  repaint a terminal or a CI log with forged verdict text; line order is ignored,
  because a reorder is not a fabrication.
  
  A moved merge-base is reported alongside the differing lines, never instead of
  them, and the base is read only from the Group A command line's own anchored
  shape — an earlier revision let one planted `git diff a...b --numstat` line
  anywhere in the region short-circuit to an exoneration.
  
  The head is read from the forge and a mismatch refuses, and the checkout must be
  clean: Group B is regenerated by diff-scoped checks, so uncommitted or untracked
  files change which files are scanned and can produce a MATCH a clean checkout
  would not. Ignored paths are deliberately not inspected — `git diff` never
  reports one, so they cannot change the scope.
  
  Exits 0 on MATCH; 1 on DIFFERS, HIDDEN, or no block; 2 on a refusal.

### Patch Changes

- 9cf5409: `pr verify-evidence` now refuses unless run from the repository root.
  
  The regeneration inherits the process working directory — `buildReport()` spawns
  the gate suite with `cwd: process.cwd()` — and several gates resolve their scan
  root from it. Run from a subdirectory there is no `aeg-root/` above them, so
  `reader-resolvable-prose` collects nothing and `registry-gates` reports itself
  dormant: an entire class of findings vanishes from the regenerated Group B with
  no error, and a published block with exactly those findings deleted compares
  MATCH.
  
  Two reviewers demonstrated it independently at the same head, on a clean tree
  with the correct head and no `BASE_SHA`. A fabricated block reported DIFFERS
  naming every deleted warning from the repository root, and MATCH from
  `apps/cli`. Only the working directory changed.
  
  The command already pinned its `git status` check to the repository root, with a
  comment saying a subdirectory invocation must not narrow what is inspected. That
  reasoning had been applied to the cheap half and not to the half that decides the
  verdict.
  
  It refuses rather than changing directory: a silent `chdir` would make the
  command quietly do something other than what the caller asked, and a refusal
  cannot manufacture a MATCH — the failure direction that matters here.
- Updated dependencies [64a85ca]
- Updated dependencies [21ccea4]
- Updated dependencies [4c0f755]
- Updated dependencies [a97e483]
- Updated dependencies [aaa21c3]
- Updated dependencies [b0e8078]
- Updated dependencies [b0e8078]
- Updated dependencies [b0e8078]
- Updated dependencies [b0e8078]
- Updated dependencies [b0e8078]
  - @attalabs/aeg-core@0.21.0
  - @attalabs/aeg-forge-state@0.21.0
  - @attalabs/aeg-types@0.21.0

## 0.20.1

### Patch Changes

- cee19e1: Adds a `files` allowlist to all four packages that previously had none, so `npm pack`/`npm publish`
  ships only each package's real entry-point surface instead of the whole working directory (`#180`).
  `aeg-core` no longer ships its `bin/` CLI scripts, `*.test.ts` files, or `src/fixtures/**`; the other
  three drop their `*.test.ts` files. Test fixtures for all four packages — including `aeg-forge-state`'s
  six verbatim internal Issue-body fixtures and `aeg-core`'s `docs-coherence` synthetic doctrine trees —
  move from `src/fixtures/` to a `tests/fixtures/` directory beside the suites that read them, so the
  disclosure is closed by relocation regardless of the allowlist. No behavior change for any real import:
  each package's documented entry point and named sub-exports were proven to resolve from a fresh
  `npm install` of the packed tarball outside this workspace.
- Updated dependencies [cee19e1]
  - @attalabs/aeg-core@0.20.1
  - @attalabs/aeg-forge-state@0.20.1
  - @attalabs/aeg-types@0.20.1

## 0.20.0

### Patch Changes

- Updated dependencies [47dc992]
  - @attalabs/aeg-core@0.20.0
  - @attalabs/aeg-forge-state@0.20.0
  - @attalabs/aeg-types@0.20.0

## 0.19.3

### Patch Changes

- 705dbfe: Adds a `commit-msg` hook to the managed-artifact set, enforcing this repo's `Type(scope):
  Description` commit convention. `vinaya init`/`vinaya upgrade` now install a third managed hook
  beside `pre-commit`/`pre-push`; `vinaya eject` removes it the same way. The commit-type vocabulary
  is exported from `@attalabs/aeg-core` as `COMMIT_TYPE_STYLE`/`COMMIT_TYPES` — the same list
  `checkForgeTitle` already enforced on PR/Issue titles.
- 2adcf5a: Wires `vinaya.config.json`'s `rings.ring1_forgeWriteInterception` and `rings.ring2_asyncAudits` into real enforcement — until now `rings` had exactly one live consumer (Studio's diagram renderer) and zero CLI-behavior consumers, despite every `vinaya init` starter config already shipping both keys.
  
  Additive, never disabling: `false`/absent is a no-op — every existing adopter's enforcement runs exactly as it does today, unchanged by upgrading. `true` is the new opt-in accelerator, the only value that changes behavior. `ring1_forgeWriteInterception: true` skips `pr`/`issue`/`milestone create|edit`'s `briefSchema` validation entirely. `ring2_asyncAudits: true` skips `vinaya archive`'s provenance work and `vinaya audit`'s dead-branch-push notification — deliberately not `vinaya audit`'s direct-main-push detection, which stays unconditional regardless of the flag: it is a real pass/fail that catches a branch-protection bypass, and a config-readable on/off switch for it would let the bypass silently disable the check that catches it.
- Updated dependencies [705dbfe]
- Updated dependencies [a5f6097]
  - @attalabs/aeg-core@0.19.3
  - @attalabs/aeg-forge-state@0.19.3
  - @attalabs/aeg-types@0.19.3

## 0.19.2

### Patch Changes

- @attalabs/aeg-core@0.19.2
  - @attalabs/aeg-forge-state@0.19.2
  - @attalabs/aeg-types@0.19.2

## 0.19.1

### Patch Changes

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
- Updated dependencies [4347c56]
- Updated dependencies [5ebf782]
  - @attalabs/aeg-forge-state@0.19.1
  - @attalabs/aeg-core@0.19.1
  - @attalabs/aeg-types@0.19.1

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

- Updated dependencies [a438d2b]
- Updated dependencies [efb570a]
  - @attalabs/aeg-core@0.19.0
  - @attalabs/aeg-forge-state@0.19.0
  - @attalabs/aeg-types@0.19.0

## 0.18.0

### Minor Changes

- 3755a6a: `vinaya studio` accepts `--port <n>`. Without it the existing behaviour is unchanged: bind `3008`, or fall back to `3108` when that is taken. With it, the named port is bound and a taken port is a **refusal** rather than a silent move to the fallback — because a caller who names a port is doing so to know which server answered, and quietly binding a different one destroys exactly the certainty they were buying. Measured while adding this: with two Studio servers running, one on `*:3008` and one on `127.0.0.1:3008`, a `200` from `/studio` proved nothing about which process served it without inspecting the established connection.
  
  The flag applies to a published install, where this CLI launches the bundled standalone server and owns the port. In a workspace checkout it is refused with an explanation: that path execs Studio's own dev script, which chooses its own port and ignores argv, so accepting the flag there would report a port the server never binds.
  
  Both spellings are accepted, `--port 3208` and `--port=3208`. A malformed value exits `2` without starting anything: nothing after the flag, a non-number, one outside `1`-`65535`, a leading zero (a probable typo, refused rather than normalised), or the flag given twice with different values (an unresolvable instruction, refused rather than resolved by precedence).
- 70e887e: `vinaya init product` no longer creates a `project:<name>` label, and no longer needs a GitHub remote or credentials. Project is a **field, not a label**: the `project:*` label family was retired, `declaredProjects` resolves a task's project from the Issue body's `**Project:**` field, and `list-tasks.ts` explicitly ignores a residual `project:*` label. The command's only forge-reaching op was therefore creating a label no shipped consumer reads, while making an otherwise purely local command require a remote — and, when none was configured, emit a warning about skipping work that did not need doing. What it writes is unchanged: the `.vinaya/projects.md` row, still deliberately outside the ownership manifest so `eject` never reverses adopter-declared data. Existing repos keep whatever `project:*` labels they already have; nothing deletes a forge label that may be in use elsewhere. Adopters relying on `project:*` for issue filtering should apply it themselves going forward.

### Patch Changes

- 6c0b848: `vinaya doctor` now reports when `briefSchema` has lost a builtin the shipped default declares, naming each absent one per kind (`briefSchema.pr`, `briefSchema.issue`). `briefSchema` is adopter-owned and `vinaya upgrade` correctly never rewrites it — but nothing else looked at it either, so a builtin deleted to work around a defect stayed deleted and stayed permanently invisible: no command surfaced it and no later upgrade repaired it. Found live where `closesN` was dropped to get an upgrade PR open at all, merged in that state, and left `closes-n` silently unenforced on every task branch afterwards. Ownership means vinaya must not overwrite the key, not that it cannot report on it; the two were conflated. The finding is `info` severity and never affects `vinaya doctor`'s exit code — running without a builtin is legitimate configuration, and the goal is to make the divergence visible once rather than argue an adopter back to a shape they rejected. Only absence relative to the shipped default is reported: extra sections, builtin or custom matcher, are additions and are never named. A new `briefSchema.ack` key lists builtins whose omission is deliberate and silences exactly those; it grants nothing, gates nothing, and an un-acked accidental deletion keeps surfacing.
- Updated dependencies [f93674c]
- Updated dependencies [c844163]
- Updated dependencies [70e887e]
  - @attalabs/aeg-core@0.18.0
  - @attalabs/aeg-forge-state@0.18.0
  - @attalabs/aeg-types@0.18.0

## 0.17.1

### Patch Changes

- @attalabs/aeg-core@0.17.1
  - @attalabs/aeg-forge-state@0.17.1
  - @attalabs/aeg-types@0.17.1

## 0.17.0

### Patch Changes

- 6dfe0f5: `vinaya issue create`/`vinaya issue edit` now run the three Issue-only content checks `packages/aeg-core/bin/open-issue.ts` has always gated task Issues on — `checkBlastRadiusScope`, `checkNoBriefContent`, `checkRationaleNamesDocs` — which had never been wired into the published CLI's own reimplementation of that validation path. Every adopter using `@attalabs/vinaya` (not only this repo) previously had only the 14 section-presence checks enforced on `issue create`/`edit`; a task Issue could carry a fully-formed but factually wrong rationale (an under-declared blast radius, brief-shaped content copied into the Issue, a rationale naming no doc it actually read) and pass. These three now run, unconditionally, immediately after the existing rationale-presence gate, for any Issue carrying a `vinaya/tranche:*` label.
  
  **Also retires the legacy `.aeg/packages` static collision-domain file, in both packages, with zero backward compatibility.** `checkBlastRadiusScope`'s domain list (`readSharedPackages`, in `open-issue.ts` AND the new `apps/cli` equivalent this same change adds) is now exactly: live-derived `packages/*` workspace members, the built-in cross-cutting default set, and `vinaya.config.json`'s `blastRadius.extraDomains`. A present `.aeg/packages` file is no longer read by the check at all — `vinaya doctor` still diagnoses it as a migration checklist, but it contributes nothing live. Principal decision: no adopter outside our own control depends on it, and it's being removed from the one real external consumer (attalabs) in this same wave.
- Updated dependencies [6dfe0f5]
  - @attalabs/aeg-core@0.17.0
  - @attalabs/aeg-forge-state@0.17.0
  - @attalabs/aeg-types@0.17.0

## 0.16.0

### Patch Changes

- acb6021: `checkBlastRadiusScope` no longer requires a hand-authored `.aeg/packages` file. Its collision-domain list now derives live from `package.json`'s `packages/*` workspace members, plus a built-in cross-cutting default set (whichever lockfile exists, `turbo.json`/`biome.json`/`tsconfig.json`, `.github/workflows`, `.husky`). A legacy `.aeg/packages` file, if present, still adds its entries on top — additive, never replaced. `vinaya.config.json` gains an optional `blastRadius.extraDomains: string[]` field for anything beyond the automatic sources (a `migrations/` folder, a codegen output dir). `vinaya doctor` reports a present `.aeg/packages` as deprecated, naming exactly which entries (if any) still need migrating.
- Updated dependencies [acb6021]
  - @attalabs/aeg-core@0.16.0
  - @attalabs/aeg-forge-state@0.16.0
  - @attalabs/aeg-types@0.16.0

## 0.15.0

### Patch Changes

- 1207b4f: `vinaya review post --role code-reviewer|security` renders, posts, and self-verifies a code-review or security-review verdict comment from structured flags (verdict, findings, per-field text) instead of a hand-typed comment. It resolves the PR's real head itself (`gh pr view --json headRefOid`), renders every structural `VERDICT:`/`Judged head:` line from validated inputs — never from caller-supplied text — refuses a contradictory verdict (a BLOCKER/CRITICAL-or-HIGH finding paired with a clean verdict) before posting anything, and after posting re-fetches the comment and refuses to exit 0 unless it re-parses clean through the exact `extractCodeReviewVerdict`/`extractSecurityReviewVerdict` functions the merge gate calls. Closes the gap where a Reviewer's free-typed markdown could produce a shape the gate's line-anchored parser silently can't see, caught only by CI going red minutes later with no pointer back to what was wrong.
- @attalabs/aeg-core@0.15.0
  - @attalabs/aeg-forge-state@0.15.0
  - @attalabs/aeg-types@0.15.0

## 0.14.0

### Patch Changes

- da64fd0: `vinaya doctor` now flags `.vinaya/doc-owners` bindings whose code glob matches no tracked file in the repo, or whose doc pointer doesn't exist on disk — both silent gaps the diff-scoped C5 gate structurally cannot see on its own, since a glob matching nothing trivially satisfies "did the docs change" for every diff. Report-only, like every other `doctor` diagnostic — it never mutates `.vinaya/doc-owners` and is not a `vinaya check` gate.
- Updated dependencies [da64fd0]
  - @attalabs/aeg-core@0.14.0
  - @attalabs/aeg-forge-state@0.14.0
  - @attalabs/aeg-types@0.14.0

## 0.13.1

### Patch Changes

- 7d23b7f: `vinaya doctor` now reports when no workflow under `.github/workflows/` appears to invoke the repo's own `package.json` test script. Vinaya requires a Test Plan on every pull request and enforces it as a blocking gate, but had no visibility into whether anything actually runs the tests that plan claims to cover. The diagnostic is a narrow heuristic — a short literal list of test-invocation substrings, scanned across every workflow file, not only the four vinaya-generated ones — and reports at `warn`, never `error`; it accepts false negatives rather than trying to be exhaustive.
- Updated dependencies [7d23b7f]
  - @attalabs/aeg-core@0.13.1
  - @attalabs/aeg-forge-state@0.13.1
  - @attalabs/aeg-types@0.13.1

## 0.13.0

### Patch Changes

- 8b2f8b6: `vinaya check --json` previously truncated its payload at the reading pipe's buffer, because the process exited on top of a pending asynchronous stdout write — a file redirect never exposed it, since a file's stdout write is synchronous. Any consumer piping the output, `vinaya pr report` among them, received unparseable JSON above that buffer. The payload now drains before the process exits, with exit codes unchanged.
- 3a9ef15: **Breaking:** `checkReviewGate`'s `ReviewGateInput` gains a required `headSha` field — the PR's current head commit (`gh pr view --json headRefOid`). A caller that does not supply it no longer compiles; an optional field that silently skipped the binding check on absence would fail open, the exact defect this closes (#73). `VerdictExtraction` gains `headSha: string | null`, parsed from a same-comment `Judged head: <sha>` line with the same anchor discipline as the `VERDICT:` marker itself (abbreviated or full sha, blockquote/list/heading/code-span excluded). `checkReviewGate` now requires both the code-review and security-review verdicts to be clean AND bound to the current head — a verdict that predates a later push, or carries no `Judged head:` line at all, fails the gate, naming both the verdict's sha and the current head. Every verdict already posted on an open PR carries no such binding and is fail-closed by this change: re-cast the verdict at the PR's current head, or a principal can apply the actor-verified `vinaya/waiver:review` label as a one-PR transition escape. `aeg-root/roles/reviewer.md` and `roles/security.md`'s `VERDICT:` output block both gain the `Judged head: <sha>` line.
- Updated dependencies [8b2f8b6]
- Updated dependencies [3a9ef15]
  - @attalabs/aeg-core@0.13.0
  - @attalabs/aeg-forge-state@0.13.0
  - @attalabs/aeg-types@0.13.0

## 0.12.0

### Patch Changes

- 5f3ed65: `Doc-neutral:` now clears a fired C5 doc-coverage binding in the merge-blocking check, not only in `verify-docs`. `evaluateC5` verifies the declaration by reading the matched file's diff, and both check bins called it without that argument — so the gate's own failure message instructed the user to declare `Doc-neutral:` while that declaration could never succeed in CI. Both bins now pass a shared per-file diff closure, against the ref that actually produced the changed-file list rather than the requested base (both re-resolve to `main` when `origin/main` yields nothing).
- 4018b71: New `vinaya pr report --write <body-file>` emits the `AEG:EVIDENCE` block — a PR body's head sha, a width-invariant `git diff --numstat`, and the result of `vinaya check --all --diff-only` — from commands, never typed by hand. The new `evidence-fresh` core check refuses a PR body whose block doesn't match the head it's attached to: it recomputes and exact-compares the diff stat (closing fabrication for that fact) and checks the attested gate run for staleness only, against the PR's real head resolved via `gh` (never `HEAD`, which is the merge commit in CI). `ANCHOR_FIELDS` gains `EVIDENCE`; `aeg-root/templates/pr-report-template.md` and `aeg-root/roles/developer.md` both route their PR-body "evidence" section through the new anchor instead of free text.
- Updated dependencies [5f3ed65]
- Updated dependencies [4018b71]
  - @attalabs/aeg-core@0.12.0
  - @attalabs/aeg-forge-state@0.12.0
  - @attalabs/aeg-types@0.12.0

## 0.11.0

### Patch Changes

- @attalabs/aeg-core@0.11.0
  - @attalabs/aeg-forge-state@0.11.0
  - @attalabs/aeg-types@0.11.0

## 0.10.0

### Minor Changes

- 264a8ae: The repo-wide coherence sweep stops re-fetching forge data it already holds. `verify-coherence.ts`'s `loadTrancheFiles` derived each tranche independently, so a repo with N Milestones paid N re-pulls of the entire Milestone list plus N serial `gh issue list` calls, and L4/L5 then re-issued those same N Issue queries a second time for the `milestone` field a `Tranche` drops. The sweep now enumerates every tranche first, indexes Milestones once (`indexTrancheMilestonesAsync`), fetches each tranche's labeled Issues exactly once at a bounded concurrency of 4, and derives both the task list and L4's Milestone-attachment facts from that single response. Measured against `atta-labs/vinaya` (6 Milestones): 21 `gh` calls and 26.4 s become 7 and 9.5 s, with byte-identical report JSON — the derivation, the checks, and the verdict are unchanged, only the round trips are gone. New `@attalabs/aeg-forge-state` exports for callers that hold forge data already: `indexTrancheMilestonesAsync`, `fetchTrancheIssuesAsync`, `trancheFromIssues`, `tasksFromIssues`, `issueMilestonesFromIssues`, and the `TrancheMilestoneIndex`/`GhIssue` types. Every existing export keeps its signature and behaviour. `indexTrancheMilestonesAsync` is paginated via the new `ghApiGetAllPagesAsync`: Milestones are append-only, so the single `per_page=100` page the older readers use is a countdown rather than a bound, and silent truncation in the index a repo-wide sweep enumerates from would drop tranches from every check with no error. The sweep also keys its Milestone fill-in on which tranches were actually produced rather than which were enumerated, so a PR that deletes or archives a topology file can no longer narrow the sweep — the deletion case fell through to a forge derivation as before, and an archival move (`tranches/x.md` to `tranches/completed/x.md`) keeps the PR head's own content and its `archived` flag. Forge unavailability is reported rather than thrown or absorbed, on every path: a lost Milestone index refuses the run when nothing local can be enumerated, and withholds L4/L5 — whose only active-tranche authority it is — when topology files keep the sweep non-empty, rather than letting an empty authority read as "no drift"; a per-tranche read that fails with no file to stand in names the omitted slugs. `ghApiGetAllPagesAsync` sets `per_page` itself rather than trusting the caller's path, because the page size IS its stop condition, and refuses to walk past a page ceiling instead of looping without bound. The sweep's two git readers now spawn `git` with an argv array rather than interpolating a ref and a path into a shell string: one of those paths is assembled from a Milestone title, so through a shell a title carrying a command substitution executed, while as one argv element it is only a filename git fails to resolve — which both readers already treat as absent.

### Patch Changes

- 6e3cf0f: The four generated workflows now invoke `npx --yes @attalabs/vinaya@<exact-installed-version>`, the same exact-version pin the generated git hooks already carried and from the same source (`ownVersion()`). Previously they emitted a bare `npx --yes @attalabs/vinaya`, which reads as "always latest" and is not: where `vinaya-checks.yml` carries an install step — which it does only when the adopter declares `ci.setup` — a repo carrying the CLI as a devDependency resolved `node_modules/.bin/vinaya` instead of the registry, measured as `0.8.2` inside such an adopter repo against `0.9.0` in `/tmp`. There, CI's version was an accident of a dependency no workflow referenced, and changing that dependency moved CI to registry latest with no commit and no diff. An adopter declaring no `ci.setup` gets no install step at all, so for them a bare spec resolved registry latest in all four workflows. The generated workflows are managed artifacts, so `vinaya upgrade` rewrites an existing install's unpinned workflows to the pinned shape and re-pins them on each version bump; `vinaya doctor` reports a stale pin as drift. The git hooks are unchanged.
- 32a01e2: The shipped token-report doctrine no longer names a host tool's script as the requirement. `aeg-root/tranche-model.md` §12 now states the obligation as three layers — every role reports its own turn's usage (portable), collected by whatever means its host offers (host-specific), into the `Tokens: …` grammar in the artifact its turn produced (portable) — so an adopter on any harness implements only the middle layer and inherits the rest unchanged. The role docs (`developer.md`, `archivist.md`, `planner.md`, `reviewer.md`, `security.md`, `tranche-archivist.md`), `state-machine.md` and `enforcement.md`'s registry row now cite `bin/report-tokens.ts` as *the Claude Code way* to satisfy collection rather than as the rule. The taxonomy that split roles by Anthropic product name ("terminal roles run in Claude Code" vs "claude.ai roles run in chat") is replaced by the capability it was actually describing: **self-metering** (the host exposes the session's own usage to the agent) vs **operator-metered** (it does not), both defined in `glossary.md`. Per-cell `—` optionality is now conditioned on that host capability rather than on the role, and `state-machine.md`'s stale, already-retracted `(terminal: /cost)` claim is gone.
  
  The obligation itself is unchanged and is not weakened: reporting stays mandatory, `—` stays sanctioned only where a host exposes no usage to the agent at all, and the no-estimate rules carry forward in substance, restated as one capability-conditioned rule rather than two role-specific ones.
  
  `@attalabs/aeg-core` gains `src/claude-code-transcript.ts`, which now homes `summarizeTranscript` — it parses one vendor's transcript JSONL and its `usage` field names, so it was never portable despite living beside the portable renderers. `TranscriptSummary` is now documented as the adapter seam: an adapter's whole contract is to produce that shape, and everything downstream of it (`formatTokensLine`, `parse-token-report.ts`'s grammar) is shared by every host. No exported name, type or behaviour changes — `summarizeTranscript` is still exported from the package root. `bin/report-tokens.ts` gains a declared `--transcript <path>` flag (previously reachable only by accident, as a bare positional) and reframes its missing-pointer error: naming your own transcript is a supported primary route, and a repo that installs no `track-transcript.sh` Stop hook — this one included — is not misconfigured for lacking a pointer file.
- Updated dependencies [264a8ae]
- Updated dependencies [6e3cf0f]
- Updated dependencies [32a01e2]
  - @attalabs/aeg-forge-state@0.10.0
  - @attalabs/aeg-core@0.10.0
  - @attalabs/aeg-types@0.10.0

## 0.9.0

### Patch Changes

- 7d939d8: `vinaya studio` now launches for real in a published install. `bundle-studio.ts` fetches attalabs' CI-built standalone Studio bundle from its public release artifact (`atta-labs/attalabs`'s `vinaya-studio-artifact.yml` workflow, no token required) and assembles it into `studio-standalone/` at `prepack` time, instead of requiring a Studio source tree this repository never had. The default ports move from `3006`/`3106` (the retired `apps/vinaya/web`'s ports) to `3008`/`3108` (matching `apps/vinaya-studio/web`'s own docs). `packages/sources/src/commands.ts`'s `studio` row and `verify-published-lifecycle.ts`'s `studio` exercise both now describe and assert a real launch instead of the prior honest refusal.
- Updated dependencies [7d939d8]
  - @attalabs/aeg-core@0.9.0
  - @attalabs/aeg-forge-state@0.9.0
  - @attalabs/aeg-types@0.9.0

## 0.8.2

### Patch Changes

- 9d730e1: Fix the `doc-coverage` check so an applied `vinaya/waiver:docs` label actually takes effect. It previously read `PR_LABELS`/`WAIVER_LABEL_ACTOR` from the environment, expecting the CI workflow to inject them — but no generated `vinaya-checks.yml`, old or current, ever set either var, so the waiver path was silently unreachable in every adopter's CI (caught live on atta-labs/attalabs#948). The check now resolves the label and its labeling actor live via `gh`, from `PR_NUMBER`, the same way `review-gate` already does — no workflow template change needed, and every already-generated `vinaya-checks.yml` is fixed in place.
- Updated dependencies [9d730e1]
  - @attalabs/aeg-core@0.8.2
  - @attalabs/aeg-forge-state@0.8.2
  - @attalabs/aeg-types@0.8.2

## 0.8.1

### Patch Changes

- 30dc300: Recognize a hand-closed dependency Issue as valid when it was closed directly by a recognized Principal identity (verified via GitHub's own `ClosedEvent` actor, not claimed in prose), instead of only accepting a merged closing PR. `dispatch-gate` and `coherence` check A1 both gain this second, narrower recognition path — the default merged-PR path is unchanged.
- Updated dependencies [30dc300]
  - @attalabs/aeg-core@0.8.1
  - @attalabs/aeg-forge-state@0.8.1
  - @attalabs/aeg-types@0.8.1

## 0.8.0

### Minor Changes

- 9cfa0c7: Recover the `vinaya studio` command the extraction dropped.
  
  Four files (`commands/studio.ts`, `lib/studio-bundle.ts`, `scripts/bundle-studio.ts`, `tests/studio.test.ts`) lived at `apps/vinaya/cli/**` in the attalabs monorepo. The extraction moved the CLI to this repository without them, and attalabs then deleted the directory they were in — the command survived only in that repo's history, absent from both repos, the router, and the published tarball, with no gate noticing.
  
  They are recovered here against the two-repo reality: Studio's source (`apps/vinaya/web`) stayed in attalabs, so the workspace branch of `resolveStudioTarget` serves only checkouts that carry that tree, and no published build bundles the standalone Studio app. Rather than fixing import paths and shipping a command that resolves nothing, the recovered command refuses explicitly (exit 1, message naming the package) in every shape it cannot yet serve. `bundle-studio.ts` is recovered as pack-shape knowledge but deliberately not wired into `prepack` or the `files` allowlist — producing and shipping the bundle is the separate Studio-packaging task, so the published artifact's contents are unchanged.
  
  `@atta/vinaya-sources` gains the matching `studio` row in the `COMMANDS` registry, with an honest description of what the command does and does not yet do; `verify-published-lifecycle.ts` exercises the refusal for real against the packed artifact.

### Patch Changes

- @atta/aeg-core@0.8.0
  - @atta/aeg-forge-state@0.8.0
  - @atta/aeg-types@0.8.0

## 0.7.1

### Patch Changes

- 334c9d4: The four engine packages are now publicly published: `private: true` dropped, `publishConfig.access: "public"` added, and `.changeset/config.json`'s `privatePackages.tag` flipped to `true`. First public versions of `@atta/aeg-core`, `@atta/aeg-types`, `@atta/aeg-forge-state` and `@atta/vinaya-sources` ship on the next `changeset publish`, alongside `@attalabs/vinaya` as the same fixed-group version.
- Updated dependencies [334c9d4]
  - @atta/aeg-core@0.7.1
  - @atta/aeg-types@0.7.1
  - @atta/aeg-forge-state@0.7.1

## 0.7.0

### Minor Changes

- a0d413a: Adopter-declared CI setup: a new optional `ci.setup` key in `vinaya.config.json`, emitted verbatim as an "Adopter CI setup" step in the generated workflows that execute `vinaya check` (checks, review, review-verdict — never the archivist, whose jobs spawn no adopter code).
  
  The generated jobs previously installed node and nothing else — correct for vinaya's own checks, which arrive whole via `npx`, and fatal for an adopter's custom checks, which are scripts in the adopter's own repository that may import the adopter's own code. Measured on the first non-greenfield adopter: both of its custom checks failed as `error (2ms)` spawn failures on every CI run while passing in the local hooks, turning a required check permanently red.
  
  The command is declared in the committed config, never inferred — vinaya cannot know an adopter's package manager or runtime. When the key is absent, the generated workflows are byte-identical to before it existed, so existing installs see no churn. Note for repos that do declare it: the generated workflows are managed artifacts, so the next `vinaya upgrade` after declaring the key rewrites their bytes — that is the intended delivery path, not drift.
  
  `@atta/vinaya-sources` gains the matching `ci` / `ci.setup` rows in the adopter-facing config reference.

### Patch Changes

- @atta/aeg-core@0.7.0
  - @atta/aeg-forge-state@0.7.0
  - @atta/aeg-types@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [6a3f006]
- Updated dependencies [dbb8acd]
  - @atta/aeg-core@0.6.0
  - @atta/aeg-forge-state@0.6.0
  - @atta/aeg-types@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [d4a12db]
  - @atta/aeg-core@0.5.0
  - @atta/aeg-forge-state@0.5.0
  - @atta/aeg-types@0.5.0
