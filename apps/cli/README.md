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
| `vinaya review post --role code-reviewer \| security --pr <n> ...` | Render, post, and self-verify a code-reviewer or security-review verdict comment on a PR from structured flags (verdict, findings, per-field text) instead of a hand-typed comment. Resolves the PR's real head itself (`gh pr view --json headRefOid`); renders every structural `VERDICT:`/`Judged head:` line from validated inputs, never from caller-supplied text; refuses a contradictory verdict (a BLOCKER/CRITICAL-or-HIGH finding with a clean verdict) before posting anything; and after posting, re-fetches the comment and refuses to exit 0 unless it re-parses through the exact `extractCodeReviewVerdict`/`extractSecurityReviewVerdict` functions the merge gate calls. `--json` for the enveloped machine form. |
| `vinaya studio` | Launch Vinaya Studio. Inside a checkout that carries Studio's source (`apps/vinaya-studio/web` — it lives in the attalabs monorepo, not this repository) it runs the dev app; a published install runs its bundled standalone server instead, fetched from attalabs' published release artifact at publish time. `--port <n>` binds an exact port — see below. |
| `vinaya milestone create --title <title> --body-file <path>` | Create a GitHub Milestone from a validated body. The title is free text, never parsed for a version — the description's optional `Release:` field is the sole authority for one. Refuses before any `gh` write when the goal is absent, `Release:` is present but malformed, or an `### Tranche intents` section (`- <slug>: <intent text>`) doesn't parse. `--validate-only` runs every check without writing; `--json` for the enveloped machine form. |
| `vinaya milestone adopt --target <title> --slug <slug> [--slug <slug> ...]` | Move one or more existing tranches into a target Milestone: reattaches every Issue carrying each `vinaya/tranche:<slug>` label to `--target`, then closes (never deletes) each slug's old tranche-Milestone. Every fact is gathered and refused-or-passed as ONE batch before any write — an unknown slug, a slug whose label carries no Issues, a target that does not exist or is closed, or a slug already adopted into a different Milestone refuses the whole invocation, not just its own slug. `--validate-only` runs every check without writing; `--json` for the enveloped machine form. |
| `vinaya quickstart [--yes] [--dry-run]` | Guided wizard that runs `init` → optional doc-owners bind → optional project registration → commit → `demo break` → `doctor` → `push` in sequence, prompting between steps. `--yes` forwards straight through to `init` and answers every one of quickstart's own prompts with its documented default (skip the two optional steps, run the refusal-then-fix proof, push) — no prompt is opened at all, so the command completes with no human at the keyboard rather than merely with stdin closed. `--dry-run` also forwards to `init` and stops immediately after its preview — nothing is installed, so no later step runs against an uninstalled repo. |

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

## Where the git hooks live

`vinaya init` installs the ring-0 hooks (`pre-commit`, `pre-push`) into a **tracked** `.vinaya/hooks/` directory and points git at it with `git config core.hooksPath .vinaya/hooks` — commit that directory. Raw `.git/hooks` is never versioned by git, so hooks installed there exist only on the installing machine; tracked hooks travel with the repo into every clone and every linked worktree checkout.

One thing git cannot version is the config itself: **each fresh clone runs `git config core.hooksPath .vinaya/hooks` once** to arm the hooks (linked worktrees inherit it — the config is shared, the path is relative). `vinaya doctor` reports an unarmed clone as an error naming that exact command; `vinaya init` and `vinaya upgrade` also set it.

Two shapes deviate: a repo already using **husky** keeps its `.husky/` directory (husky's `prepare` script owns per-clone wiring), and a repo with its own active raw hooks in `.git/hooks` stays on the legacy append-a-managed-block layout there — re-routing `core.hooksPath` would silently disable the adopter's own hooks. On that legacy layout `vinaya doctor` warns that clones have no hooks, and `vinaya upgrade` migrates to the tracked layout as soon as nothing foreign would be disabled.

On that legacy `.git/hooks` layout, note where the hook actually lives: hooks are never per-worktree, so its real home is the main checkout's shared hooks directory (`git rev-parse --git-common-dir`), which from a linked worktree is outside that worktree's own root. `vinaya eject` follows the hook there and bounds the removal to that directory's `hooks/` subtree, rather than to the worktree root — so ejecting from a linked worktree strips the hook instead of leaving it armed. A canonically spelled block path resolving anywhere else is refused, and the refusal is whole-run: `eject` removes nothing at all rather than making a partial destructive pass. (The `.git/` test is byte-exact, so a non-canonical spelling takes the working-tree branch instead — nothing vinaya generates produces one.)

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
- Emit findings as JSON lines on stderr, one per line: `{ schema: 1, check, severity: 'error' | 'warning', message, agent_recovery_prompt, file?, line? }`.
- `agent_recovery_prompt` is a corrective **instruction**, not a restated diagnosis — it tells the model what to do, not what is wrong (that's `message`'s job).
- Never self-enforce a timeout — the runner does that (`vinaya.config.json`'s `timeoutMs`, or the runner's default).
- Never reach the network unless explicitly declared as an exception (today: none of the custom-check surface; the core `coherence`/`dispatch-readiness` checks are the only declared exceptions).

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
