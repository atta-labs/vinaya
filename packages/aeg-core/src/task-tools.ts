/**
 * The task-tool catalog — the one place a task-operator tool's name, input
 * shape, result shape, error shape and purpose are written. Five tools:
 * `task_status` and `task_escalation_read` are bound to a real read
 * interface (`apps/cli/src/lib/task-tools/read.ts` and `handlers.ts` —
 * `apps/cli` reads the outbox and the forge, `aeg-core` stays pure); `task_start`,
 * `task_resume` and `task_cancel` are declared here but refuse with
 * `capability_unavailable` until a control store exists to act on (Traps to
 * avoid: an internal helper is not automatically an agent tool, and this
 * catalog exposes no raw shell or forge access — every field below is
 * either a schema or prose, never a live handle to a process or a write).
 *
 * `handlerBinding` names where each tool's behaviour actually lives; it is
 * data (a module/export pointer), not an import — `aeg-core` has no
 * dependency on `apps/cli`, so the binding is documentation the CLI-side
 * registry is expected to satisfy, not a call this file can make itself.
 *
 * A caller-supplied `role` field is never part of any input schema below —
 * an agent's own claim about who it is authenticates nothing (Traps to
 * avoid); authority is a property of the transport that invokes a tool, not
 * a value that transport lets the caller set.
 */

import { z } from 'zod'

// --- error taxonomy ---------------------------------------------------------

/**
 * Eight kinds, each naming a distinct reason a tool call did not produce its
 * result: `validation` (the input itself is malformed), `authority` (the
 * caller may not do this), `precondition` (the input is well-formed but the
 * task is not in a state this call accepts — e.g. resuming a task with no
 * paused run), `capability` (the tool exists in the catalog but its handler
 * is not yet implemented — the fixed refusal `task_start`/`task_resume`/
 * `task_cancel` return today), `infrastructure` (a read or write the tool
 * depends on failed for reasons outside the caller's input — a file the
 * outbox should carry could not be read), `cancellation` (a cancel request
 * could not be honored, e.g. nothing running to cancel), `timeout` (a read
 * exceeded its own bound), and `uncertain_effect` (a mutation was attempted
 * and its outcome could not be confirmed — reserved for `task_start`/
 * `task_resume`/`task_cancel` once they have a real effect to be uncertain
 * about; no handler below returns it yet).
 */
export const TASK_TOOL_ERROR_KINDS = [
  'validation',
  'authority',
  'precondition',
  'capability',
  'infrastructure',
  'cancellation',
  'timeout',
  'uncertain_effect'
] as const

export type TaskToolErrorKind = (typeof TASK_TOOL_ERROR_KINDS)[number]

export const TaskToolErrorSchema = z.object({
  kind: z.enum(TASK_TOOL_ERROR_KINDS),
  message: z.string().min(1),
  detail: z.string().optional()
})

export type TaskToolError = z.infer<typeof TaskToolErrorSchema>

export function taskToolError(kind: TaskToolErrorKind, message: string, detail?: string): TaskToolError {
  return detail === undefined ? { kind, message } : { kind, message, detail }
}

/** The one error every not-yet-landed mutating tool returns — same kind, same message shape, so a caller routing on `kind` never has to special-case which of the three it called. */
export function capabilityUnavailable(tool: TaskToolName, becauseOf: string): TaskToolError {
  return taskToolError('capability', `${tool} is not available yet — ${becauseOf}.`)
}

// --- shared primitives -------------------------------------------------------

/**
 * The two identity shapes every task-referencing tool accepts — a
 * tranche-labeled task (`{ tranche, id }`, matching `task/<tranche>/<n>`) or
 * a backlog task (`{ issue }`, matching `task/issue-<n>`) — the same two
 * shapes `apps/cli/src/lib/task-status.ts`'s own `TaskRef` already
 * distinguishes, mirrored here as the catalog's public vocabulary rather
 * than importing that CLI-internal type (`aeg-core` takes no dependency on
 * `apps/cli`).
 */
export const TaskToolRefSchema = z.union([
  z.object({ tranche: z.string().min(1), id: z.string().min(1) }),
  z.object({ issue: z.number().int().positive() })
])

export type TaskToolRef = z.infer<typeof TaskToolRefSchema>

/** Bounded pagination — every list-shaped result caps at `limit` (default and ceiling both declared here, so no caller and no handler picks its own). */
export const DEFAULT_PAGE_LIMIT = 20
export const MAX_PAGE_LIMIT = 100

export const PageRequestSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(MAX_PAGE_LIMIT).optional()
})

export type PageRequest = z.infer<typeof PageRequestSchema>

/**
 * `fresh`: the record was read and is current as of the run's last known
 * transition. `stale`: the record was read but predates that transition
 * (e.g. a pause record for a round the loop has since published past).
 * `unknown`: no record exists to read at all, or it could not be parsed.
 * Every observation the read interface (O2) returns carries one of these
 * alongside its own `observedAt` timestamp — never a bare value with no way
 * to tell a fresh read from a guess.
 */
export const FreshnessSchema = z.enum(['fresh', 'stale', 'unknown'])
export type Freshness = z.infer<typeof FreshnessSchema>

export const ObservedSchema = z.object({
  observedAt: z.string(),
  freshness: FreshnessSchema
})

// --- task_status -------------------------------------------------------------

export const TaskStatusInputSchema = z
  .object({
    task: TaskToolRefSchema.optional()
  })
  .merge(PageRequestSchema)

export type TaskStatusInput = z.infer<typeof TaskStatusInputSchema>

export const TaskStatusItemSchema = z
  .object({
    task: TaskToolRefSchema,
    issue: z.number().int().positive(),
    pr: z.number().int().positive().nullable(),
    state: z.string()
  })
  .merge(ObservedSchema)

export const TaskStatusResultSchema = z.object({
  items: z.array(TaskStatusItemSchema),
  nextCursor: z.string().nullable()
})

export type TaskStatusResult = z.infer<typeof TaskStatusResultSchema>

// --- task_escalation_read ------------------------------------------------

/** Who this pause reason is addressed to — the same routing the loop's own doctrine already gives each `PauseReason`, named here so the tool's result carries it as data rather than requiring the caller to know the doctrine. */
export const RequestedAuthoritySchema = z.enum(['planner', 'principal', 'operator', 'self'])
export type RequestedAuthority = z.infer<typeof RequestedAuthoritySchema>

export const EscalationInputsSchema = z.object({
  task: z.number().int().positive(),
  round: z.number().int().nonnegative(),
  head: z.string(),
  branch: z.string(),
  prNumber: z.number().int().positive()
})

export const EscalationEvidenceSchema = z.object({
  round: z.number().int().nonnegative(),
  reviewer: z.string().nullable(),
  security: z.string().nullable()
})

export const TaskEscalationReadInputSchema = z
  .object({
    task: TaskToolRefSchema
  })
  .merge(PageRequestSchema)

export type TaskEscalationReadInput = z.infer<typeof TaskEscalationReadInputSchema>

export const TaskEscalationPacketSchema = z
  .object({
    reason: z.string(),
    detail: z.string().nullable(),
    inputs: EscalationInputsSchema.nullable(),
    evidence: EscalationEvidenceSchema.nullable(),
    attemptedRecovery: z.string(),
    requestedAuthority: RequestedAuthoritySchema,
    permittedNextActions: z.array(z.string())
  })
  .merge(ObservedSchema)

export type TaskEscalationPacket = z.infer<typeof TaskEscalationPacketSchema>

export const TaskEscalationReadResultSchema = z
  .object({
    items: z.array(TaskEscalationPacketSchema),
    nextCursor: z.string().nullable()
  })
  .merge(ObservedSchema)

export type TaskEscalationReadResult = z.infer<typeof TaskEscalationReadResultSchema>

// --- task_start / task_resume / task_cancel (stubs — O3) ------------------

export const TaskStartInputSchema = z.object({
  tranche: z.string().min(1),
  id: z.string().min(1)
})
export type TaskStartInput = z.infer<typeof TaskStartInputSchema>

export const TaskResumeInputSchema = z.object({
  task: TaskToolRefSchema
})
export type TaskResumeInput = z.infer<typeof TaskResumeInputSchema>

export const TaskCancelInputSchema = z.object({
  task: TaskToolRefSchema,
  reason: z.string().min(1)
})
export type TaskCancelInput = z.infer<typeof TaskCancelInputSchema>

/** No mutating tool below has a result shape yet — each one always refuses (O3) — so its schema is `z.never()`: a handler that ever resolves rather than refuses is a type error at the call site, not a silent success. */
export const NoResultSchema = z.never()

// --- catalog -----------------------------------------------------------------

export const TASK_TOOL_NAMES = [
  'task_start',
  'task_status',
  'task_escalation_read',
  'task_resume',
  'task_cancel'
] as const

export type TaskToolName = (typeof TASK_TOOL_NAMES)[number]

export function isTaskToolName(value: string): value is TaskToolName {
  return (TASK_TOOL_NAMES as readonly string[]).includes(value)
}

/** Where a tool's behaviour is actually implemented — a pointer for a CLI-side registry to satisfy, never a call this module makes. */
export type TaskToolHandlerBinding =
  | { kind: 'bound'; module: string; export: string }
  | { kind: 'stub'; module: string; export: string }

export type TaskToolDefinition<Input = unknown, Result = unknown> = {
  name: TaskToolName
  /** One sentence: what an Operator calls this tool to accomplish. */
  purpose: string
  /** What this tool is not — the neighbour it is easiest to confuse it with, and why the boundary sits where it does. */
  boundaries: string
  inputSchema: z.ZodType<Input>
  resultSchema: z.ZodType<Result>
  errorSchema: typeof TaskToolErrorSchema
  /** At least one schema-valid input, so a catalog consumer can typecheck and smoke-test a call without inventing its own fixture. */
  examples: readonly Input[]
  handlerBinding: TaskToolHandlerBinding
}

export const TASK_STATUS_TOOL: TaskToolDefinition<TaskStatusInput, TaskStatusResult> = {
  name: 'task_status',
  purpose:
    "Read a task's current loop state (running, paused, published, exited, or no driver) and its Issue/PR identity, without shelling to `ps` or re-parsing posted verdict comments.",
  boundaries:
    'Terse and always-answerable: one state per task, from records that either exist or explicitly do not. It never explains WHY a paused task is paused beyond naming the reason — that full packet is `task_escalation_read`. Omitting `task` lists every open task, paginated; it never starts, resumes or cancels anything.',
  inputSchema: TaskStatusInputSchema,
  resultSchema: TaskStatusResultSchema,
  errorSchema: TaskToolErrorSchema,
  examples: [{ task: { tranche: 'task-operator-v1', id: '1' } }, { limit: 10 }, {}],
  handlerBinding: { kind: 'bound', module: 'apps/cli/src/lib/task-tools/handlers.ts', export: 'taskStatusHandler' }
}

export const TASK_ESCALATION_READ_TOOL: TaskToolDefinition<TaskEscalationReadInput, TaskEscalationReadResult> = {
  name: 'task_escalation_read',
  purpose:
    "Read the full escalation packet for a paused task — the reason, the round's inputs, the held verdict evidence, what recovery the driver already attempted, who the pause is addressed to, and the actions permitted next.",
  boundaries:
    'Only meaningful once `task_status` reports `paused` (or a prior pause the run has since moved past, returned as `stale`); calling it on a task with no pause record ever written answers with an empty, `unknown`-freshness page rather than an error — a caller unsure whether a task ever paused can call this directly. It never resumes or cancels; those stay `task_resume`/`task_cancel`.',
  inputSchema: TaskEscalationReadInputSchema,
  resultSchema: TaskEscalationReadResultSchema,
  errorSchema: TaskToolErrorSchema,
  examples: [{ task: { tranche: 'task-operator-v1', id: '1' } }, { task: { issue: 558 }, limit: 5 }],
  handlerBinding: {
    kind: 'bound',
    module: 'apps/cli/src/lib/task-tools/handlers.ts',
    export: 'taskEscalationReadHandler'
  }
}

export const TASK_START_TOOL: TaskToolDefinition<TaskStartInput, never> = {
  name: 'task_start',
  purpose: 'Start a fresh dev-review-loop run for a task that has never been dispatched.',
  boundaries:
    'Distinct from `task_resume`: this tool is only ever sensible for a task with no prior run at all. It refuses every call today (`capability_unavailable`) — no control manifest exists yet for it to write a run into (Traps to avoid: no new control manifest, no process start).',
  inputSchema: TaskStartInputSchema,
  resultSchema: NoResultSchema,
  errorSchema: TaskToolErrorSchema,
  examples: [{ tranche: 'task-operator-v1', id: '1' }],
  handlerBinding: { kind: 'stub', module: 'apps/cli/src/lib/task-tools/handlers.ts', export: 'taskStartHandler' }
}

export const TASK_RESUME_TOOL: TaskToolDefinition<TaskResumeInput, never> = {
  name: 'task_resume',
  purpose: 'Continue a paused or exited dev-review-loop run from where it left off.',
  boundaries:
    "Distinct from `task_start`: this tool only ever applies to a task that already has a run. It refuses every call today (`capability_unavailable`) — resuming a run is a process start, and this task's Surface admits no process start.",
  inputSchema: TaskResumeInputSchema,
  resultSchema: NoResultSchema,
  errorSchema: TaskToolErrorSchema,
  examples: [{ task: { tranche: 'task-operator-v1', id: '1' } }],
  handlerBinding: { kind: 'stub', module: 'apps/cli/src/lib/task-tools/handlers.ts', export: 'taskResumeHandler' }
}

export const TASK_CANCEL_TOOL: TaskToolDefinition<TaskCancelInput, never> = {
  name: 'task_cancel',
  purpose: 'Stop a running or paused dev-review-loop run and release its driver lock.',
  boundaries:
    'The only tool in this catalog whose job is to end a run rather than read or continue one. It refuses every call today (`capability_unavailable`) — releasing a lock and terminating a driver is a forge/process mutation this Surface does not admit yet.',
  inputSchema: TaskCancelInputSchema,
  resultSchema: NoResultSchema,
  errorSchema: TaskToolErrorSchema,
  examples: [{ task: { issue: 558 }, reason: 'superseded by a re-plan' }],
  handlerBinding: { kind: 'stub', module: 'apps/cli/src/lib/task-tools/handlers.ts', export: 'taskCancelHandler' }
}

/** The one place every tool's name and shape can be found — in this fixed order, matching `TASK_TOOL_NAMES`. */
export const TASK_TOOL_CATALOG: readonly [
  typeof TASK_START_TOOL,
  typeof TASK_STATUS_TOOL,
  typeof TASK_ESCALATION_READ_TOOL,
  typeof TASK_RESUME_TOOL,
  typeof TASK_CANCEL_TOOL
] = [TASK_START_TOOL, TASK_STATUS_TOOL, TASK_ESCALATION_READ_TOOL, TASK_RESUME_TOOL, TASK_CANCEL_TOOL]

export function taskToolByName(name: TaskToolName): TaskToolDefinition {
  const found = TASK_TOOL_CATALOG.find((tool) => tool.name === name)
  if (!found) throw new Error(`no catalog entry for task tool "${name}"`)
  return found as TaskToolDefinition
}
