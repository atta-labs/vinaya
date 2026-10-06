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
import { prePushSelection } from './pre-push-selection.js'

function main(): void {
  const repoRoot = process.cwd()
  const started = performance.now()
  const { selected, totalTestFiles, resolver, programMs } = prePushSelection(repoRoot)
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
