#!/usr/bin/env bun
/**
 * Installs `@attalabs/vinaya` from the PUBLIC npm registry into a scratch
 * directory outside this repo and exercises the full shipped-command
 * lifecycle against the real published artifact — never this workspace's
 * local source. The coverage set is derived from `@atta/vinaya-sources`'
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
 * So: 19 of the 20 rows are provable before a publish; `demo break` is provable
 * only once that exact version exists on the registry. The failure direction is
 * safe — a loud red, never a false green — but do not read a green `demo break`
 * in this mode as evidence about the tarball. It means the registry already has
 * that version, and the hook exercised the registry copy.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMMANDS } from '@atta/vinaya-sources'
// Current source's registry, read to derive the expectation the published
// artifact is measured against — the same "derive, never hand-maintain"
// discipline this script already applies to the command coverage set.
import { coreCheckRegistry, runsUnderAll } from '../src/checks/registry.js'
import { resolveHookDir } from '../src/lib/detect.js'

// `..` from `apps/cli/scripts/` is the package root — the same derivation
// `--local-pack` already uses to find the tree it packs, so both modes read
// their version from one source and cannot disagree about what is under test.
const CLI_PKG_DIR = fileURLToPath(new URL('..', import.meta.url))
const PUBLISHED_VERSION = (
  JSON.parse(readFileSync(join(CLI_PKG_DIR, 'package.json'), 'utf-8')) as { name: string; version: string }
).version
const PACKAGE_SPEC = `@attalabs/vinaya@${PUBLISHED_VERSION}`

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
 * How many checks `check --all` should report — derived from CURRENT source's
 * registry, filtered by the SAME `runsUnderAll` predicate `check.ts` ships (a
 * check with its own workflow would otherwise be evaluated twice and report
 * under two names). This was the literal `15`, and it was wrong for the same
 * reason the version pin was: `review-gate` gained `ownWorkflow` and dropped
 * out of `--all`, so the published artifact correctly reported 14 while the
 * script called that a regression. A hand-maintained count cannot distinguish
 * "published is stale" — the thing this row exists to catch — from "the
 * expectation is stale", and it silently blames the artifact either way.
 * Importing the predicate rather than re-deriving `!ownWorkflow` here closes
 * the same gap one level down: a second selection condition added to `--all`
 * reaches this expectation automatically instead of turning it stale.
 */
const EXPECTED_ALL_CHECK_COUNT = coreCheckRegistry().filter(runsUnderAll).length

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
  'scripts/vinaya-checks/proof-check.ts',
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
  'archive tranche':
    '`archive tranche` resolves an open Milestone by title and lists its Issues via live `gh api` reads ' +
    'UNCONDITIONALLY — there is no dry-run path that skips the forge. Same real-repo/real-credentials boundary ' +
    'as `archive` above; exempt for the same reason.',
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
  'issue edit':
    "`issue edit` fetches the target Issue's real labels from the forge (`gh issue view`) UNCONDITIONALLY, " +
    'even under --validate-only — there is no code path that skips it. Exercising it genuinely would require a ' +
    'real target Issue and real `gh` credentials reaching the network beyond the npm install, which the boundary ' +
    "this script runs under forbids (same reasoning as the brief's own network/credential stop condition). " +
    '`pr edit` avoids this: passing only `--title` (no `--body-file`) skips its forge fetch entirely, so it is ' +
    'exercised for real below.'
}

const EXERCISES: Record<string, (ctx: Ctx) => Outcome> = {
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
    let count = -1
    try {
      const parsed = JSON.parse(r.stdout) as { data?: { checks?: unknown[] } }
      count = parsed.data?.checks?.length ?? -1
    } catch {
      count = -1
    }
    const ok = count === EXPECTED_ALL_CHECK_COUNT
    return {
      status: ok ? 'pass' : 'fail',
      detail: `expected ${EXPECTED_ALL_CHECK_COUNT} checks under --all (current source's registry, own-workflow checks excluded), published reports ${count}`
    }
  },

  'new check': ({ bin, fixtureDir }) => {
    const r = run(bin, ['new', 'check', 'proof-check'], fixtureDir)
    const created = existsSync(join(fixtureDir, 'scripts', 'vinaya-checks', 'proof-check.ts'))
    const ok = r.status === 0 && created
    return { status: ok ? 'pass' : 'fail', detail: `exit ${r.status}, scaffold created: ${created}` }
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

  studio: ({ bin, fixtureDir }) => {
    // The published artifact ships no Studio bundle — `studio-standalone/` is
    // not in the `files` allowlist and `bundle-studio` is not part of
    // `prepack` — so the shipped behavior for a published install IS the
    // refusal path: exit 1 with a message naming the package. Exercised for
    // real rather than exempted: this proves the command is routed in the
    // published artifact AND that it refuses clearly instead of crashing or
    // exiting 0 over nothing (a `studio` that silently does nothing is the
    // defect shape this command was recovered against). When Studio
    // packaging (#43) ships a real bundle, this exercise must flip to
    // asserting a real launch.
    const r = run(bin, ['studio'], fixtureDir)
    const refused = r.status === 1 && /Vinaya Studio isn't available in this install/.test(r.stderr)
    return {
      status: refused ? 'pass' : 'fail',
      detail: `exit ${r.status} (expected 1), honest refusal on stderr: ${refused}`
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
  }
}

// `init` and `eject` are exercised inline in `main()` (init gates every other
// exercise; eject drives the Part 4 byte-identity proof) rather than through
// the generic `EXERCISES` map — still real, still asserted, just not routed
// through the loop. Named here purely so `coverageCheck` sees them as covered.
const HANDLED_INLINE = new Set(['init', 'eject'])

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
      'pr create',
      'pr edit',
      'issue create',
      'doctor',
      'upgrade',
      'doctrine',
      'demo break',
      'studio',
      'waiver'
    ]) {
      const exercise = EXERCISES[name]
      if (!exercise) continue
      results.set(name, exercise(ctx))
    }
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
