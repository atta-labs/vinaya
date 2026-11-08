import { isEntryPoint } from '../../../../../kernel/gates/checks/entry-point.js'
import { forgeSnapshotCommand } from '../../../../../kernel/adapters/code-host/github/forge-snapshot'

/**
 * `vinaya pr snapshot --dir <dir>` — CI plumbing, not a user command: the
 * generated workflows' pull request read step hands its REST reads to this
 * to write the forge snapshot their checks read. All of it lives in
 * `lib/forge-snapshot.ts`, the one owner of writing and reading the snapshot.
 */
export function prSnapshotCommand(args: string[]): void {
  forgeSnapshotCommand(args)
}

// Run as a program (`vinaya-pr-snapshot`): started through the shared program entry.
if (isEntryPoint(import.meta.url, 'pr-snapshot')) {
  const { runProgram } = await import('../../program-entry.js')
  await runProgram('pr-snapshot', async (argv: string[]) => {
    prSnapshotCommand(argv)
  })
}
