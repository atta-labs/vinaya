#!/usr/bin/env bun

/**
 * Core check: reader-resolvable-prose. Thin adapter over
 * `@attalabs/aeg-core`'s `checkReaderResolvableProse` — the two mechanizable
 * classes (unresolvable references, undefined coined vocabulary) from
 * a three-class analysis of unresolvable prose. Class 3 (register/slop) stays with the
 * review role; it is not deterministic and is not attempted here.
 *
 * De-hardcoded: the doctrine root, reader-facing page
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
 * **Report-only, except one blocking class.** The `ships` and
 * `reader-facing` classes stay the original rollout precedent
 * (`aeg-root/enforcement.md`'s G1/G2 report-only period): findings print as
 * `warning` severity and never fail the exit code — a blocking check on day
 * one would fail every open PR that already carries some of this backlog,
 * and the report-only period is what lets that backlog surface and get
 * cleaned up before the gate turns strict. The `product` class — a
 * tranche-slug citation under `PRODUCT_SLUG_SCOPE` (CLI source, the CLI and
 * sources READMEs, the workflows, `.vinaya`) — is the one exception: its
 * finding is `blocking: true`, prints as `severity: 'error'`, and this run
 * exits `1` if any reportable finding is blocking. It runs at the pre-push
 * hook (`check --all --local`) over the diff and refuses the push, and again
 * in CI, blocking, over the same diff. Orthogonal exception: a
 * genuinely unresolvable doctrine root is not a backlog finding — `main()`
 * exits non-`0`/non-`1` for that case, so it reads as a distinct
 * `status: 'error'`, never a clean pass.
 *
 * scope: full — the SWEEP is the whole doctrine tree and the whole
 * reader-facing surface (when configured), never the PR's own diff; the
 * evaluator has to read every doctrine file to resolve a cross-file
 * reference correctly. But which findings get REPORTED is now diff-scoped
 * (`resolveChangedFiles`, lib/diff-evidence.ts) — full sweep, without that,
 * meant every PR reprinted this package's entire shipped-doctrine backlog
 * regardless of what it touched (found live on a real PR
 * that changed one `packages/aeg-core` test file and nothing under
 * `aeg-root/`). A real new coined-term/unresolvable-reference finding in a
 * file the PR actually changed still surfaces.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import {
  checkReaderResolvableProse,
  checkSourceComments,
  parseGlossaryTerms,
  PRODUCT_SLUG_SCOPE,
  type ProseSourceFile
} from '@attalabs/aeg-core'
import { hasDoctrineEntry, resolveDoctrineRoot } from '../../commands/doctrine.js'
import { loadConfig } from '../../lib/config'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { findingsInThisDiff, repoRoot } from '../../lib/diff-evidence'

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
 * with no relation to whether this repo's own `aeg-root/` exists
 * (reproduced live: the same commit, checked out one directory deeper
 * under a `node_modules`-named ancestor, silently swept zero files instead
 * of its real backlog).
 *
 * So the first-choice anchor here is `repoRoot()` (`git rev-parse
 * --show-toplevel`) — deterministic regardless of checkout shape, and
 * already the anchor `resolveChangedFiles()` below uses for the same reason.
 * Only when THAT doesn't resolve to a real doctrine root (a `vinaya init`
 * adopter with no repo-local `aeg-root/` of their own — settled
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
  if (proseGates?.doctrineRoot !== undefined) return proseGates.doctrineRoot
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

/** `undefined` globs — the default — leaves the class dormant, same discipline as `READER_FACING_ACTIVE` above. */
const SOURCE_COMMENTS_GLOBS = proseGates?.sourceComments?.globs ?? []
const SOURCE_COMMENTS_ALLOWLIST = proseGates?.sourceComments?.allowlist ?? []
const SOURCE_COMMENTS_SEVERITY: 'warning' | 'error' = proseGates?.sourceComments?.severity ?? 'warning'

/** issue-657, O6 — exact repo-relative spec paths skipped entirely by the spec class (below), same "declared, not silent" discipline every other exemption list in this file already uses. */
const SPEC_GRANDFATHER = proseGates?.specGrandfather ?? []

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

const PRODUCT_SCOPE_EXTENSIONS = new Set(['.ts', '.tsx', '.yml', '.md'])

/**
 * Every file under (or equal to) each `PRODUCT_SLUG_SCOPE` prefix, filtered
 * to `.ts`/`.tsx`/`.yml`/`.md`, using the same directory skips `collect`
 * already applies. Returned repo-relative to `root` — `classifyProseFile`'s
 * `product` match is a literal-prefix compare against `PRODUCT_SLUG_SCOPE`'s
 * own repo-relative strings, so these paths must stay in that coordinate
 * system even where `shipsPaths` above may be absolute (`DOCTRINE_ROOT`
 * resolves via `repoRoot()` on this repo).
 */
function collectProductScopeFiles(root: string): string[] {
  const out: string[] = []
  for (const prefix of PRODUCT_SLUG_SCOPE) {
    const abs = join(root, prefix)
    let isDir: boolean
    try {
      isDir = statSync(abs).isDirectory()
    } catch {
      continue
    }
    if (isDir) {
      for (const f of collect(abs)) {
        const rel = f.slice(root.length + 1)
        if (PRODUCT_SCOPE_EXTENSIONS.has(extname(rel))) out.push(rel)
      }
    } else if (PRODUCT_SCOPE_EXTENSIONS.has(extname(prefix))) {
      out.push(prefix)
    }
  }
  return out
}

function readProductFiles(root: string, relPaths: string[]): ProseSourceFile[] {
  return relPaths.map((rel) => ({ path: rel, content: readFileSync(join(root, rel), 'utf8') }))
}

/**
 * issue-657, O6 — every `apps/<app>/specs/**\/*.md` file, across EVERY app
 * directory (never hardcoded to `apps/cli`, since the same exemption gap
 * applies wherever a future app grows its own `specs/`), returned
 * repo-relative to `root` — the same coordinate system `isSpecFile`
 * (`@attalabs/aeg-core`) compares against. A repo with no `apps/` directory
 * at all (an adopter whose product tree lives elsewhere) degrades to `[]`,
 * never a thrown error — the same dormancy discipline `collect` itself
 * already uses for a missing directory.
 */
function collectSpecFiles(root: string): string[] {
  const out: string[] = []
  const appsDir = join(root, 'apps')
  let appNames: string[]
  try {
    appNames = readdirSync(appsDir).filter((name) => {
      try {
        return statSync(join(appsDir, name)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return out
  }
  for (const app of appNames) {
    const specsDir = join(appsDir, app, 'specs')
    let isDir: boolean
    try {
      isDir = statSync(specsDir).isDirectory()
    } catch {
      continue
    }
    if (!isDir) continue
    for (const f of collect(specsDir)) {
      const rel = f.slice(root.length + 1)
      if (rel.endsWith('.md')) out.push(rel)
    }
  }
  return out
}

/**
 * The source-comment class's file set — entirely config-driven, unlike the
 * fixed `PRODUCT_SLUG_SCOPE` above. Each `proseGates.sourceComments.globs`
 * entry is a repo-relative directory (or file) root, swept recursively for
 * `.ts` files the same way `collectProductScopeFiles` sweeps its own fixed
 * list — "globs" names the config field (matching the brief's own
 * vocabulary for it), not a shell glob syntax this function implements.
 */
function collectSourceCommentFiles(root: string, globs: readonly string[]): string[] {
  const out: string[] = []
  for (const prefix of globs) {
    const abs = join(root, prefix)
    let isDir: boolean
    try {
      isDir = statSync(abs).isDirectory()
    } catch {
      continue
    }
    if (isDir) {
      for (const f of collect(abs)) {
        const rel = f.slice(root.length + 1)
        if (extname(rel) === '.ts') out.push(rel)
      }
    } else if (extname(prefix) === '.ts') {
      out.push(prefix)
    }
  }
  return out
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
 * uncaught out of `main()` — a read failure here is not a backlog finding
 * and not the genuinely-unresolvable-root case either, so it must not turn
 * into an uncaught exception that would exit non-`0` for the wrong reason.
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
  // found nothing" (the exact failure this class exists to close). This is
  // orthogonal to the check's own report-only exit-0 policy
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

  const productRoot = repoRoot() ?? process.cwd()
  const productRelPaths = collectProductScopeFiles(productRoot)
  const productFiles = readProductFiles(productRoot, productRelPaths)

  const sourceCommentRelPaths = collectSourceCommentFiles(productRoot, SOURCE_COMMENTS_GLOBS)
  const sourceCommentFiles = readProductFiles(productRoot, sourceCommentRelPaths)

  const specRelPaths = collectSpecFiles(productRoot)
  const specFiles = readProductFiles(productRoot, specRelPaths)

  const files = [...readAll([...shipsPaths, ...readerFacingPaths]), ...productFiles, ...specFiles]
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
    shipsPrefix,
    SPEC_GRANDFATHER
  )

  // `resolveChangedFiles()` returns absolute paths, resolved against the
  // real repo root (`git rev-parse --show-toplevel`), never an assumed
  // `process.cwd()` (a MAJOR review finding: a check bin invoked from
  // any other cwd silently matched nothing under the old cwd-relative
  // comparison). `finding.file` is usually already absolute — it comes from
  // `collect(DOCTRINE_ROOT)`, walked from an absolute `repoRoot()`- or
  // `resolveDoctrineRoot()`-derived path — but `DOCTRINE_ROOT` can also be a
  // relative `proseGates.doctrineRoot` config value. Anchor
  // to the SAME real repo root `resolveChangedFiles()` used, not a second,
  // independent `process.cwd()` assumption (a MINOR review finding:
  // the two absolute-path shapes were each internally consistent but could
  // still diverge from each other outside the common invocation shape) —
  // falling back to `process.cwd()` only if this process is somehow outside
  // any git worktree at all, which `resolveChangedFiles()` itself already
  // degrades to `null` for.
  //
  // `null` (no diff boundary could be established at all — a bare/single-
  // commit repo with no `origin` remote, or a shallow clone/orphan history
  // with no merge base, a BLOCKER review finding) reports every
  // finding unfiltered, same as before diff-scoping existed — indeterminate
  // must never collapse into "confirmed clean." Only an ACTUAL
  // resolved-but-empty diff suppresses findings.
  // Line-scoped, not merely file-scoped: a finding prints only when
  // its own line falls inside a changed hunk of a file this diff touched.
  // `findingsInThisDiff` owns both halves — one hunk parser for the whole
  // repo, and the same "indeterminate reports everything" rule
  // `resolveChangedFiles` already established. Full-sweep mode (no diff
  // boundary resolvable at all) is unchanged.
  const reportable = findingsInThisDiff(findings)

  const sourceCommentFindings = checkSourceComments(sourceCommentFiles, SOURCE_COMMENTS_ALLOWLIST)
  const reportableSourceComments = findingsInThisDiff(sourceCommentFindings)

  // stdout only — this check's stderr is the CheckError JSON channel
  // (`contract.ts`'s `emitCheckError`); a plain-text line there would make
  // the runner treat this human-readable summary as malformed output and
  // report `status: 'error'` regardless of exit code.
  console.log(
    `${CHECK_NAME}: doctrine root "${DOCTRINE_ROOT}"; reader-facing class ${READER_FACING_ACTIVE ? 'ran' : 'dormant — proseGates.readerFacingPrefix/readerFacingSuffix not both set'}; ` +
      `legacy-slug class ${legacySlugsDormant ? `dormant — ${legacySlugDir} is absent` : `ran (${slugs.length} slug(s))`}; ` +
      `product class ran (${productRelPaths.length} file(s) swept); ` +
      `spec class ran (${specRelPaths.length} file(s) swept, ${SPEC_GRANDFATHER.length} grandfathered); ` +
      `source-comment class ${SOURCE_COMMENTS_GLOBS.length === 0 ? 'dormant — proseGates.sourceComments.globs not set' : `ran (${sourceCommentRelPaths.length} file(s) swept, severity: ${SOURCE_COMMENTS_SEVERITY})`}; ` +
      `${findings.length + sourceCommentFindings.length} finding(s) swept, ${reportable.length + reportableSourceComments.length} in this diff`
  )

  let hasBlocking = false
  for (const finding of reportable) {
    if (finding.blocking) hasBlocking = true
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: finding.blocking ? 'error' : 'warning',
      message: `${finding.file}:${finding.line}: ${finding.message}`,
      file: finding.file,
      line: finding.line,
      agent_recovery_prompt: finding.message.includes('coined term')
        ? 'This page uses AEG/Vinaya-internal vocabulary a first-time reader cannot resolve. Either define the term ' +
          'inline (the same "Term — one-sentence definition" shape the glossary uses) at its first use on this page, ' +
          'or link to the glossary. Do not simply delete the word if the sentence needs it.'
        : finding.blocking && finding.file.includes('/specs/')
          ? 'This product spec cites a tranche, an Issue/PR number, or names a document outside this repository as ' +
            'its authority — a reader with no forge to resolve it against (a fork, an export, someone reading this ' +
            'spec after the Issue is closed) gets nothing from the citation. Rewrite the sentence to state the fact ' +
            'plainly instead. If this spec is pre-existing backlog, list its path in ' +
            '`proseGates.specGrandfather` rather than fixing it as a drive-by in an unrelated PR — do not add a ' +
            'NEW citation to a spec even while it is grandfathered.'
          : finding.blocking
            ? 'This product-code file cites an internal tranche slug a reader outside this repo cannot resolve ' +
              '(the reader-resolvable-prose product class). Remove the citation or rewrite the comment/doc to state ' +
              'the fact plainly instead of pointing at the tranche that did it. This finding blocks the push and CI.'
            : 'This doctrine or page cites a forge number or an internal tranche slug the reader has no tracker to ' +
              'resolve. Rewrite the sentence to state the fact plainly instead of pointing at the citation — say ' +
              'what was learned/decided, not where it was logged.'
    })
  }

  for (const finding of reportableSourceComments) {
    const blocking = SOURCE_COMMENTS_SEVERITY === 'error'
    if (blocking) hasBlocking = true
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: blocking ? 'error' : 'warning',
      message: `${finding.file}:${finding.line}: ${finding.message}`,
      file: finding.file,
      line: finding.line,
      agent_recovery_prompt:
        'This source comment cites a tranche name or a forge number a reader outside this repo cannot resolve. ' +
        'Rewrite the comment to state the fact it pointed at, or, for a comment that deliberately pins historical ' +
        'content (a test fixture), add its file path to proseGates.sourceComments.allowlist in vinaya.config.json.'
    })
  }

  // Report-only for `ships`/`reader-facing` findings — that backlog surfaces
  // and gets cleaned up before the gate turns strict (mirrors the G1/G2
  // rollout in `aeg-root/enforcement.md`). The `product` class is always
  // blocking; the source-comment class is blocking only once
  // `proseGates.sourceComments.severity` is set to `'error'`.
  process.exit(hasBlocking ? 1 : 0)
}

main()
