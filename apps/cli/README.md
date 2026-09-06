# @attalabs/vinaya

The `vinaya` bin — Vinaya's npm-distributed CLI, published to the public npm registry as `@attalabs/vinaya`. The installed command is `vinaya`; only the package name carries the scope. This package ships the command router, the hierarchical config loader, the versioned `--json` output envelope, the check engine (`vinaya check` / `vinaya new check`), the install lifecycle (`init` / `doctor` / `upgrade` / `eject`), and validated forge writes (`pr` / `issue` / `review post`).

## Install

The published artifact is a Node-executable bundle — plain Node ≥ 20 is enough, through any package manager:

```bash
npx @attalabs/vinaya init        # or: pnpm dlx / yarn dlx / bunx
```

## Commands

| Command | Description |
|---------|-------------|
| `vinaya help` | Usage text |
| `vinaya version` | Print the installed CLI version (`--json` for the enveloped machine form) |
| `vinaya doctrine [--role <name>]` | Print the absolute path of the bundled doctrine's front door (`aeg-root/skills/aeg/SKILL.md`) on this machine. The committed root `VINAYA.md` pointer names the package, never a filesystem path — this command is the read-time resolution step it hands the reader. `--role <name>` resolves straight to a specific role's doctrine instead (`aeg-root/roles/<name>.md`, under the same resolved root), validated against the role names actually enumerated under `roles/*.md` at request time — an unknown name fails cleanly and lists the valid names, never a silent bad path. `--json` for the enveloped `{ root, entry }` form. |
| `vinaya check <name> \| --all` | Run one check, or every registered check (core + `vinaya.config.json`-registered). `--json` for the enveloped `{ checks: CheckOutcome[] }` form; `--diff-only` scopes `scope: 'diff'` checks to changed files; `--parallel[=n]` caps concurrency (default: cpu-derived). Findings always print as the check contract's JSON lines on stderr, regardless of `--json`. Exit 0 iff every check passed. |
| `vinaya new check <yourname>/<id>` | Scaffold a self-contained custom check into `./scripts/vinaya-checks/<id>.ts`, ready to register in `vinaya.config.json` under that namespaced key |
| `vinaya brief render <tranche> <n> --surfaces <glob,...> [--out <path>]` | Emit the twelve-section brief skeleton from the task Issue and the tree, with every mechanically-derivable section filled: the header `Project:`/`Tier:`/`Closes #N`, the Step 0 worktree line, the dispatch-gate status as the pre-flight line, §4's file list (with consumer packages and a `sha256` premise pin per file), §7 from the `.vinaya/doc-owners` derivation, and every remaining section from the Issue's eight-field Planner rationale. Refuses, naming the missing fact, when a derived section cannot be derived: no Issue, the dispatch gate not clear, or a `--surfaces` glob matching no tracked file. Never writes under `aeg-root/` or to the Issue — stdout, or `--out <path>`, only; a brief is pasted to the Developer, never committed. |
| `vinaya issue objectives edit <n> --add "<sentence>" \| --drop O<k> \| --replace O<k> "<sentence>" --reason "<text>"` | Rewrite a task Issue's `## Objectives` section by command — the Principal's way to change a task's scope mid-flight, findable and versioned rather than a silent hand-edit. Exactly one of `--add`/`--drop`/`--replace` plus a non-empty `--reason` is required; the edit runs through the same validated `issue edit` write path (`writeValidatedIssueEdit`) as `vinaya issue edit` itself. `--drop` never renumbers the survivors — a drop that leaves the list non-contiguous from `O1` is refused with `objectivesOf`'s own parser message, since task 1's contiguous-from-O1 grammar and this command's never-renumber rule can genuinely contradict on a real drop, and that contradiction is reported rather than papered over. Splices the rendered section back in place, leaving every other byte of the body untouched, then posts one comment marked `<!-- aeg:objectives:v<k> -->` carrying the previous list, the new list, the reason, and the new version hash — `k` counted on the forge at post time, never from a local file. |
| `vinaya pr report [--write <body-file> \| --push <pr>] [--phase <phase>] [--role <role>] [--model <id>] [--transcript <path>]` | Emit two generated, never-hand-typed blocks a PR body carries: `AEG:EVIDENCE` (the head sha, the width-invariant `git diff --numstat` against `origin/main`'s merge-base, the result of `vinaya check --all --diff-only`, and — Group C, task 12, #387 — every command in the body's §9 fenced Test Plan list, re-run from the PR head with its actual output) and `AEG:TOKENS` (real usage figures collected the same way `vinaya tokens` collects them, rendered into the `## Token report` heading's table). Without `--write`/`--push`, prints the Evidence block to stdout. With `--write <body-file>`, replaces the Evidence block in place but APPENDS a new row to the Tokens block on every run — a re-entry after `CHANGES_REQUESTED` reports again, and a second report is a second row, never a sum or an overwrite. With `--push <pr>`, does the same splice directly against the PR's LIVE body — fetched from the forge, never a local file — and pushes it via `gh pr edit`, then re-reads the live body and refuses (restoring the pre-edit body) unless it agrees with the pre-push body outside the two anchored regions; refuses before writing anything on a live body with no real `AEG:EVIDENCE` pair (never appends one, unlike `--write`), a divergent anchor resolution, or a `<pr>` value that isn't a bare number. When the live body has no real `AEG:TOKENS` pair, the token splice is skipped rather than creating one (same reasoning, softer outcome — `AEG:EVIDENCE` alone is still pushed). `--write` and `--push` are mutually exclusive. `--phase`/`--role` default to `<n>: develop`/`Developer` (`<n>` parsed off a `task/<tranche>/<n>` branch) but accept any role/phase pair — a Brief Author (`--role "Brief Author" --phase "<n>: brief"`) or Planner (`--role Planner --phase "<n>: plan"`) turn appends its own row into the same block alongside the Developer's, and each round-trips through `parseTokenReportEntries` into its own distinct ledger row; no role's figures ever collapse into another's. `--transcript` names a session transcript directly, skipping Stop-hook pointer-file resolution. The two incapable classes are kept apart, and never fabricate a `0/0/—`: a session whose own wiring — a pointer whose id matches, or one at this project's own pointer path — was reached and the figures still could not be (`pointer-unusable`, the pointer cannot be read or parsed; `transcript-unreadable`; or `transcript-empty`, it resolves to zero usage records) gets an all-`—` row carrying the probe's reason inline in the Agent/Model cell; a session that resolved no transcript at all — no Stop-hook pointer, or one that cannot be corroborated as this session's — gets **no row and a refusal on stderr** naming `--transcript` and `vinaya tokens --in/--out`, because nothing there established that the host cannot meter, and a blank row would claim it did. The `AEG:EVIDENCE` block is still written/pushed in that case; only the row is withheld. Exits non-zero when any gate in Group B fails, or when the token row was refused. |
| `vinaya review status <pr>` | Print the review loop's own state for a PR. Line one is `CONTINUE`, `PAUSE: <reason>[ <id>]` for `reappearance` (an id a round marked `resolved` came back `reproduced`), `zero-deaths` (a round resolved nothing it inherited and still raised something new) or `max-rounds` — or, for `stale` (the newest verdict judged a superseded head and no Developer round comment followed), the actionable fact itself: `push after verdict — re-review required`. Line two reads `behind main by <n> — merge first` when the branch is behind its base, or `behind main: unknown — fetch origin/<base> first` when git cannot measure the distance at all; it is absent only when the branch is measurably not behind. Rounds are derived from the PR's own verdict comments — one round per `Judged head:` value, read through the same extractors `review-gate` blocks merges with, and only from comments an allowlisted principal authored; a Developer round comment is recognised by its `<!-- aeg:developer:round-<n> -->` marker at that fixed position, never by scanning its prose. Exit `0` only when the state is `CONTINUE` and the branch is not behind; `1` otherwise, so a script can gate on the exit code without parsing the text. |
| `vinaya review post --role code-reviewer \| security --pr <n> [--verdict <v>] [--escalate <class> --summary <text>] ...` | Render, post, and self-verify a code-reviewer or security-review verdict comment on a PR from structured flags (findings, per-field text) instead of a hand-typed comment. The verdict is DERIVED from the findings file (REQUEST_CHANGES/FAIL iff a BLOCKER/CRITICAL-or-HIGH finding is present) — `--verdict` is optional and refused before posting anything when it disagrees with the derivation, naming the derived value. `--escalate authority \| strategy \| product --summary <text>` posts an `ESCALATE:` comment instead of a verdict — its own outcome, refused together with `--verdict` or with a blocking finding present. When the PR already carries a same-role verdict comment, a new findings file must carry every prior `F<n>` id with a state (`open`/`fix-claimed`/`reproduced`/`resolved` — a `resolved` finding keeps its severity for the record but no longer drives the verdict), and a non-blocking finding outside the diff since that comment's `Judged head:` is refused. `--scope-evidence-file <path>` (code-reviewer only) renders the file's contents as a fenced block directly below the verdict block, backing the `SCOPE:` claim. `--objectives-file <path>` (`O<n>|MET|<evidence>` or `O<n>|NOT MET|<evidence>` per line) renders an `OBJECTIVES:` block after `SPEC CONFORMANCE:`/before `CONFIG SCAN:` and an `Objectives version:` line at line 5 — resolved from the closed Issue's `## Objectives` list, or the PR body's own section when it closes none; required whenever that resolution finds a list to judge, its ids must cover the list exactly, a clean verdict is refused alongside any `NOT MET`, and a re-review must restate every prior objective; an Issue below the objectives cutover renders neither line at all (never together with `--escalate`). Resolves the PR's real head itself (`gh pr view --json headRefOid`); renders every structural `VERDICT:`/`ESCALATE:`/`Judged head:`/`Objectives version:` line from validated inputs, never from caller-supplied text; before posting, runs the exact `extractCodeReviewVerdict`/`extractSecurityReviewVerdict` functions the merge gate calls over its own rendered text and refuses (exit `2`) unless exactly the intended verdict extracts and the other role extracts none (an escalation: both extract none) — those extractors read only a comment's first five lines, and a code-review/security render's caller-supplied fields never open one of those lines, but an escalation's `--summary` can (pre-cutover, it becomes line 5 unprefixed); this pre-post re-parse, not the render's construction, is what catches that case before anything is posted; and after posting, re-fetches the comment and refuses to exit 0 unless the same re-parse holds against the live forge state, including the objectives version. `--print-only` renders and self-checks the comment exactly like a real post, then prints it and returns — never calling `gh pr comment`, never re-fetching to self-verify a write that never happened (closes atta-labs/vinaya#184). `--json` for the enveloped machine form. |
| `vinaya pr rule <pr> --file <ruling.md>` | Post the Principal's ruling on a PR as its own marked, versioned comment (`<!-- aeg:principal:ruling:<pr>-<k> -->`) — never mistaken for a code-review or security verdict. Refuses before posting when the file's first line reads as an escalation (`ESCALATE:`), or when the file carries verdict grammar anywhere `extractCodeReviewVerdict`/`extractSecurityReviewVerdict` would treat as a candidate — a `VERDICT:` line sitting past the extractor's own first-five-line read window still counts, since it's the whole-body candidate test that disqualifies the file, not merely a clean read; a blockquoted mention of `VERDICT:` is unaffected, since the extractors ignore it too. `k` is counted on the forge at post time from `gh pr view --json comments`, never derived from a local file. |
| `vinaya tokens --phase <phase> --role <role> [--model <id>] [--transcript <path> \| --in <n> --out <n>]` | Print a role's `Tokens: …` report line — the portable front door over the token-report collection adapter, resolving `@attalabs/aeg-core`'s `resolveMeteringCapability`/`summarizeTranscript`/`formatTokensLine` from the installed package rather than a repo-relative path, so it works in an adopter checkout with no local `packages/`. `--transcript <path>` reads a session transcript directly; omitted, it resolves via the Stop-hook pointer file where one is installed. `--in <n> --out <n>` bypasses transcript resolution entirely for a host whose figures arrive by some other means. Refuses rather than emitting `0/0/—` when no transcript resolves, a resolved one can't be read, or it summarizes to zero usage records — the same capability probe backs a `vinaya doctor` finding when it reports incapable. |
| `vinaya archive [--merge-sha <sha>]` | Post-merge Archivist: resolves the merged PR from a merge SHA (`HEAD` by default), assembles and posts the `### AEG provenance` comment via `@attalabs/aeg-core`'s `buildProvenanceBlock`, then closes the PR's `Closes #N` Issue. Idempotent — a PR that already carries the block (`hasProvenance`) is skipped, posting nothing new. Appends its own one-line `Tokens: …` report to that same comment, collected via the same metering adapter `vinaya tokens` uses: the sanctioned all-`—` line on an incapable host, or — when the probe reports capable but summarized to zero tokens — the line is omitted and flagged `DANGLING (tokens): …` instead, since a capable host's blank is never licensed to read as `—`. Provenance and Issue-closure always proceed regardless of that outcome; a missing token row never withholds either. `vinaya archive tranche <slug> [--yes]` closes a tranche's legacy Milestone once every `vinaya/tranche:<slug>`-labeled Issue is closed. `rings.ring2_asyncAudits: true` skips this command's work entirely (see Config below). |
| `vinaya studio` | Launch Vinaya Studio. Inside a checkout that carries Studio's source (`apps/vinaya-studio/web` — it lives in the attalabs monorepo, not this repository) it runs the dev app; a published install runs its bundled standalone server instead, fetched from attalabs' published release artifact at publish time. `--port <n>` binds an exact port — see below. |
| `vinaya milestone create --title <title> --body-file <path>` | Create a GitHub Milestone from a validated body. The title is free text, never parsed for a version — the description's optional `Release:` field is the sole authority for one. Refuses before any `gh` write when the goal is absent, `Release:` is present but malformed, or an `### Tranche intents` section (`- <slug>: <intent text>`) doesn't parse. `--validate-only` runs every check without writing; `--json` for the enveloped machine form. |
| `vinaya milestone adopt --target <title> --slug <slug> [--slug <slug> ...]` | Move one or more existing tranches into a target Milestone: reattaches every Issue carrying each `vinaya/tranche:<slug>` label to `--target`, then closes (never deletes) each slug's old tranche-Milestone. Every fact is gathered and refused-or-passed as ONE batch before any write — an unknown slug, a slug whose label carries no Issues, a target that does not exist or is closed, or a slug already adopted into a different Milestone refuses the whole invocation, not just its own slug. `--validate-only` runs every check without writing; `--json` for the enveloped machine form. |
| `vinaya milestone edit <n> --body-file <path>` | Edit an existing Milestone's description after the same `checkMilestoneShape` gate `create` runs — the gated replacement for a raw `gh api PATCH` against a Milestone. Only the description changes; the title is untouched. `--validate-only` runs every check without writing; `--json` for the enveloped machine form. |
| `vinaya milestone close --slug <slug>` | Close a tranche's Milestone — the gated replacement for the raw `gh api .../milestones/<n> -X PATCH -f state=closed` recipe the Tranche Archivist used to run on faith. Resolves the target Milestone the same legacy-or-intent-declared way Issue create auto-attach does, then refuses to close on any mismatch between the label's Issues and the Milestone's natively attached Issues — naming each unattached or foreign Issue and its repair path (`gh issue edit <n> --milestone <title>`, or `vinaya milestone adopt`) — before the PATCH ever reaches the forge. `--validate-only` verifies attachment without closing; `--json` for the enveloped machine form. |
| `vinaya quickstart [--yes] [--dry-run]` | Guided wizard that runs `init` → optional doc-owners bind → optional project registration → commit → `demo break` → `doctor` → `push` in sequence, prompting between steps. `--yes` forwards straight through to `init` and answers every one of quickstart's own prompts with its documented default (skip the two optional steps, run the refusal-then-fix proof, push) — no prompt is opened at all, so the command completes with no human at the keyboard rather than merely with stdin closed. `--dry-run` also forwards to `init` and stops immediately after its preview — nothing is installed, so no later step runs against an uninstalled repo. |
| `vinaya release [--dry-run] [--allow-any-commit]` | Run this repo's own publish sequence in one command (`apps/cli/specs/self-hosting.md`, "How the published version is produced"). Refuses unless HEAD is the default branch, the tree is clean, HEAD equals `origin/<default>` (after `git fetch origin`), HEAD's commit subject starts with `Chore(release): Version packages` (unless `--allow-any-commit`), and `npm whoami` exits `0` — each its own refusal naming the fix. Then streams `bun install --frozen-lockfile`, `bun run build`, `bun run changeset:publish`, and a real `git push origin --tags`, so the repo's own generated pre-push hook sees the push exactly as any other push would. Afterward prints `npm view <pkg> version` for every tag now on HEAD, noting registry lag on `@attalabs/vinaya` (observed ~20 minutes) when it still shows the previous version. `--dry-run` stops after the preconditions and prints the plan; publishes nothing. |

Which one lib function backs each command, and today's dated exemptions where it calls more than that one: `apps/cli/specs/surface.md`, enforced by `apps/cli/tests/surface-index.test.ts`.

## Config

Hierarchical, file-level precedence:

1. Repo-local `vinaya.config.json` (walked up from `cwd`, stopping at the enclosing repository's root — or the filesystem root when run outside a git repository)
2. Global `~/.vinaya/config.json`
3. `null` if neither exists

Whichever file resolves first is used in full — there is no field-by-field merge across the two files.

Today the schema carries one surface:

```json
{
  "rings": {
    "ring1_forgeWriteInterception": true,
    "ring2_asyncAudits": false
  }
}
```

Both `rings` fields are plain booleans — no conditional logic. Ring 0 (git hooks) and the CI/branch-protection guarantee are never represented in this schema, by design — they are not configurable.

Both fields are additive, never disabling: `false` (the default — every `vinaya init` starter config reads `false` for both) is a no-op, leaving the underlying mechanism running exactly as it does with no config at all. `true` is the opt-in accelerator — the only value that changes behavior — and skips it. `ring1_forgeWriteInterception: true` skips `pr`/`issue create|edit`'s `briefSchema` validation entirely; `ring2_asyncAudits: true` skips `vinaya archive`'s provenance work and `vinaya audit`'s dead-branch-push notification, exiting `0` without doing anything for those two — it does **not** skip `vinaya audit`'s direct-main-push detection, which stays unconditional on purpose: that check is a real pass/fail catching a branch-protection bypass, and gating a security-relevant detection behind a flag readable from ordinary PR content would let the bypass silently disable the check that catches it.

### Blast-radius collision domains

`checkBlastRadiusScope` (the AEG task-Issue gate that refuses an under-declared blast radius) needs a list of shared collision domains — paths that couple work across project boundaries. It works out of the box, with **zero adopter file**:

- Every `packages/*` workspace member is derived live at check time — from `package.json`'s `workspaces` array, or `pnpm-workspace.yaml`'s `packages:` list on a pnpm repo (pnpm does not read `package.json`'s `workspaces` key at all) — a shared package is a collision domain by construction, so this needs no declaration. A leading `!` negates an entry, same as npm/yarn/pnpm's own workspace-glob syntax.
- A built-in default set covers the common cross-cutting paths by presence-check: whichever lockfile exists (`bun.lock`/`package-lock.json`/`pnpm-lock.yaml`/`yarn.lock`), `turbo.json`, `biome.json`, `tsconfig.json`, `.github/workflows`, `.husky`.

To declare a domain beyond those two — a `migrations/` folder, a codegen output directory — add it to `vinaya.config.json`:

```json
{
  "blastRadius": {
    "extraDomains": ["migrations", "packages/generated"]
  }
}
```

**`.aeg/packages`** (the legacy static collision-domain file some repos still carry) is **not read** by `checkBlastRadiusScope` here — no backward-compatibility path, since `apps/cli` has no adopter depending on it. `vinaya doctor` still diagnoses a present file purely as a migration checklist: it names exactly which of its entries (if any) aren't already covered by live derivation, the built-in defaults, or `blastRadius.extraDomains`, so you know what to fold into those before deleting it — but the file itself contributes nothing to the live check.

`checkBlastRadiusScope` is one of three content checks `vinaya issue create`/`vinaya issue edit` run automatically on a task Issue (any `vinaya/tranche:*` label) — unconditional, not something `vinaya.config.json`'s `briefSchema` opts into or out of. The other two: `checkNoBriefContent` refuses an Issue body carrying a brief-shaped section (`## References`, `Technical surface map`, `Premise`, `Step 0`, `Test Plan` — those belong in the brief, not the Issue); `checkRationaleNamesDocs` refuses a rationale whose "Docs to keep coherent"/"Traps" fields name no concrete doc/skill path, unless it carries the explicit `no-doc-surface` sentinel. All three grade what the eight-field Planner rationale (`checkIssueRationale`) *says*, once that gate has confirmed the fields exist.

### Config-native project metadata (`projects`)

`vinaya init product <name>` has always appended a row to `.vinaya/projects.md` (the project registry). It now *also* appends an entry to `vinaya.config.json`'s `projects` array — a second, config-native home for the same declared fact, alongside the registry file rather than instead of it:

```json
{
  "projects": [
    { "name": "mobile", "path": "apps/mobile", "description": "The mobile client" }
  ]
}
```

`name` is required (the dedup key, matching the registry row's own `Project` column); `description` and `path` are optional. This key is display metadata only — no gate or resolver reads it, and single-project repos rightly have none. `vinaya doctor` reports, at `info` severity, when a registry row and a `projects` entry name the same project but only one of the two exists — never an error, since keeping only the registry file is a fully supported shape.

### Token-usage collection for non-Claude-Code hosts (`tokens.collect`)

`vinaya tokens` ships one collection adapter, for Claude Code — it reads that host's own session transcript. A repo whose coding-agent host is something else (Codex, Grok build, or any other harness) has no route to a real `Tokens:` line without declaring one:

```json
{
  "tokens": {
    "collect": "node scripts/collect-usage.js"
  }
}
```

**`tokens.collect` must be exactly `"<interpreter> <repo-relative-script-path>"`** — two whitespace-separated tokens, nothing else: no flags, no extra arguments, no shell syntax (`&&`/`|`/`;`), no quoting. `vinaya tokens` spawns the interpreter directly with the script as its one argument — never through a shell — whenever it is declared and `--in`/`--out` are not given, and parses its stdout as a JSON object shaped:

```json
{
  "inputTokens": 0,
  "outputTokens": 0,
  "cacheCreationInputTokens": 0,
  "cacheReadInputTokens": 0,
  "model": "your-model-id-or-null"
}
```

Absent, `vinaya tokens` falls back to the shipped Claude Code transcript adapter unchanged — this key only adds a second route, never removes the first, and a Claude Code adopter continues to get working enforcement on `vinaya upgrade` having declared nothing. When declared, a command that exits non-zero or prints output that doesn't parse into that shape fails loudly rather than silently falling back to the transcript route or emitting a plausible `0/0/—`.

This is an opt-in collection route, not a capability declaration: whether a host is treated as capable of metering itself is always *probed*, never read from this key — there is no `tokens.metering` field.

Read from the repo-root config only, same trust class as `checks`/`principals`/`releaseActor`: a value that decides what command runs on this turn must come from the reviewed, committed per-repo file, never a machine-wide personal config — a global `~/.vinaya/config.json`'s `tokens` key is stripped at load time with a loud stderr warning, never resolved.

Unlike `ci.setup` — which only ever executes inside a generated, reviewed CI workflow step, under the runner's own isolation — a declared `tokens.collect` script executes IN-PROCESS, unsandboxed, on whatever machine runs the ordinary `vinaya tokens` command. Three layers close that gap:

- **Rigid grammar.** The `"<interpreter> <script>"` restriction above is not a style preference — it is what makes the content pin below rigorous rather than heuristic. Because a declaration can only ever mean one file, `vinaya tokens` never has to guess which token of an open-ended shell string "looks like a path".
- **Trust gate, content-pinned.** `vinaya tokens` refuses to run `tokens.collect` at all until a human has explicitly approved this exact interpreter/script declaration, AT the script's exact current content, for this repo, on this machine: run `vinaya tokens --trust-collect` once. Approval is keyed to this repo's git common directory, not to any one worktree, so it survives a fresh `git worktree add` of the same repo; a different interpreter, a different script path, or so much as one byte of script content changing — committed or not — needs its own fresh approval. Approvals live in `~/.vinaya/tokens-collect-trust.json`, machine-local and never read from any committed file, so a pull request can no more grant itself trust than it can add itself to `principals`.
- **Printed audit trail.** Once trusted, `vinaya tokens` still prints the exact interpreter/script to stderr immediately before every run, so nothing executes invisibly even after approval.

This is a trust-then-verify design, not a blocking interactive prompt — the unattended-agent path this key exists for keeps working once a human has approved the script's content a single time. Editing only the script, never `vinaya.config.json`, requires that same fresh approval again — this is the specific gap two earlier, less rigid designs left open (security review, PR #303), and the reason the grammar above is fixed rather than an arbitrary shell string.

## Where the git hooks live

`vinaya init` installs the ring-0 hooks (`pre-commit`, `pre-push`, `commit-msg`) into a **tracked** `.vinaya/hooks/` directory and points git at it with `git config core.hooksPath .vinaya/hooks` — commit that directory. Raw `.git/hooks` is never versioned by git, so hooks installed there exist only on the installing machine; tracked hooks travel with the repo into every clone and every linked worktree checkout.

One thing git cannot version is the config itself: **each fresh clone runs `git config core.hooksPath .vinaya/hooks` once** to arm the hooks (linked worktrees inherit it — the config is shared, the path is relative). `vinaya doctor` reports an unarmed clone as an error naming that exact command; `vinaya init` and `vinaya upgrade` also set it.

Two shapes deviate: a repo already using **husky** keeps its `.husky/` directory (husky's `prepare` script owns per-clone wiring), and a repo with its own active raw hooks in `.git/hooks` stays on the legacy append-a-managed-block layout there — re-routing `core.hooksPath` would silently disable the adopter's own hooks. On that legacy layout `vinaya doctor` warns that clones have no hooks, and `vinaya upgrade` migrates to the tracked layout as soon as nothing foreign would be disabled.

On that legacy `.git/hooks` layout, note where the hook actually lives: hooks are never per-worktree, so its real home is the main checkout's shared hooks directory (`git rev-parse --git-common-dir`), which from a linked worktree is outside that worktree's own root. `vinaya eject` follows the hook there and bounds the removal to that directory's `hooks/` subtree, rather than to the worktree root — so ejecting from a linked worktree strips the hook instead of leaving it armed. A canonically spelled block path resolving anywhere else is refused, and the refusal is whole-run: `eject` removes nothing at all rather than making a partial destructive pass. (The `.git/` test is byte-exact, so a non-canonical spelling takes the working-tree branch instead — nothing vinaya generates produces one.)

## Claude Code Stop hook (transcript pointer)

When `--agents` includes `claude` (the default), `vinaya init`/`vinaya upgrade` also install a Claude Code `Stop` hook — `.claude/hooks/track-transcript.sh`, registered in `.claude/settings.json` — that records each session's transcript pointer (session id and transcript path, tab-separated) to `${TMPDIR:-/tmp}/claude-transcript-<sanitized-project-dir>-<sha256-of-project-dir>.txt`. Appending a full `SHA-256` digest of the (uncollapsed) project directory keeps two project directories whose paths differ only in non-alphanumeric characters (e.g. `/a/b` vs `/a-b`) from sharing one pointer file — the sanitized prefix alone would collapse both to the same name (`#315`). The reader falls back to the pre-`#315`, digest-less filename when the new one is absent, so a pointer an older hook already wrote stays readable. This is the pointer `packages/aeg-core/bin/report-tokens.ts`'s token-report adapter reads, so a fresh Claude Code adopter's token-report obligation resolves without an operator naming a transcript by hand, and without falling back to scanning `~/.claude/projects/` for the newest file (which grabs the wrong session's transcript when two worktrees run concurrently). The adapter reads both the primary and legacy pointer names through the same hardened, symlink-and-FIFO-safe I/O every other metering call site uses (`hardenedMeteringDeps()`, `packages/aeg-core/src/metering-io-guard.ts`), never a hand-rolled `existsSync`/`readFileSync` pair.

The script follows the same never-clobber discipline as the git hooks above: it is a marker-delimited managed block, appended onto an adopter's existing file at that path rather than overwritten. `.claude/settings.json`, by contrast, is refuse-if-foreign (created only when absent) — strict JSON has no comment syntax the marker convention could use, so an adopter's existing `settings.json` is left untouched; wire the hook in by hand (see the install diff's REFUSE guidance) if you already have one.

## Agent-native entry points (`--agents`)

`vinaya init` writes three agent-native entry points by default, one per vendor: `.agents/skills/vinaya-<role>/SKILL.md` (Agent skills, below), `.claude/commands/vinaya.md` (Claude Code command), and `.gemini/commands/vinaya.toml` (Gemini CLI command). Each one is a thin pointer that shells out to `vinaya doctrine --role <role>` at read time — there is exactly one source of role doctrine, never a copy baked into any of these files.

`vinaya init --agents=<comma-list|all|none>` controls which of the three get written — `all` (the default) writes all three, `none` writes none, and a comma-separated list (e.g. `--agents=claude,gemini`) writes exactly the named vendors. There is no interactive prompt: `init` is scriptable/CI-safe today, and prompting would break that. The selection is persisted into `vinaya.config.json`'s `managed.agents` — `vinaya upgrade`/`vinaya doctor` read it back rather than re-deriving a default, so a repo initialized with a narrowed selection never has a later flagless `vinaya upgrade` silently add the other vendors' files, nor silently drop the recorded selection; a vendor left out is simply invisible to `vinaya doctor` rather than reported as "not installed". `vinaya eject` removes whichever of the three are actually owned, the same way it removes every other vinaya-managed artifact.

A repo whose `vinaya.config.json` predates this feature entirely (no `managed.agents` key at all — never `--agents=none`, which persists a real empty array) is treated as every vendor, the same default a fresh `vinaya init` gives everyone else: the next `vinaya upgrade` writes all three files without anyone ever needing to re-run `init` by hand. Only an *explicit* selection — narrower or empty — is ever respected as a standing choice.

## Agent skills

Generates skill pointers under `.agents/skills/vinaya-<role>/SKILL.md`, for tools natively scanning `.agents/skills/` (Codex, Antigravity, Grok Build) — one file per role discovered under `aeg-root/roles/*.md`, excluding `principal` (the one seat this doctrine never grants an agent). Each file is a 3-line pointer delegating to `vinaya doctrine --role <role>` at read time.

## Gemini CLI command

Generates `.gemini/commands/vinaya.toml`, Gemini CLI's own custom-command surface. It emits ONE parameterized command, invoked `/vinaya <role>`, whose `prompt` field embeds `!{vinaya doctrine --role {{args}}}`: Gemini CLI substitutes the typed role into `{{args}}`, shell-escaping it automatically, before running the shell block — and it always prompts the user to confirm the exact resolved command first, with no documented bypass. Role-argument validation stays in `vinaya doctrine --role` alone (`commands/doctrine.ts`), not duplicated here.

## Claude Code command

Generates a single parameterized `.claude/commands/vinaya.md`, invoked `/vinaya <role>`. The file uses Claude Code's `$ARGUMENTS` substitution to shell out to `vinaya doctrine --role "$ARGUMENTS"` at read time, scoped by `allowed-tools: Bash(vinaya doctrine *)` so it runs without a permission prompt.

**Security note:** Claude Code substitutes `$ARGUMENTS` into the command as a raw, pre-shell text splice — the substitution happens before bash parses the line, so the role token can carry live shell syntax. Double-quoting (`"$ARGUMENTS"`) closes the `;`/`|`/`&&` class the substitution's own documented apostrophe bug demonstrates, but — verified empirically, not assumed — it does **not** close `$(...)`/backtick command substitution (still executes inside double quotes), and no quote character can be made airtight against this kind of splice at all: an attacker's token can always contain that same quote character, close it early, inject a command, then reopen a matching quote so the rest of the line still parses. `vinaya doctrine --role`'s own handling (`doctrine.ts`) validates whatever argument it actually receives against the exact set of role names live-discovered from `aeg-root/roles/*.md` and refuses anything else — that gate is real and load-bearing for its own scope, but an injected `$(...)` or quote-breakout command never reaches it as an argument; it runs at the shell level first. The actual remaining backstop is Claude Code's own `allowed-tools: Bash(vinaya doctrine *)` permission matcher refusing to auto-run a chained/injected command — a platform property outside this repo's control, unverified as of this writing. Do not describe this as fully closed in any future edit here or in the emitter; it is reduced, not closed.

Custom checks register under `checks`, one entry per check. **Every key must be namespaced `<yourname>/<id>`** — exactly one `/`, both segments matching `[a-z0-9][a-z0-9-]*`, with `vinaya` reserved as a prefix:

```json
{
  "checks": {
    "myteam/my-check": {
      "run": "./scripts/my-check.ts",
      "scope": "diff",
      "include": ["src/**/*.ts"],
      "timeoutMs": 30000
    }
  }
}
```

The one exception is a key that exactly matches a **core** check id: that is an override, and it **replaces** the core check — the core one stops running. Anything else — a bare, un-namespaced key matching no core id — is rejected, and `vinaya check` then refuses the **entire** run (exit 1, nothing executes) rather than running a partial ruleset. Note that a prefix alone is not always enough: if the bare name already breaks the segment grammar (`my_check`, `QALint`), it still breaks it after prefixing and needs a real rename. Run `vinaya check --plan` to see exactly how your config resolves before it runs, and `vinaya doctor` to diagnose a config that is being refused.

Glob scoping (`include`) is permitted; conditional logic (`if`/`unless`/`except`) is **never** part of this grammar — see the check-contract quick reference below for the full grammar and the error contract every registered `run` executable must honor.

## Roles config

Per-role override and additive-role registration works the same way `checks` does, under `vinaya.config.json`'s own `roles` key — one entry per role, each naming a `contract`: a markdown file, structurally validated against the same shape a bundled role doc carries (`role_id`, `description`, `actor`, `performs`, `refuses_when`, `summary` in frontmatter, plus `title` and `order`, plus a non-empty `## The short version` body section):

```json
{
  "roles": {
    "security": { "contract": "./roles/custom-security.md" },
    "acme/qa-lead": { "contract": "./roles/qa-lead.md" }
  }
}
```

A key that exactly matches a **core** role id (`developer`, `security`, and the rest of the bundled doctrine roles) is an override — a **complete replacement**, never a frontmatter patch — whose contract's own `role_id` must equal that key exactly. Any other key must be namespaced `<yourname>/<id>`, same grammar as `checks`, and is additive — its contract's own `role_id` must equal the key's post-`/` segment exactly, and that render id must not collide with a core role id or another additive role's render id. Unlike `checks`, there is no grace period here: a malformed entry (a shape violation, a `role_id` mismatch, a collision, a bare unnamespaced key) fails closed immediately, since `roles` config has no legacy population a warn window would need to keep working. `contract` is a path, resolved relative to `vinaya.config.json`'s own directory — a bare filename with no `/` is rejected at load, the same discipline `checks.run`'s executable path does not need but a file **read** benefits from. Only registrable from a repo-local `vinaya.config.json`; a global `~/.vinaya/config.json`'s `roles` key is stripped at load time, since a role contract becomes agent-facing doctrine (`vinaya doctrine --role` hands it to a third-party agent tool as operating instructions).

Run `vinaya check --plan` to see the resolved role registry before anything renders from it — a `RENDERS AS` column (the registry key and the role's own `role_id` differ once an additive entry is namespaced) and a `GATING` column (`core` for a `default`/`overridden` role, `inert` for an `additive` one — no core `ACTIONS` wiring exists for a render id core doctrine never declared).

## Check contract — quick reference

Full field-by-field reference: [vinaya.attalabs.dev/docs/cli](https://vinaya.attalabs.dev/docs/cli). The short version — what an executable must do to be a valid check:

- Exit `0` to pass, `1` to report findings. Any other exit code reads as `status: 'error'` to the runner.
- Emit findings as JSON lines on stderr, one per line: `{ schema: 1, check, severity: 'error' | 'warning', message, agent_recovery_prompt, file?, line?, pending? }`.
- `pending: true` marks a finding that is "has not happened yet", not "is wrong" — a gate reading an artefact a later step of the same turn produces. A report renders it as a wait rather than an error, instead of guessing that distinction back out of the message text.
- `agent_recovery_prompt` is a corrective **instruction**, not a restated diagnosis — it tells the model what to do, not what is wrong (that's `message`'s job).
- Never self-enforce a timeout — the runner does that (`vinaya.config.json`'s `timeoutMs`, or the runner's default).
- Never reach the network unless explicitly declared as an exception (today: none of the custom-check surface; the core `coherence`/`dispatch-readiness` checks are the only declared exceptions).
- `token-collection-wired` (ring 0, part of `vinaya check --all --local`'s managed hooks) is a worked example of this contract's narrowest shape: it consults only local `fs`/`process.env` — no PR body, no network — and refuses a commit only when the host's token-metering probe (`resolveMeteringCapability`, `@attalabs/aeg-core`) found a transcript pointer that is this session's on one of two grounds — its recorded id matches ours and the transcript it named could not be reached, or its id could not be read at all yet the file sits at this project's own pointer path owned by this user, which is broken wiring whoever wrote it. A host never wired to meter passes, and so does one holding only a pointer that provably belongs to another session — a plain human terminal carrying an earlier session's leftover, or a second agent session whose Stop hook has not fired yet. Both are the sanctioned operator-metered case, not a wiring defect.
- `token-report` (ring 1, `requiresOpenPr`) is a worked example of the CI-only shape: it reads `PR_BODY` and re-runs the same `resolveMeteringCapability` probe fresh in its own process, then fails only when the host is metering-capable AND the PR body's "Token report" section is missing, or carries a blank/non-numeric Tokens in/out cell — an incapable host, or an empty `PR_BODY` (no PR yet), both pass silently. It proves presence and shape only, never that the reported figures are true — a check has no transcript of its own to recompute them against. A probe that itself throws (as opposed to cleanly reporting incapable) is never caught into a false pass: left uncaught, it surfaces as `status: 'error'` through the runner's own malformed-stderr path, never a silent `status: 'pass'`.
- `exec-bits` (ring 0, part of `vinaya check --all --local`'s managed hooks) is a worked example of a diff-scoped local check: for every changed file that lives under a `checks/bin/` directory or begins with a `#!` line, it reads the mode git has in the INDEX (`git ls-files -s`) and fails on anything but `100755`. The index, never the working tree — a `chmod +x` on disk changes nothing git ships, so the exec bit is the one property that can be right locally and wrong for everyone who checks the repo out. A check bin is spawned directly, never through a shell, so a bin committed `100644` cannot start at all.

`vinaya new check <yourname>/<id>` scaffolds a worked, self-contained example that honors this contract out of the box, and prints the exact — namespaced — registration to paste.

## JSON output envelope

Every machine-readable (`--json`) output is wrapped in `{ schema: 1, data: ... }`. The `schema` field is a public-surface commitment — no code path in this package emits unversioned machine output.

## Generated CI in a repo that vendors this CLI

`init` and `upgrade` normally generate workflows that invoke the published package at the exact version that generated them, `npx --yes @attalabs/vinaya@<version>` — the same pin the generated git hooks carry, so CI's version is a committed fact rather than whatever the runner happens to resolve. (An unpinned `npx` would not mean "latest". If you declare `ci.setup`, the workflow installs your dependencies first, so a repo carrying this CLI as a devDependency silently runs *that* copy; if you declare no `ci.setup`, no install step is generated and a bare spec resolves whatever the registry serves that day. `vinaya upgrade` re-pins; `vinaya doctor` reports a stale pin as drift.) In a repo whose own `workspaces` include a member named `@attalabs/vinaya`, that invocation cannot work: npm matches the name against the workspace member *before* reading any version spec, resolves that member's `bin`, and execs a file nothing has built — `sh: vinaya: command not found`. Pinning a version does not help, because the name is matched first.

So `init` detects that case and generates a different shape for it: install, build the vendored member, and invoke its built `bin` by path. The detection is exact — a workspace member whose `package.json` `name` is `@attalabs/vinaya`, which is precisely the condition npm itself branches on. Every other repo keeps the published invocation unchanged.

Two things that shape puts into your CI, stated plainly because this is the only place you can read them:

- **A third-party action.** `oven-sh/setup-bun`, pinned to a commit rather than a mutable tag, is added to the jobs that build. It is the only non-`actions/*` action this tool writes into a repository, and it is emitted **only** in the vendored shape — an ordinary adopter's workflows contain none.
- **`bun install --ignore-scripts`.** The install runs against your pull request's own manifest, so the flag blocks the PR-controlled surface: your repo's root and workspace lifecycle scripts, plus anything a PR adds to `trustedDependencies`. If your install genuinely needs those scripts, this shape will fail at the build step rather than run them.

A repo on the vendored shape runs the CLI **from its own working tree**, so its CI exercises the code in the pull request rather than a published copy predating it. The consequence is worth stating plainly: a pull request that edits this package's check sources changes the checks that judge it.

The generated command embeds the member's directory and `bin` path. Both come from the target repo's `package.json`, so both are restricted to `[A-Za-z0-9@._-]` path segments, none of which may be `.`, `..`, or begin with `-`, up to 255 characters total. Anything else — a shell metacharacter, a newline, a `..` segment — is refused, and generation falls back to the published `npx` shape rather than emitting it.

`@` is permitted so an npm-scoped member such as `packages/@attalabs/vinaya` resolves normally; it carries no meaning to the shell, to YAML at the position it appears, or to an Actions expression. The path must also resolve inside the repository, which a textual `..` rule cannot guarantee on its own.

The generated review-authority workflows run only default-branch code: the required review gate and the Changesets-release exemption on `body-bare-digits` both use `pull_request_target`, and the comment-triggered evaluator also checks out the default branch. None of these authority paths run pull-request code or adopter `ci.setup`; ordinary `pull_request` content checks remain unprivileged. Protect `.github/workflows/**` with required CODEOWNERS review as the complementary change-control layer. The full trust-boundary and bootstrap account is in [`specs/self-hosting.md`](./specs/self-hosting.md) in the source repository — it is not part of the published tarball.

## Doc-owners coverage

`.vinaya/doc-owners` binds code globs to the docs that must change with them; `vinaya check`'s C5 gate enforces that binding against each pull request's own diff — it fires only when a changed file matches a bound glob. That leaves a gap C5 cannot close on its own: a binding whose code was deleted or renamed wholesale matches nothing on any later diff, ever again, and reads as healthy forever. `vinaya doctor` closes it separately — it never fails `vinaya check` — by walking every binding against the repo's full tracked-file list and reporting any whose code glob matches zero tracked files anywhere in the repo, or whose in-repo doc pointer doesn't exist on disk. Report-only, like every other `vinaya doctor` diagnostic: it repoints or removes nothing itself.

## Changeset coverage

The `changeset-coverage` core check couples a diff touching a published package's shipped files to a `.changeset/*.md` entry in the same diff — for each member of `.changeset/config.json`'s `fixed` group, a changed path counts as shipped iff it falls under that member's own `package.json` `files` allowlist, read live from every workspace member's own manifest, never a hardcoded path list. The Changesets-release branch itself is exempt by construction. Report-only (`scope: diff`, ring 0): findings print at `warning` severity and the check's own exit code always stays `0`, so installing it cannot newly redden an existing repo's CI. Dormant when the repo carries no `.changeset/config.json`, or none of its `fixed`-group members resolve.

## Quoted-command staleness

A doc that quotes a command or config line verbatim, in backticks, as a statement of present fact ("what runs today: `X`") goes stale silently once the thing it quotes changes — every other gate can pass while the quotation is simply wrong. The `quoted-command` core check catches this, but **only for spans an author explicitly marks** — it never infers from a command-looking span, because an adopter-facing instruction (a README's `npx @attalabs/vinaya init`) is not a claim and flagging it is exactly the false-positive shape that gets a check disabled.

Opt a span in by wrapping it in an `AEG:QUOTES-FILE` marker pair naming the file it quotes:

```markdown
one job — <!-- AEG:QUOTES-FILE:START:.github/workflows/ci.yml -->`npm test`<!-- AEG:QUOTES-FILE:END --> in CI
```

Both markers are HTML comments — invisible on render — and may sit inline within a sentence or on their own lines around a fenced block. The check reads the text between them (an inline `` `span` ``, a fenced block, or bare text — one layer of wrapping is stripped either way) and asserts it still appears verbatim in the named file's current content; a marker inside a fenced/inline code example (e.g. one demonstrating this very syntax) is ignored, never mistaken for a real annotation. A finding names both sides: what the doc claims, and which file no longer contains it.

Swept corpus: the same `ships`/`reader-facing` governed-doc classes `reader-resolvable-prose` sweeps (`<doctrineRoot>/**` by default, plus any configured reader-facing pages) — never `apps/*/specs/**` or a `CLAUDE.md`. The cited file itself can be anywhere in the repo. Report-only (`scope: diff`, ring 0): findings print at `warning` severity and the check's own exit code always stays `0`, so installing it cannot newly redden an existing repo's CI. Dormant everywhere no doc carries the marker.

## Doctrine-no-procedures

Doctrine explains what a command does and why; it is not a runbook a reader executes verbatim, and a copy-pasted sequence rots the moment the real command changes underneath it. The `doctrine-no-procedures` core check refuses a fenced code block anywhere under `<doctrineRoot>/**/*.md` that contains two or more lines each starting with a shell command word (`export`/`bun`/`gh`/`git`/`grep`/`sed`/`cat`/`diff`/`vinaya`) — that shape is a sequence to run, not an illustration.

Two exemptions: a block sitting inside the `AEG:VENDOR-EXAMPLE` anchor pair (this repo's own one sanctioned fenced home for a real command sequence, `tranche-model.md` §12), and any file under a `templates/` directory (a worked-example template legitimately shows the full shape a real PR/Issue body carries). Unlike `doctrine-portability`/`reader-resolvable-prose`/`retired-vocabulary` above, this check is **blocking, not report-only** (`severity: error`, exit `1` on any finding) — it ships with an expected-zero corpus rather than an unfixed backlog, so day-one install does not need a baseline rollout.

## Objectives gate

A task Issue must carry a `## Objectives` section — numbered `O<n>. <sentence>` lines, one observable outcome each, contiguous from `O1`, never a file path. `vinaya issue create`/`vinaya issue edit` refuse a task Issue without one via the `objectives` `briefSchema.issue` builtin, and `vinaya check coherence`'s R1 grades the same rule continuously against the live stock — both for Issues numbered `OBJECTIVES_SINCE_ISSUE` (404) and above; an Issue below that number passes unconditionally, so the pre-gate stock stays green.

The brief side has two more gates, run at `verify-brief`/`brief-shape` time: the brief's own `## Objectives` section must match the Closes-linked Issue's (compared normalised — whitespace never fails it, one changed word does), and every numbered Part in §6 must cite at least one `O<n>` while every `O<n>` is cited by at least one Part. A standalone brief with no linked Issue is exempt unless it opts in with its own `## Objectives` section, in which case it is compared against itself.

## Brief-schema divergence

`briefSchema` in `vinaya.config.json` is yours: `vinaya upgrade` preserves it wholesale and never rewrites it. On its own that ownership has a silent cost — nothing else reads it either, so a builtin deleted to work around a defect stays deleted, with no later upgrade to repair it and nothing to surface it.

`vinaya doctor` reports the divergence. It compares your `briefSchema.pr` and `briefSchema.issue` against the set `vinaya init` ships and names any builtin that is absent — nothing more. Extra sections, whether a second builtin or your own `heading`/`field`/`phrase` matcher, are additions rather than weakenings and are never reported. The finding is `info` severity and can never fail your CI: running without a builtin is legitimate configuration, and the goal is to make the choice visible, not to argue you back to the default.

Once an omission is deliberate, name it in `briefSchema.ack` and it goes quiet:

```json
{ "briefSchema": { "ack": ["closesN"] } }
```

`ack` grants nothing and gates nothing — it only silences this report, and acking a builtin you still declare changes no behaviour anywhere. A deletion you did not intend, having no ack, keeps surfacing.

Two things worth knowing about its shape. `ack` is one flat list rather than per-kind, so acking a name that the shipped default declares for **both** kinds — `project` is the only such name today — silences it for both. And a config carrying no `briefSchema` key at all diverges on every builtin, so it reports on every run until you either declare the sections or ack them; that is the one shape where this becomes standing output rather than a one-time notice.

Report-only, like every other `vinaya doctor` diagnostic: it restores nothing itself.

## Pinning Studio's port

`vinaya studio` binds `3008`, or `3108` when that is taken. `--port <n>` overrides both, and the override does **not** fall back: if the port you named is busy, the command refuses instead of quietly binding a different one.

That asymmetry is deliberate. The default pair exists so a casual `vinaya studio` still comes up when something else holds `3008`. But naming a port is how you buy certainty about which server answered you — and silently moving to another port spends exactly that. Run two Studio servers on one machine without it and a `200` from `/studio` tells you nothing about which process replied.

```bash
vinaya studio --port 3208     # or --port=3208
```

A malformed value exits `2` before anything starts: no value, a non-number, one outside `1`–`65535`, a leading zero, or the flag given twice with different values.

The flag applies to a published install, where this CLI launches the bundled server and owns the port. In a checkout carrying Studio's source it is refused, because that path runs Studio's own dev script, which picks its own port and ignores what it is passed — accepting the flag there would report a port nothing ever binds.

## Known limits

The five core AEG checks (`coherence`, `dispatch-readiness`, and siblings) are bound to the Vinaya development repository — they read governance documents relative to it. Outside a Vinaya workspace, `vinaya check --all` reports those checks as `status: 'error'` rather than crashing.

`registry-gates` is bound the same way, but reports differently: it validates this package's own `aeg-root/enforcement.md` against its own `aeg-root/roles`/`aeg-root/contracts` — a tree only the Vinaya development repository itself carries, never an adopter install. Outside that repository it reports `status: 'pass'` with a `warning` finding announcing the dormancy and why, rather than `'error'` or a silent zero-finding pass. `reader-resolvable-prose`/`retired-vocabulary` are not bound this way: their unconfigured `doctrineRoot` resolves to this package's own installed copy of `aeg-root` (`vinaya doctrine`'s own resolution), so they sweep real content in every install, not only inside the Vinaya development repository. Set `proseGates.doctrineRoot` in `vinaya.config.json` to sweep your own doctrine tree instead, if you have one.

Custom checks are any executable you register in `vinaya.config.json`, in any language. Note that the TypeScript file `vinaya new check` scaffolds carries a `#!/usr/bin/env bun` shebang, so **that scaffold requires [bun](https://bun.sh) on your `PATH`** — without it the check reports `status: 'error'`. The CLI itself needs only Node; this applies to the scaffolded template alone. Write the check in a language your machine already runs and it has no such requirement.

## Documentation

Full documentation at [vinaya.attalabs.dev](https://vinaya.attalabs.dev) — the command reference lives at [/docs/cli](https://vinaya.attalabs.dev/docs/cli), and [/start](https://vinaya.attalabs.dev/start) walks the path from install to a governed repository.

## License

Copyright (C) 2026 Daniel Estevez.

Apache-2.0 — see [LICENSE](./LICENSE).
