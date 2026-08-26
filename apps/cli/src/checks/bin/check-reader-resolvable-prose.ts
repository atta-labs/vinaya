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
 * scope: full — the swept surfaces are the whole doctrine tree and the whole
 * reader-facing surface (when configured), not the PR's own diff.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { checkReaderResolvableProse, parseGlossaryTerms, type ProseSourceFile } from '@attalabs/aeg-core'
import { resolveDoctrineRoot } from '../../commands/doctrine.js'
import { loadConfig } from '../../lib/config'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'

const CHECK_NAME = 'reader-resolvable-prose'

const proseGates = loadConfig()?.proseGates

/**
 * `<doctrineRoot>/**` when `proseGates.doctrineRoot` is unset. Was a bare
 * `'aeg-root'` literal, cwd-relative — correct inside this monorepo (where
 * cwd IS the tree that owns it), but a permanently-empty sweep for every
 * `vinaya init` adopter, none of whom ever have a repo-relative `aeg-root/`
 * (task `vinaya-adopter-portability-v1` 2, Issue #232 — settled by
 * experiment). Unlike `registry-gates`, this check's corpus IS portable:
 * the doctrine prose it sweeps for unresolvable references/coined terms is
 * the same shipped text for every install, so `resolveDoctrineRoot()`
 * (`../../commands/doctrine.js` — the same "package's own copy" resolution
 * `vinaya doctrine` already uses) is the right default target, not a wrong
 * one the way it would be for a check that resolves adopter-specific forge
 * facts. Falls back to the old literal only if even that resolution comes
 * up empty (no bundled doctrine found at all) — the same degrade
 * `doctrineCommand` documents.
 */
const DOCTRINE_ROOT = proseGates?.doctrineRoot ?? resolveDoctrineRoot() ?? 'aeg-root'

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

/** `<doctrineRoot>/tranches/completed` when unset — mirrors the doctrine root's own default. */
const LEGACY_SLUG_DIR = proseGates?.legacySlugDir ?? `${DOCTRINE_ROOT}/tranches/completed`

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
function legacySlugs(): { slugs: string[]; dormant: boolean } {
  if (!existsSync(LEGACY_SLUG_DIR)) return { slugs: [], dormant: true }
  try {
    const slugs = readdirSync(LEGACY_SLUG_DIR)
      .filter((f) => f.endsWith('.md') && !f.endsWith('.tokens.md'))
      .map((f) => f.slice(0, -3))
      .filter((slug) => !/-v[0-9]+$/.test(slug))
    return { slugs, dormant: false }
  } catch (err) {
    // stdout, not stderr — same reasoning as the summary line in `main()`.
    console.log(
      `${CHECK_NAME}: could not read ${LEGACY_SLUG_DIR} (${err instanceof Error ? err.message : String(err)}) — legacy-slug class treated as dormant.`
    )
    return { slugs: [], dormant: true }
  }
}

function main(): void {
  const shipsPrefix = `${DOCTRINE_ROOT}/`
  const shipsPaths = collect(DOCTRINE_ROOT).filter((p) => p.endsWith('.md'))
  const readerFacingPaths =
    READER_FACING_ACTIVE && READER_FACING_SUFFIX !== null
      ? collect(READER_FACING_PREFIX as string).filter((p) => p.endsWith(READER_FACING_SUFFIX))
      : []

  const files = readAll([...shipsPaths, ...readerFacingPaths])
  const glossaryPath = join(DOCTRINE_ROOT, 'glossary.md')
  const glossaryTerms = existsSync(glossaryPath) ? parseGlossaryTerms(readFileSync(glossaryPath, 'utf8')) : []
  const { slugs, dormant: legacySlugsDormant } = legacySlugs()

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

  // stdout only — this check's stderr is the CheckError JSON channel
  // (`contract.ts`'s `emitCheckError`); a plain-text line there would make
  // the runner treat this human-readable summary as malformed output and
  // report `status: 'error'` regardless of exit code.
  console.log(
    `${CHECK_NAME}: doctrine root "${DOCTRINE_ROOT}"; reader-facing class ${READER_FACING_ACTIVE ? 'ran' : 'dormant — proseGates.readerFacingPrefix/readerFacingSuffix not both set'}; ` +
      `legacy-slug class ${legacySlugsDormant ? `dormant — ${LEGACY_SLUG_DIR} is absent` : `ran (${slugs.length} slug(s))`}; ` +
      `${findings.length} finding(s)`
  )

  for (const finding of findings) {
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
