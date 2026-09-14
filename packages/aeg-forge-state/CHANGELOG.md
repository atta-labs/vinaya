# @atta/aeg-forge-state

## 0.27.1

### Patch Changes

- 75e2d46: Five doctrine defects fixed: the pre-push selector always runs test files named under a new `prePush.alwaysRun` config key plus every test file added or renamed in the diff; `rings.ring1_forgeWriteInterception`/`ring2_asyncAudits` now mean what they say (`true` runs the ring, `false` opts out — inverted from before, with a version-gated `vinaya upgrade` migration for a stale config, now bidirectional in either direction); `@attalabs/aeg-forge-state` ships two tested primitives for a bare `Depends-on`/`Conflicts-with` edge id — `requireTrancheQualifiedEdges`, which throws once a bare id could belong to more than one tranche, and `tranchesAttachedToMilestone`, which lists the distinct tranches attached to a Milestone via the forge — with the actual dispatch-gate refusal wired in by a separate task (`packages/aeg-core/bin/verify-dispatch.ts` is out of this task's Surface); the post-merge Archivist self-chains into `archive tranche`, which now appends a `### Retrospective: <slug>` section (task count, rounds per task, merged PRs) to the Milestone description once a tranche is complete; the evidence runner's per-command budget is now `report.commandTimeoutMs` (default 15 minutes, capped at 1 hour) instead of a hardcoded 30 seconds; and a closed Issue's status rules now run before `branch-exists`, so a closed NOT_PLANNED Issue with a lingering task branch reads `dropped`, never `in-flight`.
- 201fd4e: `tranchesAttachedToMilestone` now fetches Issue labels only, server-side filtered and paginated through the buffered `gh` client, instead of a single unpaginated fetch of full Issue bodies — a Milestone holding many Issues with large bodies no longer overruns the process output buffer. The `Depends-on` resolver now resolves a bare backlog Issue number through that Issue's own pull request — by its `task/issue-<n>` branch, or by a `Closes #<n>` reference in a PR body — before falling back to the Issue's own closed/open state, so a merged backlog dependency is recognized as merged and a closed-but-unmerged one is not mistaken for it.
- @attalabs/aeg-types@0.27.1

## 0.27.0

### Minor Changes

- 6266fea: Adds `vinaya milestone status <n>` — read-only, prints each of a Milestone's declared `### Tranche intents` slugs with its forge-derived lifecycle (`planned`/`active`/`complete`) and its labeled Issues' counts (merged, open, not planned). `@attalabs/aeg-forge-state` gains `intentLines`, the enumeration sibling of `intentGoalForSlug`, and an optional `stateReason` field on `GhIssue`/`gh issue list`'s requested JSON fields.

### Patch Changes

- @attalabs/aeg-types@0.27.0

## 0.26.0

### Patch Changes

- 529fa54: The Brief Author role is retired: the brief is dispatched by the Planner, not authored by a separate role. `author-the-brief` (`ACTIONS`) is now `performedBy: ['planner']`. The `needs-brief-correction` label keeps its id — Issues in flight carry it — but its copy now names the Planner. `vinaya doctrine --role brief-author` refuses, pointing the caller at `--role planner`, even while `aeg-root/roles/brief-author.md` still exists on disk. `vinaya upgrade` now removes a generated `.agents/skills/vinaya-<role>/SKILL.md` for a role this codebase has retired, and no longer generates one. Retirement is DECLARED (`RETIRED_ROLE_NAMES`), never inferred from a role file's absence — `aeg-root/roles/brief-author.md` deliberately outlives this change, so an emitter that read the file as proof of liveness would both skip the cleanup and keep writing a skill whose embedded `vinaya doctrine --role brief-author` this same release refuses. `eject` is unchanged.
  
  `AEG_BRIEF_V1_MARKER` and `contentAfterTwoLines` are promoted into `@attalabs/aeg-core`'s exports — the single implementation `packages/aeg-core/bin/verify-brief.ts`, `verify-dispatch.ts`, `archive-task.ts` and `apps/cli`'s `dispatch-task.ts`/`check-brief-shape.ts` all now share, replacing four independent copies. `brief-author` is removed from `@attalabs/aeg-core`'s `ROLE_VALUES`, the log schema's dispatchable-role union, so a log line claiming that role no longer validates. `verify-brief.ts` now grades the task Issue's frozen `aeg:brief:v1` comment on a task branch — the same body `vinaya check brief-shape` already grades since the brief was moved off the PR body — instead of `PR_BODY`, so the authoring-time gate and the CI gate cannot disagree about a post-split brief.
- Updated dependencies [529fa54]
  - @attalabs/aeg-types@0.26.0

## 0.25.0

### Patch Changes

- @attalabs/aeg-types@0.25.0

## 0.24.1

### Patch Changes

- @attalabs/aeg-types@0.24.1

## 0.24.0

### Patch Changes

- b8e3aaa: `parseRationaleDeps` now reads dependency edges from a field's **labelled span only**. Previously it scanned every inline-code span in an Issue body's "Dependency rationale" section left-to-right, attributing each unlabelled span to whichever field label preceded it, however far back — so any id-shaped span in that paragraph became a declared edge. Two real bodies show the cost: one whose fields both read `—` was parsed as conflicting with the three task ids its prose merely named, and one whose trailing `` `1` `` (ordinary prose naming a task) was read as a dependency on task `1`, which on that tranche's own task `1` is a self-dependency.
  
  The grammar is now: `` `Depends-on: 1, 2` `` / `` `Conflicts-with: <slug> 25` `` — one labelled, comma-separated span per field, which is the topology file's own cell convention and exactly what `amendRationaleDeps` writes. Every other span in the section is prose and contributes nothing.
  
  **Behaviour change for adopters.** The previously-tolerated multi-span convention — a labelled first span followed by bare continuation spans holding further values — is no longer read. An Issue body written that way now declares only its labelled span's ids; state the rest in that span, comma-separated. `vinaya issue amend-deps` is the sanctioned way to rewrite one: it already emits the single labelled comma-joined form, so its output round-trips through the narrowed reader unchanged. Slug inheritance (a bare id after a slug-qualified one adopting its qualifier, one step) is unchanged but now applies within a single labelled span. The four exported grammar constants (`SECTION_HEADER`, `NEXT_HEADER`, `FIELD_LABEL`, `ID_TOKEN`) and `amendRationaleDeps` itself are untouched.
- @attalabs/aeg-types@0.24.0

## 0.23.0

### Patch Changes

- 12b7e33: **Breaking:** `checkReviewGate`'s `ReviewGateInput` gains a required `mechanicalChecks: MechanicalCheckStatus[]` field — every check-run reported for the PR's current head, excluding the caller's own review-gate check-run. A caller that does not supply it no longer compiles, the same required-not-optional discipline `headSha` already established (#73): an optional field that silently skipped the mechanical-check requirement on absence would fail open. `checkReviewGate` now also requires every reported mechanical check to be green (`bucket === 'pass'`) — an empty array does not count as clean, since there is no proof to point to. A red or absent mechanical check fails the gate the same way an unclean or unbound verdict does, naming which check is not green, or that none have reported yet. The `vinaya/waiver:review` label still short-circuits to pass unconditionally, regardless of mechanical-check state. Both `apps/cli/src/checks/bin/check-review-gate.ts` and `packages/aeg-core/bin/verify-review-gate.ts` now fetch check-run status via `gh pr checks --json name,bucket`, filtering out their own review-gate check-run name before calling in — that exclusion lives in the CLI shims, not in `aeg-core`'s pure logic, since `aeg-core` ships to every adopter under a different workflow name.
- Updated dependencies [12b7e33]
  - @attalabs/aeg-types@0.23.0

## 0.22.0

### Patch Changes

- @attalabs/aeg-types@0.22.0

## 0.21.0

### Minor Changes

- 4c0f755: `vinaya milestone close --slug <slug>` replaces the raw `gh api .../milestones/<n> -X PATCH -f state=closed` recipe `tranche-archivist.md` used to run on faith. It resolves the target Milestone the same legacy-or-intent-declared way `vinaya issue create`'s auto-attach does, fetches the tranche's labeled Issues and the Milestone's natively attached Issues, and refuses to close on any mismatch — naming each unattached or foreign Issue and its repair path (`gh issue edit <n> --milestone <title>`, or `vinaya milestone adopt`) — before the PATCH ever reaches the forge. The mismatch diff itself is a new pure function, `checkMilestoneAttachment` (`@attalabs/aeg-forge-state`): no network inside it, both Issue lists are fetched and injected by the caller. `--validate-only` verifies attachment without writing.

### Patch Changes

- 21ccea4: `vinaya issue create` now auto-attaches a new task Issue to its tranche's open Milestone — a `resolveMilestoneAttachTarget` resolver (`@attalabs/aeg-forge-state`) matches the legacy exact-slug-titled Milestone or, new, an intent-declared one (`### Tranche intents`), and always hands `gh` the Milestone's own TITLE rather than the slug. Explicit `--milestone` on argv still wins; no matching open Milestone silently skips attach rather than failing the create. Fixes the gap where the only documented path (`milestone create` then `issue create` per task) left every task Issue labeled but never attached, and fixes the pre-existing `open-issue.ts` auto-attach, which crashed intent-declared-tranche creates by handing `gh` a slug no Milestone was titled.
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
  - @attalabs/aeg-types@0.20.1

## 0.20.0

### Patch Changes

- @attalabs/aeg-types@0.20.0

## 0.19.3

### Patch Changes

- @attalabs/aeg-types@0.19.3

## 0.19.2

### Patch Changes

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
  - @attalabs/aeg-types@0.19.0

## 0.18.0

### Patch Changes

- 70e887e: `vinaya init product` no longer creates a `project:<name>` label, and no longer needs a GitHub remote or credentials. Project is a **field, not a label**: the `project:*` label family was retired, `declaredProjects` resolves a task's project from the Issue body's `**Project:**` field, and `list-tasks.ts` explicitly ignores a residual `project:*` label. The command's only forge-reaching op was therefore creating a label no shipped consumer reads, while making an otherwise purely local command require a remote — and, when none was configured, emit a warning about skipping work that did not need doing. What it writes is unchanged: the `.vinaya/projects.md` row, still deliberately outside the ownership manifest so `eject` never reverses adopter-declared data. Existing repos keep whatever `project:*` labels they already have; nothing deletes a forge label that may be in use elsewhere. Adopters relying on `project:*` for issue filtering should apply it themselves going forward.
- @attalabs/aeg-types@0.18.0

## 0.17.1

### Patch Changes

- @attalabs/aeg-types@0.17.1

## 0.17.0

### Patch Changes

- @attalabs/aeg-types@0.17.0

## 0.16.0

### Patch Changes

- @attalabs/aeg-types@0.16.0

## 0.15.0

### Patch Changes

- @attalabs/aeg-types@0.15.0

## 0.14.0

### Patch Changes

- da64fd0: `vinaya doctor` now flags `.vinaya/doc-owners` bindings whose code glob matches no tracked file in the repo, or whose doc pointer doesn't exist on disk — both silent gaps the diff-scoped C5 gate structurally cannot see on its own, since a glob matching nothing trivially satisfies "did the docs change" for every diff. Report-only, like every other `doctor` diagnostic — it never mutates `.vinaya/doc-owners` and is not a `vinaya check` gate.
- Updated dependencies [da64fd0]
  - @attalabs/aeg-types@0.14.0

## 0.13.1

### Patch Changes

- 7d23b7f: `vinaya doctor` now reports when no workflow under `.github/workflows/` appears to invoke the repo's own `package.json` test script. Vinaya requires a Test Plan on every pull request and enforces it as a blocking gate, but had no visibility into whether anything actually runs the tests that plan claims to cover. The diagnostic is a narrow heuristic — a short literal list of test-invocation substrings, scanned across every workflow file, not only the four vinaya-generated ones — and reports at `warn`, never `error`; it accepts false negatives rather than trying to be exhaustive.
- Updated dependencies [7d23b7f]
  - @attalabs/aeg-types@0.13.1

## 0.13.0

### Patch Changes

- 8b2f8b6: `vinaya check --json` previously truncated its payload at the reading pipe's buffer, because the process exited on top of a pending asynchronous stdout write — a file redirect never exposed it, since a file's stdout write is synchronous. Any consumer piping the output, `vinaya pr report` among them, received unparseable JSON above that buffer. The payload now drains before the process exits, with exit codes unchanged.
- 3a9ef15: **Breaking:** `checkReviewGate`'s `ReviewGateInput` gains a required `headSha` field — the PR's current head commit (`gh pr view --json headRefOid`). A caller that does not supply it no longer compiles; an optional field that silently skipped the binding check on absence would fail open, the exact defect this closes (#73). `VerdictExtraction` gains `headSha: string | null`, parsed from a same-comment `Judged head: <sha>` line with the same anchor discipline as the `VERDICT:` marker itself (abbreviated or full sha, blockquote/list/heading/code-span excluded). `checkReviewGate` now requires both the code-review and security-review verdicts to be clean AND bound to the current head — a verdict that predates a later push, or carries no `Judged head:` line at all, fails the gate, naming both the verdict's sha and the current head. Every verdict already posted on an open PR carries no such binding and is fail-closed by this change: re-cast the verdict at the PR's current head, or a principal can apply the actor-verified `vinaya/waiver:review` label as a one-PR transition escape. `aeg-root/roles/reviewer.md` and `roles/security.md`'s `VERDICT:` output block both gain the `Judged head: <sha>` line.
- Updated dependencies [8b2f8b6]
- Updated dependencies [3a9ef15]
  - @attalabs/aeg-types@0.13.0

## 0.12.0

### Patch Changes

- 5f3ed65: `Doc-neutral:` now clears a fired C5 doc-coverage binding in the merge-blocking check, not only in `verify-docs`. `evaluateC5` verifies the declaration by reading the matched file's diff, and both check bins called it without that argument — so the gate's own failure message instructed the user to declare `Doc-neutral:` while that declaration could never succeed in CI. Both bins now pass a shared per-file diff closure, against the ref that actually produced the changed-file list rather than the requested base (both re-resolve to `main` when `origin/main` yields nothing).
- 4018b71: New `vinaya pr report --write <body-file>` emits the `AEG:EVIDENCE` block — a PR body's head sha, a width-invariant `git diff --numstat`, and the result of `vinaya check --all --diff-only` — from commands, never typed by hand. The new `evidence-fresh` core check refuses a PR body whose block doesn't match the head it's attached to: it recomputes and exact-compares the diff stat (closing fabrication for that fact) and checks the attested gate run for staleness only, against the PR's real head resolved via `gh` (never `HEAD`, which is the merge commit in CI). `ANCHOR_FIELDS` gains `EVIDENCE`; `aeg-root/templates/pr-report-template.md` and `aeg-root/roles/developer.md` both route their PR-body "evidence" section through the new anchor instead of free text.
- Updated dependencies [5f3ed65]
- Updated dependencies [4018b71]
  - @attalabs/aeg-types@0.12.0

## 0.11.0

### Patch Changes

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
  - @attalabs/aeg-types@0.10.0

## 0.9.0

### Patch Changes

- 7d939d8: `vinaya studio` now launches for real in a published install. `bundle-studio.ts` fetches attalabs' CI-built standalone Studio bundle from its public release artifact (`atta-labs/attalabs`'s `vinaya-studio-artifact.yml` workflow, no token required) and assembles it into `studio-standalone/` at `prepack` time, instead of requiring a Studio source tree this repository never had. The default ports move from `3006`/`3106` (the retired `apps/vinaya/web`'s ports) to `3008`/`3108` (matching `apps/vinaya-studio/web`'s own docs). `packages/sources/src/commands.ts`'s `studio` row and `verify-published-lifecycle.ts`'s `studio` exercise both now describe and assert a real launch instead of the prior honest refusal.
- Updated dependencies [7d939d8]
  - @attalabs/aeg-types@0.9.0

## 0.8.2

### Patch Changes

- 9d730e1: Fix the `doc-coverage` check so an applied `vinaya/waiver:docs` label actually takes effect. It previously read `PR_LABELS`/`WAIVER_LABEL_ACTOR` from the environment, expecting the CI workflow to inject them — but no generated `vinaya-checks.yml`, old or current, ever set either var, so the waiver path was silently unreachable in every adopter's CI (caught live on atta-labs/attalabs#948). The check now resolves the label and its labeling actor live via `gh`, from `PR_NUMBER`, the same way `review-gate` already does — no workflow template change needed, and every already-generated `vinaya-checks.yml` is fixed in place.
- Updated dependencies [9d730e1]
  - @attalabs/aeg-types@0.8.2

## 0.8.1

### Patch Changes

- 30dc300: Recognize a hand-closed dependency Issue as valid when it was closed directly by a recognized Principal identity (verified via GitHub's own `ClosedEvent` actor, not claimed in prose), instead of only accepting a merged closing PR. `dispatch-gate` and `coherence` check A1 both gain this second, narrower recognition path — the default merged-PR path is unchanged.
- Updated dependencies [30dc300]
  - @attalabs/aeg-types@0.8.1

## 0.8.0

### Patch Changes

- @atta/aeg-types@0.8.0

## 0.7.1

### Patch Changes

- 334c9d4: The four engine packages are now publicly published: `private: true` dropped, `publishConfig.access: "public"` added, and `.changeset/config.json`'s `privatePackages.tag` flipped to `true`. First public versions of `@atta/aeg-core`, `@atta/aeg-types`, `@atta/aeg-forge-state` and `@atta/vinaya-sources` ship on the next `changeset publish`, alongside `@attalabs/vinaya` as the same fixed-group version.
- Updated dependencies [334c9d4]
  - @atta/aeg-types@0.7.1

## 0.7.0

### Patch Changes

- @atta/aeg-types@0.7.0

## 0.6.0

### Patch Changes

- @atta/aeg-types@0.6.0

## 0.5.0

### Patch Changes

- @atta/aeg-types@0.5.0
