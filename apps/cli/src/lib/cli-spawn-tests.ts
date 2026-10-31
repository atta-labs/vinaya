/**
 * Detects a test file's own spawn of this repository's built CLI as a fresh
 * subprocess (`bun apps/cli/src/index.ts <args>`), so the selector can give it
 * one synthetic edge into the entrypoint's real import graph — measured live,
 * a one-file change to `apps/cli/src/lib/log-sink.ts` once passed the pre-push
 * hook and failed CI on exactly this class of test.
 *
 * The classifier is the selection library's (`verification/spawn-inputs.ts`,
 * `spawnEdgeOf`), generic over the binary and the entrypoint; this adapter
 * fixes the binary to `bun`, the one this repository's tests spawn the CLI
 * with, and keeps the name every existing caller imports.
 */
import type { TypeScriptApi } from './verification/compiler-graph.js'
import { type SpawnClassification, spawnEdgeOf } from './verification/spawn-inputs.js'

export type CliSpawnClassification = SpawnClassification

/** The binary this repository's tests spawn the CLI entrypoint with. */
export const CLI_SPAWN_BINARY = 'bun'

/**
 * Classifies one test file's own spawn shapes against `entrypoint` (the CLI's
 * real entrypoint file, absolute path): `'entrypoint'` when one call provably
 * spawns `bun <entrypoint>`, `'fallback'` when the file carries only one of the
 * two signals, `null` when it carries neither — see `spawnEdgeOf`.
 */
export function cliSpawnEdgeOf(
  ts: TypeScriptApi,
  file: string,
  source: string,
  repoRoot: string,
  entrypoint: string
): CliSpawnClassification | null {
  return spawnEdgeOf(ts, file, source, repoRoot, { binary: CLI_SPAWN_BINARY, entrypoint })
}
