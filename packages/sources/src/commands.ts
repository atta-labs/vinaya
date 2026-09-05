export type CommandStatus = 'shipped' | 'planned'

export type CommandFlag = {
  flag: string
  description: string
}

export type Command = {
  name: string
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
    description: 'Show this help text',
    status: 'shipped'
  },
  {
    name: 'version',
    description: 'Print the CLI version',
    flags: [{ flag: '--json', description: 'Enveloped JSON output (schema: 1)' }],
    status: 'shipped'
  },
  {
    name: 'init',
    description: "Install Vinaya's git hooks, CI workflow, and starter config (diff-and-confirm, non-destructive)",
    flags: [
      { flag: '--dry-run', description: 'Print the full diff without installing anything' },
      { flag: '--yes', description: 'Skip the confirmation prompt' }
    ],
    details: [
      'It detects your repo, prints the complete diff of every intended change, and waits for your confirmation before installing anything. `--dry-run` prints that same diff and installs nothing. Nothing ever runs automatically on package install.',
      'It installs one CI workflow that runs `vinaya check --all --diff-only`, alongside your existing workflows — refusing to overwrite rather than touching foreign content already at that path. Git hook stubs invoke the `vinaya` binary directly; if a hook already exists, it appends a delimited managed block, shown verbatim in the diff first, rather than overwriting it.',
      "`vinaya.config.json` is seeded with a starter ruleset extracted from Vinaya's own battle-tested gates, not invented defaults. Issue and PR templates carrying the brief schema are added alongside your own; tier and `needs:*-input` labels are created only if they don't already exist — your existing labels are never modified.",
      'Two empty folders — `vinaya/checks/` and `vinaya/roles/` — are scaffolded alongside the config, each held open by a placeholder file (git does not track empty directories). `vinaya new noop-check` and `vinaya new role` write their real output into these folders later; both placeholders are recorded in the ownership manifest, so `eject` removes them exactly like everything else `init` created.',
      'The generated workflows reach the `vinaya` binary through `npx @attalabs/vinaya`, with no build step — unless your repo vendors the CLI itself (a workspace member declaring the name `@attalabs/vinaya`), in which case `npx` would resolve to that unbuilt local member instead of the registry. `init` detects that at generation time and writes workflows that build and run your own copy by path instead, so your CI exercises the code in the pull request. `upgrade` and `doctor` make the same determination, so regenerating is stable.',
      'The recommended branch-protection command is printed for you to run yourself — it is never applied, and your PATH is never touched. `eject` removes exactly the managed block it owns, or a whole file only if `init` created it.'
    ],
    status: 'shipped'
  },
  {
    name: 'init product',
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
    name: 'check',
    description: 'Run one check, or every registered check',
    flags: [
      { flag: '--all', description: 'Run every registered check instead of one named check' },
      { flag: '--json', description: 'Enveloped JSON output (schema: 1)' },
      { flag: '--diff-only', description: 'Scope diff-declared checks to changed files' },
      {
        flag: '--local',
        description: 'Skip every requiresOpenPr check (closes-n, test-plan) — set by the generated hooks, never by CI'
      },
      { flag: '--parallel[=n]', description: 'Concurrency cap (default: cpu-derived)' },
      {
        flag: '--plan',
        description:
          'Print the resolved check registry and the resolved `roles` registry (default/overridden/additive) without running anything'
      }
    ],
    details: [
      "Each spawned check's child process sees only a fixed baseline (`PATH`, `LANG`, `HOME`, `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `TMPDIR`) plus whatever its `CheckSpec['env']` declaration explicitly forwards — never the full parent environment. A required (`true`) or unsatisfied `anyOf` declaration missing from the caller's environment synthesizes a `CheckError` before the check ever spawns. Declare `env` (a core check's own registration, or `vinaya.config.json`'s `checks.<name>.env` for a custom one) for any check that reads `process.env`/`Bun.env`/`Deno.env` directly — `vinaya doctor` carries the permanent diagnostic for one that doesn't.",
      'The resolved registry IS what runs. A `checks` key that exactly matches a core check id REPLACES that core check (the core one does not run); any other key must be namespaced `<yourname>/<id>`. Anything the resolver cannot classify — a malformed entry, a bare un-namespaced key matching no core id, a duplicate id — makes `vinaya check` refuse the ENTIRE run: exit 1, nothing executes, never a partial ruleset and never a core-only fallback. `vinaya doctor` carries the permanent diagnostic for each rejected entry, so a refused config is still diagnosable.',
      '`--plan` composes with `--json`. It requires zero env vars and never prints an env value — only how each one resolves (passthrough, optional, literal, or anyOf). A `FAIL_CLOSED` entry always renders inline rather than being dropped, and exits non-zero. `--plan` and execution read the same resolution, so what the plan prints is what runs.',
      "`--local` exists because a `requiresOpenPr` check (the core `closes-n`/`test-plan`, or a custom check declaring the same field) can only evaluate for real once a pull request exists — the generated `pre-commit`/`pre-push` hooks pass it so the first commit on a fresh task branch is never asked to satisfy a PR-body field before a PR can possibly exist. CI's `vinaya-checks.yml` omits it, so these checks always run for real once a PR is open.",
      "`--plan`'s `roles` half resolves `vinaya.config.json`'s `roles` block against bundled doctrine — same override/additive shape as `checks`, with its own RENDERS AS column (the registry key and the role's own `role_id` differ for an additive entry) and a GATING column (`core` vs. `inert` — an additive role carries no core `ACTIONS` wiring). `roles.available` is `false` only when no bundled doctrine can be found next to this CLI install."
    ],
    status: 'shipped'
  },
  {
    name: 'commit-msg',
    description: "The generated `commit-msg` hook's invocation target — validates a commit message's first line",
    details: [
      "Not meant to be run by hand day-to-day: the managed `commit-msg` hook calls `vinaya commit-msg <message-file> [source]` with the two arguments git itself passes a commit-msg hook (githooks(5)) — the message file path and, when known, the commit's source keyword.",
      "Validates the message file's first line against the same `Type(scope): Description` vocabulary `check`'s `forge-title`-shaped gates enforce on PR/Issue titles (`@attalabs/aeg-core`'s `COMMIT_TYPES` — the commitlint type set plus `Plan`). Exits 0 with no output on a conforming message; a `source` of `merge` is skipped outright, since a merge commit's message is written by git, not the person committing."
    ],
    status: 'shipped'
  },
  {
    name: 'new check',
    description: 'Scaffold a custom check into ./scripts/vinaya-checks/',
    details: [
      'Takes the REGISTRATION KEY, not a bare name: `vinaya new check <yourname>/<id>` writes `./scripts/vinaya-checks/<id>.ts` and prints the namespaced `checks` entry to paste. It refuses a bare, un-namespaced name — `vinaya check` refuses its entire run over a key it cannot resolve, so scaffolding one would brick every check invocation in the repo — and refuses a core check id, since registering one REPLACES that core gate and a scaffolded stub is never what an adopter means by that.'
    ],
    status: 'shipped'
  },
  {
    name: 'new noop-check',
    description: 'Scaffold an explicit no-op into vinaya/checks/ that silences a core check',
    details: [
      'Takes a CORE check id — the opposite of what `new check` accepts, which refuses one. `vinaya new noop-check <core-check-id>` writes `vinaya/checks/<id>.ts`, an explicit, contract-satisfying no-op (always exits `0`, emits no findings, carries a comment marking the silencing as intentional) and prints the `checks` entry that REPLACES the named core check with it. This is the only sanctioned way to silence a core check.'
    ],
    status: 'shipped'
  },
  {
    name: 'new role',
    description: 'Scaffold an additive role contract into vinaya/roles/',
    details: [
      'Takes the REGISTRATION KEY: `vinaya new role <yourname>/<id>` writes `vinaya/roles/<id>.md` — a structurally-valid role contract stub (the six frontmatter keys plus `title`/`order`, and a non-empty "## The short version" section) whose own `role_id` is set to `<id>` — and prints the `roles` entry to paste. It refuses a bare, un-namespaced key: that shape resolves as an OVERRIDE of a core role, a complete replacement of that role\'s contract and a real governance decision this scaffolder does not make for you.'
    ],
    status: 'shipped'
  },
  {
    name: 'brief render',
    description: 'Emit the twelve-section brief skeleton from the forge and the tree, every derivable section filled',
    flags: [
      { flag: '--surfaces <glob1,glob2,...>', description: 'Intended surface globs, expanded against tracked files' },
      { flag: '--out <path>', description: 'Write the rendered brief to a file instead of stdout' }
    ],
    details: [
      "Reads the task Issue (`vinaya/tranche:<tranche>`-labeled, id `<n>`) and the tree, and fills every section a program can derive: the header `Project:`/`Tier:`/`Closes #N`, the Step 0 worktree line, the dispatch-gate status as the pre-flight line, §4's file list (with consumer packages and a `sha256` premise pin per file), §7 from the `.vinaya/doc-owners` derivation, and every remaining section from the Issue's eight-field Planner rationale. Refuses — naming the missing fact — when a derived section cannot be derived: no Issue, the dispatch gate not clear, or a `--surfaces` glob matching no tracked file.",
      'Never writes under `aeg-root/` or to the Issue — a brief is pasted to the Developer, never committed. Reads `aeg-root/templates/brief-template.md` at run time for its one fixed sentence and the standing autonomy clause; every other byte is generated from the forge/tree facts.'
    ],
    status: 'shipped'
  },
  {
    name: 'pr create',
    description: 'Open a pull request after full brief-schema validation',
    flags: [
      { flag: '--title', description: 'PR title (validated against the forge-title grammar)' },
      { flag: '--body-file', description: 'Path to the PR body (stream-safe; the same bytes are validated and sent)' },
      { flag: '--label', description: 'Label(s) to apply (repeatable, comma-separated)' },
      { flag: '--validate-only', description: 'Run every gate and report PASS without opening the PR' },
      { flag: '--json', description: 'Enveloped JSON output (schema: 1)' }
    ],
    details: [
      'Runs the config-defined brief-schema gate (`briefSchema.pr` in `vinaya.config.json`) LOCALLY before any `gh` write — prevention, not detection. On any failure it refuses with the versioned CheckError contract (one JSON line per finding on stderr, exit 1) whose `agent_recovery_prompt` names the exact corrective command.',
      'Which sections bind depends on the branch, matching the `brief-shape` check that runs the same grammar in CI. On a `task/<tranche>/<n>` branch every configured section binds, `closesN` included. On any other branch a body that is not brief-shaped is exempt entirely — an ordinary one-line dependency bump is not made to grow a brief — while a brief-shaped body is still graded on every other section, since a standalone fix brief is a brief; only `closesN` is dropped, because such a branch has no task Issue to close. The title grammar sits outside all of this and binds on every branch.',
      'A branch counts as resolvable only when HEAD is a symbolic ref that also resolves to a commit. Neither git query answers that alone: `rev-parse --abbrev-ref HEAD` reports the literal string `HEAD` on a detached HEAD, and `symbolic-ref` reports the not-yet-created branch name when HEAD is unborn. Reading either as an ordinary branch would take the relaxed path, so both states — plus running outside a repo — resolve to nothing and the gate is fail-closed: every configured section is enforced.'
    ],
    status: 'shipped'
  },
  {
    name: 'pr edit',
    description: 'Edit an existing pull request (<n>) after full brief-schema validation',
    flags: [
      { flag: '--title', description: 'New PR title (validated against the forge-title grammar)' },
      { flag: '--body-file', description: 'Path to the new PR body (stream-safe; same bytes validated and sent)' },
      { flag: '--validate-only', description: 'Run every gate and report PASS without editing the PR' },
      { flag: '--json', description: 'Enveloped JSON output (schema: 1)' }
    ],
    details: [
      "The target PR's real head branch and changed files are fetched from the forge to build the validation context — a failed fetch is a hard refusal, never a fall-back to the local checkout.",
      'That fetched head branch is what selects the section set, by the same branch grammar `pr create` uses — a property of the target PR, never of whatever the local checkout happens to have checked out.'
    ],
    status: 'shipped'
  },
  {
    name: 'pr report',
    description: "Emit the AEG:EVIDENCE block — a PR body's factual claims, from commands, never typed",
    flags: [
      {
        flag: '--write',
        description: 'Path to the PR body file; replaces the content between the AEG:EVIDENCE anchors in place'
      },
      {
        flag: '--push',
        description:
          "PR number; splices the same content into that PR's LIVE body (fetched from the forge) and pushes it via `gh pr edit`, self-verifying nothing outside the AEG:EVIDENCE/AEG:TOKENS regions changed. Mutually exclusive with --write."
      }
    ],
    details: [
      "Two groups: Group A (recomputable) is the head sha and a width-invariant `git diff --numstat` against the merge-base with `BASE_SHA` (else `origin/main`, then `main`) — `check-evidence-fresh` recomputes and byte-compares this exactly. Group B (attested) is the result of `vinaya check --all --diff-only`, this CLI's own portable gate suite — `check-evidence-fresh` can only check it for staleness (the block's recorded head still matches the PR's real head), never re-run it.",
      'With no `--write`/`--push`, prints the block to stdout instead of writing a file. Exits non-zero whenever the gate run failed, whether or not `--write`/`--push` was given — the block records a failing result rather than hiding one, and a non-zero exit stops a scripted `--write && open-pr` (or `--push`) from carrying a failing suite onto the forge.',
      "`--push` refuses before writing anything when the live body carries no real `AEG:EVIDENCE` pair (it never appends one, unlike `--write`), when the anchor resolves differently before and after normalisation, or when `<pr>` isn't a bare number. When the live body has no real `AEG:TOKENS` pair, the token splice is skipped (same reasoning, softer outcome) rather than creating one. After pushing, it re-reads the live body and restores the pre-edit body — exiting non-zero — if anything outside the two anchored regions changed."
    ],
    status: 'shipped'
  },
  {
    name: 'pr verify-evidence',
    description: "Prove a pull request's AEG:EVIDENCE region was machine-generated — regenerate it and compare",
    flags: [],
    details: [
      'Deliberately a command, not a check: `evidence-fresh` runs inside `vinaya check --all`, and `pr report` runs `vinaya check --all --diff-only`, so a check that regenerated the block would run the suite containing itself. That recursion is why `evidence-fresh` verifies Group A only and leaves Group B attested.',
      "Must be run from the repository ROOT of a CLEAN checkout at the pull request's head, and refuses otherwise. The regeneration inherits the working directory and several gates resolve their scan root from it, so a subdirectory silently narrows what the fresh run inspects. On cleanliness: Group B is regenerated by diff-scoped checks, so uncommitted or untracked files change which files are scanned and can produce a MATCH a clean checkout would not. Ignored paths are deliberately NOT inspected — `git diff` never reports one, so they cannot change the scope, and including them would refuse in every real checkout since `node_modules` is ignored and always present. The head is read from the forge and both a mismatch AND an unreadable head refuse — the verdict is bound to a commit, never merely attested. `BASE_SHA` is refused as well, since it steers the regeneration's merge-base.",
      'Exits 0 on MATCH; 1 on DIFFERS, HIDDEN, or no block; 2 on a refusal (dirty worktree, wrong head, usage error). HIDDEN means the anchor pair sits inside a collapsed `<details>` block, where `body-bare-digits` blanks every digit and nothing can verify what it claims.',
      'Comparison is a multiset of repo-relative, control-stripped lines: absolute paths (local AND foreign, so a block generated in CI compares against one generated on a laptop) and line order are ignored — a reorder is not a fabrication. Only the AEG:EVIDENCE region is read, since AEG:TOKENS appends by design. A moved merge-base is reported ALONGSIDE the differing lines, never instead of them.'
    ],
    status: 'shipped'
  },
  {
    name: 'issue create',
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
    name: 'issue objectives edit',
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
    description: "Close a tranche's Milestone after verifying every labeled Issue is actually attached",
    flags: [
      { flag: '--slug', description: 'The tranche whose Milestone is being closed' },
      { flag: '--validate-only', description: 'Run every gate and report PASS without closing the Milestone' },
      { flag: '--json', description: 'Enveloped JSON output (schema: 1)' }
    ],
    details: [
      "Resolves the target Milestone the same legacy-or-intent-declared way Issue create auto-attach does, then refuses to close on any mismatch between the label's Issues and the Milestone's natively attached Issues — naming each unattached or foreign Issue and its repair path (`gh issue edit <n> --milestone <title>`, or `vinaya milestone adopt`) — before the PATCH ever reaches the forge."
    ],
    status: 'shipped'
  },
  {
    name: 'review status',
    description: "Print the review loop's own state for a PR, and its branch's distance from the base",
    details: [
      'Two lines at most. The first is `CONTINUE`, `PAUSE: <reason>[ <id>]` for `reappearance`, `zero-deaths` or `max-rounds` — or, for `stale`, the actionable fact itself: `push after verdict — re-review required`. The second reads `behind main by <n> — merge first` when the branch is behind its base, or `behind main: unknown — fetch origin/<base> first` when git cannot measure the distance; it is absent only when the branch is measurably not behind.',
      "Rounds are derived from the PR's own verdict comments — one round per `Judged head:` value, read through the same extractors the merge gate blocks on, and only from comments an allowlisted principal authored. A Developer round comment is recognised by its `<!-- aeg:developer:round-<n> -->` marker, at that fixed position, never by scanning its prose.",
      'Exit `0` only when the state is `CONTINUE` and the branch is not behind; `1` otherwise, so a script can gate on the exit code without parsing the text.'
    ],
    status: 'shipped'
  },
  {
    name: 'review post',
    description: 'Render, post, and self-verify a code-reviewer or security-review verdict comment on a PR',
    flags: [
      { flag: '--role', description: '`code-reviewer` or `security` — selects which role template is rendered' },
      {
        flag: '--pr',
        description: 'Target PR number — its real head is resolved via `gh pr view`, never caller-supplied'
      },
      {
        flag: '--verdict',
        description:
          'Optional — derived from the findings file (code-reviewer: `APPROVE`/`REQUEST_CHANGES`; security: `PASS`/`FAIL`). Refused before posting if it disagrees with the derivation.'
      },
      {
        flag: '--escalate',
        description:
          '`authority` | `strategy` | `product` — posts an `ESCALATE:` comment instead of a verdict. Refused together with `--verdict` or a blocking finding.'
      },
      { flag: '--summary', description: 'Required with `--escalate` — the escalation body text' },
      {
        flag: '--findings-file',
        description:
          'One finding per line: `SEVERITY|file:line|description` (`|`-delimited). A re-review names a prior id in the description as `F<n> <class> <state>:`. Omit for zero findings.'
      },
      { flag: '--brief-conformance', description: 'code-reviewer only: the BRIEF CONFORMANCE line' },
      { flag: '--spec-conformance', description: 'code-reviewer only: the SPEC CONFORMANCE line' },
      { flag: '--scope', description: 'code-reviewer only: the SCOPE line' },
      {
        flag: '--scope-evidence-file',
        description: 'code-reviewer only: pasted diff-stat output, rendered as a fence directly below the verdict block'
      },
      { flag: '--tests', description: 'code-reviewer only: the TESTS line' },
      { flag: '--docs', description: 'code-reviewer only: the DOCS line' },
      { flag: '--config-scan', description: 'security only: the CONFIG SCAN line' },
      { flag: '--secrets', description: 'security only: the SECRETS line' },
      {
        flag: '--secrets-evidence-file',
        description:
          'security only: required whenever `--secrets` claims "none found" — the pasted scanner output backing that claim'
      },
      { flag: '--task-id', description: "the closing `Tokens:` line's task id" },
      { flag: '--model', description: "the closing `Tokens:` line's model name" },
      { flag: '--tokens-in', description: 'a non-negative integer, or `-` if unknown' },
      { flag: '--tokens-out', description: 'a non-negative integer, or `-` if unknown' },
      { flag: '--cost', description: 'free text, or `-` if unknown' },
      {
        flag: '--print-only',
        description: 'Render and self-check the comment, print it, and exit — never calls `gh pr comment`'
      },
      { flag: '--json', description: 'Enveloped JSON output (schema: 1)' }
    ],
    details: [
      '`--print-only` runs the exact same render-then-self-check path as a real post, then returns before `gh pr comment` — closes atta-labs/vinaya#184, where the old command silently posted a verdict anyway after a reviewer guessed this flag existed.',
      "Every structural line (`VERDICT:`, `Judged head:`) is rendered from this command's own validated enum/sha inputs — never from a caller-supplied string — so a Reviewer's free-typed prose can no longer produce a shape the merge gate's line-anchored regex fails to see.",
      "The verdict is derived, not typed: a BLOCKER (or CRITICAL/HIGH) finding forces REQUEST_CHANGES/FAIL and its absence forces APPROVE/PASS, before posting anything — an explicit `--verdict` that disagrees is refused naming the derived value. When a same-role verdict comment already exists on the PR, a new findings file must carry every prior id with a state and no non-blocking finding outside the diff since that comment's judged head, or the post is refused.",
      "Before the post ever reaches the forge, runs the exact `extractCodeReviewVerdict`/`extractSecurityReviewVerdict` functions `checkReviewGate` calls over its own rendered text and refuses (exit 2) unless exactly the intended verdict extracts and the other role extracts none — an escalation requires both to extract none. Both extractors read only a comment's first three lines, which are always this command's own structural lines, so no caller-supplied field can smuggle a line the gate would misread.",
      "After posting, re-fetches the PR's comments and runs them through the same extractors `checkReviewGate` calls — the same functions, not a second implementation — and exits non-zero naming precisely what failed to re-parse if the post does not come back clean, bound to the resolved head, and free of the other role's verdict. There is no `--skip-verify` escape."
    ],
    status: 'shipped'
  },
  {
    name: 'doctor',
    description: 'Diagnose hook, workflow, and config health — report only, never mutates',
    flags: [{ flag: '--json', description: 'Enveloped JSON output (schema: 1)' }],
    details: [
      'Carries the same env-declaration diagnostic `vinaya check` warns with — permanently, at `info` severity, not just ahead of the spawn-default flip — plus a `warn`-severity lint over suspicious `env` literal forms (a stray `"true"`/`"false"` string, or a high-entropy literal that reads like a leaked secret committed to config).',
      'Also carries the two permanent `checks`-classification diagnostics: a config key that REPLACES a core check (`warn`), and a bare un-namespaced key that is REJECTED (`error`, naming the rename requirement). These are the reason a config `vinaya check` now refuses outright is still diagnosable — the refusal runs nothing, so `doctor` is the surface that explains why.'
    ],
    status: 'shipped'
  },
  {
    name: 'tokens',
    description: "Print a role's `Tokens: …` report line — the portable front door over the collection adapter",
    flags: [
      { flag: '--phase', description: 'e.g. `"<task-id>: develop"` — required' },
      { flag: '--role', description: 'e.g. `Developer` — required' },
      { flag: '--model', description: 'Overrides the model id the adapter derived, if given' },
      {
        flag: '--transcript',
        description:
          'Read this transcript directly. Supported primary route — use it whenever you know which transcript ' +
          'is yours, and always in a repo with no track-transcript.sh hook. Omitted resolves via the Stop-hook ' +
          'pointer file, if this repo installs that hook.'
      },
      {
        flag: '--in / --out',
        description:
          'Manual entry: the exact token figures, for a host whose usage arrives by some other means than a ' +
          'Claude Code transcript. Both required together; skips transcript resolution entirely.'
      }
    ],
    details: [
      'Resolves the Claude Code collection adapter (`resolveMeteringCapability`, `summarizeTranscript`, `formatTokensLine`) from the INSTALLED `@attalabs/aeg-core` package, never by a repo-relative path — the fix for `packages/aeg-core/bin/report-tokens.ts` not existing in an adopter repo with no local `packages/`.',
      "Refuses — never emits a `0/0/—` line — when no transcript resolves, a resolved transcript can't be read, or it summarizes to zero usage records (empty, unparseable, or not yet flushed to disk). Capability is probed by actually attempting resolution, never declared from the host being Claude Code."
    ],
    status: 'shipped'
  },
  {
    name: 'doctrine',
    description:
      "Print the absolute path of the bundled doctrine's front door (aeg-root/skills/aeg/SKILL.md) on this machine",
    flags: [{ flag: '--json', description: 'Enveloped JSON output (schema: 1) — `{ root, entry }`' }],
    details: [
      'The committed root `VINAYA.md` pointer names the `@attalabs/vinaya` package, never a filesystem path — where the package sits is a property of each machine, not of the repo, and the pointer is committed for every clone. This command is the read-time resolution step the pointer hands the reader: it resolves the installed package\'s own bundled `aeg-root/` wherever the CLI physically sits and prints the front door\'s absolute path, so `cat "$(vinaya doctrine)"` opens the doctrine on any machine at any version.',
      "In a repo that vendors the CLI, the bundled copy is a gitignored pack-time artifact, so the command falls back to the monorepo root's own `aeg-root/` — the same directory `bundle-doctrine` copies from. Exits 1 with a corrective message when neither location holds a doctrine."
    ],
    status: 'shipped'
  },
  {
    name: 'upgrade',
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
    name: 'archive',
    description: 'Run the post-merge Archivist directly: provenance + Issue close-out for a merged task PR',
    flags: [{ flag: '--merge-sha', description: 'The merge commit to resolve (defaults to the current HEAD)' }],
    details: [
      "Resolves the merge commit's associated PR via `gh`, and — if it's a task PR without a provenance comment yet — posts the provenance block and closes the linked Issue. Idempotent: re-running against an already-archived PR is a no-op.",
      "The same logic the generated `vinaya-archivist.yml` workflow's `post-merge` job runs on every push to `main` — callable directly for a one-off run or local verification.",
      'All progress output writes through `process.stdout.write`/`process.stderr.write` (never bare `console.*`), so piping this command into a log file or a CI step captures every line in order.'
    ],
    status: 'shipped'
  },
  {
    name: 'archive tranche',
    description: 'Close a tranche — the tranche-level bookend to `init product`, closing the Milestone via the CLI',
    flags: [{ flag: '--yes', description: 'Skip the confirmation prompt' }],
    details: [
      'Refuses if any task Issue attached to the named tranche is still open, naming each one — closing a tranche with unresolved work is never silently allowed.',
      'Once every task Issue is closed, prompts for confirmation (unless `--yes`) and closes the GitHub Milestone.'
    ],
    status: 'shipped'
  },
  {
    name: 'audit',
    description: 'Run the ring-2 dead-branch-push and direct-main-push detection checks directly',
    flags: [
      { flag: '--only', description: "Scope to one check: 'dead-branches' or 'direct-push'" },
      { flag: '--sha', description: 'The commit to check for direct-main-push (defaults to the current HEAD)' },
      { flag: '--json', description: 'Enveloped JSON output' }
    ],
    details: [
      'Dead-branch-push is never-red — a notification channel that flags (label + PR comment) any `task/*` branch whose tip commit lands after its own PR already resolved. Direct-main-push is a real pass/fail — it polls the merge-association API for up to ~100s before deciding, then opens an incident Issue and exits 1 if a commit on `main` genuinely has no associated merged PR.',
      "The same logic the generated `vinaya-archivist.yml` workflow's `daily-drift` and `direct-main-push-detection` jobs run on schedule / on every push to `main` — callable directly for a one-off run or local verification.",
      'All progress output writes through `process.stdout.write`/`process.stderr.write` (never bare `console.*`), so piping this command into a log file or a CI step captures every line in order.'
    ],
    status: 'shipped'
  },
  {
    name: 'eject',
    description: 'Remove every Vinaya-installed artifact, restoring the repo to stock',
    flags: [
      { flag: '--dry-run', description: 'Print the full removal diff without removing anything' },
      { flag: '--yes', description: 'Skip the confirmation prompt' }
    ],
    status: 'shipped'
  },
  {
    name: 'demo break',
    description: 'Run a guided refusal-then-fix demo on an isolated, discardable branch',
    flags: [{ flag: '--keep', description: 'Skip cleanup and leave the demo branch checked out to inspect' }],
    details: [
      "Creates a collision-safe `vinaya/demo-break-<id>` branch off the current one, stages a deliberately incomplete draft brief, and attempts a real `git commit` — the repo's actually-installed pre-commit hook refuses it with its real output, not a scripted string. Applies the minimal fix, commits again, then switches back and deletes the demo branch.",
      'Safe to run twice: refuses on a dirty working tree, refuses from a detached HEAD, and recovers automatically from a prior crashed run before starting a fresh one — never leaves the original branch touched or a stray demo branch behind.'
    ],
    status: 'shipped'
  },
  {
    name: 'waiver',
    description:
      "Apply the actor-verified 'vinaya/waiver:docs' or 'vinaya/waiver:review' label after prompting for a reason",
    flags: [
      { flag: '--reason', description: 'The waiver rationale, posted as a PR comment (prompted for if omitted)' },
      { flag: '--print-only', description: 'Print the exact `gh` commands instead of running them' }
    ],
    details: [
      "Applies the label via `gh pr edit --add-label`, under the invoking human's own authenticated `gh` identity — this command never fabricates an actor. A waiver is never an agent-emittable string: not a PR body field, not a commit trailer, not a comment — the label plus its own labeling-timeline actor is the only mechanism ring 1 honors.",
      '`--print-only` prints the exact `gh pr edit`/`gh pr comment` commands and runs nothing — for a human who wants to run them itself, or a CI/non-interactive context where an agent session should never be the one applying its own waiver.'
    ],
    status: 'shipped'
  },
  {
    name: 'studio',
    description:
      'Launch Vinaya Studio — runs the Studio dev app when its source (apps/vinaya-studio/web) is in a checkout above the current directory; a published install launches its bundled standalone server instead',
    flags: [
      {
        flag: '--port <n>',
        description:
          "Bind this exact port. Without the flag the default is unchanged — 3008, falling back to 3108 when it is taken. With it there is no fallback: a taken port is refused, so you always know which server answered. Accepts `--port 3208` and `--port=3208`. Applies to a published install; in a workspace checkout Studio's own dev script owns the port and the flag is refused."
      }
    ],
    details: [
      "Resolution happens in this order: a workspace checkout carrying `apps/vinaya-studio/web` (Studio's source, which lives in the attalabs monorepo — not this repository) runs the dev app directly; a published install's `studio-standalone/` bundle (fetched from attalabs' release artifact at publish time, see `scripts/bundle-studio.ts`) runs that bundled server; anything else — a publish that shipped without the bundle — gets an explicit refusal and exit 1 rather than a silent no-op.",
      'Every published `@attalabs/vinaya` build ships the `studio-standalone/` bundle: `prepack` fetches attalabs’ latest CI-built standalone Studio artifact and assembles it into the tarball before publish.'
    ],
    status: 'shipped'
  },
  {
    name: 'quickstart',
    description: 'Guided wizard: init, doc-owners, project, commit, demo break, doctor, push — one command',
    details: [
      "Calls `init`'s own diff-and-confirm flow unchanged (pausing on Enter before the diff prints, so its own step header isn't scrolled off by a long diff), then Y/n-prompts through the workarounds a guest used to run by hand: binding `.vinaya/doc-owners` pairs (bad input offers a retry instead of silently skipping, and a pointer that doesn't exist on disk is refused outright — both loop across as many pairs as the guest wants, not just one), registering tracked projects (`init product`, same retry/loop shape), committing the install, running `demo break` as proof the gates actually work (default yes — the one step this wizard makes hardest to skip), running `doctor`, and pushing. Each declined prompt skips only that step; the install commit itself is never prompt-gated — it just no-ops when there is genuinely nothing to commit.",
      'Never reimplements or edits `init`/`init product`/`demo break`/`doctor` — it only calls their existing, unmodified entry points in sequence.'
    ],
    status: 'shipped'
  },
  {
    name: 'release',
    description:
      "Run this repo's own publish sequence in one command, refusing to start unless every precondition holds",
    flags: [
      {
        flag: '--dry-run',
        description: 'Run the preconditions only and print the plan; publishes nothing'
      },
      {
        flag: '--allow-any-commit',
        description: "Skip the check that HEAD's commit is a Version Packages commit"
      }
    ],
    details: [
      "Refuses unless HEAD is the default branch, the working tree is clean, HEAD equals `origin/<default>` (after `git fetch origin`), HEAD's commit subject starts with `Chore(release): Version packages` (unless `--allow-any-commit`), and `npm whoami` exits `0` — each its own refusal naming the fix.",
      "Then streams `bun install --frozen-lockfile`, `bun run build`, `bun run changeset:publish`, and `git push origin --tags` — a real push, so the repo's own generated pre-push hook sees it exactly as any other push would. After it, prints `npm view <pkg> version` for every tag now on HEAD, noting registry lag on `@attalabs/vinaya` (observed ~20 minutes) when it still shows the previous version.",
      'This is the one procedure named in `apps/cli/specs/self-hosting.md`, "How the published version is produced" — publishing itself stays manual and human-triggered; this command only removes the hand-typed four-step recipe.'
    ],
    status: 'shipped'
  }
]
