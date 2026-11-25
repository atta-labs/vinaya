/**
 * A plan held whole, before any Issue exists.
 *
 * A published plan is a set of Issues written one at a time; nothing holds it
 * as one thing, so nothing can be checked, reviewed or approved as one thing.
 * A `PlanDraft` is that one thing: every task's title, body and labels, the
 * task list, the agreed scope (each item delivered by a task or left out), the
 * code revision the plan was written against, and the version of the review
 * questions it will be reviewed under. `draftFingerprint` names exactly that
 * content, so whatever is reviewed or approved points at one unambiguous plan.
 *
 * Tasks refer to each other by tranche task number (`Depends-on: 1, 2`,
 * `after task 2: ...`), which is stable before and after publication; `#<n>`
 * always means a published Issue. A bare number and a `#number` never name the
 * same thing — `resolveDraftEdges` keeps them apart.
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { TITLE_PATTERN } from '../task-contract/forge/list-tasks'
import { classifyEdge, parseRationaleDeps } from '../task-contract/forge/parse-rationale-deps'

/** The shape version the stored draft and its fingerprint are written in. */
export const PLAN_DRAFT_SCHEMA_VERSION = 1

const SLUG = /^[a-z0-9][a-z0-9-]*$/i
const COMMIT = /^[0-9a-f]{40}$/

const TaskSchema = z
  .object({
    /** The tranche task number, stable before and after publication. */
    number: z.number().int().min(1),
    /** The published Issue's number once the task has one; `null` before. */
    issue: z.number().int().min(1).nullable(),
    title: z.string().min(1),
    body: z.string().min(1),
    labels: z.array(
      z
        .string()
        .min(1)
        .refine((l) => !l.includes(','), 'a label carries no comma')
    )
  })
  .strict()

const ScopeItemSchema = z
  .object({
    item: z.string().min(1),
    disposition: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('delivered'), task: z.number().int().min(1) }).strict(),
      z.object({ kind: z.literal('left-out'), reason: z.string().min(1) }).strict()
    ])
  })
  .strict()

export const PlanDraftSchema = z
  .object({
    schemaVersion: z.literal(PLAN_DRAFT_SCHEMA_VERSION),
    /** The tranche slug; one draft per slug. */
    tranche: z.string().regex(SLUG, 'a tranche slug is letters, digits and hyphens'),
    /** A commit of the default branch the plan was written against. */
    revision: z.string().regex(COMMIT, 'the revision is a full 40-character commit id'),
    /** The version of the review questions the draft will be reviewed under. */
    reviewQuestionVersion: z.string().min(1),
    tasks: z.array(TaskSchema).min(1),
    scope: z.array(ScopeItemSchema)
  })
  .strict()
  .superRefine((draft, ctx) => {
    const numbers = new Set<number>()
    for (const [i, t] of draft.tasks.entries()) {
      if (numbers.has(t.number)) {
        ctx.addIssue({ code: 'custom', path: ['tasks', i, 'number'], message: `task number ${t.number} appears twice` })
      }
      numbers.add(t.number)
    }
    const items = new Set<string>()
    for (const [i, s] of draft.scope.entries()) {
      if (items.has(s.item)) {
        ctx.addIssue({ code: 'custom', path: ['scope', i, 'item'], message: `scope item "${s.item}" appears twice` })
      }
      items.add(s.item)
      if (s.disposition.kind === 'delivered' && !numbers.has(s.disposition.task)) {
        ctx.addIssue({
          code: 'custom',
          path: ['scope', i, 'disposition', 'task'],
          message: `scope item "${s.item}" is delivered by task ${s.disposition.task}, which the draft does not hold`
        })
      }
    }
  })

export type PlanDraft = z.infer<typeof PlanDraftSchema>
export type DraftTask = PlanDraft['tasks'][number]
export type DraftScopeItem = PlanDraft['scope'][number]

/** A malformed draft, as the findings a reader can act on — never a throw. */
export type DraftParse = { ok: true; draft: PlanDraft } | { ok: false; errors: string[] }

export function parsePlanDraft(input: unknown): DraftParse {
  const r = PlanDraftSchema.safeParse(input)
  if (r.success) return { ok: true, draft: r.data }
  return {
    ok: false,
    errors: r.error.issues.map((i) => `${i.path.length > 0 ? `${i.path.join('.')}: ` : ''}${i.message}`)
  }
}

// --- the fingerprint -----------------------------------------------------------

/** Line endings carry no meaning: `\r\n` and a lone `\r` read as `\n`. */
const normalizeText = (s: string): string => s.replace(/\r\n?/g, '\n')

/** JSON with every object's keys in sorted order, so key order never reaches the hash. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(typeof value === 'string' ? normalizeText(value) : value)
}

/**
 * The canonical form a fingerprint is taken over. What does not carry meaning
 * is removed here: tasks are ordered by number, labels and scope items are
 * ordered as sets, line endings are `\n`. Everything that does carry meaning —
 * each task's text, labels and Issue number, the task list, the scope, the
 * revision, the review question version — stays.
 */
export function canonicalDraft(draft: PlanDraft): string {
  const sorted = (xs: readonly string[]) => [...xs].map(normalizeText).sort()
  return canonicalJson({
    schemaVersion: draft.schemaVersion,
    tranche: draft.tranche,
    revision: draft.revision,
    reviewQuestionVersion: draft.reviewQuestionVersion,
    tasks: [...draft.tasks].sort((a, b) => a.number - b.number).map((t) => ({ ...t, labels: sorted(t.labels) })),
    scope: [...draft.scope].sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0))
  })
}

/** `sha256:<hex>` of the draft's canonical form. The same draft always gives the same value. */
export function draftFingerprint(draft: PlanDraft): string {
  return `sha256:${createHash('sha256').update(canonicalDraft(draft), 'utf8').digest('hex')}`
}

// --- a draft from published Issues ---------------------------------------------

/** One published Issue as the builder reads it. */
export type PublishedIssue = { number: number; title: string; body: string; labels: readonly string[] }

export type DraftFromIssuesInput = {
  tranche: string
  revision: string
  reviewQuestionVersion: string
  /** A tranche's open task Issues, or one standalone Issue. */
  issues: readonly PublishedIssue[]
  scope?: readonly DraftScopeItem[]
}

/**
 * A draft from Issues already published. A tranche task Issue is titled
 * `[<slug>] <n> — <title>`, and `<n>` is its task number; an Issue without that
 * title shape is a standalone one and is task 1 of a one-task draft. The Issue's
 * body is carried verbatim: its `Depends-on: #<n>` stays a published reference
 * and its `Depends-on: <n>` stays a task number.
 */
export function draftFromIssues(input: DraftFromIssuesInput): DraftParse {
  const errors: string[] = []
  const standalone = input.issues.length === 1 && !TITLE_PATTERN.test(input.issues[0]?.title ?? '')
  const tasks: DraftTask[] = []
  for (const issue of input.issues) {
    let number = 1
    let title = issue.title
    if (!standalone) {
      const m = TITLE_PATTERN.exec(issue.title)
      if (!m) {
        errors.push(`Issue #${issue.number} is titled "${issue.title}", not "[<tranche>] <n> — <title>"`)
        continue
      }
      if (m[1] !== input.tranche) {
        errors.push(`Issue #${issue.number} belongs to tranche "${m[1]}", not "${input.tranche}"`)
        continue
      }
      if (!/^\d+$/.test(m[2] as string)) {
        errors.push(`Issue #${issue.number} carries task id "${m[2]}", which is not a whole number`)
        continue
      }
      number = Number.parseInt(m[2] as string, 10)
      title = (m[3] as string).trim()
    }
    tasks.push({ number, issue: issue.number, title, body: issue.body, labels: [...issue.labels] })
  }
  if (errors.length > 0) return { ok: false, errors }
  return parsePlanDraft({
    schemaVersion: PLAN_DRAFT_SCHEMA_VERSION,
    tranche: input.tranche,
    revision: input.revision,
    reviewQuestionVersion: input.reviewQuestionVersion,
    tasks: tasks.sort((a, b) => a.number - b.number),
    scope: input.scope ?? []
  })
}

// --- edges inside a draft -------------------------------------------------------

export type DraftEdges = {
  task: number
  /** Tranche task numbers the task depends on, read from bare numbers. */
  dependsOnTasks: number[]
  /** Published Issues the task depends on, read from `#<n>`. */
  dependsOnIssues: number[]
  conflictsWithTasks: number[]
  conflictsWithIssues: number[]
  /** Edges written with another tranche's slug; they resolve outside this draft. */
  otherTranche: string[]
  /** Task numbers an edge names that the draft does not hold. */
  unknownTasks: number[]
}

/**
 * What each task's `Depends-on` and `Conflicts-with` name, resolved against the
 * draft: bare numbers against the draft's task list, `#<n>` as published Issues.
 * A number is never read as an Issue and an Issue never as a number.
 */
export function resolveDraftEdges(draft: PlanDraft): DraftEdges[] {
  const known = new Set(draft.tasks.map((t) => t.number))
  return [...draft.tasks]
    .sort((a, b) => a.number - b.number)
    .map((t) => {
      const { dependsOn, conflictsWith } = parseRationaleDeps(t.body)
      const out: DraftEdges = {
        task: t.number,
        dependsOnTasks: [],
        dependsOnIssues: [],
        conflictsWithTasks: [],
        conflictsWithIssues: [],
        otherTranche: [],
        unknownTasks: []
      }
      const read = (edges: readonly string[], tasks: number[], issues: number[]) => {
        for (const edge of edges) {
          const ref = classifyEdge(edge)
          if (ref === null) continue
          if (ref.kind === 'other-tranche') out.otherTranche.push(edge.trim())
          else if (ref.kind === 'issue') issues.push(ref.number)
          else {
            tasks.push(ref.number)
            if (!known.has(ref.number) && !out.unknownTasks.includes(ref.number)) out.unknownTasks.push(ref.number)
          }
        }
      }
      read(dependsOn, out.dependsOnTasks, out.dependsOnIssues)
      read(conflictsWith, out.conflictsWithTasks, out.conflictsWithIssues)
      return out
    })
}
