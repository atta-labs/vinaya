// The install manifest, made concrete.
//
// Every artifact `vinaya init` writes into an adopter repo lives here as
// content + a typed `Op` (see lib/ops.ts). Naming and collision rules follow
// Issue #384's 2026-07-23 MINIMAL-MANIFEST re-ruling: **init installs only
// what a shipped check or ring-2 mechanism consumes.** The manifest is
// exactly six items — `vinaya.config.json` (starter ruleset, `checks: {}`
// empty), three `vinaya-` workflows (checks, review, and — since #761 —
// the archivist's ring-2 post-merge/scheduled jobs), git-hook managed
// blocks, a root `VINAYA.md` doctrine pointer (reading-order convention),
// an empty `.vinaya/doc-owners` starter manifest (#665), and labels.
// Everything else the earlier amendment-4 manifest carried (GitHub
// templates, the governance/ scaffold, example check scripts) was this
// monorepo's own operational apparatus, not product surface — no shipped
// check consumes it, so it is cut from the installer.
//
// The starter ruleset seeded into `vinaya.config.json` is EXTRACTED from this
// repo's own battle-tested gates, not invented blanks — the failure it
// kills is blank-config paralysis.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOC_OWNERS_PATH, LABELS, type LabelKey, VERDICT_MARKER_SOURCE, WAIVER_LABEL_REVIEW } from '@attalabs/aeg-core'
import { resolveDoctrineRoot } from '../commands/doctrine.js'
import type { AgentVendor } from './agent-vendors.js'
import { buildAgentsSkillsOps } from './agents-skills-emitter.js'
import { buildClaudeCommandOps } from './claude-command-emitter.js'
import { buildClaudeStopHookOps } from './claude-stop-hook-emitter.js'
import type { VinayaConfig } from './config.js'
import { buildGeminiCommandOp } from './gemini-command-emitter.js'
import type { CreateLabelOp, Op } from './ops.js'
import { packageRoot } from './package-root.js'
import type { VendoredVinaya } from './self-host.js'

/**
 * The tracked hook directory — the default install target since
 * atta-labs/attalabs#927. Unlike `.git/hooks` (which git never versions, so a
 * fresh clone silently has NO ring-0 enforcement), files here are committed
 * and travel with the repo; `core.hooksPath` (relative, shared config) routes
 * git at them in the primary checkout and every linked worktree alike. The
 * irreducible per-clone residue is one `git config core.hooksPath
 * .vinaya/hooks` — `doctor` reports it whenever it is missing.
 */
export const TRACKED_HOOK_DIR = '.vinaya/hooks'

export type HookDir = '.husky' | '.git/hooks' | typeof TRACKED_HOOK_DIR

export type InitContext = {
  owner: string
  repo: string
  /** where the git-hook stubs are installed (husky if present, else raw) */
  hookDir: HookDir
  /**
   * The workspace member declaring `@attalabs/vinaya`, when the repo being
   * written into vendors the CLI itself (atta-labs/attalabs#929) — `null` for the ordinary
   * adopter, which is everyone else. Callers get it from
   * `detectVendoredVinaya(repoRoot)`; see lib/self-host.ts for why the
   * published `npx` invocation cannot work in such a repo.
   */
  selfHost: VendoredVinaya | null
  /**
   * The adopter-declared CI preparation command (`vinaya.config.json`'s
   * `ci.setup`), or `null` when undeclared. Callers get it from
   * `readRepoCiSetup(repoRoot)` (lib/config.ts). Emitted as a step in the
   * generated workflows that execute `vinaya check`; `null` produces
   * byte-identical output to before the key existed.
   */
  ciSetup: string | null
  /**
   * The `--agents` vendor selection (task 5, #152) — which of the three
   * agent-native emitters (`.agents/skills/`, `.claude/commands/`,
   * `.gemini/commands/`; tasks 2/3/4) `buildInitOps` includes. `vinaya init`
   * computes this from its own `--agents` flag (default: all three);
   * `upgrade`/`doctor` read it back from the persisted `managed.agents`
   * manifest key (`resolveAgentVendors`, lib/config.ts) rather than
   * re-deriving a default, so a narrowed selection is never silently widened
   * or dropped on a later flagless run.
   */
  agents: Set<AgentVendor>
}

// --- neutral scaffold paths (never aeg-root / aeg-project) ------------------
export const CONFIG_PATH = 'vinaya.config.json'
// Root VINAYA.md — the doctrine pointer. Root placement is the whole point
// (reading-order convention): an agent orienting in a fresh repo finds it
// beside README, not buried inside a governance/ subfolder.
export const DOCTRINE_POINTER_PATH = 'VINAYA.md'
export const CHECKS_WORKFLOW_PATH = '.github/workflows/vinaya-checks.yml'
export const REVIEW_WORKFLOW_PATH = '.github/workflows/vinaya-review.yml'
export const REVIEW_RETRIGGER_WORKFLOW_PATH = '.github/workflows/vinaya-review-retrigger.yml'
export const REVIEW_VERDICT_WORKFLOW_PATH = '.github/workflows/vinaya-review-verdict.yml'
export const ARCHIVIST_WORKFLOW_PATH = '.github/workflows/vinaya-archivist.yml'
export const BODY_CHECKS_WORKFLOW_PATH = '.github/workflows/vinaya-body-checks.yml'
// Empty scaffold folders (task 8, #42) — `vinaya new noop-check` writes into
// `vinaya/checks/`, `vinaya new role` writes into `vinaya/roles/`. Git does
// not track empty directories, so each folder is represented by one
// placeholder file — the existing whole-file manifest grammar already
// covers this exactly (no new `Op` kind needed), and `eject` reverses it
// the same way it reverses every other file `init` owns.
export const CHECKS_FOLDER_PLACEHOLDER_PATH = 'vinaya/checks/.gitkeep'
export const ROLES_FOLDER_PLACEHOLDER_PATH = 'vinaya/roles/.gitkeep'

const MANAGED_NOTE =
  'Managed by Vinaya — created by `vinaya init`. `vinaya upgrade` regenerates it; `vinaya eject` removes it.'

function scaffoldFolderPlaceholder(folder: string, command: string): string {
  return `# ${MANAGED_NOTE}
#
# Empty on purpose — \`${command}\` scaffolds into this folder. Git does not
# track empty directories; this placeholder keeps ${folder} present (and
# \`eject\`-reversible) until you've scaffolded something into it.
`
}

// ---------------------------------------------------------------------------
// Starter ruleset — the seed for vinaya.config.json (no `managed`; the
// installer injects the ownership manifest after applying every op).
// ---------------------------------------------------------------------------
export function starterConfig(): VinayaConfig {
  return {
    // Ring 1 (forge-write interception) and Ring 2 (async audits) are opt-in
    // accelerators, off by default. Ring 0 (git hooks) and the CI
    // guarantee are non-negotiable and deliberately absent from the schema.
    rings: { ring1_forgeWriteInterception: false, ring2_asyncAudits: false },
    // `checks` starts EMPTY (2026-07-23 minimal-manifest re-ruling). init
    // ships no example checks and no example scripts: a starter config that
    // registered example `checks` was the only thing those scripts backed, and
    // init installs only what a shipped check consumes. `vinaya new check` is
    // the add-path for an adopter's first custom check.
    checks: {},
    // Brief-schema defaults extracted from this repo's real PR/Issue gates: a
    // PR body must carry Tier, a tagged Test Plan, and a Closes #N; a task
    // Issue must carry the Planner rationale.
    briefSchema: {
      pr: {
        sections: [
          { builtin: 'tier' },
          { builtin: 'testPlan' },
          { builtin: 'testPlanExclusivity' },
          { builtin: 'closesN' },
          { builtin: 'project' }
        ]
      },
      issue: {
        sections: [{ builtin: 'issueRationale' }, { builtin: 'project' }]
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The version both command emitters pin to — ONE source, shared by the four
// workflows via `vinayaRun` and the two git hooks via `hookRun`. There is
// deliberately no second source for a generated artifact's pin: the two
// surfaces drifting apart is the defect atta-labs/vinaya#86 fixed (the hooks
// pinned, the workflows did not). `doctor.ts` and `quickstart.ts` read the
// same `package.json` for display, but neither feeds a generated artifact, so
// neither can cause that drift — nor can `index.ts`'s own `readVersion()`,
// the third such display reader. The root `VINAYA.md` doctrine pointer
// (`doctrinePointer`) is deliberately left unpinned — it is a reading-order
// hint a human runs by hand, not a CI invocation.
//
// Why exact, and never bare or `@latest`:
//
//   - **Bare is not "latest" — and which way it resolves depends on the
//     adopter.** Where the generated `vinaya-checks.yml` carries an install
//     step — which it does only when the adopter declares `ci.setup` — a
//     devDependency copy of `@attalabs/vinaya` puts `node_modules/.bin/vinaya`
//     on disk and npx prefers it over the registry. Measured 2026-08-17 in
//     atta-labs/attalabs, which declares `ci.setup`: the same bare command
//     resolved 0.8.2 inside that repo and 0.9.0 in /tmp. There, CI's version
//     was an accident of a devDependency no workflow referenced — change or
//     drop it and CI jumps to registry latest with no commit and no diff.
//     An adopter that declares no `ci.setup` gets no install step at all
//     (`adopterSetupStep` returns `''`), so for them a bare spec resolved
//     registry latest in all four workflows, not only the archivist.
//   - **The archivist workflow resolves the other way, and is the sharp end.**
//     It emits no install step (its jobs spawn no adopter code), so an
//     unpinned spec there really did mean registry latest — in three jobs
//     that all hold `issues: write` (two of them `pull-requests: write`, one
//     `pull-requests: read`), covering between them every push to main
//     and nightly. A compromised publish of this package would have run with
//     that token in every adopter, unreviewed. (Origin of #86: a security
//     review of atta-labs/attalabs#944.)
//   - **`@latest` is a different product decision** (deliberately floating CI)
//     and is not what the hooks do.
//   - For the hooks the pin is additionally load-bearing on npx's cache key —
//     see the git-hook section below.
//
// The cost is the same one the hooks already pay and `upgrade` already exists
// to settle: the pinned bytes go stale when the CLI is bumped, `doctor` reports
// that as drift, and `vinaya upgrade` re-pins.
// ---------------------------------------------------------------------------
/** This installed package's own version — the hooks and the workflows pin to it. */
function ownVersion(): string {
  const pkg = JSON.parse(readFileSync(join(packageRoot(import.meta.url), 'package.json'), 'utf-8')) as {
    version: string
  }
  return pkg.version
}

// ---------------------------------------------------------------------------
// Workflow files (four, all refuse-if-foreign, all vinaya-prefixed)
//
// How the CI jobs reach the vinaya binary has TWO shapes, chosen at generation
// time from `ctx.selfHost` (atta-labs/attalabs#929):
//
//   - ordinary adopter (`selfHost: null`) — `npx --yes
//     @attalabs/vinaya@<exact-installed-version>`, no build step. An adopter
//     has no local copy to build and must not pay for a problem they do not
//     have, so the shape stays npx; the version spec is exact for the reason
//     in `ownVersion()` above.
//   - repo that vendors the CLI — build the workspace member and invoke the
//     built file by path. NEVER `npx` here: npx is the thing that misresolves
//     (it matches on the package NAME against the workspace before reading any
//     version spec, then execs an unbuilt `bin`). See lib/self-host.ts.
//
// Generation-time selection, not a runtime branch inside the YAML, because the
// generator already holds the repo root at every call site and `doctor`'s drift
// comparison regenerates the same bytes for the same repo — and because logic
// living in YAML is logic the unit tests cannot execute.
// ---------------------------------------------------------------------------

/**
 * `oven-sh/setup-bun` pinned by commit rather than by its `v2` tag. Emitted
 * only in the vendored shape; the ordinary adopter's workflows contain no
 * third-party action at all.
 */
export const SETUP_BUN_SHA = '0c5077e51419868618aeaa5fe8019c62421857d6'

/**
 * The workflow artifact name the `pull_request` build (this repo's own
 * `ci.yml`) uploads once and `vinaya-checks.yml` downloads — never a
 * `pull_request_target` workflow, which builds its own trusted copy and must
 * never download an artifact a pull request's own run produced (O2's trust
 * boundary; see `apps/cli/specs/self-hosting.md`).
 */
export const CLI_DIST_ARTIFACT_NAME = 'vinaya-cli-dist'

/**
 * Restores Bun's install cache — keyed on whichever lockfile the repo
 * actually has, text `bun.lock` or the legacy binary `bun.lockb`;
 * `hashFiles` silently ignores whichever one is absent — before a
 * `bun install --frozen-lockfile`. Caches only the download cache, never the
 * built `dist` (the build itself costs seconds and must never be trusted
 * across a trust boundary — see O2 below); a second workflow installing
 * against the same lockfile on the same commit then installs nothing it
 * doesn't already have. Emitted once, right after `setup-bun`, everywhere
 * this generator itself emits a `bun install --frozen-lockfile` line.
 */
function bunInstallCacheStep(): string {
  return `      - name: Restore Bun install cache
        uses: actions/cache@v4
        with:
          path: ~/.bun/install/cache
          key: bun-\${{ runner.os }}-\${{ hashFiles('bun.lock', 'bun.lockb') }}
          restore-keys: |
            bun-\${{ runner.os }}-
`
}

/**
 * The steps that make the vinaya binary available, emitted directly after
 * `setup-node` at 6-space step indentation. Empty for the ordinary adopter —
 * `npx` needs no preparation.
 */
type WorkflowSourceTrust = 'pull-request' | 'trusted' | 'shared-build'

function vinayaSetupSteps(selfHost: VendoredVinaya | null, sourceTrust: WorkflowSourceTrust = 'pull-request'): string {
  if (!selfHost) return ''
  if (sourceTrust === 'trusted') {
    return `      # Pinned to a commit, not the mutable \`v2\` tag. A repoint of
      # \`v2\` would execute new upstream code in every adopter on the next run,
      # with no diff anywhere to review. Resolved from the \`v2\` tag on
      # 2026-08-14. Bun's own version still comes from the repo's
      # \`packageManager\` field, not from this pin.
      - uses: oven-sh/setup-bun@${SETUP_BUN_SHA}
${bunInstallCacheStep()}      # This repo declares the \`@attalabs/vinaya\` workspace package itself, so
      # \`npx @attalabs/vinaya\` resolves to that local member instead of the
      # registry and dies on its unbuilt \`bin\`. Build and run the trusted
      # default-branch copy directly.
      #
      # This workflow executes only a trusted checkout selected by its event:
      # never the pull request head or merge ref. The review-authority decision
      # therefore comes from code the pull request cannot alter. \`--ignore-scripts\`
      # remains defense in depth against lifecycle hooks in that trusted tree.
      - name: Build the trusted Vinaya CLI
        run: |
          bun install --frozen-lockfile --ignore-scripts
          bun run --cwd ${selfHost.dir} build
`
  }
  if (sourceTrust === 'shared-build') {
    // Never builds its own copy — O2's boundary is that a `pull_request`
    // workflow builds the CLI exactly once (this repo's own `ci.yml`) and a
    // sibling `pull_request` workflow downloads it. Both run at the same
    // trust level (untrusted PR content), so sharing here crosses no
    // boundary; a `pull_request_target` workflow must NEVER take this branch
    // (see `reviewWorkflow`/`bodyChecksWorkflow`/`archivistWorkflow`, all of
    // which stay on `'trusted'` and build their own copy).
    //
    // Still installs — only the BUILD is shared, not the install. The
    // downloaded \`dist/index.js\` imports its external (unbundled) deps —
    // \`gray-matter\`, \`zod\` — from \`node_modules\` at require time (found
    // live: skipping install here entirely crashed every run with
    // \`ERR_MODULE_NOT_FOUND: Cannot find package 'gray-matter'\`, since no
    // step in this branch had ever populated \`node_modules\`). O1's cache
    // step still makes this install cheap; what O2 removes is only the
    // \`bun run --cwd \${selfHost.dir} build\` this job used to also pay for.
    return `      - uses: oven-sh/setup-bun@${SETUP_BUN_SHA}
${bunInstallCacheStep()}      - name: Install dependencies (dist is downloaded below, never built here)
        run: bun install --frozen-lockfile --ignore-scripts
      - name: Find the shared CLI build for this commit
        id: shared-build
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          set -o pipefail
          SHA="\${{ github.event.pull_request.head.sha }}"
          for i in $(seq 1 20); do
            RUN_ID=$(gh api --paginate \\
              "repos/\${{ github.repository }}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=$SHA&per_page=100" \\
              | jq -sr '[.[].workflow_runs[]] | sort_by(.created_at) | last | .id // empty')
            if [ -n "$RUN_ID" ]; then
              HAS_ARTIFACT=$(gh api "repos/\${{ github.repository }}/actions/runs/$RUN_ID/artifacts" \\
                --jq '[.artifacts[] | select(.name == "${CLI_DIST_ARTIFACT_NAME}")] | length > 0')
              if [ "$HAS_ARTIFACT" = "true" ]; then
                echo "run_id=$RUN_ID" >> "$GITHUB_OUTPUT"
                exit 0
              fi
            fi
            sleep 15
          done
          echo "No CI (ci.yml) run for $SHA produced the shared ${CLI_DIST_ARTIFACT_NAME} build after waiting - failing rather than building an unshared copy." >&2
          exit 1
      - name: Download the shared CLI build
        uses: actions/download-artifact@v4
        with:
          name: ${CLI_DIST_ARTIFACT_NAME}
          path: ${selfHost.dir}/dist
          github-token: \${{ secrets.GITHUB_TOKEN }}
          run-id: \${{ steps.shared-build.outputs.run_id }}
      # \`upload-artifact\`/\`download-artifact\` round-trip through a zip and
      # do not reliably preserve the executable bit \`scripts/build.ts\` sets
      # on every emitted entrypoint (found live: every check spawned
      # directly from \`dist/checks/bin/*.js\` — not via \`node\` — failed
      # \`EACCES\` after download). Restored here rather than skipped upstream:
      # the upload side has no reason to know which bits its own consumer
      # will need preserved.
      - name: Restore executable bits lost in the artifact round-trip
        run: chmod -R +x ${selfHost.dir}/dist
`
  }
  return `      # Pinned to a commit, not the mutable \`v2\` tag. This is the first
      # THIRD-PARTY action this generator writes into an adopter's repository,
      # and it runs in the same job that then builds and executes pull-request
      # code. A repoint of \`v2\` would execute new upstream code in every
      # adopter on the next run, with no diff anywhere to review.
      # Resolved from the \`v2\` tag on 2026-08-14. Bun's own version still
      # comes from the repo's \`packageManager\` field, not from this pin.
      - uses: oven-sh/setup-bun@${SETUP_BUN_SHA}
${bunInstallCacheStep()}      # This repo declares the \`@attalabs/vinaya\` workspace package itself, so
      # \`npx @attalabs/vinaya\` resolves to that local member instead of the
      # registry and dies on its unbuilt \`bin\`. Build and run this repo's own
      # CLI — which also makes CI exercise the code in the pull request rather
      # than a published copy predating it.
      #
      # \`--ignore-scripts\` blocks the PR-controlled surface, which is not
      # the obvious one: bun already declines an untrusted DEPENDENCY's
      # postinstall (measured, 1.2.14). What this stops is the repo's own
      # root and workspace lifecycle scripts, plus anything the pull request
      # adds to \`trustedDependencies\` — all of it editable in the same PR
      # this job is checking. The build needs the packages, not the hooks.
      - name: Build the vendored Vinaya CLI
        run: |
          bun install --frozen-lockfile --ignore-scripts
          bun run --cwd ${selfHost.dir} build
`
}

/**
 * The command that runs a vinaya subcommand, in whichever shape applies. The
 * published shape pins the exact installed version — same source and same
 * reasoning as `hookRun`'s published shape; see `ownVersion()`.
 */
function vinayaRun(selfHost: VendoredVinaya | null, args: string): string {
  return selfHost ? `node ${selfHost.bin} ${args}` : `npx --yes @attalabs/vinaya@${ownVersion()} ${args}`
}

/**
 * The adopter-declared CI preparation step (`vinaya.config.json`'s
 * `ci.setup`), emitted only in the workflows that execute `vinaya check` —
 * the one place a generated job can spawn the ADOPTER'S OWN check scripts.
 *
 * Vinaya's own checks arrive whole via `npx`, which is why the ordinary
 * adopter's shape needs no preparation FOR VINAYA. The adopter's custom
 * checks are different: they are scripts in the adopter's repository,
 * importing the adopter's own code, and a bare runner has none of it
 * installed. Measured on the first non-greenfield adopter: both of its
 * custom checks failed as `error (2ms)` on every CI run — spawn failure,
 * not findings — turning a required check permanently red. A custom check
 * exists to use the repo's own code, so the fix cannot be "keep custom
 * checks dependency-free"; and vinaya cannot know an adopter's package
 * manager or runtime, so the command is declared, never inferred.
 *
 * Not emitted in the archivist workflow: `archive`/`audit` are vinaya
 * commands that never spawn adopter check scripts, and its scheduled jobs
 * would pay the install daily for nothing.
 *
 * `''` when undeclared — byte-identical output to before the key existed.
 */
function adopterSetupStep(ciSetup: string | null): string {
  if (!ciSetup) return ''
  // trimStart() is load-bearing, not cosmetic: YAML takes a `|` block
  // scalar's indentation from its FIRST non-empty line, so a value whose
  // first line carries extra leading whitespace would set the reference
  // deeper than a later line and de-dent that line out of the scalar —
  // an invalid workflow from valid-looking config (both reviewers flagged
  // it). Leading whitespace before a shell command is semantically inert,
  // so stripping it changes nothing the adopter declared. Later lines may
  // be MORE indented than the first (heredocs, continuations) — that is
  // always inside the scalar and stays untouched.
  const indented = ciSetup
    .trimStart()
    .split('\n')
    .map((line) => (line.length > 0 ? `          ${line}` : line))
    .join('\n')
  return `      # Adopter-declared CI setup (vinaya.config.json \`ci.setup\`), emitted
      # verbatim. It prepares this repository's OWN custom checks — scripts
      # committed here that may import this repository's code — which the
      # \`npx\` invocation below cannot do: npx prepares only vinaya itself.
      # The command is repo-committed, reviewed config; under \`pull_request\`
      # the workflow definition is already controlled by the pull request, so
      # this step adds no trust surface that did not already exist.
      - name: Adopter CI setup
        run: |
${indented}
`
}

/**
 * The "Fetch PR body" step body, shared verbatim by \`vinaya-checks.yml\` and
 * \`vinaya-body-checks.yml\` (task 17, O3) — one rule, not two copies. A
 * single \`gh pr view\` read is a race: \`pr report --push\` (or a plain
 * \`pr edit\`) can land on the forge in the gap between this workflow's
 * trigger firing and its own \`gh pr view\` call, so the run reads a body
 * from BEFORE that write finished — measured live on atta-labs/vinaya
 * #485/#520/#523, each red on \`closes-n\` with a body the workflow's own
 * log later showed was correct, green on the very next run with no code
 * change. Every real task PR already passed \`closes-n\` at WRITE time
 * (\`runBodyChecks\`, O1) before it could exist on the forge at all, so a
 * missing/malformed \`AEG:CLOSES\` region here is never a legitimate,
 * permanent state for a task branch — it is this exact race, and it is
 * safe to wait a few seconds for it to resolve. Same reasoning for a
 * present \`AEG:EVIDENCE\` block whose recorded \`Head:\` is not yet this
 * run's real PR head: \`pr report --push\` re-reads and self-verifies its
 * own write, so a body carrying a STALE head is a write still landing, not
 * a permanently wrong one.
 *
 * Bounded — six attempts, five seconds apart (thirty seconds total) — and
 * loud on exhaustion: names exactly what it waited for rather than quietly
 * running the check suite against a body it already knows may be stale.
 */
function verifiedFetchPrBodyStep(): string {
  return `      - name: Fetch PR body
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
          PR_HEAD_SHA: \${{ github.event.pull_request.head.sha }}
          BRANCH: \${{ github.head_ref }}
        run: |
          ATTEMPTS=0
          MAX_ATTEMPTS=6
          SLEEP_SECONDS=5
          while :; do
            BODY="$(gh pr view "$PR_NUMBER" --json body --jq .body)"
            WAIT_FOR=""
            if [[ "$BRANCH" =~ ^task/[^/]+/[^/]+$ ]]; then
              CLOSES_REGION="$(printf '%s\\n' "$BODY" | sed -n '/<!-- AEG:CLOSES:START -->/,/<!-- AEG:CLOSES:END -->/p')"
              if ! printf '%s\\n' "$CLOSES_REGION" | grep -qE '#[0-9]+'; then
                WAIT_FOR="a real Closes #N inside the AEG:CLOSES region for task branch $BRANCH"
              fi
            fi
            if [ -z "$WAIT_FOR" ]; then
              EVIDENCE_REGION="$(printf '%s\\n' "$BODY" | sed -n '/<!-- AEG:EVIDENCE:START -->/,/<!-- AEG:EVIDENCE:END -->/p')"
              if [ -n "$EVIDENCE_REGION" ]; then
                EVIDENCE_HEAD="$(printf '%s\\n' "$EVIDENCE_REGION" | grep -m1 '^Head: ' | sed 's/^Head: //')"
                if [ -n "$EVIDENCE_HEAD" ] && [ "$EVIDENCE_HEAD" != "$PR_HEAD_SHA" ]; then
                  WAIT_FOR="the AEG:EVIDENCE block's Head ($EVIDENCE_HEAD) to catch up to this run's real head ($PR_HEAD_SHA)"
                fi
              fi
            fi
            if [ -z "$WAIT_FOR" ]; then
              break
            fi
            ATTEMPTS=$((ATTEMPTS + 1))
            if [ "$ATTEMPTS" -ge "$MAX_ATTEMPTS" ]; then
              echo "::error::Gave up after $ATTEMPTS attempts waiting for $WAIT_FOR." >&2
              exit 1
            fi
            sleep "$SLEEP_SECONDS"
          done
          DELIM="PR_BODY_$(openssl rand -hex 16)"
          echo "PR_BODY<<$DELIM" >> "$GITHUB_ENV"
          printf '%s\\n' "$BODY" >> "$GITHUB_ENV"
          echo "$DELIM" >> "$GITHUB_ENV"
`
}

function checksWorkflow(selfHost: VendoredVinaya | null, ciSetup: string | null): string {
  return `# ${MANAGED_NOTE}
#
# The deterministic gate suite. Runs every registered vinaya check over the
# pull request's diff. This is the guarantee: a PR cannot merge red.
name: Vinaya Checks

on:
  pull_request:
    types: [opened, synchronize, reopened, edited]

# One run per pull request COMMIT, always. Several \`types:\` above can fire in the
# same instant — \`vinaya pr create\` opens the PR and applies its tranche
# label immediately after, so \`opened\` and \`labeled\` arrive together and
# GitHub starts TWO runs of this workflow. Both then report under the same
# check name, and the merge box counts both: one can go green while its twin
# holds a stale red, which no later verdict clears because each run only ever
# re-evaluates itself. Measured live on atta-labs/vinaya#18 — two runs created
# in the same second, one success, one failure, PR blocked with both reviews
# already approved.
#
# The key carries the head SHA as well as the PR number, and that second half
# is load-bearing. Keyed on the PR alone, every run for that PR shares one
# group — including a rerun of an EARLIER commit's run, which the verdict
# retrigger performs. Measured on PR #22: re-running the old commit's run
# (attempt 4) cancelled the current commit's run after one second, so a push
# appeared to produce a cancelled gate. Runs for different commits must not be
# able to cancel each other; runs for the SAME commit still collapse, which is
# the duplicate this group exists to remove.
#
# \`cancel-in-progress\` is safe here and not merely tolerable: the job is a
# pure re-evaluation of forge state that takes seconds, so a cancelled run had
# nothing to lose and the survivor reads strictly fresher state.
concurrency:
  group: vinaya-checks-\${{ github.event.pull_request.number || github.ref }}-\${{ github.event.pull_request.head.sha || github.sha }}
  cancel-in-progress: true

jobs:
  vinaya-checks:
    name: vinaya check --all --diff-only
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
      issues: read
      # O2's shared-build lookup (\`vinayaSetupSteps(..., 'shared-build')\`)
      # calls \`gh api .../actions/workflows/ci.yml/runs\` and
      # \`.../actions/runs/$RUN_ID/artifacts\`, then downloads via
      # \`actions/download-artifact@v4\` with a cross-run \`run-id\` — all three
      # need \`actions: read\` on GITHUB_TOKEN, which an explicit \`permissions:\`
      # block does not grant by default (security review finding: every run
      # 403'd on the lookup/download without this).
      actions: read
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          # The job builds and runs code from this checkout, and the default
          # writes GITHUB_TOKEN into .git/config as an http extraheader —
          # readable by anything the build executes. Nothing here pushes.
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 20
${vinayaSetupSteps(selfHost, 'shared-build')}${adopterSetupStep(ciSetup)}      # PR_BODY is what makes test-plan/closes-n/pr-report-density EVALUATE:
      # none of the three fetches the body itself (all read
      # \`process.env.PR_BODY\` only) — without it they read "no body —
      # nothing to check" and pass vacuously regardless of the PR's real
      # content, on every run. Fetched live from the forge, never the
      # event payload — a rerun of an old run must read the body as it
      # stands NOW, not as it stood when the triggering event fired. See
      # \`verifiedFetchPrBodyStep\`'s own doc comment for why this re-reads
      # with a bounded backoff instead of trusting the first read.
${verifiedFetchPrBodyStep()}      - name: Run checks
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
          BRANCH: \${{ github.head_ref }}
        # pipefail is load-bearing: this job's default shell is \`bash -e\`
        # WITHOUT pipefail, so an unguarded pipe through tee would mask the
        # check runner's exit code and report a red suite green.
        run: |
          set -o pipefail
          ${vinayaRun(selfHost, 'check --all --diff-only')} | tee vinaya-check-output.txt
      # The job's one check name ("vinaya check --all --diff-only: failing")
      # names no check. This step puts the runner's per-check lines — which
      # check failed, and its finding messages — on the run's Summary page,
      # readable without opening the log. \`!cancelled()\` rather than
      # \`always()\`: the concurrency group above cancels superseded runs as a
      # matter of course, and a cancelled run's half-captured output is noise,
      # not signal.
      - name: Per-check summary
        if: \${{ !cancelled() }}
        run: |
          {
            echo '### vinaya check --all --diff-only'
            echo '~~~'
            cat vinaya-check-output.txt 2>/dev/null || echo 'no check output captured (runner did not start)'
            echo '~~~'
          } >> "$GITHUB_STEP_SUMMARY"
`
}

/**
 * Doubles every backslash in a plain regex SOURCE string (e.g.
 * `VERDICT_MARKER_SOURCE`, already in the single-backslash form
 * `RegExp.prototype.source` uses) so it survives, byte-identical, through a
 * jq double-quoted string literal: jq's JSON-style string parser collapses
 * `\\` back to one backslash, reconstructing the exact source oniguruma
 * needs. Generation-time only — never applied to pull-request content.
 */
function jqStringEscape(regexSource: string): string {
  return regexSource.replace(/\\/g, '\\\\')
}

function reviewWorkflow(selfHost: VendoredVinaya | null): string {
  const verdictMarkerForJq = jqStringEscape(VERDICT_MARKER_SOURCE)
  return `# ${MANAGED_NOTE}
#
# The required review gate. \`pull_request_target\` is the trust boundary:
# GitHub loads this workflow and its default checkout from the repository's
# default branch, never from the pull request being judged. The job does not
# fetch, check out, install, build, or execute pull-request content.
#
# The verdict-comment
# half lives in its own workflow (vinaya-review-verdict.yml): a new PR
# comment fires a different GitHub event that this
# workflow structurally cannot receive — and keeping the comment path in a
# separate FILE means this workflow's runs never list permanently-skipped
# comment jobs on the PR's checks panel. The CI-green retrigger half lives
# in its own workflow too (vinaya-review-retrigger.yml, Issue #402 O4): it
# only ever fires on \`workflow_run\`, so it never appears as a check-run —
# skipped or otherwise — against this workflow's own \`pull_request_target\`
# runs. When a clean final verdict lands, or CI turns green, one of those
# two workflows re-runs this one, so the required check below goes green
# natively with no manual rerun.
#
# The job's first step never builds: it reads the PR's comments and labels
# through the API alone and fails fast, without checkout or build, whenever
# neither a \`VERDICT:\` comment nor a (presence-only, unverified) waiver
# label exists yet — the ordinary state on \`opened\`/\`synchronize\`/
# \`reopened\`/\`labeled\`/\`unlabeled\`. The build runs once that step finds
# either: a verdict, which in practice is the state a rerun finds it in (the
# verdict-comment workflow and the CI-green retrigger both re-run THIS run,
# and by the time either fires, the verdict this job is looking for already
# exists) — or a \`labeled\` event applying the waiver label itself, so a
# waived PR goes green on the SAME push that applies the label rather than
# waiting on a verdict that will never arrive (\`#525\`: found live minutes
# after this pre-check step was first added — PR #517's Version Packages
# PR, carrying the waiver label, went red at the gate in four seconds,
# never having learned the waiver the full gate downstream already
# honoured).
name: Vinaya Review Gate
run-name: "Vinaya Review Gate PR #\${{ github.event.pull_request.number }} @ \${{ github.event.pull_request.head.sha }}"

on:
  pull_request_target:
    types: [opened, synchronize, reopened, labeled, unlabeled]

# One run per pull request COMMIT, always. Several \`types:\` above can fire in the
# same instant — \`vinaya pr create\` opens the PR and applies its tranche
# label immediately after, so \`opened\` and \`labeled\` arrive together and
# GitHub starts TWO runs of this workflow. Both then report under the same
# check name, and the merge box counts both: one can go green while its twin
# holds a stale red, which no later verdict clears because each run only ever
# re-evaluates itself. Measured live on atta-labs/vinaya#18 — two runs created
# in the same second, one success, one failure, PR blocked with both reviews
# already approved.
#
# The key carries the head SHA as well as the PR number, and that second half
# is load-bearing. Keyed on the PR alone, every run for that PR shares one
# group — including a rerun of an EARLIER commit's run, which a retrigger
# performs. Measured on PR #22: re-running the old commit's run (attempt 4)
# cancelled the current commit's run after one second, so a push appeared to
# produce a cancelled gate. Runs for different commits must not be able to
# cancel each other; runs for the SAME commit still collapse, which is the
# duplicate this group exists to remove.
#
# \`cancel-in-progress\` is safe here and not merely tolerable: the job is a
# pure re-evaluation of forge state that takes seconds, so a cancelled run had
# nothing to lose and the survivor reads strictly fresher state.
concurrency:
  group: vinaya-review-\${{ github.event.pull_request.number || github.ref }}-\${{ github.event.pull_request.head.sha || github.sha }}
  cancel-in-progress: true

jobs:
  vinaya-review:
    name: vinaya review gate
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
      issues: read
      checks: read
    steps:
      # No checkout, no build: read whether a verdict exists yet, or an
      # actor-verified \`vinaya/waiver:review\` label is present, through the
      # API alone. Absent both, THIS step fails — the job's own single
      # check-run ("vinaya review gate") goes red with the reason below and
      # every step after it is skipped, so an ordinary push (opened /
      # synchronize / reopened / labeled / unlabeled) never pays for a build
      # it cannot use. Deliberately one job, not two: a second job would
      # report a second check-run name, and \`REVIEW_GATE_CHECK_RUN_NAME\`
      # (this repo's own \`check-review-gate.ts\`/\`dev-review-loop.ts\`) is
      # the one required name every other mechanism already keys on.
      #
      # The label check below is PRESENCE-ONLY, never actor verification
      # (\`#525\`: "Do NOT verify the waiver's actor in the pre-check").
      # Actor verification needs the trusted build's
      # \`principalAllowlist\`/\`gh api .../timeline\` reads and stays exactly
      # where it already lives, in \`check-review-gate.ts\`'s own \`main()\`.
      # An unverified label only earns the PR a build — the SAME build job
      # the full gate already runs on every ordinary push — so a
      # self-applied label buys nothing on its own: \`checkReviewGate\` inside
      # that build re-decides for real, actor and all, exactly as it did
      # before this pre-check existed.
      #
      # Both string constants spliced into the \`jq\` calls below are read
      # from \`packages/aeg-core\` at CLI-GENERATION time — \`WAIVER_LABEL_REVIEW\`
      # (\`waiver-label.ts\`) and \`VERDICT_MARKER_SOURCE\` (\`verdict-extraction.ts\`)
      # — the SAME constants \`check-review-gate.ts\` reads for the full gate,
      # never a second hand-typed copy of either fact (\`#525\`).
      #
      # Line-anchored \`VERDICT:\` — same anchor discipline
      # \`packages/aeg-core/src/verdict-extraction.ts\` standardizes on
      # (security-review FAIL finding, PR #636/#639): a bare substring/word
      # search matches ordinary prose that merely mentions "VERDICT" (an
      # escalation, a reviewer report, this very step's own description) and
      # would wrongly let the build run on a push with no real verdict cast.
      # \`VERDICT_MARKER_SOURCE\` tolerates the same leading markdown emphasis
      # run the real extractor does, and — because it is tested per split
      # line rather than as one multiline string (this jq/oniguruma build's
      # \`^\`/\`$\` do not cross embedded newlines even under the "m"/"s"
      # flags) — rejects the same blockquote/list-item/heading prefixes the
      # real extractor rejects. This is a presence-only approximation of
      # that module's full extraction (no first-five-lines window, no
      # value-side match, no most-recent-comment selection, no code-span
      # exclusion) — deliberately so: this step never runs after a checkout,
      # so it cannot import \`packages/aeg-core\` at RUN time (the constant is
      # instead read once, at CLI-generation time, and spliced in below). A
      # false positive here only wastes a trusted build; the downstream
      # \`vinayaRun(selfHost, 'check review-gate')\` step, which DOES run the
      # real extractor and the real actor-verified waiver check after
      # checkout, is the authoritative read and still fails correctly on
      # anything this coarser check let through.
      - name: Require a verdict or waiver before building
        id: verdict-check
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
        run: |
          set -o pipefail
          PR_JSON=$(gh pr view "$PR_NUMBER" --repo \${{ github.repository }} --json comments,labels)
          HAS_VERDICT=$(echo "$PR_JSON" | jq '[.comments[].body | select((. / "\\n") | any(test("${verdictMarkerForJq}")))] | length > 0')
          HAS_WAIVER_LABEL=$(echo "$PR_JSON" | jq '[.labels[].name == "${WAIVER_LABEL_REVIEW}"] | any')
          if [ "$HAS_VERDICT" != "true" ] && [ "$HAS_WAIVER_LABEL" != "true" ]; then
            echo "No VERDICT: comment and no ${WAIVER_LABEL_REVIEW} label yet on PR #$PR_NUMBER - nothing to evaluate. Holding the gate red without building until a reviewer posts a verdict or a principal applies the waiver." >&2
            exit 1
          fi
      - uses: actions/checkout@v4
        with:
          # Explicit trusted ref: never use the PR head/merge ref in this job.
          ref: \${{ github.event.repository.default_branch }}
          persist-credentials: false
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
${vinayaSetupSteps(selfHost, 'trusted')}      - name: Review gate
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          # PR_NUMBER is what makes the review-gate check EVALUATE: without
          # it the adapter reads "no PR yet — local dev" and exits 0, and
          # the gate is green regardless of review state.
          PR_NUMBER: \${{ github.event.pull_request.number }}
        run: ${vinayaRun(selfHost, 'check review-gate')}
`
}

function reviewRetriggerWorkflow(): string {
  return `# ${MANAGED_NOTE}
#
# The CI-green retrigger half of the review gate (Issue #402 O4, split out
# of vinaya-review.yml). Its own FILE, not a second job there, on purpose:
# a job's \`if:\` evaluating false still reports a \`skipped\` check-run for
# THAT workflow's head — \`retrigger-on-ci-green\` reported \`skipped\` on
# every ordinary \`pull_request_target\` run of vinaya-review.yml, and
# \`check-review-gate.ts\`'s mechanical-checks read counted that as "not
# green," blocking every PR (first seen on PR #401 at 01efd54c). This
# workflow triggers ONLY on \`workflow_run\`, so it never runs — and so
# never reports a check-run at all — against a \`pull_request_target\` event;
# there is no skipped entry left for the gate to misread.
#
# Executes nothing itself; only re-runs vinaya-review.yml's own prior run
# for this head, exactly as vinaya-review-verdict.yml's \`retrigger\` job
# does for a verdict comment.
name: Vinaya Review Gate (retrigger on CI green)

on:
  # Re-run the required gate for a head whose CI (\`ci.yml\`, name \`CI\`) just
  # turned green, so a pull request that passed every check locally but
  # raced a red CI run (found live on PR #398 at 4c59d4dd: gate ran with CI
  # red, CI passed on rerun, gate held red until a hand \`gh run rerun\`)
  # goes green on its own — no manual rerun.
  workflow_run:
    workflows: [CI]
    types: [completed]

# Keyed per PR, falling back to the run id for a non-PR branch (no PR to
# key on). Cancelling an older, still-running retrigger for the SAME PR is
# safe and desirable, not merely tolerable: this job executes nothing of
# its own — it only calls \`gh run rerun\` on the one required run matching
# the CURRENT head's immutable title (see the lookup below). A newer CI
# completion means a newer push superseded the head the older retrigger was
# chasing, so letting the older one finish would at best re-run a gate for
# a head nobody will read and at worst race the newer retrigger for the
# same required run — cancelling it loses nothing the newer completion
# doesn't already redo.
concurrency:
  group: vinaya-review-retrigger-\${{ github.event.workflow_run.pull_requests[0].number || github.event.workflow_run.id }}
  cancel-in-progress: true

jobs:
  retrigger-on-ci-green:
    name: vinaya review gate (retrigger on CI green)
    # \`github.event.workflow_run.pull_requests\` resolves for a same-repo
    # branch (this repo's own model — task branches push to origin, never a
    # fork), so PR_NUMBER needs no separate \`gh\` lookup here.
    if: \${{ github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.pull_requests[0] != null }}
    runs-on: ubuntu-latest
    permissions:
      actions: write
    steps:
      - name: Re-run the required review gate for this head
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          PR_NUMBER: \${{ github.event.workflow_run.pull_requests[0].number }}
          HEAD_SHA: \${{ github.event.workflow_run.head_sha }}
        run: |
          # pull_request_target runs execute at the DEFAULT branch SHA, so a
          # run's head_sha cannot identify the PR commit. GitHub's nested
          # pull_requests snapshot is also not immutable: an old rerun can
          # expose the PR's current head. The required workflow therefore
          # records PR number + head SHA in run-name at creation, and this
          # query matches that immutable display_title exactly — same
          # lookup vinaya-review-verdict.yml's own retrigger step runs.
          set -o pipefail
          RUN_TITLE="Vinaya Review Gate PR #$PR_NUMBER @ $HEAD_SHA"
          # O7 (found live 2026-09-04): dropped \`select(.status == "completed")\`
          # — two retriggers for the same head race the SAME required run
          # (PR #401, PR #409: runs 33841069791/33841065139), and the loser's
          # query landed while the winner's \`gh run rerun\` had already
          # flipped the run to \`in_progress\`. Requiring \`completed\` made
          # that run invisible to the loser entirely — not "already handled,
          # skip", but "nothing matched, give up" — so when that in-flight
          # attempt itself later failed, nothing retried it again and the
          # gate stayed red until a hand rerun. Matching on title+event alone
          # (any status) lets the loser find the SAME run mid-run and try
          # \`gh run rerun\` on it too; the existing "declined (already
          # queued)" fallback below already handles that outcome harmlessly
          # — it is not a new failure mode, only a query that used to see
          # nothing at all now sees the run and takes the same safe no-op.
          RUN_ID=$(gh api --paginate \\
            "repos/\${{ github.repository }}/actions/workflows/vinaya-review.yml/runs?event=pull_request_target&per_page=100" \\
            | jq -sr --arg title "$RUN_TITLE" '
                [.[].workflow_runs[]
                 | select(.display_title == $title)
                 | select(.event == "pull_request_target")
                 | select(.conclusion != "cancelled")
                 | .id][0] // empty')
          if [ -z "$RUN_ID" ]; then
            echo "No completed, non-cancelled pull_request_target run of vinaya-review.yml for PR #$PR_NUMBER at $HEAD_SHA - nothing to re-run."
            exit 0
          fi
          echo "Re-running vinaya-review.yml run $RUN_ID for PR #$PR_NUMBER at $HEAD_SHA"
          # Two green CI completions for one head (e.g. a re-triggered CI
          # run) run two retriggers in parallel. Both can select the same
          # run, and the loser gets "already queued" — the mechanism
          # working, not a failure worth reddening the step over.
          gh run rerun "$RUN_ID" --repo "\${{ github.repository }}" || echo "rerun declined (already queued, or run too old) - the other retrigger covers it"
`
}

function bodyChecksWorkflow(selfHost: VendoredVinaya | null): string {
  return `# ${MANAGED_NOTE}
#
# Required, PR-content-independent checks that need a trust anchor no pull
# request can rewrite. \`pull_request_target\` is the same boundary
# \`vinaya-review.yml\` uses: GitHub loads this workflow and its default
# checkout from the repository's default branch, never from the pull
# request being judged. The job does not fetch, check out, install, build,
# or execute pull-request content — every check registered here reads only
# live-fetched PR metadata (\`gh pr view\`), never the diff or repo tree, the
# same shape \`review-gate\` already requires of its own checks.
#
# \`body-bare-digits\` is the one check here today: its Changesets-release
# exemption live-fetches the PR's real author, keyed on \`PR_NUMBER\` — on a
# \`pull_request\` trigger that value is PR-editable (the PR's own workflow
# YAML controls it), so an attacker could redirect it to any
# already-approved PR by the configured release actor. Found live (round 5,
# security review, PR #165), and verified no env-var or git-state signal
# inside a \`pull_request\` job closes it — \`pull_request_target\` does,
# because the workflow text assigning \`PR_NUMBER\` comes from THIS file on
# the default branch, which a pull request cannot edit.
name: Vinaya Body Checks
run-name: "Vinaya Body Checks PR #\${{ github.event.pull_request.number }} @ \${{ github.event.pull_request.head.sha }}"

on:
  pull_request_target:
    types: [opened, synchronize, reopened, edited]

# Same collapsing rationale as \`vinaya-review.yml\`'s concurrency group — see
# that file's own comment for the two measured failure modes (duplicate
# runs from simultaneous event types; an old rerun cancelling the current
# commit's run) this group exists to prevent.
concurrency:
  group: vinaya-body-checks-\${{ github.event.pull_request.number || github.ref }}-\${{ github.event.pull_request.head.sha || github.sha }}
  cancel-in-progress: true

jobs:
  vinaya-body-checks:
    name: vinaya check body-bare-digits
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
    steps:
      - uses: actions/checkout@v4
        with:
          # Explicit trusted ref: never use the PR head/merge ref in this job.
          ref: \${{ github.event.repository.default_branch }}
          persist-credentials: false
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
${vinayaSetupSteps(selfHost, 'trusted')}      # PR_BODY is what makes body-bare-digits EVALUATE at all — the bin
      # reads \`process.env.PR_BODY\` only, never fetches it itself. Fetched
      # live from the forge, never the event payload — same reasoning as
      # \`vinaya-checks.yml\`'s own PR_BODY step. See \`verifiedFetchPrBodyStep\`'s
      # own doc comment for why this re-reads with a bounded backoff instead
      # of trusting the first read.
${verifiedFetchPrBodyStep()}      - name: Body checks
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          # PR_NUMBER is what makes the Changesets-release exemption
          # EVALUATE its live gh pr view fetch: without it the check reads
          # "no PR yet — local dev" and falls through to the ordinary
          # bare-digit scan.
          PR_NUMBER: \${{ github.event.pull_request.number }}
        run: ${vinayaRun(selfHost, 'check body-bare-digits')}
`
}

function reviewVerdictWorkflow(selfHost: VendoredVinaya | null): string {
  return `# ${MANAGED_NOTE}
#
# The verdict-comment half of the review gate. A reviewer's verdict arrives
# as a PR comment (\`VERDICT: APPROVE\` / \`VERDICT: PASS\`), which fires
# GitHub's \`issue_comment\` event — an event the required PR-event
# workflow cannot receive. This workflow evaluates the gate on that comment
# and, when the evaluation is clean, RE-RUNS the required workflow so its
# check goes green natively with no manual rerun. (Writing check-run
# conclusions directly is no longer possible: GitHub's 2025-02-12 change
# restricts check-run updates to the owning workflow — re-running is the
# supported channel.)
#
# Privilege split, deliberate: \`evaluate\` executes only the default branch's
# trusted gate code and holds NO write permission; \`retrigger\` holds
# \`actions: write\` but checks out and executes nothing. Neither job checks
# out or executes pull-request content.
name: Vinaya Review Gate (on verdict)

on:
  issue_comment:
    types: [created]

jobs:
  evaluate:
    name: vinaya review gate (verdict check)
    if: github.event.issue.pull_request != null && contains(github.event.comment.body, 'VERDICT')
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
      issues: read
      checks: read
    outputs:
      number: \${{ steps.pr.outputs.number }}
      sha: \${{ steps.pr.outputs.sha }}
    steps:
      # issue_comment payloads carry no PR head SHA — resolve it for immutable
      # run identity only. It never selects executable code.
      - name: Resolve PR head
        id: pr
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          NUMBER="\${{ github.event.issue.number }}"
          SHA=$(gh pr view "$NUMBER" --repo "\${{ github.repository }}" --json headRefOid -q .headRefOid)
          echo "number=$NUMBER" >> "$GITHUB_OUTPUT"
          echo "sha=$SHA" >> "$GITHUB_OUTPUT"
      - uses: actions/checkout@v4
        with:
          # issue_comment already sources workflows from the default branch;
          # make the trusted code checkout explicit too.
          ref: \${{ github.event.repository.default_branch }}
          persist-credentials: false
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
${vinayaSetupSteps(selfHost, 'trusted')}      - name: Review gate (verdict evaluation)
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          # Same wiring as the required workflow: PR_NUMBER is what makes
          # the adapter evaluate instead of no-op'ing as "local dev".
          PR_NUMBER: \${{ steps.pr.outputs.number }}
        run: ${vinayaRun(selfHost, 'check review-gate')}

  # Executes nothing; consumes only the evaluator's outputs.
  #
  # Fires on EITHER verdict. The required check stores a conclusion, and that
  # stored conclusion — not this job's result — is what guards the merge
  # button. Running only on a clean evaluation makes the gate one-way: it can
  # turn the check green on an approval but never turn it red again on a
  # later rejection, leaving a stale green until someone pushes.
  retrigger:
    name: vinaya review gate (retrigger)
    if: \${{ !cancelled() && needs.evaluate.result != 'skipped' }}
    needs: evaluate
    runs-on: ubuntu-latest
    permissions:
      actions: write
    steps:
      - name: Re-run the required review gate for this branch
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          PR_NUMBER: \${{ needs.evaluate.outputs.number }}
          HEAD_SHA: \${{ needs.evaluate.outputs.sha }}
        run: |
          if [ -z "$PR_NUMBER" ]; then
            echo "No PR number resolved (the evaluate job failed before resolving it) - nothing to re-run."
            exit 0
          fi
          # Same guard, same producer: an empty SHA would make the selection
          # below match nothing and silently skip the rerun a verdict just
          # earned. Say so instead.
          if [ -z "$HEAD_SHA" ]; then
            echo "No head SHA resolved (the evaluate job failed before resolving it) - nothing to re-run."
            exit 0
          fi
          # pull_request_target runs execute at the DEFAULT branch SHA, so a
          # run's head_sha cannot identify the PR commit. GitHub's nested
          # pull_requests snapshot is also not immutable: an old rerun can
          # expose the PR's current head. The required workflow therefore
          # records PR number + head SHA in run-name at creation, and this
          # query matches that immutable display_title exactly.
          set -o pipefail
          RUN_TITLE="Vinaya Review Gate PR #$PR_NUMBER @ $HEAD_SHA"
          # O7 (found live 2026-09-04): dropped \`select(.status == "completed")\`
          # — two retriggers for the same head race the SAME required run
          # (PR #401, PR #409: runs 33841069791/33841065139), and the loser's
          # query landed while the winner's \`gh run rerun\` had already
          # flipped the run to \`in_progress\`. Requiring \`completed\` made
          # that run invisible to the loser entirely — not "already handled,
          # skip", but "nothing matched, give up" — so when that in-flight
          # attempt itself later failed, nothing retried it again and the
          # gate stayed red until a hand rerun. Matching on title+event alone
          # (any status) lets the loser find the SAME run mid-run and try
          # \`gh run rerun\` on it too; the existing "declined (already
          # queued)" fallback below already handles that outcome harmlessly
          # — it is not a new failure mode, only a query that used to see
          # nothing at all now sees the run and takes the same safe no-op.
          RUN_ID=$(gh api --paginate \\
            "repos/\${{ github.repository }}/actions/workflows/vinaya-review.yml/runs?event=pull_request_target&per_page=100" \\
            | jq -sr --arg title "$RUN_TITLE" '
                [.[].workflow_runs[]
                 | select(.display_title == $title)
                 | select(.event == "pull_request_target")
                 | select(.conclusion != "cancelled")
                 | .id][0] // empty')
          if [ -z "$RUN_ID" ]; then
            echo "No completed, non-cancelled pull_request_target run of vinaya-review.yml for PR #$PR_NUMBER at $HEAD_SHA - nothing to re-run."
            exit 0
          fi
          echo "Re-running vinaya-review.yml run $RUN_ID for PR #$PR_NUMBER at $HEAD_SHA"
          # Two verdict comments landing together run two retriggers in
          # parallel (this workflow has no concurrency group, deliberately —
          # a queued retrigger is a delayed one). Both can select the same
          # run, and the loser gets "already queued". That is the mechanism
          # working, not a failure worth reddening the step over; a real
          # 403 or an expired run still surfaces in the log.
          gh run rerun "$RUN_ID" --repo "\${{ github.repository }}" || echo "rerun declined (already queued, or run too old) - the other verdict's retrigger covers it"
`
}

// The ring-2 post-merge/scheduled mechanisms — same three-job shape as this
// monorepo's own live `.github/workflows/archivist.yml` (triggers,
// permissions, `continue-on-error` on the drift job), calling `vinaya
// archive`/`vinaya audit` instead of a repo-internal `bun packages/aeg-core/
// bin/*.ts` invocation, so any vinaya-init'd repo gets the same post-merge
// provenance/close-out, dead-branch drift notification, and direct-main-push
// detection — not just this one.
function archivistWorkflow(selfHost: VendoredVinaya | null): string {
  return `# ${MANAGED_NOTE}
#
# The ring-2 post-merge/scheduled mechanisms: per-task Archivist provenance
# + close-out (post-merge), dead-branch-push drift (daily-drift, a
# notification channel — never fails red), and direct-main-push detection
# (direct-main-push-detection, a real pass/fail).
name: Vinaya Archivist

on:
  push:
    branches: [main]
  schedule:
    - cron: "0 2 * * *"  # daily at 02:00 UTC
  workflow_dispatch:

jobs:
  post-merge:
    name: Post-Merge Archivist
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          # The job builds and runs code from this checkout, and the default
          # writes GITHUB_TOKEN into .git/config as an http extraheader —
          # readable by anything the build executes. Nothing here pushes.
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 20
${vinayaSetupSteps(selfHost)}      - name: Run vinaya archive
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: ${vinayaRun(selfHost, 'archive')} --merge-sha=\${{ github.sha }}

  daily-drift:
    name: Daily Drift Check (dead-branch pushes)
    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          # The job builds and runs code from this checkout, and the default
          # writes GITHUB_TOKEN into .git/config as an http extraheader —
          # readable by anything the build executes. Nothing here pushes.
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 20
${vinayaSetupSteps(selfHost)}      - name: Run vinaya audit --only=dead-branches
        continue-on-error: true # never-red — this job is a notification channel, not a gate
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: ${vinayaRun(selfHost, 'audit --only=dead-branches')}

  direct-main-push-detection:
    name: Direct-Main-Push Detection
    if: (github.event_name == 'push' && github.ref == 'refs/heads/main') || github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: write
      pull-requests: read
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          # The job builds and runs code from this checkout, and the default
          # writes GITHUB_TOKEN into .git/config as an http extraheader —
          # readable by anything the build executes. Nothing here pushes.
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 20
${vinayaSetupSteps(selfHost)}      - name: Run vinaya audit --only=direct-push
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: ${vinayaRun(selfHost, 'audit --only=direct-push')} --sha=\${{ github.sha }}
`
}

// ---------------------------------------------------------------------------
// Git-hook stubs — thin, marker-delimited, invoke the vinaya binary ONLY
// (never inline check logic, never path into any repo-internal bin).
//
// `npx --yes @attalabs/vinaya@<exact-version>`, NOT `--no-install` bare:
// npx's cache is keyed by the invoked spec, and a cache entry written by
// `npx @attalabs/vinaya init` (bare or `@latest`) does NOT satisfy a later
// `--no-install @attalabs/vinaya` lookup — reproduced live 2026-08-09: on
// any machine that never ran the exact spec, the very first commit after
// init died with npx's non-interactive "canceled due to missing packages
// and no YES option". The exact-version pin makes the cache key stable
// (one download at most, offline afterwards) and pins the gate's version
// to the installer that wrote the hook; `vinaya upgrade` re-pins it.
//
// In a repo that vendors the CLI (`selfHost`), that same spec resolves to the
// local workspace member instead — npm matches the package NAME before reading
// any version spec — and execs its unbuilt `bin`, so the hook dies on `sh:
// vinaya: command not found` and `|| exit 1` blocks every commit and push.
// atta-labs/attalabs#929 fixed this for the four generated workflows and left
// the two hook emitters on the published spec; #935 is that remainder. Same
// predicate, same shape: run the built file directly, never `npx`.
// ---------------------------------------------------------------------------
const HOOK_PREAMBLE = '#!/usr/bin/env sh\n'

// `--local` skips every `requiresOpenPr` check (closes-n, test-plan): neither
// hook can ever satisfy them — a PR doesn't exist yet at commit time, and
// pushing the branch is what makes one *possible*, not what creates it. CI's
// `vinaya-checks.yml` runs on the `pull_request` event and omits `--local`,
// so both checks run for real, against the real PR body, once one exists.
/**
 * The command a generated hook runs, in whichever shape applies — the hook
 * analogue of `vinayaRun` (which the workflows use). Both published forms pin
 * the exact installed version, from the same `ownVersion()`; this one differs
 * in exactly one way, deliberate: the vendored form guards on the built file
 * being present.
 *
 * That guard is the whole reason this is not a one-line branch. A hook that
 * silently skipped when the build is missing would turn a loud breakage into
 * an absent gate — ring 0 gone, with nothing saying so. `dist/` is generated
 * and git-ignored, so it is legitimately absent in a fresh clone and in every
 * new worktree; the hook says which command builds it and fails until it is
 * run. Deliberately not auto-building: a hook that silently spends a build on
 * someone's commit is worse than one that tells them what to run.
 */
function hookRun(selfHost: VendoredVinaya | null, args: string): string {
  if (!selfHost) return `npx --yes @attalabs/vinaya@${ownVersion()} ${args} || exit 1`
  return `# This repo vendors the CLI, so \`npx @attalabs/vinaya\` resolves to its own
# unbuilt workspace member. Run the built file instead.
if [ ! -f ${selfHost.bin} ]; then
  echo "vinaya: ${selfHost.bin} is missing — run \\\`bun run --cwd ${selfHost.dir} build\\\`" >&2
  exit 1
fi
node ${selfHost.bin} ${args} || exit 1`
}

// `--local` skips every `requiresOpenPr` check (closes-n, test-plan): neither
// hook can ever satisfy them — a PR doesn't exist yet at commit time, and
// pushing the branch is what makes one *possible*, not what creates it. CI's
// `vinaya-checks.yml` runs on the `pull_request` event and omits `--local`,
// so both checks run for real, against the real PR body, once one exists.
/**
 * O9 — the local gates run only what the change requires, and fix what they
 * can rather than merely refusing it. Gated on `selfHost` like the pre-push
 * affected-test block below it: only a repo vendoring `@attalabs/vinaya` as
 * a workspace member is assumed to run this repo's own Bun/Biome/Turborepo
 * toolchain — an ordinary adopter's commit is not made to depend on `biome`
 * or `turbo` existing.
 *
 * Two steps, in order:
 *
 * 1. `biome check --write --staged .` applies every safe formatting/lint fix
 *    to the STAGED files only, then exits non-zero if a real (unfixable, or
 *    unsafe) violation remains — never merely reporting what a human must
 *    fix by hand. `--write` rewrites the WORKING TREE, not the index, so the
 *    fixed content restages itself only for files that were already staged
 *    before this ran (`git diff --cached --name-only` captured up front) —
 *    never a file the developer deliberately left unstaged.
 * 2. `turbo typecheck --affected` — the identical `--affected` derivation
 *    the pre-push hook's own test step already uses, scoped to whichever
 *    packages the staged diff actually touches rather than every package
 *    `bun run typecheck` would check.
 *
 * Both cost seconds because both are scoped; the doctrine `vinaya check`
 * gate that follows was already diff-scoped (`--diff-only`) before this.
 */
function preCommitBody(selfHost: VendoredVinaya | null): string {
  const doctrineGate = `# Vinaya commit-time gate. Runs the deterministic checks over your staged
# diff before the commit lands.
${hookRun(selfHost, 'check --all --diff-only --local --skip-full')}`

  if (!selfHost) return doctrineGate

  return `# Ring 0: format + lint your staged files, applying every safe fix, then
# type-check only the packages your staged diff actually touches (O9) —
# scoped so this hook costs seconds, not the whole repo's worth of work.
VINAYA_STAGED_FILES="$(git diff --cached --name-only --diff-filter=ACMR)"
bunx biome check --write --staged . --no-errors-on-unmatched || exit 1
if [ -n "$VINAYA_STAGED_FILES" ]; then
  echo "$VINAYA_STAGED_FILES" | xargs git add --
fi
bunx turbo typecheck --affected || exit 1
${doctrineGate}`
}

function prePushBody(selfHost: VendoredVinaya | null): string {
  const base = `# Vinaya pre-push gate. Runs branch/dispatch checks before the push leaves.
# Forward git's own pre-push stdin (one "<local ref> <local sha> <remote
# ref> <remote sha>" line per ref being pushed) so main-branch-refusal can
# tell a tag-only push apart from one that also carries a branch ref.
VINAYA_PUSH_REFS="$(cat)"
export VINAYA_PUSH_REFS
${hookRun(selfHost, 'check --all --local')}`

  if (!selfHost) return base

  // Ring 0 also runs the affected test suite before a push leaves the
  // machine (#407, O4) — turbo derives the package set from the diff
  // against the remote-tracking base, so this always covers every package
  // a Part actually touched, never just the one a local run happened to be
  // filtered to (PR #409 went red in CI on a `packages/sources` test the
  // Developer's own filtered local run never exercised). Gated on
  // `selfHost`: only a repo vendoring `@attalabs/vinaya` as a workspace
  // member is assumed to run this repo's own Bun/Turborepo toolchain — an
  // ordinary adopter's push is not made to depend on `turbo` existing.
  return `${base}
# Ring 0: the affected test suite. A failing test refuses the push with
# its own output (#407, O4). --concurrency=1 (O9, found live 2026-09-04):
# a local machine already running other work (another worktree's own
# build/test, an IDE indexer) alongside this hook's parallel package
# suites was measured pushing a git-clone-heavy fixture test past its
# timeout under real contention — CI's own runner is dedicated and keeps
# turbo.json's default concurrency; only this hook invocation is serialized.
bunx turbo test --affected --concurrency=1 || exit 1`
}

// `commit-msg` validates the MESSAGE — the file git hands the hook as `$1`,
// plus the source keyword as `$2` (githooks(5)) — never a staged diff, so it
// does not go through `check --local` like its two siblings; there is no
// diff to scope it to and no `requiresOpenPr` check it needs to skip.
// `"$1" "$2"` here are the hook script's own positional params, not this
// TypeScript template's — passed through to `vinaya commit-msg` verbatim.
function commitMsgBody(selfHost: VendoredVinaya | null): string {
  return `# Vinaya commit-message gate. Validates the message's first line against
# this repo's Type(scope): Description convention.
${hookRun(selfHost, 'commit-msg "$1" "$2"')}`
}

// ---------------------------------------------------------------------------
// Doctrine pointer (root VINAYA.md, the only orientation artifact)
//
// MUST be a pure function of `selfHost` — never of where the CLI physically
// sits. This file is COMMITTED into the adopter's repo, so any
// `packageRoot()` interpolation makes its bytes a function of one machine's
// filesystem: teammates clone a pointer naming a directory that doesn't
// exist for them, the installer's home directory is published into the repo,
// and `doctor` (which diffs regenerated bytes against disk) reports drift on
// every machine except the installer's (atta-labs/attalabs#928). The pointer
// therefore names the PACKAGE and hands the reader `vinaya doctrine` — the
// command that resolves the bundled doctrine at READ time, on the reader's
// own machine.
// ---------------------------------------------------------------------------
export function doctrinePointer(selfHost: VendoredVinaya | null): string {
  // Same generation-time selection the workflows and hooks use: in a repo
  // that vendors the CLI, `npx @attalabs/vinaya` misresolves to the unbuilt
  // workspace member (atta-labs/attalabs#929), so the reader is handed the
  // built file by path instead. `selfHost` is a property of the repo, not of
  // any machine — the same repo always regenerates the same bytes.
  const resolveCmd = selfHost ? `node ${selfHost.bin} doctrine` : 'npx --yes @attalabs/vinaya doctrine'
  const resolveNote = selfHost
    ? `   It prints the front door's absolute path on this machine (build the
   CLI first if that file is missing:
   \`bun install --frozen-lockfile && bun run --cwd ${selfHost.dir} build\`);
   the \`aeg-root/\` directory above it is the full doctrine.`
    : `   It prints the front door's absolute path on this machine, installing
   the package first if it has to; the \`aeg-root/\` directory above it is
   the full doctrine.`
  return `<!-- ${MANAGED_NOTE} -->
# Vinaya doctrine — read this first

This repo is governed by Vinaya: obligations that would otherwise depend on
an agent following instructions run as functions instead, layered in three
enforcement rings (the full model is inside the doctrine — see "Where the
full doctrine lives" below).

- **Ring 0 (hooks)** — always on, never configurable. Every commit and push
  runs the registered checks locally, before anything reaches the forge.
- **Ring 1 (branch rules)** — always on. The forge re-runs the identical
  checks as CI on every pull request and blocks merge while any is red —
  the backstop for writers the local hooks can't reach (web UI, other
  tools, humans).
- **Ring 2 (audits)** — always on. Forge-scheduled, after merge,
  continuous: drift (archive state, dead-branch-push, direct-main-push) is
  surfaced as findings regardless of who or what wrote it.

\`${CONFIG_PATH}\`'s \`rings\` block does not switch these on or off — every
ring above runs unconditionally, for every adopter, by default.
\`ring1_forgeWriteInterception\` and \`ring2_asyncAudits\` are opt-in
**accelerators**, not on/off switches: \`false\` or absent (the default) is a
no-op — the real work above keeps running exactly as described above;
\`true\` skips only the non-security-critical part of that ring's work once
you've outgrown it (brief-schema validation for ring 1; dead-branch-push
bookkeeping for ring 2). Neither flag ever disables direct-main-push
detection — that stays unconditional by design.

## Your role

Pick the role you're working as and load its doctrine before doing
anything substantive:

    vinaya doctrine --role <name>

prints the absolute path to that role's doctrine — \`architect\`,
\`developer\`, \`reviewer\`, \`planner\`, \`security\`, \`archivist\`,
\`tranche-archivist\`, or \`principal\`. If your agent tool
supports slash-style commands, the same doctrine is likely exposed as
\`/vinaya <role>\` — check your tool's command list before falling back to
the raw CLI form.

Regardless of role, load the front door first, every session: run
\`vinaya doctrine\` with no \`--role\` (see "Where the full doctrine lives"
below for what that resolves to).

## Where governance lives in this repo

- **\`${CONFIG_PATH}\`** — the ruleset: the two accelerator flags above, the
  registered \`checks\`, the \`roles\` overrides/additions, and the brief
  schema a PR/Issue body must satisfy.
- **\`${TRACKED_HOOK_DIR}\`** and **\`${DOC_OWNERS_PATH}\`** — the installed
  git-hook scripts (ring 0) and the code-to-doc coherence manifest.

## How to see what's running

- \`vinaya check --plan\` — prints the resolved check registry and the
  resolved \`roles\` registry (default / overridden / additive), without
  running anything.
- \`vinaya doctor\` — reports what is installed and diagnoses hook, workflow,
  and config health. Report only; it never mutates.

## How to extend

- \`vinaya new check <yourname>/<id>\` — scaffolds a custom check into
  \`./scripts/vinaya-checks/\` and prints the \`checks\` entry to paste into
  \`${CONFIG_PATH}\`.
- \`vinaya new noop-check <core-check-id>\` — the only sanctioned way to
  silence a core check: scaffolds an explicit, contract-satisfying no-op
  into \`vinaya/checks/\` and prints the \`checks\` entry that REPLACES the
  core check with it.
- \`vinaya new role <yourname>/<id>\` — scaffolds an additive role contract
  into \`vinaya/roles/\` and prints the \`roles\` entry to paste into
  \`${CONFIG_PATH}\`. A role's contract can also be overridden by hand from
  \`${CONFIG_PATH}\`'s \`roles\` block. What a contract must satisfy is
  documented inside the resolved doctrine below.

## Security

Each check's child process receives a fixed safe baseline (\`PATH\`, \`LANG\`,
\`HOME\`, \`HTTPS_PROXY\`, \`HTTP_PROXY\`, \`NO_PROXY\`, \`TMPDIR\`) plus only what
its \`env\` declaration explicitly forwards — never the full parent
environment. That default is a breaking-change tightening from forwarding
everything; \`vinaya doctor\` flags a check that reads \`process.env\` directly
without declaring one. A literal \`env\` value lives in this committed,
reviewed file — it must never be a secret. The audit trail this buys
(every governed write traceable to a reviewed commit) holds only where
pull request review is actually enforced on this repo; Vinaya does not
enforce that for you.

## Where the full doctrine lives

The full, canonical doctrine (roles, contracts, the state machine, the ring
gates) ships inside the installed \`@attalabs/vinaya\` npm package itself — no
in-repo copy to drift. This pointer names that package, never a filesystem
path: where a package sits is a property of one machine, and this file is
committed for every clone.

The doctrine's own front door is \`aeg-root/skills/aeg/SKILL.md\` inside that
package — read first every session regardless of role. Resolve it on this
machine with:

    ${resolveCmd}

${resolveNote}

Live task status is derived from the forge (Issues, labels, comments) via
\`vinaya check\` — it is never written into a file here.
`
}

// ---------------------------------------------------------------------------
// Doc-ownership manifest (root .vinaya/doc-owners) — the starter for the C5
// coherence seam. Grammar reproduced from this monorepo's own doc-owners
// header (format line, glob syntax, pointer forms, coverage rule, no-doc
// escape hatch, dormancy note) so an adopter learns the file by reading it.
// Ships with zero real bindings — an adopter's bindings are theirs to add.
// ---------------------------------------------------------------------------
function starterDocOwners(): string {
  return `# ${MANAGED_NOTE}
#
# ${DOC_OWNERS_PATH} — code → doc bindings for the coherence seam.
#
# Format: one binding per line, CODEOWNERS-shaped.
#     <code-glob>  <doc-pointer>
# Whitespace-separated. Lines starting with \`#\` and blank lines are ignored.
#
# Glob syntax (kept deliberately simple — no character classes):
#   \`**\`  matches any sequence (including \`/\`)
#   \`*\`   matches any sequence not containing \`/\`
#   every other character is literal — so dynamic-route segments like
#   \`[username]\` match literally, no escaping required.
#
# Pointer forms:
#   in-repo path             e.g. \`docs/my-feature.md\`
#   in-repo path with anchor e.g. \`docs/my-feature.md#section-2\`
#   URL                      e.g. \`https://example.com/docs/x\`
#
# Coverage rule (enforced by C5, the doc-owners check bundled into \`vinaya check\`):
#   When a code file in the PR matches a glob:
#     - in-repo pointer  → that path must appear in the PR diff, else FAIL
#     - URL pointer      → require a \`Doc-ack: <pointer> — <note>\` PR-body line
#     - dangling pointer → in-repo pointer that does not exist on disk: FAIL
#   Escape:
#     A PR-wide \`vinaya/waiver:docs\` label whose labeling timeline event's
#     actor is a configured principal suppresses every fired binding for that
#     PR — a forge-authenticated human act, never a parseable string. There is
#     no PR-body waiver field; label presence alone is never sufficient.
#
# Dormancy:
#   This file absent, OR no glob matches any changed code file → silent no-op.
#   The gate has no opinion until you teach it one.
#
# \`vinaya doctor\` (never \`vinaya check\`) separately reports — it does not
# fail the check — any binding whose code glob matches zero tracked files
# anywhere in the repo, or whose in-repo pointer doesn't exist on disk. This
# catches what the dormancy rule above structurally cannot: a glob matching
# nothing trivially satisfies "no changed file matched" on every diff,
# forever, so a binding naming deleted or renamed code reads as healthy
# indefinitely unless something walks the whole repo, not just one diff.
#
# ── No-doc allow-list ───────────────────────────────────────────────────────
# Surfaces that legitimately need no bound doc are listed below. Format:
#   # no-doc: <glob> — <reason>
# These lines exempt the matching directory from the completeness scoreboard
# (\`vinaya check\`'s advisory output). They do NOT affect C5 enforcement — if a
# binding exists for a surface, C5 still fires on changed files regardless of
# any no-doc line. Use no-doc for scaffold-only, config-only, or stub-only
# surfaces where adding a doc-owners binding would be meaningless busywork.
# To un-exempt a surface, remove its no-doc line and add a real binding.
#
# This starter ships empty — no bindings, no no-doc entries. Add your own
# below this line as your repo grows real code → doc coverage needs.
`
}

// ---------------------------------------------------------------------------
// Labels — create-if-absent, existing never modified (amendment-4 manifest).
// Names and the fixed set come from the code-owned vocabulary
// (`@attalabs/aeg-core`'s re-exported `LABELS`), never written here as
// literals, so an adopter's repo is seeded with exactly the namespaced set
// this repo runs on. Every `form: 'literal'` entry is seeded — the ONE
// exception is the `tranche` key (`form: 'prefix'`): its suffix is
// open-ended by design (cut per-tranche, not at install), so it has its own
// creation path in `packages/aeg-core/bin/open-issue.ts` instead. Metadata
// is a `Record` keyed by every literal `LabelKey`, so a future addition to
// `LABELS` fails to typecheck here until it is given a color + description —
// the exact 6-of-16 gap this task closes cannot silently reopen.
// ---------------------------------------------------------------------------
type LabelMeta = { color: string; description: string }

const FIXED_LABEL_METADATA: Record<Exclude<LabelKey, 'tranche'>, LabelMeta> = {
  blocked: { color: 'e11d21', description: 'Execution halted pending an external unblock' },
  backlog: { color: 'ededed', description: 'Deliberately unplanned — belongs to no tranche until promoted' },
  'tier-0': { color: 'ededed', description: 'Trivial / mechanical change' },
  'tier-1': { color: 'c5def5', description: 'Standard task — code + tests + docs' },
  'tier-3': { color: 'd93f0b', description: 'Records a decision; ratification-gated' },
  'needs-execution-input': { color: 'fbca04', description: 'Blocked on a missing execution detail' },
  'needs-strategy-input': { color: 'fbca04', description: 'Blocked on a strategy/approach decision' },
  'needs-principal-input': { color: 'b60205', description: 'Blocked on a Principal decision' },
  'needs-brief-correction': {
    color: 'fbca04',
    description: 'Blocked on the Planner — brief contradicts the surface'
  },
  'waiver-docs': { color: '0e8a16', description: 'Doc-coverage gate excused for this PR (principal-applied)' },
  'waiver-review': { color: '0e8a16', description: 'Review gate excused for this PR (principal-applied)' },
  'override-docs': {
    color: '5319e7',
    description: 'Whole verify-docs gate suppressed for this PR (principal-only)'
  },
  incoherent: { color: 'e99695', description: 'Closed COMPLETED with no merged-PR link — needs a human look' },
  'direct-main-push': { color: 'b60205', description: 'A commit landed on main with no associated merged PR' },
  'dead-branch-push': {
    color: 'fbca04',
    description: 'Commits landed on a branch after its PR already resolved'
  },
  'state-object': { color: 'ededed', description: 'A permanent forge-native storage object — never actionable work' },
  'type-build': { color: 'bfd4f2', description: 'Build system, packaging, or external dependency change' },
  'type-chore': { color: 'fef2c0', description: 'Maintenance / repo housekeeping — no functional change' },
  'type-docs': { color: '0075ca', description: 'Documentation-only change' },
  'type-feat': { color: '0e8a16', description: 'Adds a capability that did not exist before' },
  'type-fix': { color: 'd93f0b', description: 'Corrects incorrect behavior' },
  'type-perf': { color: 'fbca04', description: 'Performance or resource-use improvement, same behavior' },
  'type-refactor': { color: 'c5def5', description: 'Restructures code with no external behavior change' },
  'type-revert': { color: 'e11d21', description: 'Undoes a previous change' },
  'type-style': { color: 'f9d0c4', description: 'Formatting / naming change with no logic change' },
  'type-test': { color: 'bfdadc', description: 'Adds or corrects test coverage, no production-code change' }
}

export function labelOps(): CreateLabelOp[] {
  const g = 'Labels (create-if-absent; existing labels never modified)'
  return LABELS.filter((l) => l.form === 'literal').map((l) => {
    const meta = FIXED_LABEL_METADATA[l.key as Exclude<LabelKey, 'tranche'>]
    return { kind: 'create-label', name: l.id, color: meta.color, description: meta.description, group: g }
  })
}

const BRANCH_PROTECTION_NOTE = `Recommended (run yourself — vinaya never applies branch protection):

  gh api -X PUT repos/{owner}/{repo}/branches/main/protection \\
    -F required_pull_request_reviews.required_approving_review_count=1 \\
    -F required_status_checks.strict=true \\
    -F 'required_status_checks.contexts[]=vinaya-checks' \\
    -F enforce_admins=true -F restrictions=`

// Workflow files run with elevated trust — vinaya-review.yml's
// pull_request_target boundary loads them from THIS branch, not the PR's,
// specifically so a PR cannot rewrite the check that judges it. An
// unreviewed edit to that file on the default branch defeats the whole
// boundary from the other side. Printed guidance only, same reasoning as
// BRANCH_PROTECTION_NOTE and for the same reason vinaya never WRITES the
// CODEOWNERS entry itself: `principals` already had one incident from a
// hardcoded identity leaking into every adopter as a wrong default
// (review-gate.ts's own module comment) — an unreviewed guess at whose
// GitHub login belongs in every adopter's committed CODEOWNERS file would
// repeat that mistake in a more visible, harder-to-miss place. The
// adopter's own login(s) are theirs to choose.
const CODEOWNERS_NOTE = `Recommended: require review on vinaya's own workflow files.

  echo '/.github/workflows/** @your-github-login' >> .github/CODEOWNERS

Then add this flag to the branch-protection command above:

  -F required_pull_request_reviews.require_code_owner_reviews=true`

// review-gate and the actor-verified doc/review waivers trust
// `vinaya.config.json`'s `principals` array (`resolvePrincipalAllowlist`,
// lib/config.ts) — when it is unset, EVERY repo falls back to the same
// hardcoded placeholder (`PRINCIPAL_ALLOWLIST`, this monorepo's own
// maintainer). A fresh `vinaya init` never sets `principals` itself — same
// "vinaya never guesses an identity into committed config" reasoning as
// BRANCH_PROTECTION_NOTE/CODEOWNERS_NOTE above — which means every adopter's
// very first PR fails review-gate silently: two clean human verdicts land,
// neither counts, and the only signal is a cryptic DANGLING reason on the
// gate itself (found live: a first-time adopter's PR #6, two real APPROVE/
// PASS verdicts both ignored, zero warning anywhere in `init`'s output).
const PRINCIPALS_NOTE = `Recommended: without this, review-gate trusts nobody's verdicts on this repo.

  Add to vinaya.config.json:
    "principals": ["<your-github-login>"]

Anyone reviewing a PR here (code-reviewer/security verdicts, the
vinaya/waiver:review label) must be listed, or their comments are ignored
and every PR reads as unreviewed. \`vinaya doctor\` reports when this is unset.`

// ---------------------------------------------------------------------------
// Op builders
// ---------------------------------------------------------------------------

/** The full forward change-set for `vinaya init`. */
export function buildInitOps(ctx: InitContext): Op[] {
  const ops: Op[] = []
  const hookMode = 0o755

  // Workflows (refuse-if-foreign create-file).
  ops.push({
    kind: 'create-file',
    path: CHECKS_WORKFLOW_PATH,
    content: checksWorkflow(ctx.selfHost, ctx.ciSetup),
    group: 'CI workflows'
  })
  ops.push({
    kind: 'create-file',
    path: REVIEW_WORKFLOW_PATH,
    content: reviewWorkflow(ctx.selfHost),
    group: 'CI workflows'
  })
  ops.push({
    kind: 'create-file',
    path: REVIEW_RETRIGGER_WORKFLOW_PATH,
    content: reviewRetriggerWorkflow(),
    group: 'CI workflows'
  })
  ops.push({
    kind: 'create-file',
    path: REVIEW_VERDICT_WORKFLOW_PATH,
    content: reviewVerdictWorkflow(ctx.selfHost),
    group: 'CI workflows'
  })
  ops.push({
    kind: 'create-file',
    path: ARCHIVIST_WORKFLOW_PATH,
    content: archivistWorkflow(ctx.selfHost),
    group: 'CI workflows'
  })
  ops.push({
    kind: 'create-file',
    path: BODY_CHECKS_WORKFLOW_PATH,
    content: bodyChecksWorkflow(ctx.selfHost),
    group: 'CI workflows'
  })

  // Git hooks (marker-delimited managed blocks; never clobber).
  ops.push({
    kind: 'managed-block',
    path: `${ctx.hookDir}/pre-commit`,
    marker: 'pre-commit',
    body: preCommitBody(ctx.selfHost),
    comment: 'hash',
    hostPreamble: HOOK_PREAMBLE,
    mode: hookMode,
    group: 'Git hooks'
  })
  ops.push({
    kind: 'managed-block',
    path: `${ctx.hookDir}/pre-push`,
    marker: 'pre-push',
    body: prePushBody(ctx.selfHost),
    comment: 'hash',
    hostPreamble: HOOK_PREAMBLE,
    mode: hookMode,
    group: 'Git hooks'
  })
  ops.push({
    kind: 'managed-block',
    path: `${ctx.hookDir}/commit-msg`,
    marker: 'commit-msg',
    body: commitMsgBody(ctx.selfHost),
    comment: 'hash',
    hostPreamble: HOOK_PREAMBLE,
    mode: hookMode,
    group: 'Git hooks'
  })
  if (ctx.hookDir === TRACKED_HOOK_DIR) {
    ops.push({
      kind: 'print',
      message:
        `Hooks are installed into the TRACKED ${TRACKED_HOOK_DIR}/ directory — commit them so they\n` +
        'travel with the repo. This working copy is armed via `git config core.hooksPath\n' +
        `${TRACKED_HOOK_DIR}\` (shared config — covers every linked worktree). Each fresh clone\n` +
        'runs that one command once; `vinaya doctor` reports it whenever it is missing.',
      group: 'Git hooks'
    })
  }

  // Config (refuse-if-foreign). Content is the seed WITHOUT `managed`; the
  // installer rewrites it with the ownership manifest injected after apply.
  ops.push({
    kind: 'create-file',
    path: CONFIG_PATH,
    content: `${JSON.stringify(starterConfig(), null, 2)}\n`,
    group: 'Config (starter ruleset)'
  })

  // Doctrine pointer — root VINAYA.md, the only orientation artifact.
  ops.push({
    kind: 'create-file',
    path: DOCTRINE_POINTER_PATH,
    content: doctrinePointer(ctx.selfHost),
    group: 'Doctrine pointer'
  })

  // Doc-ownership manifest — root .vinaya/doc-owners starter.
  ops.push({
    kind: 'create-file',
    path: DOC_OWNERS_PATH,
    content: starterDocOwners(),
    group: 'Doc-ownership manifest'
  })

  // Empty scaffold folders (task 8) — `new noop-check`/`new role` write
  // real content beside these placeholders later.
  ops.push({
    kind: 'create-file',
    path: CHECKS_FOLDER_PLACEHOLDER_PATH,
    content: scaffoldFolderPlaceholder('vinaya/checks/', 'vinaya new noop-check'),
    group: 'Scaffold folders'
  })
  ops.push({
    kind: 'create-file',
    path: ROLES_FOLDER_PLACEHOLDER_PATH,
    content: scaffoldFolderPlaceholder('vinaya/roles/', 'vinaya new role'),
    group: 'Scaffold folders'
  })

  // Agent-native entry points (task 5, #152) — each opt-in via `ctx.agents`,
  // absent entirely (no op, not a skipped one) for a vendor not selected, so
  // `doctor` never reports a deliberately-excluded vendor as "missing".
  if (ctx.agents.has('skills')) {
    const doctrineRoot = resolveDoctrineRoot()
    if (!doctrineRoot) {
      throw new Error(
        'vinaya init: --agents includes "skills" but no bundled doctrine was found next to this CLI install — ' +
          'cannot discover agent-skill roles. Reinstall @attalabs/vinaya, or run bundle-doctrine first in a repo ' +
          'that vendors the CLI.'
      )
    }
    ops.push(...buildAgentsSkillsOps(doctrineRoot, ctx.selfHost))
  }
  if (ctx.agents.has('claude')) {
    ops.push(...buildClaudeCommandOps(ctx.selfHost))
    ops.push(...buildClaudeStopHookOps())
  }
  if (ctx.agents.has('gemini')) {
    ops.push(buildGeminiCommandOp(ctx.selfHost))
  }

  // The agent-native entry points above all invoke a bare `vinaya doctrine`
  // — `.claude/commands/vinaya.md`'s `allowed-tools: Bash(vinaya doctrine *)`
  // needs that literal short prefix to permission-match without a prompt
  // (see claude-command-emitter.ts's module doc), so this note explains the
  // prerequisite instead of changing the invocation shape. `vinaya init`
  // never installs itself anywhere — a bare `vinaya` resolves only if it's
  // separately on PATH. Found live: a fresh install's `/vinaya <role>` and
  // every `.agents/skills/vinaya-*/SKILL.md` failed "command not found" on
  // their very first use, with nothing in `init`'s own output warning it.
  //
  // Message names only the files THIS install actually wrote — a
  // gemini-only repo (no `claude` in `ctx.agents`) never had a working
  // `/vinaya <role>` slash command to begin with, so telling it that one
  // broke names a file it doesn't have while leaving its real affected
  // file (`.gemini/commands/vinaya.toml`) unmentioned (code review, PR #279).
  if (ctx.agents.size > 0) {
    const affected: string[] = []
    if (ctx.agents.has('claude')) affected.push('the `/vinaya <role>` command (.claude/commands/vinaya.md)')
    if (ctx.agents.has('gemini')) affected.push('the `/vinaya` command (.gemini/commands/vinaya.toml)')
    if (ctx.agents.has('skills')) affected.push('every .agents/skills/vinaya-*/SKILL.md file')
    ops.push({
      kind: 'print',
      message:
        'The agent-native commands above (`vinaya doctrine`) need `vinaya` resolvable on PATH:\n\n' +
        '  npm install -g @attalabs/vinaya\n\n' +
        `Without a global install, ${affected.join(' and ')} fail "command not found" the first time an agent ` +
        'tries to use them.',
      group: 'Agent-native commands (printed, never applied)'
    })
  }

  // Labels.
  ops.push(...labelOps())

  // Branch protection — printed only, never applied.
  ops.push({ kind: 'print', message: BRANCH_PROTECTION_NOTE, group: 'Branch protection (printed, never applied)' })
  ops.push({ kind: 'print', message: CODEOWNERS_NOTE, group: 'Branch protection (printed, never applied)' })
  ops.push({ kind: 'print', message: PRINCIPALS_NOTE, group: 'Review trust (printed, never applied)' })

  return ops
}

// ---------------------------------------------------------------------------
// `vinaya init product <name>` — why there is no op-builder here
// ---------------------------------------------------------------------------
/*
 * It writes ONE thing, and it is not an `Op`.
 *
 * There used to be a `buildInitProductOps` returning a single
 * `project:<name>` label. It is gone (#72). Project is a **field, not a
 * label** — the `project:*` family was retired outright, `declaredProjects`
 * (`issue-validation.ts`) reads the Issue body's `**Project:**` field, and
 * `@attalabs/aeg-forge-state`'s `list-tasks.ts` explicitly ignores a residual
 * `project:*` label. So the command's only forge-reaching op created a label
 * that no shipped consumer read, while making an otherwise purely local
 * command require a GitHub remote and credentials.
 *
 * What it does write is the `.vinaya/projects.md` row — a SEPARATE local
 * write (`lib/registry-write.ts`, called from `runInitProduct` in
 * `commands/init.ts`), never modeled as an `Op` here, and deliberately not
 * recorded in the ownership manifest: the registry is adopter-declared data,
 * not vinaya-owned scaffolding, so `eject` does not reverse it. Vinaya
 * Studio's tranche board reads it.
 *
 * Existing repos keep whatever `project:*` labels they already have; nothing
 * deletes a forge label that may be in use elsewhere.
 */

export { BRANCH_PROTECTION_NOTE }
