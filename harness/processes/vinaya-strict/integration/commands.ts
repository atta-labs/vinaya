export type CommandStatus = 'shipped' | 'planned'

export type CommandFlag = {
  flag: string
  description: string
}

/**
 * What a command needs beyond the dispatched Developer's sandbox: `forge` — a
 * forge credential (it reads or writes the forge); `default-branch` — a
 * checkout of the default branch; `operator-seat` — the Operator's own seat
 * (it starts, rules on or releases work). A command that needs none declares
 * `[]`.
 */
export type CommandNeed = 'forge' | 'default-branch' | 'operator-seat'

export type Command = {
  name: string
  /** What this command needs beyond the sandbox — required, so a command added without the declaration fails to typecheck and its exhaustiveness test. */
  needs: readonly CommandNeed[]
  description: string
  flags?: CommandFlag[]
  /**
   * Long-form description paragraphs, rendered only by surfaces that have room
   * for them (the web command reference does; `printHelp()` renders
   * `description` alone and ignores this). Backticked runs are inline code.
   */
  details?: readonly string[]
  status: CommandStatus
}

export const COMMANDS: readonly Command[] = [
  {
    name: 'help',
    needs: [],
    description: 'Show this help text',
    status: 'shipped'
  },
  {
    name: 'version',
    needs: [],
    description: 'Print the CLI version',
    flags: [{ flag: '--json', description: 'Enveloped JSON output (schema: 1)' }],
    status: 'shipped'
  },
  {
    name: 'init',
    needs: [],
    description: "Install Vinaya's git hooks, CI workflow, and starter config (diff-and-confirm, non-destructive)",
    flags: [
      { flag: '--dry-run', description: 'Print the full diff without installing anything' },
      { flag: '--yes', description: 'Skip the confirmation prompt' }
    ],
    details: [
      'It detects your repo, prints the complete diff of every intended change, and waits for your confirmation before installing anything. `--dry-run` prints that same diff and installs nothing. Nothing ever runs automatically on package install.',
      'It installs one CI workflow that runs `vinaya-check --all --diff-only`, alongside your existing workflows — refusing to overwrite rather than touching foreign content already at that path. Git hook stubs invoke the `vinaya` binary directly; if a hook already exists, it appends a delimited managed block, shown verbatim in the diff first, rather than overwriting it.',
      "`vinaya.config.json` is seeded with a starter ruleset extracted from Vinaya's own battle-tested gates, not invented defaults. Issue and PR templates carrying the brief schema are added alongside your own; tier and `needs:*-input` labels are created only if they don't already exist — your existing labels are never modified.",
      'Two empty folders — `vinaya/checks/` and `vinaya/roles/` — are scaffolded alongside the config, each held open by a placeholder file (git does not track empty directories). `vinaya new noop-check` and `vinaya new role` write their real output into these folders later; both placeholders are recorded in the ownership manifest, so `eject` removes them exactly like everything else `init` created.',
      'The generated workflows reach the `vinaya` binary through `npx @attalabs/vinaya`, with no build step — unless your repo vendors the CLI itself (a workspace member declaring the name `@attalabs/vinaya`), in which case `npx` would resolve to that unbuilt local member instead of the registry. `init` detects that at generation time and writes workflows that build and run your own copy by path instead, so your CI exercises the code in the pull request. `upgrade` and `doctor` make the same determination, so regenerating is stable.',
      'The recommended branch-protection command is printed for you to run yourself — it is never applied, and your PATH is never touched. `eject` removes exactly the managed block it owns, or a whole file only if `init` created it.'
    ],
    status: 'shipped'
  },
  {
    name: 'init product',
    needs: [],
    description: 'Register a project in .vinaya/projects.md in an already-initialized repo',
    flags: [
      {
        flag: '--path <path>',
        description: "The project's home folder — declared, not derived. Defaults to the repo root."
      }
    ],
    details: [
      "Writes (or appends to) `.vinaya/projects.md` — the registry Vinaya Studio's tranche board resolves a project's board link against. Idempotent: re-running with the same name updates nothing.",
      'Reaches no forge and needs no GitHub remote or credentials: the registry row is a pure local file write, and it is deliberately NOT recorded in the ownership manifest, so `eject` does not reverse adopter-declared data.',
      "Creates no label. Project is a field, not a label: a task Issue declares its project in the body's `**Project:**` field, and a `project:*` label is ignored wherever one still exists."
    ],
    status: 'shipped'
  },
  {
    name: 'new check',
    needs: [],
    description: 'Scaffold a custom check into ./scripts/vinaya-checks/',
    details: [
      'Takes the REGISTRATION KEY, not a bare name: `vinaya new check <yourname>/<id>` writes `./scripts/vinaya-checks/<id>.ts` and prints the namespaced `checks` entry to paste. It refuses a bare, un-namespaced name — `vinaya check` refuses its entire run over a key it cannot resolve, so scaffolding one would brick every check invocation in the repo — and refuses a core check id, since registering one REPLACES that core gate and a scaffolded stub is never what an adopter means by that.'
    ],
    status: 'shipped'
  },
  {
    name: 'new noop-check',
    needs: [],
    description: 'Scaffold an explicit no-op into vinaya/checks/ that silences a core check',
    details: [
      'Takes a CORE check id — the opposite of what `new check` accepts, which refuses one. `vinaya new noop-check <core-check-id>` writes `vinaya/checks/<id>.ts`, an explicit, contract-satisfying no-op (always exits `0`, emits no findings, carries a comment marking the silencing as intentional) and prints the `checks` entry that REPLACES the named core check with it. This is the only sanctioned way to silence a core check.'
    ],
    status: 'shipped'
  },
  {
    name: 'new role',
    needs: [],
    description: 'Scaffold an additive role contract into vinaya/roles/',
    details: [
      'Takes the REGISTRATION KEY: `vinaya new role <yourname>/<id>` writes `vinaya/roles/<id>.md` — a structurally-valid role contract stub (the six frontmatter keys plus `title`/`order`, and a non-empty "## The short version" section) whose own `role_id` is set to `<id>` — and prints the `roles` entry to paste. It refuses a bare, un-namespaced key: that shape resolves as an OVERRIDE of a core role, a complete replacement of that role\'s contract and a real governance decision this scaffolder does not make for you.'
    ],
    status: 'shipped'
  },
  {
    name: 'brief render',
    needs: ['forge', 'default-branch'],
    description: 'Emit the twelve-section brief skeleton from the forge and the tree, every derivable section filled',
    flags: [
      { flag: '--surfaces <glob1,glob2,...>', description: 'Intended surface globs, expanded against tracked files' },
      { flag: '--out <path>', description: 'Write the rendered brief to a file instead of stdout' }
    ],
    details: [
      // AEG:CLAIM: harness/processes/vinaya-strict/tools/task-contract/brief-render.ts contains:export function renderBrief(facts: BriefFacts, template: string): RenderResult {
      // AEG:CLAIM: apps/cli/src/commands/brief.ts contains:refuse(`cannot render — missing fact(s):
      "Reads the task Issue (`vinaya/tranche:<tranche>`-labeled, id `<n>`) and the tree, and fills every section a program can derive: the header `Project:`/`Tier:`/`Closes #N`, the Step 0 worktree line, the dispatch-gate status as the pre-flight line, §4's file list (with consumer packages and a `sha256` premise pin per file, and Out of surface from the Issue's own `## Surface` `out:` list), §6 from the Issue's `## Parts`, §7 from the `.vinaya/doc-owners` derivation, §9 from the Issue's `## Test plan`, §10 from the Issue's `## Stop conditions` plus the rationale's Stop-and-escalate field, and every remaining section from the Issue's eight-field Planner rationale. Refuses — naming the missing section — when it cannot be derived: no Issue, the dispatch gate not clear, a `--surfaces` glob matching no tracked file, or the Issue missing/malformed `## Surface`/`## Parts`/`## Test plan`/`## Stop conditions` — never a bracketed placeholder.",
      'Never writes under `vinaya-strict/` or to the Issue — a brief is pasted to the Developer, never committed. Reads `artifacts/templates/brief-template.md` at run time for its one fixed sentence and the standing autonomy clause; every other byte is generated from the forge/tree facts.'
    ],
    status: 'shipped'
  },
  {
    name: 'task run',
    needs: ['forge', 'operator-seat'],
    description: 'One command from a planned Issue to a reviewed pull request — exactly one developer started',
    flags: [
      {
        flag: '--runner <standalone|atta-engine>',
        description: 'Override runner config for this invocation; absent uses config, whose default is standalone'
      },
      {
        flag: '--agent <claude|codex>',
        description: 'Vendor for the developer and both reviewers this run dispatches'
      },
      {
        flag: '--quiet',
        description:
          "Hide the detail lines (an agent's prose, full commands, failed-result tails) on the live terminal; the driver log file keeps them"
      },
      {
        flag: '--widen-surface <glob,...> --reason <text>',
        description:
          "Continue a pre-pull-request escalation whose Developer asked for `widen_surface`: supersede the frozen brief with the globs added to `## Surface`, record that as the escalation's resolution, grade the widened Issue through the write gate, then start the run"
      },
      {
        flag: '--rollback',
        description:
          'Run the terminate-and-restart procedure for this task: cancel its in-flight Engine run, reconcile every prepared and uncertain effect by its identity, then start a fresh standalone run from the same frozen brief. Refuses a task whose recorded runner is not `atta-engine`'
      }
    ],
    details: [
      'The atta-engine runner starts the workspace Engine script with Bun, streams its output and returns its exit code. A published install without the script prints one notice and falls back to standalone. Engine Log events use the local folder only; logs: false disables all Log destinations for both runners.',
      // AEG:CLAIM: harness/processes/vinaya-strict/loops/dev-review/run-control/task-run-engine.ts contains:export function crossRunnerRefusalReason(
      "A run's runner is recorded when it starts and never changes: switching `runner` in config changes only the runner of new runs, and a run recorded on `atta-engine` keeps routing to the Engine for `task status`, `task_resume` and `task_cancel`. A start on a pause another runner holds is refused with a typed reason naming the recorded runner and the requested one, and so is a start on another runner's Engine run that is still in flight with no pause held — halted or stopped short of completed or cancelled.",
      // AEG:CLAIM: harness/processes/vinaya-strict/loops/dev-review/run-control/backend-rollback.ts contains:export async function terminateAndRestart(
      "`--rollback` ends the Engine run first: a held pause through the shared cancel `task_cancel` uses, which needs a Principal ruling newer than the pause as any cancel does; a run halted with no pause held has its started effects fenced; a run that already completed or was cancelled is refused, as is a driver still running with no pause held, which is never signalled; and the standalone run never starts while the Engine driver lives, a cancelled run's driver given a bounded wait to release its lock. Every started and uncertain effect is then reconciled by its identity: one the forge carries is recorded verified, one it does not carry is left for the restarted run to complete, and one the forge read cannot settle refuses the restart. Each rehearsal appends a record — task, recorded runner, action, reconciled effect identities, the restarted run's runner and terminal state — to `backend-rollback-rehearsals.jsonl` in the task's runtime directory, whether it completed, was refused or failed at a later step, and nothing removes it.",
      // AEG:CLAIM: harness/processes/vinaya-strict/loops/dev-review/run-control/task-run.ts contains:async function widenSurfaceBeforeRun(
      "`--widen-surface` is the Planner's one command for a widen-surface escalation, and refuses before any write when the held pause is not one (no pause, a pause with a pull request — whose continuation is the ruling on that pull request — or a round whose Developer asked for no `widen_surface`), when a driver is still alive for the task, when the escalation's resolution is already consumed (a replay — the Surface is never widened twice), or when the widened body fails the write gate, whose findings name the field to edit first. The escalation packet's permitted next actions name this command with the globs the Developer asked for, and `task_resume` refuses such an escalation naming it.",
      // AEG:CLAIM: harness/processes/vinaya-strict/loops/dev-review/run-control/task-run.ts contains:export async function runTask(
      "Prepares the frozen brief and resolves the task, branch and model once. The standalone runner then starts the watching driver (`runDriverLoop`, `dev-review-loop.ts`). Preparation starts no agent; the loop's own round 1 reads the frozen brief off the Issue and is the only place a developer is ever dispatched from a fresh task, so exactly one developer is started by construction.",
      'A brief already frozen on the Issue is reused, never re-posted — the second `task dispatch`/`task brief` call this composes around does not fail the whole run, it just skips straight to running the loop. A task whose Issue refuses preparation (a missing brief section, an unmet dispatch gate) is refused before any agent starts, with nothing posted.',
      "Refuses when the frozen brief's developer branch already has an open pull request AND a driver is still live for it — a driver that crashed or was killed leaves its PR behind, and this command is the one that revives it, in any state, pause held or not.",
      "issue-711 O4: a pause never ends this process — it keeps running and watches the pull request, continuing on its own once a newer Principal ruling appears (or, for an `'infrastructure'`/`'stale_driver'` pause, after a bounded backoff), with no `--resume` command needed for the ordinary case. Exit and printed summary distinguish a published pull request OR a watched pause's own genuine end — merged, closed, or an operator's own `--cancel` (exit `0` either way, the PR URL) — from the one pause this process can never watch (no pull request exists yet — exit `1`, with the working `vinaya task run` command for this task's own branch to continue by hand — `<tranche> <n>` for a tranche task, `--issue <n>` for a backlog one — never a `dev-review-loop --resume` line naming a pull-request number this pause does not have), a usage/argv error (exit `2`), and any other failure (exit `3`)."
    ],
    status: 'shipped'
  },
  {
    name: 'task switch',
    needs: ['forge'],
    description:
      "Change a task's agent or model by setting its Engine checkpoint aside, so the next `task run` is accepted",
    flags: [
      { flag: '--issue <n>', description: 'Address the task by its Issue number instead of `<tranche> <n>`' },
      { flag: '--agent <claude|codex>', description: 'Vendor the next `task run` of the task continues on' },
      { flag: '--model <model>', description: 'Model the next `task run` is meant to use; absent, the vendor default' }
    ],
    details: [
      "Refuses, changing nothing, while a driver for the task is alive, naming its pid. Otherwise moves the task's Engine checkpoint (`checkpoints.sqlite` with its `-wal` and `-shm` files) into a timestamped `switched-*` folder of the task's run directory and never deletes it; the branch, its commits and its pull request are untouched, so the next `task run` with the new agent continues the same branch on a fresh checkpoint.",
      "Writes one driver-log line naming the from and to agent, the from and to model and the folder the checkpoint went to. On the standalone runner it changes nothing on disk and says that runner already continues a task on a new `--agent` by itself. `task run` and `run-engine --resume` still refuse an agent other than the checkpoint's, and their refusal names this command."
    ],
    status: 'shipped'
  },
  {
    name: 'task status',
    needs: ['forge'],
    description:
      'Every open task with a frozen brief, its pull request, and whether its loop is running, paused, or published',
    flags: [
      { flag: '--json', description: 'Enveloped JSON output (schema: 1)' },
      {
        flag: '--follow',
        description:
          "Tail the task's driver log live, with its detail lines, on either the `<tranche> <n>` form or `--issue <n>`"
      },
      { flag: '--quiet', description: 'With `--follow`, hide the detail lines; the log file is unchanged' }
    ],
    details: [
      'Read-only: one `gh issue list` for every open task Issue across every tranche (title/label resolved through the same `resolveTaskIssueRef` `list-tasks.ts` already uses), the open pull request per branch, and the driver pid record / pause record / publish effect markers under `<outboxRoot>/dev-review-loop/<task>/` — never a `ps` scan, never a re-parse of posted verdict comments to decide `published`.',
      "`running` names the driver's pid (`review-validity-v1` task 7's pid record); `paused` names the reason from the pause record; `published` means the newest round's reviewer and security verdict effect markers both read `posted`; `no driver` is the fallback when none of the above holds.",
      "`vinaya task status <tranche> <n>` narrows to one task and adds the last round's held or published verdict lines (`round-<n>-reviewer.md`/`round-<n>-security.md`, whichever their outbox carries) plus the exact `vinaya-dev-review-loop --resume <pr>` command when paused."
    ],
    status: 'shipped'
  },
  {
    name: 'pr rule',
    needs: ['forge', 'operator-seat'],
    description: 'Post a Principal ruling on a PR, marked and versioned — never mistaken for a review verdict',
    flags: [
      { flag: '--file', description: 'Path to the ruling file to post as a PR comment' },
      { flag: '--json', description: 'Enveloped JSON output (schema: 1)' }
    ],
    details: [
      // AEG:CLAIM: harness/processes/vinaya-strict/tools/task-contract/verdict-extraction.ts contains:function firstFiveLines(comment: string): string {
      "Refuses before posting when the file's first line reads as an escalation (`ESCALATE:`), or when the file carries verdict grammar anywhere `extractCodeReviewVerdict`/`extractSecurityReviewVerdict` would treat as a candidate — a `VERDICT:` line past the extractor's own first-five-line window still counts, since the whole-body candidate test is what disqualifies the file, not merely a clean read.",
      'Marker numbers (`<!-- aeg:principal:ruling:<pr>-<k> -->`) are counted on the forge at post time from `gh pr view --json comments`, never derived from a local file — two rulings racing to the same number are a known, undocumented-lock case.'
    ],
    status: 'shipped'
  },
  {
    name: 'issue create',
    needs: ['forge'],
    description: 'Open an issue after full brief-schema validation',
    flags: [
      { flag: '--title', description: 'Issue title (validated on task Issues)' },
      { flag: '--body-file', description: 'Path to the Issue body (stream-safe; same bytes validated and sent)' },
      { flag: '--label', description: 'Label(s) to apply; a `vinaya/tranche:*` label marks a task Issue' },
      { flag: '--validate-only', description: 'Run every gate and report PASS without opening the Issue' },
      { flag: '--json', description: 'Enveloped JSON output (schema: 1)' }
    ],
    details: [
      'A task Issue (any `vinaya/tranche:*` label) must carry the full Planner rationale (`briefSchema.issue`); non-task Issues pass through unvalidated.'
    ],
    status: 'shipped'
  },
  {
    name: 'issue edit',
    needs: ['forge'],
    description: 'Edit an existing issue (<n>) after full brief-schema validation',
    flags: [
      { flag: '--title', description: 'New Issue title (validated on task Issues)' },
      { flag: '--body-file', description: 'Path to the new Issue body (stream-safe; same bytes validated and sent)' },
      { flag: '--validate-only', description: 'Run every gate and report PASS without editing the Issue' },
      { flag: '--json', description: 'Enveloped JSON output (schema: 1)' }
    ],
    details: [
      "The target Issue's actual labels are fetched from the forge and unioned with argv to decide task-Issue applicability — a failed fetch is a hard refusal."
    ],
    status: 'shipped'
  },
  {
    name: 'issue surface',
    needs: [],
    description: "Print what a draft Issue's Boundary pins force on its `## Surface`",
    flags: [
      { flag: '--body-file', description: 'Path to the draft Issue body' },
      { flag: '--json', description: 'Enveloped JSON output (schema: 1)' }
    ],
    details: [
      "For every Boundary-pinned file, each tracked source or test that imports it, marked `reached` (an `in:` glob covers it), `disclaimed` (the Boundary's `Out:` clause names it or its directory) or `uncovered` (with the directory glob that would reach it). A `## Surface` `out:` glob never disclaims an importer. Also reports the CI shard list when a pinned CLI test file is new, and the loop invariant map's fixture and spec when a pinned loop file is new.",
      'The importers are decided by the same function `issue create` and `issue edit` refuse with, over the same importer listing — an importer this report calls `uncovered` is one the write gate refuses, and every other one it accepts.',
      'Writes nothing and reads no forge. Exits 0 with the report, or 2 when the body cannot be read or its `## Surface` does not parse.'
    ],
    status: 'shipped'
  },
  {
    name: 'issue objectives edit',
    needs: ['forge'],
    description: "Rewrite a task Issue's `## Objectives` section by command — versioned, findable on the forge",
    flags: [
      { flag: '--add', description: 'Append a new objective as `O<max+1>` with the given sentence' },
      { flag: '--drop', description: 'Remove an objective by id (`O<k>`) — never renumbers the survivors' },
      {
        flag: '--replace',
        description: 'Replace an objective\'s sentence in place, keeping its id (`O<k>` "<sentence>")'
      },
      { flag: '--reason', description: 'Required, non-empty: why this change is being made' },
      { flag: '--json', description: 'Enveloped JSON output (schema: 1)' }
    ],
    details: [
      'Exactly one of `--add`/`--drop`/`--replace` is required. Every edit goes through the same validated `issue edit` write path (`writeValidatedIssueEdit`) as `vinaya issue edit` itself — no second, unvalidated write path.',
      "A `--drop` that leaves the surviving objectives non-contiguous from `O1` is refused with `objectivesOf`'s own parser message: dropping never renumbers survivors, and task 1's contiguous-from-O1 grammar is the one parser everything else reads, so a live contradiction between the two stops here for a Principal ruling rather than silently renumbering.",
      'Splices the rendered section back in place (`## Objectives` heading through the next `##` heading, or end of body) — every other byte of the Issue body is untouched. Posts one comment marked `<!-- aeg:objectives:v<k> -->` carrying the previous list, the new list, the reason, and the new `objectivesVersion`; `k` is counted on the forge at post time, never derived from a local file.'
    ],
    status: 'shipped'
  },
  {
    name: 'milestone create',
    needs: ['forge'],
    description: 'Create a GitHub Milestone from a validated body',
    flags: [
      { flag: '--title', description: 'Milestone title — free text, never parsed for a version' },
      {
        flag: '--body-file',
        description: 'Path to the Milestone description (stream-safe; same bytes validated and sent)'
      },
      { flag: '--validate-only', description: 'Run every gate and report PASS without creating the Milestone' },
      { flag: '--json', description: 'Enveloped JSON output (schema: 1)' }
    ],
    details: [
      "Refuses before any `gh` call when the goal is absent, an optional `Release:` field is present but not a version, or an optional `### Tranche intents` section (`- <slug>: <intent text>`) doesn't parse. `Release:` is the sole authority for the milestone's version — the title is never parsed for one."
    ],
    status: 'shipped'
  },
  {
    name: 'milestone adopt',
    needs: ['forge'],
    description: 'Move one or more existing tranches into a target Milestone',
    flags: [
      { flag: '--target', description: 'The Milestone every named slug is adopted into' },
      { flag: '--slug', description: 'A tranche slug to adopt — repeatable for a multi-slug move' },
      { flag: '--validate-only', description: 'Run every gate and report PASS without writing anything' },
      { flag: '--json', description: 'Enveloped JSON output (schema: 1)' }
    ],
    details: [
      "Reattaches every Issue carrying each named `vinaya/tranche:<slug>` label to `--target`, then closes (never deletes) each slug's old tranche-Milestone. Every fact for every named slug is gathered and checked in ONE call before any write, so a single unsafe slug — an unknown slug, a slug whose label carries no Issues, a target that does not exist or is closed, or a slug already adopted into a different Milestone — refuses the whole invocation, not just its own slug."
    ],
    status: 'shipped'
  },
  {
    name: 'milestone edit',
    needs: ['forge'],
    description: 'Edit an existing Milestone (<n>) after full brief-schema validation',
    flags: [
      {
        flag: '--body-file',
        description: 'Path to the new Milestone description (stream-safe; same bytes validated and sent)'
      },
      { flag: '--validate-only', description: 'Run every gate and report PASS without editing the Milestone' },
      { flag: '--json', description: 'Enveloped JSON output (schema: 1)' }
    ],
    details: [
      'Same `checkMilestoneShape` refusal `create` runs, before any `gh` call — the gated replacement for a raw `gh api PATCH` against a Milestone. Only the description changes; the title is untouched.'
    ],
    status: 'shipped'
  },
  {
    name: 'milestone close',
    needs: ['forge'],
    description:
      "Close a tranche's Milestone after verifying every labeled Issue is attached and every tranche it declares is complete",
    flags: [
      { flag: '--slug', description: 'The tranche whose Milestone is being closed' },
      { flag: '--validate-only', description: 'Run every gate and report PASS without closing the Milestone' },
      { flag: '--json', description: 'Enveloped JSON output (schema: 1)' }
    ],
    details: [
      "Resolves the target Milestone the same legacy-or-intent-declared way Issue create auto-attach does, then refuses to close on any mismatch between the label's Issues and the Milestone's natively attached Issues — naming each unattached or foreign Issue and its repair path (`gh issue edit <n> --milestone <title>`, or `vinaya milestone adopt`) — before the PATCH ever reaches the forge. It also holds the Milestone open while a tranche its `### Tranche intents` section declares is not complete — naming each unfinished tranche and its lifecycle — or while that section carries no readable tranche line; a Milestone with no such section closes on attachment alone. `--validate-only` refuses with the same reasons."
    ],
    status: 'shipped'
  },
  {
    name: 'milestone status',
    needs: ['forge'],
    description: "Print each of a Milestone's declared tranche intents with its derived lifecycle and issue counts",
    flags: [{ flag: '--json', description: 'Enveloped JSON output (schema: 1)' }],
    details: [
      "Read-only — writes nothing. For each `- <slug>: …` line in the Milestone's `### Tranche intents` section, prints the tranche's lifecycle (`planned`/`active`/`complete`) and its labeled Issues' counts (merged, open, not planned), all derived from the forge. Refuses if `<n>` isn't a real Milestone in this repo, or if the forge is unreachable."
    ],
    status: 'shipped'
  },
  {
    name: 'doctor',
    needs: ['forge'],
    description: 'Diagnose hook, workflow, and config health — report only, never mutates',
    flags: [{ flag: '--json', description: 'Enveloped JSON output (schema: 1)' }],
    details: [
      'Carries the same env-declaration diagnostic `vinaya-check` warns with — permanently, at `info` severity, not just ahead of the spawn-default flip — plus a `warn`-severity lint over suspicious `env` literal forms (a stray `"true"`/`"false"` string, or a high-entropy literal that reads like a leaked secret committed to config).',
      'Also carries the two permanent `checks`-classification diagnostics: a config key that REPLACES a core check (`warn`), and a bare un-namespaced key that is REJECTED (`error`, naming the rename requirement). These are the reason a config `vinaya-check` now refuses outright is still diagnosable — the refusal runs nothing, so `doctor` is the surface that explains why.'
    ],
    status: 'shipped'
  },
  {
    name: 'doctrine',
    needs: [],
    description:
      "Print the absolute path of the bundled doctrine's front door (doctrine/skills/vinaya/SKILL.md) on this machine",
    flags: [
      {
        flag: '--role <name>',
        description: 'Resolve to a specific role file (roles/<name>.md) instead of the front door'
      },
      {
        flag: '--template <name>',
        description: 'Print a template the package ships (templates/<name>-template.md) instead of the front door'
      },
      {
        flag: '--print',
        description:
          "Emit the resolved file's body (frontmatter stripped) instead of its path — the one-hop mode every generated skill and slash command invokes. A role file whose frontmatter carries an `ack-token` emits that token as the output's own first line."
      },
      { flag: '--json', description: 'Enveloped JSON output (schema: 1) — `{ root, entry }`' }
    ],
    details: [
      'The committed root `AGENTS.md` pointer names the `@attalabs/vinaya` package, never a filesystem path — where the package sits is a property of each machine, not of the repo, and the pointer is committed for every clone. This command is the read-time resolution step the pointer hands the reader: it resolves the installed package\'s own bundled `vinaya-strict/` wherever the CLI physically sits and prints the front door\'s absolute path, so `cat "$(vinaya doctrine)"` opens the doctrine on any machine at any version.',
      "In a repo that vendors the CLI, the bundled copy is a gitignored pack-time artifact, so the command falls back to the monorepo's own `harness/processes/vinaya-strict/` — the same directory `bundle-doctrine` copies from. Exits 1 with a corrective message when neither location holds a doctrine."
    ],
    status: 'shipped'
  },
  {
    name: 'upgrade',
    needs: [],
    description: 'Regenerate hooks, workflow, and config to the current contract version (diff-and-confirm)',
    flags: [
      { flag: '--dry-run', description: 'Print the full diff without regenerating anything' },
      { flag: '--yes', description: 'Skip the confirmation prompt' }
    ],
    details: [
      'When `claude` is a selected agent vendor, also retrofits the Claude Code `Stop` hook (`.claude/hooks/track-transcript.sh`, `.claude/settings.json`) the same way `init` installs it on a fresh repo — for a repo that ran `init` before this hook existed, closing the gap that left token rows reading `—/—/—` with no operator ever told to re-run `init`. Never overwrites a foreign `.claude/settings.json` (refuse-if-foreign, same as `init`); appends to a foreign Stop-hook script rather than replacing it (managed-block, same discipline as the git hooks).'
    ],
    status: 'shipped'
  },
  {
    name: 'eject',
    needs: [],
    description: 'Remove every Vinaya-installed artifact, restoring the repo to stock',
    flags: [
      { flag: '--dry-run', description: 'Print the full removal diff without removing anything' },
      { flag: '--yes', description: 'Skip the confirmation prompt' }
    ],
    status: 'shipped'
  },
  {
    name: 'quickstart',
    needs: ['forge'],
    description: 'Guided wizard: init, doc-owners, project, commit, demo break, doctor, push — one command',
    details: [
      "Calls `init`'s own diff-and-confirm flow unchanged (pausing on Enter before the diff prints, so its own step header isn't scrolled off by a long diff), then Y/n-prompts through the workarounds a guest used to run by hand: binding `.vinaya/doc-owners` pairs (bad input offers a retry instead of silently skipping, and a pointer that doesn't exist on disk is refused outright — both loop across as many pairs as the guest wants, not just one), registering tracked projects (`init product`, same retry/loop shape), committing the install, running `demo break` as proof the gates actually work (default yes — the one step this wizard makes hardest to skip), running `doctor`, and pushing. Each declined prompt skips only that step; the install commit itself is never prompt-gated — it just no-ops when there is genuinely nothing to commit.",
      'Never reimplements or edits `init`/`init product`/`demo break`/`doctor` — it only calls their existing, unmodified entry points in sequence.'
    ],
    status: 'shipped'
  }
]
