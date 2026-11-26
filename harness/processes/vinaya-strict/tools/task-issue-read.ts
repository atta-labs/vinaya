/**
 * The read of the task's own Issue, shared by the two dispatch gate scripts.
 *
 * A read has three outcomes, never two: the Issue was read, the forge says the
 * Issue does not exist (a missing Issue), or the read itself failed. A failed
 * read says nothing about whether the Issue exists, so a caller must not
 * report it as missing; it carries `gh`'s own standard error instead.
 *
 * The outcome is decided from `gh`'s text, never its exit code: a missing
 * Issue and a dropped connection both exit 1.
 *   - the missing-Issue text is a missing Issue, and is never retried;
 *   - a line the driver's own classifier (`isGitHubConnectionFailure`) accepts
 *     is a connection failure, tried again after each of `RETRY_WAITS_MS`;
 *   - anything else is a failed read at once, with no wait.
 *
 * Only a successful read is remembered; a failed or missing one is asked of
 * the forge again by the next read in the same process.
 *
 * This module changes no working directory and runs nothing on import, so a
 * script that must not import another script can still call it.
 */

import { execFileSync } from 'node:child_process'
import { isGitHubConnectionFailure } from '../loops/dev-review/standalone/dev-review-loop/round-assess'

/** The waits before the first, second and third retry of a connection failure. */
export const RETRY_WAITS_MS: readonly number[] = [10_000, 30_000, 60_000]

/** `gh`'s wording for an Issue number the repository does not have — an answer, not a failed read. */
const ISSUE_NOT_FOUND = /could not resolve to an issue/i

export type TaskIssueRead<T> =
  | { outcome: 'read'; issue: T }
  | { outcome: 'missing' }
  /** `error` is `gh`'s standard error, verbatim and untrimmed. */
  | { outcome: 'failed'; error: string }

/** Runs `gh` with the arguments; returns its standard output, or throws an `Error` whose message is its standard error. */
export type GhRunner = (args: string[]) => string

export type TaskIssueReadDeps = {
  run?: GhRunner
  /** Blocks for the given milliseconds. */
  sleep?: (ms: number) => void
  /** Successful reads, by arguments. Defaults to one map per process. */
  cache?: Map<string, unknown>
}

const processCache = new Map<string, unknown>()

export const runGh: GhRunner = (args) => {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    const stderr = (err as { stderr?: unknown }).stderr
    const text = stderr === undefined || stderr === null ? '' : String(stderr)
    throw new Error(text !== '' ? text : err instanceof Error ? err.message : String(err))
  }
}

const blockingSleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Reads one Issue through `gh` with the given arguments (each caller passes its
 * own, `-R` and `--json` fields included) and parses the JSON it prints.
 * `retry: false` makes one attempt only, for a caller whose answer is not
 * worth a wait.
 */
export function readTaskIssue<T>(args: string[], deps: TaskIssueReadDeps & { retry?: boolean } = {}): TaskIssueRead<T> {
  const run = deps.run ?? runGh
  const sleep = deps.sleep ?? blockingSleep
  const cache = deps.cache ?? processCache
  const key = args.join('\u0000')
  if (cache.has(key)) return { outcome: 'read', issue: cache.get(key) as T }

  const waits = deps.retry === false ? [] : RETRY_WAITS_MS
  for (let attempt = 0; ; attempt += 1) {
    let text: string
    try {
      const out = run(args)
      let parsed: T
      try {
        parsed = JSON.parse(out) as T
      } catch {
        return { outcome: 'failed', error: `gh printed output that is not JSON: ${out}` }
      }
      cache.set(key, parsed)
      return { outcome: 'read', issue: parsed }
    } catch (err) {
      text = err instanceof Error ? err.message : String(err)
    }
    if (ISSUE_NOT_FOUND.test(text)) return { outcome: 'missing' }
    const wait = waits[attempt]
    if (wait === undefined || !isGitHubConnectionFailure(new Error(text))) return { outcome: 'failed', error: text }
    sleep(wait)
  }
}
