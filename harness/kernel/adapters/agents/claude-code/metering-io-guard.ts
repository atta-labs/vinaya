/**
 * Hardened I/O for `MeteringCapabilityDeps` (CWE-59). Every real
 * caller of `resolveMeteringCapability` fills `exists`/`readFile` with the
 * factory here rather than hand-rolling `existsSync`/`readFileSync`, so the
 * guard lives once at the shared seam instead of being re-derived (or
 * missed) at each call site.
 *
 * `claude-code-transcript.ts` stays pure (no `fs`, no `process.env`) — this
 * sibling module is `aeg-core`'s one deliberate exception, exported
 * alongside it rather than living in `bin/`: `apps/cli` only ever sees this
 * package's `src/index.ts` surface, and `bin/` is not part of it (see that
 * file's own header on the `bin/` vs `src/` split).
 *
 * The pointer path this guards (`$TMPDIR/claude-transcript-<key>.txt`) is
 * fully predictable and, on the usual CI/Linux default with `TMPDIR` unset,
 * sits in a directory other local users can typically write to. The write
 * side of this exact path was hardened already
 * (`apps/cli/src/lib/claude-stop-hook-emitter.ts`, CWE-59: `wx` +
 * `renameSync`, refusing to write through a symlink). This is the read
 * side's turn, against the same threat model.
 *
 * Mechanism: open with `O_NOFOLLOW | O_NONBLOCK`, then `fstat` the
 * resulting descriptor — never a separate `lstat`-then-`open` pair, which
 * still races between the two calls (a symlink or FIFO planted in the gap
 * defeats the earlier check). `O_NOFOLLOW` makes the kernel refuse an open
 * through a symlink outright (`ELOOP`) rather than trusting a stat taken a
 * moment earlier. `O_NONBLOCK` is what actually closes the FIFO hang:
 * opening a FIFO for reading in the default blocking mode waits for a
 * writer that may never come — the reviewer's finding, 20+ seconds, killed
 * by their own alarm rather than by the process. With `O_NONBLOCK` the open
 * returns immediately regardless of whether a writer exists, and `fstat`'s
 * `isFile()` then refuses the descriptor before any read is attempted, so
 * the read call this guards never has a FIFO to block on in the first
 * place. Neither flag changes behavior for a genuine regular file.
 * Confirmed against a live planted symlink and a live FIFO, on both Node
 * and Bun, before writing this comment.
 */

import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync } from 'node:fs'
import type { MeteringCapabilityDeps } from './claude-code-transcript'

const GUARD_OPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW

/**
 * The one property both `exists` and `readFile` require of an already-open
 * descriptor before its content is trusted: a regular file (never a FIFO,
 * device, directory, or — moot once `O_NOFOLLOW` has run — a symlink),
 * owned by this process's own user on a platform that reports one at all.
 *
 * Split out from the `openSync`/`fstatSync` pair so the foreign-owner
 * refusal — not constructible in CI without a second real local user — stays
 * unit-testable by handing this function a faked stat directly, rather than
 * needing an actual cross-user fixture.
 */
export function isTrustedMeteringStat(stat: { isFile(): boolean; uid: number }, ownUid: number | undefined): boolean {
  if (!stat.isFile()) return false
  if (typeof ownUid === 'number' && stat.uid !== ownUid) return false
  return true
}

function ownUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined
}

function guardedOpen(path: string): number | undefined {
  try {
    return openSync(path, GUARD_OPEN_FLAGS)
  } catch {
    // Covers a missing path (`ENOENT`), a symlink (`ELOOP`, `O_NOFOLLOW`),
    // and anything else the platform refuses to open under these flags —
    // all degrade to "not usable", never a throw. An attacker must not be
    // able to turn a probe into a crash either.
    return undefined
  }
}

function hardenedExists(path: string): boolean {
  const fd = guardedOpen(path)
  if (fd === undefined) return false
  try {
    return isTrustedMeteringStat(fstatSync(fd), ownUid())
  } finally {
    closeSync(fd)
  }
}

function hardenedReadFile(path: string): string {
  const fd = guardedOpen(path)
  if (fd === undefined) {
    throw new Error(`refusing to read ${path}: not openable as a plain, non-symlinked file`)
  }
  try {
    if (!isTrustedMeteringStat(fstatSync(fd), ownUid())) {
      throw new Error(`refusing to read ${path}: not a regular file owned by this user`)
    }
    // Reads the already-open, already-checked descriptor directly — never
    // reopens by path, which would reintroduce the exact TOCTOU gap this
    // module exists to close.
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

/**
 * The hardened `MeteringCapabilityDeps` every real caller of
 * `resolveMeteringCapability` should build from, in place of hand-rolled
 * `existsSync`/`readFileSync`. `env`/`cwd` carry no I/O hazard of their own;
 * every current call site reads them the same way, so this reads them
 * directly rather than taking them as parameters no caller would vary.
 */
export function hardenedMeteringDeps(): MeteringCapabilityDeps {
  return {
    env: process.env,
    cwd: process.cwd(),
    exists: hardenedExists,
    readFile: hardenedReadFile
  }
}
