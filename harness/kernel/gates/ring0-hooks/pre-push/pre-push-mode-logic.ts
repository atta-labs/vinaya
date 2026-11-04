/**
 * The pre-push hook's push mode as a pure decision (`pre-push-mode.ts` is the
 * hook's entrypoint that feeds it the live inputs).
 */
export type PushMode = 'storage' | 'ready' | 'default'

/** Where the review loop marks a worktree whose pushes are storage pushes. */
export const PUSH_MODE_MARKER = 'vinaya/push-mode'

/**
 * The storage marker a run of version 2 writes: storage pushes belong to that
 * one run, so the marker names the run, its branch and the process that runs
 * it. A marker whose process is gone (a crash), whose branch is not the one
 * being pushed, or that is not of this shape is stale and ignored.
 */
export type StorageMarker = { version: 1; mode: 'storage'; runId: string; branch: string; pid: number }

/** The marker's text for one run. */
export const storageMarkerText = (marker: Omit<StorageMarker, 'version' | 'mode'>): string =>
  `${JSON.stringify({ version: 1, mode: 'storage', ...marker })}\n`

/** Reads a storage marker, or `null` when it is missing or of another shape (an old plain `storage` line included). */
export function parseStorageMarker(text: string | null): StorageMarker | null {
  if (!text) return null
  try {
    const value = JSON.parse(text) as Partial<StorageMarker>
    if (value.version !== 1 || value.mode !== 'storage') return null
    if (typeof value.runId !== 'string' || value.runId === '') return null
    if (typeof value.branch !== 'string' || value.branch === '') return null
    if (typeof value.pid !== 'number' || !Number.isInteger(value.pid) || value.pid <= 0) return null
    return value as StorageMarker
  } catch {
    return null
  }
}

/** Storage pushes exist only on a task branch. */
export const isTaskBranch = (branch: string): boolean => branch.startsWith('task/')

/**
 * The push's mode, or the refusal of a storage push. The environment names
 * only `ready` or `default`: storage mode comes from a live run's marker
 * alone, on that run's own task branch. `openPullRequests` is asked only for
 * a storage push; a failed answer refuses it, since a storage push that skips
 * the tests must never land on a branch a pull request (and its CI) already
 * watches.
 */
export function resolvePushMode(input: {
  envMode: string | undefined
  marker: string | null
  branch: string
  isPidAlive: (pid: number) => boolean
  openPullRequests: () => number
}): { ok: true; mode: PushMode } | { ok: false; reason: string } {
  const env = input.envMode?.trim()
  if (env === 'ready' || env === 'default') return { ok: true, mode: env }
  const marker = parseStorageMarker(input.marker)
  const live =
    marker !== null && isTaskBranch(input.branch) && marker.branch === input.branch && input.isPidAlive(marker.pid)
  if (!live) return { ok: true, mode: 'default' }
  let open: number
  try {
    open = input.openPullRequests()
  } catch (error) {
    return {
      ok: false,
      reason: `a storage push runs no tests, so it must first confirm that no pull request is open for ${input.branch}, and that read failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  if (open > 0) {
    return {
      ok: false,
      reason: `a pull request is open for ${input.branch}: storage pushes (no tests) are allowed only while none is open — push without the storage mode so the selected tests run`
    }
  }
  return { ok: true, mode: 'storage' }
}
