#!/usr/bin/env bun

/**
 * Core check: token-collection-wired. Thin I/O adapter over
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

import { lstatSync, readFileSync } from 'node:fs'
import { resolveMeteringCapability, type MeteringCapabilityDeps } from '@attalabs/aeg-core'
import { emitCheckError } from '../contract'
import { evaluateTokenCollectionWiring } from '../token-collection-wiring-logic'

const CHECK_NAME = 'token-collection-wired'

/**
 * Symlink- and owner-hardened stat/read, supplied as the probe's I/O deps.
 *
 * The pointer path is fully predictable — `$TMPDIR/claude-transcript-<key>.txt`,
 * and `TMPDIR` is unset on the usual CI/Linux default so `/tmp` is reached — and
 * its contents are then trusted as a path and opened. This check is what makes
 * that read happen automatically, unattended, on every commit and push in every
 * adopter, so a co-resident local user who wins the race to that name would
 * otherwise get a reliable commit-blocking denial of service and a file
 * existence oracle.
 *
 * The repo already accepted this exact threat model on the WRITER side:
 * `apps/cli/src/lib/claude-stop-hook-emitter.ts` records a prior review's CWE-59
 * finding on this same path and hardens the write with `wx` + rename. The read
 * side inherited the threat and none of the hardening; this is that half.
 *
 * `lstatSync` (never `statSync`) is the point — it describes the link itself, so
 * a symlink is refused rather than followed. Refusing a file owned by anyone but
 * this user closes the plant-a-real-file variant. Both degrade to "not usable",
 * never to a throw: an attacker must not be able to turn this into a crash
 * either.
 */
function safeLstat(path: string): { ok: true } | { ok: false } {
  try {
    const st = lstatSync(path)
    if (st.isSymbolicLink() || !st.isFile()) return { ok: false }
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return { ok: false }
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

function main(): void {
  const deps: MeteringCapabilityDeps = {
    env: process.env,
    cwd: process.cwd(),
    exists: (path: string) => safeLstat(path).ok,
    readFile: (path: string) => {
      // Re-checked immediately before the read. This narrows the TOCTOU window
      // rather than closing it — Node exposes no `O_NOFOLLOW` through
      // `readFileSync` — so the owner check above is what actually carries the
      // guarantee, and this is defence in depth.
      if (!safeLstat(path).ok) throw new Error(`refusing to read ${path}: not a regular file owned by this user`)
      return readFileSync(path, 'utf8')
    }
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
