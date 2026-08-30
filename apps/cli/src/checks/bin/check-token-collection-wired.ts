#!/usr/bin/env bun

/**
 * Core check: token-collection-wired (task 5, #272). Thin I/O adapter over
 * `@attalabs/aeg-core`'s
 * `resolveMeteringCapability` (task 1's probe) and this directory's own
 * `evaluateTokenCollectionWiring` (the pure predicate, tested independently).
 *
 * Ring 0, local, offline: `resolveMeteringCapability` touches only
 * `process.env` and a couple of `fs` stats/reads on a `TMPDIR` pointer file
 * and the transcript it names — no network, no PR body (none exists yet at
 * pre-commit; that's task 4's surface, not this one's).
 *
 * scope: full — a property of the host's current metering wiring, not the
 * diff.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolveMeteringCapability, type MeteringCapabilityDeps } from '@attalabs/aeg-core'
import { emitCheckError } from '../contract'
import { evaluateTokenCollectionWiring } from '../token-collection-wiring-logic'

const CHECK_NAME = 'token-collection-wired'

function main(): void {
  const deps: MeteringCapabilityDeps = {
    env: process.env,
    cwd: process.cwd(),
    exists: existsSync,
    readFile: (path: string) => readFileSync(path, 'utf8')
  }

  const capability = resolveMeteringCapability(deps)
  const result = evaluateTokenCollectionWiring(CHECK_NAME, capability)

  if (!result.pass) {
    emitCheckError(result.error)
    process.exit(1)
  }

  process.exit(0)
}

main()
