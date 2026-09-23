#!/usr/bin/env node
/**
 * The pre-push hook's own entrypoint into the test
 * selector. Standalone (not routed through `index.ts`/`commands/`) so it
 * bundles and ships exactly like `checks/bin/*.ts` does, and so the hook can
 * invoke it directly without paying for the whole CLI's argv-parsing layer.
 *
 * Contract with the generated hook (`artifacts.ts`'s `prePushBody`): prints
 * one absolute test-file path per line to STDOUT (empty output means
 * nothing was selected — a valid, common outcome, not an error), and the
 * human-facing "selected N of M" line to STDERR, so the hook's own
 * `$(...)` capture of STDOUT is never polluted by it.
 */
import { affectedNames } from './changed-names.js'
import { loadConfig } from './config.js'
import {
  addedOrRenamedFilesSinceRemoteBaseAbsolute,
  changedFileDiffsSinceRemoteBase,
  changedFilesSinceRemoteBaseAbsolute
} from './remote-base.js'
import { selectAffectedTestFiles } from './test-selector.js'
import { loadTypeScript } from './ts-module-graph.js'

function main(): void {
  const repoRoot = process.cwd()
  const started = performance.now()
  const changed = changedFilesSinceRemoteBaseAbsolute(repoRoot)
  const addedOrRenamed = addedOrRenamedFilesSinceRemoteBaseAbsolute(repoRoot)
  const alwaysRun = loadConfig()?.prePush?.alwaysRun ?? []
  // The changed NAMES, when the compiler is there to parse them; without it the
  // selector falls back to the file-level answer on its own.
  const typescript = loadTypeScript(repoRoot)
  const names = typescript ? affectedNames(typescript, changedFileDiffsSinceRemoteBase(repoRoot)) : undefined
  // O1 (Issue #707): never the full transitive closure a push away from
  // main can grow to — that stays CI's job (every shard still runs every
  // test). Depth-one keeps a push to a widely-imported module small: the
  // test files this diff changed, the test files that import a changed
  // name directly, and `prePush.alwaysRun`.
  const { selected, totalTestFiles, resolver, programMs } = selectAffectedTestFiles(repoRoot, changed, {
    alwaysRun,
    addedOrRenamed,
    affectedNames: names,
    depth: 'one'
  })
  const elapsed = performance.now() - started

  for (const file of selected) process.stdout.write(`${file}\n`)
  // Selector runtime is reported on its own, and split from the compiler
  // program build inside it, so a push-time budget can be judged against the
  // selector rather than against the tests it goes on to run.
  process.stderr.write(
    `vinaya pre-push: selected ${selected.length} of ${totalTestFiles} test file(s) ` +
      `[${resolver}, ${elapsed.toFixed(0)} ms selector, ${programMs.toFixed(0)} ms program]\n`
  )
}

main()
