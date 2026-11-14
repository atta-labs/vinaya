/**
 * The review round's git read memo: one answer per local read-only git query, keyed by the effective working
 * directory and the argument list, so a round that asks the same question of the same repository many times starts
 * one git process for it between two changes to that repository.
 *
 * It serves only while an Engine round's own driver step runs (`withGitReadMemo`) and no agent turn is in flight
 * (`beginAgentTurn`/`endAgentTurn`); everywhere else, the standalone runner included, every read starts git as
 * before. It answers only the queries whose answer depends on refs and objects alone (`rev-parse`, `merge-base`,
 * `show-ref`, `for-each-ref`, `rev-list`), never a remote read (`ls-remote`) and never a working-tree read (`status`,
 * `diff`, `ls-files`), and never keeps a failed read. Any other git command that goes through it is treated as a
 * write and empties it once it ends, as does every step boundary, every agent turn's start and end, every Developer
 * tool call the driver serves, and every caller that knows it wrote or started a child process (`clearGitReadMemo`).
 */

import { resolve } from 'node:path'

/** The git subcommands whose answer is a function of the repository's refs and objects alone. */
const MEMOIZED = new Set(['rev-parse', 'merge-base', 'show-ref', 'for-each-ref', 'rev-list'])

/** The git subcommands that read without changing refs, but whose answer is never kept (remote or working-tree reads). */
const READ_ONLY_UNKEPT = new Set(['ls-remote', 'status', 'diff', 'ls-files', 'log', 'show', 'cat-file', 'merge-tree'])

/**
 * What the memo did with one call: a git process started (`served` when the memo was serving, the read was
 * memoizable and it succeeded, so its answer is kept), an answer served without one, or a clear.
 */
export type GitReadEvent =
  | { kind: 'spawn'; key: string; memoizable: boolean; served: boolean }
  | { kind: 'hit'; key: string }
  | { kind: 'clear'; reason: string }

interface MemoState {
  /** The driver steps running now: the memo serves while at least one is. */
  scopes: number
  /** The agent turns in flight now: the memo serves none of their reads. */
  turns: number
  entries: Map<string, string>
  listeners: Set<(event: GitReadEvent) => void>
}

const state: MemoState = { scopes: 0, turns: 0, entries: new Map(), listeners: new Set() }

const notify = (event: GitReadEvent): void => {
  for (const listener of state.listeners) listener(event)
}

/** The git subcommand of `args`, past any `-C <dir>`, `-c <key=value>` and other leading options. */
export function gitSubcommand(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '-C' || arg === '-c' || arg === '--git-dir' || arg === '--work-tree') {
      i++
      continue
    }
    if (arg.startsWith('-')) continue
    return arg
  }
  return undefined
}

/** The memo key: the effective working directory, then every argument, so `-C <dir>` and the cwd both count. */
export function gitReadKey(cwd: string | undefined, args: readonly string[]): string {
  return [resolve(cwd ?? process.cwd()), ...args].join('\0')
}

/** Whether a read made now would be served from (and kept in) the memo. */
export function gitReadMemoServing(): boolean {
  return state.scopes > 0 && state.turns === 0
}

/** Empties the memo: the repository may have changed. */
export function clearGitReadMemo(reason = 'cleared'): void {
  state.entries.clear()
  notify({ kind: 'clear', reason })
}

/**
 * Runs git through the memo: `run` starts the git process for `args` in `cwd` (the process's own cwd when absent) and
 * returns its output, or throws. A memoizable read made while the memo serves is answered from it when it holds the
 * key, and kept when it succeeds; a read-only command that is never kept just runs; any other command runs and then
 * empties the memo, whether it succeeded or not.
 */
export function runGit(cwd: string | undefined, args: readonly string[], run: () => string): string {
  const sub = gitSubcommand(args)
  const key = gitReadKey(cwd, args)
  const memoizable = sub !== undefined && MEMOIZED.has(sub)
  if (memoizable && gitReadMemoServing()) {
    const kept = state.entries.get(key)
    if (kept !== undefined) {
      notify({ kind: 'hit', key })
      return kept
    }
    let value: string
    try {
      value = run()
    } catch (error) {
      notify({ kind: 'spawn', key, memoizable: true, served: false })
      throw error
    }
    notify({ kind: 'spawn', key, memoizable: true, served: true })
    // A turn cannot start while this synchronous read runs, but a clear can have come from `run` itself.
    if (gitReadMemoServing()) state.entries.set(key, value)
    return value
  }
  notify({ kind: 'spawn', key, memoizable, served: false })
  if (memoizable || (sub !== undefined && READ_ONLY_UNKEPT.has(sub))) return run()
  try {
    return run()
  } finally {
    clearGitReadMemo(`git ${sub ?? '(none)'}`)
  }
}

/** `fn`, then a clear of the memo when it returns, throws or its promise settles: for a call that may write or start a child. */
export function clearingAfter<A extends unknown[], R>(fn: (...args: A) => R, reason: string): (...args: A) => R {
  return (...args: A): R => {
    let result: R
    try {
      result = fn(...args)
    } catch (error) {
      clearGitReadMemo(reason)
      throw error
    }
    if (result instanceof Promise) {
      return result.finally(() => clearGitReadMemo(reason)) as R
    }
    clearGitReadMemo(reason)
    return result
  }
}

const wrapped = new WeakMap<object, object>()

/**
 * `fns` with each function property except the named reads wrapped by `clearingAfter`: the bound functions a step
 * calls, of which any not known to be a pure read may write the repository or start a child process.
 */
export function clearingAfterEffects<T extends object>(fns: T, reads: ReadonlySet<string>): T {
  const known = wrapped.get(fns)
  if (known !== undefined) return known as T
  const proxy = new Proxy(fns, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function' || typeof property !== 'string' || reads.has(property)) return value
      return clearingAfter((...args: unknown[]) => Reflect.apply(value, target, args), `call ${property}`)
    }
  })
  wrapped.set(fns, proxy)
  // Wrapping the wrapper again hands it back unchanged.
  wrapped.set(proxy, proxy)
  return proxy
}

/** Runs one driver step with the memo serving: emptied as the step starts and again as it ends. */
export async function withGitReadMemo<T>(step: () => Promise<T>): Promise<T> {
  state.scopes += 1
  clearGitReadMemo('step start')
  try {
    return await step()
  } finally {
    state.scopes -= 1
    clearGitReadMemo('step end')
  }
}

/** An agent turn starts: the memo is emptied and serves no read until every turn in flight has ended. */
export function beginAgentTurn(): void {
  state.turns += 1
  clearGitReadMemo('agent turn start')
}

/** An agent turn ends: whatever it wrote is unseen, so the memo is emptied. */
export function endAgentTurn(): void {
  state.turns = Math.max(0, state.turns - 1)
  clearGitReadMemo('agent turn end')
}

/**
 * Runs `call` as a Developer tool call the driver serves: the memo is emptied on entry, serves none of the call's
 * reads (the agent may commit beside it), and is emptied again once the call returns, throws or its promise settles.
 */
export function servingDeveloperToolCall<R>(call: () => R): R {
  beginAgentTurn()
  let result: R
  try {
    result = call()
  } catch (error) {
    endAgentTurn()
    throw error
  }
  if (result instanceof Promise) return result.finally(endAgentTurn) as R
  endAgentTurn()
  return result
}

/** Observes every memo event until the returned function stops it: the spawn-count tests' window onto the loop's git. */
export function observeGitReads(listener: (event: GitReadEvent) => void): () => void {
  state.listeners.add(listener)
  return () => {
    state.listeners.delete(listener)
  }
}
