// `vinaya sync` (O1–O7): fills, resumes and rebuilds the local log cache from
// this repository's configured destination. Argument parsing only — the
// whole flow (resolve the destination, pick the source, open the cache, run
// the bounded engine, print the summary, pick the exit code) lives behind
// the one library call below (`apps/cli/specs/surface.md`).

import { runLogSync } from '../lib/log-sync.js'

export async function syncCommand(args: string[]): Promise<number> {
  return runLogSync({ rebuild: args.includes('--rebuild'), json: args.includes('--json') })
}
