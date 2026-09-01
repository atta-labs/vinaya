#!/usr/bin/env bun

/**
 * Core check: reader-resolvable-prose. Thin adapter over
 * `@attalabs/aeg-core`'s `checkReaderResolvableProse` — the two mechanizable
 * classes (unresolvable references, undefined coined vocabulary) from
 * Issue #694's three-class analysis. Class 3 (register/slop) stays with the
 * review role; it is not deterministic and is not attempted here.
 *
 * De-hardcoded (task 7, Issue #56): the doctrine root, reader-facing page
 * globs, and legacy-slug corpus location all come from
 * `vinaya.config.json`'s `proseGates` key, read via `loadConfig()` — the
 * cwd-walking resolver every other repo-local, non-trust config value uses.
 * Absent config falls back to this repo's own historical shape
 * (`doctrineRoot: 'aeg-root'`, dormant reader-facing sweep — no public web
 * app in this repo — `legacySlugDir` derived from `doctrineRoot`), so an install
 * with no `proseGates` set behaves exactly as it did before this key
 * existed.
 *
 * **No `REPO_ROOT`/`process.chdir()` — a real behavior fix, not cosmetic.**
 * The predecessor of this bin computed its own package's file-system
 * location and `chdir`'d there, which only ever happened to be this
 * monorepo's own root because the check had never run anywhere else. Once
 * bundled and installed into an adopter's `node_modules`, that walk lands
 * inside the installed package, not the adopter's repo — every other
 * registered check (`check-doc-coverage.ts` et al.) instead reads paths
 * relative to `process.cwd()`, which the runner leaves as the caller's own
 * repo root. This bin now does the same.
 *
 * Reads `<doctrineRoot>/glossary.md` for the term list and
 * `<legacySlugDir>` for the legacy-slug list — the only I/O in this check,
 * per aeg-core's zero-I/O pure-rule charter (the rule itself takes file
 * paths + contents + term/slug lists and returns findings).
 *
 * **Report-only (rollout precedent: `aeg-root/enforcement.md`'s G1/G2
 * report-only period).** Findings print as `warning` severity; the exit code
 * always stays 0. A blocking check on day one would fail every open PR that
 * already carries some of this backlog — the report-only period is what lets
 * that backlog surface and get cleaned up before the gate turns strict.
 *
 * scope: full — the SWEEP is the whole doctrine tree and the whole
 * reader-facing surface (when configured), never the PR's own diff; the
 * evaluator has to read every doctrine file to resolve a cross-file
 * reference correctly. But which findings get REPORTED is now diff-scoped
 * (`resolveChangedFiles`, lib/diff-evidence.ts) — full sweep, without that,
 * meant every PR reprinted this package's entire shipped-doctrine backlog
 * regardless of what it touched (found live, atta-labs/vinaya#289, on a PR
 * that changed one `packages/aeg-core` test file and nothing under
 * `aeg-root/`). A real new coined-term/unresolvable-reference finding in a
 * file the PR actually changed still surfaces.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { checkReaderResolvableProse, parseGlossaryTerms, type ProseSourceFile } from '@attalabs/aeg-core'
import { hasDoctrineEntry, resolveDoctrineRoot } from '../../commands/doctrine.js'
import { loadConfig } from '../../lib/config'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { repoRoot, resolveChangedFiles } from '../../lib/diff-evidence'

const CHECK_NAME = 'reader-resolvable-prose'

const proseGates = loadConfig()?.proseGates

/**
 * `<doctrineRoot>/**` when `proseGates.doctrineRoot` is unset.
 *
 * `resolveDoctrineRoot()`'s own default resolves relative to wherever ITS
 * OWN calling module physically sits on disk (`packageRoot(import.meta.url)`,
 * evaluated in `doctrine.ts`'s scope) — the right anchor for `vinaya doctrine`
 * (a command resolving its OWN package's bundled copy), but the wrong one
 * here: this check sweeps the repo actually UNDER CHECK, and whether that
 * repo's checkout happens to sit under an ancestor directory literally named
 * `node_modules` (a nested/linked checkout, a worktree under a differently-
 * shaped path) flips `resolveDoctrineRoot`'s internal fallback-candidate gate
 * with no relation to whether this repo's own `aeg-root/` exists (Issue
 * #314 — reproduced live: the same commit, checked out one directory deeper
 * under a `node_modules`-named ancestor, silently swept zero files instead
 * of its real backlog).
 *
 * So the first-choice anchor here is `repoRoot()` (`git rev-parse
 * --show-toplevel`) — deterministic regardless of checkout shape, and
 * already the anchor `resolveChangedFiles()` below uses for the same reason.
 * Only when THAT doesn't resolve to a real doctrine root (a `vinaya init`
 * adopter with no repo-local `aeg-root/` of their own — Issue #232, settled
 * by experiment) does this fall back to `resolveDoctrineRoot()`'s package-
 * relative "my own shipped copy" resolution, which is genuinely the right
 * target for that case: the doctrine prose this check sweeps is the same
 * shipped text for every install. `null` when NEITHER resolves — a
 * genuinely unresolvable root, reported by `main()` as its own distinct
 * outcome, never silently as a clean zero-finding pass (the bare `'aeg-root'`
 * literal this constant previously fell back to was itself the bug: a
 * cwd-relative guess that only ever worked by coincidence).
 */
function resolveCheckDoctrineRoot(): string | null {
  if (proseGates?.doctrineRoot) return proseGates.doctrineRoot
  const root = repoRoot()
  if (root !== null) {
    const candidate = join(root, 'aeg-root')
    if (hasDoctrineEntry(candidate)) return candidate
  }
  return resolveDoctrineRoot()
}

const DOCTRINE_ROOT = resolveCheckDoctrineRoot()

/**
 * BOTH must be configured for the reader-facing sweep to run at all — same
 * "explicit no-op, not a silent gap" discipline the predecessor bin used for
 * `READER_FACING_ROOT: null`. This repo itself sets neither (no public site
 * here to sweep), so `check --all` in this repo stays dormant on this half
 * exactly as before.
 */
const READER_FACING_PREFIX = proseGates?.readerFacingPrefix ?? null
const READER_FACING_SUFFIX = proseGates?.readerFacingSuffix ?? null
const READER_FACING_ACTIVE = READER_FACING_PREFIX !== null && READER_FACING_SUFFIX !== null

/**
 * `<doctrineRoot>/tranches/completed` when unset — mirrors the doctrine
 * root's own default. `null` only when `DOCTRINE_ROOT` itself is (the
 * genuinely-unresolvable case), in which case `main()` reports that distinct
 * outcome and returns before this would ever be read.
 */
const LEGACY_SLUG_DIR =
  proseGates?.legacySlugDir ?? (DOCTRINE_ROOT === null ? null : `${DOCTRINE_ROOT}/tranches/completed`)

/** Recursively collects repo-relative paths under `dir`. Missing/unreadable `dir` degrades to `[]`, never throws — the same dormancy discipline `legacySlugs()` below documents. */
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
      if (name === 'node_modules' || name === '.next' || name === '.turbo') continue
      collect(full, out)
    } else {
      out.push(full)
    }
  }
  return out
}

function readAll(paths: string[]): ProseSourceFile[] {
  return paths.map((p) => ({ path: p, content: readFileSync(p, 'utf8') }))
}

/**
 * Legacy-slug list, derived from `<legacySlugDir>`'s `*.md` filenames.
 * Distinguishes "directory absent, class dormant" from "directory present,
 * empty" so the dormancy is visible in the check's own output rather than
 * indistinguishable from a real, exercised pass.
 *
 * `existsSync` is the common-case short-circuit; `readdirSync` is still
 * wrapped so an unexpected read failure (permissions, a TOCTOU race between
 * the two calls) degrades to dormant with a warning rather than throwing
 * uncaught out of `main()` — this check's own contract is report-only, exit
 * code always 0, and an uncaught exception would break that.
 */
function legacySlugs(legacySlugDir: string): { slugs: string[]; dormant: boolean } {
  if (!existsSync(legacySlugDir)) return { slugs: [], dormant: true }
  try {
    const slugs = readdirSync(legacySlugDir)
      .filter((f) => f.endsWith('.md') && !f.endsWith('.tokens.md'))
      .map((f) => f.slice(0, -3))
      .filter((slug) => !/-v[0-9]+$/.test(slug))
    return { slugs, dormant: false }
  } catch (err) {
    // stdout, not stderr — same reasoning as the summary line in `main()`.
    console.log(
      `${CHECK_NAME}: could not read ${legacySlugDir} (${err instanceof Error ? err.message : String(err)}) — legacy-slug class treated as dormant.`
    )
    return { slugs: [], dormant: true }
  }
}

function main(): void {
  // Genuinely unresolvable — no `aeg-root` found relative to the repo under
  // check (`repoRoot()/aeg-root`), and no bundled copy found relative to this
  // package's own install either. Report this as its OWN distinct outcome:
  // `severity: 'error'` (never `'warning'`, which the reportable-findings
  // loop below uses) and a non-{0,1} exit code, so the runner's own generic
  // exit-code mapping (`runner.ts`: 0 → pass, 1 → fail, else → error) marks
  // this run `status: 'error'` — never `'pass'` with zero findings, which
  // would be structurally indistinguishable from "swept the real tree and
  // found nothing" (the exact failure this task exists to close, Issue
  // #314). This is orthogonal to the check's own report-only exit-0 policy
  // for the PROSE-FINDINGS class below, which is unchanged.
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

  const shipsPrefix = `${DOCTRINE_ROOT}/`
  const shipsPaths = collect(DOCTRINE_ROOT).filter((p) => p.endsWith('.md'))
  const readerFacingPaths =
    READER_FACING_ACTIVE && READER_FACING_SUFFIX !== null
      ? collect(READER_FACING_PREFIX as string).filter((p) => p.endsWith(READER_FACING_SUFFIX))
      : []

  const files = readAll([...shipsPaths, ...readerFacingPaths])
  const glossaryPath = join(DOCTRINE_ROOT, 'glossary.md')
  const glossaryTerms = existsSync(glossaryPath) ? parseGlossaryTerms(readFileSync(glossaryPath, 'utf8')) : []
  const legacySlugDir = LEGACY_SLUG_DIR ?? `${DOCTRINE_ROOT}/tranches/completed`
  const { slugs, dormant: legacySlugsDormant } = legacySlugs(legacySlugDir)

  const readerFacingPrefix =
    READER_FACING_ACTIVE && READER_FACING_PREFIX !== null ? `${READER_FACING_PREFIX}/` : '/no-reader-facing-surface'
  const readerFacingSuffix = READER_FACING_ACTIVE && READER_FACING_SUFFIX !== null ? READER_FACING_SUFFIX : '/page.tsx'

  const findings = checkReaderResolvableProse(
    files,
    glossaryTerms,
    readerFacingPrefix,
    readerFacingSuffix,
    slugs,
    shipsPrefix
  )

  // `resolveChangedFiles()` returns absolute paths, resolved against the
  // real repo root (`git rev-parse --show-toplevel`), never an assumed
  // `process.cwd()` (review finding, PR #290 MAJOR: a check bin invoked from
  // any other cwd silently matched nothing under the old cwd-relative
  // comparison). `finding.file` is usually already absolute — it comes from
  // `collect(DOCTRINE_ROOT)`, walked from an absolute `repoRoot()`- or
  // `resolveDoctrineRoot()`-derived path — but `DOCTRINE_ROOT` can also be a
  // relative `proseGates.doctrineRoot` config value. Anchor
  // to the SAME real repo root `resolveChangedFiles()` used, not a second,
  // independent `process.cwd()` assumption (review finding, PR #290 MINOR:
  // the two absolute-path shapes were each internally consistent but could
  // still diverge from each other outside the common invocation shape) —
  // falling back to `process.cwd()` only if this process is somehow outside
  // any git worktree at all, which `resolveChangedFiles()` itself already
  // degrades to `null` for.
  //
  // `null` (no diff boundary could be established at all — a bare/single-
  // commit repo with no `origin` remote, or a shallow clone/orphan history
  // with no merge base, review finding PR #290 BLOCKER) reports every
  // finding unfiltered, same as before diff-scoping existed — indeterminate
  // must never collapse into "confirmed clean." Only an ACTUAL
  // resolved-but-empty diff suppresses findings.
  const changedFilesList = resolveChangedFiles()
  const changed = changedFilesList === null ? null : new Set(changedFilesList)
  const pathBase = repoRoot() ?? process.cwd()
  const reportable = changed === null ? findings : findings.filter((f) => changed.has(resolve(pathBase, f.file)))

  // stdout only — this check's stderr is the CheckError JSON channel
  // (`contract.ts`'s `emitCheckError`); a plain-text line there would make
  // the runner treat this human-readable summary as malformed output and
  // report `status: 'error'` regardless of exit code.
  console.log(
    `${CHECK_NAME}: doctrine root "${DOCTRINE_ROOT}"; reader-facing class ${READER_FACING_ACTIVE ? 'ran' : 'dormant — proseGates.readerFacingPrefix/readerFacingSuffix not both set'}; ` +
      `legacy-slug class ${legacySlugsDormant ? `dormant — ${legacySlugDir} is absent` : `ran (${slugs.length} slug(s))`}; ` +
      `${findings.length} finding(s) swept, ${reportable.length} in this diff`
  )

  for (const finding of reportable) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'warning',
      message: `${finding.file}:${finding.line}: ${finding.message}`,
      file: finding.file,
      line: finding.line,
      agent_recovery_prompt: finding.message.includes('coined term')
        ? 'This page uses AEG/Vinaya-internal vocabulary a first-time reader cannot resolve. Either define the term ' +
          'inline (the same "Term — one-sentence definition" shape the glossary uses) at its first use on this page, ' +
          'or link to the glossary. Do not simply delete the word if the sentence needs it.'
        : 'This doctrine or page cites a forge number or an internal tranche slug the reader has no tracker to ' +
          'resolve. Rewrite the sentence to state the fact plainly instead of pointing at the citation — say what ' +
          'was learned/decided, not where it was logged.'
    })
  }

  // Report-only: this check can only ever inform, never fail CI, until the
  // backlog this run surfaces has been triaged and a follow-up task flips it
  // to blocking (mirrors the G1/G2 rollout in `aeg-root/enforcement.md`).
  process.exit(0)
}

main()
