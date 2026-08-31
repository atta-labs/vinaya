#!/usr/bin/env bun

/**
 * Core check: quoted-command (Issue #128). Thin adapter over
 * `@attalabs/aeg-core`'s `findCitedQuotes`/`evaluateCitedQuotes` — a doc that
 * quotes a command/config line verbatim, in backticks, as a statement of
 * present fact goes stale silently once the thing it quotes changes.
 *
 * **Marker-based only (Principal decision, 2026-08-30) — no inference.**
 * This bin evaluates ONLY spans wrapped in the `AEG:QUOTES-FILE:START:<path>`
 * / `AEG:QUOTES-FILE:END` marker pair (`quoted-command.ts`'s own module doc
 * has the full grammar). It never guesses at a command-looking span: an
 * adopter-facing `npx @attalabs/vinaya init` in a README is instruction, not
 * a claim, and flagging it unmarked is the false-positive shape that gets a
 * gate disabled. Coverage grows only as docs adopt the marker.
 *
 * **Doc discovery mirrors `check-reader-resolvable-prose.ts`.** Same
 * `vinaya.config.json` `proseGates` key, same `resolveDoctrineRoot()`
 * default, same de-hardcoded reasoning (Issue #56/#232) — this check sweeps
 * the identical governed-doc corpus for markers, never a second notion of
 * "governed doc". `findCitedQuotes` itself scopes further, via the shared
 * `classifyProseFile` (`ships`/`reader-facing` only, never `internal`).
 *
 * **Cited-file resolution is unscoped.** A marker's cited file can be
 * anywhere in the repo (a CI workflow YAML, a config file) — not only under
 * the doctrine tree — so every distinct `citedFile` a discovered marker
 * names is read directly off `process.cwd()`-relative disk, independent of
 * the doc-discovery sweep above.
 *
 * **Report-only (rollout precedent: `changeset-coverage`/`reader-resolvable-prose`).**
 * Findings print as `warning` severity; the exit code always stays `0`.
 * Registering a new check must not newly redden any adopter's CI on day
 * one. Graduating to blocking, and any waiver-label escape that would need,
 * is a later, separately-dispatched decision once the false-positive rate
 * is observed against real corpora — not designed here.
 *
 * scope: diff, ring 0 (registry.ts): offline and local (no gh CLI call, no
 * forge call — every fact comes from already-checked-out working-tree files), so
 * the managed local hooks can run it; CI re-runs it like every
 * `--all --diff-only` check. `env: {}`: no environment variable is read.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { evaluateCitedQuotes, findCitedQuotes, type QuotedCommandSourceFile } from '@attalabs/aeg-core'
import { resolveDoctrineRoot } from '../../commands/doctrine.js'
import { loadConfig } from '../../lib/config'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { repoRoot } from '../../lib/diff-evidence'

const CHECK_NAME = 'quoted-command'

const proseGates = loadConfig()?.proseGates

/** Same default as `check-reader-resolvable-prose.ts`: the package's own bundled doctrine copy, falling back to the historical `aeg-root` literal. */
const DOCTRINE_ROOT = proseGates?.doctrineRoot ?? resolveDoctrineRoot() ?? 'aeg-root'

const READER_FACING_PREFIX = proseGates?.readerFacingPrefix ?? null
const READER_FACING_SUFFIX = proseGates?.readerFacingSuffix ?? null
const READER_FACING_ACTIVE = READER_FACING_PREFIX !== null && READER_FACING_SUFFIX !== null

/** Recursively collects repo-relative paths under `dir`. Missing/unreadable `dir` degrades to `[]`, matching `check-reader-resolvable-prose.ts`'s own dormancy discipline. */
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

function readAll(paths: string[]): QuotedCommandSourceFile[] {
  return paths.map((p) => ({ path: p, content: readFileSync(p, 'utf8') }))
}

function toPosix(p: string): string {
  return p.split('\\').join('/')
}

/**
 * Every path this check ever names in a finding is repo-root-relative, never
 * absolute. `DOCTRINE_ROOT` (`resolveDoctrineRoot()`'s default) is an
 * absolute filesystem path — the sibling `check-reader-resolvable-prose.ts`
 * collects and reports directly off it, which leaks the developer's own
 * local checkout path into every finding's `file` field (review finding on
 * this check's own first PR; the sibling carries the identical bug and is
 * out of this PR's surface to fix — reader-resolvable-prose.ts is read as a
 * model, never modified). This bin resolves `DOCTRINE_ROOT`/`READER_FACING_PREFIX`
 * to an absolute path ONLY for the `fs` walk, then immediately relativizes
 * every collected path — and the ships/reader-facing prefixes themselves —
 * against `root` before anything is classified, matched, or emitted, the
 * same `toPosix(relative(root, p))` shape `check-changeset-coverage.ts`
 * already uses correctly.
 */
function main(): void {
  const root = repoRoot() ?? process.cwd()

  const docRootAbs = resolve(root, DOCTRINE_ROOT)
  const shipsPrefix = `${toPosix(relative(root, docRootAbs))}/`
  const shipsPaths = collect(docRootAbs).filter((p) => p.endsWith('.md'))

  const readerFacingRootAbs =
    READER_FACING_ACTIVE && READER_FACING_PREFIX !== null ? resolve(root, READER_FACING_PREFIX) : null
  const readerFacingPaths =
    readerFacingRootAbs !== null && READER_FACING_SUFFIX !== null
      ? collect(readerFacingRootAbs).filter((p) => p.endsWith(READER_FACING_SUFFIX))
      : []

  // Read while paths are still absolute (reliable regardless of cwd), then
  // relativize the ONE time it matters: what a finding actually names.
  const docs = readAll([...shipsPaths, ...readerFacingPaths]).map((f) => ({
    ...f,
    path: toPosix(relative(root, f.path))
  }))

  const readerFacingPrefix =
    readerFacingRootAbs !== null ? `${toPosix(relative(root, readerFacingRootAbs))}/` : '/no-reader-facing-surface'
  const readerFacingSuffix = READER_FACING_ACTIVE && READER_FACING_SUFFIX !== null ? READER_FACING_SUFFIX : '/page.tsx'

  const citedQuotes = findCitedQuotes(docs, readerFacingPrefix, readerFacingSuffix, shipsPrefix)

  const citedFileContents = new Map<string, string>()
  for (const quote of citedQuotes) {
    if (citedFileContents.has(quote.citedFile)) continue
    const abs = join(root, quote.citedFile)
    if (existsSync(abs) && statSync(abs).isFile()) {
      citedFileContents.set(quote.citedFile, readFileSync(abs, 'utf8'))
    }
  }

  const findings = evaluateCitedQuotes(citedQuotes, citedFileContents)

  // stdout only — stderr is the CheckError JSON channel (contract.ts).
  console.log(
    `${CHECK_NAME}: doctrine root "${DOCTRINE_ROOT}"; ${citedQuotes.length} marked quote(s) found; ${findings.length} finding(s)`
  )

  for (const finding of findings) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'warning',
      message: finding.message,
      file: finding.file,
      line: finding.line,
      agent_recovery_prompt: `This doc marks a quote of \`${finding.citedFile}\` (AEG:QUOTES-FILE marker) that no longer matches that file verbatim. Either update the quoted text in the doc to match \`${finding.citedFile}\`'s current content, or update \`${finding.citedFile}\` if the doc's claim is what should be true. Do not simply remove the marker to silence this — the doc would still be making an unverified claim.`
    })
  }

  // Report-only — see module doc.
  process.exit(0)
}

main()
