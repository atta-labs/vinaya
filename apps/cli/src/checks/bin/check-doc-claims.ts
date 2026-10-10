#!/usr/bin/env bun

/**
 * Core check: doc-claims. Thin adapter over `@attalabs/aeg-core`'s
 * `checkDocClaims` — every `AEG:CLAIM` marker in a doctrine page or source
 * comment re-asserted against the file it cites. A marker that parses as
 * neither form, and a binding whose cited file no longer holds its literal,
 * are both `severity: error`, exit 1: a sentence that reads as checked and is
 * not is the exact defect this check exists to catch, so it blocks.
 *
 * **The corpus is the standalone documentation verifier's, unchanged** —
 * every tracked doctrine page under `aeg-root/` and every tracked `.ts`/`.md`
 * file under `apps/` and `packages/`. Discovery goes through `git ls-files`,
 * never a directory walk, so a scratch file nobody committed is never swept.
 *
 * **A cited file is read only when git tracks it.** A crafted `contains:`
 * marker aimed at an untracked file present at check time would otherwise
 * read pass/fail as one bit about that file's content. Reading tracked
 * content only removes that oracle, and a marker citing an untracked file is
 * a claim resting on something no reviewer can see — reported as unreadable.
 *
 * **No `REPO_ROOT`/`process.chdir()`, same reasoning as its siblings.** Paths
 * are relative to `process.cwd()`, the caller's own repo root.
 *
 * scope: full — the swept surface is the whole corpus, not the PR's own file
 * list: a marker goes stale when its CITED file changes, which a diff of the
 * marker's own file never shows.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { checkDocClaims } from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'

const CHECK_NAME = 'doc-claims'

/** The same pathspecs the standalone documentation verifier sweeps for its doc-claim bindings. */
const CORPUS_PATHSPECS = ['aeg-root/*.md', 'apps/*.ts', 'apps/*.md', 'packages/*.ts', 'packages/*.md']

function gitLsFiles(pathspecs: readonly string[]): string[] {
  return execFileSync('git', ['ls-files', '--', ...pathspecs], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

function main(): void {
  const files = gitLsFiles(CORPUS_PATHSPECS)
    .filter((path) => existsSync(path))
    .map((path) => ({ path, content: readFileSync(path, 'utf8') }))

  const tracked = new Set(gitLsFiles([]))
  const readCited = (path: string): string | null =>
    tracked.has(path) && existsSync(path) ? readFileSync(path, 'utf8') : null

  const { findings, bindingCount } = checkDocClaims(files, readCited)

  // stdout only — this check's stderr is the CheckError JSON channel
  // (`contract.ts`'s `emitCheckError`); a plain-text line there would make
  // the runner treat this summary as malformed output.
  console.log(
    findings.length === 0
      ? `${CHECK_NAME}: ${bindingCount} binding(s) verified across ${files.length} file(s)`
      : `${CHECK_NAME}: ${findings.length} finding(s) among ${bindingCount} binding(s) across ${files.length} file(s)`
  )

  for (const finding of findings) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: finding.message,
      file: finding.file,
      line: finding.line,
      agent_recovery_prompt:
        'An `AEG:CLAIM` marker binds the sentence beside it to text its cited file must hold. When the binding no ' +
        'longer holds, re-read the cited code, correct the sentence to what the code does now, and re-bind it to a ' +
        'literal the file holds — or remove the sentence with its marker. Never reword the sentence while it is ' +
        'unbound, and never delete only the marker. A malformed marker must stand alone on its own line, in the form ' +
        '`<path> contains:<literal>` (or `absent:`/`sha256:`).'
    })
  }

  process.exit(findings.length === 0 ? 0 : 1)
}

main()
