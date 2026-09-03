#!/usr/bin/env bun

/**
 * Core check: doctrine-portability. Thin adapter over `@attalabs/aeg-core`'s
 * `checkDoctrinePortability` (task 234, Issue #234) — the class
 * `check-reader-resolvable-prose` sweeps but, by its own zero-I/O contract,
 * cannot see: a shipped-doctrine citation of a path that exists only in the
 * authoring repository, never resolvable by an adopter.
 *
 * **No `REPO_ROOT`/`process.chdir()`, same reasoning as
 * `check-reader-resolvable-prose.ts`.** Paths are read relative to
 * `process.cwd()` — the caller's own repo root, wherever this bin actually
 * runs from once bundled into an installed package.
 *
 * **Baseline mode, not blocking.** Cold, this check fires on every
 * author-repo-only path the shipped doctrine already cites — 200+ in this
 * repo alone — which would red-line every adopter's CI on install.
 * `checkDoctrinePortability` itself stays zero-I/O and reports the FULL set
 * every time it runs; this bin is what narrows that to "what a diff adds":
 * it runs the same predicate twice — once over the working tree, once over
 * `BASE_SHA` (`origin/main` by default) read live through `git show`/`git
 * ls-tree` — and reports only the findings present in the working tree but
 * absent at the base ref. `@attalabs/aeg-core`'s `captureBaseline`/
 * `compareToBaseline` (`baseline-capture.ts`) carry the aggregate
 * baseline-vs-current counts into the summary line; the per-finding new-set
 * is a multiplicity-aware diff over the two predicate runs, keyed on
 * `file:cited` content identity (never line number, which shifts on any
 * earlier edit) — computed here in the I/O layer rather than added to the
 * zero-I/O module's contract.
 *
 * Report-only (same `aeg-root/enforcement.md` G1/G2 rollout precedent as
 * `reader-resolvable-prose`/`retired-vocabulary`): findings print as
 * `warning` severity, exit code always 0. A blocking check on day one would
 * fail every adopter's install before the corpus this run surfaces has ever
 * been triaged — sibling task 233 owns that cleanup; this check owns only
 * catching what gets added on top of it from here on.
 *
 * scope: full — the swept surface is the whole doctrine tree against its
 * base-ref counterpart, not the PR's own file list.
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  captureBaseline,
  checkDoctrinePortability,
  compareToBaseline,
  type PortabilityFinding,
  type PortabilitySourceFile
} from '@attalabs/aeg-core'
import { loadConfig } from '../../lib/config'
import { findingsInThisDiff } from '../../lib/diff-evidence'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'

const CHECK_NAME = 'doctrine-portability'

/** Same config key and same default as `reader-resolvable-prose`/`retired-vocabulary`. */
const DOCTRINE_ROOT = loadConfig()?.proseGates?.doctrineRoot ?? 'aeg-root'
const SHIPS_PREFIX = `${DOCTRINE_ROOT}/`

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    return ''
  }
}

/** Recursively collects repo-relative `.md` paths under `dir` from the working tree. Missing/unreadable `dir` degrades to `[]`, never throws — an adopter with no `<doctrineRoot>` at all has nothing to sweep, not an error. */
function collectWorkingTree(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    const full = join(dir, name)
    let isDir: boolean
    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue
    }
    if (isDir) {
      if (name === 'node_modules' || name === '.git' || name === '.next' || name === '.turbo') continue
      collectWorkingTree(full, out)
    } else if (name.endsWith('.md')) {
      out.push(full)
    }
  }
  return out
}

function readWorkingTree(paths: string[]): PortabilitySourceFile[] {
  return paths.map((p) => ({ path: p, content: readFileSync(p, 'utf8') }))
}

/** Same `.md` corpus as `collectWorkingTree`/`readWorkingTree`, read from `ref` via `git ls-tree`/`git show` instead of the filesystem. A `ref` with no `<doctrineRoot>` at all (an adopter's own base branch never carried it) degrades to `[]`, same as the working-tree collector. */
function collectAtRef(ref: string, dir: string): PortabilitySourceFile[] {
  const listing = git(['ls-tree', '-r', '--name-only', ref, '--', dir])
  const paths = listing
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p.endsWith('.md'))
  return paths.map((p) => ({ path: p, content: git(['show', `${ref}:${p}`]) }))
}

/**
 * Content identity, not position: `file:kind:cited`, never `line`. A
 * doctrine edit that inserts or removes a line earlier in the same file
 * shifts every later citation's line number without changing what it
 * cites — keying on line would make every one of those unmoved citations
 * register as "new" on the very next unrelated edit, spamming false
 * positives on any non-append change (found live reviewing this same PR's
 * own diff). `kind` is included explicitly (Issue #298's `vendor-name`
 * finding kind, review round 2) rather than left to the fact that a `path`
 * finding's `cited` always contains a `/` and a `vendor-name` finding's
 * never does — that separation is real today but is an invariant of the
 * word list, not of this function, and this key should not depend on it.
 */
function findingKey(f: PortabilityFinding): string {
  return `${f.file}:${f.kind}:${f.cited}`
}

/**
 * Multiplicity-aware set difference over `findingKey`: each baseline
 * finding can absorb at most one current finding sharing its key, so a
 * genuinely NEW duplicate of an already-cited path (baseline has one
 * occurrence, current has two) still reports the second one — a plain
 * `Set`-membership diff would silently swallow it, since membership alone
 * doesn't count how many baseline slots a repeated key already used.
 */
function newSince(
  baseline: readonly PortabilityFinding[],
  current: readonly PortabilityFinding[]
): PortabilityFinding[] {
  const remaining = new Map<string, number>()
  for (const f of baseline) {
    const key = findingKey(f)
    remaining.set(key, (remaining.get(key) ?? 0) + 1)
  }
  const added: PortabilityFinding[] = []
  for (const f of current) {
    const key = findingKey(f)
    const count = remaining.get(key) ?? 0
    if (count > 0) {
      remaining.set(key, count - 1)
    } else {
      added.push(f)
    }
  }
  return added
}

function main(): void {
  const base = process.env.BASE_SHA || 'origin/main'

  const currentFiles = readWorkingTree(collectWorkingTree(DOCTRINE_ROOT))
  const currentFindings = checkDoctrinePortability(currentFiles, SHIPS_PREFIX)

  const baselineFiles = collectAtRef(base, DOCTRINE_ROOT)
  const baselineFindings = checkDoctrinePortability(baselineFiles, SHIPS_PREFIX)

  const newFindings = findingsInThisDiff(newSince(baselineFindings, currentFindings))
  // Line-scoped (task 8): a finding prints only when its own line falls
  // inside a changed hunk of a file this diff touched. `findingsInThisDiff`
  // owns both halves — one hunk parser for the whole repo, and the same
  // "indeterminate reports everything" rule `resolveChangedFiles` already
  // established. Full-sweep mode (no diff boundary resolvable at all) is
  // unchanged, so a scheduled whole-tree run still reports the backlog.

  const baseline = captureBaseline(
    [{ tool: CHECK_NAME, findingCount: baselineFindings.length }],
    new Date().toISOString()
  )
  const comparison = compareToBaseline([{ tool: CHECK_NAME, findingCount: currentFindings.length }], baseline)

  // stdout only — this check's stderr is the CheckError JSON channel
  // (`contract.ts`'s `emitCheckError`); a plain-text line there would make
  // the runner treat this human-readable summary as malformed output and
  // report `status: 'error'` regardless of exit code.
  console.log(
    `${CHECK_NAME}: doctrine root "${DOCTRINE_ROOT}"; ${currentFiles.length} file(s) at HEAD, ${baselineFiles.length} at "${base}"; ` +
      `baseline ${baselineFindings.length}, current ${currentFindings.length}, delta ${comparison.delta}; ${newFindings.length} new finding(s)`
  )

  const PATH_RECOVERY_PROMPT =
    'This doctrine page cites a path that only resolves in the authoring repository, not in an adopter’s ' +
    'install — an adopter cannot follow it. Rewrite the citation to a doctrine-relative path (`roles/...`, ' +
    '`contracts/...`, `skills/...`, `aeg-root/...`) or an adopter-owned one (`.github/...`, `.vinaya/...`, ' +
    '`.claude/...`), or state the fact without pointing at the file at all.'

  const VENDOR_NAME_RECOVERY_PROMPT =
    'This doctrine page names an AI vendor/product/agent by name outside the one sanctioned fenced home ' +
    '(`<!-- AEG:VENDOR-EXAMPLE:START -->` … `<!-- AEG:VENDOR-EXAMPLE:END -->` in `tranche-model.md` §12). ' +
    'Rewrite the mention to refer to the host/agent generically (e.g. "the coding agent," "this repo\'s ' +
    'shipped reference host," "an external, independently-hosted model") instead of by product name.'

  for (const finding of newFindings) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'warning',
      message: `${finding.file}:${finding.line}: ${finding.message}`,
      file: finding.file,
      line: finding.line,
      agent_recovery_prompt: finding.kind === 'vendor-name' ? VENDOR_NAME_RECOVERY_PROMPT : PATH_RECOVERY_PROMPT
    })
  }

  // Report-only, same G1/G2 precedent as reader-resolvable-prose/retired-vocabulary.
  process.exit(0)
}

main()
