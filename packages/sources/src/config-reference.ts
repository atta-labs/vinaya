/**
 * The `vinaya.config.json` reference — an AUTHORED registry, not a Zod
 * introspection. `apps/vinaya/cli/src/lib/config.ts`'s `VinayaConfigSchema`
 * validates SHAPE only (zero `.describe()` calls); this module is the one
 * place semantics are written down in adopter-facing prose. Content is
 * reconciled from two sources of truth — `config.ts`'s own comments and
 * `specs/vinaya-spec.md`'s Configuration architecture chapter — never
 * invented.
 *
 * `apps/vinaya/cli/tests/checks/config-reference-coverage.test.ts` proves
 * every `VinayaConfigSchema` top-level key and every `CheckEntrySchema` key
 * has a row here, by key-presence only (it does not check prose accuracy —
 * that is a review concern, not a mechanizable one).
 *
 * `web` renders this registry (`apps/vinaya/web/src/app/(site)/config`);
 * `web` must never import `cli` internals, so this lives sources-side,
 * exactly like `commands.ts`'s `COMMANDS`.
 */

export type ConfigField = {
  /** Dotted path from the config root, e.g. `checks`, `checks.<name>.env`. Matches `VinayaConfigSchema`/`CheckEntrySchema`'s own key for top-level and check-entry rows — this is what the coverage test matches against. */
  key: string
  /** Human-readable type/forms summary, e.g. `object (optional)`, `true | { optional: true } | { anyOf: string[] } | string`. */
  type: string
  /** One–three adopter-facing sentences: what it's for and how it behaves. */
  semantics: string[]
  /** A runnable JSON snippet showing the field in context. */
  example: string
  /** Set only where a form invites a real security mistake (the `env` literal form). */
  warning?: string
}

export const CONFIG_REFERENCE: readonly ConfigField[] = [
  {
    key: 'rings',
    type: 'object (optional)',
    semantics: [
      'Declarative booleans for the two opt-in accelerator rings. Ring 0 (git hooks) and the CI/branch-protection guarantee are never represented here — they are universal, not configurable — so this object controls only whether the optional rings are on.'
    ],
    example: `{
  "rings": {
    "ring1_forgeWriteInterception": true,
    "ring2_asyncAudits": true
  }
}`
  },
  {
    key: 'rings.ring1_forgeWriteInterception',
    type: 'boolean',
    semantics: [
      'Additive, never disabling. `false` (the default — every `vinaya init` starter config reads `false` here) is a no-op: `pr`/`issue create|edit` validate a body against `briefSchema` before any `gh` write, exactly as they always have. `true` is the opt-in accelerator — the only value that changes behavior — and skips that validation entirely.'
    ],
    example: `{ "rings": { "ring1_forgeWriteInterception": true } }`
  },
  {
    key: 'rings.ring2_asyncAudits',
    type: 'boolean',
    semantics: [
      'Additive, never disabling. `false` (the default — every `vinaya init` starter config reads `false` here) is a no-op: `vinaya archive`’s provenance work and `vinaya audit`’s dead-branch-push notification run exactly as they always have. `true` is the opt-in accelerator — the only value that changes behavior — and skips that work, exiting `0` without doing anything.',
      'Deliberately does NOT gate `vinaya audit`’s direct-main-push detection, which stays unconditional regardless of this flag — it is a real pass/fail that catches a branch-protection bypass, and its own on/off switch must never be readable from ordinary, PR-reachable config content (the security-review reasoning: the actor a detector exists to catch must never also be able to disable it in the same push).'
    ],
    example: `{ "rings": { "ring2_asyncAudits": true } }`
  },
  {
    key: 'checks',
    type: 'Record<string, CheckEntry> (optional)',
    semantics: [
      'Custom-check registration, keyed by check name. Each entry produces the exact same `CheckSpec` shape the built-in registry does — no field either side can carry that the other cannot.',
      'A key that exactly matches a core check id is an **override attempt** (replaces the core check, contract-validated, fail-closed if malformed); any other key must be namespaced `<yourname>/<id>` (exactly one `/`, both segments `[a-z0-9][a-z0-9-]*`, the `vinaya` prefix reserved). A bare key matching no core id is a config error.',
      'Globs (`include`) are permitted for scoping; conditionals (`if`/`unless`/`except`) are never part of this grammar. Registered from a repo-local `vinaya.config.json` only — a global `~/.vinaya/config.json`’s `checks` key is stripped at load time with a loud stderr warning, never resolved.'
    ],
    example: `{
  "checks": {
    "myteam/vocab-check": {
      "run": "./scripts/vinaya-checks/vocab-check.ts",
      "scope": "diff",
      "include": ["**/*.md"]
    }
  }
}`
  },
  {
    key: 'checks.run',
    type: 'string',
    semantics: ['The executable path (or bare command on PATH) the runner spawns directly — never through a shell.'],
    example: `{ "run": "./scripts/vinaya-checks/vocab-check.ts" }`
  },
  {
    key: 'checks.scope',
    type: `'diff' | 'full'`,
    semantics: [
      '`diff` checks may be skipped by the runner under `--diff-only` when no changed file matches `include`. `full` checks (coherence, dispatch-readiness) always run — they read live forge state, not the local diff.'
    ],
    example: `{ "scope": "diff" }`
  },
  {
    key: 'checks.include',
    type: 'string[] (optional)',
    semantics: ['Glob patterns that scope a `diff`-scoped check to changed files. Scoping only — never a conditional.'],
    example: `{ "include": ["**/*.md", "apps/**/*.ts"] }`
  },
  {
    key: 'checks.args',
    type: 'string[] (optional)',
    semantics: ['Extra argv elements passed to `run`, appended after the runner’s own fixed arguments.'],
    example: `{ "args": ["--strict"] }`
  },
  {
    key: 'checks.timeoutMs',
    type: 'number (optional)',
    semantics: [
      'Advisory to the check; the RUNNER enforces the actual deadline (kills the whole process group), never the check itself.'
    ],
    example: `{ "timeoutMs": 30000 }`
  },
  {
    key: 'checks.requiresOpenPr',
    type: 'boolean (optional)',
    semantics: [
      'Marks a check that can only meaningfully evaluate once a pull request exists — it reads the real PR body/number, not local git state. The generated `pre-commit`/`pre-push` hooks (`vinaya check --all --local`) skip a check declaring this entirely rather than running it against a PR that cannot exist yet; CI (which only ever runs after a PR is open) always runs it for real.',
      'Use for a custom check with the same shape as the core `closes-n`/`test-plan` checks — anything that would otherwise deadlock the first commit on a fresh branch by requiring PR content before a PR can exist.'
    ],
    example: `{ "requiresOpenPr": true }`
  },
  {
    key: 'checks.ownWorkflow',
    type: 'boolean (optional)',
    semantics: [
      'Marks a check that a dedicated workflow of your own already reports. `vinaya check --all` omits it, so the same check is never evaluated twice under two different job names. Naming the check directly (`vinaya check <name>`) still runs it.',
      "Use it when a check's answer can change AFTER a push — for example one that reads pull-request comments. Such a check needs its own workflow that something re-runs when the input changes; a second copy inside `--all` is never re-run, so it freezes at push-time state and reports a stale result forever. The core `review-gate` check is exactly this shape and carries this flag."
    ],
    example: `{ "ownWorkflow": true }`
  },
  {
    key: 'checks.env',
    type: 'Record<string, EnvEntry> (optional)',
    semantics: [
      'The per-check environment allowlist. A check’s child process receives ONLY a fixed safe baseline (`PATH`, `LANG`, `HOME`, `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `TMPDIR`) plus whatever this declaration explicitly forwards — never the full parent environment.',
      'A check that reads `process.env`/`Bun.env`/`Deno.env` directly with no `env` declared is invisible to the child process; `vinaya doctor` carries the permanent diagnostic for that gap. Four declared forms, below.'
    ],
    example: `{
  "env": {
    "JIRA_TOKEN": { "anyOf": ["JIRA_TOKEN", "JIRA_PAT"] }
  }
}`
  },
  {
    key: 'checks.env.passthrough',
    type: 'true',
    semantics: [
      'Required passthrough — forwards the caller’s own value for this key verbatim. Absent from the caller’s environment synthesizes a `CheckError` before the check ever spawns.'
    ],
    example: `{ "env": { "GITHUB_TOKEN": true } }`
  },
  {
    key: 'checks.env.optional',
    type: '{ optional: true }',
    semantics: [
      'Passthrough if set, simply absent from the child otherwise — never fatal. Use for a var the check’s own code already tolerates missing (e.g. a CI-only secret that would otherwise hard-block `git push` on a developer laptop).'
    ],
    example: `{ "env": { "PR_BODY": { "optional": true } } }`
  },
  {
    key: 'checks.env.anyOf',
    type: '{ anyOf: string[] }',
    semantics: [
      'An either/or requirement with no deeper fallback — at least one named member must be set in the caller’s environment, or a `CheckError` is synthesized before spawn. Every set member passes through under its own name.',
      'The record key must be one of its own `anyOf` members, and at least 2 unique members are required (a single-member `anyOf` is just `true` under a different name). Adopter-facing only — no core check uses this form, since every core check’s env read already has a deeper fallback (a `gh auth token` subprocess, a default literal) that an `anyOf`’s hard pre-spawn failure would be wrong for.'
    ],
    example: `{ "env": { "JIRA_TOKEN": { "anyOf": ["JIRA_TOKEN", "JIRA_PAT"] } } }`
  },
  {
    key: 'checks.env.literal',
    type: 'string',
    semantics: [
      'Sets the key to this exact value, never interpolated — `spawn` takes an explicit `env` object, no shell expands `$VAR`.'
    ],
    example: `{ "env": { "NODE_ENV": "test" } }`,
    warning:
      'Never put a secret in a literal. `env` values live in a COMMITTED file, reviewed like any other code change — a literal is for fixed, non-sensitive values only (e.g. `"NODE_ENV": "test"`), never a token or credential. `vinaya doctor` warns on a high-entropy literal (looks like a leaked secret) and on a literal `"true"`/`"false"` string (almost certainly meant as the boolean passthrough form instead) as a backstop, but review is the real defense — do not rely on the linter to catch every case.'
  },
  {
    key: 'roles',
    type: 'Record<string, RoleEntry> (optional)',
    semantics: [
      'Per-role override and additive-role registration, keyed by config key. Each entry names a `contract`: a markdown file, structurally validated the same way a core role doc is — six frontmatter keys (`role_id`, `description`, `actor`, `performs`, `refuses_when`, `summary`), plus `title` and `order`, plus a non-empty "## The short version" body section.',
      "A key that exactly matches a core role id is an **override attempt** (a COMPLETE replacement of that role — never a patch, no frontmatter inheritance — whose contract's own `role_id` must equal the config key exactly); any other key must be namespaced `<yourname>/<id>` (exactly one `/`, both segments `[a-z0-9][a-z0-9-]*`, the `vinaya` prefix reserved) and is **additive**, whose contract's own `role_id` must equal the key's post-\"/\" segment exactly. A bare key matching no core role id is a config error.",
      'Unlike `checks`, there is deliberately NO grace period for a malformed entry — roles config is wholly new, with no legacy population a warn window would need to keep alive, so every malformed variant fails closed from day one.',
      "An additive role's own `role_id` (its \"render id\" — what every renderer, `vinaya check --plan`'s RENDERS AS column included, actually shows) must not collide with a core role id or with another additive role's render id; either collision is a config error naming both colliding keys.",
      "Registered from a repo-local `vinaya.config.json` only — a global `~/.vinaya/config.json`'s `roles` key is stripped at load time with a loud stderr warning, never resolved, because a role contract is agent-facing doctrine (`vinaya doctrine --role` hands it to a third-party agent tool as operating instructions), and which contract a role name resolves to must come from the reviewed, committed repo file."
    ],
    example: `{
  "roles": {
    "developer": { "contract": "./roles/custom-developer.md" },
    "acme/qa-lead": { "contract": "./roles/qa-lead.md" }
  }
}`
  },
  {
    key: 'roles.contract',
    type: 'string',
    semantics: [
      'A PATH to the role\'s markdown contract, resolved relative to this `vinaya.config.json`\'s own directory. PATH-ONLY: a slash-free value (a bare filename like `"developer.md"`) is rejected at load — it must read as a path, never a bare role id.'
    ],
    example: `{ "contract": "./roles/custom-developer.md" }`
  },
  {
    key: 'briefSchema',
    type: 'object (optional)',
    semantics: [
      'The config-defined brief schema the forge-write commands (`pr create|edit`, `issue create|edit`) validate a body against, locally, before any `gh` write. Declarative only — a required section is either a named battle-tested builtin or a generic heading/field/phrase matcher; no conditional grammar.'
    ],
    example: `{
  "briefSchema": {
    "pr": { "sections": [{ "builtin": "tier" }, { "heading": "Rollback Plan" }] }
  }
}`
  },
  {
    key: 'briefSchema.pr',
    type: '{ sections: BriefSection[] } (optional)',
    semantics: ['Required sections for a PR body — checked by `vinaya pr create|edit` before any `gh` write.'],
    example: `{ "pr": { "sections": [{ "builtin": "closesN" }] } }`
  },
  {
    key: 'briefSchema.issue',
    type: '{ sections: BriefSection[] } (optional)',
    semantics: ['Required sections for an Issue body — checked by `vinaya issue create|edit` before any `gh` write.'],
    example: `{ "issue": { "sections": [{ "builtin": "issueRationale" }] } }`
  },
  {
    key: 'briefSchema.milestone',
    type: '{ sections: BriefSection[] } (optional)',
    semantics: [
      'Required sections for a Milestone body — checked by `vinaya milestone create` before any `gh` write, same shape as `briefSchema.pr`/`briefSchema.issue`.',
      "`checkMilestoneShape`'s own refusal (goal absent, `Release:` present but malformed, the `### Tranche intents` section unparseable) is unconditional and runs whether or not this key is set — mirroring the Issue-only content gate (`checkBlastRadiusScope`/`checkNoBriefContent`/`checkRationaleNamesDocs`), config decides which EXTRA sections are required, never whether that check runs. This key only adds an adopter's own custom `heading`/`field`/`phrase` sections, or opts into the `milestoneShape` builtin explicitly for the same check surfaced through this path too."
    ],
    example: `{ "milestone": { "sections": [{ "builtin": "milestoneShape" }] } }`
  },
  {
    key: 'briefSchema.ack',
    type: 'BriefBuiltin[] (optional)',
    semantics: [
      "Builtin names this repo has deliberately dropped from `briefSchema.pr`/`briefSchema.issue`. Purely a silencer for `vinaya doctor`'s brief-schema divergence report — it grants nothing, gates nothing, and acking a builtin that is still declared changes no behaviour.",
      "`briefSchema` is yours: `vinaya upgrade` never rewrites it. That also means a builtin deleted as a workaround stays deleted and, without this report, stays invisible — no command surfaces it and no later upgrade repairs it. `doctor` reports the divergence at `info` severity, so it never fails anyone's CI; list a name here once the omission is a considered choice, and an accidental one keeps surfacing."
    ],
    example: `{ "briefSchema": { "ack": ["closesN"] } }`
  },
  {
    key: 'managed',
    type: 'object (optional)',
    semantics: [
      'The ownership manifest `vinaya init` writes and `vinaya eject` reads — machine-owned, never adopter-authored. It records exactly what the installer created (`files`, marker-delimited `blocks` inside adopter-owned files, created-if-absent `labels`) so `eject` reverses precisely: deleting only files it created, stripping only blocks it wrote, reporting labels for manual removal.',
      'If this manifest is absent or corrupt at eject time, `eject` refuses rather than guessing at ownership. Hand-editing this block is not a supported workflow.'
    ],
    example: `{
  "managed": {
    "version": 1,
    "files": [".github/workflows/vinaya-checks.yml"],
    "blocks": [],
    "labels": ["tier:1"]
  }
}`
  },
  {
    key: 'principals',
    type: 'string[] (optional, min 1)',
    semantics: [
      'GitHub logins trusted as THIS repo’s own principals — the only authors whose PR comments count as a review-gate verdict, and the only actors an actor-verified `vinaya/waiver:docs`/`vinaya/waiver:review` label trusts. Overrides the package’s hardcoded default principal (this monorepo’s own maintainer) entirely — a full replacement, not additive.',
      'Repo-local only, same rule as `checks`: a global `~/.vinaya/config.json`’s `principals` key is stripped at load time with a loud stderr warning, never resolved — who is trusted to approve merges must come from the reviewed, committed per-repo file, never a machine-wide personal config.',
      'Without this key, `vinaya`’s hardcoded default principal is the only trusted author — which makes review-gate structurally unpassable on any repo that principal doesn’t personally review. Set this to your own team’s GitHub logins to make the gate passable on your repo.',
      'Read from your repository’s DEFAULT BRANCH via the GitHub API — the value itself never comes from the pull request’s own checkout or local git state, both of which a pull request can rewrite. A PR that edits this field therefore takes effect only once it merges, never for itself. (The API call is addressed using the repository identity the Actions runner provides; that part is not a separate lever, for the reason in the next note.)',
      '⚠️ **This field is only a security control if `main` has branch protection with the Vinaya check marked as a required status check.** Vinaya’s checks run in a `pull_request`-triggered workflow, which GitHub executes from the pull request’s own copy of the workflow file — so a PR can always edit or delete the job that runs them. What a PR cannot do is satisfy a required status check that never reports. Without branch protection, `principals` is a useful team convention, not an enforced boundary. `vinaya init` prints the exact `gh api` command to enable it, and `vinaya doctor` reports when it is missing.',
      '**Set this on your default branch before you need it.** Because the value is read from the default branch, a pull request that introduces `principals` for the first time is still evaluated against vinaya’s built-in default — so its own author cannot yet approve it, and cannot self-waive either (the waiver labels resolve through the same list). Land it with the `vinaya init` install commit, or any push to the default branch, before enabling branch protection. Once it is on the default branch, ordinary review applies: adding a principal thereafter needs an existing principal’s approval, which is the point.'
    ],
    example: `{ "principals": ["alice", "bob"] }`
  },
  {
    key: 'releaseActor',
    type: 'string (optional, min 1)',
    semantics: [
      'The GitHub login expected to author THIS repo’s Changesets release PR (branch `changeset-release/main`) — the identity `body-bare-digits` checks before treating that PR as machine-rendered, already-reviewed content instead of agent-narrated prose. Overrides the package’s default (`github-actions[bot]`, the identity `changesets/action` shows when it opens a release PR using the ambient `GITHUB_TOKEN`).',
      'Set this when your repository opens release PRs some other way — most commonly a custom PAT (e.g. a `RELEASE_TOKEN` secret) whose owner is a real user login, not a bot. Without it, the release-PR exemption silently never fires for a repo like that, and every release PR stays blocked by its own auto-generated bare version numbers and commit shas.',
      'Same trust class and sourcing rule as `principals` — repo-local only (a global `~/.vinaya/config.json`’s `releaseActor` is stripped at load time with a loud stderr warning), and read from your repository’s DEFAULT BRANCH via the GitHub API, never from the pull request’s own checkout, local git, or an env var. A PR that introduces or changes this field takes effect only once it merges.',
      'The exemption itself only runs from `vinaya-body-checks.yml`, a `pull_request_target` workflow — the same trust boundary `principals`/review-gate already use. `body-bare-digits` never trusts this decision from `vinaya-checks.yml`’s ordinary `pull_request` job, because that job runs the pull request’s own copy of the workflow file.'
    ],
    example: `{ "releaseActor": "your-release-bot-or-token-owner" }`
  },
  {
    key: 'ci',
    type: 'object (optional)',
    semantics: [
      'Adopter-declared CI preparation for the generated workflows. Vinaya’s own checks arrive whole via `npx` and need no setup; your custom checks are scripts in your repository that may import your repository’s code, and the generated jobs install none of it by default — without this key, any custom check with a dependency fails in CI as a spawn error while passing in the local hooks.'
    ],
    example: `{ "ci": { "setup": "npm ci" } }`
  },
  {
    key: 'ci.setup',
    type: 'string (optional, min 1)',
    semantics: [
      'A shell command emitted verbatim as an “Adopter CI setup” step in the generated workflows that execute `vinaya check` (`vinaya-checks.yml`, `vinaya-review.yml`, `vinaya-review-verdict.yml` — not the archivist, whose jobs never spawn custom checks). It runs after checkout and `setup-node`, before any `vinaya check` invocation.',
      'Declared, never inferred: vinaya cannot know your package manager or runtime. Declare whatever your custom checks need to spawn — e.g. `npm ci`, or a runtime install plus dependency install chained with `&&`.',
      'When absent, the generated workflows are byte-identical to before this key existed — existing installs see no churn until they both declare the key and run `vinaya upgrade`. The key is read at generation time (`init`/`upgrade`/`doctor`) from the repo-root config; changing it takes effect on the next `vinaya upgrade`, which regenerates the managed workflows.'
    ],
    example: `{
  "ci": {
    "setup": "npm install -g bun && bun install --frozen-lockfile --ignore-scripts"
  }
}`
  },
  {
    key: 'tokens',
    type: 'object (optional)',
    semantics: [
      'Adopter-declared token-usage collection for `vinaya tokens` on a non-Claude-Code host — layer 2 of the token-report obligation. Vinaya ships one collection adapter, for Claude Code, which reads that host’s own session transcript; a host with no such transcript has no route to a real `Tokens:` line without this key.',
      'This is an opt-in collection route, never a capability declaration: `vinaya`’s metering-capability probe stays host-identity-blind — there is no `tokens.metering` key, and this key is read only inside `vinaya tokens`’s own command path, never consulted by the probe `vinaya doctor`/`vinaya upgrade` call.'
    ],
    example: `{ "tokens": { "collect": "node scripts/collect-usage.js" } }`
  },
  {
    key: 'tokens.collect',
    type: 'string (optional, min 1)',
    semantics: [
      'A shell command `vinaya tokens` runs itself (not at generation time, unlike `ci.setup`) whenever declared and `--in`/`--out` are not given. Its stdout must be a JSON object shaped `{"inputTokens":N,"outputTokens":N,"cacheCreationInputTokens":N,"cacheReadInputTokens":N,"model":"…"|null}` — the `TranscriptSummary` seam flattened to JSON.',
      'Declared, never inferred: vinaya cannot know a non-Claude-Code host’s own usage surface (an API response shape, a meter’s CLI, a log format) — same argument as `ci.setup`, applied to usage collection instead of CI preparation.',
      'When absent, `vinaya tokens` falls back to the shipped Claude Code transcript adapter unchanged — this key only adds a second route, never removes the first. When declared, a command that fails to run or whose output cannot be parsed fails loudly rather than silently falling back to the transcript route or emitting zeros.',
      'Read from the repo-root config only, same trust class as `checks`/`principals`/`releaseActor`: a value that decides what command runs on this turn must come from the reviewed, committed per-repo file — a global `~/.vinaya/config.json`’s `tokens` key is stripped at load time with a loud stderr warning, never resolved.'
    ],
    example: `{
  "tokens": {
    "collect": "node scripts/collect-usage.js"
  }
}`
  },
  {
    key: 'blastRadius',
    type: 'object (optional)',
    semantics: [
      '`checkBlastRadiusScope`’s collision-domain declaration surface — the sanctioned "I need one more domain" path. The legacy static `.aeg/packages` file is retired; this is the only way to declare a domain beyond live derivation. Every `packages/*` workspace member is derived live at check time (from `package.json`’s `workspaces`, or `pnpm-workspace.yaml`’s `packages:` list on a pnpm repo), and a built-in default set covers the common cross-cutting paths by presence-check (whichever lockfile exists, `turbo.json`/`biome.json`/`tsconfig.json`, `.github/workflows`, `.husky`) — this key is for anything beyond those two.'
    ],
    example: `{ "blastRadius": { "extraDomains": ["migrations", "packages/generated"] } }`
  },
  {
    key: 'blastRadius.extraDomains',
    type: 'string[] (optional)',
    semantics: [
      'Repo-relative path prefixes treated as additional shared collision domains — a `migrations/` folder, a codegen output directory, anything that couples tasks across package boundaries with no universal naming convention `checkBlastRadiusScope`’s built-in defaults can presence-check.'
    ],
    example: `{ "extraDomains": ["migrations"] }`
  },
  {
    key: 'projects',
    type: 'ProjectEntry[] (optional)',
    semantics: [
      'A config-native home for project metadata, alongside — not instead of — `.vinaya/projects.md` (the project registry). `vinaya init product <name>` appends an entry here at the same time it appends the registry row.',
      "Minimal metadata only: `name` (required, the dedup key — matches the registry row's own `Project` column), `description` (optional), `path` (optional). Display metadata, never load-bearing for enforcement — no gate or resolver reads this key.",
      'Absent entirely for a single-project repo, or for any repo that has never run `init product`. `vinaya doctor` reports (at `info` severity, never an error) when a registry row and a `projects` entry name the same project but only one of the two exists.'
    ],
    example: `{
  "projects": [
    { "name": "mobile", "path": "apps/mobile", "description": "The mobile client" }
  ]
}`
  },
  {
    key: 'proseGates',
    type: 'object (optional)',
    semantics: [
      "De-hardcodes the two prose/vocabulary core checks — `reader-resolvable-prose` and `retired-vocabulary` — behind adopter configuration, so both can run for real in an adopter repo instead of only inside this monorepo's own dev loop. Read fresh on every `vinaya check` run (not at generation time), so an edit takes effect on the very next run with no `vinaya upgrade` needed.",
      "Every field is optional; unset entirely, both checks behave exactly as they did when this key did not exist — this repo's own prior hardcoded doctrine layout.",
      "Both checks are report-only: a finding prints as a `warning`, and the check's own exit code always stays `0` — registering them (or configuring them) can never newly fail an existing install's CI."
    ],
    example: `{
  "proseGates": {
    "doctrineRoot": "governance-docs",
    "readerFacingPrefix": "apps/web/src/app/(site)",
    "readerFacingSuffix": "/page.tsx",
    "legacySlugDir": "governance-docs/tranches/completed"
  }
}`
  },
  {
    key: 'proseGates.doctrineRoot',
    type: 'string (optional, min 1)',
    semantics: [
      'The doctrine directory both checks sweep in full — every `.md` under it counts as "ships" prose. Defaults to `"aeg-root"`, this repo\'s own doctrine root. An adopter who names their installed doctrine tree differently sets this once; both checks read the same value.'
    ],
    example: `{ "doctrineRoot": "governance-docs" }`
  },
  {
    key: 'proseGates.readerFacingPrefix',
    type: 'string (optional, min 1)',
    semantics: [
      "The path prefix of the adopter's reader-facing surface (a public site, docs app, …) that `reader-resolvable-prose` also sweeps. Must be set TOGETHER with `readerFacingSuffix` — either alone is a declared no-op, not a partial sweep, matching this repo's own dormant default (no public site here)."
    ],
    example: `{ "readerFacingPrefix": "apps/web/src/app/(site)" }`
  },
  {
    key: 'proseGates.readerFacingSuffix',
    type: 'string (optional, min 1)',
    semantics: [
      'The filename suffix (e.g. `"/page.tsx"`) that, combined with `readerFacingPrefix`, selects which files under the reader-facing tree actually carry reader-visible prose — sibling files (components, fixtures) are not swept.'
    ],
    example: `{ "readerFacingSuffix": "/page.tsx" }`
  },
  {
    key: 'proseGates.legacySlugDir',
    type: 'string (optional, min 1)',
    semantics: [
      'The archived-tranche directory `reader-resolvable-prose`\'s legacy-slug citation class derives its slug list from (filenames only, never content). Defaults to `"<doctrineRoot>/tranches/completed"`. Absent on disk degrades this class to explicitly dormant, never an error.'
    ],
    example: `{ "legacySlugDir": "governance-docs/tranches/completed" }`
  }
] as const

/**
 * The documented home of `vinaya check --plan --json`'s `schema: 1` shape
 * (`apps/vinaya/cli/src/commands/check.ts`), field by field — not part of
 * `vinaya.config.json` itself, but the config reference's natural companion:
 * this is what reading the resolved config back out looks like.
 */
export type PlanJsonField = {
  key: string
  type: string
  semantics: string[]
}

export const PLAN_JSON_SCHEMA: readonly PlanJsonField[] = [
  {
    key: 'schema',
    type: '1',
    semantics: [
      'The envelope version. Additive evolution only — a field is never removed or retyped under the same version number.'
    ]
  },
  {
    key: 'checks',
    type: 'Record<name, { state, source, env, envAnyOf?, scope }>',
    semantics: [
      'The fully resolved check registry, keyed by name — every core and config entry, after override/additive resolution.'
    ]
  },
  {
    key: 'checks.<name>.state',
    type: `'default' | 'overridden' | 'additive'`,
    semantics: [
      '`default`: shipped with Vinaya, unmodified. `overridden`: a config entry currently claims this (core) id and satisfies its contract. `additive`: a wholly new, namespaced entry.'
    ]
  },
  {
    key: 'checks.<name>.source',
    type: `'core' | 'config'`,
    semantics: ['Where the resolved spec came from — `registry.ts` (`core`) or `vinaya.config.json` (`config`).']
  },
  {
    key: 'checks.<name>.env',
    type: `Record<string, 'passthrough' | 'optional' | 'literal' | 'anyOf'>`,
    semantics: [
      'How each declared env var resolves — never the actual value. A security reviewer auditing the plan needs to see "reads the caller’s real token" vs. "sets a fixed string," never the token or string itself.'
    ]
  },
  {
    key: 'checks.<name>.envAnyOf',
    type: 'Record<string, string[]> (optional)',
    semantics: ['Present only for `anyOf`-labeled env keys — the full member list for that key.']
  },
  {
    key: 'checks.<name>.scope',
    type: `'diff' | 'full'`,
    semantics: ['The resolved check’s scope, echoed from its `CheckSpec`.']
  },
  {
    key: 'roles',
    type: '{ available: true, resolved: Record<name, {...}>, errors: RoleResolverFailure[] } | { available: false, reason: string }',
    semantics: [
      '`available: false` only when no bundled doctrine can be found next to this CLI install (nothing to resolve core roles against) — `reason` names why. Otherwise `available: true`, with the fully resolved role registry.'
    ]
  },
  {
    key: 'roles.resolved.<name>.state',
    type: `'default' | 'overridden' | 'additive'`,
    semantics: [
      '`default`: a core doctrine role, unmodified. `overridden`: a config entry currently claims this (core) role id and satisfies its contract. `additive`: a wholly new, namespaced role.'
    ]
  },
  {
    key: 'roles.resolved.<name>.source',
    type: `'core' | 'config'`,
    semantics: [
      "Where the resolved contract came from — bundled doctrine (`core`) or `vinaya.config.json`'s `roles` (`config`)."
    ]
  },
  {
    key: 'roles.resolved.<name>.rendersAs',
    type: 'string',
    semantics: [
      'The role\'s own `role_id` — the identifier every downstream consumer actually sees. Equal to `<name>` for `default`/`overridden`; the post-"/" segment of `<name>` for `additive` (the registry-id/render-id decoupling that lets `acme/qa-lead` register under that whole key but render as `qa-lead`).'
    ]
  },
  {
    key: 'roles.resolved.<name>.title',
    type: 'string',
    semantics: ["The resolved contract's own `title` frontmatter."]
  },
  {
    key: 'roles.resolved.<name>.gating',
    type: `'core' | 'inert'`,
    semantics: [
      "`core` for every `default`/`overridden` entry — it participates in core enforcement (doctrine's own `ACTIONS.performedBy` wiring). `inert` for every `additive` entry — documentation-only, since no core `ACTIONS` entry can name a render id core doctrine never declared."
    ]
  },
  {
    key: 'roles.errors',
    type: 'RoleResolverFailure[]',
    semantics: [
      "Every role-resolution failure (a malformed `roles` entry, a `role_id` mismatch, a render-id collision, a bare key matching no core role id) — rendered inline, never dropped. Non-empty `roles.errors` makes `--plan`'s own exit code non-zero, same as a non-empty top-level `errors` does for `checks`."
    ]
  },
  {
    key: 'roles.reason',
    type: 'string',
    semantics: ['Present only when `roles.available` is `false` — why no doctrine could be resolved.']
  },
  {
    key: 'errors',
    type: 'ResolverFailure[]',
    semantics: [
      'Every `FAIL_CLOSED` entry (a bare key with no namespace matching no core check) — rendered inline, never dropped. Non-empty `errors` always exits non-zero; `--plan` never swallows a failure to render a clean-looking table.',
      'Non-empty `errors` is also what real execution refuses on: `vinaya check` runs NOTHING while any entry is unresolvable, so a non-empty `errors` here is a preview of a refused run, not an advisory.'
    ]
  }
] as const
