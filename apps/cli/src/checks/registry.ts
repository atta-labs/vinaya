import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { packageRoot } from '../lib/package-root.js'
import type { CheckSpec } from './contract'

// `packageRoot(import.meta.url)` walks up to the nearest `package.json`
// rather than a fixed `../..` — the fixed depth was correct only when
// running unbundled from `src/checks/`; once bundled into a single-file
// `dist/index.js` (what a real `npm install` ships), the depth from the
// bundled file to the package root differs, and a fixed walk landed every
// `BIN_DIR`-derived path one directory short. `BIN_DIR` is still computed
// once at module scope: the package root a check's bin resolves against
// never changes at runtime.
//
// **The published tarball never contains `src/`** — `package.json`'s
// `files` allowlist ships only `dist`, `templates`, `README.md`. Every one
// of these checks was 100% unreachable through a real `npm install`
// (`check --all` errored "not found on PATH" for all 15 — found live
// against the real published `@attalabs/vinaya@0.1.1`, not caught by any
// prior review because verification only ever ran against local source,
// where `src/checks/bin/*.ts` genuinely exists). `scripts/build.ts` now
// bundles each `src/checks/bin/*.ts` to its own standalone, self-contained
// `dist/checks/bin/*.js` (same `Bun.build` shape as the main `dist/index.js`
// entrypoint) — that bundled output is what actually ships. Prefer it when
// present; fall back to the raw `.ts` source so `bun src/index.ts check
// --all` still works for local, unbundled dev without requiring a build
// first.
const DIST_BIN_DIR = join(packageRoot(import.meta.url), 'dist', 'checks', 'bin')
const SRC_BIN_DIR = join(packageRoot(import.meta.url), 'src', 'checks', 'bin')
const BIN_DIR = existsSync(DIST_BIN_DIR) ? DIST_BIN_DIR : SRC_BIN_DIR
const BIN_EXT = BIN_DIR === DIST_BIN_DIR ? '.js' : '.ts'

/** `bin('check-brief-shape')` → the real, resolvable path to that check's executable — bundled `.js` when shipped, raw `.ts` in local dev. */
function bin(name: string): string {
  return join(BIN_DIR, `${name}${BIN_EXT}`)
}

/**
 * Whether `--all` selects this check. A pure predicate over one spec —
 * deliberately not over a spec list, and with no registry/config loading
 * folded in: the two callers assemble their lists differently
 * (`commands/check.ts` filters the resolved list including an adopter's
 * custom checks; `scripts/verify-published-lifecycle.ts` filters
 * `coreCheckRegistry()` alone) and must stay free to.
 *
 * Exported so the shipped selection and the lifecycle script's derived
 * expectation apply the SAME rule. Each once re-derived `!ownWorkflow`
 * inline — a verifier re-implementing its subject's predicate is testing
 * its own copy, and any second condition added to `--all`'s selection
 * would have reached `check.ts` but not the script, which would then
 * report a divergence that was its own (the drift class #28 removed one
 * level up, where the expectation was a hand-maintained count).
 *
 * A check with `ownWorkflow` is withheld because its dedicated workflow
 * already reports it — see `CheckSpec.ownWorkflow` and the `review-gate`
 * entry below for why a second `--all` copy freezes at push-time verdicts.
 */
export function runsUnderAll(spec: CheckSpec): boolean {
  return !spec.ownWorkflow
}

/**
 * `ring` — which of `aeg-root/enforcement.md`'s three ring tables this core
 * check's own row belongs in, when the registry-scaffold writer
 * (`packages/aeg-core/src/registry-scaffold.ts`) needs to auto-insert a stub
 * row for it. Derived mechanically, not by re-reading each check's prose:
 * `0` for every check that runs under the managed local hooks (pre-commit/
 * pre-push's `vinaya check --all --local`) — i.e. everything that is
 * neither `requiresOpenPr` nor `ownWorkflow`, since `--local` skips exactly
 * those two classes (`apps/cli/src/lib/artifacts.ts`'s `preCommitBody`/
 * `prePushBody` comments) and nothing else; `1` for a check that can only
 * ever run once a pull request exists (`requiresOpenPr`) or is reported by
 * its own dedicated workflow instead of `--all` (`ownWorkflow`) — CI/PR-only
 * by construction. No core check is ring-2-only today: every ring-2
 * mechanism in this repo (`archive-task.ts`, `check-direct-main-push.ts`,
 * `dead-branch-audit.ts`, `report-tokens.ts`) is a standalone script, never
 * a `coreCheckRegistry()` entry.
 *
 * Several of these checks are *also* re-run in CI (`vinaya-checks.yml`'s
 * `check --all --diff-only`) even when ring-0 — `enforcement.md` line 114
 * documents this as the normal, accepted shape ("Same checks, same
 * strictness, at ring 0 and ring 1 — the runner is one codebase invoked from
 * both"), not a contradiction: `ring` here names the EARLIEST enforcement
 * point (ring 0 wins when a check is hook-eligible at all), not an
 * exhaustive list of every ring a check happens to also run under.
 *
 * Deliberately NOT a field on `CheckSpec` (or on the objects
 * `coreCheckRegistry()` returns): the shared contract and the adopter config
 * schema stay untouched (Issue #104's core-registry-local decision), and
 * `tests/checks/no-privileged-api.test.ts` already guards that a core
 * `CheckSpec` object carries no field a config-derived one cannot — adding
 * `ring` as a real property on the spec would trip that guard, which is
 * exactly the invariant this task must not break. Paired here as a 2-tuple
 * instead: `REGISTRY`'s element type is `readonly [CheckSpec, 0 | 1 | 2]`, so
 * omitting the ring for a new entry is a tuple-arity type error, not a
 * silent gap — the typechecker forces completeness without the annotation
 * ever reaching the runtime object.
 */
export type CoreCheckRing = 0 | 1 | 2

/**
 * The core AEG gates an adopter's repo actually runs, expressed as ordinary
 * `CheckSpec`s — the exact shape a `vinaya.config.json` entry produces. No
 * extra field, no privileged flag: this IS the no-privileged-API proof, not
 * a stylistic choice. See `tests/checks/no-privileged-api.test.ts`.
 *
 * `reader-resolvable-prose`/`retired-vocabulary` (task 7, Issue #56): both
 * used to be excluded here because they hardcoded this monorepo's own
 * doctrine layout — a scope-registration decision, not a pathing bug. Both
 * bins now read their doctrine root, reader-facing globs, and legacy-slug
 * corpus from `vinaya.config.json`'s `proseGates` key (`lib/config.ts`),
 * defaulting to this repo's own prior hardcoded shape when unset, so an
 * install that sets nothing behaves exactly as before this task. Both are
 * report-only (`aeg-root/enforcement.md`'s G1/G2 precedent) — a `warning`
 * finding, never a failing exit code — so registering them cannot newly
 * fail any existing install's CI.
 *
 * Each entry is paired with its ring in `REGISTRY` below — see
 * `CoreCheckRing`'s doc comment for how the ring is derived and why it is
 * not a field on the spec itself.
 */
const REGISTRY: ReadonlyArray<readonly [CheckSpec, CoreCheckRing]> = [
  [
    {
      name: 'brief-shape',
      run: bin('check-brief-shape'),
      scope: 'diff',
      timeoutMs: 15_000,
      // `process.env.PR_BODY ?? ''` / `process.env.BRANCH ?? ''` — both
      // plain absence-tolerant fall-throughs. Without BRANCH declared here
      // the runner strips it before the child spawns and the non-task/
      // non-brief bypass and requireClosesN gating never fire (#870).
      env: {
        PR_BODY: { optional: true },
        BRANCH: { optional: true }
      }
    },
    0
  ],
  [
    {
      name: 'doc-coverage',
      run: bin('check-doc-coverage'),
      scope: 'diff',
      timeoutMs: 15_000,
      // `resolvePrBody()` falls through to `''` when neither PR_BODY nor
      // PR_BODY_FILE is set — the legitimate ring-0 "no PR exists yet" case.
      // BASE_SHA already defaults via `|| 'origin/main'` in the bin itself.
      // PR_NUMBER absence takes the bin's own "no PR to evaluate the waiver
      // against yet" bypass (`waiverActive()` returns false) — same shape as
      // `review-gate`'s identical PR_NUMBER declaration below. The bin shells
      // to `gh pr view`/`gh api .../timeline` directly to resolve the
      // `vinaya/waiver:docs` label + its labeling actor, so
      // GITHUB_TOKEN/GH_TOKEN must reach it on a CI runner, where `gh`
      // authenticates only from those env vars. GITHUB_REPOSITORY/
      // GITHUB_TOKEN/GH_TOKEN also feed the trust-anchor read
      // (`loadTrustAnchorConfig`, lib/config.ts) — a `gh api` fetch of
      // `principals` from the DEFAULT BRANCH, never local git. All optional:
      // absent, the fetch fails and the allowlist falls back to the hardcoded
      // `PRINCIPAL_ALLOWLIST`, the safe direction.
      env: {
        BASE_SHA: { optional: true },
        PR_BODY: { optional: true },
        PR_BODY_FILE: { optional: true },
        PR_NUMBER: { optional: true },
        GITHUB_REPOSITORY: { optional: true },
        GITHUB_TOKEN: { optional: true },
        GH_TOKEN: { optional: true }
      }
    },
    0
  ],
  [
    {
      name: 'coherence',
      run: bin('check-coherence'),
      scope: 'full',
      timeoutMs: 30_000,
      // `resolveToken()`'s three-tier fallback (GITHUB_TOKEN, then GH_TOKEN,
      // then a `gh auth token` subprocess) means neither var is ever
      // hard-required — the subprocess path is the documented reason zero
      // pre-spawn env coverage is the correct outcome here, not a gap.
      // AEG_REPO/BRANCH each fall back to `git remote`/`git rev-parse`.
      env: {
        AEG_REPO: { optional: true },
        BRANCH: { optional: true },
        GITHUB_TOKEN: { optional: true },
        GH_TOKEN: { optional: true }
      }
    },
    0
  ],
  [
    {
      name: 'dispatch-readiness',
      run: bin('check-dispatch-readiness'),
      scope: 'full',
      timeoutMs: 30_000,
      // Identical `resolveToken()` three-tier fallback to `coherence` above
      // — same reasoning, same declaration.
      env: {
        AEG_REPO: { optional: true },
        BRANCH: { optional: true },
        GITHUB_TOKEN: { optional: true },
        GH_TOKEN: { optional: true }
      }
    },
    0
  ],
  [
    {
      name: 'closes-n',
      run: bin('check-closes-n'),
      scope: 'diff',
      timeoutMs: 15_000,
      // Pre-merge-only: needs the open PR's real body to find `Closes #N`.
      // See `CheckSpec.requiresOpenPr`'s doc comment for why the local hooks
      // skip this rather than running it against nothing.
      requiresOpenPr: true,
      // `process.env.PR_BODY ?? ''`; BRANCH/AEG_REPO both fall back to git
      // (`rev-parse --abbrev-ref HEAD` / `remote get-url origin`). Tokens
      // forwarded because the bin reaches the forge through
      // `createForgeSource` — same as `branch-topology`'s identical
      // declaration above: the runner spawns each check with only a fixed
      // baseline env, so without explicit forwarding this check has no way
      // to auth to GitHub on a CI runner (found live: passed locally under
      // a developer's own `gh auth login`, failed deterministically in CI
      // with "no topology file found" — a misleading message, since the
      // real cause was an unauthenticated forge read, not a missing file).
      env: {
        BRANCH: { optional: true },
        PR_BODY: { optional: true },
        AEG_REPO: { optional: true },
        GITHUB_TOKEN: { optional: true },
        GH_TOKEN: { optional: true }
      }
    },
    // requiresOpenPr: cannot run under the local hook (`--local` skips it) —
    // CI/PR-only, see `CoreCheckRing`'s doc comment.
    1
  ],
  [
    {
      name: 'single-plan-pr',
      run: bin('check-single-plan-pr'),
      scope: 'diff',
      timeoutMs: 15_000,
      // BASE_SHA defaults to `'origin/main'`; PR_NUMBER's absence takes the
      // explicit `? Number(...) : null` branch — both tolerate absence.
      // Tokens forwarded so the bin's `gh pr list` authenticates on CI
      // runners (fail-open to [] without them — silently vacuous there).
      env: {
        BASE_SHA: { optional: true },
        PR_NUMBER: { optional: true },
        GITHUB_TOKEN: { optional: true },
        GH_TOKEN: { optional: true }
      }
    },
    0
  ],
  [
    {
      name: 'test-plan',
      run: bin('check-test-plan'),
      scope: 'diff',
      timeoutMs: 15_000,
      // Pre-merge-only: a `[principal]` Test Plan item is, by construction
      // (`roles/developer.md`), never tickable by the Developer that makes
      // the first commit — only the Principal can satisfy it, after review.
      // See `CheckSpec.requiresOpenPr`'s doc comment.
      requiresOpenPr: true,
      // `process.env.PR_BODY ?? ''` / `process.env.BRANCH ?? ''` — both
      // plain absence-tolerant fall-throughs.
      env: {
        PR_BODY: { optional: true },
        BRANCH: { optional: true }
      }
    },
    // requiresOpenPr — see `closes-n` above.
    1
  ],
  [
    {
      name: 'body-bare-digits',
      run: bin('check-body-bare-digits'),
      scope: 'diff',
      timeoutMs: 15_000,
      // Pre-merge-only: reads the open PR's real body, same reasoning as
      // `closes-n`/`test-plan`/`evidence-fresh` above — nothing to scan
      // before a PR (hence its body) exists.
      requiresOpenPr: true,
      // Reported by the generated `vinaya-body-checks.yml`, a
      // `pull_request_target` job — `check --all` must not evaluate it a
      // second time from `vinaya-checks.yml`'s `pull_request` job: that copy
      // cannot safely resolve the Changesets-release exemption (its
      // PR_NUMBER/BRANCH are PR-editable), same reasoning as `review-gate`'s
      // own `ownWorkflow` entry above.
      ownWorkflow: true,
      // `process.env.PR_BODY ?? ''` — plain absence-tolerant fall-through.
      // PR_NUMBER/GITHUB_TOKEN/GH_TOKEN back the live `gh pr view` fetch the
      // Changesets-release exemption needs (bin's own module comment) —
      // same reasoning as `review-gate`'s entry: on a CI runner `gh`
      // authenticates ONLY from GH_TOKEN/GITHUB_TOKEN, and PR_AUTHOR is
      // deliberately never declared here (registry-env.test.ts's coupling
      // test bans any check bin from reading it from env at all).
      // GITHUB_REPOSITORY addresses the trust-anchor read
      // (`loadTrustAnchorConfig`, lib/config.ts) — a `gh api` fetch of
      // `releaseActor` from the DEFAULT BRANCH, same as `review-gate`'s own
      // entry. Found live (code review, PR #169): omitted here, the runner
      // strips it before the check ever runs, and the trust-anchor read
      // silently falls to its local-dev fallback path on every CI run.
      env: {
        PR_BODY: { optional: true },
        PR_NUMBER: { optional: true },
        GITHUB_REPOSITORY: { optional: true },
        GITHUB_TOKEN: { optional: true },
        GH_TOKEN: { optional: true }
      }
    },
    // requiresOpenPr AND ownWorkflow — CI/PR-only twice over.
    1
  ],
  [
    {
      name: 'no-disk-state',
      run: bin('check-no-disk-state'),
      scope: 'diff',
      timeoutMs: 15_000,
      // BASE_SHA defaults to `'origin/main'`, with a further `main...HEAD`
      // fallback in the bin itself when that yields no files.
      env: { BASE_SHA: { optional: true } }
    },
    0
  ],
  [
    {
      name: 'registry-gates',
      run: bin('check-registry-gates'),
      scope: 'full',
      timeoutMs: 30_000,
      // `resolveRepo()`'s only env read; falls back to `git remote get-url
      // origin` when unset. The bin is otherwise dormant (exit 0) when
      // `aeg-root/enforcement.md` doesn't exist — no other env dependency.
      // Tokens forwarded so its `gh auth status` / `gh issue|pr view`
      // string-form shell-outs authenticate on CI runners (without them
      // `ghReachable()` reports false there and the forge-number
      // resolution degrades, exactly like the execFileSync siblings).
      env: {
        AEG_REPO: { optional: true },
        GITHUB_TOKEN: { optional: true },
        GH_TOKEN: { optional: true }
      }
    },
    0
  ],
  [
    {
      name: 'review-gate',
      run: bin('check-review-gate'),
      scope: 'full',
      timeoutMs: 30_000,
      // Reported by the generated `vinaya-review.yml`, which the verdict
      // workflow re-runs when a verdict comment lands. `check --all` must not
      // evaluate it a second time: nothing re-runs `vinaya-checks.yml`, so
      // that copy freezes at push-time verdicts and stays red after an
      // approval — measured on atta-labs/vinaya#21.
      ownWorkflow: true,
      // PR_NUMBER's absence takes the explicit "no PR to evaluate yet
      // (local dev, pre-push before a PR exists)"
      // bypass documented in the bin's own module comment. The bin shells
      // to `gh` directly (no `resolveToken()`), and on a CI runner `gh`
      // authenticates ONLY from GH_TOKEN/GITHUB_TOKEN — without forwarding
      // them the allowlist strips the workflow-provided token and every
      // `gh pr view` fails. Optional because local runs use `gh`'s own
      // keyring auth with no env var at all. GITHUB_REPOSITORY addresses the
      // trust-anchor read (`loadTrustAnchorConfig`, lib/config.ts) — a `gh
      // api` fetch of `principals` from the DEFAULT BRANCH.
      //
      // Deliberately NO `BASE_SHA` here, and no other ref-shaped knob: a
      // `BASE_SHA` declaration was tried and reverted (security finding, PR
      // #862 round 2) because a `pull_request`-triggered workflow runs the
      // PR's own PR-editable YAML, so any ref this check accepts as an
      // override is attacker-steerable and reopens the self-approval hole.
      // GITHUB_REPOSITORY is not the same thing: it names WHICH repo to ask
      // GitHub about, is runner-set in the only context where this is a trust
      // decision, and never selects a commit — see `trustAnchorRepo`.
      env: {
        PR_NUMBER: { optional: true },
        GITHUB_REPOSITORY: { optional: true },
        GITHUB_TOKEN: { optional: true },
        GH_TOKEN: { optional: true }
      }
    },
    // ownWorkflow — see `body-bare-digits` above.
    1
  ],
  [
    {
      name: 'branch-topology',
      run: bin('check-branch-topology'),
      scope: 'full',
      timeoutMs: 30_000,
      // BRANCH falls back to git; AEG_REPO falls back to `git remote`.
      // Tokens forwarded because the bin reaches the forge through
      // `createForgeSource` → `@attalabs/aeg-forge-state`'s token resolution
      // (GITHUB_TOKEN, then GH_TOKEN, then a `gh auth token` subprocess)
      // — the subprocess tier fails on CI runners, so without forwarding
      // the check cannot reach the forge there. Same reasoning as
      // `coherence`/`dispatch-readiness` above.
      env: {
        BRANCH: { optional: true },
        AEG_REPO: { optional: true },
        GITHUB_TOKEN: { optional: true },
        GH_TOKEN: { optional: true }
      }
    },
    0
  ],
  [
    {
      name: 'dead-branch-push',
      run: bin('check-dead-branch-push'),
      scope: 'full',
      timeoutMs: 30_000,
      // BRANCH falls back to `git rev-parse --abbrev-ref HEAD`; the bin's
      // own module comment documents fail-open (UNKNOWN → allow) for every
      // other forge-reachability gap, unrelated to env absence. Tokens
      // forwarded so `gh pr list` authenticates on CI runners instead of
      // taking that UNKNOWN branch on every run.
      env: {
        BRANCH: { optional: true },
        GITHUB_TOKEN: { optional: true },
        GH_TOKEN: { optional: true }
      }
    },
    0
  ],
  [
    {
      name: 'first-push-dispatch',
      run: bin('check-first-push-dispatch'),
      scope: 'full',
      timeoutMs: 30_000,
      // BRANCH/AEG_REPO fall back to git; GITHUB_TOKEN/GH_TOKEN read as
      // `process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''` inside
      // `classifyReadiness` — absence degrades to an empty token, which
      // `fetchOpenIssuesByLabel` tolerates (fail-open, per the bin's own
      // module comment on forge-reachability failures).
      env: {
        BRANCH: { optional: true },
        AEG_REPO: { optional: true },
        GITHUB_TOKEN: { optional: true },
        GH_TOKEN: { optional: true }
      }
    },
    0
  ],
  [
    {
      name: 'doc-coverage-push',
      run: bin('check-doc-coverage-push'),
      scope: 'diff',
      timeoutMs: 15_000,
      // Same `resolvePrBody()`/BASE_SHA/PR_LABELS/WAIVER_LABEL_ACTOR
      // absence-tolerance as `doc-coverage` above, plus OVERRIDE_DOCS
      // (`overrideActive()`'s first, env-only check) which is opt-in by
      // design — absence is the default, unremarkable path.
      // GITHUB_REPOSITORY/GITHUB_TOKEN/GH_TOKEN: same trust-anchor read as
      // `doc-coverage` above — see that entry's comment.
      env: {
        OVERRIDE_DOCS: { optional: true },
        BASE_SHA: { optional: true },
        PR_BODY: { optional: true },
        PR_BODY_FILE: { optional: true },
        PR_LABELS: { optional: true },
        WAIVER_LABEL_ACTOR: { optional: true },
        GITHUB_REPOSITORY: { optional: true },
        GITHUB_TOKEN: { optional: true },
        GH_TOKEN: { optional: true }
      }
    },
    0
  ],
  [
    {
      name: 'issue-assignment',
      run: bin('check-issue-assignment'),
      scope: 'full',
      timeoutMs: 30_000,
      // AEG_REPO/BRANCH both fall back to git. Every other fact this bin
      // needs (remote-ref existence, assignees, the authenticated login)
      // comes from `gh` subprocess calls gated behind `parsed &&
      // !remoteRefExists`, never a raw env read — tokens forwarded so
      // those calls authenticate on CI runners instead of null-skipping.
      env: {
        AEG_REPO: { optional: true },
        BRANCH: { optional: true },
        GITHUB_TOKEN: { optional: true },
        GH_TOKEN: { optional: true }
      }
    },
    0
  ],
  [
    {
      name: 'evidence-fresh',
      run: bin('check-evidence-fresh'),
      scope: 'diff',
      timeoutMs: 15_000,
      // Pre-merge-only: meaningless before a PR exists to resolve a real
      // head against. Same reasoning as `closes-n`/`test-plan` above.
      requiresOpenPr: true,
      // The bin shells to `gh pr view --json headRefOid` to resolve the real
      // PR head (never `HEAD`, which is the merge commit in CI — see the
      // bin's own module comment), so GITHUB_TOKEN/GH_TOKEN must reach it on
      // a CI runner. PR_NUMBER/PR_BODY absence both take documented
      // ring-0/no-PR bypasses in the bin. BASE_SHA overrides the
      // `origin/main`/`main` merge-base resolution — same declaration as
      // `doc-coverage`/`doc-coverage-push`/`no-disk-state`/`single-plan-pr`
      // above (`closes-n` declares no BASE_SHA and resolves no merge-base) —
      // for a repo whose default branch resolves as neither.
      env: {
        PR_NUMBER: { optional: true },
        PR_BODY: { optional: true },
        BASE_SHA: { optional: true },
        GITHUB_TOKEN: { optional: true },
        GH_TOKEN: { optional: true }
      }
    },
    // requiresOpenPr — see `closes-n` above.
    1
  ],
  [
    {
      name: 'reader-resolvable-prose',
      run: bin('check-reader-resolvable-prose'),
      scope: 'full',
      timeoutMs: 30_000,
      // Deliberately empty, not omitted: audited (task 7) and confirmed to
      // need none — reads only local files (`vinaya.config.json`'s
      // `proseGates` key via `loadConfig()`, plus the doctrine/reader-facing
      // trees it names), no forge call, no PR content.
      env: {}
    },
    0
  ],
  [
    {
      name: 'retired-vocabulary',
      run: bin('check-retired-vocabulary'),
      scope: 'full',
      timeoutMs: 30_000,
      // Same reasoning as `reader-resolvable-prose` above — local files only.
      env: {}
    },
    0
  ],
  [
    {
      name: 'doctrine-portability',
      run: bin('check-doctrine-portability'),
      scope: 'full',
      timeoutMs: 30_000,
      // Local-only: `git ls-tree`/`git show` read the already-fetched local
      // repository, never the network — no forge call, no PR content.
      // BASE_SHA overrides the `origin/main` baseline ref, same declaration
      // as `doc-coverage`/`no-disk-state`/`evidence-fresh` above.
      env: { BASE_SHA: { optional: true } }
    },
    0
  ],
  [
    {
      name: 'workspace-escape',
      run: bin('check-workspace-escape'),
      scope: 'full',
      timeoutMs: 30_000,
      // Local-only: walks the working tree with `node:fs`, never the
      // network, `gh`, or a PR-scoped fact — no forge call, no PR content.
      env: {}
    },
    0
  ]
]

/** The exact `CheckSpec[]` shape `vinaya.config.json` also produces — no
 * extra field, no privileged flag. See `no-privileged-api.test.ts`. */
export function coreCheckRegistry(): CheckSpec[] {
  return REGISTRY.map(([spec]) => spec)
}

/** `name` -> `ring`, derived from the same `REGISTRY` pairing `coreCheckRegistry()`
 * reads — never out of sync with it by construction. Consulted by
 * `packages/aeg-core/src/registry-scaffold.ts` indirectly, through the
 * aeg-core-local mirror in `gate-audience.ts` (aeg-core cannot import this
 * module — see that file's own doc comment for why); `gate-audience.test.ts`-
 * style coupling assertions in this package keep the two in sync. */
export const CORE_CHECK_RING: Readonly<Record<string, CoreCheckRing>> = Object.fromEntries(
  REGISTRY.map(([spec, ring]) => [spec.name, ring])
)
