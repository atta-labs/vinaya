import type { VerdictObservation } from '../../../../tools/dev-review-policy/types'
import type { DeferredFindingEntry } from '../../../../tools/task-contract/forge/forge-write.js'
import type { AgentVendor } from '../../dispatch/dispatch.js'
import type { Decision } from '../../../../tools/dev-review-policy/types'
import { loopLogPathFor } from '../../../../../../kernel/log/client/loop-log.js'
import { sweepModernTasksAsync } from '../../run-control/task-sweep.js'
import { appendDriverLine } from '../../../../../../kernel/log/client/loop-log.js'
import { defaultTaskSweepAsyncDeps } from '../../run-control/task-sweep.js'
import type { IssueSurface } from '../../../../tools/task-contract/issue-validation'
import type { OpenedAgentConfigEntry } from '../../../../../../kernel/isolation/worker-boundary.js'
import { agentOwnConfigDirs } from '../../../../../../kernel/isolation/worker-boundary.js'
import { globCoversPath } from '../../../../tools/task-contract/issue-validation'
import { packageRoot } from '../../../../../../../apps/cli/src/lib/package-root.js'
import { resolve } from 'node:path'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { PROCESS_FOLDER_IN_CHECKOUT } from '../../run-control/task-run-engine.js'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/**
 * One round's deferred findings as tracking-Issue entries — each carrying the
 * reviewer that reported it (`v.role`, O1's "reviewer" field), taken straight
 * from the round's own verdict observations. The journal's `RoundRecord.deferred`
 * (`@attalabs/process-vinaya`) drops the role, and that type — like the summary that
 * renders it — is out of this task's Surface, so the role is captured here at
 * the one point it is still in hand, then accumulated per round by the loop.
 * The severity/location/reason are the same facts the summary lists, so the
 * two never disagree on the finding itself. Empty when the round deferred
 * nothing (O3).
 */
export function deferredEntriesForRound(round: number, verdicts: VerdictObservation[]): DeferredFindingEntry[] {
  const entries: DeferredFindingEntry[] = []
  for (const v of verdicts) {
    for (const f of v.findings) {
      if (f.deferred !== undefined) {
        entries.push({
          round,
          reviewer: v.role,
          severity: f.severity,
          location: f.location ?? '',
          reason: f.deferred,
          description: f.description ?? ''
        })
      }
    }
  }
  return entries
}

// --- the loop -----------------------------------------------------------------

/**
 * `model` (issue-661, O1) — resolved once by `task-run.ts`'s `runTask`
 * (explicit `--model`, then the Issue's own suggested-agent-class mapping,
 * then this vendor's default) and spent in exactly one place: the
 * developer's own `dispatchRole` call in `dispatchDeveloper` below.
 * `undefined` on the deprecated `task dispatch` path and on every direct
 * `devReviewLoop` caller that never resolved one — `dispatchRole` already
 * treats an absent `model` as "run this vendor's own default," unchanged.
 *
 * `retainDriverLock` (issue-711 O4, code review round 1, BLOCKER; round 2,
 * MAJOR/security LOW) — set ONLY by `runDriverLoop`'s own internal calls
 * (both the first and every resume attempt), never by the CLI or a direct
 * caller: it carries the one-driver-per-task lock TOKEN `runDriverLoop`
 * itself generated once, at its own start, and tells THIS call "keep the
 * lock held under this exact token no matter which reason this round
 * pauses for" (below, `keepLockAlive`), because the watching driver is not
 * done — it is about to poll and, likely, call `devReviewLoop` again
 * itself. The entry gate (below) treats an EXISTING lock as this call's
 * own only when its pid AND its token both match — a bare pid match is
 * never proof of ownership on its own (a crashed driver's exact pid can be
 * reissued by the OS to a fresh, unrelated invocation for the same task;
 * that invocation carries no matching token, so it is correctly treated as
 * NOT its own, same as a genuinely different process would be). Absent
 * (the ordinary case), a pause still clears the lock exactly as before
 * this task: an operator's own one-shot `--task`/`--resume` call was
 * always meant to end here. A clean `publish` under the watching driver
 * keeps the lock too: `runDriverLoop` goes on watching the published pull
 * request and releases the lock only once it is merged or closed.
 *
 * `pauseOnConflict` — set ONLY by `runDriverLoop`'s published-pull-request
 * watch, once its automatic conflict re-entries (`MAX_AUTOMATIC_CONFLICT_REENTRIES`)
 * are spent: the first conflicting mergeability read of this run then
 * pauses `repeat_failure` with this detail, through the ordinary pause path,
 * instead of sending the Developer back again.
 */
export type LoopInput = {
  json?: boolean
  model?: string
  retainDriverLock?: string
  pauseOnConflict?: string
} & ({ task: number; agent: AgentVendor } | { resumePr: number; agent?: AgentVendor })

export type LoopResult = { finalDecision: Decision; prNumber: number; task: number }

/**
 * The exact argv `checkStaleDriver`'s re-exec hands to a fresh `vinaya
 * dev-review-loop` process — pulled out as its own pure function
 * (a round-2 review MINOR finding) so the one thing that
 * actually regresses easily — a flag silently dropped across the restart —
 * is unit-testable without driving the whole re-exec/driver-lock path.
 * Carries the ORIGINAL invocation's `--json` intent through: dropping it
 * would silently switch an unattended, machine-parsed caller over to
 * human-readable output the moment a moved base restarts this same driver
 * underneath it.
 *
 * O4: ALWAYS `--task <n>`, never `--resume <pr>`, even when
 * `input` itself carries a `resumePr` — a re-exec is this SAME run
 * continuing, not a fresh `--resume` invocation, and `--resume`'s own
 * top-of-function gate authenticates the Principal's ruling by CONSUMING
 * its resolution exactly once (`resolveEscalation`/`consumeResolutionOnce`,
 * `pause-resume.ts`), durably, in the control store. A re-exec that
 * rebuilt `--resume <pr>` re-entered that SAME gate a second time against
 * the SAME already-consumed resolution — `ReplayedResolutionError`, thrown
 * before this process's own outer `try`/`finally` even starts, so nothing
 * traces it: a resumed loop that ran a full round, took the developer's
 * next push, then hit a stale-driver restart mid-round exited with no
 * pause and no reviewers (origin: live, 2026-09-19). `--task <n>`'s own
 * round-1 entry already attaches to the open PR with no ruling required
 * (`loop.md` § Rounds — "an already-open pull request… means ATTACH") and
 * recovers the round number from the durable journal/held-verdict state,
 * exactly the position a mid-loop restart needs — never from a stale
 * `pause-state.json` a completed resume has already moved past. A
 * genuinely fresh, human-invoked `--resume <pr>` past an already-consumed
 * resolution must still refuse (Traps to avoid) — this function is never
 * in that path; it only shapes the driver's OWN internal re-exec.
 */
export function buildReexecArgs(input: LoopInput, task: number): string[] {
  if (!input.agent) throw new Error('buildReexecArgs: resolved agent is required')
  return [
    'dev-review-loop',
    '--task',
    String(task),
    '--agent',
    input.agent,
    ...(input.model ? ['--model', input.model] : []),
    ...(input.json ? ['--json'] : [])
  ]
}

/**
 * `sweepModernTasksAsync`'s own call, started once at the start of every
 * run, `excludeScope: task` so this run never sweeps the very folder it is
 * about to write into. Best-effort: a thrown error is reported to stderr
 * and swallowed, never re-thrown — the same "the mechanics stalled, not a
 * review verdict" tolerance this driver already gives every other
 * best-effort side effect. Non-blocking lookups with bounded
 * concurrency (Traps to avoid) — never the legacy-layout half of the sweep
 * (Boundary: out of scope, and its own driver-side result was always
 * discarded anyway). Injectable (`LoopDeps.sweepTasksAtStart`) so a test
 * never shells out to real `gh` or touches a real runtime directory just
 * because a run started. Never rejects — every failure, including one from
 * `onDecision` itself, is caught and reported, so the caller can safely
 * await the returned promise unconditionally.
 */
export async function defaultSweepTasksAtStart(task: number): Promise<void> {
  try {
    const sweepLogPath = loopLogPathFor(null, task)
    let removed = 0
    let kept = 0
    await sweepModernTasksAsync(
      task,
      (decision) => {
        if (decision.removed) removed++
        else kept++
        // A folder the sweep could not remove is a failure, and stays visible on its own line.
        if (decision.failed)
          appendDriverLine(sweepLogPath, `Sweep could not remove ${decision.folder}: ${decision.reason}`, 'failed')
      },
      defaultTaskSweepAsyncDeps
    )
    appendDriverLine(
      sweepLogPath,
      `Sweep finished: removed ${removed} finished task folder${removed === 1 ? '' : 's'}, kept ${kept}.`,
      'done'
    )
  } catch (err) {
    appendDriverLine(
      loopLogPathFor(null, task),
      `Sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      'failed'
    )
  }
}

/**
 * The configuration directories of `agent` that `surface` opens for this
 * task, relative to the worktree. An `in:` entry opens a path only when it is
 * a literal path, or a literal path followed only by `/**`, and that path
 * equals or lies inside one of `agent`'s own configuration directories
 * (`agentOwnConfigDirs`): naming `.claude/rules` opens that folder, never the
 * rest of `.claude`. An entry with any other glob in it opens nothing, an
 * entry for another agent's configuration opens nothing for this one, and
 * `.mcp.json` never opens, because Surface entries are directories. An
 * opened path opens nothing when any `out:` entry equals it, lies inside it
 * or contains it — `globCoversPath`, the containment test the Issue's own
 * Surface checks use, where an exclusion wins over an inclusion. Empty when
 * `surface` is `null`: a task with no resolvable Surface names nothing.
 * Pure: the driver resolves the result against the worktree
 * (`resolveOpenedAgentConfigPaths`) before any grant.
 */
export function surfaceOpenedAgentConfigPaths(surface: IssueSurface | null, agent: string): OpenedAgentConfigEntry[] {
  if (!surface) return []
  const configDirs = agentOwnConfigDirs(agent)
  const opened = new Map<string, OpenedAgentConfigEntry>()
  for (const raw of surface.in) {
    const createIfMissing = raw.endsWith('/**')
    const path = createIfMissing ? raw.slice(0, -'/**'.length) : raw
    if (path.length === 0 || /[*?[\]{}!\\]/.test(path) || path.startsWith('/') || path.endsWith('/')) continue
    if (path.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) continue
    if (!configDirs.some((dir) => path === dir || path.startsWith(`${dir}/`))) continue
    if (surface.out.some((glob) => globCoversPath(glob, path))) continue
    const prior = opened.get(path)
    opened.set(path, { path, createIfMissing: createIfMissing || prior?.createIfMissing === true })
  }
  return [...opened.values()]
}

/**
 * The publishing-instruction clause every Developer prompt and re-ask of the
 * review loop ends with — the same for both agents: the Developer publishes
 * only through the driver-run tools, holding no forge credential of its own.
 * The driver hosts the tools and runs every gate; it never commits, pushes or
 * opens on the Developer's behalf. The evaluation harness's change trials give
 * their Developer this same clause.
 */
export function publishingInstructionLine(): string {
  return 'publish only through the driver-run tools, which run outside your sandbox and hold the gates: `publish_changes` (pass your one-line `Type(scope): Description` commit header) to commit and push the task branch, `open_pull_request` (pass the full PR-report body) to open the pull request when none is open, `update_pull_request_body`/`refresh_evidence` for a body-only change, `read_pull_request` to read its state, its checks and the job-log tail of each failed check, and `run_checks` to run `vinaya-check --all`; you hold no `gh`/`git push` credential and the driver does not commit, push or open on your behalf.'
}

/**
 * Names this standalone run as the producer of every Log event it writes and
 * every event a process it launches writes: runner `standalone` at this CLI's
 * own package version, and the Vinaya process definition's id, `version` and
 * digest, read from its `process.yaml` through the process loader exactly as
 * the Engine runner reads them. The process definition and its loader sit
 * beside the CLI only in a checkout of this repository, and the loader is
 * imported from that checkout rather than bundled; a published CLI has
 * neither, so its process version and digest stay unset and read `null`,
 * never an invented value. Only a run calls this — a `vinaya` command a
 * person runs with no run keeps the header's own defaults.
 */
export async function setStandaloneLogIdentity(
  env: NodeJS.ProcessEnv = process.env,
  cliRoot: string = packageRoot(import.meta.resolve('@attalabs/vinaya/package.json'))
): Promise<void> {
  const packagePath = join(cliRoot, 'package.json')
  const pkg: unknown = JSON.parse(readFileSync(packagePath, 'utf8'))
  if (
    typeof pkg !== 'object' ||
    pkg === null ||
    !('version' in pkg) ||
    typeof pkg.version !== 'string' ||
    pkg.version === ''
  ) {
    throw new Error(`Cannot resolve the Vinaya CLI version from ${packagePath}`)
  }
  env.VINAYA_RUNNER_ID = 'standalone'
  env.VINAYA_RUNNER_VERSION = pkg.version
  const checkout = resolve(cliRoot, '../..')
  const loaderPath = join(checkout, 'harness', 'kernel', 'dev-process-socket', 'loader', 'load-process.ts')
  const processFolder = join(checkout, PROCESS_FOLDER_IN_CHECKOUT)
  if (!existsSync(join(checkout, '.git')) || !existsSync(loaderPath) || !existsSync(processFolder)) return
  const { loadProcess } = (await import(pathToFileURL(loaderPath).href)) as {
    loadProcess: (folder: string) => {
      identity: { id: string; version: string }
      digest: string
      flowKey?: string
      flowPath?: string
    }
  }
  const loaded = loadProcess(processFolder)
  env.VINAYA_PROCESS_ID = loaded.identity.id
  env.VINAYA_PROCESS_VERSION = loaded.identity.version
  env.VINAYA_PROCESS_DIGEST = loaded.digest
  // Which flow ran, as the Engine runner names it: the standalone loop runs the process's default flow, so the Log
  // compares the two runners — and the two flows — from one field.
  if (loaded.flowKey && loaded.flowPath) {
    const flowId = /^id:\s*(\S+)\s*$/m.exec(readFileSync(loaded.flowPath, 'utf8'))?.[1]
    env.VINAYA_FLOW = flowId ?? loaded.identity.id
    env.VINAYA_FLOW_VERSION = loaded.flowKey
  }
}
