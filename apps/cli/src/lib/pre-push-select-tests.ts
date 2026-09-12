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
import { loadConfig } from './config.js'
import { addedOrRenamedFilesSinceRemoteBaseAbsolute, changedFilesSinceRemoteBaseAbsolute } from './remote-base.js'
import { selectAffectedTestFiles } from './test-selector.js'

function main(): void {
  const repoRoot = process.cwd()
  const changed = changedFilesSinceRemoteBaseAbsolute(repoRoot)
  const addedOrRenamed = addedOrRenamedFilesSinceRemoteBaseAbsolute(repoRoot)
  const alwaysRun = loadConfig()?.prePush?.alwaysRun ?? []
  const { selected, totalTestFiles } = selectAffectedTestFiles(repoRoot, changed, { alwaysRun, addedOrRenamed })

  for (const file of selected) process.stdout.write(`${file}\n`)
  process.stderr.write(`vinaya pre-push: selected ${selected.length} of ${totalTestFiles} test file(s)\n`)
}

main()
