#!/usr/bin/env bun

/**
 * Core check: workspace-escape. Thin adapter over `@attalabs/aeg-core`'s
 * `findWorkspaceEscapes` (task 17, Issue #78) — the class neither the
 * workspace dependency graph nor a literal-path grep can see: a constructed
 * filesystem reference (`readFileSync`, `readFile`, `new URL('…',
 * import.meta.url)`) that resolves outside the citing file's own workspace
 * package, or to a path that does not exist at all. Measured 2026-08-16
 * during attalabs' adoption of the published CLI: deleting the vendored CLI
 * workspace looked safe by both instruments (nothing depended on it; no
 * source file referenced it by name) and broke a sibling workspace's test
 * suite anyway.
 *
 * Deliberately does not police `import`/`require` module specifiers — the
 * dependency graph already covers those; duplicating it here would be
 * noise, not signal.
 *
 * Static source scanning only, no execution of the scanned code, no
 * network. No `REPO_ROOT`/`process.chdir()` — paths are read relative to
 * `process.cwd()`, same reasoning as `check-reader-resolvable-prose.ts`/
 * `check-doctrine-portability.ts`.
 *
 * **Report-only, same G1/G2 rollout precedent as `reader-resolvable-prose`/
 * `retired-vocabulary`/`doctrine-portability`:** findings print as `warning`
 * severity, exit code always 0. This repo's own corpus carries one real
 * pre-existing finding (`packages/sources/src/commands-router-coverage.test.ts`
 * reaching into `apps/cli/src/index.ts` via a constructed relative path,
 * structurally the same incident this check exists to catch) — a blocking
 * check on day one would fail this repo's own CI on that finding before
 * anyone has triaged fixing it, which is a separate task's surface, not
 * this one's.
 *
 * scope: full — the swept surface is every `.ts`/`.tsx` file under the
 * workspace packages, not just the PR's own changed-file list; a file left
 * untouched by a diff can still be the one that escapes.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { findWorkspaceEscapes, type WorkspaceEscapeSourceFile } from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'

const CHECK_NAME = 'workspace-escape'
const WORKSPACE_DIRS = ['apps', 'packages']
const SOURCE_EXTENSIONS = ['.ts', '.tsx']
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.turbo', '.next', '.git'])

/**
 * Every repo-relative path under `dir` — files AND directories, so a
 * reference to a directory itself (`new URL('.', import.meta.url)`, or
 * `'../bin'` naming a directory, not a file) resolves as "exists" — the
 * existence-check universe `findWorkspaceEscapes` needs to tell "escapes to
 * a real sibling package" apart from "points at nothing at all". Missing/
 * unreadable `dir` degrades to `[]`, same as `check-doctrine-portability.ts`'s
 * identical working-tree walker.
 */
function collectAllPaths(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (EXCLUDED_DIRS.has(name)) continue
    const full = join(dir, name)
    let isDir: boolean
    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue
    }
    out.push(full)
    if (isDir) collectAllPaths(full, out)
  }
  return out
}

function main(): void {
  const allPaths = WORKSPACE_DIRS.flatMap((d) => collectAllPaths(d)).map((p) => p.split('\\').join('/'))
  const knownPaths = new Set(allPaths)

  const sourceFiles: WorkspaceEscapeSourceFile[] = allPaths
    .filter((p) => SOURCE_EXTENSIONS.some((ext) => p.endsWith(ext)))
    .map((p) => ({ path: p, content: readFileSync(p, 'utf8') }))

  const findings = findWorkspaceEscapes(sourceFiles, knownPaths, WORKSPACE_DIRS)

  // stdout only — this check's stderr is the CheckError JSON channel
  // (`contract.ts`'s `emitCheckError`); a plain-text line there would make
  // the runner treat this human-readable summary as malformed output and
  // report `status: 'error'` regardless of exit code.
  console.log(
    `${CHECK_NAME}: ${sourceFiles.length} source file(s) scanned under ${WORKSPACE_DIRS.join('/')}; ${findings.length} finding(s)`
  )

  for (const finding of findings) {
    const what =
      finding.reason === 'escapes-workspace-package'
        ? `resolves to "${finding.resolved}", outside this file's own workspace package`
        : `resolves to "${finding.resolved}", which does not exist`
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'warning',
      message: `${finding.file}:${finding.line}: constructed filesystem reference "${finding.reference}" ${what}`,
      file: finding.file,
      line: finding.line,
      agent_recovery_prompt:
        finding.reason === 'escapes-workspace-package'
          ? "This filesystem reference reaches outside its own workspace package via a constructed path — the module dependency graph does not see this, so deleting or moving the target package will not warn this file's owner. Move the referenced file into this package, or replace the constructed path with a real package dependency (import from the target package's published entry point instead)."
          : 'This filesystem reference resolves to a path that does not exist. Fix the path, or remove the reference if the file it once pointed to is gone.'
    })
  }

  // Report-only, same G1/G2 precedent as reader-resolvable-prose/retired-vocabulary/doctrine-portability.
  process.exit(0)
}

main()
