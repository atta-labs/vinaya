#!/usr/bin/env bun

/**
 * Core check: retired-vocabulary. Thin adapter over `@attalabs/aeg-core`'s
 * `scanRetiredVocabulary` (task 7, Issue #56) — the genuinely-retired half
 * of `retired-vocabulary.test.ts`'s original scan, "today only a vitest
 * test inside `packages/aeg-core`, executed by no adopter ever."
 *
 * Deliberately NOT the forge-number / tranche-slug / legacy-slug class that
 * test file also carries: those ban a LIVE, unexplained citation, and are
 * already `reader-resolvable-prose` (`checkUnresolvableReferences`) —
 * shipping both under two check names would double-report the identical
 * match. See `scanRetiredVocabulary`'s own module header for the full
 * reasoning.
 *
 * **Scope: `<doctrineRoot>/**` only, not the whole adopter repo.** What
 * `RETIRED_PATTERNS` bans is AEG's own methodology history (the decision
 * log, the lock, the `team-leader` role, …) — vocabulary that only means
 * anything inside AEG's own doctrine, which is exactly what `vinaya init`
 * installs at `<doctrineRoot>` and nowhere else in an adopter's repo.
 * Sweeping the adopter's own unrelated source (their business logic, their
 * own "decision log" feature, whatever "CONTRADICTION" means to their
 * domain) would misfire on words that carry no AEG meaning there at all.
 * This is a narrower scope than the vitest suite's own `PRODUCT = ['.']` —
 * a deliberate scope decision for the adopter-facing adapter, not a change
 * to `RETIRED_PATTERNS`/`RETIRED_EXEMPT_SUBSTRINGS`/`PATTERN_EXEMPT`
 * themselves, which are unmodified from the vitest suite.
 *
 * Shares `vinaya.config.json`'s `proseGates.doctrineRoot` with
 * `reader-resolvable-prose` — one config key, two checks reading the same
 * doctrine-root fact, never two separate knobs for the same thing.
 *
 * Report-only, same rollout precedent as `reader-resolvable-prose`
 * (`aeg-root/enforcement.md`'s G1/G2 period): findings print as `warning`
 * severity, exit code always 0.
 *
 * scope: full — the SWEEP stays the whole doctrine tree (a retired-vocabulary
 * leak can sit in any doctrine file regardless of what a given PR touches).
 * Which findings get REPORTED is diff-scoped (`resolveChangedFiles`,
 * lib/diff-evidence.ts) — same fix, same reason, as `reader-resolvable-prose`
 * (atta-labs/vinaya#289): without it, every PR reprinted this package's
 * entire shipped-doctrine backlog regardless of what changed.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { scanRetiredVocabulary, type VocabSourceFile } from '@attalabs/aeg-core'
import { hasDoctrineEntry, resolveDoctrineRoot } from '../../commands/doctrine.js'
import { loadConfig } from '../../lib/config'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { repoRoot, resolveChangedFiles } from '../../lib/diff-evidence'

const CHECK_NAME = 'retired-vocabulary'

/**
 * Same default, same config key, and same fix as `reader-resolvable-prose`
 * (Issue #314) — see that file's `resolveCheckDoctrineRoot()` for the full
 * reasoning: `resolveDoctrineRoot()`'s own default resolves relative to
 * wherever ITS OWN calling module physically sits on disk, which makes
 * whether it finds this repo's `aeg-root/` depend on checkout-path shape
 * rather than on whether that `aeg-root/` exists. `repoRoot()` (`git
 * rev-parse --show-toplevel`) is the deterministic anchor instead; falling
 * back to `resolveDoctrineRoot()`'s package-relative "my own shipped copy"
 * resolution only when the repo under check has no local `aeg-root/` of its
 * own (a `vinaya init` adopter, Issue #232). `null` — a genuinely
 * unresolvable root — is reported by `main()` as its own distinct outcome,
 * never silently as a clean zero-finding pass.
 */
function resolveCheckDoctrineRoot(): string | null {
  const configured = loadConfig()?.proseGates?.doctrineRoot
  if (configured) return configured
  const root = repoRoot()
  if (root !== null) {
    const candidate = join(root, 'aeg-root')
    if (hasDoctrineEntry(candidate)) return candidate
  }
  return resolveDoctrineRoot()
}

const DOCTRINE_ROOT = resolveCheckDoctrineRoot()

/** Text extensions worth sweeping — mirrors `retired-vocabulary.test.ts`'s own `grep --include` list. */
function isSweptFile(name: string): boolean {
  return /\.(md|ts|tsx|yml)$/.test(name) || name === 'doc-owners' || name === 'packages'
}

/** Recursively collects repo-relative paths under `dir` whose name passes `isSweptFile`. Missing/unreadable `dir` degrades to `[]`, never throws — this check's contract is report-only. */
function collect(dir: string, out: string[] = []): string[] {
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
      collect(full, out)
    } else if (isSweptFile(name)) {
      out.push(full)
    }
  }
  return out
}

function readAll(paths: string[]): VocabSourceFile[] {
  return paths.map((p) => ({ path: p, content: readFileSync(p, 'utf8') }))
}

function main(): void {
  // Genuinely unresolvable — see `check-reader-resolvable-prose.ts`'s
  // identical guard for the full reasoning. `severity: 'error'` and a
  // non-{0,1} exit code (never `'warning'`, which the reportable-findings
  // loop below uses) make the runner mark this run `status: 'error'`, never
  // `'pass'` with zero findings — structurally indistinguishable, before
  // this fix, from "swept the real tree and found nothing" (Issue #314).
  if (DOCTRINE_ROOT === null) {
    console.log(`${CHECK_NAME}: doctrine root unresolvable — sweep did not run.`)
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message:
        'doctrine root unresolvable: no aeg-root found at the repo root under check, and no bundled copy found ' +
        "relative to this package's own install.",
      agent_recovery_prompt:
        'Set proseGates.doctrineRoot in vinaya.config.json to the doctrine tree this repo actually uses, or ' +
        "confirm aeg-root/ exists at the repo root (or that this package's own bundled aeg-root/ is present)."
    })
    process.exit(2)
  }

  const paths = collect(DOCTRINE_ROOT)
  const files = readAll(paths)
  const findings = scanRetiredVocabulary(files)
  // Same absolute-path comparison (`resolveChangedFiles()` resolves against
  // the real repo root, never an assumed `process.cwd()`) AND same
  // `null`-means-unfiltered handling `check-reader-resolvable-prose.ts`
  // needs, for the identical reasons: `finding.file` comes from
  // `collect(DOCTRINE_ROOT)`, usually already absolute but not always
  // (`DOCTRINE_ROOT` can be a relative `proseGates.doctrineRoot` config
  // value). Anchor to the SAME real repo
  // root `resolveChangedFiles()` used (`repoRoot()`, review finding, PR #290
  // MINOR) rather than a second, independent `process.cwd()` assumption that
  // could diverge from it outside the common invocation shape; and
  // `resolveChangedFiles()` returns `null` — never `[]` — when no diff
  // boundary could be established at all (a bare/single-commit fixture, or a
  // shallow clone/orphan history with no merge base, review finding PR #290
  // BLOCKER), so that case reports every finding unfiltered instead of
  // silencing a real sweep.
  const changedFilesList = resolveChangedFiles()
  const changed = changedFilesList === null ? null : new Set(changedFilesList)
  const pathBase = repoRoot() ?? process.cwd()
  const reportable = changed === null ? findings : findings.filter((f) => changed.has(resolve(pathBase, f.file)))

  // stdout only — this check's stderr is the CheckError JSON channel
  // (`contract.ts`'s `emitCheckError`); a plain-text line there would make
  // the runner treat this human-readable summary as malformed output and
  // report `status: 'error'` regardless of exit code.
  console.log(
    `${CHECK_NAME}: doctrine root "${DOCTRINE_ROOT}"; ${paths.length} file(s) swept; ${findings.length} finding(s), ${reportable.length} in this diff`
  )

  for (const finding of reportable) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'warning',
      message: `${finding.file}:${finding.line}: ${finding.message}`,
      file: finding.file,
      line: finding.line,
      agent_recovery_prompt:
        'This doctrine page claims a mechanism AEG itself retired is still live (a decision-log entry, the lock, ' +
        'the `team-leader` role, …). Rewrite it to describe the CURRENT mechanism, or remove the claim — never ' +
        'describe a retired concept as something a reader can still do today.'
    })
  }

  // Report-only, same precedent as reader-resolvable-prose.
  process.exit(0)
}

main()
