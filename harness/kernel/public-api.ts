/**
 * The kernel's library entry: what `@attalabs/vinaya/harness` exposes to a
 * consumer. Each symbol is named, never re-exported with `export *`, so the
 * public surface is exactly this list. The entry names no process.
 */
export { resolveRepo } from './adapters/code-host/github/resolve-repo'
export type { RepoRef, ResolveRepoExec } from './adapters/code-host/github/resolve-repo'
export { loadProcess } from './dev-process-socket/loader/load-process'
export type {
  LoadedProcess,
  LoadProcessOptions,
  ProcessIdentity,
  ProcessLoadReason,
  ProvidedPaths,
  ProvidedRolePaths
} from './dev-process-socket/loader/load-process'
