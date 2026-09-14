// Imports and runs the SHIPPED `acquireOwnership` from
// `packages/aeg-core/src/control-store/local.ts` directly — never a
// hand-duplicated stand-in — as a genuinely separate OS process.
// `acquireOwnership` is the real public entry point whose own retry loop
// drives `attemptEpochClaim`, which in turn drives `exclusiveCreateFile`:
// the double-ownership defect this fixture exists to catch spanned exactly
// that chain (a claim publishing its content in a separate, later-visible
// step, and the retry loop's own reclaim-a-corrupt-slot path reclaiming a
// still-being-written claim out from under its writer), so racing this
// real chain — not one function from it in isolation — is what actually
// proves the fix.
//
// Argv: <rootDir> <task> <ownerId>. Prints one JSON line to stdout:
// `{ "acquired": true, "epoch": <n> } | { "acquired": false, "currentEpoch": <n>, "currentOwnerId": <string|null> }`.

import { hostname } from 'node:os'
import { acquireOwnership, type ControlStoreDeps } from '../../src/control-store/local'

const [, , rootDir, taskArg, ownerId] = process.argv as [string, string, string, string]
const task = Number.parseInt(taskArg, 10)

const deps: ControlStoreDeps = {
  root: () => rootDir,
  now: () => new Date(),
  pid: () => process.pid,
  hostname: () => hostname()
}

const result = acquireOwnership(deps, task, ownerId)
process.stdout.write(`${JSON.stringify(result)}\n`)
