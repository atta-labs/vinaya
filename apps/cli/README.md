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
| `vinaya doctrine` | Print the absolute path of the bundled doctrine's front door (`aeg-root/skills/aeg/SKILL.md`) on this machine. The committed root `VINAYA.md` pointer names the package, never a filesystem path — this command is the read-time resolution step it hands the reader. `--json` for the enveloped `{ root, entry }` form. |
| `vinaya check <name> \| --all` | Run one check, or every registered check (core + `vinaya.config.json`-registered). `--json` for the enveloped `{ checks: CheckOutcome[] }` form; `--diff-only` scopes `scope: 'diff'` checks to changed files; `--parallel[=n]` caps concurrency (default: cpu-derived). Findings always print as the check contract's JSON lines on stderr, regardless of `--json`. Exit 0 iff every check passed. |
| `vinaya new check <yourname>/<id>` | Scaffold a self-contained custom check into `./scripts/vinaya-checks/<id>.ts`, ready to register in `vinaya.config.json` under that namespaced key |
| `vinaya review post --role code-reviewer \| security --pr <n> ...` | Render, post, and self-verify a code-reviewer or security-review verdict comment on a PR from structured flags (verdict, findings, per-field text) instead of a hand-typed comment. Resolves the PR's real head itself (`gh pr view --json headRefOid`); renders every structural `VERDICT:`/`Judged head:` line from validated inputs, never from caller-supplied text; refuses a contradictory verdict (a BLOCKER/CRITICAL-or-HIGH finding with a clean verdict) before posting anything; and after posting, re-fetches the comment and refuses to exit 0 unless it re-parses through the exact `extractCodeReviewVerdict`/`extractSecurityReviewVerdict` functions the merge gate calls. `--json` for the enveloped machine form. |
| `vinaya studio` | Launch Vinaya Studio. Inside a checkout that carries Studio's source (`apps/vinaya-studio/web` — it lives in the attalabs monorepo, not this repository) it runs the dev app; a published install runs its bundled standalone server instead, fetched from attalabs' published release artifact at publish time. |

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

## Where the git hooks live

`vinaya init` installs the ring-0 hooks (`pre-commit`, `pre-push`) into a **tracked** `.vinaya/hooks/` directory and points git at it with `git config core.hooksPath .vinaya/hooks` — commit that directory. Raw `.git/hooks` is never versioned by git, so hooks installed there exist only on the installing machine; tracked hooks travel with the repo into every clone and every linked worktree checkout.

One thing git cannot version is the config itself: **each fresh clone runs `git config core.hooksPath .vinaya/hooks` once** to arm the hooks (linked worktrees inherit it — the config is shared, the path is relative). `vinaya doctor` reports an unarmed clone as an error naming that exact command; `vinaya init` and `vinaya upgrade` also set it.

Two shapes deviate: a repo already using **husky** keeps its `.husky/` directory (husky's `prepare` script owns per-clone wiring), and a repo with its own active raw hooks in `.git/hooks` stays on the legacy append-a-managed-block layout there — re-routing `core.hooksPath` would silently disable the adopter's own hooks. On that legacy layout `vinaya doctor` warns that clones have no hooks, and `vinaya upgrade` migrates to the tracked layout as soon as nothing foreign would be disabled.

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

Branch protection is worth enabling, and it does not make the generated review gate unbypassable — a required status check is satisfied by a conclusion reported under its name, and under a `pull_request` trigger the workflow definition comes from the PR. That is true whether CI runs the published package or a vendored build; vendoring widens what the PR controls, it does not open the hole. The full statement, including where the shape degrades silently, is in [`specs/self-hosting.md`](./specs/self-hosting.md) in the source repository — it is not part of the published tarball.

## Doc-owners coverage

`.vinaya/doc-owners` binds code globs to the docs that must change with them; `vinaya check`'s C5 gate enforces that binding against each pull request's own diff — it fires only when a changed file matches a bound glob. That leaves a gap C5 cannot close on its own: a binding whose code was deleted or renamed wholesale matches nothing on any later diff, ever again, and reads as healthy forever. `vinaya doctor` closes it separately — it never fails `vinaya check` — by walking every binding against the repo's full tracked-file list and reporting any whose code glob matches zero tracked files anywhere in the repo, or whose in-repo doc pointer doesn't exist on disk. Report-only, like every other `vinaya doctor` diagnostic: it repoints or removes nothing itself.

## Known limits

The five core AEG checks (`coherence`, `dispatch-readiness`, and siblings) are bound to the Vinaya development repository — they read governance documents relative to it. Outside a Vinaya workspace, `vinaya check --all` reports those checks as `status: 'error'` rather than crashing.

Custom checks are any executable you register in `vinaya.config.json`, in any language. Note that the TypeScript file `vinaya new check` scaffolds carries a `#!/usr/bin/env bun` shebang, so **that scaffold requires [bun](https://bun.sh) on your `PATH`** — without it the check reports `status: 'error'`. The CLI itself needs only Node; this applies to the scaffolded template alone. Write the check in a language your machine already runs and it has no such requirement.

## Documentation

Full documentation at [vinaya.attalabs.dev](https://vinaya.attalabs.dev) — the command reference lives at [/docs/cli](https://vinaya.attalabs.dev/docs/cli), and [/start](https://vinaya.attalabs.dev/start) walks the path from install to a governed repository.

## License

Copyright (C) 2026 Daniel Estevez.

Apache-2.0 — see [LICENSE](./LICENSE).
