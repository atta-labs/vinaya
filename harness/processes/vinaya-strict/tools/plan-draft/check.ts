/**
 * A plan draft checked as one thing.
 *
 * The Issue write gate grades one body at a time. A plan is more than its
 * bodies: whether two tasks collide, whether an edge names a task that exists,
 * whether the edges close into a cycle, whether a deferred fact has a producer
 * the task depends on, and whether every item of the agreed scope is delivered
 * once — none of that is visible from one body. `checkDraft` runs the full
 * write gate on every task exactly as publication would, with the draft's
 * other tasks standing in as each other's siblings, and adds the findings that
 * only the whole plan has.
 *
 * Tasks of the draft are named by tranche task number and published Issues by
 * `#<n>`; the two are kept apart throughout, because the gate's own edge
 * comparison reads task 5 and Issue #5 as one. Among the draft's own tasks the
 * comparisons here use keys of their own; against published tasks, a published
 * Issue answers to a bare number only when the task names it with `#<n>`.
 *
 * Open published tasks of the tranche and open pull requests are still read
 * from the forge, as at publication, so a plan colliding with work in flight is
 * found before it is published.
 */

import type { CheckError } from '@harness/kernel/gates/checks/contract'
import { listTrackedFiles } from '@harness/workflow/tools/task-contract/brief-assembly.js'
import {
  captureRefusal,
  collectTaskIssueErrors,
  type FetchCollisionPeersResult,
  type FetchSiblingsResult,
  fetchCollisionPeers,
  fetchOpenTaskSurfaceSiblings,
  makeCheckError,
  type MilestoneSource,
  pinnedFilesOf,
  runIssueChecks,
  type TaskIssueValidationDeps,
  validateRenderedBriefForIssue
} from '@harness/workflow/tools/task-contract/forge/forge-write.js'
import { classifyEdge, parseRationaleDeps } from '@harness/workflow/tools/task-contract/forge/parse-rationale-deps'
import {
  checkFileCollisions,
  checkSurfaceOverlap,
  parseIssuePremises,
  parseIssueSurface,
  type TaskSurfaceFacts
} from '@harness/workflow/tools/task-contract/issue-validation'
import { loadConfig, resolveCollisionThreshold } from '@harness/workflow/integration/config/compose'
import { type DraftEdges, type DraftTask, draftFingerprint, type PlanDraft, resolveDraftEdges } from './draft'
import { inStagedRevision, publishedIssueOf } from './preview'

export const CHECK_DRAFT_EDGES = 'plan-draft-edges'
export const CHECK_DRAFT_COLLISION = 'plan-draft-collision'
export const CHECK_DRAFT_CYCLE = 'plan-draft-cycle'
export const CHECK_DRAFT_DEFERRED = 'plan-draft-deferred-fact'
export const CHECK_DRAFT_SCOPE = 'plan-draft-scope'

const RETRY = 'plan_draft_check'

export type TaskFindings = { task: number; findings: CheckError[] }

export type DraftCheckReport = {
  fingerprint: string
  /** The write gate's findings for each task, as publication would give them. */
  tasks: TaskFindings[]
  /** Findings only the whole plan has: collisions, edges, cycles, deferred facts. */
  cross: CheckError[]
  /** Findings about how the agreed scope is assigned. */
  coverage: CheckError[]
  /** `true` when any finding is an error — a warning never blocks. */
  blocking: boolean
}

export type DraftCheckDeps = {
  /** Gate groups to replace — a test supplies the ones that need live state. */
  gate?: Partial<TaskIssueValidationDeps>
  /** The published open task Issues compared against; defaults to the forge read for a Milestone. */
  readSiblings?: (milestoneTitle: string, retryCommand: string) => FetchSiblingsResult
  /** The open task Issues and pull requests compared against; defaults to the forge read. */
  readPeers?: (allTrackedFiles: string[], retryCommand: string) => FetchCollisionPeersResult
  /** Where a task's Milestone comes from; `null` reads none, so no published sibling is compared. Defaults to the label-driven lookup publication uses. */
  milestoneSource?: MilestoneSource | null
  /** The checkout the revision is read from; defaults to the working directory. */
  cwd?: string
}

const blocks = (e: CheckError): boolean => e.severity !== 'warning'

// --- edges and cycles ------------------------------------------------------------

const label = (n: number): string => `task ${n}`

function edgeFindings(edges: readonly DraftEdges[]): CheckError[] {
  const out: CheckError[] = []
  for (const e of edges) {
    for (const [field, named] of [
      ['Depends-on', e.dependsOnTasks],
      ['Conflicts-with', e.conflictsWithTasks]
    ] as const) {
      for (const n of new Set(named)) {
        if (!e.unknownTasks.includes(n)) continue
        out.push(
          makeCheckError(
            CHECK_DRAFT_EDGES,
            `${label(e.task)} names task ${n} in \`${field}\`, which the draft does not hold.`,
            `Write \`${field}: #<n>\` for a published Issue, or name a task number the draft holds, or add task ${n} to the draft; then submit the draft again.`
          )
        )
      }
    }
  }
  return out
}

/** Every dependency cycle among the draft's tasks, each as the closed path `1 → 2 → 1`, found once. */
function cycleFindings(edges: readonly DraftEdges[]): CheckError[] {
  const known = new Set(edges.map((e) => e.task))
  const next = new Map(edges.map((e) => [e.task, [...new Set(e.dependsOnTasks)].filter((n) => known.has(n))]))
  const reported = new Set<string>()
  const out: CheckError[] = []
  const walk = (start: number, at: number, path: number[]) => {
    for (const n of next.get(at) ?? []) {
      if (n === start) {
        const loop = [...path]
        const key = [...loop].sort((a, b) => a - b).join(',')
        if (reported.has(key)) continue
        reported.add(key)
        out.push(
          makeCheckError(
            CHECK_DRAFT_CYCLE,
            `the draft's \`Depends-on\` edges form a cycle: ${[...loop, start].map(label).join(' → ')}. No task in it can start first.`,
            'Remove one `Depends-on` in the cycle, or merge the tasks it joins, then submit the draft again.'
          )
        )
      } else if (!path.includes(n)) {
        walk(start, n, [...path, n])
      }
    }
  }
  for (const e of edges) walk(e.task, e.task, [e.task])
  return out
}

// --- deferred facts --------------------------------------------------------------

function deferredFindings(draft: PlanDraft, edges: readonly DraftEdges[]): CheckError[] {
  const held = new Set(draft.tasks.map((t) => t.number))
  const out: CheckError[] = []
  for (const task of draft.tasks) {
    const parsed = parseIssuePremises(task.body)
    if (!parsed.ok) continue
    const mine = edges.find((e) => e.task === task.number)
    for (const premise of parsed.value) {
      if (premise.afterTask === null) continue
      if (!held.has(premise.afterTask)) {
        out.push(
          makeCheckError(
            CHECK_DRAFT_DEFERRED,
            `${label(task.number)} defers a premise to task ${premise.afterTask} (\`${premise.line}\`), which the draft does not hold, so nothing will ever make it true.`,
            'Name the task that produces the fact in `after task <n>:`, or write the premise without the deferral if it already holds.'
          )
        )
      } else if (!mine?.dependsOnTasks.includes(premise.afterTask)) {
        out.push(
          makeCheckError(
            CHECK_DRAFT_DEFERRED,
            `${label(task.number)} defers a premise to task ${premise.afterTask} (\`${premise.line}\`), but does not declare \`Depends-on: ${premise.afterTask}\` — the task that produces a fact is a dependency, not a note.`,
            `Add \`Depends-on: ${premise.afterTask}\` to ${label(task.number)}'s Dependency rationale, then submit the draft again.`
          )
        )
      }
    }
  }
  return out
}

// --- collisions between the draft's own tasks --------------------------------------

/** A key for a task of this draft that no published Issue number can equal. */
const key = (n: number): string => `task:${n}`

function collisionFindings(draft: PlanDraft, edges: readonly DraftEdges[], tracked: string[]): CheckError[] {
  const threshold = resolveCollisionThreshold(loadConfig())
  const facts = draft.tasks.map((t) => {
    const e = edges.find((x) => x.task === t.number)
    const surface = parseIssueSurface(t.body)
    return {
      number: t.number,
      files: pinnedFilesOf(t.body, tracked),
      surfaceIn: surface.ok ? surface.value.in : [],
      conflictsWith: (e?.conflictsWithTasks ?? []).map(key),
      dependsOn: (e?.dependsOnTasks ?? []).map(key)
    }
  })
  const out: CheckError[] = []
  for (const a of facts) {
    const later = facts.filter((b) => b.number > a.number)
    const result = checkFileCollisions(
      { ref: key(a.number), files: a.files, conflictsWith: a.conflictsWith },
      later.map((b) => ({
        ref: key(b.number),
        label: label(b.number),
        files: b.files,
        conflictsWith: b.conflictsWith
      })),
      threshold
    )
    const fix = `Declare \`Conflicts-with\` between the two tasks (one side is enough), or split the work so they share fewer than ${threshold} files, then submit the draft again.`
    for (const m of result.refusals) {
      out.push(makeCheckError(CHECK_DRAFT_COLLISION, `${label(a.number)}: ${m}`, fix))
    }
    for (const m of result.warnings) {
      out.push(
        makeCheckError(
          CHECK_DRAFT_COLLISION,
          `${label(a.number)}: ${m}`,
          'No action required — the two tasks run in parallel.',
          'warning'
        )
      )
    }
    const subject: TaskSurfaceFacts = {
      ref: key(a.number),
      surfaceIn: a.surfaceIn,
      conflictsWith: a.conflictsWith,
      dependsOn: a.dependsOn
    }
    const siblings: TaskSurfaceFacts[] = later.map((b) => ({
      ref: key(b.number),
      surfaceIn: b.surfaceIn,
      conflictsWith: b.conflictsWith,
      dependsOn: b.dependsOn
    }))
    for (const m of checkSurfaceOverlap(subject, siblings).errors) {
      out.push(makeCheckError(CHECK_DRAFT_COLLISION, `${label(a.number)}: ${m}`, fix))
    }
  }
  return out
}

// --- agreed scope --------------------------------------------------------------------

/** One item of the agreed scope as it is written: what it is, and where it goes — which may be nowhere, or in two places. */
export type ScopeEntry = {
  item: string
  disposition?: { kind: 'delivered'; task: number } | { kind: 'left-out'; reason: string } | undefined
}

/**
 * Every item of the agreed scope is delivered by exactly one task of the draft
 * or listed as left out. An item written twice is assigned twice — to two tasks,
 * or to a task and to left out; an item with no disposition, or delivered by a
 * task the draft does not hold, is assigned to none. Each is a finding naming
 * the item. The scope is a list the draft carries; nothing here reads prose.
 */
export function checkScopeCoverage(tasks: readonly number[], scope: readonly ScopeEntry[]): CheckError[] {
  const held = new Set(tasks)
  const byItem = new Map<string, ScopeEntry[]>()
  for (const entry of scope) byItem.set(entry.item, [...(byItem.get(entry.item) ?? []), entry])
  const out: CheckError[] = []
  for (const [item, entries] of byItem) {
    const assigned = entries.filter(
      (e) => e.disposition !== undefined && (e.disposition.kind === 'left-out' || held.has(e.disposition.task))
    )
    if (assigned.length > 1) {
      const where = assigned.map((e) =>
        e.disposition?.kind === 'delivered' ? `task ${e.disposition.task}` : 'left out'
      )
      out.push(
        makeCheckError(
          CHECK_DRAFT_SCOPE,
          `scope item "${item}" is assigned ${assigned.length} times (${where.join(', ')}); each item is delivered by exactly one task or left out.`,
          `Keep one disposition for "${item}" — one delivering task, or left out with a reason — and submit the draft again.`
        )
      )
    } else if (assigned.length === 0) {
      out.push(
        makeCheckError(
          CHECK_DRAFT_SCOPE,
          `scope item "${item}" is assigned to no task and is not left out.`,
          `Assign "${item}" to the one task that delivers it, or list it as left out with a reason, then submit the draft again.`
        )
      )
    }
  }
  return out
}

// --- the published tasks the draft is compared with -----------------------------------

/**
 * Keeps a published Issue from answering to a draft task's number: the gate
 * reads task 5 and Issue #5 as one, so a published peer whose number is one
 * the task names as a bare task number — and not as `#<n>` — is renamed so
 * that edge cannot exempt it.
 */
function publishedRefFor(task: DraftTask): (ref: string) => string {
  const namedAsTask = new Set<number>()
  const namedAsIssue = new Set<number>()
  const { dependsOn, conflictsWith } = parseRationaleDeps(task.body)
  for (const edge of [...dependsOn, ...conflictsWith]) {
    const ref = classifyEdge(edge)
    if (ref?.kind === 'task') namedAsTask.add(ref.number)
    else if (ref !== null) namedAsIssue.add(ref.number)
  }
  return (ref) => {
    const n = /^\d+$/.test(ref) ? Number(ref) : null
    return n !== null && namedAsTask.has(n) && !namedAsIssue.has(n) ? `issue:${n}` : ref
  }
}

function gateDepsFor(draft: PlanDraft, task: DraftTask, deps: DraftCheckDeps): TaskIssueValidationDeps {
  const rename = publishedRefFor(task)
  const ownIssue = task.issue === null ? null : String(task.issue)
  const tasks = draft.tasks.map((t) => ({ id: String(t.number), issue: t.issue }))
  return {
    runIssueChecks,
    computeRenderedBriefErrors: (input) => validateRenderedBriefForIssue({ ...input, draft: { tasks } }),
    fetchSiblings: (milestoneTitle, _exclude, retry) => {
      if (milestoneTitle === null) return { ok: true, siblings: [] }
      const read = (deps.readSiblings ?? ((m, r) => fetchOpenTaskSurfaceSiblings(m, null, r)))(milestoneTitle, retry)
      if (!read.ok) return read
      return {
        ok: true,
        siblings: read.siblings.filter((s) => s.ref !== ownIssue).map((s) => ({ ...s, ref: rename(s.ref) }))
      }
    },
    fetchPeers: (scope, _subject, tracked, retry) => {
      const read = (deps.readPeers ?? ((t, r) => fetchCollisionPeers(scope, null, t, r)))(tracked, retry)
      if (!read.ok) return read
      return {
        ok: true,
        value: {
          capHit: read.value.capHit,
          peers: read.value.peers.filter((p) => p.ref !== ownIssue).map((p) => ({ ...p, ref: rename(p.ref) }))
        }
      }
    },
    ...deps.gate
  }
}

// --- the check ---------------------------------------------------------------------------

/**
 * The deferred-fact findings the write gate gives a task, which the whole-plan
 * check restates with task numbers; only the restated ones are reported.
 */
const isDeferredToTask = (e: CheckError): boolean => /defers to task \d+/.test(e.message)

/**
 * Checks every task of `draft` as publication would, and the plan as a whole.
 * Reads the code at the draft's captured revision, never the working tree; a
 * revision the checkout lacks, or that is stale, is the only finding returned.
 */
export async function checkDraft(draft: PlanDraft, deps: DraftCheckDeps = {}): Promise<DraftCheckReport> {
  const fingerprint = draftFingerprint(draft)
  const ordered = [...draft.tasks].sort((a, b) => a.number - b.number)
  const edges = resolveDraftEdges(draft)
  const coverage = checkScopeCoverage(
    draft.tasks.map((t) => t.number),
    draft.scope
  )
  const milestoneSource: MilestoneSource | undefined =
    deps.milestoneSource === undefined ? { kind: 'create', ghArgs: [] } : (deps.milestoneSource ?? undefined)

  const staged = await inStagedRevision(
    draft.revision,
    async () => {
      const tasks: TaskFindings[] = []
      for (const task of ordered) {
        const issue = publishedIssueOf(draft, task)
        const collected = await captureRefusal(() =>
          collectTaskIssueErrors(
            issue.body,
            issue.title,
            issue.labels,
            RETRY,
            null,
            milestoneSource,
            gateDepsFor(draft, task, deps)
          )
        )
        const found = collected.ok ? collected.value.errors : collected.errors
        tasks.push({ task: task.number, findings: found.filter((e) => !isDeferredToTask(e)) })
      }
      const cross = [
        ...edgeFindings(edges),
        ...cycleFindings(edges),
        ...deferredFindings(draft, edges),
        ...collisionFindings(draft, edges, listTrackedFiles())
      ]
      return { tasks, cross }
    },
    deps.cwd
  )

  if (!staged.ok) {
    return { fingerprint, tasks: [], cross: [staged.finding], coverage, blocking: true }
  }
  const { tasks, cross } = staged.value
  const blocking = [...tasks.flatMap((t) => t.findings), ...cross, ...coverage].some(blocks)
  return { fingerprint, tasks, cross, coverage, blocking }
}
