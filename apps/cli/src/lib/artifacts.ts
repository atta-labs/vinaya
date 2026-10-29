// The install manifest, made concrete.
//
// Every artifact `vinaya init` writes into an adopter repo lives here as
// content + a typed `Op` (see lib/ops.ts). Naming and collision rules follow
// a 2026-07-23 MINIMAL-MANIFEST re-ruling: **init installs only
// what a shipped check or ring-2 mechanism consumes.** The manifest is
// `vinaya.config.json` (starter ruleset, `checks: {}` empty), the
// `vinaya-` workflows (checks, review, and its verdict split,
// body checks, the archivist's ring-2 post-merge/scheduled jobs, and the
// task-log collector that gives task-path CI evidence a credentialed
// publisher), git-hook managed blocks, a root
// `AGENTS.md` doctrine pointer with the `CLAUDE.md` that imports it, an empty
// `.vinaya/doc-owners` starter manifest, and labels. Everything else
// the earlier amendment-4 manifest carried (GitHub templates, the
// governance/ scaffold, example check scripts) was this monorepo's own
// operational apparatus, not product surface — no shipped check consumes
// it, so it is cut from the installer.
//
// The starter ruleset seeded into `vinaya.config.json` is EXTRACTED from this
// repo's own battle-tested gates, not invented blanks — the failure it
// kills is blank-config paralysis.

import { DOC_OWNERS_PATH, LABELS, type LabelKey, VERDICT_MARKER_SOURCE, WAIVER_LABEL_REVIEW } from '@attalabs/aeg-core'
import { resolveDoctrineRoot } from '../commands/doctrine.js'
import type { AgentVendor } from './agent-vendors.js'
import { buildAgentsSkillsOps, discoverRoleNames } from './agents-skills-emitter.js'
import { claudeMcpJsonFile } from './task-tools/adapters.js'
import {
  BODY_CHECKS_WORKFLOW_PATH,
  CHECKS_WORKFLOW_PATH,
  REVIEW_VERDICT_WORKFLOW_PATH,
  REVIEW_WORKFLOW_PATH
} from './managed-workflow-paths.js'
import { buildClaudeCommandOps } from './claude-command-emitter.js'
import { buildClaudeStopHookOps } from './claude-stop-hook-emitter.js'
import type { VinayaConfig } from './config.js'
import { buildGeminiCommandOp } from './gemini-command-emitter.js'
import { type HookDir, TRACKED_HOOK_DIR } from './init-hook-paths.js'
import type { CreateLabelOp, Op } from './ops.js'
import { ownVersion } from './own-version.js'
import { REVIEW_GATE_WORKFLOW_NAME } from './review-gate-check-name.js'
import { ADOPTER_TEST_RUNNER, NO_LOCAL_TESTS_MARKER } from './pre-push-test-runner.js'
import { READY_TESTS_DEFERRED_LINE } from './pre-push-ready-policy.js'
import type { VendoredVinaya } from './self-host.js'

export { type HookDir, TRACKED_HOOK_DIR } from './init-hook-paths.js'

export type InitContext = {
  owner: string
  repo: string
  /** where the git-hook stubs are installed (husky if present, else raw) */
  hookDir: HookDir
  /**
   * The workspace member declaring `@attalabs/vinaya`, when the repo being
   * written into vendors the CLI itself — `null` for the ordinary
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
   * The `--agents` vendor selection — which of the three
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
// Root AGENTS.md — the doctrine pointer. Root placement and the name are the
// whole point: each agent vendor auto-loads one project file at session
// start, and Codex reads `AGENTS.md` there. Claude Code reads `CLAUDE.md`
// instead (and `AGENTS.md` only when no `CLAUDE.md` exists anywhere above),
// so a two-line `CLAUDE.md` imports the pointer rather than copying it; Gemini
// CLI reads whatever context file its project settings name, so
// `.gemini/settings.json` names this one. One text, three readers.
export const DOCTRINE_POINTER_PATH = 'AGENTS.md'
export const CLAUDE_POINTER_PATH = 'CLAUDE.md'
export const GEMINI_SETTINGS_PATH = '.gemini/settings.json'
// The pointer's former name — a file no agent vendor reads, so no session
// ever loaded it unprompted. No longer generated: `upgrade` removes a copy the
// manifest still records, and `eject` removes it like any recorded file.
export const RETIRED_DOCTRINE_POINTER_PATH = 'VINAYA.md'
// The three files above, as one set: an install that predates them never
// recorded them, so `upgrade` writes each one that is absent (never one an
// adopter already has) and `doctor` points a missing one at `upgrade`.
export const DOCTRINE_POINTER_PATHS: readonly string[] = [
  DOCTRINE_POINTER_PATH,
  CLAUDE_POINTER_PATH,
  GEMINI_SETTINGS_PATH
]
export { BODY_CHECKS_WORKFLOW_PATH, CHECKS_WORKFLOW_PATH, REVIEW_VERDICT_WORKFLOW_PATH, REVIEW_WORKFLOW_PATH }
export const ARCHIVIST_WORKFLOW_PATH = '.github/workflows/vinaya-archivist.yml'
export const TASK_LOG_COLLECTOR_WORKFLOW_PATH = '.github/workflows/vinaya-task-log-collector.yml'
// Empty scaffold folders — `vinaya new noop-check` writes into
// `vinaya/checks/`, `vinaya new role` writes into `vinaya/roles/`. Git does
// not track empty directories, so each folder is represented by one
// placeholder file — the existing whole-file manifest grammar already
// covers this exactly (no new `Op` kind needed), and `eject` reverses it
// the same way it reverses every other file `init` owns.
export const CHECKS_FOLDER_PLACEHOLDER_PATH = 'vinaya/checks/.gitkeep'
export const ROLES_FOLDER_PLACEHOLDER_PATH = 'vinaya/roles/.gitkeep'
// Claude's project-root MCP registration for the task-tools server. Strict
// JSON, so — like `.claude/settings.json` — it is a refuse-if-foreign whole
// file, never a managed block, and it is written only
// when `claude` is one of the selected agent vendors. The Codex equivalent
// (`~/.codex/config.toml` `[mcp_servers]`) is a user-home file, not a repo
// artifact, so it is documented in `apps/cli/specs/self-hosting.md` rather than
// emitted here.
export const MCP_JSON_PATH = '.mcp.json'

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
    // Ring 1 (forge-write interception) and Ring 2 (async audits) are on by
    // default — `true` runs them, `false` opts a repo out. Ring 0 (git
    // hooks) and the CI guarantee are non-negotiable and deliberately
    // absent from the schema.
    rings: { ring1_forgeWriteInterception: true, ring2_asyncAudits: true },
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
// workflows via `vinayaRun`, the two git hooks via `hookRun`, and a rendered
// task brief via `briefCliInvocation`. It lives in `lib/own-version.ts`, whose
// own comment carries the whole why: why exact, and never bare or `@latest`.
// Re-exported here because this module was its home before the brief renderer
// needed it too, and `lib/brief-assembly.ts` cannot import this file without
// closing an import cycle through the task-tools server.
// ---------------------------------------------------------------------------
export { ownVersion } from './own-version.js'

// ---------------------------------------------------------------------------
// Workflow files (four, all refuse-if-foreign, all vinaya-prefixed)
//
// How the CI jobs reach the vinaya binary has TWO shapes, chosen at generation
// time from `ctx.selfHost`:
//
//   - ordinary adopter (`selfHost: null`) — `npx --yes
//     @attalabs/vinaya@<exact-installed-version>`, no build step. An adopter
//     has no local copy to build and must not pay for a problem they do not
//     have, so the shape stays npx; the version spec is exact for the reason
//     in `ownVersion()` (lib/own-version.ts).
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
 * Restores Bun's install cache — keyed on whichever lockfile the repo
 * actually has, text `bun.lock` or the legacy binary `bun.lockb`;
 * `hashFiles` silently ignores whichever one is absent — before a
 * `bun install --frozen-lockfile`. Caches only the download cache, never the
 * built `dist` (the build itself costs seconds and must never be trusted
 * across a trust boundary); a second workflow installing
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
 * The last step of every generated job: when the job failed, it prints that
 * job's own token budgets — REST (`core`) and GraphQL — on one marker line,
 * read through \`gh api rate_limit\`, which spends neither. The review loop
 * reads this line off a failed job's log tail to tell a red that is GitHub's
 * rate limit from a real failure, and to learn when that budget resets: the
 * loop host's own token is a different token with a different reset, and it
 * cannot read this one's. The line never carries GitHub's rate-limit wording
 * itself, and \`|| true\` keeps a failed read from failing the job twice.
 */
export function budgetMarkerStep(): string {
  return `      # When this job failed, print its own token budgets on one line for
      # the review loop (\`apps/cli/specs/loop.md\`). Reading them spends none.
      - name: Report this job's GitHub token budget
        if: failure()
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          gh api rate_limit --jq '${BUDGET_MARKER_JQ}' || true
`
}

/** The \`jq\` program behind \`budgetMarkerStep\`: one \`vinaya-budget:\` line naming the spent budget (\`core\` first) and both budgets' remaining count and reset epoch. */
const BUDGET_MARKER_JQ =
  '.resources as $r | "vinaya-budget: exhausted=\\(if $r.core.remaining == 0 then "core" elif $r.graphql.remaining == 0 then "graphql" else "none" end) core_remaining=\\($r.core.remaining) core_reset=\\($r.core.reset) graphql_remaining=\\($r.graphql.remaining) graphql_reset=\\($r.graphql.reset)"'

/**
 * The steps that make the vinaya binary available, emitted directly after
 * `setup-node` at 6-space step indentation. Empty for the ordinary adopter —
 * `npx` needs no preparation.
 */
type WorkflowSourceTrust = 'pull-request' | 'trusted'

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

/** Where a job keeps its forge snapshot (`lib/forge-snapshot.ts`): the runner's temp directory, which a checkout never touches. Shell steps reach it as `$RUNNER_TEMP/vinaya-forge-snapshot`. */
const FORGE_SNAPSHOT_DIR = '${{ runner.temp }}/vinaya-forge-snapshot'

/** The artifact `vinaya-body-checks.yml`'s read job hands its snapshot to both check jobs under. */
export const FORGE_SNAPSHOT_ARTIFACT_NAME = 'vinaya-forge-snapshot'

/** The \`jq\` program a failed read prints both budgets with — remaining, limit and reset, and which one is spent. */
const READ_FAILURE_BUDGET_JQ =
  '.resources as $r | "::error::GitHub REST (core) budget: \\($r.core.remaining) of \\($r.core.limit) left, resets at \\($r.core.reset | todate)\\(if $r.core.remaining == 0 then " - spent, so GitHub rate-limited this read" else "" end); GraphQL budget: \\($r.graphql.remaining) of \\($r.graphql.limit) left, resets at \\($r.graphql.reset | todate)\\(if $r.graphql.remaining == 0 then " - spent" else "" end)."'

/**
 * One of the two steps every generated job opens and closes with: the
 * GraphQL budget's used count, written to the job's summary page, so one
 * push's summaries show what each job spent. Reading it spends nothing
 * (\`gh api rate_limit\`), and a failed read writes that it failed rather than
 * failing the job. Concurrent jobs share the budget, so a job's own delta is
 * an upper bound.
 */
export function graphqlBudgetStep(at: 'start' | 'end'): string {
  return `      - name: Record the GraphQL budget at job ${at}
${at === 'end' ? '        if: ${{ !cancelled() }}\n' : ''}        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          gh api rate_limit --jq '"GraphQL budget at job ${at}: \\(.resources.graphql.used) used of \\(.resources.graphql.limit), resets at \\(.resources.graphql.reset | todate)"' >> "$GITHUB_STEP_SUMMARY" || echo "GraphQL budget at job ${at}: unreadable" >> "$GITHUB_STEP_SUMMARY"
`
}

/**
 * The read of the pull request and its comments, once per run, over REST
 * (\`gh api repos/{owner}/{repo}/pulls/<n>\` and the paged
 * \`.../issues/<n>/comments\` listing — never \`gh pr view\`, which spends the
 * GraphQL budget), into \`raw/\` of the job's forge snapshot directory.
 * \`vinaya pr snapshot\` (\`forgeSnapshotStep\`) then turns those files into the
 * snapshot the checks read. A failed or refused read fails the step, naming
 * what it read and both token budgets, so no check ever runs on a body that
 * was never read.
 *
 * Read live from the forge, never from the event payload: a rerun of an old
 * run must read the pull request as it stands NOW, not as it stood when the
 * triggering event fired.
 *
 * \`waitForCloses\` keeps the one re-read a run makes, and the only reason it
 * reads the pull request more than once. A single read is a race: \`pr report
 * --push\` (or a plain \`pr edit\`) can land on the forge in the gap between
 * the workflow's trigger firing and its read, so the run reads a body from
 * BEFORE that write finished — measured live, repeatedly, each red on
 * \`closes-n\` with a body the workflow's own log later showed was correct,
 * green on the very next run with no code change. Every real task PR already
 * passed \`closes-n\` at WRITE time (\`runBodyChecks\`, O1) before it could
 * exist on the forge at all, so a missing/malformed \`AEG:CLOSES\` region here
 * is never a legitimate, permanent state for a task branch — it is this exact
 * race, and it is safe to wait a few seconds for it to resolve. Bounded — six
 * attempts, five seconds apart (thirty seconds total) — and loud on
 * exhaustion: names exactly what it waited for rather than quietly running
 * the check suite against a body it already knows may be stale.
 *
 * Never waits for the \`AEG:EVIDENCE\` block's \`Head:\` to catch up. The
 * checks and body-checks workflows trigger on \`opened\`/\`reopened\`/\`edited\`
 * only, never \`synchronize\` (see each workflow's own \`on:\` block), so a
 * push landing after their run started cannot race it. The review workflow's
 * \`evidence-fresh\` job does run on \`synchronize\`, and a red there is the
 * point: a body whose recorded head lags the branch fails that check until
 * the body edit naming the pushed head re-runs it on \`edited\`.
 */
function pullRequestReadStep(opts: { name: string; id?: string; prNumber: string; waitForCloses: boolean }): string {
  const read = `gh api "repos/{owner}/{repo}/pulls/$PR_NUMBER" > "$RAW/pull.json" 2> "$RAW/read-error.txt" || fail_read "pull request #$PR_NUMBER"`
  const readPull = opts.waitForCloses
    ? `          ATTEMPTS=0
          MAX_ATTEMPTS=6
          SLEEP_SECONDS=5
          while :; do
            ${read}
            BODY="$(jq -r '.body // ""' "$RAW/pull.json")"
            WAIT_FOR=""
            if [[ "$BRANCH" =~ ^task/[^/]+/[^/]+$ ]]; then
              CLOSES_REGION="$(printf '%s\\n' "$BODY" | sed -n '/<!-- AEG:CLOSES:START -->/,/<!-- AEG:CLOSES:END -->/p')"
              if ! printf '%s\\n' "$CLOSES_REGION" | grep -qE '#[0-9]+'; then
                WAIT_FOR="a real Closes #N inside the AEG:CLOSES region for task branch $BRANCH"
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
`
    : `          ${read}
`
  return `      - name: ${opts.name}
${opts.id ? `        id: ${opts.id}\n` : ''}        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          GH_REPO: \${{ github.repository }}
          PR_NUMBER: ${opts.prNumber}
${opts.waitForCloses ? '          BRANCH: ${{ github.head_ref }}\n' : ''}        run: |
          set -o pipefail
          RAW="$RUNNER_TEMP/vinaya-forge-snapshot/raw"
          mkdir -p "$RAW"
          fail_read() {
            echo "::error::Reading $1 over the REST API failed: $(cat "$RAW/read-error.txt" 2>/dev/null)" >&2
            gh api rate_limit --jq '${READ_FAILURE_BUDGET_JQ}' >&2 || echo "::error::The token budget could not be read either." >&2
            exit 1
          }
${readPull}          gh api --paginate --slurp "repos/{owner}/{repo}/issues/$PR_NUMBER/comments?per_page=100" > "$RAW/pull-comments.json" 2> "$RAW/read-error.txt" || fail_read "pull request #$PR_NUMBER's comments"
`
}

/**
 * Turns the read step's \`raw/\` files into the forge snapshot
 * (\`vinaya pr snapshot\`), reading the task Issue the body closes and its
 * comments over REST on the way; fails, naming both budgets, when a read
 * does. With \`exportBody\` it also exports \`PR_BODY\` for the steps after it,
 * from the same REST body \`PR_BODY_FILE\` names. The snapshot directory itself
 * is handed only to the step that runs checks, never through
 * \`$GITHUB_ENV\`: a later step that writes to the forge and re-reads must
 * read live.
 */
function forgeSnapshotStep(selfHost: VendoredVinaya | null, opts: { exportBody: boolean }): string {
  const exportBody = opts.exportBody
    ? `          DELIM="PR_BODY_$(openssl rand -hex 16)"
          {
            echo "PR_BODY<<$DELIM"
            cat "$RUNNER_TEMP/vinaya-forge-snapshot/body.md"
            echo
            echo "$DELIM"
          } >> "$GITHUB_ENV"
`
    : ''
  return `      - name: Write the forge snapshot
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          GH_REPO: \${{ github.repository }}
        run: |
          ${vinayaRun(selfHost, 'pr snapshot')} --dir "$RUNNER_TEMP/vinaya-forge-snapshot"
${exportBody}`
}

/** The env lines that hand the snapshot to the step that runs checks — the directory and the body file. */
const FORGE_SNAPSHOT_CHECK_ENV = `          # The run's forge snapshot (\`lib/forge-snapshot.ts\`): the checks read
          # the pull request and its task Issue from it instead of reading the
          # forge for them again. Set on this step only.
          VINAYA_FORGE_SNAPSHOT_DIR: ${FORGE_SNAPSHOT_DIR}
          PR_BODY_FILE: ${FORGE_SNAPSHOT_DIR}/body.md
`

/**
 * The step that resolves the diff base for the checks job. On a
 * \`pull_request\` run the checkout is the pull request merged into the base
 * branch's tip as that merge was built, so the merge's first parent is the
 * exact commit the checked-out tree diffs against; the event's own base commit
 * goes stale as soon as the base branch moves past it, and a diff against it
 * counts the base branch's later commits as the pull request's own. A \`HEAD\`
 * that is not a merge commit falls back to the event's base. The value is
 * validated as a full commit id before it reaches \`$GITHUB_ENV\`, so no
 * value can carry a second variable in on a newline.
 */
function diffBaseStep(): string {
  return `      - name: Resolve the diff base
        env:
          EVENT_BASE_SHA: \${{ github.event.pull_request.base.sha }}
        run: |
          if git rev-parse --verify -q HEAD^2 > /dev/null; then
            BASE="$(git rev-parse HEAD^1)"
            SOURCE="the checked-out merge commit's first parent"
          else
            BASE="$EVENT_BASE_SHA"
            SOURCE="the event's base commit, because HEAD is not a merge commit"
          fi
          if [[ ! "$BASE" =~ ^[0-9a-f]{40}$ ]]; then
            echo "::error::The diff base from $SOURCE is not a full commit id." >&2
            exit 1
          fi
          echo "Diff base: $BASE, from $SOURCE."
          echo "BASE_SHA=$BASE" >> "$GITHUB_ENV"
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
    types: [opened, reopened, edited]

# No \`synchronize\` above: a push's own \`vinaya pr
# report --push\` always follows it with a body edit (\`gh pr edit\`) carrying
# that push's real head, which fires \`edited\` — the only trigger left this
# workflow needs, against a body that already names the new head. A push
# with no following edit produces no run of this workflow, by design;
# \`evidence-fresh\` still runs on every push, as its own job in
# \`vinaya-review.yml\`, which triggers on \`synchronize\` and \`edited\`.
#
# Several \`types:\` above can still fire in the same instant — \`vinaya pr
# create\` opens the PR and applies its tranche label immediately after, so
# \`opened\` and \`labeled\` arrive together and GitHub starts TWO runs of this
# workflow. Both then report under the same check name, and the merge box
# counts both: one can go green while its twin holds a stale red, which no
# later verdict clears because each run only ever re-evaluates itself.
# Measured live on atta-labs/vinaya#18 — two runs created in the same
# second, one success, one failure, PR blocked with both reviews already
# approved.
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
    steps:
${graphqlBudgetStep('start')}      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          # The job builds and runs code from this checkout, and the default
          # writes GITHUB_TOKEN into .git/config as an http extraheader —
          # readable by anything the build executes. Nothing here pushes.
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 22
${vinayaSetupSteps(selfHost)}${adopterSetupStep(ciSetup)}      # PR_BODY is what makes test-plan/closes-n/pr-report-density EVALUATE:
      # none of the three fetches the body itself (all read
      # \`process.env.PR_BODY\`) — without it they read "no body — nothing to
      # check" and pass vacuously regardless of the PR's real content, on
      # every run. The pull request, its comments, the task Issue its body
      # closes and that Issue's comments are read once, over REST, into the
      # forge snapshot the checks read — see \`pullRequestReadStep\`'s own doc
      # comment for why the read is live and re-reads with a bounded backoff.
${pullRequestReadStep({ name: 'Read the pull request over REST', prNumber: '${{ github.event.pull_request.number }}', waitForCloses: true })}${forgeSnapshotStep(selfHost, { exportBody: true })}${diffBaseStep()}      - name: Run checks
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
${FORGE_SNAPSHOT_CHECK_ENV}          BRANCH: \${{ github.head_ref }}
          # The pull request's own head — never \`git rev-parse HEAD\`, which on
          # a pull_request run is the merge ref — at which \`test-plan\` demands
          # a passed \`AEG:LIVE\` entry for each \`[live]\` line of the brief.
          PULL_REQUEST_HEAD_SHA: \${{ github.event.pull_request.head.sha }}
          # BASE_SHA comes from the job environment \`Resolve the diff base\`
          # wrote — never set here, where a step-level entry would override it.
          # O3: this job's gate events deliver live to the \`logs.url\` server
          # destination the default branch's own \`vinaya.config.json\`
          # declares — never a fork PR's own working-tree copy
          # (\`resolveTrustAnchorLogsDestination\`). VINAYA_UNATTENDED is what
          # makes that gate apply here at all; without it this run would be
          # classified attended and would honour the PR's own diff directly.
          VINAYA_UNATTENDED: '1'
          # A write-only ingest token, never a value this job can use to read
          # anything back — GitHub withholds every repository secret from a
          # fork-originated pull_request run, so this resolves to an empty
          # string there. \`log()\` treats an empty/absent value referenced by
          # a configured \`logs.headers\` entry as "no credential" and records
          # nothing for this run, naming why, rather than delivering with a
          # blank credential or silently falling back to this ephemeral
          # runner's own disk.
          VINAYA_LOG_TOKEN: \${{ secrets.VINAYA_LOG_TOKEN }}
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
${graphqlBudgetStep('end')}${budgetMarkerStep()}`
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
# The required review gate, and the push-time run of \`evidence-fresh\`.
# \`pull_request_target\` is the trust boundary: GitHub loads this workflow
# and its default checkout from the repository's default branch, never from
# the pull request being judged. Neither job checks out, installs, builds, or
# executes pull-request content. The review job fetches none of it; the
# \`evidence-fresh\` job fetches the pull request head's commits as git
# objects only, so \`git diff\` and \`git merge-base\` can read them, and
# runs the CLI built from the default-branch checkout over them.
#
# The verdict-comment
# half lives in its own workflow (vinaya-review-verdict.yml): a new PR
# comment fires a different GitHub event that this
# workflow structurally cannot receive — and keeping the comment path in a
# separate FILE means this workflow's runs never list permanently-skipped
# comment jobs on the PR's checks panel. When a clean final verdict lands,
# that workflow re-runs this one, so the required check below goes green
# natively with no manual rerun.
#
# Nothing re-runs this workflow when CI completes, and nothing needs to:
# the review gate answers for the review verdicts, \`evidence-fresh\` for
# the body's \`AEG:EVIDENCE\` block against the pushed head, and no other
# check's result can change either answer, so a CI run finishing tells
# neither anything.
#
# \`synchronize\` is what runs \`evidence-fresh\` on every push, so a push
# with no following body edit turns its check-run red instead of producing
# no run at all; \`edited\` re-runs it on the body edit \`vinaya pr report
# --push\` makes after that push, so a body naming the pushed head turns the
# same check-run green with no manual rerun.
#
# The job's first steps never build: they read the PR, its comments and its
# labels through the REST API alone — the same read the forge snapshot the
# gate later evaluates is written from, so the run reads them once — and fail
# fast, without checkout or build, whenever
# neither a \`VERDICT:\` comment nor a (presence-only, unverified) waiver
# label exists yet — the ordinary state on \`opened\`/\`synchronize\`/
# \`reopened\`/\`edited\`/\`labeled\`/\`unlabeled\`. The build runs once that step finds
# either: a verdict, which in practice is the state a rerun finds it in (the
# verdict-comment workflow re-runs THIS run, and by the time it fires, the
# verdict this job is looking for already exists) — or a \`labeled\` event
# applying the waiver label itself, so a
# waived PR goes green on the SAME push that applies the label rather than
# waiting on a verdict that will never arrive (\`#525\`: found live minutes
# after this pre-check step was first added — PR #517's Version Packages
# PR, carrying the waiver label, went red at the gate in four seconds,
# never having learned the waiver the full gate downstream already
# honoured).
name: ${REVIEW_GATE_WORKFLOW_NAME}
run-name: "${REVIEW_GATE_WORKFLOW_NAME} PR #\${{ github.event.pull_request.number }} @ \${{ github.event.pull_request.head.sha }}"

on:
  pull_request_target:
    types: [opened, synchronize, reopened, edited, labeled, unlabeled]

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
${graphqlBudgetStep('start')}      # No checkout, no build: read whether a verdict exists yet, or an
      # actor-verified \`vinaya/waiver:review\` label is present, from the REST
      # read just above. Absent both, THIS step fails — the job's own single
      # check-run ("vinaya review gate") goes red with the reason below and
      # every step after it is skipped, so an ordinary push (opened /
      # synchronize / reopened / edited / labeled / unlabeled) never pays for
      # a build it cannot use. Deliberately a step of this job, never a job of
      # its own: a pre-check job would report a second review check-run name,
      # and \`REVIEW_GATE_CHECK_RUN_NAME\`
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
${pullRequestReadStep({ name: 'Read the pull request over REST', prNumber: '${{ github.event.pull_request.number }}', waitForCloses: false })}      - name: Require a verdict or waiver before building
        id: verdict-check
        env:
          PR_NUMBER: \${{ github.event.pull_request.number }}
        run: |
          set -o pipefail
          RAW="$RUNNER_TEMP/vinaya-forge-snapshot/raw"
          HAS_VERDICT=$(jq '[.[][] | (.body // "") | select((. / "\\n") | any(test("${verdictMarkerForJq}")))] | length > 0' "$RAW/pull-comments.json")
          HAS_WAIVER_LABEL=$(jq '[.labels[].name == "${WAIVER_LABEL_REVIEW}"] | any' "$RAW/pull.json")
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
          node-version: 22
${vinayaSetupSteps(selfHost, 'trusted')}${forgeSnapshotStep(selfHost, { exportBody: false })}      - name: Review gate
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          # PR_NUMBER is what makes the review-gate check EVALUATE: without
          # it the adapter reads "no PR yet — local dev" and exits 0, and
          # the gate is green regardless of review state.
          PR_NUMBER: \${{ github.event.pull_request.number }}
${FORGE_SNAPSHOT_CHECK_ENV}        run: ${vinayaRun(selfHost, 'check review-gate')}
${graphqlBudgetStep('end')}${budgetMarkerStep()}
  # \`evidence-fresh\` on every push, under its own check-run name. The
  # checks workflow never triggers on \`synchronize\`, so without this job a
  # push followed by no body edit produced no \`evidence-fresh\` run at all.
  # It carries no \`if:\`: a skipped job reports success for the same head,
  # which would replace a red result.
  #
  # Default-branch code only: the checkout is the default branch, the CLI is
  # built from it, and the pull request head's commits are fetched as git
  # objects for \`git diff\` and \`git merge-base\` to read — never checked
  # out, installed, built or executed. The check reads the head from the same
  # forge snapshot the fetch step read it from, so both name one commit.
  vinaya-evidence-fresh:
    name: vinaya check evidence-fresh
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
      issues: read
    steps:
${graphqlBudgetStep('start')}      - uses: actions/checkout@v4
        with:
          # Explicit trusted ref: never use the PR head/merge ref in this job.
          ref: \${{ github.event.repository.default_branch }}
          persist-credentials: false
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
${vinayaSetupSteps(selfHost, 'trusted')}${pullRequestReadStep({ name: 'Read the pull request over REST', prNumber: '${{ github.event.pull_request.number }}', waitForCloses: true })}${forgeSnapshotStep(selfHost, { exportBody: true })}${pullRequestHeadFetchStep()}      - name: Evidence freshness
        env:
          # \`principals\` is read from the default branch over the forge, so
          # this step needs the token even with the snapshot in hand.
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          # PR_NUMBER is what makes evidence-fresh EVALUATE: without it the
          # check reads "no PR yet" and exits 0.
          PR_NUMBER: \${{ github.event.pull_request.number }}
          # The commit the pull request targets, for the merge-base the diff
          # stat is recomputed from.
          BASE_SHA: \${{ github.event.pull_request.base.sha }}
${FORGE_SNAPSHOT_CHECK_ENV}        run: ${vinayaRun(selfHost, 'check evidence-fresh')}
${graphqlBudgetStep('end')}${budgetMarkerStep()}`
}

/**
 * Fetches the pull request head the forge snapshot recorded, by sha, as git
 * objects into the default-branch checkout — nothing is checked out. The
 * job's read-only token authenticates this one \`git fetch\` through
 * \`GIT_CONFIG_*\` variables scoped to the command, so it never reaches
 * \`.git/config\` or the command line. Fails when the commit is still absent
 * afterwards, so the check never recomputes a diff against a head it cannot
 * read.
 */
function pullRequestHeadFetchStep(): string {
  return `      - name: Fetch the pull request head as git objects
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          set -o pipefail
          HEAD_SHA="$(jq -r '.head.sha // ""' "$RUNNER_TEMP/vinaya-forge-snapshot/raw/pull.json")"
          if ! [[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]; then
            echo "::error::The pull request read recorded no head commit sha." >&2
            exit 1
          fi
          AUTH="$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)"
          echo "::add-mask::$AUTH"
          GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraheader GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $AUTH" \\
            git fetch --no-tags --quiet origin "$HEAD_SHA"
          git cat-file -e "$HEAD_SHA^{commit}"
`
}

function bodyChecksWorkflow(selfHost: VendoredVinaya | null): string {
  return `# ${MANAGED_NOTE}
#
# Required, PR-content-independent checks that need a trust anchor no pull
# request can rewrite. \`pull_request_target\` is the same boundary
# \`vinaya-review.yml\` uses: GitHub loads this workflow and its default
# checkout from the repository's default branch, never from the pull
# request being judged. No job fetches, checks out, installs, builds, or
# executes pull-request content — every check registered here reads only
# live-fetched PR metadata, never the diff or repo tree, the same shape
# \`review-gate\` already requires of its own checks.
#
# That metadata is read once per run: the \`vinaya-forge-read\` job reads the
# pull request, its comments, the task Issue its body closes and that Issue's
# comments over REST into the forge snapshot, and both check jobs take it as
# this run's own artifact. Each check job needs the read job and runs with
# \`!cancelled()\`, so a failed read fails both required checks by name on
# their first step instead of skipping them. Re-run the whole run, not only
# the failed jobs, to read the pull request afresh.
#
# \`body-bare-digits\`: its Changesets-release
# exemption live-fetches the PR's real author, keyed on \`PR_NUMBER\` — on a
# \`pull_request\` trigger that value is PR-editable (the PR's own workflow
# YAML controls it), so an attacker could redirect it to any
# already-approved PR by the configured release actor. Found live (round 5,
# security review, PR #165), and verified no env-var or git-state signal
# inside a \`pull_request\` job closes it — \`pull_request_target\` does,
# because the workflow text assigning \`PR_NUMBER\` comes from THIS file on
# the default branch, which a pull request cannot edit.
#
# \`principal-test-plan-wait\`: reported by its own job, never by the
# aggregate \`check --all\`, so its red can never turn another check's name
# red. This file's own \`on: pull_request_target: types: [opened, reopened,
# edited]\` trigger is what re-evaluates it on a PR body edit — ticking a
# \`[principal]\` box re-runs this job, where before, enforcement living
# inside \`review-gate\` meant a body edit retriggered nothing.
name: Vinaya Body Checks
run-name: "Vinaya Body Checks PR #\${{ github.event.pull_request.number }} @ \${{ github.event.pull_request.head.sha }}"

on:
  pull_request_target:
    types: [opened, reopened, edited]

# Same collapsing rationale as \`vinaya-review.yml\`'s concurrency group — see
# that file's own comment for the two measured failure modes (duplicate
# runs from simultaneous event types; an old rerun cancelling the current
# commit's run) this group exists to prevent.
concurrency:
  group: vinaya-body-checks-\${{ github.event.pull_request.number || github.ref }}-\${{ github.event.pull_request.head.sha || github.sha }}
  cancel-in-progress: true

jobs:
  # The one read of the pull request this run makes: the pull request, its
  # comments, the task Issue its body closes and that Issue's comments, over
  # REST, into the forge snapshot — handed to both check jobs below as this
  # run's own artifact, so neither job reads the forge for them again.
  vinaya-forge-read:
    name: vinaya read pull request
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: read
      pull-requests: read
    steps:
${graphqlBudgetStep('start')}      - uses: actions/checkout@v4
        with:
          # Explicit trusted ref: never use the PR head/merge ref in this job.
          ref: \${{ github.event.repository.default_branch }}
          persist-credentials: false
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
${vinayaSetupSteps(selfHost, 'trusted')}${pullRequestReadStep({ name: 'Read the pull request over REST', prNumber: '${{ github.event.pull_request.number }}', waitForCloses: true })}${forgeSnapshotStep(selfHost, { exportBody: false })}      - name: Share the forge snapshot with the check jobs
        uses: actions/upload-artifact@v4
        with:
          name: ${FORGE_SNAPSHOT_ARTIFACT_NAME}
          path: ${FORGE_SNAPSHOT_DIR}
          if-no-files-found: error
          overwrite: true
          retention-days: 1
${graphqlBudgetStep('end')}${budgetMarkerStep()}
  vinaya-body-checks:
    name: vinaya check body-bare-digits
    needs: vinaya-forge-read
    # \`!cancelled()\`, never \`always()\` and never the default: a skipped job
    # counts as passing on the merge box, so this job runs when the read job
    # failed and fails on its own first step instead of skipping; a run the
    # concurrency group cancelled stays cancelled.
    if: \${{ !cancelled() }}
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
    steps:
${forgeReadRequiredStep()}${graphqlBudgetStep('start')}      - uses: actions/checkout@v4
        with:
          # Explicit trusted ref: never use the PR head/merge ref in this job.
          ref: \${{ github.event.repository.default_branch }}
          persist-credentials: false
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
${vinayaSetupSteps(selfHost, 'trusted')}${forgeSnapshotDownloadSteps()}      - name: Body checks
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          # PR_NUMBER is what makes the Changesets-release exemption
          # EVALUATE its pull request read: without it the check reads
          # "no PR yet — local dev" and falls through to the ordinary
          # bare-digit scan.
          PR_NUMBER: \${{ github.event.pull_request.number }}
${FORGE_SNAPSHOT_CHECK_ENV}        run: ${vinayaRun(selfHost, 'check body-bare-digits')}
${graphqlBudgetStep('end')}${budgetMarkerStep()}
  vinaya-principal-test-plan-wait:
    name: vinaya check principal-test-plan-wait
    needs: vinaya-forge-read
    # Same \`!cancelled()\` condition as the sibling job above, same reason.
    if: \${{ !cancelled() }}
    runs-on: ubuntu-latest
    permissions:
      contents: read
      # The task Issue's frozen brief, read for its \`[live]\` lines.
      issues: read
      pull-requests: read
    steps:
${forgeReadRequiredStep()}${graphqlBudgetStep('start')}      - uses: actions/checkout@v4
        with:
          # Explicit trusted ref: never use the PR head/merge ref in this job.
          ref: \${{ github.event.repository.default_branch }}
          persist-credentials: false
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
${vinayaSetupSteps(selfHost, 'trusted')}${forgeSnapshotDownloadSteps()}      - name: Principal Test Plan wait
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          BRANCH: \${{ github.head_ref }}
          # The pull request's own head, at which each \`[live]\` line of the
          # task's frozen brief must have passed for the merge to go through.
          PULL_REQUEST_HEAD_SHA: \${{ github.event.pull_request.head.sha }}
${FORGE_SNAPSHOT_CHECK_ENV}        run: ${vinayaRun(selfHost, 'check principal-test-plan-wait')}
${graphqlBudgetStep('end')}${budgetMarkerStep()}`
}

/**
 * The first step of each \`vinaya-body-checks.yml\` check job: it fails unless
 * the run's read job succeeded, so a failed or refused read reddens both
 * required checks by name instead of leaving them skipped — which the merge
 * box would count as passing.
 */
function forgeReadRequiredStep(): string {
  return `      - name: Require the pull request read
        env:
          READ_RESULT: \${{ needs.vinaya-forge-read.result }}
        run: |
          if [ "$READ_RESULT" != "success" ]; then
            echo "::error::The pull request read job ended '$READ_RESULT', so this check has no pull request to evaluate. Its own log names the failed read; re-run the whole workflow run." >&2
            exit 1
          fi
`
}

/**
 * The read job's snapshot, downloaded into this job's own forge snapshot
 * directory from the same run's artifact, then \`PR_BODY\` exported from its
 * body for the check step.
 */
function forgeSnapshotDownloadSteps(): string {
  return `      - name: Download the forge snapshot
        uses: actions/download-artifact@v4
        with:
          name: ${FORGE_SNAPSHOT_ARTIFACT_NAME}
          path: ${FORGE_SNAPSHOT_DIR}
      - name: Export the pull request body
        run: |
          DELIM="PR_BODY_$(openssl rand -hex 16)"
          {
            echo "PR_BODY<<$DELIM"
            cat "$RUNNER_TEMP/vinaya-forge-snapshot/body.md"
            echo
            echo "$DELIM"
          } >> "$GITHUB_ENV"
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
${graphqlBudgetStep('start')}${pullRequestReadStep({ name: 'Read the pull request over REST', prNumber: '${{ github.event.issue.number }}', waitForCloses: false })}      # issue_comment payloads carry no PR head SHA — resolve it, from the REST
      # read just above, for immutable run identity only. It never selects
      # executable code.
      - name: Resolve PR head
        id: pr
        run: |
          NUMBER="\${{ github.event.issue.number }}"
          SHA=$(jq -r '.head.sha' "$RUNNER_TEMP/vinaya-forge-snapshot/raw/pull.json")
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
          node-version: 22
${vinayaSetupSteps(selfHost, 'trusted')}${forgeSnapshotStep(selfHost, { exportBody: false })}      - name: Review gate (verdict evaluation)
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          # Same wiring as the required workflow: PR_NUMBER is what makes
          # the adapter evaluate instead of no-op'ing as "local dev".
          PR_NUMBER: \${{ steps.pr.outputs.number }}
${FORGE_SNAPSHOT_CHECK_ENV}        run: ${vinayaRun(selfHost, 'check review-gate')}
${graphqlBudgetStep('end')}${budgetMarkerStep()}
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
${graphqlBudgetStep('start')}      - name: Re-run the required review gate for this branch
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
${graphqlBudgetStep('end')}${budgetMarkerStep()}`
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
# + close-out (post-merge), tranche self-archive when a task Issue closes
# without a merge (issue-closed), dead-branch-push drift and the daily
# tranche catch-up (daily-drift, a notification channel — never fails red),
# and direct-main-push detection
# (direct-main-push-detection, a real pass/fail).
name: Vinaya Archivist

on:
  push:
    branches: [main]
  issues:
    types: [closed]
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
${graphqlBudgetStep('start')}      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          # The job builds and runs code from this checkout, and the default
          # writes GITHUB_TOKEN into .git/config as an http extraheader —
          # readable by anything the build executes. Nothing here pushes.
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 22
${vinayaSetupSteps(selfHost)}      - name: Run vinaya archive
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: ${vinayaRun(selfHost, 'archive')} --merge-sha=\${{ github.sha }}
      - name: Self-archive the tranche once its last task merges (O4)
        # \`vinaya archive tranche\` already IS the "any open task Issue left"
        # check (\`trancheArchivalStatus\`) — this step never re-derives that
        # rule, it only resolves which slug just merged and asks. Refusing
        # (exit 1) while task Issues remain open is the expected outcome on
        # every non-final task merge, never a reason to fail this job.
        continue-on-error: true
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          PR_NUMBER="$(gh api repos/\${{ github.repository }}/commits/\${{ github.sha }}/pulls --jq '.[0].number // empty')"
          if [ -z "$PR_NUMBER" ]; then exit 0; fi
          BRANCH="$(gh api "repos/\${{ github.repository }}/pulls/$PR_NUMBER" --jq .head.ref)"
          SLUG="$(printf '%s' "$BRANCH" | sed -n 's#^task/\\([^/]*\\)/.*#\\1#p')"
          if [ -z "$SLUG" ]; then exit 0; fi
          ${vinayaRun(selfHost, 'archive tranche')} "$SLUG" --yes
${graphqlBudgetStep('end')}${budgetMarkerStep()}
  issue-closed:
    name: Tranche Self-Archive (task Issue closed)
    # A task Issue closed by hand — dropped, replaced, or moved — merges no
    # pull request, so the post-merge job never runs for it and a tranche whose
    # last open task closed this way would never archive. The slug comes from
    # the Issue's own \`vinaya/tranche:\` label, never from a branch name: a
    # hand-closed task has no task branch. The job checks out and builds the
    # default branch only — an \`issues\` event carries no pull-request code —
    # and its one write permission is \`issues: write\`.
    if: github.event_name == 'issues' && contains(join(github.event.issue.labels.*.name, ','), 'vinaya/tranche:')
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: write
      pull-requests: read
    steps:
${graphqlBudgetStep('start')}      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          # The job builds and runs code from this checkout, and the default
          # writes GITHUB_TOKEN into .git/config as an http extraheader —
          # readable by anything the build executes. Nothing here pushes.
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 22
${vinayaSetupSteps(selfHost)}      - name: Self-archive the tranche this Issue belongs to
        # \`vinaya archive tranche\` already IS the "any open task Issue left"
        # check — refusing (exit 1) while task Issues remain open is the
        # expected outcome on every close but the last, never a reason to fail
        # this job. The Issue number is the only event field read, and the
        # labels are re-read from the forge, so no label text reaches a shell
        # unquoted.
        continue-on-error: true
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          ISSUE_NUMBER: \${{ github.event.issue.number }}
        run: |
          SLUGS="$(gh api "repos/\${{ github.repository }}/issues/$ISSUE_NUMBER" --jq '.labels[].name | select(startswith("vinaya/tranche:")) | ltrimstr("vinaya/tranche:")')"
          for SLUG in $SLUGS; do
            case "$SLUG" in ''|-*|*[!A-Za-z0-9._-]*) continue ;; esac
            ${vinayaRun(selfHost, 'archive tranche')} "$SLUG" --yes
          done
${graphqlBudgetStep('end')}${budgetMarkerStep()}
  daily-drift:
    name: Daily Drift Check (dead-branch pushes)
    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: write
      pull-requests: write
    steps:
${graphqlBudgetStep('start')}      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          # The job builds and runs code from this checkout, and the default
          # writes GITHUB_TOKEN into .git/config as an http extraheader —
          # readable by anything the build executes. Nothing here pushes.
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 22
${vinayaSetupSteps(selfHost)}      - name: Run vinaya audit --only=dead-branches
        continue-on-error: true # never-red — this job is a notification channel, not a gate
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: ${vinayaRun(selfHost, 'audit --only=dead-branches')}
      - name: Archive every finished tranche not yet archived
        # The catch-up the two event-driven triggers cannot make: a tranche that
        # finished before this workflow existed, or whose closing event was
        # missed, is archived here within a day. A tranche still holding an open
        # task Issue is skipped, and archiving what is already archived changes
        # nothing, so the schedule can call it every day.
        continue-on-error: true
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: ${vinayaRun(selfHost, 'archive tranches')} --yes
${graphqlBudgetStep('end')}${budgetMarkerStep()}
  direct-main-push-detection:
    name: Direct-Main-Push Detection
    if: (github.event_name == 'push' && github.ref == 'refs/heads/main') || github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: write
      pull-requests: read
    steps:
${graphqlBudgetStep('start')}      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          # The job builds and runs code from this checkout, and the default
          # writes GITHUB_TOKEN into .git/config as an http extraheader —
          # readable by anything the build executes. Nothing here pushes.
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 22
${vinayaSetupSteps(selfHost)}      - name: Run vinaya audit --only=direct-push
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: ${vinayaRun(selfHost, 'audit --only=direct-push')} --sha=\${{ github.sha }}
${graphqlBudgetStep('end')}${budgetMarkerStep()}`
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
// A real fix addressed this for the four generated workflows and left
// the two hook emitters on the published spec; this is that remainder. Same
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
 * someone's commit is worse than one that tells them what to run. The
 * dev-review-loop driver is the deliberate exception outside this hook: it
 * builds a missing vendored CLI before making its own publication commit, so
 * the hook itself remains a pure gate and never spends that build.
 */
// `VINAYA_HOST=hook` marks every gate observation
// emitted from THIS invocation as `meta.host: 'hook'` — never inferred after
// the fact, since a bare `vinaya check` run outside a hook is otherwise
// indistinguishable from one run BY a hook (both would read `host: 'cli'`,
// `log-sink.ts`'s own fallback). CI needs no equivalent: `GITHUB_ACTIONS` is
// already set by the platform, and `hostFromEnv` reads it first.
function hookRun(selfHost: VendoredVinaya | null, args: string): string {
  if (!selfHost) return `VINAYA_HOST=hook npx --yes @attalabs/vinaya@${ownVersion()} ${args} || exit 1`
  return `# This repo vendors the CLI, so \`npx @attalabs/vinaya\` resolves to its own
# unbuilt workspace member. Run the built file instead.
if [ ! -f ${selfHost.bin} ]; then
  echo "vinaya: ${selfHost.bin} is missing — run \\\`bun run --cwd ${selfHost.dir} build\\\`" >&2
  exit 1
fi
VINAYA_HOST=hook node ${selfHost.bin} ${args} || exit 1`
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

/** `bun <dir>/src/lib/<file>.ts` self-hosted, `npx --yes -p @attalabs/vinaya@<version> <bin>` for an adopter's real install — the same two-shape split `hookRun` already draws, for a script that isn't routed through the CLI's own argv dispatch at all. */
function libBinInvocation(selfHost: VendoredVinaya | null, file: string, bin: string): string {
  if (selfHost) return `bun ${selfHost.dir}/src/lib/${file}`
  return `npx --yes -p @attalabs/vinaya@${ownVersion()} ${bin}`
}

/**
 * The adopter's ready-mode test step (the contract is `pre-push-test-runner.ts`'s): after both reviewers approved,
 * the push runs the repository's declared test runner, or says plainly that it runs no local tests. Every other
 * push is unchanged. Nothing here names a toolchain: the runner is the adopter's own executable.
 */
function adopterReadyTests(): string {
  return `# The ready push (after approval) runs the repository's declared test
# runner, ${ADOPTER_TEST_RUNNER}: an executable run from the repository root
# with no arguments, whose exit status is the verdict. A repository that
# declares none runs no local tests, and says so.
if [ "$VINAYA_PUSH_MODE" = "ready" ]; then
  if [ -x ${ADOPTER_TEST_RUNNER} ]; then
    ./${ADOPTER_TEST_RUNNER} || { echo "vinaya pre-push: refused — the declared test runner (${ADOPTER_TEST_RUNNER}) failed"; exit 1; }
  else
    echo "${NO_LOCAL_TESTS_MARKER} (no test runner declared at ${ADOPTER_TEST_RUNNER})"
  fi
fi`
}

function prePushBody(selfHost: VendoredVinaya | null): string {
  const doctrineGate = `# Vinaya pre-push gate. Runs branch/dispatch checks before the push leaves.
# Forward git's own pre-push stdin (one "<local ref> <local sha> <remote
# ref> <remote sha>" line per ref being pushed) so main-branch-refusal can
# tell a tag-only push apart from one that also carries a branch ref.
VINAYA_PUSH_REFS="$(cat)"
export VINAYA_PUSH_REFS
${hookRun(selfHost, 'check --all --local')}`

  if (!selfHost)
    return `${doctrineGate}
${adopterReadyTests()}`

  // Gated on `selfHost`: only a repo vendoring `@attalabs/vinaya` as a
  // workspace member is assumed to run this repo's own Bun/Biome/Turborepo
  // toolchain — an ordinary adopter's push is not made to depend on
  // `biome`/`turbo` existing, the same line `preCommitBody`'s O9 block
  // already draws.
  //
  // O5, O6, O7 — three steps, in this order, replacing the
  // old single `turbo test --affected` line entirely:
  //
  // 1. O5: Biome lint+format on the files changed since the remote base —
  //    literally the hook's first step, before the doctrine gate and
  //    everything else, so a formatting slip never even reaches it (round-5
  //    ruling: "before anything else" is the hook's own first line, not
  //    merely first among the new O5/O6/O7 steps). Report-only (no
  //    `--write`): a push can't safely rewrite-and-restage the way the
  //    pre-commit hook's own staged-file fix does, since the commits are
  //    already made — the contributor fixes with `bunx biome check --write
  //    .` locally, same as CI's own message. Reads only git state (the
  //    remote-base diff) — never git's own pre-push stdin, so running it
  //    before the doctrine gate's `VINAYA_PUSH_REFS="$(cat)"` below leaves
  //    that read untouched.
  // 2. The doctrine gate (unchanged).
  // 3. O6: `turbo typecheck --affected` (unchanged mechanism) plus the new
  //    file-level test selector (`vinaya-select-tests`,
  //    `lib/pre-push-select-tests.ts`) — resolved through the REAL import
  //    graph of the files changed since that same remote base, never a
  //    folder heuristic (`lib/test-selector.ts`). Prints how many files it
  //    selected. O7: no `--concurrency=1` anywhere in this block — that
  //    guard was always a `turbo` flag bounding how many PACKAGES' own
  //    `bun test` subprocesses it ran at once; `bun test` itself has
  //    no concurrency flag of its own (confirmed against `bun test
  //    --help` — it runs whatever files it's handed as one job). This step
  //    never asks turbo to fan out a subprocess per affected package at
  //    all: the selector hands every selected file, across every affected
  //    package, to ONE `bun test` invocation — the exact resource
  //    contention the guard existed to bound (many concurrent `bun test`
  //    processes) cannot recur when there is only ever one. The full,
  //    unscoped affected suite stays CI's job, on the one push, exactly as
  //    before.
  return `# Ring 0 (O5): Biome over the files changed since the remote base —
# literally the hook's first step, before the doctrine gate and everything
# else that follows costs real time. The trailing "--" stops flag parsing
# before the file list, so a tracked file named like a Biome option is
# passed through as a literal path, never interpreted as one.
VINAYA_CHANGED_FILES="$(${libBinInvocation(selfHost, 'pre-push-changed-files.ts', 'vinaya-changed-files')})"
if [ -n "$VINAYA_CHANGED_FILES" ]; then
  echo "$VINAYA_CHANGED_FILES" | xargs bunx biome check --no-errors-on-unmatched -- || exit 1
fi
# The push mode: storage (a task-branch push while no pull request is open —
# cheap checks only, no typecheck, no tests; refused when one is open), ready
# (after both reviewers approved — the selected tests, measured against the
# default branch) or default (every other push, unchanged).
VINAYA_PUSH_MODE="$(${libBinInvocation(selfHost, 'pre-push-mode.ts', 'vinaya-push-mode')})" || exit 1
export VINAYA_PUSH_MODE
${doctrineGate}
if [ "$VINAYA_PUSH_MODE" = "storage" ]; then
  echo "vinaya pre-push: storage push — cheap checks only, no tests (no pull request is open)"
  exit 0
fi
# Ring 0 (O6): typecheck, then only the test files the real import graph
# says the changed files could affect.
bunx turbo typecheck --affected || exit 1
# A version-2 run's ready push, or its driver-owned repair push on its own
# open pull request, defers the selected tests to required current-head CI
# when the default branch opts in (prePush.readyTests) and the run's live
# driver marked this push. Every check above has already run; the selector,
# the test run and the test cache below do not. Anything else is "local".
VINAYA_READY_TESTS="$(${libBinInvocation(selfHost, 'pre-push-ready-policy.ts', 'vinaya-ready-policy')})" || exit 1
if [ "$VINAYA_READY_TESTS" = "deferred" ]; then
  echo "${READY_TESTS_DEFERRED_LINE} — local checks passed; the selected tests run in the required CI check on this head"
  exit 0
fi
VINAYA_SELECTED_TESTS="$(${libBinInvocation(selfHost, 'pre-push-select-tests.ts', 'vinaya-select-tests')})"
if [ -n "$VINAYA_SELECTED_TESTS" ]; then
  # A git hook's own invoking git sets GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE
  # for THIS repo — correct for every step above, which all operate on this
  # repo on purpose. A selected test that creates and operates on its OWN
  # throwaway git fixture elsewhere inherits those same variables unless it
  # explicitly overrides them, and GIT_DIR silently overrides discovery
  # regardless of that fixture's own directory — a real, load-bearing
  # incident, not a hypothetical: a fixture test with no remote of its own
  # resolved this branch's real upstream and landed several of its own
  # git commit calls as genuine commits on it, recoverable only via a hard
  # reset to the last real commit. Unset every GIT_* variable right before
  # the one step that can run arbitrary test-owned git fixtures — every
  # step above stays on this repo either way, since cwd-based discovery
  # finds the exact same repo these variables already named.
  #
  # The name pattern admits digits, not letters and underscores only: the
  # real git variables whose names carry one are exactly the ones a
  # letters-only pattern leaves behind for the test run to inherit —
  # \`GIT_CONFIG_KEY_0\`/\`GIT_CONFIG_VALUE_0\` (arbitrary config injected into
  # every fixture git call) and \`GIT_TRACE2\`/\`GIT_TRACE2_EVENT\` (trace
  # output interleaved into whatever a fixture test parses out of git's
  # own). Measured on a real push from a linked worktree: with a
  # letters-only pattern those three survived the loop and reached the
  # test run's own child processes.
  #
  # Reading names out of \`env\` cannot MISS a variable — a real one always
  # holds a line of its own — and an unrelated variable whose value spans
  # lines (a pull-request body, say) can at worst contribute a name that is
  # not set, which \`unset\` accepts as the no-op it is.
  for _vinaya_git_var in $(env | grep -o '^GIT_[A-Za-z0-9_]*='); do
    unset "\${_vinaya_git_var%=*}"
  done
  # The trailing "--" stops flag parsing before the file list: a tracked
  # file named like a global bun flag (e.g. "--preload=path", which loads
  # and executes an arbitrary module before tests run) would otherwise be
  # forwarded as that flag rather than a literal test-file path — confirmed
  # live against bun 1.2.14 without the separator. \`--timeout=30000\`
  # matches this repo's own \`apps/cli/package.json\` \`test\` script — a bare
  # \`bun test\` here would otherwise fall back to bun's 5-second default,
  # tight enough that a CLI-invocation test doing real subprocess and
  # filesystem work (a registered check's own gate observation, most
  # recently) can lose the race under nothing worse than ordinary host load.
  #
  # O6: captured to a file rather than piped straight through, so a refusal
  # can end with a clean summary — the count, the hook's own wall time and,
  # on a refusal, every failing test's file and title — instead of whatever
  # line \`bun test\` itself happened to print last. A caller that keeps only
  # the tail of a refused push's output (this loop's own driver among them)
  # sees the failing tests either way, never buried under a full run's
  # scrollback. \`date +%s\` (seconds, not \`%N\` nanoseconds) is the portable
  # choice across this hook's two real targets — GNU \`date\` on CI, BSD
  # \`date\` on a contributor's own Mac, which has no \`%N\` at all.
  VINAYA_TEST_LOG="$(mktemp)"
  VINAYA_TEST_STARTED=$(date +%s)
  # O3: the exact command text this run executes — reconstructed here,
  # before running it, so the SAME string is what gets cached below and
  # what a later PR-body Test-plan command line would need to match,
  # verbatim, to reuse this run instead of re-executing it.
  VINAYA_TEST_CMD="bun test --timeout=30000 -- $(printf '%s' "$VINAYA_SELECTED_TESTS" | tr '\\n' ' ')"
  echo "$VINAYA_SELECTED_TESTS" | xargs ${libBinInvocation(selfHost, 'pre-push-record-tests.ts', 'vinaya-record-tests')} run > "$VINAYA_TEST_LOG" 2>&1
  VINAYA_TEST_STATUS=$?
  cat "$VINAYA_TEST_LOG"
  VINAYA_TEST_ELAPSED=$(( $(date +%s) - VINAYA_TEST_STARTED ))
  VINAYA_SELECTED_COUNT=$(printf '%s\\n' "$VINAYA_SELECTED_TESTS" | grep -c .)
  if [ "$VINAYA_TEST_STATUS" -ne 0 ]; then
    # Re-run only what failed: record the failing files at this commit so
    # the next push runs those plus what the fix affects, not the whole
    # selection again. Best-effort, and STDERR only — the refusal summary
    # below stays the tail of this hook's own output.
    ${libBinInvocation(selfHost, 'pre-push-record-tests.ts', 'vinaya-record-tests')} failed "$VINAYA_TEST_LOG" "$VINAYA_TEST_ELAPSED" 1>&2 || true
    echo ""
    echo "vinaya pre-push: refused — selected \${VINAYA_SELECTED_COUNT} file(s), \${VINAYA_TEST_ELAPSED}s — failing tests:"
    # \`<path>.test.<ext>:\` is this repo's own per-file header (\`isTestFile\`'s
    # own convention) — the one line shape a real error/stack-trace line
    # never happens to end with, so the file a failing title belongs to is
    # never misattributed to an unrelated colon-terminated line above it.
    awk '
      /\\.test\\.[a-zA-Z]+:$/ { f = $0; sub(/:$/, "", f) }
      /^\\(fail\\) / { t = $0; sub(/^\\(fail\\) /, "", t); print "  " f ": " t }
    ' "$VINAYA_TEST_LOG"
    rm -f "$VINAYA_TEST_LOG"
    exit 1
  fi
  # O3: this exact run just proved green against this head/tree — cache it
  # (best-effort; a caching failure here never fails the push, since the
  # test run itself already succeeded) so a "pr report" evidence build for
  # the same head/tree naming the identical command reuses it rather than
  # running it again.
  ${libBinInvocation(selfHost, 'pre-push-cache-test-run.ts', 'vinaya-cache-test-run')} "$VINAYA_TEST_CMD" "$VINAYA_TEST_LOG" || true
  ${libBinInvocation(selfHost, 'pre-push-record-tests.ts', 'vinaya-record-tests')} passed "$VINAYA_TEST_LOG" "$VINAYA_TEST_ELAPSED" 1>&2 || true
  rm -f "$VINAYA_TEST_LOG"
  echo "vinaya pre-push: selected \${VINAYA_SELECTED_COUNT} file(s), \${VINAYA_TEST_ELAPSED}s — all green"
else
  # Nothing selected is a green run too: it clears a stale failed-tests record.
  ${libBinInvocation(selfHost, 'pre-push-record-tests.ts', 'vinaya-record-tests')} passed "" 0 1>&2 || true
fi`
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
// Doctrine pointer (root AGENTS.md, the only orientation artifact; CLAUDE.md
// and .gemini/settings.json only route their vendor's reader to it)
//
// MUST be a pure function of `selfHost` and the bundled doctrine's role files
// — never of where the CLI physically
// sits. This file is COMMITTED into the adopter's repo, so any
// `packageRoot()` interpolation makes its bytes a function of one machine's
// filesystem: teammates clone a pointer naming a directory that doesn't
// exist for them, the installer's home directory is published into the repo,
// and `doctor` (which diffs regenerated bytes against disk) reports drift on
// every machine except the installer's. The pointer
// therefore names the PACKAGE and hands the reader `vinaya doctrine` — the
// command that resolves the bundled doctrine at READ time, on the reader's
// own machine. The role list comes from the doctrine the package bundles,
// which is the same at one version on every machine.
//
// Every agent session loads this file at start, a dispatched one on every
// turn — keep it short.
// ---------------------------------------------------------------------------
export function doctrinePointer(selfHost: VendoredVinaya | null, roles: readonly string[]): string {
  // Same generation-time selection the workflows and hooks use: in a repo
  // that vendors the CLI, `npx @attalabs/vinaya` misresolves to the unbuilt
  // workspace member, so the reader is handed the
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

\`${CONFIG_PATH}\`'s \`rings\` block does not switch these three rings on or
off — every ring above runs unconditionally, for every adopter, by default.
\`ring1_forgeWriteInterception\` and \`ring2_asyncAudits\` name a narrower,
non-security-critical slice of that work each: \`true\` (or absent — the
default) runs it, exactly as described above; \`false\` opts OUT of that one
slice once you've outgrown it (brief-schema validation for ring 1;
the post-merge task archive and dead-branch-push bookkeeping for ring 2).
Neither flag ever disables
direct-main-push detection — that stays unconditional by design.

## Your role

Pick the role you're working as and load its doctrine before doing
anything substantive:

    vinaya doctrine --role <name>

prints the absolute path to that role's doctrine — ${formatRoleList(roles)}. If your agent tool
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

/** `\`a\``, `\`a\` or \`b\``, `\`a\`, \`b\`, or \`c\`` — the pointer's inline role list. */
function formatRoleList(roles: readonly string[]): string {
  const quoted = roles.map((role) => `\`${role}\``)
  if (quoted.length <= 1) return quoted.join('')
  if (quoted.length === 2) return `${quoted[0]} or ${quoted[1]}`
  return `${quoted.slice(0, -1).join(', ')}, or ${quoted[quoted.length - 1]}`
}

/**
 * The agent roles the pointer lists — discovered the way the skill emitter
 * discovers the roles it writes a skill for (`discoverRoleNames`: every
 * `roles/*.md` of the bundled doctrine, minus human-only and retired roles),
 * so a role added to or retired from the doctrine changes the pointer on the
 * next `upgrade`, and the pointer and the skills never disagree.
 */
export function pointerRoleNames(): string[] {
  const doctrineRoot = resolveDoctrineRoot()
  if (!doctrineRoot) {
    throw new Error(
      'vinaya: no bundled doctrine was found next to this CLI install — cannot list the roles the doctrine ' +
        `pointer (${DOCTRINE_POINTER_PATH}) names. Reinstall @attalabs/vinaya, or run bundle-doctrine first in a ` +
        'repo that vendors the CLI.'
    )
  }
  return discoverRoleNames(doctrineRoot)
}

// Root CLAUDE.md — Claude Code's start-of-session file. The import line loads
// `AGENTS.md` in full (Claude Code's documented `@path` import), so the
// pointer text lives once. Never a symlink: Windows checkouts break them.
export function claudePointer(): string {
  return `@${DOCTRINE_POINTER_PATH}

Run \`/vinaya <role>\` to load that role's doctrine for this session.
`
}

// .gemini/settings.json — Gemini CLI's project settings. `context.fileName`
// replaces Gemini's default `GEMINI.md`, so a Gemini session loads the same
// pointer Codex and Claude Code do. Strict JSON: a refuse-if-foreign whole
// file, like `.claude/settings.json` and `.mcp.json`.
export function geminiSettings(): string {
  return `${JSON.stringify({ context: { fileName: DOCTRINE_POINTER_PATH } }, null, 2)}\n`
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
// `vinaya.config.json`'s `principals` array (`resolveTrustedPrincipals`,
// lib/config.ts), read from the default branch — when it is unset there is no
// built-in Principal, and every Principal-deciding gate and command refuses
// until it lands. A fresh `vinaya init` never sets `principals` itself — same
// "vinaya never guesses an identity into committed config" reasoning as
// BRANCH_PROTECTION_NOTE/CODEOWNERS_NOTE above — which means every adopter's
// very first PR is refused by every Principal-deciding gate until the key is
// on the default branch — so this note names it at install time rather than
// leaving the first refusal as the only signal.
const PRINCIPALS_NOTE = `Required: without this, every gate and command that decides who counts as a
Principal (review-gate, the waiver labels, the Principal-only commands) refuses.

  Add to vinaya.config.json, in the install commit:
    "principals": ["<your-github-login>"]

It is read from the default branch only. Anyone reviewing a PR here
(code-reviewer/security verdicts, the vinaya/waiver:review label) must be
listed, or their comments do not count. \`vinaya doctor\` reports when this is unset.`

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

  // Doctrine pointer — root AGENTS.md, the only orientation artifact, and
  // the CLAUDE.md that imports it.
  ops.push({
    kind: 'create-file',
    path: DOCTRINE_POINTER_PATH,
    content: doctrinePointer(ctx.selfHost, pointerRoleNames()),
    group: 'Doctrine pointer'
  })
  ops.push({
    kind: 'create-file',
    path: CLAUDE_POINTER_PATH,
    content: claudePointer(),
    group: 'Doctrine pointer'
  })

  // Doc-ownership manifest — root .vinaya/doc-owners starter.
  ops.push({
    kind: 'create-file',
    path: DOC_OWNERS_PATH,
    content: starterDocOwners(),
    group: 'Doc-ownership manifest'
  })

  // Empty scaffold folders — `new noop-check`/`new role` write
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

  // Agent-native entry points — each opt-in via `ctx.agents`,
  // absent entirely (no op, not a skipped one) for a vendor not selected, so
  // `doctor` never reports a deliberately-excluded vendor as "missing".
  // Role skills land once per directory a host scans: `.agents/skills/` under
  // `skills`, `.claude/skills/` under `claude` — the same pointers, so both
  // vendors resolve the same bundled doctrine root.
  const skillsDoctrineRoot = (vendor: AgentVendor): string => {
    const doctrineRoot = resolveDoctrineRoot()
    if (!doctrineRoot) {
      throw new Error(
        `vinaya init: --agents includes "${vendor}" but no bundled doctrine was found next to this CLI install — ` +
          'cannot discover agent-skill roles. Reinstall @attalabs/vinaya, or run bundle-doctrine first in a repo ' +
          'that vendors the CLI.'
      )
    }
    return doctrineRoot
  }
  if (ctx.agents.has('skills')) {
    ops.push(...buildAgentsSkillsOps(skillsDoctrineRoot('skills'), ctx.selfHost, 'agents'))
  }
  if (ctx.agents.has('claude')) {
    ops.push(...buildAgentsSkillsOps(skillsDoctrineRoot('claude'), ctx.selfHost, 'claude'))
    ops.push(...buildClaudeCommandOps(ctx.selfHost))
    ops.push(...buildClaudeStopHookOps())
    // Claude's stdio MCP registration for the task-tools server (refuse-if-foreign
    // whole file, same treatment as `.claude/settings.json`).
    ops.push({
      kind: 'create-file',
      path: MCP_JSON_PATH,
      content: claudeMcpJsonFile(ctx.selfHost),
      group: 'Task-tools MCP server (Claude .mcp.json)'
    })
  }
  if (ctx.agents.has('gemini')) {
    ops.push(buildGeminiCommandOp(ctx.selfHost))
    ops.push({
      kind: 'create-file',
      path: GEMINI_SETTINGS_PATH,
      content: geminiSettings(),
      group: 'Gemini CLI context file (.gemini/settings.json)'
    })
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
  // file (`.gemini/commands/vinaya.toml`) unmentioned (a code-review finding).
  if (ctx.agents.size > 0) {
    const affected: string[] = []
    if (ctx.agents.has('claude'))
      affected.push(
        'the `/vinaya <role>` command (.claude/commands/vinaya.md) and every .claude/skills/vinaya-*/SKILL.md file'
      )
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
 * `project:<name>` label. It is gone. Project is a **field, not a
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
