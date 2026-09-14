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
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { hostname as osHostname } from 'node:os'
import { dirname, join } from 'node:path'
import {
  type EffectRecord,
  type InputRecord,
  type LoopStateRecord,
  type ManifestRecord,
  type OwnershipRecord,
  parseEffectRecord,
  parseInputRecord,
  parseLoopStateRecord,
  parseManifestRecord,
  parseOwnershipRecord,
  parseRunRecord,
  parseTransitionRecord,
  type ParsedRecord,
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
    // silently reporting absence.
    throw err
  }
}

/** Whole-file write via temp-then-rename, `fsync`ed before the rename so the bytes are durable, not just visible. */
function atomicWriteFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
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
 * used here.
 */
function exclusiveCreateFile(path: string, contents: string): { created: true } | { created: false } {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
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

function taskRoot(root: string, task: number): string {
  return join(root, String(task))
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
  const result = exclusiveCreateFile(path, JSON.stringify(record))
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
  atomicWriteFile(runPath(deps.root(), task, input.runId), JSON.stringify(record))
  return record
}

export function readRun(deps: Pick<ControlStoreDeps, 'root'>, task: number, runId: string): ParsedRecord<RunRecord> {
  return parseRunRecord(readIfExists(runPath(deps.root(), task, runId)))
}

export type InputInput = Omit<InputRecord, 'version' | 'kind' | 'task'>

export function writeInput(deps: ControlStoreDeps, task: number, epoch: number, input: InputInput): InputRecord {
  assertCurrentEpoch(deps, task, epoch)
  const record: InputRecord = { version: 1, kind: 'input', task, ...input }
  atomicWriteFile(inputPath(deps.root(), task, input.runId), JSON.stringify(record))
  return record
}

export function readInput(
  deps: Pick<ControlStoreDeps, 'root'>,
  task: number,
  runId: string
): ParsedRecord<InputRecord> {
  return parseInputRecord(readIfExists(inputPath(deps.root(), task, runId)))
}

export type ManifestInput = Omit<ManifestRecord, 'version' | 'kind' | 'task'>

/**
 * Writes the review-input manifest snapshot for `(task, round)` (`#555`, O1).
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
  atomicWriteFile(manifestPath(deps.root(), task, round), JSON.stringify(record))
  return record
}

/** The manifest snapshot recorded for `(task, round)`, or `'absent'`/`'corrupt'` — the same three-way read every other record uses, never a nullable read that conflates the two. */
export function readManifest(
  deps: Pick<ControlStoreDeps, 'root'>,
  task: number,
  round: number
): ParsedRecord<ManifestRecord> {
  return parseManifestRecord(readIfExists(manifestPath(deps.root(), task, round)))
}

export type LoopStateInput = Omit<LoopStateRecord, 'version' | 'kind' | 'task'>

/**
 * Writes the dev-review-loop's authoritative recovery snapshot for `task`
 * (`control-store-v1` task 4, O1) — phase, round, budgets, held-result and
 * delivered-findings identity. Deliberately NOT epoch-fenced, the same
 * precedent `writeManifest` sets: see `LoopStateRecordSchema`'s own doc
 * comment. Overwritten in place on every transition, unlike
 * `writeRun`/`writeInput`.
 */
export function writeLoopState(deps: ControlStoreDeps, task: number, input: LoopStateInput): LoopStateRecord {
  const record: LoopStateRecord = { version: 1, kind: 'loop_state', task, ...input }
  atomicWriteFile(loopStatePath(deps.root(), task), JSON.stringify(record))
  return record
}

/** The loop-state snapshot recorded for `task`, or `'absent'`/`'corrupt'` — the same three-way read every other record uses, never a nullable read that conflates the two (O3: a caller must be able to tell "nothing recovered yet" apart from "something recorded but untrustworthy," since the latter must never be read as license to reset budgets). */
export function readLoopState(deps: Pick<ControlStoreDeps, 'root'>, task: number): ParsedRecord<LoopStateRecord> {
  return parseLoopStateRecord(readIfExists(loopStatePath(deps.root(), task)))
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
    const result = exclusiveCreateFile(transitionPath(root, task, epoch, seq), JSON.stringify(record))
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
    .map((name) => parseTransitionRecord(readIfExists(join(dir, name))))
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
  atomicWriteFile(effectPath(deps.root(), task, key), JSON.stringify(record))
  return record
}

export function readEffect(
  deps: Pick<ControlStoreDeps, 'root'>,
  task: number,
  key: string
): ParsedRecord<EffectRecord> {
  return parseEffectRecord(readIfExists(effectPath(deps.root(), task, key)))
}
