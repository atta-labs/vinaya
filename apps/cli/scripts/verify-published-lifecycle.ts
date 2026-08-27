#!/usr/bin/env bun
/**
 * Installs `@attalabs/vinaya` from the PUBLIC npm registry into a scratch
 * directory outside this repo and exercises the full shipped-command
 * lifecycle against the real published artifact — never this workspace's
 * local source. The coverage set is derived from `@attalabs/vinaya-sources`'
 * `COMMANDS` registry (current source), not hand-maintained here.
 *
 * The version under test is READ FROM `apps/cli/package.json`, not pinned
 * here. It was a hand-maintained constant, and the failure mode of that was
 * silent in the worst direction: the constant sat at `0.4.6` while the
 * registry moved to `0.6.0`, so a green run certified an artifact three
 * releases old and said nothing about the one actually shipping. A stale pin
 * cannot fail loudly, because the version it names is a real published
 * version that really does pass — the run is honest about the wrong subject.
 *
 * Deriving it means the script always targets the version `main` currently
 * claims to be. A red row after a version bump means the published artifact
 * genuinely diverges from what current source promises (the 0.1.0-era run of
 * this script caught exactly that four ways at once: `demo break`/`waiver`
 * missing, a stale check count, and a missing `.vinaya/doc-owners` — all one
 * root cause, source ahead of publish).
 *
 * The one ordering constraint this creates is worth stating, because it is
 * the normal release sequence rather than an edge case: between merging the
 * Version Packages PR and running `changeset publish`, `package.json` names
 * a version the registry does not have yet, so the default mode cannot pass.
 * That window is exactly what `--local-pack` is for.
 *
 * `--local-pack` runs the same lifecycle against an `npm pack` of THIS
 * working tree instead of the registry spec (the tarball's `prepack` builds
 * the bundle and copies the doctrine, so it is the exact artifact a publish
 * would ship). This is the pre-publish leg: source that is ahead of the
 * registry is *supposed* to print red rows in the default mode, and this
 * flag is how to prove those rows go green before any version is published —
 * with ONE row excepted, and the exception is the pre-publish case itself.
 *
 * `demo break` cannot pass against a version the registry does not have. The
 * generated git hooks pin `npx --yes @attalabs/vinaya@<version>` (see
 * `artifacts.ts`'s hook block: the pin is an npx cache-key fix, and is itself
 * behavior under test, not something this script rewires). If that version is
 * unpublished, npx returns `ETARGET`, the hook refuses BOTH the broken and the
 * fixed commit, and `demo.ts`'s requirement that the fixed commit succeed makes
 * the row red and the run exit 1.
 *
 * So: every row but `demo break` is provable before a publish, and `demo break`
 * is provable only once that exact version exists on the registry.
 *
 * Stated as a rule rather than a count on purpose. This sentence carried a
 * hand-maintained integer pair and went stale TWICE — the registry grew, the
 * number did not, and a later edit incremented the stale value instead of
 * re-deriving it. Everything else measured here (the version under test, the
 * check-name set, the coverage set) is derived from the registry precisely so
 * it cannot drift; a prose count is the one place that rule was not applied.
 * `printReport`'s own footer counts the rows at runtime, from `COMMANDS`, and
 * that is the number to trust. The failure direction is
 * safe — a loud red, never a false green — but do not read a green `demo break`
 * in this mode as evidence about the tarball. It means the registry already has
 * that version, and the hook exercised the registry copy.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { trancheLabel } from '@attalabs/aeg-core'
import { COMMANDS } from '@attalabs/vinaya-sources'
// Current source's registry, read to derive the expectation the published
// artifact is measured against — the same "derive, never hand-maintain"
// discipline this script already applies to the command coverage set.
import { coreCheckRegistry, runsUnderAll } from '../src/checks/registry.js'
// Same discipline for the `studio` exercise below: it probes the ports
// current source would actually bind rather than hand-maintaining a second
// copy of `3008`/`3108` that could silently drift from `studio.ts`.
import { FALLBACK_PORT as STUDIO_FALLBACK_PORT, PRIMARY_PORT as STUDIO_PRIMARY_PORT } from '../src/commands/studio.js'
import { resolveHookDir } from '../src/lib/detect.js'

// `..` from `apps/cli/scripts/` is the package root — the same derivation
// `--local-pack` already uses to find the tree it packs, so both modes read
// their version from one source and cannot disagree about what is under test.
const CLI_PKG_DIR = fileURLToPath(new URL('..', import.meta.url))
const PUBLISHED_VERSION = (
  JSON.parse(readFileSync(join(CLI_PKG_DIR, 'package.json'), 'utf-8')) as { name: string; version: string }
).version
const PACKAGE_SPEC = `@attalabs/vinaya@${PUBLISHED_VERSION}`

// The real repo the `archive tranche` exercise below reaches (see EXERCISES'
// `'archive tranche'` entry) — read from THIS checkout's own `origin` remote,
// the same regex `detectGitRepo` (lib/detect.ts) uses, rather than
// hand-maintaining an owner/repo string that would point a fork's run at the
// upstream repo instead of itself.
const HOST_REPO_FLAG = (() => {
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: CLI_PKG_DIR, encoding: 'utf8' }).trim()
  const m = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (!m) throw new Error(`could not parse a GitHub owner/repo from this checkout's origin remote: "${url}"`)
  return `${m[1]}/${m[2]}`
})()

// What the run is actually testing — the registry spec by default, or the
// locally packed tarball under `--local-pack`. `specLabel` is set once in
// `main` before any exercise runs; the report header reads it.
//
// `expectedVersion` is const because both modes now resolve to the same
// number — it is this package's own version either way, so `--local-pack` has
// nothing left to override. That is the point of deriving rather than pinning.
let specLabel = PACKAGE_SPEC
const expectedVersion = PUBLISHED_VERSION

// ---------------------------------------------------------------------------
// Workspace-root guard — the whole point is testing the PUBLISHED artifact in
// isolation, never accidentally resolving this monorepo's local source. Run
// against the mkdtemp'd scratch root the instant it exists, before anything
// else touches it. A `vinaya.config.json` or a `package.json` carrying a
// `workspaces` field anywhere above the scratch root means TMPDIR (or the
// platform default) resolved somewhere it should not have.
// ---------------------------------------------------------------------------
function assertOutsideWorkspace(dir: string): void {
  let cur = dir
  for (;;) {
    const configPath = join(cur, 'vinaya.config.json')
    if (existsSync(configPath)) {
      throw new Error(
        `refusing to run: found ${configPath} above the scratch directory — this would test local ` +
          'workspace/adopter config instead of the isolated published artifact.'
      )
    }
    const pkgPath = join(cur, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { workspaces?: unknown }
        if (pkg.workspaces) {
          throw new Error(
            `refusing to run: found a workspace root at ${pkgPath} above the scratch directory — this script ` +
              'must run against an isolated published-artifact install, never inside a monorepo workspace.'
          )
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('refusing to run')) throw err
        // malformed package.json above the scratch dir — not this script's concern, keep walking up.
      }
    }
    const parent = dirname(cur)
    if (parent === cur) return
    cur = parent
  }
}

// ---------------------------------------------------------------------------
// Snapshot + hash-diff (Part 4 — eject byte-identity proof)
// ---------------------------------------------------------------------------
type Snapshot = Map<string, string>

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Which checks `check --all` should report — derived from CURRENT source's
 * registry, filtered by the SAME `runsUnderAll` predicate `check.ts` ships (a
 * check with its own workflow would otherwise be evaluated twice and report
 * under two names). This was once a literal count (`15`), and a count was
 * wrong for the same reason the version pin was: `review-gate` gained
 * `ownWorkflow` and dropped out of `--all`, so the published artifact
 * correctly reported 14 while the script called that a regression. A
 * hand-maintained count cannot distinguish "published is stale" — the thing
 * this row exists to catch — from "the expectation is stale", and it
 * silently blames the artifact either way. Worse, a count is blind to the
 * one regression class this row most needs to catch: a check dropped from
 * BOTH the current registry and the published artifact leaves the two
 * numbers equal and the row green, exactly when a name has silently gone
 * missing everywhere at once.
 *
 * A sorted NAME list closes that gap — the published artifact's `--all
 * --json` output already carries a `name` per check (`CheckOutcome.name`),
 * so comparing sets by name, not counting them, is possible with no change
 * to `check --all`'s output contract. It also makes a red row actionable: the
 * `detail` string below names exactly which checks are missing or
 * unexpected, instead of leaving the operator to diff two integers by hand.
 *
 * Importing the predicate rather than re-deriving `!ownWorkflow` here closes
 * the same gap one level down: a second selection condition added to `--all`
 * reaches this expectation automatically instead of turning it stale.
 */
const EXPECTED_ALL_CHECK_NAMES = coreCheckRegistry()
  .filter(runsUnderAll)
  .map((s) => s.name)
  .sort()

/**
 * Where CURRENT source says this fixture's hook belongs, and whether the
 * published artifact put one there. `resolveHookDir` is the function `init`
 * itself uses, so the expectation tracks the product rather than restating
 * it — the same reason the version and the check registry are read rather
 * than written down.
 *
 * It must be ONE directory, not a set. An earlier revision of this fix
 * accepted a `pre-commit` in any of the three shapes, which read as tolerance
 * and was actually proof loss: this fixture is a bare `git init` with no
 * `.husky` and no active raw hooks, so the resolver deterministically
 * promises the tracked directory, and a published artifact regressing to
 * untracked `.git/hooks` — precisely the clone-survival defect this repo just
 * fixed — would have passed green. Widening a probe to stop it failing is how
 * a check stops being able to detect the thing it exists for.
 *
 * And it must be resolved on the PRISTINE fixture, before `init` runs. The
 * resolver reads the tree it is given: an artifact that wrongly wrote
 * `.git/hooks/pre-commit` would leave an active raw hook behind, and a
 * post-init call would then legitimately answer `.git/hooks` and agree with
 * the regression it was meant to catch. Predicting first and comparing after
 * is what makes this an assertion rather than a restatement.
 *
 * Two copies of this probe both named `.git/hooks` alone before, which
 * stopped being where a fresh install writes once hooks became tracked, and
 * neither could notice because the version under test was pinned to a release
 * predating the move. One function now, called from both places.
 */
function hookInstalledIn(fixtureDir: string, expected: string): boolean {
  return existsSync(join(fixtureDir, ...expected.split('/'), 'pre-commit'))
}

// Resolved once in `main` against the pristine fixture, before `init` runs —
// see `hookInstalledIn` for why the timing is load-bearing. Both the `init`
// exercise and the pre-flight guard read it.
let expectedHookDir = ''

/**
 * Walks `root` recursively. `.git` is skipped except `.git/hooks` — the one
 * `.git`-internal path `vinaya init`/`eject` ever touches, and only on the
 * legacy shape (a repo whose `.git/hooks` already holds active raw hooks).
 * The tracked `.vinaya/hooks` and `.husky` shapes are ordinary working-tree
 * directories and are walked like anything else. Everything else under `.git`
 * (objects, index, refs) churns for reasons unrelated to vinaya and would
 * make the diff noisy rather than meaningful.
 *
 * `.git/config` is deliberately NOT walked, which is worth knowing when
 * reading an eject diff: arming and unsetting `core.hooksPath` is invisible
 * to this snapshot, so the hook ROUTING is not what these rows compare — only
 * the files.
 */
function walk(dir: string, relBase: string, out: Snapshot): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (rel === '.git') {
        const hooksAbs = join(abs, 'hooks')
        if (existsSync(hooksAbs)) walk(hooksAbs, '.git/hooks', out)
        continue
      }
      walk(abs, rel, out)
    } else if (entry.isFile()) {
      out.set(rel, sha256(readFileSync(abs)))
    }
  }
}

function snapshot(root: string): Snapshot {
  const out: Snapshot = new Map()
  walk(root, '', out)
  return out
}

function diffSnapshots(pre: Snapshot, post: Snapshot): { added: string[]; removed: string[]; changed: string[] } {
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  for (const [path, hash] of post) {
    if (!pre.has(path)) added.push(path)
    else if (pre.get(path) !== hash) changed.push(path)
  }
  for (const path of pre.keys()) {
    if (!post.has(path)) removed.push(path)
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() }
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------
type RunResult = { status: number; stdout: string; stderr: string }

function run(bin: string, args: string[], cwd: string): RunResult {
  const result = spawnSync(bin, args, { cwd, encoding: 'utf8' })
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/**
 * Polls `http://127.0.0.1:<port>/studio` on every candidate port until one
 * answers or `timeoutMs` elapses. Two ports, not one: `studio.ts` falls back
 * from `STUDIO_PRIMARY_PORT` to `STUDIO_FALLBACK_PORT` when the primary is
 * already bound (a real possibility on a dev machine already running
 * `vinaya studio`), and this exercise must accept either — hardcoding one
 * port would make the exercise flaky on exactly the machine most likely to
 * run it by hand.
 */
async function waitForStudio(ports: number[], timeoutMs: number): Promise<{ port: number; status: number } | null> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    for (const port of ports) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/studio`, { signal: AbortSignal.timeout(1000) })
        return { port, status: res.status }
      } catch {
        // not up yet on this port — try the next, or the next poll cycle
      }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return null
}

// ---------------------------------------------------------------------------
// Per-command exercises. Every `status: 'shipped'` entry in `COMMANDS` must
// have a matching key here OR in `EXEMPTIONS` below — checked at start,
// before any network/filesystem work, so a registry that grows silently
// under-covered fails loudly instead of quietly passing fewer commands.
// ---------------------------------------------------------------------------
type Outcome = { status: 'pass' | 'fail'; detail: string }
type Ctx = { bin: string; fixtureDir: string }

// The 5 (of 6) manifest artifacts every downstream exercise needs `init` to
// have written — `.vinaya/doc-owners` is deliberately excluded: it is the
// known, tracked gap (published predates #665), never a blocker for the rest
// of the lifecycle proof.
const CORE_INIT_ARTIFACTS = [
  'vinaya.config.json',
  'VINAYA.md',
  '.github/workflows/vinaya-checks.yml',
  '.github/workflows/vinaya-review.yml'
]
const DOC_OWNERS_PATH = '.vinaya/doc-owners'
const PROJECTS_REGISTRY_PATH_LOCAL = '.vinaya/projects.md'

// `new noop-check`'s target is DERIVED — the first entry `coreCheckRegistry()`
// (current source, same import EXPECTED_ALL_CHECK_NAMES above already uses)
// returns — never a hand-picked id, so a renamed/removed core check cannot
// leave this pointing at a dead one. One constant, reused by the exercise
// below AND by `SCRATCH_FIXTURE_PATHS`, so the scaffold path neither drifts
// nor needs restating.
const NOOP_CHECK_TARGET = coreCheckRegistry()[0]?.name
if (!NOOP_CHECK_TARGET) {
  throw new Error('coreCheckRegistry() returned no entries — cannot pick a target for the `new noop-check` exercise')
}

// The registration key for the `new role` exercise below — namespaced
// (`isValidNamespacedKey` refuses a bare id), same `lifecycle/` prefix
// `new check`'s own fixture key already uses above.
const NEW_ROLE_KEY = 'lifecycle/proof-role'
const NEW_ROLE_ID = 'proof-role'

const MILESTONE_BODY_FIXTURE =
  "Fixture body used only by verify-published-lifecycle.ts's `milestone create`/`milestone edit` " +
  '`--validate-only` exercises — never actually written to the forge (--validate-only, no network write).\n'

// This script's OWN scratch files, written by the exercises that run between
// the pre-init and post-eject snapshots (`pr create`/`issue create` fixture
// bodies, `new check`'s scaffold, `init product`'s registry row). Never
// vinaya-owned, never touched by `eject` — real byte-identity noise unrelated
// to the question "does eject reverse init exactly", so excluded from the
// Part 4 diff. `.vinaya/projects.md` in particular is deliberately excluded
// from `eject`'s reversal by design (vinaya-architecture skill) — the
// registry row is adopter-declared data, not vinaya-owned scaffolding.
const SCRATCH_FIXTURE_PATHS = new Set([
  '.pr-body-fixture.md',
  '.issue-body-fixture.md',
  '.commit-msg-good.txt',
  '.commit-msg-bad.txt',
  '.milestone-body-fixture.md',
  'scripts/vinaya-checks/proof-check.ts',
  `vinaya/checks/${NOOP_CHECK_TARGET}.ts`,
  `vinaya/roles/${NEW_ROLE_ID}.md`,
  PROJECTS_REGISTRY_PATH_LOCAL
])

const PR_BODY_FIXTURE = `Tier: 1
Project: vinaya
Closes #705

## Summary
Fixture body used only by verify-published-lifecycle.ts's \`pr create --validate-only\`
exercise — never actually opened as a PR (--validate-only, no network write).

## Test Plan
- [ ] **[agent]** N/A — fixture only, not a real change.
`

const ISSUE_BODY_FIXTURE = `Project: vinaya

**Boundary** — Fixture body used only by verify-published-lifecycle.ts's \`issue create --validate-only\`
exercise; never actually opened (--validate-only, no network write).
**Sizing** — trivial (fixture only).
**Project(s) + blast radius** — vinaya only; no shared package touched.
**Dependency rationale** — none; no depends-on edge.
**Traps to avoid** — none; fixture content only.
**Suggested agent-class** — n/a (fixture).
**Stop-and-escalate** — n/a (fixture; never actually filed).
**Docs to keep coherent** — no-doc-surface
`

const EXEMPTIONS: Record<string, string> = {
  archive:
    '`archive` is a ring-2 post-merge mechanism: it resolves merged PRs and their associated Issues from the ' +
    'live forge (`gh` reads against real merge history) UNCONDITIONALLY — there is no dry-run path that skips ' +
    'the forge. Exercising it genuinely would require a real repo with real merged task PRs and real `gh` ' +
    "credentials reaching the network beyond the npm install, which this script's boundary forbids (same " +
    "reasoning as `issue edit`'s exemption).",
  quickstart:
    '`quickstart` is a pure orchestrator over `init`/`init product`/`demo break`/`doctor` — it calls their ' +
    'existing, unmodified entry points in sequence with Y/n prompts between steps, never reimplements their ' +
    'internals (vinaya-architecture skill). Every one of those four commands is already exercised for real ' +
    'against the published artifact elsewhere in this script (`init` inline, `init product`, `demo break`, ' +
    "`doctor` in EXERCISES). Scripting quickstart's own interactive prompt sequence here would also disturb " +
    "this script's carefully ordered shared fixtureDir state (re-running init/demo-break mid-sequence risks " +
    'breaking the Part 4 eject byte-identity diff). The orchestration logic itself — prompt ordering, ' +
    'closeStdin-once discipline, partial-decline paths — is proven by tests/quickstart.test.ts against this ' +
    "workspace's own source, with real (non-mocked) git/hook behavior.",
  audit:
    '`audit` is a ring-2 scheduled mechanism: dead-branch drift and direct-main-push detection both derive ' +
    'from live forge state (`gh` branch/PR reads) UNCONDITIONALLY — no offline path exists. Same forge/' +
    'credential boundary as `archive` above; exempt for the same reason as `issue edit`.',
  'review post':
    "`review post` resolves the target PR's real head via `gh pr view <n> --json headRefOid` UNCONDITIONALLY, " +
    'before it renders anything — the whole point of the command is that the sha is forge-resolved and never ' +
    'caller-supplied, so there is no flag that skips it and no honest way to add one. It then POSTS a comment ' +
    'and re-reads it back to self-verify, which is a forge WRITE against a real PR — further outside this ' +
    "script's credential-free boundary than the read-only exemptions above. `pr edit`'s escape (pass only " +
    '`--title`, skipping the body fetch) has no analogue here: everything reachable before `resolveHeadSha` is ' +
    'argument validation — `parseFlags`, the `--role` enum, and the `requireFlag`/`requireTokenField` calls for ' +
    '`--pr`/`--task-id`/`--model`/`--tokens-in`/`--tokens-out`/`--cost` — and exercising a command rejecting a ' +
    'bad flag is not exercising the command. Same boundary as `issue edit`; exempt for the same reason. ' +
    "What `tests/review-post.test.ts` covers against this workspace's source is the PURE surface it imports: " +
    'findings parsing, flag parsing, comment rendering, `isNoneFoundClaim`, and the two self-verify ' +
    'predicates. It does NOT import `reviewPostCommand`, so every refusal that function holds is proven ' +
    'neither here nor there: a BLOCKER finding with `--verdict APPROVE`, a CRITICAL/HIGH finding with ' +
    '`--verdict PASS`, and `--secrets` claiming "none found" with no `--secrets-evidence-file`. Those three ' +
    'are the mechanical guards `reviewer.md` and `security.md` delegate to this command. That is a real, ' +
    'stated coverage gap in the role-guard layer, not a claim of coverage; closing it needs a unit test ' +
    "around `reviewPostCommand` with its `gh` seam injected, which is its own change, not this script's.",
  'issue edit':
    "`issue edit` fetches the target Issue's real labels from the forge (`gh issue view`) UNCONDITIONALLY, " +
    'even under --validate-only — there is no code path that skips it. Exercising it genuinely would require a ' +
    'real target Issue and real `gh` credentials reaching the network beyond the npm install, which the boundary ' +
    "this script runs under forbids (same reasoning as the brief's own network/credential stop condition). " +
    '`pr edit` avoids this: passing only `--title` (no `--body-file`) skips its forge fetch entirely, so it is ' +
    'exercised for real below.',
  'milestone adopt':
    '`milestoneAdoptCommand` resolves the repo and then fetches this repo\'s real labels and Milestones from the ' +
    'forge (`gh api repos/<repo>/labels`, `gh api repos/<repo>/milestones`, and per-slug `gh issue list`) ' +
    'UNCONDITIONALLY, before its own `--validate-only` check is ever reached — unlike `milestone create`/' +
    '`milestone edit` below, whose `--validate-only` returns before any repo/forge call and are exercised for ' +
    'real. Exercising `milestone adopt` genuinely would require a real target Milestone plus real tranche labels ' +
    "and Issues on the live forge, and real `gh` credentials reaching the network beyond the npm install, which " +
    "this script's boundary forbids (same reasoning as `issue edit`'s exemption)."
}

const EXERCISES: Record<string, (ctx: Ctx) => Outcome | Promise<Outcome>> = {
  help: ({ bin, fixtureDir }) => {
    const r = run(bin, ['help'], fixtureDir)
    const ok = r.status === 0 && /vinaya/i.test(r.stdout)
    return {
      status: ok ? 'pass' : 'fail',
      detail: `exit ${r.status}, ${r.stdout.split('\n').length} lines of help text`
    }
  },

  version: ({ bin, fixtureDir }) => {
    const plain = run(bin, ['version'], fixtureDir)
    const json = run(bin, ['version', '--json'], fixtureDir)
    let jsonOk = false
    try {
      const parsed = JSON.parse(json.stdout) as { schema?: number; data?: { version?: string } }
      jsonOk = parsed.schema === 1 && parsed.data?.version === expectedVersion
    } catch {
      jsonOk = false
    }
    const ok = plain.status === 0 && plain.stdout.trim() === expectedVersion && json.status === 0 && jsonOk
    return { status: ok ? 'pass' : 'fail', detail: `plain: "${plain.stdout.trim()}", --json schema/version: ${jsonOk}` }
  },

  init: ({ bin, fixtureDir }) => {
    const r = run(bin, ['init', '--yes'], fixtureDir)
    const coreWritten = CORE_INIT_ARTIFACTS.every((p) => existsSync(join(fixtureDir, p)))
    const hookInstalled = hookInstalledIn(fixtureDir, expectedHookDir)
    const docOwnersWritten = existsSync(join(fixtureDir, DOC_OWNERS_PATH))
    const coreOk = r.status === 0 && coreWritten && hookInstalled
    return {
      status: coreOk && docOwnersWritten ? 'pass' : 'fail',
      detail: coreOk
        ? docOwnersWritten
          ? `exit ${r.status}, all 6 manifest artifacts written, hook installed at ${expectedHookDir}`
          : `exit ${r.status}, ${DOC_OWNERS_PATH} missing from published output`
        : `exit ${r.status}, core artifacts written: ${coreWritten}, hook at ${expectedHookDir} (where current source resolves for this fixture): ${hookInstalled}`
    }
  },

  'init product': ({ bin, fixtureDir }) => {
    const r = run(bin, ['init', 'product', 'demo-product', '--yes'], fixtureDir)
    // No `origin` remote (by design, §11) — the label write is skipped, but
    // the registry row write is NOT: `runInitProduct` writes/appends
    // `.vinaya/projects.md` unconditionally (vinaya-architecture skill).
    const registryPath = join(fixtureDir, PROJECTS_REGISTRY_PATH_LOCAL)
    const registryWritten = existsSync(registryPath) && readFileSync(registryPath, 'utf-8').includes('| demo-product |')
    const ok = r.status === 0 && /scaffolded/.test(r.stdout) && registryWritten
    return {
      status: ok ? 'pass' : 'fail',
      detail: `exit ${r.status}: ${r.stdout.trim().split('\n').pop()}, registry row written: ${registryWritten}`
    }
  },

  check: ({ bin, fixtureDir }) => {
    const r = run(bin, ['check', '--all', '--json'], fixtureDir)
    let reportedNames: string[] | null = null
    try {
      const parsed = JSON.parse(r.stdout) as { data?: { checks?: Array<{ name?: unknown }> } }
      const checks = parsed.data?.checks
      if (Array.isArray(checks)) {
        reportedNames = checks
          .map((c) => (typeof c?.name === 'string' ? c.name : `<unnamed:${String(c?.name)}>`))
          .sort()
      }
    } catch {
      reportedNames = null
    }

    // Kept distinguishable from a membership mismatch: a malformed/unparseable
    // payload is a different failure mode (the artifact's output contract
    // broke) from "the artifact's output parsed fine but the names disagree".
    if (reportedNames === null) {
      return {
        status: 'fail',
        detail:
          `expected ${EXPECTED_ALL_CHECK_NAMES.length} checks under --all (${EXPECTED_ALL_CHECK_NAMES.join(', ')}), ` +
          'but published output did not parse as the expected { data: { checks: [{ name, ... }] } } envelope'
      }
    }

    const missing = EXPECTED_ALL_CHECK_NAMES.filter((n) => !reportedNames?.includes(n))
    const unexpected = reportedNames.filter((n) => !EXPECTED_ALL_CHECK_NAMES.includes(n))
    const ok = missing.length === 0 && unexpected.length === 0
    return {
      status: ok ? 'pass' : 'fail',
      detail: ok
        ? `all ${EXPECTED_ALL_CHECK_NAMES.length} expected checks reported under --all: ${EXPECTED_ALL_CHECK_NAMES.join(', ')}`
        : `checks under --all diverge from current source's registry — missing: [${missing.join(', ')}], unexpected: [${unexpected.join(', ')}]`
    }
  },

  'new check': ({ bin, fixtureDir }) => {
    // `lifecycle/proof-check`, NOT a bare `proof-check`. `newCheckCommand`
    // refuses any key that is not `<namespace>/<name>` (`isValidNamespacedKey`)
    // — `vinaya check` refuses a whole run over a key it cannot resolve, so a
    // bare name would brick every check invocation in the adopting repo. This
    // row sat red against the published artifact and nobody could see it: the
    // script had already refused to start over the `pr report` coverage gap,
    // so the stale argument here was never reached. Restoring the script
    // surfaced it on the first run.
    //
    // The file on disk is named for the segment AFTER the slash, so the
    // scaffold path — and `SCRATCH_FIXTURE_PATHS`' entry for it — is unchanged.
    const r = run(bin, ['new', 'check', 'lifecycle/proof-check'], fixtureDir)
    const created = existsSync(join(fixtureDir, 'scripts', 'vinaya-checks', 'proof-check.ts'))
    const ok = r.status === 0 && created
    return {
      status: ok ? 'pass' : 'fail',
      detail: `exit ${r.status}, scaffold created: ${created}${ok ? '' : ` — ${(r.stderr.trim() || r.stdout.trim()).slice(0, 200)}`}`
    }
  },

  'pr create': ({ bin, fixtureDir }) => {
    const bodyPath = join(fixtureDir, '.pr-body-fixture.md')
    writeFileSync(bodyPath, PR_BODY_FIXTURE, 'utf-8')
    const r = run(
      bin,
      ['pr', 'create', '--title', 'Chore: verify published lifecycle', '--body-file', bodyPath, '--validate-only'],
      fixtureDir
    )
    const ok = r.status === 0 && /PASS/i.test(r.stdout)
    return { status: ok ? 'pass' : 'fail', detail: `exit ${r.status}: ${r.stdout.trim() || r.stderr.trim()}` }
  },

  'pr edit': ({ bin, fixtureDir }) => {
    // `--title` only, no `--body-file`: `prEditCommand` skips its forge fetch
    // entirely when `body === null` — a real, network-free exercise of the
    // command, unlike `issue edit` (see EXEMPTIONS).
    const r = run(
      bin,
      ['pr', 'edit', '999999', '--title', 'Chore: verify published lifecycle edit', '--validate-only'],
      fixtureDir
    )
    const ok = r.status === 0 && /PASS/i.test(r.stdout)
    return { status: ok ? 'pass' : 'fail', detail: `exit ${r.status}: ${r.stdout.trim() || r.stderr.trim()}` }
  },

  'pr report': ({ bin, fixtureDir }) => {
    // No `--write`: the block goes to stdout, so this exercise leaves the
    // fixture untouched and stays out of Part 4's byte-identity diff. The
    // write path is the same `buildReport` output routed through
    // `replaceEvidenceBlock`; what is under test here is that the PUBLISHED
    // artifact can produce the block at all.
    //
    // This row reaches `gh`, and stays offline only INCIDENTALLY. Group A is
    // genuinely git-only — `resolveMergeBase` tries `origin/main`, gets
    // nothing (the fixture adds no remote, §11), and falls back to plain
    // `main`, which the fixture has. Group B is not: it shells to this same
    // installed CLI's `check --all --diff-only`, and `dead-branch-push` is
    // `scope: 'full'`, which `--diff-only` never skips, so its `fetchPrState`
    // runs `gh pr list` unconditionally. That call fails on local repo
    // resolution before any API request precisely BECAUSE the fixture has no
    // remote, and the check fails open to UNKNOWN. Do not restate this as
    // "no gh" — the `audit` EXEMPTION above exempts a command for reaching
    // `gh` through that very code path, and the two claims cannot both hold.
    // The added forge surface is nil either way: the `check` exercise above
    // already runs the strictly larger `check --all --json` on this fixture.
    //
    // The assertion is on the HEAD SHA, not merely on the block's delimiters:
    // an emitter that printed a well-formed but empty Group A would satisfy a
    // marker-only check, and "verified: no changes" versus "never verified
    // anything" being the same bytes is the exact failure `computeGroupA`
    // refuses. Comparing against the fixture's real HEAD proves Group A ran.
    //
    // Exit code is deliberately not asserted: `pr report` exits 1 when any
    // attested gate fails, and whether the fixture's own gate suite is green
    // is a fact about the fixture, not about whether the published command
    // works. Exit 2 (usage) and a refusal (exit 1 with no block on stdout)
    // both still fail this row, because the block assertion below is what
    // carries it.
    //
    // `rev-parse` is guarded rather than left to `git()`'s throw: an exception
    // escaping into the run loop would abort the whole sweep over one row's
    // setup step, and a row that cannot establish its own precondition should
    // redden itself, not take the other rows with it. Not yet a file-wide
    // property — `demo break` still makes unguarded `git()` calls from inside
    // the same loop — so this is the shape to copy, not one to assume.
    let head = ''
    try {
      head = git(fixtureDir, ['rev-parse', 'HEAD'])
    } catch {
      head = ''
    }
    const r = run(bin, ['pr', 'report'], fixtureDir)
    const hasBlock = r.stdout.includes('<!-- AEG:EVIDENCE:START -->') && r.stdout.includes('<!-- AEG:EVIDENCE:END -->')
    const bindsHead = head.length > 0 && r.stdout.includes(head)
    const ok = hasBlock && bindsHead
    return {
      status: ok ? 'pass' : 'fail',
      detail: ok
        ? `exit ${r.status}, AEG:EVIDENCE block emitted and bound to fixture head ${head.slice(0, 7)}`
        : `exit ${r.status}, block delimiters: ${hasBlock}, bound to head ${head.slice(0, 7) || '<unresolved>'}: ${bindsHead} — ${(r.stdout.trim() || r.stderr.trim()).slice(0, 200)}`
    }
  },

  'issue create': ({ bin, fixtureDir }) => {
    const bodyPath = join(fixtureDir, '.issue-body-fixture.md')
    writeFileSync(bodyPath, ISSUE_BODY_FIXTURE, 'utf-8')
    const r = run(
      bin,
      [
        'issue',
        'create',
        '--title',
        '[vinaya-cli-v1] 10 — verify published lifecycle (fixture)',
        '--body-file',
        bodyPath,
        '--label',
        'vinaya/tranche:verify-fixture',
        '--validate-only'
      ],
      fixtureDir
    )
    const ok = r.status === 0 && /PASS/i.test(r.stdout)
    return { status: ok ? 'pass' : 'fail', detail: `exit ${r.status}: ${r.stdout.trim() || r.stderr.trim()}` }
  },

  doctor: ({ bin, fixtureDir }) => {
    const r = run(bin, ['doctor', '--json'], fixtureDir)
    let installOk = false
    try {
      const parsed = JSON.parse(r.stdout) as { data?: { findings?: Array<{ check: string; severity: string }> } }
      const findings = parsed.data?.findings ?? []
      installOk = findings.some((f) => f.check === 'config' && (f.severity === 'ok' || f.severity === 'info'))
    } catch {
      installOk = false
    }
    // doctor's overall exit code is gh-auth/branch-protection-dependent
    // (environment, not this script) — the real assertion is that it read
    // back the install this script just performed, not a fixed exit code.
    const ok = (r.status === 0 || r.status === 1) && installOk
    return { status: ok ? 'pass' : 'fail', detail: `exit ${r.status}, recognized this run's install: ${installOk}` }
  },

  upgrade: ({ bin, fixtureDir }) => {
    const r = run(bin, ['upgrade', '--yes'], fixtureDir)
    const ok = r.status === 0 && /already current/i.test(r.stdout)
    return { status: ok ? 'pass' : 'fail', detail: `exit ${r.status}: ${r.stdout.trim()}` }
  },

  doctrine: ({ bin, fixtureDir }) => {
    // The published-tarball resolution shape, for real: the scratch install's
    // own bundled `aeg-root/` (in the `files` array) is what must resolve —
    // exactly the path the committed VINAYA.md pointer hands every reader.
    const plain = run(bin, ['doctrine'], fixtureDir)
    const printed = plain.stdout.trim()
    const entrySuffix = join('aeg-root', 'skills', 'aeg', 'SKILL.md')
    const plainOk = plain.status === 0 && isAbsolute(printed) && printed.endsWith(entrySuffix) && existsSync(printed)
    const json = run(bin, ['doctrine', '--json'], fixtureDir)
    let jsonOk = false
    try {
      const parsed = JSON.parse(json.stdout) as { schema?: number; data?: { root?: string; entry?: string } }
      jsonOk =
        parsed.schema === 1 &&
        typeof parsed.data?.root === 'string' &&
        parsed.data?.entry === join(parsed.data.root, 'skills', 'aeg', 'SKILL.md') &&
        existsSync(parsed.data.entry)
    } catch {
      jsonOk = false
    }
    return {
      status: plainOk && jsonOk ? 'pass' : 'fail',
      detail: `exit ${plain.status}, printed entry exists: ${plainOk}, --json root/entry coherent: ${jsonOk}`
    }
  },

  'demo break': ({ bin, fixtureDir }) => {
    // Git-local end to end (branch + fixture commit + hook rejection + its own
    // cleanup) — network-free, so it is exercised for real. It refuses on a
    // dirty tree, and earlier exercises leave untracked fixture files behind:
    // commit them first so the refusal path isn't what gets measured.
    git(fixtureDir, ['add', '-A'])
    git(fixtureDir, ['commit', '-m', 'Chore: absorb lifecycle fixtures pre demo-break', '--no-verify', '--allow-empty'])
    const r = run(bin, ['demo', 'break'], fixtureDir)
    const ok = r.status === 0
    return {
      status: ok ? 'pass' : 'fail',
      detail: `exit ${r.status}: ${(r.stdout || r.stderr).trim().split('\n').filter(Boolean).pop()}`
    }
  },

  studio: async ({ bin, fixtureDir }) => {
    // `studio-standalone/` is now in the `files` allowlist and `bundle-studio`
    // runs at `prepack`, so the shipped behavior for a published install is a
    // REAL launch, not the refusal path this exercise asserted before Studio
    // packaging shipped. `vinaya studio` never exits on its own (it's a
    // server), so this spawns it detached, polls until it answers on either
    // candidate port, then tears it down — the same "spawn, prove liveness,
    // kill" shape Part 4 of this task's own brief uses for its end-to-end
    // proof, just inlined here as one row of the lifecycle sweep.
    const child = spawn(bin, ['studio'], { cwd: fixtureDir, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    let exitCode: number | null = null
    child.on('exit', (code) => {
      exitCode = code
    })

    const hit = await waitForStudio([STUDIO_PRIMARY_PORT, STUDIO_FALLBACK_PORT], 20_000)

    child.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 500))
    if (exitCode === null) child.kill('SIGKILL')

    const launched = hit !== null && hit.status === 200
    return {
      status: launched ? 'pass' : 'fail',
      detail: launched
        ? `real launch: server on port ${hit?.port} answered /studio with ${hit?.status}`
        : `no 200 from /studio on port ${STUDIO_PRIMARY_PORT} or ${STUDIO_FALLBACK_PORT} within 20s — exit ${exitCode ?? 'n/a (still running)'}, stdout tail: ${stdout.trim().slice(-300)}, stderr tail: ${stderr.trim().slice(-300)}`
    }
  },

  waiver: ({ bin, fixtureDir }) => {
    // --print-only executes nothing — it prints the `gh` commands a human
    // would run. A real, network-free exercise of the command's whole
    // argument/validation path.
    const r = run(
      bin,
      ['waiver', 'docs', '1', '--reason', 'verify-published-lifecycle fixture', '--print-only'],
      fixtureDir
    )
    const ok = r.status === 0 && /nothing below was executed/i.test(r.stdout)
    return {
      status: ok ? 'pass' : 'fail',
      detail: `exit ${r.status}: ${(r.stdout || r.stderr).trim().split('\n')[0]}`
    }
  },

  'commit-msg': ({ bin, fixtureDir }) => {
    // Pure local file validation — reads the message file's first line,
    // never touches the forge. Two invocations, not one: exit 0 alone would
    // also be produced by a command that never actually checked anything, so
    // the real observable is the REJECTION's own text on a bad message,
    // proven alongside acceptance of a good one.
    const goodPath = join(fixtureDir, '.commit-msg-good.txt')
    const badPath = join(fixtureDir, '.commit-msg-bad.txt')
    writeFileSync(goodPath, 'Chore: verify-published-lifecycle commit-msg fixture\n', 'utf-8')
    writeFileSync(badPath, 'not a valid commit message\n', 'utf-8')
    const good = run(bin, ['commit-msg', goodPath], fixtureDir)
    const bad = run(bin, ['commit-msg', badPath], fixtureDir)
    const rejected = bad.status === 1 && /doesn't match this repo's commit convention/.test(bad.stderr)
    const ok = good.status === 0 && rejected
    return {
      status: ok ? 'pass' : 'fail',
      detail: `good message exit ${good.status}, bad message exit ${bad.status}: ${bad.stderr.trim().split('\n')[0] || bad.stdout.trim()}`
    }
  },

  'new noop-check': ({ bin, fixtureDir }) => {
    // Local scratch write only — `NOOP_CHECK_TARGET` is a real core check id
    // (derived, see its own comment above), so this exercises the real
    // "does this id resolve against the current registry" path, not a
    // fabricated name.
    const r = run(bin, ['new', 'noop-check', NOOP_CHECK_TARGET], fixtureDir)
    const scaffoldPath = join(fixtureDir, 'vinaya', 'checks', `${NOOP_CHECK_TARGET}.ts`)
    const created = existsSync(scaffoldPath)
    const printedReplacement = r.stdout.includes(`"${NOOP_CHECK_TARGET}"`) && /REPLACES the core check/.test(r.stdout)
    const ok = r.status === 0 && created && printedReplacement
    return {
      status: ok ? 'pass' : 'fail',
      detail: `exit ${r.status}, scaffold created: ${created}, replacement entry printed: ${printedReplacement}${ok ? '' : ` — ${(r.stderr.trim() || r.stdout.trim()).slice(0, 200)}`}`
    }
  },

  'new role': ({ bin, fixtureDir }) => {
    // Local scratch write only — `NEW_ROLE_KEY` is namespaced, so this
    // exercises the additive-scaffold path, not the bare-key OVERRIDE
    // refusal (a different, already-argument-validation-only path).
    const r = run(bin, ['new', 'role', NEW_ROLE_KEY], fixtureDir)
    const scaffoldPath = join(fixtureDir, 'vinaya', 'roles', `${NEW_ROLE_ID}.md`)
    const created = existsSync(scaffoldPath)
    const roleIdSet = created && readFileSync(scaffoldPath, 'utf-8').includes(`role_id: ${NEW_ROLE_ID}`)
    const ok = r.status === 0 && created && roleIdSet
    return {
      status: ok ? 'pass' : 'fail',
      detail: `exit ${r.status}, scaffold created: ${created}, role_id set to ${NEW_ROLE_ID}: ${roleIdSet}${ok ? '' : ` — ${(r.stderr.trim() || r.stdout.trim()).slice(0, 200)}`}`
    }
  },

  'milestone create': ({ bin, fixtureDir }) => {
    // `milestoneCreateCommand`'s `--validate-only` returns BEFORE the repo is
    // resolved or `gh` is ever called (unlike `milestone adopt` — see
    // EXEMPTIONS) — the same network-free escape `pr create`/`issue create`
    // above already use, so this is a real exercise of the shape/schema
    // gates, not a mock.
    const bodyPath = join(fixtureDir, '.milestone-body-fixture.md')
    writeFileSync(bodyPath, MILESTONE_BODY_FIXTURE, 'utf-8')
    const r = run(
      bin,
      ['milestone', 'create', '--title', 'Chore: verify published lifecycle', '--body-file', bodyPath, '--validate-only'],
      fixtureDir
    )
    const ok = r.status === 0 && /PASS/i.test(r.stdout)
    return { status: ok ? 'pass' : 'fail', detail: `exit ${r.status}: ${r.stdout.trim() || r.stderr.trim()}` }
  },

  'milestone edit': ({ bin, fixtureDir }) => {
    // Same escape as `milestone create` above: `milestoneEditCommand`'s
    // `--validate-only` returns before the target Milestone is ever resolved
    // against the forge, so a fake target number is safe — nothing looks it
    // up.
    const bodyPath = join(fixtureDir, '.milestone-body-fixture.md')
    writeFileSync(bodyPath, MILESTONE_BODY_FIXTURE, 'utf-8')
    const r = run(bin, ['milestone', 'edit', '999999', '--body-file', bodyPath, '--validate-only'], fixtureDir)
    const ok = r.status === 0 && /PASS/i.test(r.stdout)
    return { status: ok ? 'pass' : 'fail', detail: `exit ${r.status}: ${r.stdout.trim() || r.stderr.trim()}` }
  }
}

/**
 * `archive tranche` reaches the live Milestone/Issue API UNCONDITIONALLY —
 * there is no dry-run path that skips the forge (the reason `archive` above
 * stays an EXEMPTIONS-only entry). A real exercise therefore means real
 * GitHub objects, not the network/credential-free `fixtureDir` every
 * EXERCISES entry above stays inside (§11) — so, like `init`/`eject` below,
 * this runs inline in `main()` rather than through the generic map: it needs
 * its own scratch git directory carrying a real `origin` remote (a plain
 * git-config trick — `detectGitRepo` only ever reads that string, never
 * dials it, so no clone is needed) and its own create → run → verify →
 * cleanup sequence, against THIS checkout's own repo (`HOST_REPO_FLAG`,
 * derived above) rather than a hand-maintained one, so a fork exercises
 * itself instead of reaching upstream.
 *
 * Every object created here — label, Issue, Milestone — is removed in the
 * `finally` below on every path, including a throw, matching the brief's own
 * stop condition: a stray OPEN Milestone left behind on a failure path would
 * be worse than the coverage gap this closes. The Milestone in particular is
 * asserted closed twice: once from the command's own stdout, once from an
 * independent `gh api` re-read — proof the write actually reached the forge,
 * not merely that the command printed a success-shaped line.
 */
async function exerciseArchiveTranche(bin: string): Promise<Outcome> {
  const slug = `vlt-${Date.now().toString(36)}${process.pid.toString(36)}`
  const label = trancheLabel(slug)
  const scratchDir = mkdtempSync(join(tmpdir(), 'vinaya-verify-archive-tranche-'))
  git(scratchDir, ['init', '-q', '-b', 'main'])
  git(scratchDir, ['remote', 'add', 'origin', `https://github.com/${HOST_REPO_FLAG}.git`])

  let issueNumber: number | null = null
  let milestoneNumber: number | null = null
  try {
    const labelRun = run(
      'gh',
      [
        'label',
        'create',
        label,
        '-R',
        HOST_REPO_FLAG,
        '--color',
        'ededed',
        '--description',
        'Scratch — verify-published-lifecycle archive-tranche exercise; deleted by the same run.'
      ],
      scratchDir
    )
    if (labelRun.status !== 0)
      throw new Error(`\`gh label create\` failed: ${labelRun.stderr.trim() || labelRun.stdout.trim()}`)

    const milestoneRun = run('gh', ['api', `repos/${HOST_REPO_FLAG}/milestones`, '-f', `title=${slug}`], scratchDir)
    if (milestoneRun.status !== 0)
      throw new Error(
        `\`gh api .../milestones\` (create) failed: ${milestoneRun.stderr.trim() || milestoneRun.stdout.trim()}`
      )
    milestoneNumber = (JSON.parse(milestoneRun.stdout) as { number: number }).number

    const issueRun = run(
      'gh',
      [
        'issue',
        'create',
        '-R',
        HOST_REPO_FLAG,
        '--title',
        `Scratch — ${slug}`,
        '--body',
        "Scratch Issue created and closed by verify-published-lifecycle.ts's archive-tranche exercise — deleted by the same run. Safe to ignore if seen outside one.",
        '--label',
        label
      ],
      scratchDir
    )
    const issueMatch = issueRun.stdout.match(/\/issues\/(\d+)/)
    if (issueRun.status !== 0 || !issueMatch)
      throw new Error(`\`gh issue create\` failed: ${issueRun.stderr.trim() || issueRun.stdout.trim()}`)
    issueNumber = Number(issueMatch[1])

    const closeRun = run('gh', ['issue', 'close', String(issueNumber), '-R', HOST_REPO_FLAG], scratchDir)
    if (closeRun.status !== 0)
      throw new Error(`\`gh issue close\` failed: ${closeRun.stderr.trim() || closeRun.stdout.trim()}`)

    // `gh issue list --label` reads GitHub's search index, not the issue
    // record directly — it can lag a few seconds behind a create that just
    // happened, and `runArchiveTranche` calls exactly this query. Observed
    // directly while building this exercise: an immediate run reported
    // "no tranche found" against an Issue that demonstrably carried the
    // label (confirmed via `gh issue view`) a moment later. Poll the same
    // query this command itself runs until it catches up, rather than let
    // that lag read as a regression in `archive tranche`.
    for (let attempt = 0; attempt < 5; attempt++) {
      const indexed = run(
        'gh',
        [
          'issue',
          'list',
          '-R',
          HOST_REPO_FLAG,
          '--state',
          'all',
          '--label',
          label,
          '--json',
          'number',
          '--limit',
          '200'
        ],
        scratchDir
      )
      if (indexed.stdout.trim() !== '[]') break
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }

    const r = run(bin, ['archive', 'tranche', slug, '--yes'], scratchDir)
    const claimsClosed = new RegExp(`closed \\(Milestone #${milestoneNumber}\\)`).test(r.stdout)

    const reread = run('gh', ['api', `repos/${HOST_REPO_FLAG}/milestones/${milestoneNumber}`], scratchDir)
    let closedForReal = false
    try {
      closedForReal = reread.status === 0 && (JSON.parse(reread.stdout) as { state: string }).state === 'closed'
    } catch {
      closedForReal = false
    }

    const ok = r.status === 0 && claimsClosed && closedForReal
    return {
      status: ok ? 'pass' : 'fail',
      detail: ok
        ? `exit ${r.status}, real Milestone #${milestoneNumber} created then closed via \`archive tranche ${slug} --yes\` against ${HOST_REPO_FLAG}, confirmed closed via an independent \`gh api\` re-read`
        : `exit ${r.status}, stdout claims closed: ${claimsClosed}, gh api confirms closed: ${closedForReal} — ${(r.stdout.trim() || r.stderr.trim()).slice(0, 200)}`
    }
  } catch (err) {
    return {
      status: 'fail',
      detail: `archive-tranche exercise did not complete: ${err instanceof Error ? err.message : String(err)}`
    }
  } finally {
    if (milestoneNumber !== null)
      run('gh', ['api', '-X', 'DELETE', `repos/${HOST_REPO_FLAG}/milestones/${milestoneNumber}`], scratchDir)
    if (issueNumber !== null)
      run('gh', ['issue', 'delete', String(issueNumber), '-R', HOST_REPO_FLAG, '--yes'], scratchDir)
    run('gh', ['label', 'delete', label, '-R', HOST_REPO_FLAG, '--yes'], scratchDir)
    rmSync(scratchDir, { recursive: true, force: true })
  }
}

// `init` and `eject` are exercised inline in `main()` (init gates every other
// exercise; eject drives the Part 4 byte-identity proof) rather than through
// the generic `EXERCISES` map — still real, still asserted, just not routed
// through the loop. `archive tranche` joins them for a different reason (see
// `exerciseArchiveTranche` above): it is the only exercise that reaches a
// real forge repo instead of the isolated `fixtureDir`. Named here purely so
// `coverageCheck` sees all three as covered.
const HANDLED_INLINE = new Set(['init', 'eject', 'archive tranche'])

function coverageCheck(): void {
  const missing = COMMANDS.filter(
    (c) => c.status === 'shipped' && !(c.name in EXERCISES) && !(c.name in EXEMPTIONS) && !HANDLED_INLINE.has(c.name)
  )
  if (missing.length > 0) {
    throw new Error(
      `coverage gap: ${missing.map((c) => `"${c.name}"`).join(', ')} — shipped in the current COMMANDS registry ` +
        'but has neither an exercise nor a stated exemption in this script. Add one before running.'
    )
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  coverageCheck()

  const keep = process.argv.includes('--keep')
  const localPack = process.argv.includes('--local-pack')
  const root = mkdtempSync(join(tmpdir(), 'vinaya-verify-'))

  try {
    assertOutsideWorkspace(root)

    const installDir = join(root, 'install')
    const fixtureDir = join(root, 'fixture')
    mkdirSync(installDir, { recursive: true })
    mkdirSync(fixtureDir, { recursive: true })

    // The registry spec by default; under --local-pack, a tarball of this
    // working tree. The TARBALL lands in the scratch root, never in the repo —
    // but the pack OPERATION is not repo-free: npm runs `prepack` with `cwd`
    // at the package, so build + bundle-doctrine write `apps/cli/dist/` and
    // `apps/cli/aeg-root/` into the working tree. Both are gitignored, so this
    // leaves no dirtiness; it does mean two concurrent `--local-pack` runs
    // race on those shared build outputs, while the scratch root itself is
    // per-run unique. Running `prepack` is the point: the tarball is then the
    // exact artifact `npm publish` would ship from this tree.
    let installSource = PACKAGE_SPEC
    if (localPack) {
      process.stdout.write(`--local-pack: packing ${CLI_PKG_DIR} (prepack: build + bundle-doctrine)…\n`)
      const packStdout = execFileSync('npm', ['pack', '--pack-destination', root], {
        cwd: CLI_PKG_DIR,
        encoding: 'utf8'
      }).trim()
      const tarball = packStdout.split('\n').at(-1) ?? ''
      if (!tarball.endsWith('.tgz')) throw new Error(`npm pack did not report a tarball filename (got: "${tarball}")`)
      installSource = join(root, tarball)
      // `expectedVersion` already holds this package's version — both modes
      // now read it from the same `package.json`, so there is nothing to
      // re-derive here and no way for the two to drift apart.
      specLabel = `local pack ${tarball} (working tree, v${expectedVersion})`
    }

    process.stdout.write(`Installing ${specLabel} into ${installDir}…\n`)
    execFileSync('npm', ['init', '-y', '--silent'], { cwd: installDir, stdio: 'ignore' })
    execFileSync('npm', ['install', installSource, '--no-audit', '--no-fund', '--silent'], {
      cwd: installDir,
      stdio: 'inherit'
    })
    const bin = join(installDir, 'node_modules', '.bin', 'vinaya')
    if (!existsSync(bin)) throw new Error(`npm install succeeded but ${bin} was not produced.`)

    git(fixtureDir, ['init', '-q', '-b', 'main'])
    git(fixtureDir, ['config', 'user.email', 'verify-published-lifecycle@example.com'])
    git(fixtureDir, ['config', 'user.name', 'verify-published-lifecycle'])
    writeFileSync(join(fixtureDir, 'README.md'), '# verify-published-lifecycle fixture\n')
    git(fixtureDir, ['add', 'README.md'])
    git(fixtureDir, ['commit', '-q', '-m', 'Chore: initial commit'])
    // No `origin` remote is ever added (§11) — the whole run stays credential-free.

    const ctx: Ctx = { bin, fixtureDir }
    const results = new Map<string, Outcome>()

    // Part 4's byte-identity proof: snapshot BEFORE `init` runs, diff against
    // the snapshot taken AFTER `eject` — must be empty (init → eject round-trips
    // the fixture to its exact pre-init state).
    const preSnapshot = snapshot(fixtureDir)

    // `init` must write its CORE artifacts for every downstream exercise
    // (config/hooks it seeds) to be meaningful — `.vinaya/doc-owners` alone
    // missing is the known, tracked gap and must not block the rest of the run.
    // Predicted against the pristine fixture — BEFORE `init` writes anything.
    // See `hookInstalledIn`: resolving after the fact would let a regression
    // to raw `.git/hooks` supply the very condition that makes the resolver
    // endorse it.
    expectedHookDir = resolveHookDir(fixtureDir)

    const initOutcome = EXERCISES.init?.(ctx)
    const coreArtifactsOk =
      CORE_INIT_ARTIFACTS.every((p) => existsSync(join(fixtureDir, p))) && hookInstalledIn(fixtureDir, expectedHookDir)
    if (!initOutcome || !coreArtifactsOk) {
      throw new Error(
        `\`vinaya init\` did not write its core artifacts against the published artifact — cannot proceed: ${initOutcome?.detail}`
      )
    }
    results.set('init', initOutcome)

    for (const name of [
      'help',
      'version',
      'init product',
      'check',
      'new check',
      'new noop-check',
      'new role',
      'pr create',
      'pr edit',
      'pr report',
      'issue create',
      'milestone create',
      'milestone edit',
      'doctor',
      'upgrade',
      'doctrine',
      'commit-msg',
      'demo break',
      'studio',
      'waiver'
    ]) {
      const exercise = EXERCISES[name]
      if (!exercise) continue
      results.set(name, await exercise(ctx))
    }

    // Reaches the real forge (`HOST_REPO_FLAG`), not `fixtureDir` — see
    // `exerciseArchiveTranche` for why it runs here instead of through the
    // generic loop above.
    results.set('archive tranche', await exerciseArchiveTranche(bin))

    for (const [name, reason] of Object.entries(EXEMPTIONS)) {
      results.set(name, { status: 'pass', detail: `EXEMPT — ${reason}` })
    }

    const ejectRun = run(bin, ['eject', '--yes'], fixtureDir)
    const ejectedCleanly = ejectRun.status === 0 && /Vinaya ejected/i.test(ejectRun.stdout)
    const postSnapshot = snapshot(fixtureDir)
    for (const p of SCRATCH_FIXTURE_PATHS) postSnapshot.delete(p)
    const diff = diffSnapshots(preSnapshot, postSnapshot)
    const byteIdentical = diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0
    results.set('eject', {
      status: ejectedCleanly && byteIdentical ? 'pass' : 'fail',
      detail: byteIdentical
        ? `exit ${ejectRun.status}, byte-identical to pre-init snapshot`
        : `exit ${ejectRun.status}, snapshot diff — added: [${diff.added.join(', ')}], removed: [${diff.removed.join(', ')}], changed: [${diff.changed.join(', ')}]`
    })

    printReport(results)

    // `coverageCheck()` proves every shipped command has an EXERCISES/
    // EXEMPTIONS/HANDLED_INLINE key; this proves each one actually RAN. A key
    // that exists but is missing from the run-order list above would
    // otherwise be silently unaccounted — report green while never executing
    // (exactly how a well-built `doctrine` exercise shipped as dead code).
    const unaccounted = COMMANDS.filter((c) => c.status === 'shipped' && !results.has(c.name)).map((c) => c.name)
    if (unaccounted.length > 0) {
      process.stdout.write(
        `✗ unaccounted shipped command(s) — covered by coverageCheck but never run: ${unaccounted.join(', ')}\n`
      )
    }
    const anyFail = [...results.values()].some((o) => o.status === 'fail') || unaccounted.length > 0
    process.exitCode = anyFail ? 1 : 0
  } finally {
    if (keep) {
      process.stdout.write(`--keep: leaving scratch directory at ${root}\n`)
    } else {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

function printReport(results: Map<string, Outcome>): void {
  process.stdout.write(`\nvinaya verify-published-lifecycle — against ${specLabel}\n\n`)

  let pass = 0
  let fail = 0
  for (const c of COMMANDS) {
    if (c.status !== 'shipped') continue
    const o = results.get(c.name)
    if (!o) continue
    const symbol = o.status === 'pass' ? '✓' : '✗'
    process.stdout.write(`${symbol} ${c.name.padEnd(16)} ${o.detail}\n`)
    if (o.status === 'pass') pass += 1
    else fail += 1
  }

  process.stdout.write(
    `\n${pass + fail}/${COMMANDS.filter((c) => c.status === 'shipped').length} commands accounted for (${pass} pass, ${fail} fail)\n`
  )
}

main().catch((err) => {
  console.error(`verify-published-lifecycle: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
