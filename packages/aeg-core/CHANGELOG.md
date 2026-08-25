# @atta/aeg-core

## 0.19.2

### Patch Changes

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
- Updated dependencies [4347c56]
  - @attalabs/aeg-forge-state@0.19.1
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
- Updated dependencies [a438d2b]
  - @attalabs/aeg-forge-state@0.19.0
  - @attalabs/aeg-types@0.19.0

## 0.18.0

### Minor Changes

- f93674c: Every governance gate under `packages/aeg-core/bin/` now declares who it is for, and a test fails the build when one does not. Membership of the adopter-facing set was previously defined by ABSENCE from `coreCheckRegistry()`, so a deliberate exclusion and a forgotten port left exactly the same trace — nothing could tell "adopters should not run this" from "we forgot to ship it". `GATE_AUDIENCE` makes the second column something you have to say, with a reason: `{ shippedAs: '<core check name>' }` for gates adopters run, `{ internal: '<why not>' }` for the ones this repo keeps to itself, and a separate `NON_GATE_BINS` list for the forge writers and reporters in that directory that are not gates at all. Adding a file to `bin/` and nothing else is now a failing test that names it. Deliberately not a field on `CheckSpec`: adopter-defined checks in `vinaya.config.json` produce that same shape, so an audience field there would push an internal-governance question into adopter config, where it cannot be answered.
  
  Covers both sides of the boundary. `GATE_AUDIENCE` accounts for every bin under `packages/aeg-core/bin/`, and `SHIPPED_BIN_AUDIENCE` for every executable under `apps/cli/src/checks/bin/` — both asserted in the CLI's own suite, where `coreCheckRegistry()` is in scope, so a `shippedAs` naming a check that does not exist fails a test rather than being trusted. The shipped side is where the motivating case actually lives: `reader-resolvable-prose` has no bin in aeg-core at all, so an aeg-core-only enumeration would never have seen the exclusion it was built to make visible. Both enumerations walk recursively and accept `.ts`/`.mts`/`.cts`, because a gate whose enumeration is narrower than the directory it guards has a door in the back.
  
  Both enumerations refuse a symlink rather than skipping it. `readdirSync(dir, { withFileTypes: true })` reports a symlink-to-directory as `isDirectory() === false`, so an unfollowed symlink fell through to the extension filters and was dropped in silence — a symlinked directory holding an undeclared gate passed both suites green. The `shippedAs` validation iterates the two maps separately rather than spreading them into one, because the namespaces overlap and a spread let the second map shadow the first, dropping the shadowed entry's declaration from validation entirely.

### Patch Changes

- c844163: `verify-dispatch`'s baseline no longer reports a healthy `verify-coherence` as `UNAVAILABLE (tool failed to run)`. It captured the child's stdout and stderr and concatenated them before `JSON.parse`, on the stated premise that neither tool writes to stderr on its clean `--json` path. That premise was false: `verify-coherence` probes `aeg-root/tranches` and `aeg-root/tranches/completed` off the base ref, the forge-native cutover deleted those directories — `no-disk-state.ts` now actively forbids re-adding one — so `git` prints a `fatal:` line per probe while the tool itself exits 0 with correct results. One such line made the parse throw, and every dispatch check reported the oracle as dead. The two streams are now kept apart and each caller reads the one its own parse needs: `verify-coherence` is parsed, so it reads stdout alone; `verify-docs` is line-counted, so it still scans both and a finding printed to stderr still counts. Separately, the two probes in `verify-coherence` that legitimately miss on every healthy run now silence the child's stderr rather than letting an expected absence print a `fatal:` line the caller has to parse around. The load-bearing consequence is not the cosmetic line: concatenation made a genuinely crashed run and a chatty healthy one indistinguishable, so the field could no longer surface the thing it exists to surface — an unparseable stdout is still reported `UNAVAILABLE`, and there is now a test pinning that.
  
  Two further changes to the same baseline, both adopter-visible. The reported count is now validated as a **shape**, not merely as parseable JSON — a scalar, an array, or an object without a numeric non-negative `summary.failed` reads as `UNAVAILABLE` rather than throwing a `TypeError` on property access, which splitting the streams had newly made reachable. And a sweep that ran but could not reach the forge (`forgeUnavailable`) is now `UNAVAILABLE` too: its checks evaluate against only the tranches it could see, so `failed` is a smaller number arrived at honestly, and comparing it as a finding count under-reports. Before the streams were split an outage happened to fail closed, because it also wrote to stderr and the concatenated parse threw; this restores that on purpose.
  
  **This can make `verify-dispatch --check-baseline` refuse where it previously compared** — a forge outage, or a malformed report, now blocks the comparison instead of scoring it. That is the intended direction (an unavailable tool carries no honest count), but it is a behaviour change for anyone running that mode. The gate-mode baseline is informational and unaffected in verdict, only in what it prints.
  
  The `UNAVAILABLE` line no longer claims "tool failed to run", because that is now sometimes false — a forge-degraded run *did* run. It reads "no usable finding count", and the accompanying diagnostic says which of the two happened. Diagnostics from the child are surfaced rather than dropped, and one over `300` characters is marked as truncated instead of ending mid-token.
- Updated dependencies [70e887e]
  - @attalabs/aeg-forge-state@0.18.0
  - @attalabs/aeg-types@0.18.0

## 0.17.1

### Patch Changes

- @attalabs/aeg-forge-state@0.17.1
  - @attalabs/aeg-types@0.17.1

## 0.17.0

### Minor Changes

- 6dfe0f5: `vinaya issue create`/`vinaya issue edit` now run the three Issue-only content checks `packages/aeg-core/bin/open-issue.ts` has always gated task Issues on — `checkBlastRadiusScope`, `checkNoBriefContent`, `checkRationaleNamesDocs` — which had never been wired into the published CLI's own reimplementation of that validation path. Every adopter using `@attalabs/vinaya` (not only this repo) previously had only the 14 section-presence checks enforced on `issue create`/`edit`; a task Issue could carry a fully-formed but factually wrong rationale (an under-declared blast radius, brief-shaped content copied into the Issue, a rationale naming no doc it actually read) and pass. These three now run, unconditionally, immediately after the existing rationale-presence gate, for any Issue carrying a `vinaya/tranche:*` label.
  
  **Also retires the legacy `.aeg/packages` static collision-domain file, in both packages, with zero backward compatibility.** `checkBlastRadiusScope`'s domain list (`readSharedPackages`, in `open-issue.ts` AND the new `apps/cli` equivalent this same change adds) is now exactly: live-derived `packages/*` workspace members, the built-in cross-cutting default set, and `vinaya.config.json`'s `blastRadius.extraDomains`. A present `.aeg/packages` file is no longer read by the check at all — `vinaya doctor` still diagnoses it as a migration checklist, but it contributes nothing live. Principal decision: no adopter outside our own control depends on it, and it's being removed from the one real external consumer (attalabs) in this same wave.

### Patch Changes

- @attalabs/aeg-forge-state@0.17.0
  - @attalabs/aeg-types@0.17.0

## 0.16.0

### Minor Changes

- acb6021: `checkBlastRadiusScope` no longer requires a hand-authored `.aeg/packages` file. Its collision-domain list now derives live from `package.json`'s `packages/*` workspace members, plus a built-in cross-cutting default set (whichever lockfile exists, `turbo.json`/`biome.json`/`tsconfig.json`, `.github/workflows`, `.husky`). A legacy `.aeg/packages` file, if present, still adds its entries on top — additive, never replaced. `vinaya.config.json` gains an optional `blastRadius.extraDomains: string[]` field for anything beyond the automatic sources (a `migrations/` folder, a codegen output dir). `vinaya doctor` reports a present `.aeg/packages` as deprecated, naming exactly which entries (if any) still need migrating.

### Patch Changes

- @attalabs/aeg-forge-state@0.16.0
  - @attalabs/aeg-types@0.16.0

## 0.15.0

### Patch Changes

- @attalabs/aeg-forge-state@0.15.0
  - @attalabs/aeg-types@0.15.0

## 0.14.0

### Patch Changes

- da64fd0: `vinaya doctor` now flags `.vinaya/doc-owners` bindings whose code glob matches no tracked file in the repo, or whose doc pointer doesn't exist on disk — both silent gaps the diff-scoped C5 gate structurally cannot see on its own, since a glob matching nothing trivially satisfies "did the docs change" for every diff. Report-only, like every other `doctor` diagnostic — it never mutates `.vinaya/doc-owners` and is not a `vinaya check` gate.
- Updated dependencies [da64fd0]
  - @attalabs/aeg-forge-state@0.14.0
  - @attalabs/aeg-types@0.14.0

## 0.13.1

### Patch Changes

- 7d23b7f: `vinaya doctor` now reports when no workflow under `.github/workflows/` appears to invoke the repo's own `package.json` test script. Vinaya requires a Test Plan on every pull request and enforces it as a blocking gate, but had no visibility into whether anything actually runs the tests that plan claims to cover. The diagnostic is a narrow heuristic — a short literal list of test-invocation substrings, scanned across every workflow file, not only the four vinaya-generated ones — and reports at `warn`, never `error`; it accepts false negatives rather than trying to be exhaustive.
- Updated dependencies [7d23b7f]
  - @attalabs/aeg-forge-state@0.13.1
  - @attalabs/aeg-types@0.13.1

## 0.13.0

### Minor Changes

- 3a9ef15: **Breaking:** `checkReviewGate`'s `ReviewGateInput` gains a required `headSha` field — the PR's current head commit (`gh pr view --json headRefOid`). A caller that does not supply it no longer compiles; an optional field that silently skipped the binding check on absence would fail open, the exact defect this closes (#73). `VerdictExtraction` gains `headSha: string | null`, parsed from a same-comment `Judged head: <sha>` line with the same anchor discipline as the `VERDICT:` marker itself (abbreviated or full sha, blockquote/list/heading/code-span excluded). `checkReviewGate` now requires both the code-review and security-review verdicts to be clean AND bound to the current head — a verdict that predates a later push, or carries no `Judged head:` line at all, fails the gate, naming both the verdict's sha and the current head. Every verdict already posted on an open PR carries no such binding and is fail-closed by this change: re-cast the verdict at the PR's current head, or a principal can apply the actor-verified `vinaya/waiver:review` label as a one-PR transition escape. `aeg-root/roles/reviewer.md` and `roles/security.md`'s `VERDICT:` output block both gain the `Judged head: <sha>` line.

### Patch Changes

- 8b2f8b6: `vinaya check --json` previously truncated its payload at the reading pipe's buffer, because the process exited on top of a pending asynchronous stdout write — a file redirect never exposed it, since a file's stdout write is synchronous. Any consumer piping the output, `vinaya pr report` among them, received unparseable JSON above that buffer. The payload now drains before the process exits, with exit codes unchanged.
- Updated dependencies [8b2f8b6]
- Updated dependencies [3a9ef15]
  - @attalabs/aeg-forge-state@0.13.0
  - @attalabs/aeg-types@0.13.0

## 0.12.0

### Patch Changes

- 5f3ed65: `Doc-neutral:` now clears a fired C5 doc-coverage binding in the merge-blocking check, not only in `verify-docs`. `evaluateC5` verifies the declaration by reading the matched file's diff, and both check bins called it without that argument — so the gate's own failure message instructed the user to declare `Doc-neutral:` while that declaration could never succeed in CI. Both bins now pass a shared per-file diff closure, against the ref that actually produced the changed-file list rather than the requested base (both re-resolve to `main` when `origin/main` yields nothing).
- 4018b71: New `vinaya pr report --write <body-file>` emits the `AEG:EVIDENCE` block — a PR body's head sha, a width-invariant `git diff --numstat`, and the result of `vinaya check --all --diff-only` — from commands, never typed by hand. The new `evidence-fresh` core check refuses a PR body whose block doesn't match the head it's attached to: it recomputes and exact-compares the diff stat (closing fabrication for that fact) and checks the attested gate run for staleness only, against the PR's real head resolved via `gh` (never `HEAD`, which is the merge commit in CI). `ANCHOR_FIELDS` gains `EVIDENCE`; `aeg-root/templates/pr-report-template.md` and `aeg-root/roles/developer.md` both route their PR-body "evidence" section through the new anchor instead of free text.
- Updated dependencies [5f3ed65]
- Updated dependencies [4018b71]
  - @attalabs/aeg-forge-state@0.12.0
  - @attalabs/aeg-types@0.12.0

## 0.11.0

### Patch Changes

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
  - @attalabs/aeg-types@0.10.0

## 0.9.0

### Patch Changes

- 7d939d8: `vinaya studio` now launches for real in a published install. `bundle-studio.ts` fetches attalabs' CI-built standalone Studio bundle from its public release artifact (`atta-labs/attalabs`'s `vinaya-studio-artifact.yml` workflow, no token required) and assembles it into `studio-standalone/` at `prepack` time, instead of requiring a Studio source tree this repository never had. The default ports move from `3006`/`3106` (the retired `apps/vinaya/web`'s ports) to `3008`/`3108` (matching `apps/vinaya-studio/web`'s own docs). `packages/sources/src/commands.ts`'s `studio` row and `verify-published-lifecycle.ts`'s `studio` exercise both now describe and assert a real launch instead of the prior honest refusal.
- Updated dependencies [7d939d8]
  - @attalabs/aeg-forge-state@0.9.0
  - @attalabs/aeg-types@0.9.0

## 0.8.2

### Patch Changes

- 9d730e1: Fix the `doc-coverage` check so an applied `vinaya/waiver:docs` label actually takes effect. It previously read `PR_LABELS`/`WAIVER_LABEL_ACTOR` from the environment, expecting the CI workflow to inject them — but no generated `vinaya-checks.yml`, old or current, ever set either var, so the waiver path was silently unreachable in every adopter's CI (caught live on atta-labs/attalabs#948). The check now resolves the label and its labeling actor live via `gh`, from `PR_NUMBER`, the same way `review-gate` already does — no workflow template change needed, and every already-generated `vinaya-checks.yml` is fixed in place.
- Updated dependencies [9d730e1]
  - @attalabs/aeg-forge-state@0.8.2
  - @attalabs/aeg-types@0.8.2

## 0.8.1

### Patch Changes

- 30dc300: Recognize a hand-closed dependency Issue as valid when it was closed directly by a recognized Principal identity (verified via GitHub's own `ClosedEvent` actor, not claimed in prose), instead of only accepting a merged closing PR. `dispatch-gate` and `coherence` check A1 both gain this second, narrower recognition path — the default merged-PR path is unchanged.
- Updated dependencies [30dc300]
  - @attalabs/aeg-forge-state@0.8.1
  - @attalabs/aeg-types@0.8.1

## 0.8.0

### Patch Changes

- @atta/aeg-forge-state@0.8.0
  - @atta/aeg-types@0.8.0

## 0.7.1

### Patch Changes

- 334c9d4: The four engine packages are now publicly published: `private: true` dropped, `publishConfig.access: "public"` added, and `.changeset/config.json`'s `privatePackages.tag` flipped to `true`. First public versions of `@atta/aeg-core`, `@atta/aeg-types`, `@atta/aeg-forge-state` and `@atta/vinaya-sources` ship on the next `changeset publish`, alongside `@attalabs/vinaya` as the same fixed-group version.
- Updated dependencies [334c9d4]
  - @atta/aeg-types@0.7.1
  - @atta/aeg-forge-state@0.7.1

## 0.7.0

### Patch Changes

- @atta/aeg-forge-state@0.7.0
  - @atta/aeg-types@0.7.0

## 0.6.0

### Patch Changes

- 6a3f006: Key the generated workflows' concurrency group on the head commit as well as the pull request, so a rerun of an earlier commit's run cannot cancel the current one.
  
  Keyed on the pull request alone, every run for that pull request shared a single group — including reruns of earlier commits, which the verdict retrigger performs. Measured: re-running the previous commit's run cancelled the current commit's run one second after it started, so pushing to a pull request appeared to produce a cancelled review gate. Runs for the same commit still collapse, which is the duplicate the group exists to remove.
- dbb8acd: Fix the generated review gate so a pull request holding clean verdicts reports green without human intervention.
  
  Two defects, both in workflows `vinaya init` writes into every adopter's repository:
  
  - **Duplicate runs.** `vinaya pr create` opens the pull request and applies its tranche label immediately after, so `opened` and `labeled` arrive together and GitHub starts two runs of the same workflow. Both report under one check name and the merge box counts both, so one could go green while its twin held a stale red. The two `pull_request`-triggered workflows now carry a concurrency group keyed per pull request.
  
  - **The verdict retrigger selected the wrong run.** It re-ran every completed run, which put several into one concurrency group at once and had `cancel-in-progress` kill all but the last — cancelled runs report red. Selecting the newest was also wrong: `--status completed` excludes a run that is re-running but includes cancelled ones, so a verdict arriving mid-flight could rerun a stale cancelled sibling and cancel the live evaluation. Selection is now by head SHA, excluding cancelled runs — the run for the current head is the only one whose conclusion gates the merge.
  
  Unchanged: the gate still fails when no verdict exists. "Nobody has reviewed this" must block a merge.
- @atta/aeg-forge-state@0.6.0
  - @atta/aeg-types@0.6.0

## 0.5.0

### Patch Changes

- d4a12db: Make SCOPE layout-agnostic for the retired-vocabulary sweep.
  
  `@atta/aeg-core` is private and never published directly, but it is inlined
  into `@attalabs/vinaya`'s bundle, so this change ships as part of the CLI's
  next release under the fixed group.
- @atta/aeg-forge-state@0.5.0
  - @atta/aeg-types@0.5.0
