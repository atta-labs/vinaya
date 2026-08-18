# @atta/aeg-types

## 0.10.0

### Minor Changes

- 264a8ae: The repo-wide coherence sweep stops re-fetching forge data it already holds. `verify-coherence.ts`'s `loadTrancheFiles` derived each tranche independently, so a repo with N Milestones paid N re-pulls of the entire Milestone list plus N serial `gh issue list` calls, and L4/L5 then re-issued those same N Issue queries a second time for the `milestone` field a `Tranche` drops. The sweep now enumerates every tranche first, indexes Milestones once (`indexTrancheMilestonesAsync`), fetches each tranche's labeled Issues exactly once at a bounded concurrency of 4, and derives both the task list and L4's Milestone-attachment facts from that single response. Measured against `atta-labs/vinaya` (6 Milestones): 21 `gh` calls and 26.4 s become 7 and 9.5 s, with byte-identical report JSON — the derivation, the checks, and the verdict are unchanged, only the round trips are gone. New `@attalabs/aeg-forge-state` exports for callers that hold forge data already: `indexTrancheMilestonesAsync`, `fetchTrancheIssuesAsync`, `trancheFromIssues`, `tasksFromIssues`, `issueMilestonesFromIssues`, and the `TrancheMilestoneIndex`/`GhIssue` types. Every existing export keeps its signature and behaviour. `indexTrancheMilestonesAsync` is paginated via the new `ghApiGetAllPagesAsync`: Milestones are append-only, so the single `per_page=100` page the older readers use is a countdown rather than a bound, and silent truncation in the index a repo-wide sweep enumerates from would drop tranches from every check with no error. The sweep also keys its Milestone fill-in on which tranches were actually produced rather than which were enumerated, so a PR that deletes or archives a topology file can no longer narrow the sweep — the deletion case fell through to a forge derivation as before, and an archival move (`tranches/x.md` to `tranches/completed/x.md`) keeps the PR head's own content and its `archived` flag. Forge unavailability is reported rather than thrown or absorbed, on every path: a lost Milestone index refuses the run when nothing local can be enumerated, and withholds L4/L5 — whose only active-tranche authority it is — when topology files keep the sweep non-empty, rather than letting an empty authority read as "no drift"; a per-tranche read that fails with no file to stand in names the omitted slugs. `ghApiGetAllPagesAsync` sets `per_page` itself rather than trusting the caller's path, because the page size IS its stop condition, and refuses to walk past a page ceiling instead of looping without bound. The sweep's two git readers now spawn `git` with an argv array rather than interpolating a ref and a path into a shell string: one of those paths is assembled from a Milestone title, so through a shell a title carrying a command substitution executed, while as one argv element it is only a filename git fails to resolve — which both readers already treat as absent.

### Patch Changes

- 6e3cf0f: The four generated workflows now invoke `npx --yes @attalabs/vinaya@<exact-installed-version>`, the same exact-version pin the generated git hooks already carried and from the same source (`ownVersion()`). Previously they emitted a bare `npx --yes @attalabs/vinaya`, which reads as "always latest" and is not: where `vinaya-checks.yml` carries an install step — which it does only when the adopter declares `ci.setup` — a repo carrying the CLI as a devDependency resolved `node_modules/.bin/vinaya` instead of the registry, measured as `0.8.2` inside such an adopter repo against `0.9.0` in `/tmp`. There, CI's version was an accident of a dependency no workflow referenced, and changing that dependency moved CI to registry latest with no commit and no diff. An adopter declaring no `ci.setup` gets no install step at all, so for them a bare spec resolved registry latest in all four workflows. The generated workflows are managed artifacts, so `vinaya upgrade` rewrites an existing install's unpinned workflows to the pinned shape and re-pins them on each version bump; `vinaya doctor` reports a stale pin as drift. The git hooks are unchanged.
- 32a01e2: The shipped token-report doctrine no longer names a host tool's script as the requirement. `aeg-root/tranche-model.md` §12 now states the obligation as three layers — every role reports its own turn's usage (portable), collected by whatever means its host offers (host-specific), into the `Tokens: …` grammar in the artifact its turn produced (portable) — so an adopter on any harness implements only the middle layer and inherits the rest unchanged. The role docs (`developer.md`, `archivist.md`, `planner.md`, `reviewer.md`, `security.md`, `tranche-archivist.md`), `state-machine.md` and `enforcement.md`'s registry row now cite `bin/report-tokens.ts` as *the Claude Code way* to satisfy collection rather than as the rule. The taxonomy that split roles by Anthropic product name ("terminal roles run in Claude Code" vs "claude.ai roles run in chat") is replaced by the capability it was actually describing: **self-metering** (the host exposes the session's own usage to the agent) vs **operator-metered** (it does not), both defined in `glossary.md`. Per-cell `—` optionality is now conditioned on that host capability rather than on the role, and `state-machine.md`'s stale, already-retracted `(terminal: /cost)` claim is gone.
  
  The obligation itself is unchanged and is not weakened: reporting stays mandatory, `—` stays sanctioned only where a host exposes no usage to the agent at all, and the no-estimate rules carry forward in substance, restated as one capability-conditioned rule rather than two role-specific ones.
  
  `@attalabs/aeg-core` gains `src/claude-code-transcript.ts`, which now homes `summarizeTranscript` — it parses one vendor's transcript JSONL and its `usage` field names, so it was never portable despite living beside the portable renderers. `TranscriptSummary` is now documented as the adapter seam: an adapter's whole contract is to produce that shape, and everything downstream of it (`formatTokensLine`, `parse-token-report.ts`'s grammar) is shared by every host. No exported name, type or behaviour changes — `summarizeTranscript` is still exported from the package root. `bin/report-tokens.ts` gains a declared `--transcript <path>` flag (previously reachable only by accident, as a bare positional) and reframes its missing-pointer error: naming your own transcript is a supported primary route, and a repo that installs no `track-transcript.sh` Stop hook — this one included — is not misconfigured for lacking a pointer file.

## 0.9.0

### Patch Changes

- 7d939d8: `vinaya studio` now launches for real in a published install. `bundle-studio.ts` fetches attalabs' CI-built standalone Studio bundle from its public release artifact (`atta-labs/attalabs`'s `vinaya-studio-artifact.yml` workflow, no token required) and assembles it into `studio-standalone/` at `prepack` time, instead of requiring a Studio source tree this repository never had. The default ports move from `3006`/`3106` (the retired `apps/vinaya/web`'s ports) to `3008`/`3108` (matching `apps/vinaya-studio/web`'s own docs). `packages/sources/src/commands.ts`'s `studio` row and `verify-published-lifecycle.ts`'s `studio` exercise both now describe and assert a real launch instead of the prior honest refusal.

## 0.8.2

### Patch Changes

- 9d730e1: Fix the `doc-coverage` check so an applied `vinaya/waiver:docs` label actually takes effect. It previously read `PR_LABELS`/`WAIVER_LABEL_ACTOR` from the environment, expecting the CI workflow to inject them — but no generated `vinaya-checks.yml`, old or current, ever set either var, so the waiver path was silently unreachable in every adopter's CI (caught live on atta-labs/attalabs#948). The check now resolves the label and its labeling actor live via `gh`, from `PR_NUMBER`, the same way `review-gate` already does — no workflow template change needed, and every already-generated `vinaya-checks.yml` is fixed in place.

## 0.8.1

### Patch Changes

- 30dc300: Recognize a hand-closed dependency Issue as valid when it was closed directly by a recognized Principal identity (verified via GitHub's own `ClosedEvent` actor, not claimed in prose), instead of only accepting a merged closing PR. `dispatch-gate` and `coherence` check A1 both gain this second, narrower recognition path — the default merged-PR path is unchanged.

## 0.8.0

## 0.7.1

### Patch Changes

- 334c9d4: The four engine packages are now publicly published: `private: true` dropped, `publishConfig.access: "public"` added, and `.changeset/config.json`'s `privatePackages.tag` flipped to `true`. First public versions of `@atta/aeg-core`, `@atta/aeg-types`, `@atta/aeg-forge-state` and `@atta/vinaya-sources` ship on the next `changeset publish`, alongside `@attalabs/vinaya` as the same fixed-group version.

## 0.7.0

## 0.6.0

## 0.5.0
