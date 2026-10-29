#!/usr/bin/env node
/**
 * The ready-tests policy: whether a version-2 run's ready push, and its driver-owned repair pushes on its own open
 * pull request, run the selected tests locally (the default) or defer them to required current-head CI.
 *
 * The opt-in is `prePush.readyTests: { mode: 'ci', workflow: '.github/workflows/ci.yml', check: 'Vinaya CI' }`, read
 * from the default branch's `vinaya.config.json` only (the trust anchor) — never from the task branch, a local
 * override or the environment. Absent means local tests. A failed trusted read refuses: it never permits deferral.
 *
 * A push defers only when the run's driver asked for it: the driver writes a short-lived marker under the worktree's
 * git directory (`READY_DEFERRAL_MARKER`) naming its run, its task branch, its own process identity (pid and start
 * time) and either the approved head (`ready`) or its open pull request (`repair`), and removes it when the publish
 * ends. A marker whose driver is gone, whose identity no longer matches, that has expired, that names another branch
 * or head, or whose pull request is not the branch's one open pull request grants nothing: the push runs its tests.
 *
 * As the generated hook's entrypoint (self-hosted only) it prints `deferred` or `local` on STDOUT, and exits 1 with
 * the reason on STDERR when the push must be refused. A deferred push writes `READY_TESTS_DEFERRED_RECORD`, the
 * head- and run-bound structured result the driver and `vinaya pr report` read; it never writes a test-cache entry.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { type VinayaConfig, loadTrustAnchorConfigOrThrow } from './config.js'
import { currentBranch, gitPath, writeJsonUnderGit } from './pre-push-failed-tests.js'
import { isTaskBranch } from './pre-push-mode-logic.js'
import { identityOf, type ProcessIdentity } from './process-registry.js'

/** The one workflow the initial opt-in supports: this repository's hand-written CI. */
export const READY_TESTS_WORKFLOW = '.github/workflows/ci.yml'

/** The required check the opt-in binds to: the aggregate job of `READY_TESTS_WORKFLOW`. */
export const READY_TESTS_CHECK = 'Vinaya CI'

/** What a ready or driver-owned repair push does with its selected tests. */
export type ReadyTestsPolicy = { mode: 'local' } | { mode: 'ci'; workflow: string; check: string }

/** The driver-minted marker that asks the hook to defer, under the worktree's git directory. */
export const READY_DEFERRAL_MARKER = 'vinaya/ready-deferral'

/** The structured result a deferred push leaves, under the worktree's git directory. */
export const READY_TESTS_DEFERRED_RECORD = 'vinaya/ready-tests-deferred.json'

/** The line the hook prints when it deferred the tests. Informational only: nothing reads state from it. */
export const READY_TESTS_DEFERRED_LINE = 'vinaya pre-push: tests deferred to required CI'

/** How long a marker stays valid: the ready push's default deadline plus slack. */
export const DEFERRAL_MARKER_TTL_MS = 30 * 60 * 1000

/** The marker the driver writes for one publish. */
export type DeferralMarker = {
  version: 1
  kind: 'ready' | 'repair'
  runId: string
  branch: string
  driver: ProcessIdentity
  /** The approved head the ready push tests (`ready` only). */
  head?: string
  /** The run's own open pull request (`repair` only). */
  pr?: number
  expiresAt: string
}

/** What a deferred push records: the head, the run and the required CI it owes. */
export type DeferredTestsRecord = {
  version: 1
  kind: 'ready' | 'repair'
  head: string
  branch: string
  runId: string
  workflow: string
  check: string
  recordedAt: string
}

/** The first word of the loop's automatic Test Plan line on a deferred head: the line no shell command starts with. */
export const READY_CI_COMMAND_WORD = 'required-ci'

/**
 * The automatic selected-suite line the driver writes into the Test Plan when the ready push deferred its tests: it
 * names the required check and its workflow. It is the one Test Plan line that may report pending instead of running,
 * and only on a head the hook recorded as deferred to exactly this check (`resolveDeferredGroupC`).
 */
export function readyCiPlanCommand(policy: { workflow: string; check: string }): string {
  return `${READY_CI_COMMAND_WORD} "${policy.check}" ${policy.workflow}`
}

/** True for a Test Plan command shaped like the automatic required-CI line. */
export const isReadyCiCommand = (command: string): boolean => command.trim().split(/\s+/)[0] === READY_CI_COMMAND_WORD

/** The effective policy of a parsed trust-anchor config: `local` unless it opts in. */
export function readyTestsPolicyOf(config: VinayaConfig | null): ReadyTestsPolicy {
  const ready = config?.prePush?.readyTests
  if (ready?.mode !== 'ci') return { mode: 'local' }
  return { mode: 'ci', workflow: ready.workflow, check: ready.check }
}

/** The policy from the default branch's config; throws when the trusted read fails. */
export function readTrustedReadyTestsPolicy(
  load: () => VinayaConfig | null = () => loadTrustAnchorConfigOrThrow()
): ReadyTestsPolicy {
  return readyTestsPolicyOf(load())
}

export const deferralMarkerText = (marker: Omit<DeferralMarker, 'version'>): string =>
  `${JSON.stringify({ version: 1, ...marker })}\n`

/** A marker of the right shape, or null. */
export function parseDeferralMarker(text: string | null): DeferralMarker | null {
  if (!text) return null
  try {
    const value = JSON.parse(text) as Partial<DeferralMarker>
    if (value.version !== 1 || (value.kind !== 'ready' && value.kind !== 'repair')) return null
    if (typeof value.runId !== 'string' || value.runId === '') return null
    if (typeof value.branch !== 'string' || value.branch === '') return null
    const driver = value.driver
    if (!driver || !Number.isInteger(driver.pid) || driver.pid <= 0 || typeof driver.startTime !== 'string') return null
    if (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))) return null
    if (value.kind === 'ready' && (typeof value.head !== 'string' || !/^[0-9a-f]{40}$/.test(value.head))) return null
    if (value.kind === 'repair' && (!Number.isInteger(value.pr) || (value.pr as number) <= 0)) return null
    return value as DeferralMarker
  } catch {
    return null
  }
}

/** A deferred-tests record for `head` (and, when given, `runId`), or null when it is missing, malformed or another head's. */
export function parseDeferredTestsRecord(
  text: string | null,
  expect: { head: string; runId?: string }
): DeferredTestsRecord | null {
  if (!text) return null
  try {
    const value = JSON.parse(text) as Partial<DeferredTestsRecord>
    if (value.version !== 1 || (value.kind !== 'ready' && value.kind !== 'repair')) return null
    if (value.head !== expect.head) return null
    if (expect.runId !== undefined && value.runId !== expect.runId) return null
    if (typeof value.workflow !== 'string' || typeof value.check !== 'string') return null
    if (typeof value.branch !== 'string' || typeof value.runId !== 'string') return null
    return value as DeferredTestsRecord
  } catch {
    return null
  }
}

/** Reads the worktree's deferred-tests record for `head`, or null. */
export function readDeferredTestsRecord(
  worktreePath: string,
  expect: { head: string; runId?: string }
): DeferredTestsRecord | null {
  const path = gitPath(worktreePath, READY_TESTS_DEFERRED_RECORD)
  if (!path || !existsSync(path)) return null
  try {
    return parseDeferredTestsRecord(readFileSync(path, 'utf8'), expect)
  } catch {
    return null
  }
}

export type DeferralDecision =
  | { defer: false; reason: string }
  | { defer: true; marker: DeferralMarker; policy: Extract<ReadyTestsPolicy, { mode: 'ci' }> }
  | { refuse: string }

/**
 * Pure: whether this push defers its tests. Every input but the marker is asked only once the marker is a live
 * driver's, for this branch and this push: the open pull request (a `repair` marker) and then the trusted policy.
 */
export function resolveReadyTestsDeferral(input: {
  pushMode: string | undefined
  marker: string | null
  branch: string
  /** The head this push sends. */
  pushedHead: string
  now: number
  isDriverAlive: (driver: ProcessIdentity) => boolean
  /** The branch's open pull request numbers; throws when the forge read fails. */
  openPullRequests: () => number[]
  /** The trusted policy; throws when the read fails. */
  readPolicy: () => ReadyTestsPolicy
}): DeferralDecision {
  const marker = parseDeferralMarker(input.marker)
  if (marker === null) return { defer: false, reason: 'no driver deferral marker' }
  if (!isTaskBranch(input.branch) || marker.branch !== input.branch)
    return { defer: false, reason: `the marker names ${marker.branch}, not ${input.branch}` }
  if (Date.parse(marker.expiresAt) <= input.now) return { defer: false, reason: 'the marker expired' }
  if (!input.isDriverAlive(marker.driver)) return { defer: false, reason: 'the driver that wrote the marker is gone' }
  if (marker.kind === 'ready') {
    if (input.pushMode !== 'ready')
      return { defer: false, reason: 'a ready marker on a push that is not the ready push' }
    if (marker.head !== input.pushedHead)
      return { defer: false, reason: `the marker names ${marker.head}, not the pushed head ${input.pushedHead}` }
  } else {
    if (input.pushMode === 'ready' || input.pushMode === 'storage')
      return { defer: false, reason: `a repair marker on a ${input.pushMode} push` }
    let open: number[]
    try {
      open = input.openPullRequests()
    } catch (error) {
      return {
        defer: false,
        reason: `the open pull request could not be read (${error instanceof Error ? error.message : String(error)})`
      }
    }
    if (open.length !== 1 || open[0] !== marker.pr)
      return { defer: false, reason: `pull request #${marker.pr} is not the branch's one open pull request` }
  }
  let policy: ReadyTestsPolicy
  try {
    policy = input.readPolicy()
  } catch (error) {
    return {
      refuse: `the driver asked to defer this push's tests to required CI, and the default branch's ready-tests policy could not be read: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  if (policy.mode !== 'ci') return { defer: false, reason: 'the default branch does not opt in' }
  return { defer: true, marker, policy }
}

/** The head of the first branch ref git's pre-push stdin names for `branch`, or null. */
export function pushedHeadOf(refs: string, branch: string): string | null {
  for (const line of refs.split('\n')) {
    const [localRef, localSha] = line.trim().split(/\s+/)
    if (localRef === `refs/heads/${branch}` && localSha && /^[0-9a-f]{40}$/.test(localSha)) return localSha
  }
  return null
}

function liveOpenPullRequests(repoRoot: string, branch: string): number[] {
  const out = execFileSync(
    'gh',
    ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number', '--jq', '.[].number'],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }
  )
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const n = Number(line)
      if (!Number.isInteger(n)) throw new Error(`gh answered ${JSON.stringify(line)}`)
      return n
    })
}

function main(): void {
  const repoRoot = process.cwd()
  const markerPath = gitPath(repoRoot, READY_DEFERRAL_MARKER)
  let marker: string | null = null
  if (markerPath && existsSync(markerPath)) {
    try {
      marker = readFileSync(markerPath, 'utf8')
    } catch {
      marker = null
    }
  }
  const recordPath = gitPath(repoRoot, READY_TESTS_DEFERRED_RECORD)
  // A record left by an earlier push never describes this one.
  if (recordPath) rmSync(recordPath, { force: true })
  const branch = currentBranch(repoRoot)
  const pushedHead = pushedHeadOf(process.env.VINAYA_PUSH_REFS ?? '', branch) ?? ''
  const decision = resolveReadyTestsDeferral({
    pushMode: process.env.VINAYA_PUSH_MODE,
    marker,
    branch,
    pushedHead,
    now: Date.now(),
    isDriverAlive: (driver) => identityOf(driver.pid)?.startTime === driver.startTime,
    openPullRequests: () => liveOpenPullRequests(repoRoot, branch),
    readPolicy: () => readTrustedReadyTestsPolicy()
  })
  if ('refuse' in decision) {
    process.stderr.write(`vinaya pre-push: refused — ${decision.refuse}\n`)
    process.exit(1)
  }
  if (!decision.defer) {
    process.stdout.write('local\n')
    return
  }
  const record: DeferredTestsRecord = {
    version: 1,
    kind: decision.marker.kind,
    head: pushedHead,
    branch,
    runId: decision.marker.runId,
    workflow: decision.policy.workflow,
    check: decision.policy.check,
    recordedAt: new Date().toISOString()
  }
  writeJsonUnderGit(repoRoot, READY_TESTS_DEFERRED_RECORD, record)
  process.stdout.write('deferred\n')
}

if (import.meta.main) main()
