/**
 * The Planner's Issue, surface, objectives and brief operations as a library.
 * Each operation returns an outcome — the written Issue's link, the rendered
 * text, or the findings that refused it — and never ends the process: the
 * Planner role tools call one operation here and return its outcome. Every refusal reached beneath an
 * operation (however deep) is captured as a finding, not an exit.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isForgeReadOversize,
  readIssueComments,
  readIssueFields
} from '../../../../../kernel/adapters/code-host/github/forge-read.js'
import { assembleAndRenderBrief } from '../../../tools/task-contract/brief-assembly.js'
import { type FrozenBriefCandidate, resolveNewestFrozenBrief } from '../../../tools/task-contract/brief-validation'
import { prepareTaskOrIssue } from '../../../tools/task-contract/dispatch-task.js'
import { findTrancheSlug } from '../../../tools/task-contract/forge/labels'
import { resolveTaskIssueRef } from '../../../tools/task-contract/forge/list-tasks'
import {
  type BodyResult,
  ForgeArgError,
  captureRefusal,
  countMarkerComments,
  ensureTrancheLabelExistsOutcome,
  extractLabels,
  extractTitle,
  fetchForgeLabelsOutcome,
  frozenSectionChangeOutcome,
  issueSurfaceOutcome,
  locateBody,
  makeCheckError,
  objectivesVersionMarkerPrefixes,
  parseIssueNumberFromRef,
  postMarkedComment,
  refuse,
  refuseUnlessPrincipal,
  renderSurfaceForcedSet,
  resolveMilestoneAttachOutcome,
  resolvePrincipalsOrRefuse,
  runGhWriteOutcome,
  validateTaskIssueOutcome
} from '../../../tools/task-contract/forge/forge-write'
import type { CheckError } from '../../../../../kernel/gates/checks/contract'
import {
  isTaskIssueBodyShaped,
  isTaskIssueLabelSet,
  parseIssueParts,
  type SurfaceForcedSet
} from '../../../tools/task-contract/issue-validation'
import {
  type Objective,
  objectivesOf,
  objectivesVersion,
  renderObjectives
} from '../../../tools/task-contract/objectives'

export const RETRY_CREATE = 'task_issue_create'
export const RETRY_EDIT = 'task_issue_edit'

// --- outcomes ----------------------------------------------------------------

/** What a refused operation returns: the findings, in the order the gate produced them. `forgeError` is the raw error of a `gh` write that failed after every gate passed. */
export type Refused = {
  ok: false
  findings: CheckError[]
  /** Warning-severity findings the gates raised before the refusal. */
  warnings: CheckError[]
  forgeError?: unknown
}

/** Where an operation reports what is not part of its outcome, at the moment it happens. */
export interface PlannerIo {
  warning?: (finding: CheckError) => void
  notice?: (text: string) => void
}

/** The forge-touching steps an Issue write runs, replaceable so a test stubs the forge. */
export interface PlannerForge {
  fetchLabels: typeof fetchForgeLabelsOutcome
  frozenSectionChange: typeof frozenSectionChangeOutcome
  validate: typeof validateTaskIssueOutcome
  ensureTrancheLabel: typeof ensureTrancheLabelExistsOutcome
  milestoneArgs: typeof resolveMilestoneAttachOutcome
  ghWrite: typeof runGhWriteOutcome
}

export const realPlannerForge: PlannerForge = {
  fetchLabels: fetchForgeLabelsOutcome,
  frozenSectionChange: frozenSectionChangeOutcome,
  validate: validateTaskIssueOutcome,
  ensureTrancheLabel: ensureTrancheLabelExistsOutcome,
  milestoneArgs: resolveMilestoneAttachOutcome,
  ghWrite: runGhWriteOutcome
}

export type IssueWriteOutcome =
  | {
      ok: true
      /** `true` when the forge was written; `false` for a validate-only pass. */
      written: boolean
      /** The link `gh` printed (empty when it printed none, or nothing was written). */
      url: string
      /** Non-null when the brief render never ran — a pass that must not be claimed as a full one. */
      renderSkipped: string | null
      warnings: CheckError[]
    }
  | Refused

const refusedWith = (findings: CheckError[], warnings: CheckError[], forgeError?: unknown): Refused => ({
  ok: false,
  findings,
  warnings,
  ...(forgeError !== undefined ? { forgeError } : {})
})

function locateBodyOutcome(
  ghArgs: string[],
  retryCommand: string
): { ok: true; bodyResult: BodyResult | null } | { ok: false; findings: CheckError[] } {
  try {
    return { ok: true, bodyResult: locateBody(ghArgs) }
  } catch (e) {
    if (e instanceof ForgeArgError) {
      return {
        ok: false,
        findings: [makeCheckError('forge-args', e.message, `Fix the invocation, then re-run \`${retryCommand}\`.`)]
      }
    }
    throw e
  }
}

/** Runs the gate once and splits its findings; a blocking one refuses, a warning is reported and passes. */
async function gate(
  forge: PlannerForge,
  io: PlannerIo,
  args: Parameters<PlannerForge['validate']>
): Promise<{ ok: true; renderSkipped: string | null; warnings: CheckError[] } | Refused> {
  const r = await forge.validate(...args)
  if (r.blocking) {
    return refusedWith(
      r.errors,
      r.errors.filter((e) => e.severity === 'warning')
    )
  }
  for (const e of r.errors) io.warning?.(e)
  return { ok: true, renderSkipped: r.renderSkipped, warnings: r.errors }
}

// --- create ------------------------------------------------------------------

/**
 * Creates a task Issue: the same gates as `task_issue_create`, then the
 * tranche label, the Milestone attach and the `gh` write. `validateOnly` runs
 * every gate and returns without touching the forge.
 */
export async function createIssue(
  input: { ghArgs: string[]; validateOnly?: boolean },
  io: PlannerIo = {},
  forge: PlannerForge = realPlannerForge
): Promise<IssueWriteOutcome> {
  const { ghArgs } = input
  const located = locateBodyOutcome(ghArgs, RETRY_CREATE)
  if (!located.ok) return refusedWith(located.findings, [])
  const { bodyResult } = located
  const body = bodyResult?.body ?? null
  const title = extractTitle(ghArgs)
  const labels = extractLabels(ghArgs)

  let renderSkipped: string | null = null
  let warnings: CheckError[] = []
  if (isTaskIssueLabelSet(labels) || (body !== null && isTaskIssueBodyShaped(body))) {
    // No number exists until the write completes — null is fail-closed, never "old enough to skip".
    const g = await gate(forge, io, [body, title, labels, RETRY_CREATE, null, { kind: 'create', ghArgs }])
    if (!g.ok) return g
    renderSkipped = g.renderSkipped
    warnings = g.warnings
  }

  if (input.validateOnly) return { ok: true, written: false, url: '', renderSkipped, warnings }

  const slugToEnsure = findTrancheSlug(labels)
  if (slugToEnsure) {
    const errors = forge.ensureTrancheLabel(slugToEnsure)
    if (errors.length > 0) return refusedWith(errors, warnings)
  }

  const milestone = forge.milestoneArgs(ghArgs, labels)
  if (milestone.notice) io.notice?.(milestone.notice)
  const written = forge.ghWrite(['issue', 'create'], milestone.args, bodyResult)
  if (!written.ok) return refusedWith(written.errors, warnings, written.cause)
  return { ok: true, written: true, url: written.url, renderSkipped, warnings }
}

// --- edit --------------------------------------------------------------------

/**
 * Edits an Issue: `args` is the target Issue ref followed by the `gh issue
 * edit` flags. The same gates as `task_issue_edit`; `validateOnly` stops
 * after them. `skipFrozenSectionsCheck` is the objectives edit's own escape
 * hatch; `retryCommand` names the command a refusal tells the caller to re-run.
 */
export async function editIssue(
  input: {
    args: string[]
    validateOnly?: boolean
    retryCommand?: string
    skipFrozenSectionsCheck?: boolean
  },
  io: PlannerIo = {},
  forge: PlannerForge = realPlannerForge
): Promise<IssueWriteOutcome> {
  const retry = input.retryCommand ?? RETRY_EDIT
  const issueRef = input.args[0]
  if (!issueRef || issueRef.startsWith('-')) {
    return refusedWith(
      [
        makeCheckError(
          'forge-args',
          '`task_issue_edit` requires the target Issue number/URL as the first argument.',
          'Call `task_issue_edit` with the `issue` number and the fields to change.'
        )
      ],
      []
    )
  }
  const ghArgs = input.args.slice(1)
  const located = locateBodyOutcome(ghArgs, retry)
  if (!located.ok) return refusedWith(located.findings, [])
  return editLocated(
    {
      issueRef,
      ghArgs,
      bodyResult: located.bodyResult,
      validateOnly: input.validateOnly,
      retryCommand: retry,
      skipFrozenSectionsCheck: input.skipFrozenSectionsCheck
    },
    io,
    forge
  )
}

/** The edit once its body is located — shared with the objectives edit, which writes a body it built itself. */
async function editLocated(
  input: {
    issueRef: string
    ghArgs: string[]
    bodyResult: BodyResult | null
    validateOnly?: boolean
    retryCommand: string
    skipFrozenSectionsCheck?: boolean
  },
  io: PlannerIo,
  forge: PlannerForge
): Promise<IssueWriteOutcome> {
  const { issueRef, ghArgs, bodyResult, retryCommand } = input
  const body = bodyResult?.body ?? null
  const title = extractTitle(ghArgs)

  // Union the forge's real labels with any passed on argv — argv is normally
  // silent on edit, so the forge is what decides task-Issue applicability.
  const fetched = forge.fetchLabels(issueRef, retryCommand)
  if ('errors' in fetched) return refusedWith(fetched.errors, [])
  const labels = [...new Set([...fetched.labels, ...extractLabels(ghArgs)])]

  let renderSkipped: string | null = null
  let warnings: CheckError[] = []
  if (isTaskIssueLabelSet(labels) || (body !== null && isTaskIssueBodyShaped(body))) {
    const frozen = forge.frozenSectionChange(issueRef, body, retryCommand, input.skipFrozenSectionsCheck ?? false)
    if (frozen.length > 0) return refusedWith(frozen, [])
    const g = await gate(forge, io, [
      body,
      title,
      labels,
      retryCommand,
      parseIssueNumberFromRef(issueRef),
      { kind: 'edit', issueRef, ghArgs }
    ])
    if (!g.ok) return g
    renderSkipped = g.renderSkipped
    warnings = g.warnings
  }

  if (input.validateOnly) return { ok: true, written: false, url: '', renderSkipped, warnings }

  const slugToEnsure = findTrancheSlug(labels)
  if (slugToEnsure) {
    const errors = forge.ensureTrancheLabel(slugToEnsure)
    if (errors.length > 0) return refusedWith(errors, warnings)
  }
  const written = forge.ghWrite(['issue', 'edit', issueRef], ghArgs, bodyResult)
  if (!written.ok) return refusedWith(written.errors, warnings, written.cause)
  return { ok: true, written: true, url: written.url, renderSkipped, warnings }
}

// --- surface -----------------------------------------------------------------

export type SurfaceOutcome =
  | { ok: true; set: SurfaceForcedSet; json: boolean; text: string }
  | { ok: false; exitCode: 2; message: string }

/** What a draft Issue's Boundary pins force on its Surface. Writes nothing. */
export function printIssueSurface(args: string[]): SurfaceOutcome {
  const r = issueSurfaceOutcome(args)
  if (!r.ok) return { ok: false, exitCode: 2, message: r.message }
  return { ok: true, set: r.set, json: r.json, text: renderSurfaceForcedSet(r.set) }
}

// --- brief -------------------------------------------------------------------

export type BriefOutcome = { ok: true; brief: string } | { ok: false; missing: string[] }

/** Renders a task's brief; a refusal lists the facts it could not find. */
export async function renderBrief(
  input: {
    trancheSlug: string
    taskId: string
    globs?: string[]
  },
  assemble: typeof assembleAndRenderBrief = assembleAndRenderBrief
): Promise<BriefOutcome> {
  const result = await assemble(input.trancheSlug, input.taskId, input.globs)
  if (!result.ok) return { ok: false, missing: result.missing }
  return { ok: true, brief: result.brief }
}

// --- objectives edit ---------------------------------------------------------

const RETRY = 'task_objectives_edit'
/** The objectives-version marker's opening, in every spelling, the current one first — the writer posts the first; `k` counts them all, so a version posted before the rename is never reused. */
const MARKER_PREFIXES = objectivesVersionMarkerPrefixes()
const MARKER_PREFIX = MARKER_PREFIXES[0] as string

type EditOp =
  | { kind: 'add'; sentence: string }
  | { kind: 'drop'; id: string }
  | { kind: 'replace'; id: string; sentence: string }

/**
 * The same `## Objectives` heading/next-heading boundary `objectivesOf`
 * itself locates (that scanner is internal to the objectives package, never
 * exported — the parsed `Objective[]` list is the public surface, not the
 * raw span). Re-deriving the SAME regex here only decides where to splice
 * text back in; it never re-implements the grammar `objectivesOf` already
 * validated.
 */
const HEADING_RE = /^##[ \t]*Objectives[ \t]*$/im
const NEXT_HEADING_RE = /^##[ \t]/m

/**
 * Replaces the `## Objectives` section (heading through the next `##`
 * heading, or end of body) with `renderedSection`, leaving every other byte
 * of `body` untouched — the before-heading and after-next-heading slices are
 * copied verbatim, never re-derived.
 */
export function spliceObjectivesSection(body: string, renderedSection: string): string {
  const heading = HEADING_RE.exec(body)
  if (!heading) {
    throw new Error(
      'spliceObjectivesSection: no `## Objectives` heading — caller must validate with objectivesOf first.'
    )
  }
  const before = body.slice(0, heading.index)
  const afterHeadingStart = heading.index + heading[0].length
  const afterHeading = body.slice(afterHeadingStart)
  const next = NEXT_HEADING_RE.exec(afterHeading)
  if (!next) return `${before}${renderedSection}\n`
  const tail = afterHeading.slice(next.index)
  return `${before}${renderedSection}\n\n${tail}`
}

/** The body with its `## Objectives` section blanked out — used to assert the edit touched nothing else. */
export function withoutObjectivesSection(body: string): string {
  const heading = HEADING_RE.exec(body)
  if (!heading) return body
  const before = body.slice(0, heading.index)
  const afterHeadingStart = heading.index + heading[0].length
  const afterHeading = body.slice(afterHeadingStart)
  const next = NEXT_HEADING_RE.exec(afterHeading)
  return next ? before + afterHeading.slice(next.index) : before
}

const PARTS_HEADING_RE = /^##[ \t]*Parts[ \t]*$/im

/** `{ headingEnd, sectionEnd }` byte offsets of the `## Parts` section's own content (heading excluded, next `##` heading excluded) — `null` when there is no `## Parts` heading at all. */
function partsSectionBounds(body: string): { headingEnd: number; sectionEnd: number } | null {
  const heading = PARTS_HEADING_RE.exec(body)
  if (!heading) return null
  const headingEnd = heading.index + heading[0].length
  const afterHeading = body.slice(headingEnd)
  const next = NEXT_HEADING_RE.exec(afterHeading)
  const sectionEnd = next ? headingEnd + next.index : body.length
  return { headingEnd, sectionEnd }
}

/**
 * Appends `partLine` as a new line at the end of the `## Parts` section —
 * `--add`'s own write, in the SAME edit as the Objectives change.
 * Throws when there is no `## Parts` heading at all: a pre-cutover Issue
 * with no Parts section has no self-serve add path here — the same posture
 * the brief-sections cutover already takes for a Surface-less Issue.
 */
export function appendPartLine(body: string, partLine: string): string {
  const bounds = partsSectionBounds(body)
  if (!bounds) {
    throw new Error('appendPartLine: no `## Parts` heading in this Issue body — cannot add a Part.')
  }
  const before = body.slice(0, bounds.headingEnd)
  const section = body.slice(bounds.headingEnd, bounds.sectionEnd).replace(/\s+$/, '')
  const tail = body.slice(bounds.sectionEnd)
  return `${before}${section}\n${partLine}\n${tail}`
}

/**
 * Removes every `## Parts` line whose citation is EXACTLY `droppedId` (and
 * nothing else) — `--drop`'s own write. A Part citing the dropped
 * objective alongside another is left untouched, unchanged from before this
 * edit: narrowing a multi-objective citation is out of this rule's scope. If
 * that leaves a Part citing an objective no longer defined,
 * `writeValidatedIssueEdit`'s own pre-existing `checkPartsCiteDefinedObjectives`
 * gate refuses the write naming the dangling citation — the Planner resolves
 * it by hand before the drop can proceed. A no-op when there is no
 * `## Parts` heading.
 */
export function removePartLinesCitingOnly(body: string, droppedId: string): string {
  const bounds = partsSectionBounds(body)
  if (!bounds) return body
  const droppedN = Number.parseInt(droppedId.replace(/^O/i, ''), 10)
  const before = body.slice(0, bounds.headingEnd)
  const section = body.slice(bounds.headingEnd, bounds.sectionEnd)
  const tail = body.slice(bounds.sectionEnd)
  const kept = section.split('\n').filter((line) => {
    const m = /^Part\s+\d+\s*\(([^)]*)\)\s*[-—–]/i.exec(line.trim())
    if (!m) return true
    const refs = [...(m[1] as string).matchAll(/O(\d+)/gi)].map((r) => Number.parseInt(r[1] as string, 10))
    return !(refs.length === 1 && refs[0] === droppedN)
  })
  return `${before}${kept.join('\n')}${tail}`
}

function formatList(objectives: Objective[]): string {
  return objectives.map((o) => `${o.id}. ${o.text}`).join('\n')
}

function parseArgs(args: string[]): { json: boolean; issueRef: string; op: EditOp; reason: string; part?: string } {
  const json = args.includes('--json')
  const rest = args.filter((a) => a !== '--json')

  const issueRef = rest[0]
  if (!issueRef || issueRef.startsWith('-')) {
    refuse([
      makeCheckError(
        'forge-args',
        '`task_objectives_edit` requires the target Issue number as the first argument.',
        `Pass the Issue number, e.g. \`${RETRY}\`.`
      )
    ])
  }

  const ops: EditOp[] = []
  let reason: string | undefined
  let part: string | undefined
  const flagArgs = rest.slice(1)
  for (let i = 0; i < flagArgs.length; i++) {
    const a = flagArgs[i] as string
    if (a === '--add') {
      ops.push({ kind: 'add', sentence: flagArgs[++i] ?? '' })
    } else if (a === '--drop') {
      ops.push({ kind: 'drop', id: flagArgs[++i] ?? '' })
    } else if (a === '--replace') {
      const id = flagArgs[++i] ?? ''
      const sentence = flagArgs[++i] ?? ''
      ops.push({ kind: 'replace', id, sentence })
    } else if (a === '--reason') {
      reason = flagArgs[++i]
    } else if (a === '--part') {
      part = flagArgs[++i]
    }
  }

  if (ops.length !== 1) {
    refuse([
      makeCheckError(
        'forge-args',
        `\`task_objectives_edit\` requires exactly one of --add, --drop, --replace (found ${ops.length}).`,
        `Pass exactly one edit flag, e.g. \`${RETRY}\`.`
      )
    ])
  }
  if (!reason || reason.trim().length === 0) {
    refuse([
      makeCheckError(
        'forge-args',
        '`task_objectives_edit` requires a non-empty `--reason "<text>"`.',
        `Add \`--reason "<text>"\`, then re-run \`${RETRY}\`.`
      )
    ])
  }
  // Security review, round 2, HIGH: this same reason is later
  // handed to `prepareTask`'s own O6 supersede call, which refuses a
  // `\r`/`\n` reason for the header-corruption hazard `dispatch-task.ts`
  // documents at its own check. Checked here too, before ANY write, so a
  // bad reason never gets past the point where the Objectives comment has
  // already posted — `prepareTask`'s refusal would otherwise fire only
  // after that comment exists, leaving the Issue and its frozen brief
  // disagreeing with no disclosure.
  if (/[\r\n]/.test(reason as string)) {
    refuse([
      makeCheckError(
        'forge-args',
        "`--reason` must be a single line — it becomes one line of the frozen comment header this edit may supersede, and a newline in it would corrupt every reader's header-line count for that version.",
        `Remove the newline from --reason, then re-run \`${RETRY}\`.`
      )
    ])
  }

  // O5: `--add` without a `--part` would freeze an
  // objective no `## Parts` line ever cites — `checkPartsCiteDefinedObjectives`
  // stays silent about it (it only checks a citation names a REAL objective,
  // never the reverse), so a frozen brief re-issued after this edit would
  // simply omit the new objective from every Part with nothing to fail on.
  // Refused here, naming the rule, rather than discovered downstream.
  if (ops[0]?.kind === 'add' && (!part || part.trim().length === 0)) {
    refuse([
      makeCheckError(
        'objectives-part-required',
        '`--add` requires `--part "Part <n> (O<k>) — <outcome>"` for the objective it adds — an objective with no citing Part is never covered by a frozen brief re-issued after this edit.',
        `Pass --part "Part <n> (O<k>) — <outcome>", then re-run \`${RETRY}\`.`
      )
    ])
  }
  if (ops[0]?.kind !== 'add' && part !== undefined) {
    refuse([
      makeCheckError(
        'forge-args',
        '`--part` is only meaningful with `--add`.',
        `Remove --part, then re-run \`${RETRY}\`.`
      )
    ])
  }

  return { json, issueRef, op: ops[0] as EditOp, reason: reason as string, part }
}

/** A comment reduced to what both `countMarkerComments` (body only) and `resolveNewestFrozenBrief` (body + author, O6) need, plus its own URL to name in a superseding-brief context. */
type IssueComment = FrozenBriefCandidate & { url: string }

export function fetchIssueBodyAndComments(issueRef: string): {
  number: number
  body: string
  title: string
  labels: string[]
  comments: IssueComment[]
} {
  try {
    const parsed = readIssueFields<{
      number?: number
      body?: string
      title?: string
      labels?: Array<{ name: string }>
    }>(issueRef, 'number,body,title,labels')
    return {
      number: parsed.number ?? Number.NaN,
      body: parsed.body ?? '',
      title: parsed.title ?? '',
      labels: (parsed.labels ?? []).map((l) => l.name),
      comments: readIssueComments(issueRef).map((c) => ({ body: c.body, url: c.url, author: c.author?.login ?? null }))
    }
  } catch (err) {
    if (isForgeReadOversize(err)) {
      refuse([makeCheckError('forge-fetch', err.message, `Trim the Issue's comments, then re-run \`${RETRY}\`.`)])
    }
    if (!(err instanceof SyntaxError)) {
      refuse([
        makeCheckError(
          'forge-fetch',
          `Could not fetch Issue ${issueRef} (\`gh issue view\`): ${err instanceof Error ? err.message : String(err)}`,
          `Check \`gh auth status\` and network, then re-run \`${RETRY}\`.`
        )
      ])
    }
    refuse([
      makeCheckError(
        'forge-fetch',
        `Could not parse \`gh issue view ${issueRef} --json number,body,title,labels,comments\` output.`,
        `Re-run \`${RETRY}\`.`
      )
    ])
  }
}

function applyOp(previous: Objective[], op: EditOp): Objective[] {
  if (op.kind === 'add') {
    if (op.sentence.trim().length === 0) {
      refuse([
        makeCheckError(
          'objectives-args',
          '`--add` requires a non-empty sentence.',
          `Pass a sentence, then re-run \`${RETRY}\`.`
        )
      ])
    }
    const maxN = previous.reduce((m, o) => Math.max(m, Number.parseInt(o.id.slice(1), 10)), 0)
    return [...previous, { id: `O${maxN + 1}`, text: op.sentence }]
  }

  const idx = previous.findIndex((o) => o.id === op.id)
  if (idx === -1) {
    refuse([
      makeCheckError(
        'objectives-args',
        `${op.id} does not exist in the current Objectives list.`,
        `Check the current list, then re-run \`${RETRY}\` with an existing id.`
      )
    ])
  }

  if (op.kind === 'replace') {
    if (op.sentence.trim().length === 0) {
      refuse([
        makeCheckError(
          'objectives-args',
          '`--replace` requires a non-empty sentence.',
          `Pass a sentence, then re-run \`${RETRY}\`.`
        )
      ])
    }
    return previous.map((o, i) => (i === idx ? { id: o.id, text: op.sentence } : o))
  }

  // --drop: remove the line, never renumber the survivors. If the parser then
  // refuses the result (a real numbering gap), that is a live contradiction
  // between the rationale's never-renumber rule and `objectivesOf`'s
  // contiguous-from-O1 grammar — report it verbatim and stop; do not change
  // `objectives.ts` to paper over it (§10).
  const dropped = previous.filter((o) => o.id !== op.id)
  const check = objectivesOf(renderObjectives(dropped))
  if (!check.ok) {
    refuse([
      makeCheckError(
        'objectives-drop-contiguity',
        `${check.errors.join(' ')} Dropping ${op.id} never renumbers the surviving objectives, but the result no longer parses — the Principal must rule on this contradiction (contiguous-from-O1 grammar vs. never-renumber rationale) before this drop can proceed.`,
        'Escalate to the Principal; do not change `objectives.ts`.'
      )
    ])
  }
  return dropped
}

export type ObjectivesOutcome =
  | { ok: true; version: string; url: string; supersedeUrl: string | null }
  | { ok: false; findings: CheckError[] }

/**
 * Edits an Issue's `## Objectives`: `args` is the Issue ref followed by exactly
 * one of `--add`, `--drop`, `--replace`, plus `--reason` (and `--part` for
 * `--add`). Principal-only. Writes the Issue, supersedes a frozen brief when
 * one exists, and posts the audit comment. A refusal anywhere beneath — an
 * argument, the Principal gate, a parse, a gate, a forge call — comes back as
 * findings.
 */
export async function editObjectives(
  args: string[],
  io: PlannerIo = {},
  deps: ObjectivesDeps = realObjectivesDeps
): Promise<ObjectivesOutcome> {
  const r = await captureRefusal(() => editObjectivesOrRefuse(args, io, deps))
  return r.ok ? r.value : { ok: false, findings: r.errors }
}

/** The forge-touching steps the objectives edit runs, replaceable so a test stubs the forge. */
export interface ObjectivesDeps {
  forge: PlannerForge
  requirePrincipal: (retryCommand: string) => void
  resolvePrincipals: (check: string, retryCommand: string) => string[]
  fetchIssue: typeof fetchIssueBodyAndComments
  supersede: typeof prepareTaskOrIssue
  postComment: typeof postMarkedComment
}

export const realObjectivesDeps: ObjectivesDeps = {
  forge: realPlannerForge,
  requirePrincipal: refuseUnlessPrincipal,
  resolvePrincipals: resolvePrincipalsOrRefuse,
  fetchIssue: (ref) => fetchIssueBodyAndComments(ref),
  supersede: prepareTaskOrIssue,
  postComment: postMarkedComment
}

async function editObjectivesOrRefuse(args: string[], io: PlannerIo, deps: ObjectivesDeps): Promise<ObjectivesOutcome> {
  const { issueRef, op, reason, part } = parseArgs(args)
  deps.requirePrincipal(RETRY)

  const { number, body, title, labels, comments } = deps.fetchIssue(issueRef)
  // Resolved before the edit below is written, so a Principal list that does
  // not resolve refuses with nothing changed on the forge.
  const allowlist = deps.resolvePrincipals('principal-only', RETRY)
  const parsed = objectivesOf(body)
  if (!parsed.ok) {
    refuse([
      makeCheckError(
        'objectives-parse',
        `Issue ${issueRef}'s \`## Objectives\` section does not parse: ${parsed.errors.join(' ')}`,
        "Fix the Issue body's Objectives section by hand, then retry."
      )
    ])
  }
  const previous = parsed.objectives

  const updated = applyOp(previous, op)
  const objectivesBody = spliceObjectivesSection(body, renderObjectives(updated))

  // `--add` writes its `--part` line into `## Parts` in this SAME edit, so a
  // frozen brief re-issued right after this command always passes
  // `checkObjectivesCoverage`/`checkPartsCiteDefinedObjectives`.
  // `--drop` removes the Part lines that cited only the dropped objective.
  let finalBody = objectivesBody
  if (op.kind === 'add') {
    finalBody = appendPartLine(finalBody, part as string)
    const reparsedParts = parseIssueParts(finalBody)
    if (!reparsedParts.ok) {
      refuse([
        makeCheckError(
          'objectives-part-malformed',
          `--part "${part}" produced a malformed \`## Parts\` section: ${reparsedParts.errors.join(' ')}`,
          `Fix --part to match \`Part <n> (O<k>) — <outcome>\`, then re-run \`${RETRY}\`.`
        )
      ])
    }
    const addedId = (updated[updated.length - 1] as Objective).id
    const addedN = Number.parseInt(addedId.slice(1), 10)
    if (!reparsedParts.value.some((p) => p.objectiveIds.includes(addedN))) {
      refuse([
        makeCheckError(
          'objectives-part-mismatch',
          `--part "${part}" does not cite ${addedId}, the objective this --add just created.`,
          `Pass --part "Part <n> (${addedId}) — <outcome>", then re-run \`${RETRY}\`.`
        )
      ])
    }
  } else if (op.kind === 'drop') {
    finalBody = removePartLinesCitingOnly(finalBody, op.id)
  }

  const dir = mkdtempSync(join(tmpdir(), 'vinaya-objectives-edit-'))
  const tmp = join(dir, 'body.md')
  writeFileSync(tmp, finalBody, 'utf8')
  try {
    const ghArgs = ['--body-file', tmp]
    // This command IS the sanctioned Objectives-change path the frozen-section
    // gate names as its escape hatch: it rewrites `## Parts` in the same edit
    // and posts its own superseding brief below.
    const written = await editLocated(
      {
        issueRef,
        ghArgs,
        bodyResult: locateBody(ghArgs),
        retryCommand: RETRY,
        skipFrozenSectionsCheck: true
      },
      io,
      deps.forge
    )
    if (!written.ok) {
      if (written.forgeError !== undefined) throw written.forgeError
      return { ok: false, findings: written.findings }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  const newVersion = objectivesVersion(updated)

  // If this task's brief is already frozen, the edit above just moved the
  // Issue and the frozen brief out of agreement. Resolve and post the
  // superseding brief BEFORE this edit's own audit comment below, so a
  // failure here leaves no objectives comment behind at all. A
  // tranche-labeled Issue supersedes through the tranche path; a backlog
  // Issue (no tranche identity) through the `--issue` path.
  let supersedeUrl: string | null = null
  const frozen = resolveNewestFrozenBrief(comments, allowlist)
  if (frozen !== null) {
    const taskRef = resolveTaskIssueRef(title, labels)
    const result = await deps.supersede(
      taskRef !== null
        ? { tranche: taskRef.trancheSlug, n: Number.parseInt(taskRef.taskId, 10), supersede: { reason } }
        : { issue: number, supersede: { reason } }
    )
    supersedeUrl = result.commentUrl
  }

  const k =
    countMarkerComments(
      comments.map((c) => c.body),
      MARKER_PREFIXES
    ) + 1
  const marker = `${MARKER_PREFIX}${k} -->`
  const commentBody = [
    'Previous:',
    formatList(previous),
    '',
    'Now:',
    formatList(updated),
    '',
    `Reason: ${reason}`,
    `Version: ${newVersion}`
  ].join('\n')
  const url = deps.postComment('issue', issueRef, marker, commentBody)

  return { ok: true, version: newVersion, url, supersedeUrl }
}
