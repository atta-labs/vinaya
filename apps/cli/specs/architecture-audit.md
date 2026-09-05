# Architecture audit — agents, functions, and the forge

Status: draft

An audit of how Vinaya's three layers depend on each other: the agents (LLM roles loaded from doctrine markdown), the functions (CLI commands, ring checks, ring-2 scripts, generated workflows), and the forge (GitHub, reached through the `gh` CLI and the GraphQL API). It answers three questions: how much of the function surface the agents actually know about, whether the agents could be lifted into an external package so Vinaya "receives" agents, and whether the process itself is decoupled enough for a team to swap the tracker or the review strategy.

The short answer to all three: the agents are far more decoupled from the functions than the functions are from GitHub. The seam that would let anyone bring their own agents mostly exists already. The seam that would let anyone bring their own tracker or their own process does not, and the coupling sits in the functions, not in the doctrine.

## 1. What each agent knows

Every agent entry point is a one-line loader. All eight `.agents/skills/vinaya-*/SKILL.md` files, `.claude/commands/vinaya.md` and `.gemini/commands/vinaya.toml` run `vinaya doctrine --role <role>` and nothing else. The doctrine that command prints is the agent. What an agent "knows" is therefore exactly what its role doc, the contracts it cites, and the skills it is routed to name explicitly.

Distinct `vinaya` subcommand forms each role's doctrine tells it to run, plus the raw `gh`/`git` commands it prescribes:

| Role | `vinaya` commands named | raw `gh` commands prescribed | check names cited | forge objects the role reads or writes |
|---|---|---|---|---|
| Principal (human) | `milestone edit` | 0 | 0 | PRs, merge, `vinaya/needs:*` labels |
| Architect | `milestone create` (edit/adopt named, not run) | 0 | 0 | GitHub Milestone, `Release:`, `### Tranche intents` |
| Planner | `issue create/edit`, `check coherence`, `check single-plan-pr`, `verify-dispatch.ts --surfaces` | 0 run, 2 named as forbidden | ~15 (mostly `aeg-core` function names via the planner-brief contract) | task Issues, `vinaya/tranche:*` label, Milestone, plan PR |
| Brief Author | `brief render`, `verify-dispatch.ts`, `verify-brief.ts`; the brief-authoring skill adds `check dispatch-readiness`, `check brief-shape`, `check doc-coverage`, `pr create/edit/report` | 3 (struck as superseded) | ~12 | Issue rationale and Objectives, PR body, dependency PRs |
| Developer | `check dispatch-readiness`, `pr create`, `pr report --write/--push`, `review status`, `tokens`, `check doc-coverage`, plus repo toolchain | 1 live (`gh pr view --json reviews,statusCheckRollup`), 2 struck, ~12 `git` | ~10 plus the `AEG:*` anchors | Issue, Milestone, `vinaya/tranche:*`, `vinaya/waiver:docs`, `Closes #N`, PR body, review states |
| Reviewer | `review post --role code-reviewer …`, `check review-gate` | 0 run (`gh pr comment` named as deprecated) | 4 | PR, verdict comment, `vinaya/waiver:review` |
| Security | `review post --role security …`, `check review-gate` | 0 | 3 | PR, verdict comment, status checks |
| Archivist | `check no-disk-state`, `archive`, `tokens` | 2 (`gh issue close`, `gh issue view --json state`) plus 1 in a contract | 4 | merged PR, Issue close, provenance comment |
| Tranche Archivist | `milestone close` | 6 read commands, plus `git mv`, `git push --delete` flagged | 0 | Milestone, `vinaya/tranche:*`, branches, lessons Issue |

Findings from the doctrine side:

- **No role is pure prose.** Every role names at least one `vinaya` subcommand. The pure-prose documents are `reviewer-prompt.md`, four of the eight contracts, and `task-model.md`.
- **The Developer carries most of the coupling.** `roles/developer.md` has 21 `vinaya` invocations, more than any other file including `enforcement.md`. Developer plus Brief Author plus Planner account for the large majority of function references.
- **The doctrine still prescribes raw `gh`.** The Tranche Archivist runs six `gh` reads directly and the Archivist runs `gh issue close`; the front-door skill (`aeg-root/skills/aeg/SKILL.md` §12) hands every session four `gh issue list` / `gh pr list` queries with hard-coded label names. This contradicts the same file's §2 claim that "a tool may know AEG; AEG does not know the tool".
- **The code-side action model and the doctrine-side action model do not match.** `packages/aeg-core/src/actions.ts` declares 11 canonical actions with `performedBy` role ids. The role docs' `performs:` frontmatter declares 48 ids. Only 4 ids appear in both lists (`create-the-milestone`, `post-provenance-comment`, `produce-the-verdict`, `write-the-retrospective`). `diagram-model.ts` explicitly ignores the frontmatter and uses `ACTIONS` only; `registry-checks.ts` only asserts `performs` is non-empty. The frontmatter is therefore documentation, not a binding.
- **Label namespace drift across doctrine.** `skills/aeg/SKILL.md` uses `aeg:blocked`, `tier:*`, `needs:*`; `process.md` and `aeg-manual-flow.md` use `aeg:` and unprefixed forms; `brief-authoring/SKILL.md` uses `tranche:<slug>`; `state-machine.md` §14 declares `vinaya/` as the sole namespace. `enforcement.md` names ring-2 labels `aeg:direct-main-push` / `aeg:dead-branch-push` while the audit command mints `vinaya/direct-main-push` / `vinaya/dead-branch-push`.
- **Other doctrine inconsistencies found in passing:** `state-machine.md` and `contracts/brief-developer.md` assign `vinaya/tier:*` labeling to the Planner and Developer but neither role doc mentions it; three archivist contracts claim `roles/archivist.md` references them and it cites none; `process.md` and `aeg-roles/SKILL.md` still describe writing `aeg-project/state.md` and `lessons.md`, which the role docs say are retired; `brief-template.md` and `pr-report-template.md` still seed `[agent]` checkboxes that `developer.md` says are refused; `brief-template.md` says the brief lands in a `<details>` block while `pr create` splits it into a separate comment; `contracts/brief-developer.md` still tells the Developer to read `aeg-root/tranches/<name>.md` while `developer.md` says derive from the forge.

## 2. What the functions are and what they touch

Live registry, from `vinaya check --plan`: 29 core checks, 1 adopter check, 9 roles. Of the 29 core checks, 17 declare `GITHUB_TOKEN`/`GH_TOKEN`, and 2 declare Claude Code session variables.

Commands, 34 subcommands:

| Class | Count | Members |
|---|---|---|
| filesystem/git only | 14 | version, help, studio, doctrine, eject, init product, upgrade, check (the runner itself), commit-msg, new check, new noop-check, new role, demo break, tokens, release |
| forge read | 5 | doctor, brief render, pr verify-evidence, review status, pr report (without `--push`) |
| forge write | 15 | init, quickstart, archive, archive tranche, audit, issue create/edit, milestone create/edit/adopt/close, pr create/edit, pr report `--push`, review post, waiver |

Core checks, 29:

| Class | Count | Members |
|---|---|---|
| filesystem/git only | 14 | pr-report-density, test-plan, token-report, no-disk-state, reader-resolvable-prose, retired-vocabulary, doctrine-portability, doctrine-no-procedures, exec-bits, workspace-escape, changeset-coverage, quoted-command, main-branch-refusal, token-collection-wired |
| forge read | 14 | brief-shape, doc-coverage, doc-coverage-push, coherence, dispatch-readiness, closes-n, single-plan-pr, body-bare-digits, registry-gates, review-gate, branch-topology, dead-branch-push, first-push-dispatch, evidence-fresh |
| forge write | 1 | issue-assignment (`gh issue edit --add-assignee`) |

Generic hygiene versus Vinaya-process-specific, among the 29 checks: 8 are generic (exec-bits, workspace-escape, changeset-coverage, main-branch-refusal, dead-branch-push, no-disk-state, doc-coverage, doc-coverage-push). The other 21 encode Vinaya's process: brief sections, tiers, `Closes #N`, test-plan halves, token rows, the `AEG:EVIDENCE` block, the tranche/Milestone/label state machine, the verdict grammar, doctrine prose rules, Claude Code metering.

Who invokes what:

- **Git hooks (ring 0)** run only `vinaya check --all --diff-only --local --skip-full` and `check --all --local`. `enforcement.md` ring-0 rows still cite `packages/aeg-core/bin/*.ts` as the hook implementations; those 21 scripts are legacy duplicates of the shipped `apps/cli/src/checks/bin` copies and are not what an adopter runs.
- **CI (ring 1)** is four generated workflows. `vinaya-checks.yml` runs `check --all --diff-only`; `vinaya-review.yml` and `vinaya-body-checks.yml` run one check each under `pull_request_target`; `vinaya-review-verdict.yml` and `vinaya-review-retrigger.yml` exist only to re-run the review gate via `gh run rerun` when a verdict comment or a green CI run arrives.
- **Ring 2** is `vinaya-archivist.yml` running `archive` on push to main and `audit` daily.
- **Agents** invoke `doctrine`, `brief render`, `issue create/edit`, `milestone *`, `pr create/edit/report`, `review post`, `review status`, `archive`, `tokens`, and a handful of `check <name>` forms. That is roughly 12 of 34 subcommands. No agent is told about `audit`, `doctor`, `waiver`, `pr verify-evidence`, `upgrade`, `eject`, `new *`, `release`, or `quickstart`.

The review loop deserves a precise statement because it is the part most often assumed to be "an LLM in CI". It is not. No workflow invokes a model. The reviewer is a separate agent session that loads the reviewer doctrine and runs `vinaya review post`, which derives the verdict from the findings file, binds it to the true head SHA, posts a PR comment, and self-verifies by re-reading it. The deterministic side (`verdict-extraction.ts`, `review-gate.ts`) parses only the first three lines of comments authored by allowlisted principals for `VERDICT:` and `Judged head:`, requires every other check-run green, and accepts an actor-verified `vinaya/waiver:review` label as the only alternative. The three review workflows exist to re-evaluate that gate when a comment lands after the push.

## 3. How deep GitHub goes

There is one real abstraction and it is a keyhole. `StateSource` (`packages/aeg-core/src/state-source.ts`) has one method, `getTranche(slug)`. `packages/sources` selects between a `forge` and a `file` implementation, but "forge" means GitHub; there is no GitHub-versus-GitLab axis. Everything else, status facts, milestones, labels, PR state, review verdicts, and all writes, bypasses it.

`@attalabs/aeg-forge-state` is not an interface. It is ~35 free functions taking `(owner, repo, …)` positional strings, with two transports (`gh` subprocess and `@octokit/graphql`). Its output types (`ForgeFacts`, `Tranche`, `MilestoneFacts`) are neutral; its input types (`GhIssue`, `RawTaskFacts`, `GhMilestone`) are GitHub GraphQL shapes verbatim. `mapForgeFacts` and `trancheFromIssues` are the only true seams inside it. Note also that `aeg-core` depends on `aeg-forge-state`, so the forge adapter sits underneath the "pure" core, not beside it.

Direct `gh` call sites outside that package: roughly 110. About 60 in `apps/cli/src` (commands and check bins), about 45 in `packages/aeg-core/bin`, plus the inline `gh` in generated YAML. Roughly a third of CLI check and command files use `createForgeSource` for the topology and then shell to `gh` themselves for everything else. Token resolution (`GITHUB_TOKEN`, `GH_TOKEN`, `gh auth token`) is copied in five places. Label create/list is duplicated in six files despite an `ensure-label.ts` seam.

GitHub concepts with no neutral equivalent in the code, ranked by how hard they are to move:

1. **`pull_request_target` as the trust root.** The security model of `principals`, `releaseActor`, the review gate and waivers is derived from GitHub Actions event semantics. Each forge needs its own trust-boundary design; this is design work, not refactoring.
2. **Actor-verified waiver labels via timeline `labeled` events.** A waiver is defined as "a label plus who applied it". Four fetch sites; most trackers lack this shape.
3. **`ForgeFacts` sourced from `timelineItems(CLOSED_EVENT).closer` and `stateReason`.** The terminal statuses `dropped` and `incoherent` depend on `NOT_PLANNED`/`COMPLETED` and "which PR closed this Issue".
4. **`Task.issue: number` and the `Closes #N` grammar.** Pervasive across parsers, gates and brief validation; Linear and Jira keys are strings.
5. **Milestones with title==slug legacy and `### Tranche intents` in the description.** Tied to GitHub Milestone semantics and `gh --milestone <title>`.
6. **Branch and PR bound to task** via `refs/heads/task/<t>/<n>` and `pullRequests(headRefName)`. A tracker-only forge cannot supply it.
7. **Trust-anchor config read from the default branch** via `gh api …/contents` keyed on `GITHUB_REPOSITORY`.
8. **Review-gate consumes `gh pr checks` bucket vocabulary** and `releaseActor = github-actions[bot]`.
9. **Ring-1 write commands wrap `gh` argv.** `pr create`, `issue create` and `forge-write.ts` parse `--body-file`, `--title`, `--label`, `--milestone` from `gh`'s own grammar and then exec `gh`. An adapter would have to re-specify these commands, not just re-implement a call.
10. **Label vocabulary, the 50-character cap, and `{owner}/{repo}` URL templating** that only works under `gh api`.

The write side of ring 1 has a sharper observation: `validateForgeWrite` is forge-neutral and config-driven, but everything around it (`locateBody`, `resolveShippableArgs`, `extractLabels`, `resolveMilestoneAttachArgs`, `ensureTrancheLabelExists`, the two `runGhWrite` calls) is `gh`-CLI-specific. Also, `rings.ring1_forgeWriteInterception: true` disables validation, the opposite of what the flag name suggests.

## 4. Answers to the three questions

**How many functions do the agents directly know?** Around 12 of 34 subcommands and around 15 of 29 check names, concentrated in the Developer, Brief Author and Planner. The other half of the surface (hooks, workflows, ring-2 audits, `doctor`, `waiver`, `audit`, the 21 legacy scripts) is invisible to agents by design: it runs regardless of what the agent does. That invisibility is the product's central claim and it holds. What does not hold is the reverse direction: the doctrine that agents load names ~50 distinct function or check identifiers and prescribes ~10 raw `gh` commands, so the agents are not independent of the functions; they are consumers of a specific CLI surface.

**Could the agents be an external package so Vinaya receives agents?** Largely yes, and the mechanism is already there. The CLI resolves roles from `aeg-root/roles/*.md` through `roles/contract.ts` (frontmatter shape plus a "The short version" section), `vinaya.config.json`'s `roles` block overrides or adds roles, and `vinaya doctrine --role` is the only thing an agent entry point runs. Three things stand in the way:

- The roles ship inside the `@attalabs/vinaya` package (`VINAYA.md` says so explicitly, "no in-repo copy to drift"), so "bring your own agents" today means overriding nine roles one by one in config rather than pointing at a package.
- Additive roles are `inertToGating`: they get no `ACTIONS.performedBy` binding, so the diagram, the G3 crossing tripwire and any future role-aware gate cannot see them. The 11-entry `ACTIONS` list would need to become data the role package supplies, and the 48 frontmatter `performs` ids would need to become the same vocabulary or be dropped.
- The doctrine is not just role prose. Contracts, templates, the state machine and the brief-authoring skill are what the checks actually validate against (brief sections, rationale fields, `Objectives` copy, the `AEG:*` anchors). An external agent package would have to ship those too, or the checks would have to read their schema from config rather than from doctrine. `briefSchema` in config is the beginning of that but only covers section presence.

**Is the process decoupled enough for any team to bring their own tracker or review strategy?** No, and the coupling is in the functions rather than the doctrine. The doctrine talks about "the forge" abstractly in most places and is genuinely closer to tool-neutral than the code. The code has one implementable interface with one method, ~110 direct `gh` call sites, and a trust model built on a GitHub Actions event type. A Linear or Jira adapter could serve the tracker half (issues, labels, comments, milestones) for the 14 tracker-shaped checks and the Planner/Brief Author/Archivist commands, but the review gate, evidence freshness, dead-branch push, single-plan-pr and the waiver mechanism need a git-forge half (refs, PRs, check-runs, label actor history) that only a GitHub or GitLab adapter can provide. The review strategy is the least portable piece: the verdict grammar, the principal allowlist, the head binding and the three retrigger workflows are one design, not a pluggable one.

## 5. What a decoupling would actually require

In order of leverage, not effort:

1. **Split the forge into two interfaces** in `aeg-types`: a work tracker (issue by id, issues by label, labels, label events with actor, comments, milestones, assignees) and a code forge (refs, PRs by head, PR files, PR comments, check-runs, merge-commit-to-PR, default-branch file read, credential). Make issue ids opaque strings. Keep `ForgeFacts`, `Tranche`, `MilestoneFacts` as the neutral outputs they already are.
2. **Turn `aeg-forge-state` into `GitHubForge`**, the first implementation. Keep `mapForgeFacts`, `trancheFromIssues`, `parse-rationale-deps`, `strip-code`, `labels.ts` as pure. Export the currently-internal list helpers so `verify-dispatch.ts`, `archive.ts` and `milestone.ts` stop re-implementing them.
3. **Route the ~60 CLI call sites through it.** Commands first (`pr`, `issue`, `milestone`, `archive`, `audit`, `waiver`, `review-post`, `review-status`, `pr-report`, `brief`), then the 14 forge-reading check bins. Delete the five copies of token resolution and six copies of label ensure.
4. **Re-specify the ring-1 write commands** as API calls with named options instead of `gh` argv passthrough. `validateForgeWrite` survives unchanged.
5. **Make the process schema data, not doctrine.** `briefSchema` already declares which sections a PR or Issue body must carry; extend it to the rationale fields, Objectives coupling, evidence anchors and verdict grammar so a team that keeps issues in Linear can declare a different body shape without editing doctrine markdown.
6. **Make roles a package input.** A `roles` source in config that points at a directory or a package, with the action list and contract set supplied alongside the role docs, and `ACTIONS` derived from that source rather than hard-coded in `aeg-core`.
7. **Design the trust boundary per forge**, explicitly. The `pull_request_target` argument, the label-actor waiver and the default-branch trust anchor are one coherent GitHub design; each other forge needs its own written equivalent before any adapter is believable.
8. **Retire the duplicates.** The 21 `packages/aeg-core/bin` scripts and the shipped `apps/cli/src/checks/bin` copies enforce the same rules twice; `enforcement.md` still points at the legacy ones.

Items 1 to 4 are refactoring with the neutral types already in place. Items 5 to 7 are design decisions. Item 8 is cleanup that removes a standing source of drift.

## 6. Method

Three passes over the tree on 2026-09-05: every doctrine file under `aeg-root/`, `.agents/`, `.claude/commands`, `.gemini/commands` read in full for named commands, checks, labels and forge concepts; every file under `apps/cli/src/commands`, `apps/cli/src/checks`, `apps/cli/src/lib/{artifacts,config,forge-write,detect}.ts`, `apps/cli/src/roles`, `packages/aeg-core/bin`, and the six generated workflows and three hooks, read for callers and forge access; every file in `packages/sources`, `packages/aeg-forge-state`, `packages/aeg-types` and the forge-touching modules of `packages/aeg-core/src`, read for the abstraction boundary, with a grep sweep for `gh` shell-outs, octokit and `GITHUB_*` across all four trees. Counts were checked against `vinaya check --plan` output and against `actions.ts` versus the roles' frontmatter.
