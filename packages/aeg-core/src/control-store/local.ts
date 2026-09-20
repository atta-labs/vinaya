/**
 * The one supported local storage implementation for the control-store. Two
 * properties, demonstrated by the fault fixtures in `local.test.ts` rather
 * than asserted in prose:
 *
 * **Atomic, durable transitions.** Every write — an ordinary overwrite via
 * `atomicWriteFile`, or an exclusive claim via `exclusiveCreateFile` — lands
 * fully-formed content on a private temp file in the same directory,
 * `fsync`ed, before that content is ever published under its real name via
 * `renameSync` (an overwrite) or `linkSync` (an exclusive claim). POSIX
 * guarantees both publish operations are atomic on a shared filesystem, so
 * a reader never observes a partial file, and a crash before the publish
 * step simply leaves the prior state (or none) untouched. This is the
 * "atomic files" half of the traps-to-avoid decision, recorded in
 * `apps/cli/specs/loop.md` — a transactional database was rejected because
 * this store's own concurrency need (one exclusive owner at a time, on one
 * machine) is fully met by a filesystem's own `link(2)`/`rename(2)`
 * guarantees, and pulling in a DB engine would be the "distributed
 * coordination" the brief says not to introduce for a single-machine guard.
 *
 * **Exclusive ownership epochs, fenced at the mutation boundary.** Ownership
 * is not "the recorded pid answers a liveness probe" (`isDriverPidAlive`'s
 * old role, the trap this task exists to retire: liveness alone never
 * proved ownership, only that some process with that pid still runs).
 * Instead each attempted epoch is its own immutable file, published with
 * `linkSync` from a private, fully-written temp file: two racing callers
 * computing the same next epoch from the same observed current epoch
 * contend for the same final name, and the filesystem — not a timestamp,
 * not a liveness probe — decides the single winner, with no window in
 * which either can observe the other's claim as an empty or torn file.
 * Creating the final name directly with `O_CREAT|O_EXCL` and writing its
 * content in a separate step would reopen exactly that window: a second
 * claimant could open the name mid-write, read it as corrupt, and reclaim
 * it out from under the first writer, whose own call would go on to finish
 * successfully against its now-orphaned inode and report itself the winner
 * regardless — two processes each believing they held the same epoch.
 * Publishing via `linkSync` from an already-complete, already-`fsync`ed
 * temp file closes that window: the final name transitions directly from
 * absent to fully-formed, never through a visible partial state. A caller
 * that already lost synchronously discovers it (the loser's `linkSync`
 * throws `EEXIST`); every later write against a stale epoch is refused
 * inside `assertCurrentEpoch`, never left to the caller to remember to
 * check.
 */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { hostname as osHostname } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import {
  type EffectRecord,
  type EscalationRecord,
  type InputRecord,
  type LoopStateRecord,
  type ManifestRecord,
  type OwnershipRecord,
  parseEffectRecord,
  parseEscalationRecord,
  parseInputRecord,
  parseLoopStateRecord,
  parseManifestRecord,
  parseOwnershipRecord,
  parseResolutionRecord,
  parseRunRecord,
  parseTransitionRecord,
  type ParsedRecord,
  type ResolutionRecord,
  type RunRecord,
  type TransitionRecord
} from './records'

export type ControlStoreDeps = {
  root: () => string
  now: () => Date
  pid: () => number
  hostname: () => string
}

export function defaultControlStoreDeps(root: () => string): ControlStoreDeps {
  return {
    root,
    now: () => new Date(),
    pid: () => process.pid,
    hostname: () => osHostname()
  }
}

/** Thrown by every write function when the epoch the caller presents is no longer current — the caller lost ownership (or never had it) and must not have its write honored. */
export class StaleEpochWriteError extends Error {
  constructor(
    readonly task: number,
    readonly attemptedEpoch: number,
    readonly currentEpoch: number
  ) {
    super(
      `control-store: refusing a write for task ${task} at epoch ${attemptedEpoch} — the current epoch is ${currentEpoch}`
    )
    this.name = 'StaleEpochWriteError'
  }
}

function isErrnoException(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code
}

function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    if (isErrnoException(err, 'ENOENT')) return undefined
    // A real read failure (permissions, an unreadable special file) is not
    // "nothing was ever written" — surface it as a corrupt read rather than
    // silently reporting absence. Rethrown here, never swallowed — `readRecord`
    // below is what turns this into the `'corrupt'` a caller actually reads;
    // this function's own contract stays "the raw bytes, undefined, or throw".
    throw err
  }
}

/**
 * Every direct `parse<X>Record(readIfExists(path))` read in this file goes
 * through here instead (round 3 review, BLOCKER): `readIfExists` rethrows a
 * real filesystem fault (permission denied, an unreadable special file, an
 * EIO) raw, and every one of `parseWith`'s callers sits upstream of a caller
 * that reads that record BEFORE its own try/catch is in scope (`recoverLoopState`
 * in `dev-review-loop.ts`, most concretely) — the exact "escapes uncaught
 * instead of becoming a decided pause" failure class round 1's BLOCKER
 * already named for malformed JSON, reopened here through a different
 * trigger. A real read failure is "something is there but untrustworthy," the
 * same fact `parseWith` already reports as `'corrupt'` for torn JSON or a
 * schema violation — never `'absent'`, and never left to erupt uncaught out
 * of every caller of every record kind this store has.
 */
function readRecord<T>(path: string, parse: (raw: string | undefined) => ParsedRecord<T>): ParsedRecord<T> {
  try {
    return parse(readIfExists(path))
  } catch (err) {
    return { status: 'corrupt', reason: `filesystem read failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/**
 * Whether a directory segment already sitting on disk is safe to write
 * through — a pre-existing REAL directory (never a symlink; that is
 * `mkdirNoSymlinks`'s own `isDirectory()` check, applied before this one)
 * can still be a co-tenant's plant: owning it, or leaving it world-writable,
 * hands that co-tenant the same control over its contents a symlink would
 * (security review, round 3 — the type check alone "never followed a
 * symlink" but said nothing about who could still tamper with a directory
 * of the right type).
 *
 * Two independent properties, both required:
 *
 * **Owner.** Trusted when it is this process's own effective user, or root
 * (uid `0`) — a root-owned ancestor (`/`, `/tmp` itself) predates this store
 * and sits outside any co-tenant's control, the same trust boundary every
 * process on the box already accepts by running at all. Any other owner
 * sitting exactly on this store's own path is the co-tenant-plant case this
 * check exists to catch. Skipped entirely on a platform reporting no uid at
 * all (e.g. Windows) — the same fallback `metering-io-guard.ts`'s
 * `isTrustedMeteringStat` already uses for the same reason.
 *
 * **Mode.** Refused when world-writable UNLESS the sticky bit is also set —
 * the exact shape `/tmp` itself relies on: shared write access, but only an
 * entry's own owner may remove or rename it, so the world-write bit alone
 * never lets another local account delete or replace a file this store
 * already wrote. Without that allowance, `/tmp`'s own standard `1777` would
 * fail this check the moment a test (or a real deployment) resolves a path
 * underneath it. Deliberately narrower than group-writable: this repo's own
 * fixtures routinely create ancestor directories with no explicit mode at
 * all, landing on whatever a shared-group development umask (e.g. `002`)
 * produces — group-writable-but-still-owned-by-us is that ordinary case, not
 * the co-tenant threat (a genuinely different account) this function exists
 * to catch, and group is not the bit `/tmp`'s own convention polices either.
 *
 * Split out from `mkdirNoSymlinks` so the foreign-owner branch — not
 * constructible as a real fixture in CI without a second local user — stays
 * unit-testable against a faked stat, the same convention
 * `metering-io-guard.test.ts`'s `isTrustedMeteringStat` suite already uses;
 * the mode branch is a real, constructible fixture (`local.test.ts`).
 */
export function isTrustedDirStat(stat: { uid: number; mode: number }, ownUid: number | undefined): boolean {
  if (typeof ownUid !== 'number') return true
  if (stat.uid !== ownUid && stat.uid !== 0) return false
  const worldWritable = (stat.mode & 0o002) !== 0
  const sticky = (stat.mode & 0o1000) !== 0
  return !worldWritable || sticky
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined
}

/**
 * Creates `dir` and every missing ancestor, refusing to traverse through a
 * pre-existing symlink — or a pre-existing real directory with an untrusted
 * owner or mode — at or below `trustedRoot` (security review, CRITICAL then
 * round 3; the operating-system-owned-temp-root exemption above it added
 * once an untouched checkout's default temp root turned out to already be
 * such a symlink).
 * `mkdirSync(dir, { recursive: true })` treats an existing symlink-to-directory
 * as already present and silently follows it — every writer that reaches
 * this store's own `openSync`/`writeSync`/`renameSync`/`linkSync` next then
 * operates inside whatever real directory that symlink resolves to. Before
 * `runtimeDir` became a repo-configurable absolute path shared with other
 * local accounts (`apps/cli/src/lib/run-paths.ts`'s own doc comment names
 * `/var/lib/vinaya/runs`), this whole tree sat under a fixed, per-repository,
 * user-owned default and a co-tenant able to pre-plant a symlink was out of
 * scope; a shared, configurable tree makes that co-tenant a real adversary
 * for every path this store writes.
 *
 * `trustedRoot` names the boundary between two zones, both walked from the
 * filesystem root down to `dir`:
 *
 * - **Above `trustedRoot`** (its own ancestors) — never this store's own
 *   territory, and on the declared-supported host frequently an
 *   operating-system-owned symlink (macOS's default temp root: `/var` is
 *   itself a symlink to `/private/var`, and `os.tmpdir()` resolves through
 *   it). A symlink here is tolerated, but never blindly: its target is
 *   resolved (`statSync`, which follows the link) and that REAL directory is
 *   ownership/mode-checked exactly as a non-symlink ancestor already is —
 *   `isTrustedDirStat` never sees the symlink's own metadata, only what it
 *   points at.
 * - **At or below `trustedRoot`** — this store's own tree, whether
 *   `trustedRoot` itself still needs creating or already exists from a prior
 *   run. A symlink here is refused unconditionally, the original check,
 *   unweakened: a co-tenant on a shared `runtimeDir` who pre-plants a symlink
 *   below it must still be caught, whether or not that plant happens to look
 *   "pre-existing" from this call's own perspective.
 *
 * Each path segment is created with a plain, non-recursive `mkdirSync` —
 * one this call itself creates cannot be a pre-planted symlink, since it did
 * not exist a moment before — then `lstatSync`-verified without following
 * symlinks, the identical check applied to a segment that already existed.
 *
 * Exported (not just this module's own use) so `apps/cli`'s own run-file
 * writers — `run-paths.ts`'s `ensureRunDir`, the one chokepoint every other
 * run-file directory in that package already goes through — share this
 * exact check rather than a second, independently-maintained copy of it.
 */
export function mkdirNoSymlinks(dir: string, mode: number, trustedRoot: string): void {
  const absolute = resolve(dir)
  const rootSegments = resolve(trustedRoot)
    .split(sep)
    .filter((s) => s.length > 0)
  const segments = absolute.split(sep).filter((s) => s.length > 0)
  const ownUid = currentUid()
  let current = absolute.startsWith(sep) ? sep : ''
  segments.forEach((segment, index) => {
    current = current === '' || current === sep ? `${current}${segment}` : `${current}${sep}${segment}`
    // `trustedRoot` itself sits at index `rootSegments.length - 1` — at or
    // below it, refusal is unconditional; strictly above it, a symlink is
    // resolved and its real target trust-checked instead of refused outright.
    const atOrBelowTrustedRoot = index >= rootSegments.length - 1
    try {
      mkdirSync(current, { mode })
    } catch (err) {
      if (!isErrnoException(err, 'EEXIST')) throw err
    }
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) {
      if (atOrBelowTrustedRoot) {
        throw new Error(
          `control-store: refusing to create a run directory through ${current} — it already exists and is not a real directory (a symlink or a file)`
        )
      }
      let real: ReturnType<typeof statSync>
      try {
        real = statSync(current)
      } catch (err) {
        throw new Error(
          `control-store: refusing to create a run directory through ${current} — it is a symlink whose target could not be resolved: ${err instanceof Error ? err.message : String(err)}`
        )
      }
      if (!real.isDirectory()) {
        throw new Error(
          `control-store: refusing to create a run directory through ${current} — it is a symlink that does not resolve to a real directory`
        )
      }
      if (!isTrustedDirStat(real, ownUid)) {
        throw new Error(
          `control-store: refusing to create a run directory through ${current} — its symlink target is owned by uid ${real.uid} with mode ${(real.mode & 0o7777).toString(8)}, neither this process's own user nor a safe shared mode`
        )
      }
      return
    }
    if (!stat.isDirectory()) {
      throw new Error(
        `control-store: refusing to create a run directory through ${current} — it already exists and is not a real directory (a symlink or a file)`
      )
    }
    if (!isTrustedDirStat(stat, ownUid)) {
      throw new Error(
        `control-store: refusing to create a run directory through ${current} — it already exists, owned by uid ${stat.uid} with mode ${(stat.mode & 0o7777).toString(8)}, neither this process's own user nor a safe shared mode`
      )
    }
  })
}

/** Whole-file write via temp-then-rename, `fsync`ed before the rename so the bytes are durable, not just visible. `trustedRoot` is this store's own root (`deps.root()`) — see `mkdirNoSymlinks`. */
function atomicWriteFile(path: string, contents: string, trustedRoot: string): void {
  mkdirNoSymlinks(dirname(path), 0o700, trustedRoot)
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`
  const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC, 0o600)
  try {
    writeSync(fd, contents, null, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

/**
 * Creates `path` with `contents` exclusively and atomically — `contents` is
 * fully written and `fsync`ed to a private temp file first, then published
 * with a single `linkSync`, which either fully succeeds (`path` now holds
 * complete content) or fails `EEXIST` (someone else published first) with
 * no intermediate state in which a reader can observe `path` partially
 * written. Used for every "only one writer may ever occupy this exact
 * name" file: an ownership epoch, a transition sequence slot. See this
 * file's own module doc for why `O_CREAT|O_EXCL` directly at `path` is not
 * used here. `trustedRoot` is this store's own root (`deps.root()`) — see
 * `mkdirNoSymlinks`.
 */
function exclusiveCreateFile(
  path: string,
  contents: string,
  trustedRoot: string
): { created: true } | { created: false } {
  mkdirNoSymlinks(dirname(path), 0o700, trustedRoot)
  const tmp = `${path}.claim-${process.pid}-${randomUUID()}`
  const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
  try {
    writeSync(fd, contents, null, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    linkSync(tmp, path)
    return { created: true }
  } catch (err) {
    if (!isErrnoException(err, 'EEXIST')) throw err
    return { created: false }
  } finally {
    // Runs on every exit from the try above — both returns AND a rethrown
    // non-EEXIST error alike (a full disk, a permissions fault) — so the
    // private temp file is never left behind regardless of how `linkSync`
    // failed. The temp file already did its job by this point (its content
    // is durably published at `path`, or it wasn't needed because someone
    // else published first, or publishing itself failed and there is
    // nothing left to keep it for); a failure removing it is not this
    // call's own concern to surface, so it's swallowed here rather than
    // thrown, and never overrides the real return/throw decided above.
    try {
      unlinkSync(tmp)
    } catch {
      // leftover temp file, harmless — never thrown from here
    }
  }
}

// `runId` reaches `runPath`/`inputPath` from a caller-supplied value
// (`RunInput.runId`/`InputInput.runId`) rather than a store-generated one —
// unlike an epoch or a transition seq, which this module always derives
// itself. A `runId` carrying a path segment (`../../etc/passwd`, an
// absolute path) must not be spliced unchecked into a filesystem path; the
// same discipline `log-sink.ts`'s `isSafeRepoSegment` applies to an
// environment-sourced repo name, applied here to a run identifier instead.
const SAFE_ID_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

export class InvalidRunIdError extends Error {
  constructor(readonly runId: string) {
    super(`control-store: refusing an unsafe runId (must be a single path-safe segment): ${JSON.stringify(runId)}`)
    this.name = 'InvalidRunIdError'
  }
}

function assertSafeRunId(runId: string): void {
  if (!SAFE_ID_SEGMENT.test(runId) || runId.includes('..')) {
    throw new InvalidRunIdError(runId)
  }
}

/** An effect's `key` reaches `effectPath` from a caller (`EffectExecutor`'s own caller, ultimately a forge-write call site) the same way `runId` does — the identical path-safety discipline, under its own error type so a caller can tell which id was rejected. */
export class InvalidEffectKeyError extends Error {
  constructor(readonly key: string) {
    super(`control-store: refusing an unsafe effect key (must be a single path-safe segment): ${JSON.stringify(key)}`)
    this.name = 'InvalidEffectKeyError'
  }
}

function assertSafeEffectKey(key: string): void {
  if (!SAFE_ID_SEGMENT.test(key) || key.includes('..')) {
    throw new InvalidEffectKeyError(key)
  }
}

/** An escalation/resolution's `escalationId` reaches its path from a caller (`pause-resume.ts`'s `escalationIdFor`, `<task>-<round>-<head>`) the same way an effect's `key` does — the identical path-safety discipline, under its own error type so a caller can tell which id was rejected. */
export class InvalidEscalationIdError extends Error {
  constructor(readonly escalationId: string) {
    super(
      `control-store: refusing an unsafe escalationId (must be a single path-safe segment): ${JSON.stringify(escalationId)}`
    )
    this.name = 'InvalidEscalationIdError'
  }
}

function assertSafeEscalationId(escalationId: string): void {
  if (!SAFE_ID_SEGMENT.test(escalationId) || escalationId.includes('..')) {
    throw new InvalidEscalationIdError(escalationId)
  }
}

/**
 * A task's own control records: `<root>/<task>/control/`.
 *
 * `root` is the directory holding one folder per task — the CLI passes
 * `<runtimeDir>/tasks-execution` (`apps/cli/src/lib/run-paths.ts`), so a
 * task's control records sit in the `control/` subdirectory of the same
 * folder that holds its session records, its raw output and its per-round
 * reviewer files. The `control/` segment is what keeps those four classes
 * from sharing one flat directory, and is why a caller passes the tasks
 * root rather than a control-store root of its own: there is no longer a
 * separate control-store tree to point at. No record's own filename,
 * content or version changes — only which directory holds it.
 */
/**
 * The subdirectory of a task's folder that holds its control records. Named
 * and exported so the CLI's own layout constant
 * (`apps/cli/src/lib/run-paths.ts`'s `RUN_AREA_DIRNAMES.control`) can be
 * derived from this one rather than repeating the literal across a package
 * boundary, where nothing would catch the two drifting apart.
 */
export const CONTROL_AREA_DIRNAME = 'control'

function taskRoot(root: string, task: number): string {
  return join(root, String(task), CONTROL_AREA_DIRNAME)
}

function ownershipDir(root: string, task: number): string {
  return join(taskRoot(root, task), 'ownership')
}

const EPOCH_FILENAME = /^epoch-(\d+)\.json$/

function ownershipEpochPath(root: string, task: number, epoch: number): string {
  return join(ownershipDir(root, task), `epoch-${String(epoch).padStart(6, '0')}.json`)
}

function runPath(root: string, task: number, runId: string): string {
  assertSafeRunId(runId)
  return join(taskRoot(root, task), 'run', `${runId}.json`)
}

function inputPath(root: string, task: number, runId: string): string {
  assertSafeRunId(runId)
  return join(taskRoot(root, task), 'input', `${runId}.json`)
}

function manifestPath(root: string, task: number, round: number): string {
  return join(taskRoot(root, task), 'manifest', `round-${String(round).padStart(6, '0')}.json`)
}

function loopStatePath(root: string, task: number): string {
  return join(taskRoot(root, task), 'loop-state.json')
}

function effectPath(root: string, task: number, key: string): string {
  assertSafeEffectKey(key)
  return join(taskRoot(root, task), 'effect', `${key}.json`)
}

function effectDir(root: string, task: number): string {
  return join(taskRoot(root, task), 'effect')
}

function escalationPath(root: string, task: number, escalationId: string): string {
  assertSafeEscalationId(escalationId)
  return join(taskRoot(root, task), 'escalation', `${escalationId}.json`)
}

function resolutionPath(root: string, task: number, escalationId: string): string {
  assertSafeEscalationId(escalationId)
  return join(taskRoot(root, task), 'resolution', `${escalationId}.json`)
}

function transitionsDir(root: string, task: number, epoch: number): string {
  return join(taskRoot(root, task), 'transitions', `epoch-${String(epoch).padStart(6, '0')}`)
}

function transitionPath(root: string, task: number, epoch: number, seq: number): string {
  return join(transitionsDir(root, task, epoch), `${String(seq).padStart(6, '0')}.json`)
}

/** The highest validly-parsing ownership epoch on disk, and every epoch number that exists but fails to parse (a corrupt or torn epoch file) — surfaced so a caller can tell "no owner yet" apart from "an owner's record is unreadable". */
export function readCurrentOwnership(
  deps: Pick<ControlStoreDeps, 'root'>,
  task: number
): { epoch: number; record: OwnershipRecord | null; corruptEpochs: number[] } {
  const dir = ownershipDir(deps.root(), task)
  if (!existsSync(dir)) return { epoch: 0, record: null, corruptEpochs: [] }
  let bestEpoch = 0
  let best: OwnershipRecord | null = null
  const corruptEpochs: number[] = []
  for (const entry of readdirSync(dir)) {
    const match = EPOCH_FILENAME.exec(entry)
    if (!match) continue
    const epoch = Number.parseInt(match[1] as string, 10)
    const parsed = parseOwnershipRecord(readIfExists(join(dir, entry)))
    if (parsed.status === 'ok') {
      if (epoch > bestEpoch) {
        bestEpoch = epoch
        best = parsed.value
      }
    } else if (parsed.status === 'corrupt') {
      corruptEpochs.push(epoch)
    }
  }
  return { epoch: best ? bestEpoch : 0, record: best, corruptEpochs }
}

export type AcquireResult =
  | { acquired: true; epoch: number; record: OwnershipRecord }
  | { acquired: false; currentEpoch: number; currentOwnerId: string | null }

/** Bounds the reclaim-a-corrupt-slot retry loop below — real contention never approaches this; it exists so a pathological repeated-corruption case fails loudly rather than spinning forever. */
const MAX_ACQUIRE_ATTEMPTS = 8

type ClaimOutcome =
  | { outcome: 'won'; record: OwnershipRecord }
  | { outcome: 'lost'; record: OwnershipRecord }
  | { outcome: 'reclaim' }

/**
 * The single-epoch claim primitive `acquireOwnership` loops on. Exposed on
 * its own because it is what makes the race provable without real OS-level
 * concurrency: two callers that independently observed the same current
 * epoch (`readCurrentOwnership` returning the same value to both, which is
 * exactly what "racing" means here) go on to compute the SAME next epoch
 * and therefore reduce to two calls of THIS function with the identical
 * `epoch` argument — `local.test.ts` calls it directly, twice, with one
 * fixed epoch, to prove `O_EXCL` admits exactly one winner rather than
 * trusting the guarantee unverified.
 */
export function attemptEpochClaim(deps: ControlStoreDeps, task: number, epoch: number, ownerId: string): ClaimOutcome {
  const path = ownershipEpochPath(deps.root(), task, epoch)
  const record: OwnershipRecord = {
    version: 1,
    kind: 'ownership',
    task,
    epoch,
    ownerId,
    pid: deps.pid(),
    host: deps.hostname(),
    acquiredAt: deps.now().toISOString()
  }
  const result = exclusiveCreateFile(path, JSON.stringify(record), deps.root())
  if (result.created) return { outcome: 'won', record }

  // Lost the race, or found a corpse of a crashed claim — tell them apart
  // by re-parsing the exact file we collided on.
  const parsed = parseOwnershipRecord(readIfExists(path))
  if (parsed.status === 'ok') return { outcome: 'lost', record: parsed.value }
  // 'absent' can't happen here (we just observed EEXIST); 'corrupt' means a
  // crashed writer never completed this epoch's claim — reclaim it so the
  // caller can retry the same epoch number.
  try {
    unlinkSync(path)
  } catch (err) {
    if (!isErrnoException(err, 'ENOENT')) throw err
  }
  return { outcome: 'reclaim' }
}

/**
 * Acquires the next epoch for `task`. A caller that finds a contested slot
 * already validly held reports the real winner truthfully rather than
 * retrying past it (see `attemptEpochClaim`'s own doc for how that race
 * resolves); a corrupt, crash-orphaned claim is reclaimed and the same
 * epoch retried, bounded by `MAX_ACQUIRE_ATTEMPTS`.
 */
export function acquireOwnership(deps: ControlStoreDeps, task: number, ownerId: string): AcquireResult {
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    const current = readCurrentOwnership(deps, task)
    const nextEpoch = current.epoch + 1
    const claim = attemptEpochClaim(deps, task, nextEpoch, ownerId)
    if (claim.outcome === 'won') return { acquired: true, epoch: nextEpoch, record: claim.record }
    if (claim.outcome === 'lost') {
      return { acquired: false, currentEpoch: claim.record.epoch, currentOwnerId: claim.record.ownerId }
    }
    // 'reclaim' — the slot is now clear; loop retries the same nextEpoch.
  }
  throw new Error(`control-store: could not acquire an epoch for task ${task} after ${MAX_ACQUIRE_ATTEMPTS} attempts`)
}

function assertCurrentEpoch(deps: ControlStoreDeps, task: number, epoch: number): void {
  const current = readCurrentOwnership(deps, task)
  if (current.record === null || current.epoch !== epoch) {
    throw new StaleEpochWriteError(task, epoch, current.epoch)
  }
}

export type RunInput = Omit<RunRecord, 'version' | 'kind' | 'task'>

/** Refuses (`StaleEpochWriteError`) unless `epoch` is still the task's current epoch — a run record can only be written by whoever currently owns the task. */
export function writeRun(deps: ControlStoreDeps, task: number, epoch: number, input: RunInput): RunRecord {
  assertCurrentEpoch(deps, task, epoch)
  const record: RunRecord = { version: 1, kind: 'run', task, ...input }
  atomicWriteFile(runPath(deps.root(), task, input.runId), JSON.stringify(record), deps.root())
  return record
}

export function readRun(deps: Pick<ControlStoreDeps, 'root'>, task: number, runId: string): ParsedRecord<RunRecord> {
  return readRecord(runPath(deps.root(), task, runId), parseRunRecord)
}

export type InputInput = Omit<InputRecord, 'version' | 'kind' | 'task'>

export function writeInput(deps: ControlStoreDeps, task: number, epoch: number, input: InputInput): InputRecord {
  assertCurrentEpoch(deps, task, epoch)
  const record: InputRecord = { version: 1, kind: 'input', task, ...input }
  atomicWriteFile(inputPath(deps.root(), task, input.runId), JSON.stringify(record), deps.root())
  return record
}

export function readInput(
  deps: Pick<ControlStoreDeps, 'root'>,
  task: number,
  runId: string
): ParsedRecord<InputRecord> {
  return readRecord(inputPath(deps.root(), task, runId), parseInputRecord)
}

export type ManifestInput = Omit<ManifestRecord, 'version' | 'kind' | 'task'>

/**
 * Writes the review-input manifest snapshot for `(task, round)` (O1).
 * Deliberately NOT epoch-fenced, unlike `writeRun`/`writeInput`: this record
 * is an IMMUTABLE per-round snapshot the parent stamps once before dispatching
 * reviewers, not a mutable state transition two owners could race on, and the
 * driver's own cutover to acquired-epoch ownership is separate, later adoption
 * work (`loop.md`, "The control store … built, not yet adopted"). The atomic
 * temp-then-rename write below still gives it the same torn-write-free
 * durability every other record here has; what it does not require is that the
 * caller already hold the task's current epoch, which the parent does not yet
 * acquire. A rerun of the same round overwrites with identical content.
 */
export function writeManifest(
  deps: ControlStoreDeps,
  task: number,
  round: number,
  input: ManifestInput
): ManifestRecord {
  const record: ManifestRecord = { version: 1, kind: 'manifest', task, ...input }
  atomicWriteFile(manifestPath(deps.root(), task, round), JSON.stringify(record), deps.root())
  return record
}

/** The manifest snapshot recorded for `(task, round)`, or `'absent'`/`'corrupt'` — the same three-way read every other record uses, never a nullable read that conflates the two. */
export function readManifest(
  deps: Pick<ControlStoreDeps, 'root'>,
  task: number,
  round: number
): ParsedRecord<ManifestRecord> {
  return readRecord(manifestPath(deps.root(), task, round), parseManifestRecord)
}

export type LoopStateInput = Omit<LoopStateRecord, 'version' | 'kind' | 'task'>

/**
 * Writes the dev-review-loop's authoritative recovery snapshot for `task` —
 * phase, round, budgets, held-result and delivered-findings identity.
 * Deliberately NOT epoch-fenced, the same
 * precedent `writeManifest` sets: see `LoopStateRecordSchema`'s own doc
 * comment. Overwritten in place on every transition, unlike
 * `writeRun`/`writeInput`.
 */
export function writeLoopState(deps: ControlStoreDeps, task: number, input: LoopStateInput): LoopStateRecord {
  const record: LoopStateRecord = { version: 1, kind: 'loop_state', task, ...input }
  atomicWriteFile(loopStatePath(deps.root(), task), JSON.stringify(record), deps.root())
  return record
}

/** The loop-state snapshot recorded for `task`, or `'absent'`/`'corrupt'` — the same three-way read every other record uses, never a nullable read that conflates the two (O3: a caller must be able to tell "nothing recovered yet" apart from "something recorded but untrustworthy," since the latter must never be read as license to reset budgets). */
export function readLoopState(deps: Pick<ControlStoreDeps, 'root'>, task: number): ParsedRecord<LoopStateRecord> {
  return readRecord(loopStatePath(deps.root(), task), parseLoopStateRecord)
}

export type TransitionInput = Omit<TransitionRecord, 'version' | 'kind' | 'task' | 'epoch' | 'seq'>

/**
 * Appends the next transition for `epoch` — refused (`StaleEpochWriteError`)
 * unless `epoch` is still current. The sequence number is itself claimed
 * with `O_EXCL`, incrementing past any slot already taken, rather than
 * trusted from a count the caller computed — two writers (which should
 * never both hold the current epoch, since `assertCurrentEpoch` gates
 * entry, but a crash-and-resume can still leave a partial sequence) never
 * collide on one seq number.
 */
export function appendTransition(
  deps: ControlStoreDeps,
  task: number,
  epoch: number,
  input: TransitionInput
): TransitionRecord {
  assertCurrentEpoch(deps, task, epoch)
  const root = deps.root()
  const dir = transitionsDir(root, task, epoch)
  let seq = existsSync(dir) ? readdirSync(dir).length : 0
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    const record: TransitionRecord = { version: 1, kind: 'transition', task, epoch, seq, ...input }
    const result = exclusiveCreateFile(transitionPath(root, task, epoch, seq), JSON.stringify(record), root)
    if (result.created) return record
    seq++
  }
  throw new Error(`control-store: could not claim a transition seq for task ${task} epoch ${epoch}`)
}

/** Every transition recorded for `epoch`, in `seq` order — a corrupt entry is surfaced as its own `'corrupt'` element, never dropped and never conflated with "no more transitions". */
export function readTransitions(
  deps: Pick<ControlStoreDeps, 'root'>,
  task: number,
  epoch: number
): ParsedRecord<TransitionRecord>[] {
  const dir = transitionsDir(deps.root(), task, epoch)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => /^\d+\.json$/.test(name))
    .sort()
    .map((name) => readRecord(join(dir, name), parseTransitionRecord))
}

export type EffectInput = Omit<EffectRecord, 'version' | 'kind' | 'task' | 'key'>

/**
 * Writes (or overwrites — unlike `writeRun`/`writeInput`, an effect record
 * advances through `'started'` → `'verified'`/`'uncertain'` in place, one
 * file per `key`) an effect record, fenced by `epoch` the same as every
 * other write here: refused (`StaleEpochWriteError`) the instant the caller
 * no longer holds `task`'s current epoch.
 */
export function writeEffect(
  deps: ControlStoreDeps,
  task: number,
  epoch: number,
  key: string,
  input: EffectInput
): EffectRecord {
  assertCurrentEpoch(deps, task, epoch)
  const record: EffectRecord = { version: 1, kind: 'effect', task, key, ...input }
  atomicWriteFile(effectPath(deps.root(), task, key), JSON.stringify(record), deps.root())
  return record
}

export function readEffect(
  deps: Pick<ControlStoreDeps, 'root'>,
  task: number,
  key: string
): ParsedRecord<EffectRecord> {
  return readRecord(effectPath(deps.root(), task, key), parseEffectRecord)
}

/**
 * Every effect key currently on disk for `task`, `'started'` records only —
 * O3's "unresolved effects remain explicitly uncertain" starting point: a
 * cancellation calls this, then `markEffectUncertain` on each key returned,
 * so an in-flight-but-never-confirmed write is never left silently
 * ambiguous. A corrupt effect record is skipped here (nothing safe to say
 * about its status) rather than thrown — cancellation must not itself fail
 * because one unrelated effect record is unreadable.
 */
export function listStartedEffectKeys(deps: Pick<ControlStoreDeps, 'root'>, task: number): string[] {
  const dir = effectDir(deps.root(), task)
  if (!existsSync(dir)) return []
  const keys: string[] = []
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue
    const key = entry.slice(0, -'.json'.length)
    const parsed = parseEffectRecord(readIfExists(join(dir, entry)))
    if (parsed.status === 'ok' && parsed.value.status === 'started') keys.push(key)
  }
  return keys
}

/**
 * Advances one effect record from `'started'` to `'uncertain'` — the same
 * transition `EffectExecutor`'s own `reconcileExisting` writes when a
 * reconciliation comes back ambiguous, applied here unconditionally rather
 * than after a remote read: a cancellation does not attempt to reconcile a
 * late-in-flight write against the forge, it simply refuses to let it read
 * as either confirmed or safely retryable. Epoch-fenced like every other
 * write here — a caller must hold the CURRENT epoch (the one cancellation
 * itself just acquired) for this to succeed. A key that no longer parses as
 * `'started'` (already advanced, or corrupt) is left untouched and simply
 * omitted from the return value.
 */
export function markEffectUncertain(
  deps: ControlStoreDeps,
  task: number,
  epoch: number,
  key: string
): EffectRecord | null {
  const existing = readEffect(deps, task, key)
  if (existing.status !== 'ok' || existing.value.status !== 'started') return null
  return writeEffect(deps, task, epoch, key, {
    operation: existing.value.operation,
    target: existing.value.target,
    inputVersion: existing.value.inputVersion,
    payloadDigest: existing.value.payloadDigest,
    status: 'uncertain',
    recordedAt: deps.now().toISOString()
  })
}

export type EscalationInput = Omit<EscalationRecord, 'version' | 'kind' | 'task'>

/**
 * True when two escalation inputs describe the SAME pause instance — every
 * field but `recordedAt` (which always differs on a rerun) and `evidence`
 * (best-effort, allowed to fill in on a later attempt where an earlier one
 * had none). Used only to tell "a rerun of the identical pause" apart from
 * "a genuinely different pause that happens to collide on the same
 * `(task, round, head)` key" — see `writeEscalation`'s own doc comment.
 */
function sameEscalationInstance(a: EscalationInput, b: EscalationInput): boolean {
  return (
    a.round === b.round &&
    a.head === b.head &&
    a.branch === b.branch &&
    a.pr === b.pr &&
    a.reason === b.reason &&
    (a.detail ?? null) === (b.detail ?? null)
  )
}

/** Bounds the disambiguating-suffix probe below — real collisions never approach this; exists so a pathological repeated-collision case fails loudly rather than spinning forever. */
const MAX_ESCALATION_COLLISION_ATTEMPTS = 8

/**
 * Refuses (`StaleEpochWriteError`) unless `epoch` is still the task's
 * current epoch — an escalation can only be recorded by whoever currently
 * owns the task's pause. Idempotent on a rerun of the SAME pause instance
 * (`sameEscalationInstance` — an ordinary overwrite, like `writeManifest`).
 *
 * A GENUINELY DIFFERENT escalation colliding on the same `escalationId`
 * (`<task>-<round>-<head>`) — a resumed run that hits a second, different
 * pause condition before the head moves, most plausibly one of the
 * self-resumed reasons (`objectives_changed`, `ruling_posted`,
 * `stale_driver`, `brief_superseded`, `policy_changed`), which dispatch no
 * developer and so never guarantee a new head — is never silently
 * overwritten (code review, round 2, MEDIUM: the earlier pause's own
 * reason/detail/evidence would otherwise become unrecoverable except
 * through chat history, exactly what O1 exists to avoid). Instead it claims
 * the next free `<escalationId>-<n>` suffix via the same exclusive-create
 * discipline `attemptEpochClaim`/`appendTransition`'s own seq-slot claim
 * uses — never `atomicWriteFile` for this branch, so two colliding writers
 * can never both believe they won the same suffix. The record actually
 * written (never the caller's original `input.escalationId` once a suffix
 * was needed) is what the caller must key any later read against — see
 * `writeEscalationRecord` (`pause-resume.ts`), which persists the real id
 * back onto `PauseState` for exactly this reason.
 */
export function writeEscalation(
  deps: ControlStoreDeps,
  task: number,
  epoch: number,
  input: EscalationInput
): EscalationRecord {
  assertCurrentEpoch(deps, task, epoch)
  const canonicalId = input.escalationId
  const existing = readEscalation(deps, task, canonicalId)
  if (existing.status !== 'ok' || sameEscalationInstance(existing.value, input)) {
    // Absent, corrupt (healed by overwrite), or a genuine rerun of the
    // identical instance — safe to (re)write at the canonical key.
    const record: EscalationRecord = { version: 1, kind: 'escalation', task, ...input }
    atomicWriteFile(escalationPath(deps.root(), task, canonicalId), JSON.stringify(record), deps.root())
    return record
  }
  for (let n = 2; n <= MAX_ESCALATION_COLLISION_ATTEMPTS; n++) {
    const candidateId = `${canonicalId}-${n}`
    const record: EscalationRecord = { version: 1, kind: 'escalation', task, ...input, escalationId: candidateId }
    const result = exclusiveCreateFile(
      escalationPath(deps.root(), task, candidateId),
      JSON.stringify(record),
      deps.root()
    )
    if (result.created) return record
    const there = readEscalation(deps, task, candidateId)
    if (there.status === 'ok' && sameEscalationInstance(there.value, input)) return there.value
    // Slot taken by yet another distinct instance — try the next suffix.
  }
  throw new Error(
    `control-store: could not claim a disambiguating escalation slot for task ${task}, key '${canonicalId}', after ${MAX_ESCALATION_COLLISION_ATTEMPTS} attempts`
  )
}

export function readEscalation(
  deps: Pick<ControlStoreDeps, 'root'>,
  task: number,
  escalationId: string
): ParsedRecord<EscalationRecord> {
  return parseEscalationRecord(readIfExists(escalationPath(deps.root(), task, escalationId)))
}

export type ResolutionInput = Omit<ResolutionRecord, 'version' | 'kind' | 'task'>

export type ConsumeResolutionResult =
  | { outcome: 'consumed'; record: ResolutionRecord }
  | { outcome: 'already-consumed'; record: ResolutionRecord | null }

/**
 * Claims `escalationId`'s resolution EXCLUSIVELY — the same `linkSync`
 * discipline an ownership epoch claim uses (`exclusiveCreateFile`), never an
 * ordinary overwrite: a second call for the SAME `escalationId`, whether a
 * genuine replay of an already-consumed decision or a second decision
 * racing the first, collides on the identical final name and comes back
 * `'already-consumed'` rather than silently replacing what is already
 * there. This is what makes "a resolution is consumed once" a storage
 * guarantee rather than an application-level check the caller could forget.
 * Epoch-fenced like every other write here (`StaleEpochWriteError` on a
 * stale caller), on top of — not instead of — the exclusivity above.
 */
export function consumeResolutionOnce(
  deps: ControlStoreDeps,
  task: number,
  epoch: number,
  input: ResolutionInput
): ConsumeResolutionResult {
  assertCurrentEpoch(deps, task, epoch)
  const record: ResolutionRecord = { version: 1, kind: 'resolution', task, ...input }
  const path = resolutionPath(deps.root(), task, input.escalationId)
  const result = exclusiveCreateFile(path, JSON.stringify(record), deps.root())
  if (result.created) return { outcome: 'consumed', record }
  const existing = parseResolutionRecord(readIfExists(path))
  return { outcome: 'already-consumed', record: existing.status === 'ok' ? existing.value : null }
}

export function readResolution(
  deps: Pick<ControlStoreDeps, 'root'>,
  task: number,
  escalationId: string
): ParsedRecord<ResolutionRecord> {
  return parseResolutionRecord(readIfExists(resolutionPath(deps.root(), task, escalationId)))
}
