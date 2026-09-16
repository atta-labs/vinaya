#!/usr/bin/env bun

/**
 * Core check: doctrine-no-procedures. Thin adapter over `@attalabs/aeg-core`'s
 * `checkDoctrineNoProcedures` — task 9's rule that
 * doctrine describes no command sequence, made a check. Unlike its sibling
 * `doctrine-portability` (baseline mode, warning-only — task 234's corpus
 * had 200+ pre-existing findings), this is a fresh rule with an expected-zero
 * corpus after this task's own Part 3 sweep-and-fix, so it blocks: a finding
 * is `severity: error`, exit 1.
 *
 * **No `REPO_ROOT`/`process.chdir()`, same reasoning as its siblings.** Paths
 * are read relative to `process.cwd()` — the caller's own repo root, wherever
 * this bin actually runs from once bundled into an installed package.
 *
 * scope: full — the swept surface is the whole doctrine tree, not the PR's
 * own file list.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { checkDoctrineNoProcedures, type DoctrineFile } from '@attalabs/aeg-core'
import { loadConfig } from '../../lib/config'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'

const CHECK_NAME = 'doctrine-no-procedures'

/** Same config key and same default as `doctrine-portability`/`reader-resolvable-prose`. */
const DOCTRINE_ROOT = loadConfig()?.proseGates?.doctrineRoot ?? 'aeg-root'

/** Recursively collects repo-relative `.md` paths under `dir`. Missing/unreadable `dir` degrades to `[]`, never throws — an adopter with no `<doctrineRoot>` at all has nothing to sweep, not an error. */
function collectMarkdown(dir: string, out: string[] = []): string[] {
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
      collectMarkdown(full, out)
    } else if (name.endsWith('.md')) {
      out.push(full)
    }
  }
  return out
}

function readFiles(paths: string[]): DoctrineFile[] {
  return paths.map((p) => ({ path: p, content: readFileSync(p, 'utf8') }))
}

function main(): void {
  const files = readFiles(collectMarkdown(DOCTRINE_ROOT))
  const findings = checkDoctrineNoProcedures(files)

  // stdout only — this check's stderr is the CheckError JSON channel
  // (`contract.ts`'s `emitCheckError`); a plain-text line there would make
  // the runner treat this human-readable summary as malformed output and
  // report `status: 'error'` regardless of exit code.
  console.log(
    `${CHECK_NAME}: doctrine root "${DOCTRINE_ROOT}"; ${files.length} file(s) swept; ${findings.length} finding(s)`
  )

  for (const finding of findings) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: `${finding.file}:${finding.line}: ${finding.message}`,
      file: finding.file,
      line: finding.line,
      agent_recovery_prompt:
        'This fenced block strings together two or more shell-command lines — a runbook, not an illustration, and it rots ' +
        'the moment the real command changes. Name it as a `vinaya` command (or the underlying script it wraps) instead of ' +
        'spelling out the sequence, or move the block inside the `AEG:VENDOR-EXAMPLE` anchor pair, or under a `templates/` ' +
        'directory if it is a worked-example template.'
    })
  }

  process.exit(findings.length === 0 ? 0 : 1)
}

main()
