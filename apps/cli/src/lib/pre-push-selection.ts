/**
 * The pre-push hook's own test selection, as one function of a repository and
 * a base ref, so any caller that needs to know what the hook runs for a diff
 * answers from the hook's own code rather than a copy that could drift.
 */
import { affectedNames } from './changed-names.js'
import { loadConfig } from './config.js'
import {
  addedOrRenamedFilesSinceRemoteBaseAbsolute,
  changedFileDiffsSinceRemoteBase,
  changedFilesSinceRemoteBaseAbsolute,
  type ReadFailure,
  removedFilesSinceRemoteBaseAbsolute,
  resolveRemoteBase
} from './remote-base.js'
import { type SelectionOptions, type SelectionResult, selectAffectedTestFiles } from './test-selector.js'
import { loadTypeScript } from './ts-module-graph.js'

/**
 * What pre-push selects for the diff between `base` and `HEAD` — by default
 * the base the hook itself resolves (the branch's upstream, then
 * `origin/main`). `depth` defaults to the hook's own `'one'`; a pull
 * request's CI run passes `'transitive'` for the same selection walked to
 * its full closure. A caller that must tell a failed git read from an empty
 * change list passes `failure`: every read this selection makes reports into
 * it, and the selection itself is unchanged.
 */
export function prePushSelection(
  repoRoot: string,
  base = resolveRemoteBase(repoRoot),
  depth: NonNullable<SelectionOptions['depth']> = 'one',
  failure?: ReadFailure
): SelectionResult {
  const changed = changedFilesSinceRemoteBaseAbsolute(repoRoot, base, failure)
  const addedOrRenamed = addedOrRenamedFilesSinceRemoteBaseAbsolute(repoRoot, base, failure)
  const removed = removedFilesSinceRemoteBaseAbsolute(repoRoot, base, failure)
  const alwaysRun = loadConfig()?.prePush?.alwaysRun ?? []
  // The changed NAMES and touched lines, when the compiler is there to parse
  // them; without it the selector falls back to the file-level answer on its own.
  const typescript = loadTypeScript(repoRoot)
  const diffs = typescript ? changedFileDiffsSinceRemoteBase(repoRoot, base, failure) : undefined
  const names = typescript && diffs ? affectedNames(typescript, diffs) : undefined
  const changedRanges = diffs ? new Map(diffs.map((d) => [d.file, d.afterRanges])) : undefined
  // The hook never walks the full transitive closure a push away from
  // main can grow to — that stays CI's job (a pull request's shards walk it,
  // and `main` still runs every test). Depth-one keeps a push to a
  // widely-imported module small: the test files this diff changed, the test
  // files that import a changed name directly, the folder-scanning tests
  // whose declared kind of change this is, and `prePush.alwaysRun`.
  return selectAffectedTestFiles(repoRoot, changed, {
    alwaysRun,
    addedOrRenamed,
    removed,
    changedRanges,
    affectedNames: names,
    depth
  })
}
