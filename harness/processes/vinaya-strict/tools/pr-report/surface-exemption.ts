/**
 * A command that does not yet call exactly one `apps/cli/src/lib/**` chokepoint
 * (per Principal ruling) declares this, in its own file, instead of
 * a row in a shared spec. `apps/cli/tests/surface-index.test.ts` reads it via a
 * dynamic import of the command's own file — never from a hand-maintained table.
 *
 * `callsToday` is a ratchet: it must equal the command entry function's real
 * in-scope call count (lib calls plus any refused command-to-command calls) at
 * every commit. A call added without bumping this number fails the test, so
 * drift is caught in the same file the call was added to.
 */
export interface SurfaceExemption {
  /** ISO date the exemption was recorded. */
  date: string
  /** The command's real in-scope call count today — a ratchet against silent growth. */
  callsToday: number
  /** The named chokepoint (existing or future) that retires this exemption. */
  retiresVia: string
}
