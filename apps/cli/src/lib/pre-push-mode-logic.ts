/**
 * The pre-push hook's push mode as a pure decision (`pre-push-mode.ts` is the
 * hook's entrypoint that feeds it the live inputs).
 */
export type PushMode = 'storage' | 'ready' | 'default'

/** Where the review loop marks a worktree whose pushes are storage pushes. */
export const PUSH_MODE_MARKER = 'vinaya/push-mode'

const asMode = (value: string | undefined | null): PushMode | null => {
  const trimmed = value?.trim()
  return trimmed === 'storage' || trimmed === 'ready' || trimmed === 'default' ? trimmed : null
}

/**
 * The push's mode, or the refusal of a storage push. `openPullRequests` is
 * asked only for a storage push; a failed answer refuses it, since a storage
 * push that skips the tests must never land on a branch a pull request (and
 * its CI) already watches.
 */
export function resolvePushMode(input: {
  envMode: string | undefined
  marker: string | null
  branch: string
  openPullRequests: () => number
}): { ok: true; mode: PushMode } | { ok: false; reason: string } {
  const mode = asMode(input.envMode) ?? asMode(input.marker) ?? 'default'
  if (mode !== 'storage') return { ok: true, mode }
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
  return { ok: true, mode }
}
