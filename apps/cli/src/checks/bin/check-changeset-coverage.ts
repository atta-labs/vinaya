#!/usr/bin/env bun

/**
 * Core check: changeset-coverage. Thin adapter over
 * `changeset-coverage-logic.ts`'s pure predicate: reads `.changeset/config.json`'s
 * `fixed` group live, resolves each member's own `package.json` `files`
 * allowlist live (never a hardcoded path list), reads the diff's changed
 * files, and reports a finding when a shipped path is hit with no
 * `.changeset/*.md` in the same diff.
 *
 * Blocking: a finding is `error` severity and exits `1`, so the pre-push
 * hook refuses the push and CI fails the pull request. The one waiver is an
 * empty changeset (`bunx changeset add --empty`): it is a `.changeset/*.md`
 * file in the diff, so it satisfies the predicate and cannot be forgotten.
 * There is no label or pull-request-body escape. The indeterminate-diff case
 * stays a warning, exit `0` — an ambiguity is not a missing changeset.
 *
 * scope: diff, ring 0 (registry.ts) — offline and diff-only, so the managed
 * local hooks can run it; CI re-runs it like every `--all --diff-only`
 * check. `env: {}`: every fact this bin needs comes from already-local git
 * state and the working tree's own manifests — this bin reads no env var of
 * its own at all (the current branch is `git rev-parse`d directly, never
 * `process.env.BRANCH`), so there is nothing for the runner's env allowlist
 * to need to strip in the first place.
 *
 * Release-branch exemption: reuses `@attalabs/aeg-core`'s own
 * `CHANGESET_RELEASE_BRANCH` constant — the same one `check-body-bare-digits.ts`'s
 * Changesets-release exemption is keyed on. That check also live-fetches the
 * PR author; this one deliberately shells out to nothing but local git.
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { CHANGESET_RELEASE_BRANCH } from '@attalabs/aeg-core'
import { repoRoot, resolveChangedFiles } from '../../lib/diff-evidence'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { evaluateChangesetCoverage, type FixedGroupMember } from '../changeset-coverage-logic'

const CHECK_NAME = 'changeset-coverage'

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return ''
  }
}

/** `git symbolic-ref --quiet --short HEAD` — `''` on detached HEAD, never a false name. */
function currentBranch(): string {
  return git(['symbolic-ref', '--quiet', '--short', 'HEAD'])
}

/** `refs/remotes/origin/HEAD` stripped of its `origin/` prefix — `''` when unresolvable (never fetched, or a remote other than `origin`). Same derivation as `check-main-branch-refusal.ts`'s own `defaultBranch()`. */
function defaultBranch(): string {
  const ref = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  return ref.startsWith('origin/') ? ref.slice('origin/'.length) : ''
}

function toPosix(p: string): string {
  return p.split('\\').join('/')
}

type PackageJsonView = { name?: unknown; files?: unknown; workspaces?: unknown }

function readPackageJson(path: string): PackageJsonView | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as PackageJsonView) : null
  } catch {
    return null
  }
}

function workspacePatterns(pkg: PackageJsonView | null): string[] {
  const raw = pkg?.workspaces
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { packages?: unknown }).packages)
      ? ((raw as { packages: unknown[] }).packages as unknown[])
      : []
  return list.filter((p): p is string => typeof p === 'string')
}

function childDirs(absoluteDir: string): string[] {
  try {
    return readdirSync(absoluteDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.'))
      .map((e) => e.name)
  } catch {
    return []
  }
}

/**
 * `workspace glob -> candidate repo-relative member dirs`, supporting only
 * the one shape every real workspaces field in this repo (and the vast
 * majority of real-world ones) uses: a literal prefix ending in `/*`. A
 * pattern that isn't that shape is skipped — degrading to "this member
 * wasn't discovered" is the safe direction for a report-only check; it never
 * fabricates a shipped-path hit.
 */
function candidateMemberDirs(root: string, pattern: string): string[] {
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2)
    return childDirs(join(root, prefix)).map((name) => `${prefix}/${name}`)
  }
  if (!pattern.includes('*')) return [pattern]
  return []
}

/** `package name -> its own {dir, files}`, resolved live from every workspace member's own `package.json` — never a hardcoded package-to-directory table. */
function resolveWorkspaceMembers(root: string): Map<string, { dir: string; files: string[] }> {
  const rootPkg = readPackageJson(join(root, 'package.json'))
  const members = new Map<string, { dir: string; files: string[] }>()
  for (const pattern of workspacePatterns(rootPkg)) {
    for (const dir of candidateMemberDirs(root, pattern)) {
      const pkg = readPackageJson(join(root, dir, 'package.json'))
      const name = pkg?.name
      const files = pkg?.files
      if (typeof name !== 'string' || !Array.isArray(files)) continue
      members.set(name, { dir, files: files.filter((f): f is string => typeof f === 'string') })
    }
  }
  return members
}

/** `.changeset/config.json`'s `fixed` group, flattened across every sub-array — read live, never hardcoded. Missing/malformed config degrades to `[]` (dormant). */
function fixedGroupNames(root: string): string[] {
  const pkg = readPackageJson(join(root, '.changeset', 'config.json')) as { fixed?: unknown } | null
  const fixed = pkg?.fixed
  if (!Array.isArray(fixed)) return []
  return fixed.flat().filter((n): n is string => typeof n === 'string')
}

function main(): void {
  const root = repoRoot() ?? process.cwd()

  // O3 (found live 2026-09-04): on the default branch itself there is no
  // diff to grade against — this is not the ambiguous-history case below,
  // it's the expected shape of every run from `main` (a managed local hook,
  // a scheduled whole-tree audit). Exit silently rather than warning that a
  // diff "could not be determined" when there was never a diff to find.
  const current = currentBranch()
  const base = defaultBranch()
  if (current !== '' && current === base) {
    process.exit(0)
  }

  const changedAbs = resolveChangedFiles()
  // `null` (indeterminate — a shallow clone, no merge base, an orphan or
  // bare/single-commit history) is NOT the same fact as `[]` (a real,
  // resolved, genuinely empty diff) — collapsing the two into the same
  // silent pass is the exact fail-open class `diff-evidence.ts`'s own
  // module doc documents as a real, reproduced incident (a review finding).
  // This check has no non-diff-dependent corpus to fall back to
  // the way `retired-vocabulary`/`reader-resolvable-prose` do (their
  // "report everything unfiltered" fallback), so the loud direction here is
  // a `warning` finding naming the ambiguity — never a bypass, and still
  // exit `0` always, same report-only contract as every other outcome.
  if (changedAbs === null) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'warning',
      message:
        'changeset-coverage: could not determine this diff against origin/main or main (a shallow clone, no merge base, or an orphan/single-commit history) — shipped-path coverage could not be evaluated for this diff.',
      agent_recovery_prompt:
        'Fetch enough history to establish a real merge base against origin/main (e.g. remove a shallow --depth from the checkout, or run `git fetch --unshallow`), then re-run `vinaya check changeset-coverage`.'
    })
    process.exit(0)
  }
  if (changedAbs.length === 0) {
    process.exit(0)
  }
  const changedFiles = changedAbs.map((p) => toPosix(relative(root, p)))

  // Always self-computed via git, never `process.env.BRANCH` — this check
  // declares `env: {}` (registry.ts) and the runner's env allowlist already
  // strips any caller-supplied BRANCH before the real registered path ever
  // spawns this bin, so reading it here would only be live for a direct,
  // out-of-band invocation of this file — a narrow, needless spoofing
  // surface for a fact `git rev-parse` already gives for free.
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const isReleaseBranch = branch === CHANGESET_RELEASE_BRANCH

  const workspaceMembers = resolveWorkspaceMembers(root)
  const fixedGroup: FixedGroupMember[] = fixedGroupNames(root)
    .map((name) => {
      const member = workspaceMembers.get(name)
      return member ? { name, dir: member.dir, files: member.files } : null
    })
    .filter((m): m is FixedGroupMember => m !== null)

  const result = evaluateChangesetCoverage(fixedGroup, changedFiles, isReleaseBranch)

  // stdout only — stderr is the CheckError JSON channel (contract.ts).
  console.log(
    `${CHECK_NAME}: ${fixedGroup.length} fixed-group member(s) resolved; ${result.status === 'finding' ? result.shippedPathsHit.length : 0} shipped path(s) hit`
  )

  if (result.status === 'finding') {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: `changeset-coverage: this diff changes a published package's shipped file(s) with no \`.changeset/*.md\` in the same diff: ${result.shippedPathsHit.join(', ')}. Add a changeset describing the change, or add an empty one when the change ships nothing users see.`,
      agent_recovery_prompt:
        "Either add a `.changeset/*.md` entry describing the change in user terms (run the repo's changeset CLI, e.g. `bunx changeset`), or, when the change ships nothing users see, add an empty changeset (`bunx changeset add --empty`). Commit it in the same PR."
    })
    process.exit(1)
  }
}

main()
