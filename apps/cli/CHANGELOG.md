# @attalabs/vinaya

## 0.8.1

### Patch Changes

- 30dc300: Recognize a hand-closed dependency Issue as valid when it was closed directly by a recognized Principal identity (verified via GitHub's own `ClosedEvent` actor, not claimed in prose), instead of only accepting a merged closing PR. `dispatch-gate` and `coherence` check A1 both gain this second, narrower recognition path — the default merged-PR path is unchanged.

## 0.8.0

### Minor Changes

- 9cfa0c7: Recover the `vinaya studio` command the extraction dropped.
  
  Four files (`commands/studio.ts`, `lib/studio-bundle.ts`, `scripts/bundle-studio.ts`, `tests/studio.test.ts`) lived at `apps/vinaya/cli/**` in the attalabs monorepo. The extraction moved the CLI to this repository without them, and attalabs then deleted the directory they were in — the command survived only in that repo's history, absent from both repos, the router, and the published tarball, with no gate noticing.
  
  They are recovered here against the two-repo reality: Studio's source (`apps/vinaya/web`) stayed in attalabs, so the workspace branch of `resolveStudioTarget` serves only checkouts that carry that tree, and no published build bundles the standalone Studio app. Rather than fixing import paths and shipping a command that resolves nothing, the recovered command refuses explicitly (exit 1, message naming the package) in every shape it cannot yet serve. `bundle-studio.ts` is recovered as pack-shape knowledge but deliberately not wired into `prepack` or the `files` allowlist — producing and shipping the bundle is the separate Studio-packaging task, so the published artifact's contents are unchanged.
  
  `@atta/vinaya-sources` gains the matching `studio` row in the `COMMANDS` registry, with an honest description of what the command does and does not yet do; `verify-published-lifecycle.ts` exercises the refusal for real against the packed artifact.

## 0.7.1

## 0.7.0

### Minor Changes

- a0d413a: Adopter-declared CI setup: a new optional `ci.setup` key in `vinaya.config.json`, emitted verbatim as an "Adopter CI setup" step in the generated workflows that execute `vinaya check` (checks, review, review-verdict — never the archivist, whose jobs spawn no adopter code).
  
  The generated jobs previously installed node and nothing else — correct for vinaya's own checks, which arrive whole via `npx`, and fatal for an adopter's custom checks, which are scripts in the adopter's own repository that may import the adopter's own code. Measured on the first non-greenfield adopter: both of its custom checks failed as `error (2ms)` spawn failures on every CI run while passing in the local hooks, turning a required check permanently red.
  
  The command is declared in the committed config, never inferred — vinaya cannot know an adopter's package manager or runtime. When the key is absent, the generated workflows are byte-identical to before it existed, so existing installs see no churn. Note for repos that do declare it: the generated workflows are managed artifacts, so the next `vinaya upgrade` after declaring the key rewrites their bytes — that is the intended delivery path, not drift.
  
  `@atta/vinaya-sources` gains the matching `ci` / `ci.setup` rows in the adopter-facing config reference.

## 0.6.0

### Minor Changes

- 7d074ac: Add `vinaya doctrine` — prints the absolute path of the bundled doctrine's front door (`aeg-root/skills/aeg/SKILL.md`), resolved at read time on the caller's own machine (`--json` for the enveloped `{ root, entry }` form) — and make the committed `VINAYA.md` doctrine pointer machine-independent: it now names the `@attalabs/vinaya` package and hands the reader that command, instead of interpolating the installing machine's absolute install path into committed content. The old shape broke for every clone but the installer's (and for the installer on their next upgrade, since npx's cache key rotates with the version), published the installing user's home directory into the repo, and made `doctor` report drift on every machine except the one that ran `init`. Existing adopters see one-time managed-file drift on `VINAYA.md` at their next `doctor`, and a rewrite on their next `upgrade` — the drift being reported is the machine-local path this release removes.
- edd7c17: Ring 0 now survives a clone (atta-labs/attalabs#927). Non-husky installs write git hooks into a TRACKED `.vinaya/hooks/` directory routed via `git config core.hooksPath .vinaya/hooks` instead of the unversioned `.git/hooks` — hook files travel with the repo into every clone and every linked worktree checkout, where before a fresh clone silently had zero ring-0 enforcement while the manifest still claimed the hooks existed.
  
  What changes for adopters:
  
  - **New installs** (`vinaya init`, no husky, no active raw `.git/hooks` hooks): hooks land in `.vinaya/hooks/` (commit them) and the installing clone is armed automatically. Each FRESH clone runs `git config core.hooksPath .vinaya/hooks` once — the one thing git cannot version. `vinaya doctor` reports an unarmed clone as an error and names that exact command; `vinaya upgrade` also arms it.
  - **Existing `.git/hooks` installs**: the next `vinaya upgrade` migrates — tracked copies land first, legacy hosts are stripped, the config is armed, and the manifest's hook paths are rewritten. The migration REFUSES (and says why, and `doctor` keeps warning) whenever arming would silently disable hooks vinaya does not own: adopter lines in a hook host, or any unmanaged active raw hook in `.git/hooks`.
  - **Husky installs**: unchanged.
  - **`vinaya eject`**: also unsets `core.hooksPath` when it still points at vinaya's own tracked dir.
  - The managed-manifest version bumps 1 → 2 (shape unchanged) so an older package meeting a migrated manifest refuses loudly instead of half-understanding the recorded hook locations.

### Patch Changes

- 562408b: Name the failing check on the run's Summary page of the generated Vinaya Checks workflow.
  
  The workflow's one aggregate check reports only "vinaya check --all --diff-only: failing" — it never says which of the registered checks failed, forcing a trip into the raw log. The generated job now tees the runner's per-check stdout (the `✓/·/✗ name: status` lines plus each finding's message) into a file, and a follow-up step appends it, fenced, to `$GITHUB_STEP_SUMMARY`.
  
  Two guards are load-bearing: `set -o pipefail` before the tee, because the job's default shell is `bash -e` without pipefail and an unguarded pipe would report a red suite green; and the summary step runs on `!cancelled()` rather than `always()`, because the concurrency group cancels superseded runs routinely and their half-captured output is noise. Both the published (`npx`) and vendored (`node <bin>`) shapes get the same capture.
- e3379ee: Correct `aeg-root/enforcement.md`'s ring-table implementation pointers to the mechanisms that actually run in a vinaya-governed repo — the managed `.git/hooks/pre-commit`/`pre-push` blocks, the validated `vinaya issue|pr` forge-write commands, the required review-gate check, and the `vinaya-*.yml` workflows — instead of the attalabs-only `.husky/*`, `.claude/hooks/*`, and `forge-lifecycle.yml` paths, which do not exist in an adopter repo (measured live by the `registry-gates` G1 check during the first tranche cut natively in atta-labs/vinaya). `aeg-root/` ships in the published tarball, so the stale pointers were the account every adopter got.
  
  Also records, in `apps/cli/specs/self-hosting.md` (unpublished), what that first forge-native walk measured: the authoring-time vs CI brief-shape divergence, the file-topology phrasing still present in some refusal text and baselines, and the Planner-surface gap (no CLI path for Milestone or tranche-label creation).
- 9fde689: Fix `vinaya upgrade` crashing (`ENOTDIR`) when run from inside a linked git worktree (atta-labs/attalabs#942) — it now resolves git-hook paths through `git rev-parse --git-common-dir`, the same fix `vinaya doctor` already had, lifted into a shared resolver both (and `init`, `quickstart`, `demo break`) now call.
  
  Every AEG-style adopter that develops in linked worktrees hit this: a worktree's `.git` is a gitlink file, not a directory, so the old `join(repoRoot, '.git/hooks/…')` tried to `mkdir` under a file and aborted the whole upgrade before any other managed artifact (e.g. the doctrine pointer) was written. Hooks are never actually per-worktree — every linked worktree shares the primary checkout's hooks directory — so the fix resolves the real shared path instead of guessing wrong and crashing.

## 0.5.0

### Minor Changes

- d4a12db: Remove the `vinaya studio` command and its bundled Studio assets from the published CLI.
  
  `studio` was a documented command in the README's command table. An adopter
  running it after upgrading now gets an unknown command — that is a breaking
  change for anyone using it, not an internal cleanup. The published tarball
  also shrinks from ~85.7 MB to ~743 kB as a direct result. Bumped `minor`
  rather than `patch`: pre-1.0 semver convention treats `minor` as the
  breaking-change slot, and a silent `patch` would misrepresent the removal's
  impact.
  
  Also bundled in this release, since none of it has been published yet:
  
  - Fix: resolve the vendored CLI correctly in generated git hooks
  - Fix: address code-review findings from the Studio-removal PR
  - Fix: make the reader-facing no-op sentinel structurally safe
  - Feat: add Changesets with a fixed-group cascade (the mechanism that
    produced this release)
