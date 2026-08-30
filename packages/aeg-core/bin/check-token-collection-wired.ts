#!/usr/bin/env bun

/**
 * check-token-collection-wired — self-hosting counterpart of the shipped
 * `apps/cli/src/checks/bin/check-token-collection-wired.ts` gate (task 5,
 * #272). Thin CLI/I/O shim: runs `resolveMeteringCapability` against real
 * `fs`/`process.env`, then the SAME `isTokenCollectionWiringBroken`
 * predicate the shipped check uses — one predicate, two thin shims, the
 * `isNewDiskStateFile`/`check-no-disk-state.ts` precedent. Exists so this
 * repo's own governance-registry gates (`verify-registry.ts`'s G1/G2, and
 * the `--scaffold` writer) have a `packages/aeg-core/bin/*.ts` candidate to
 * resolve `aeg-root/enforcement.md`'s ring-0 row against — the shipped
 * check under `apps/cli/src/checks/bin/` is invisible to that scaffold's
 * candidate glob (confirmed live: `--scaffold` reported nothing to insert
 * before this file existed).
 *
 * Usage: bun packages/aeg-core/bin/check-token-collection-wired.ts
 * Exit code: 0 (wired, or genuinely unwired — sanctioned) or 1 (wired but
 * unreachable — a wiring defect, named in the message).
 */

import { existsSync, readFileSync } from 'node:fs'
import { isTokenCollectionWiringBroken, resolveMeteringCapability } from '../src/index'

const capability = resolveMeteringCapability({
  env: process.env,
  cwd: process.cwd(),
  exists: existsSync,
  readFile: (path: string) => readFileSync(path, 'utf8')
})

if (isTokenCollectionWiringBroken(capability) && !capability.capable) {
  console.error(
    'check-token-collection-wired: the token-report collection adapter resolved a wiring point ' +
      `(${capability.reason}) but could not reach it — ${capability.detail}`
  )
  process.exit(1)
}

console.log('check-token-collection-wired: pass (wired and reachable, or genuinely unwired).')
process.exit(0)
