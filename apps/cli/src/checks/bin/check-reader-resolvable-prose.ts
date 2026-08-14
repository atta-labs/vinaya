#!/usr/bin/env bun

/**
 * Core check: reader-resolvable-prose. Thin adapter over
 * `@atta/aeg-core`'s `checkReaderResolvableProse` — the two mechanizable
 * classes (unresolvable references, undefined coined vocabulary) from
 * Issue #694's three-class analysis. Class 3 (register/slop) stays with the
 * review role; it is not deterministic and is not attempted here.
 *
 * Gathers the swept surfaces itself (every `.md` under `aeg-root/`, every
 * `page.tsx` under the public site's `(site)` route tree), reads
 * `aeg-root/glossary.md` for the term list and `aeg-root/tranches/completed/`
 * for the legacy-slug list — the only I/O in this check, per aeg-core's
 * zero-I/O pure-rule charter (the rule itself takes file paths + contents +
 * term/slug lists and returns findings).
 *
 * **Report-only (rollout precedent: `aeg-root/enforcement.md`'s G1/G2
 * report-only period).** Findings print as `warning` severity; the exit code
 * always stays 0. A blocking check on day one would fail every open PR that
 * already carries some of this backlog — the report-only period is what lets
 * that backlog surface and get cleaned up before the gate turns strict.
 *
 * scope: full — the swept surfaces are the whole doctrine tree and the whole
 * public site, not the PR's own diff.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkReaderResolvableProse, parseGlossaryTerms, type ProseSourceFile } from '@atta/aeg-core'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../..')
process.chdir(REPO_ROOT)

const CHECK_NAME = 'reader-resolvable-prose'

/**
 * This adopter's own reader-facing surface. `aeg-core`'s
 * `classifyProseFile`/`checkReaderResolvableProse` are generic; this
 * repo-specific shape is supplied here, not baked into the package.
 *
 * This repo (`atta-labs/vinaya`) has no public site — no `apps/<name>/web` — so
 * there is no reader-facing surface to sweep. `READER_FACING_ROOT` is `null`
 * to make that an explicit, named no-op rather than a prefix literal that
 * would silently match nothing; the `ships` class (`aeg-root/**`) still runs
 * either way.
 */
const READER_FACING_ROOT: string | null = null
const READER_FACING_SUFFIX = '/page.tsx'

/** Recursively collects repo-relative paths under `dir` whose name passes `match`. */
function collect(dir: string, match: (name: string) => boolean, out: string[] = []): string[] {
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
      collect(full, match, out)
    } else if (match(name)) {
      out.push(full)
    }
  }
  return out
}

function readAll(paths: string[]): ProseSourceFile[] {
  return paths.map((p) => ({ path: p, content: readFileSync(p, 'utf8') }))
}

/**
 * Legacy-slug list, derived from `aeg-root/tranches/completed/*.md` filenames.
 * That archive is legitimately absent in this repo (task 4's ratified
 * boundary — attalabs' operational history, not doctrine). Distinguishes
 * "archive absent, class dormant" from "archive present, empty" so the
 * dormancy is visible in the check's own output rather than indistinguishable
 * from a real, exercised pass.
 */
function legacySlugs(): { slugs: string[]; dormant: boolean } {
  const dir = join(REPO_ROOT, 'aeg-root/tranches/completed')
  if (!existsSync(dir)) return { slugs: [], dormant: true }
  const slugs = readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.endsWith('.tokens.md'))
    .map((f) => f.slice(0, -3))
    .filter((slug) => !/-v[0-9]+$/.test(slug))
  return { slugs, dormant: false }
}

function main(): void {
  const shipsPaths = collect('aeg-root', (name) => name.endsWith('.md'))
  const readerFacingPaths =
    READER_FACING_ROOT !== null ? collect(READER_FACING_ROOT, (name) => name === 'page.tsx') : []

  const files = readAll([...shipsPaths, ...readerFacingPaths])
  const glossaryTerms = parseGlossaryTerms(readFileSync(join(REPO_ROOT, 'aeg-root/glossary.md'), 'utf8'))
  const { slugs, dormant: legacySlugsDormant } = legacySlugs()

  // No reader-facing surface in this repo (see READER_FACING_ROOT) — a
  // prefix no swept path can ever start with, so classifyProseFile's
  // reader-facing branch never matches. The `ships` class still runs.
  const readerFacingPrefix = READER_FACING_ROOT !== null ? `${READER_FACING_ROOT}/` : 'no-reader-facing-surface/'

  const findings = checkReaderResolvableProse(files, glossaryTerms, readerFacingPrefix, READER_FACING_SUFFIX, slugs)

  console.error(
    `${CHECK_NAME}: reader-facing class ${READER_FACING_ROOT !== null ? 'ran' : 'dormant — no reader-facing surface (e.g. apps/*/web) in this repo'}; ` +
      `legacy-slug class ${legacySlugsDormant ? 'dormant — aeg-root/tranches/completed is absent in this repo' : `ran (${slugs.length} slug(s))`}; ` +
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
          'inline (the same "Term — one-sentence definition" shape `aeg-root/glossary.md` uses) at its first use on ' +
          'this page, or link to `/docs/glossary`. Do not simply delete the word if the sentence needs it.'
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
