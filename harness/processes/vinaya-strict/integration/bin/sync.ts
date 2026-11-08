// `vinaya sync` (O1–O7): fills, resumes and rebuilds the local log cache from
// this repository's configured destination. Argument parsing only — the
// whole flow (resolve the destination, pick the source, open the cache, run
// the bounded engine, print the summary, pick the exit code) lives behind
// the one library call below (`apps/cli/specs/surface.md`).

import { isEntryPoint } from '../../../../kernel/gates/checks/entry-point.js'
import { runLogSync } from '../../../../kernel/log/client/log-sync.js'

export async function syncCommand(args: string[]): Promise<number> {
  return runLogSync({ rebuild: args.includes('--rebuild'), json: args.includes('--json') })
}

// Run as a program (`vinaya-sync`): started through the shared program entry.
if (isEntryPoint(import.meta.url, 'sync')) {
  const { runProgram } = await import('../../tools/program-entry.js')
  await runProgram('sync', async (argv: string[]) => {
    process.exit(await syncCommand(argv))
  })
}
