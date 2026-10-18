import { forgeSnapshotCommand } from '../lib/forge-snapshot'

/**
 * `vinaya pr snapshot --dir <dir>` — CI plumbing, not a user command: the
 * generated workflows' pull request read step hands its REST reads to this
 * to write the forge snapshot their checks read. All of it lives in
 * `lib/forge-snapshot.ts`, the one owner of writing and reading the snapshot.
 */
export function prSnapshotCommand(args: string[]): void {
  forgeSnapshotCommand(args)
}
