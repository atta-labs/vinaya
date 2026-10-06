/**
 * The pre-push hook's own test selection, as one function of a repository and
 * a base ref — so the hook, and CI's report of which failing test files that
 * hook would have run, answer from the same code rather than two copies that
 * could drift apart.
 */
import { isAbsolute, join, relative } from 'node:path'
import { affectedNames } from './changed-names.js'
import { loadConfig } from './config.js'
import {
  addedOrRenamedFilesSinceRemoteBaseAbsolute,
  changedFileDiffsSinceRemoteBase,
  changedFilesSinceRemoteBaseAbsolute,
  removedFilesSinceRemoteBaseAbsolute,
  resolveRemoteBase
} from './remote-base.js'
import { type SelectionResult, selectAffectedTestFiles } from './test-selector.js'
import { loadTypeScript } from './ts-module-graph.js'

/**
 * What pre-push selects for the diff between `base` and `HEAD` — by default
 * the base the hook itself resolves (the branch's upstream, then
 * `origin/main`). CI passes the pull request's own base commit instead.
 */
export function prePushSelection(repoRoot: string, base = resolveRemoteBase(repoRoot)): SelectionResult {
  const changed = changedFilesSinceRemoteBaseAbsolute(repoRoot, base)
  const addedOrRenamed = addedOrRenamedFilesSinceRemoteBaseAbsolute(repoRoot, base)
  const removed = removedFilesSinceRemoteBaseAbsolute(repoRoot, base)
  const alwaysRun = loadConfig()?.prePush?.alwaysRun ?? []
  // The changed NAMES and touched lines, when the compiler is there to parse
  // them; without it the selector falls back to the file-level answer on its own.
  const typescript = loadTypeScript(repoRoot)
  const diffs = typescript ? changedFileDiffsSinceRemoteBase(repoRoot, base) : undefined
  const names = typescript && diffs ? affectedNames(typescript, diffs) : undefined
  const changedRanges = diffs ? new Map(diffs.map((d) => [d.file, d.afterRanges])) : undefined
  // Never the full transitive closure a push away from
  // main can grow to — that stays CI's job (every shard still runs every
  // test). Depth-one keeps a push to a widely-imported module small: the
  // test files this diff changed, the test files that import a changed
  // name directly, the folder-scanning tests whose declared kind of change
  // this is, and `prePush.alwaysRun`.
  return selectAffectedTestFiles(repoRoot, changed, {
    alwaysRun,
    addedOrRenamed,
    removed,
    changedRanges,
    affectedNames: names,
    depth: 'one'
  })
}

/**
 * The test files a JUnit report (`bun test --reporter=junit`) records as
 * failing — a suite with a failure or an error — as absolute paths, resolved
 * against `testsCwd`, the directory the run was started from.
 */
export function failingTestFilesFromJunit(xml: string, testsCwd: string): string[] {
  const failing = new Set<string>()
  for (const match of xml.matchAll(/<testsuite\b([^>]*)>/g)) {
    const attributes = match[1] as string
    const attribute = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1]
    const file = attribute('file') ?? attribute('name')
    if (!file) continue
    if (Number(attribute('failures') ?? 0) > 0 || Number(attribute('errors') ?? 0) > 0) {
      failing.add(isAbsolute(file) ? file : join(testsCwd, file))
    }
  }
  return [...failing].sort()
}

/**
 * One line per failing test file: whether pre-push would have selected it
 * for this diff. A file pre-push would have run, failing only in CI, points
 * at a difference between the two machines; a file it would not have run is
 * a selection escape — the gap a scanner declaration or an import edge
 * should close.
 */
export function escapeReportLines(repoRoot: string, failing: readonly string[], selected: readonly string[]): string[] {
  const chosen = new Set(selected)
  if (failing.length === 0) return ['vinaya escape report: no failing test file recorded in the report.']
  return failing.map((file) =>
    chosen.has(file)
      ? `vinaya escape report: ${relative(repoRoot, file)} — pre-push selects it for this diff: a platform difference, not a selection gap.`
      : `vinaya escape report: ${relative(repoRoot, file)} — pre-push does NOT select it for this diff: a selection escape.`
  )
}
