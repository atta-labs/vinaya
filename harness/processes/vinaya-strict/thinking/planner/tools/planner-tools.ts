/**
 * The Planner's role tools — the six operations the Planner writes a task
 * Issue with, served on the Planner's own seat of the tool host. Each tool
 * validates its input, calls ONE operation of the Planner library
 * (`planner-operations.ts`, which returns an outcome and never ends the
 * process — never a command function, which parses argv and exits) and returns
 * that outcome: the written Issue's link or the rendered text on success; on
 * refusal a `validation` error in the task tools' typed shape whose `message`
 * is the first finding and whose string `detail` is the JSON text of EVERY
 * finding as `{check, message, recovery}`, so no finding loses its check name
 * or its recovery text. A handler never throws past its boundary: an
 * unexpected failure is an `infrastructure` error, so no call ends the server.
 *
 * The catalog entries (name, description, input and output JSON Schema) and
 * the handlers are defined here; the seat table (`integration/server.ts`)
 * binds them to the Planner seat and its grant (`integration/policies/roles.ts`).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { taskToolError, type TaskToolError } from '../../../../../kernel/tools/catalog/task-tools'
import type { SeatCallResult, SeatHandler } from '../../../../../kernel/tools/host/seat-host.js'
import type { McpToolListEntry } from '../../../../../kernel/tools/mcp-protocol.js'
import type { CheckError } from '../../../../../kernel/gates/checks/contract'
import {
  createIssue,
  editIssue,
  editObjectives,
  printIssueSurface,
  renderBrief,
  type BriefOutcome,
  type IssueWriteOutcome,
  type ObjectivesOutcome,
  type SurfaceOutcome
} from './planner-operations'

// --- names ------------------------------------------------------------------

/** The six tools the Planner's seat is granted, in the order the seat lists them. */
export const PLANNER_TOOL_NAMES = [
  'task_issue_create',
  'task_issue_edit',
  'task_issue_surface',
  'task_objectives_edit',
  'brief_render',
  'task_issue_validate'
] as const

export type PlannerToolName = (typeof PLANNER_TOOL_NAMES)[number]

// --- findings and the typed refusal -----------------------------------------

/** One finding as a refusal's detail carries it. */
export type PlannerFinding = { check: string; message: string; recovery: string }

const finding = (check: string, message: string, recovery: string): PlannerFinding => ({ check, message, recovery })

const fromCheckError = (e: CheckError): PlannerFinding => ({
  check: e.check,
  message: e.message,
  recovery: e.agent_recovery_prompt
})

/** The refusal every tool returns: `message` is the first finding, `detail` the JSON text of all of them. */
export function findingsRefusal(findings: readonly PlannerFinding[]): TaskToolError {
  const first = findings[0]
  return taskToolError(
    'validation',
    first ? first.message : 'the operation was refused without a finding',
    JSON.stringify(findings)
  )
}

const refused = (findings: readonly PlannerFinding[]): SeatCallResult => ({
  ok: false,
  error: findingsRefusal(findings)
})
const succeeded = (result: unknown): SeatCallResult => ({ ok: true, result })

// --- input schemas ------------------------------------------------------------

const label = z
  .string()
  .min(1)
  .refine((l) => !l.includes(','), 'a label carries no comma')
const issueNumber = z.number().int().min(1)

const CreateInput = z
  .object({
    title: z.string().min(1),
    body: z.string().min(1),
    labels: z.array(label).optional(),
    milestone: z.string().min(1).optional()
  })
  .strict()

const EditInput = z
  .object({
    issue: issueNumber,
    title: z.string().min(1).optional(),
    body: z.string().min(1).optional(),
    addLabels: z.array(label).optional()
  })
  .strict()
  .refine((v) => v.title !== undefined || v.body !== undefined || (v.addLabels?.length ?? 0) > 0, {
    message: 'an edit changes at least one of title, body, addLabels'
  })

const ValidateInput = z
  .object({
    mode: z.enum(['create', 'edit']),
    issue: issueNumber.optional(),
    title: z.string().min(1).optional(),
    body: z.string().min(1),
    labels: z.array(label).optional()
  })
  .strict()
  .refine((v) => (v.mode === 'edit') === (v.issue !== undefined), {
    message: 'issue is given for mode "edit" and for no other mode'
  })

const SurfaceInput = z.object({ body: z.string().min(1) }).strict()

const ObjectivesInput = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('add'),
      issue: issueNumber,
      sentence: z.string().min(1),
      reason: z.string().min(1),
      part: z.string().min(1).optional()
    })
    .strict(),
  z.object({ op: z.literal('drop'), issue: issueNumber, id: z.string().min(1), reason: z.string().min(1) }).strict(),
  z
    .object({
      op: z.literal('replace'),
      issue: issueNumber,
      id: z.string().min(1),
      sentence: z.string().min(1),
      reason: z.string().min(1)
    })
    .strict()
])

const BriefInput = z
  .object({ tranche: z.string().min(1), id: z.string().min(1), globs: z.array(z.string().min(1)).optional() })
  .strict()

// --- JSON Schemas (the wire needs them; Zod 3 ships no exporter) ---------------

const str = { type: 'string', minLength: 1 } as const
const labelsSchema = { type: 'array', items: { type: 'string', minLength: 1, pattern: '^[^,]+$' } } as const
const issueSchema = { type: 'integer', minimum: 1 } as const

const FINDING_JSON_SCHEMA = {
  type: 'object',
  properties: { check: { type: 'string' }, message: { type: 'string' }, recovery: { type: 'string' } },
  required: ['check', 'message', 'recovery'],
  additionalProperties: false
} as const
const FINDINGS_ARRAY = { type: 'array', items: FINDING_JSON_SCHEMA } as const

const WRITTEN_OUTPUT = {
  type: 'object',
  properties: {
    written: { type: 'boolean' },
    url: { type: 'string', description: "The written Issue's link; empty when nothing was written." },
    renderSkipped: { type: ['string', 'null'] },
    warnings: FINDINGS_ARRAY
  },
  required: ['written', 'url', 'renderSkipped', 'warnings'],
  additionalProperties: false
} as const

/** The input JSON Schema of each tool. */
export const PLANNER_TOOL_INPUT_JSON_SCHEMAS: Record<PlannerToolName, Record<string, unknown>> = {
  task_issue_create: {
    type: 'object',
    properties: { title: str, body: str, labels: labelsSchema, milestone: str },
    required: ['title', 'body'],
    additionalProperties: false
  },
  task_issue_edit: {
    type: 'object',
    properties: { issue: issueSchema, title: str, body: str, addLabels: labelsSchema },
    required: ['issue'],
    additionalProperties: false
  },
  task_issue_surface: {
    type: 'object',
    properties: { body: str },
    required: ['body'],
    additionalProperties: false
  },
  task_objectives_edit: {
    type: 'object',
    properties: {
      op: { enum: ['add', 'drop', 'replace'] },
      issue: issueSchema,
      sentence: { ...str, description: 'The objective sentence, for add and replace.' },
      id: { ...str, description: 'The objective id (O<k>), for drop and replace.' },
      reason: str,
      part: { ...str, description: 'The Parts line written with an added objective.' }
    },
    required: ['op', 'issue', 'reason'],
    additionalProperties: false
  },
  brief_render: {
    type: 'object',
    properties: { tranche: str, id: str, globs: { type: 'array', items: str } },
    required: ['tranche', 'id'],
    additionalProperties: false
  },
  task_issue_validate: {
    type: 'object',
    properties: {
      mode: {
        enum: ['create', 'edit'],
        description: 'Which write gate to run: the one create or the one edit passes.'
      },
      issue: { ...issueSchema, description: 'The Issue number, for mode "edit" only.' },
      title: str,
      body: str,
      labels: labelsSchema
    },
    required: ['mode', 'body'],
    additionalProperties: false
  }
}

/** The output JSON Schema of each tool, as a success returns it. */
export const PLANNER_TOOL_OUTPUT_JSON_SCHEMAS: Record<PlannerToolName, Record<string, unknown>> = {
  task_issue_create: WRITTEN_OUTPUT,
  task_issue_edit: WRITTEN_OUTPUT,
  task_issue_validate: WRITTEN_OUTPUT,
  task_issue_surface: {
    type: 'object',
    properties: { text: { type: 'string' }, set: { type: 'object' } },
    required: ['text', 'set'],
    additionalProperties: false
  },
  task_objectives_edit: {
    type: 'object',
    properties: { version: { type: 'string' }, url: { type: 'string' }, supersedeUrl: { type: ['string', 'null'] } },
    required: ['version', 'url', 'supersedeUrl'],
    additionalProperties: false
  },
  brief_render: {
    type: 'object',
    properties: { brief: { type: 'string' } },
    required: ['brief'],
    additionalProperties: false
  }
}

const REFUSAL_NOTE =
  'A refusal is a `validation` error: `message` is the first finding, `detail` is the JSON text of every finding as {check, message, recovery}.'

const DESCRIPTIONS: Record<PlannerToolName, string> = {
  task_issue_create: `Create a task Issue from a title, a body and labels through the Issue write gate (the same gates \`task_issue_validate\` dry-runs), then write it. Returns the written Issue's link. ${REFUSAL_NOTE}`,
  task_issue_edit: `Edit a task Issue's title, body or labels through the Issue write gate (the same gates \`task_issue_validate\` dry-runs). Returns the Issue's link. ${REFUSAL_NOTE}`,
  task_issue_surface: `Report what a draft Issue body's Boundary pins force on its Surface. Writes nothing. ${REFUSAL_NOTE}`,
  task_objectives_edit: `Add, drop or replace one objective of an Issue's \`## Objectives\` (Principal only); supersedes a frozen brief when one exists. Returns the new objectives version. ${REFUSAL_NOTE}`,
  brief_render: `Render a task's brief from its Issue; a refusal lists the facts it could not find. Writes nothing. ${REFUSAL_NOTE}`,
  task_issue_validate: `Dry-run the Issue write gate for a create or an edit: runs exactly the gates create and edit run, writes nothing, and returns the findings in the same encoding as the other tools. ${REFUSAL_NOTE}`
}

/** The Planner seat's catalog entries, in the order the seat lists them. */
export const PLANNER_TOOL_ENTRIES: readonly McpToolListEntry[] = PLANNER_TOOL_NAMES.map((name) => ({
  name,
  description: DESCRIPTIONS[name],
  inputSchema: PLANNER_TOOL_INPUT_JSON_SCHEMAS[name],
  outputSchema: PLANNER_TOOL_OUTPUT_JSON_SCHEMAS[name]
}))

// --- handlers -------------------------------------------------------------------

/** The library operations each tool calls, replaceable so a test stubs the forge. */
export type PlannerOperations = {
  createIssue: (input: { ghArgs: string[]; validateOnly?: boolean }) => Promise<IssueWriteOutcome>
  editIssue: (input: { args: string[]; validateOnly?: boolean }) => Promise<IssueWriteOutcome>
  editObjectives: (args: string[]) => Promise<ObjectivesOutcome>
  printIssueSurface: (args: string[]) => SurfaceOutcome
  renderBrief: (input: { trancheSlug: string; taskId: string; globs?: string[] }) => Promise<BriefOutcome>
}

export const realPlannerOperations: PlannerOperations = {
  createIssue: (input) => createIssue(input),
  editIssue: (input) => editIssue(input),
  editObjectives: (args) => editObjectives(args),
  printIssueSurface,
  renderBrief: (input) => renderBrief(input)
}

/** Writes a body to a scratch file the library reads (`--body-file`), and removes it when the operation is over. */
async function withBodyFile<T>(body: string | undefined, run: (bodyFile: string | null) => Promise<T> | T): Promise<T> {
  if (body === undefined) return run(null)
  const dir = mkdtempSync(join(tmpdir(), 'planner-tool-'))
  try {
    const file = join(dir, 'body.md')
    writeFileSync(file, body, 'utf8')
    return await run(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const labelArgs = (flag: string, labels: readonly string[] | undefined) => (labels ?? []).flatMap((l) => [flag, l])

function issueOutcomeResult(outcome: IssueWriteOutcome): SeatCallResult {
  if (!outcome.ok) return refused(outcome.findings.map(fromCheckError))
  return succeeded({
    written: outcome.written,
    url: outcome.url,
    renderSkipped: outcome.renderSkipped,
    warnings: outcome.warnings.map(fromCheckError)
  })
}

/** Parses the caller's input; a malformed one is a refusal in the same encoding as any other. */
function parse<S extends z.ZodTypeAny>(
  schema: S,
  input: unknown
): { ok: true; value: z.infer<S> } | { ok: false; refusal: SeatCallResult } {
  const r = schema.safeParse(input ?? {})
  if (r.success) return { ok: true, value: r.data }
  return {
    ok: false,
    refusal: refused(
      r.error.issues.map((issue) =>
        finding(
          'tool-input',
          `${issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''}${issue.message}`,
          'Correct the tool input to match its input schema, then call the tool again.'
        )
      )
    )
  }
}

/** Wraps a handler so nothing it throws ends the server: an unexpected failure is an `infrastructure` error. */
function guarded<S extends z.ZodTypeAny>(
  schema: S,
  run: (input: z.infer<S>) => Promise<SeatCallResult> | SeatCallResult
): SeatHandler<unknown> {
  return async (input) => {
    const parsed = parse(schema, input)
    if (!parsed.ok) return parsed.refusal
    try {
      return await run(parsed.value)
    } catch (e) {
      return { ok: false, error: taskToolError('infrastructure', e instanceof Error ? e.message : String(e)) }
    }
  }
}

/** The handler of each Planner tool, over the library operations given. */
export function plannerToolHandlers(
  ops: PlannerOperations = realPlannerOperations
): Record<PlannerToolName, SeatHandler<unknown>> {
  return {
    task_issue_create: guarded(CreateInput, (v) =>
      withBodyFile(v.body, async (file) =>
        issueOutcomeResult(
          await ops.createIssue({
            ghArgs: [
              '--title',
              v.title,
              '--body-file',
              file as string,
              ...labelArgs('--label', v.labels),
              ...(v.milestone ? ['--milestone', v.milestone] : [])
            ]
          })
        )
      )
    ),
    task_issue_edit: guarded(EditInput, (v) =>
      withBodyFile(v.body, async (file) =>
        issueOutcomeResult(
          await ops.editIssue({
            args: [
              String(v.issue),
              ...(v.title !== undefined ? ['--title', v.title] : []),
              ...(file !== null ? ['--body-file', file] : []),
              ...labelArgs('--add-label', v.addLabels)
            ]
          })
        )
      )
    ),
    task_issue_validate: guarded(ValidateInput, (v) =>
      withBodyFile(v.body, async (file) => {
        const common = [
          ...(v.title !== undefined ? ['--title', v.title] : []),
          '--body-file',
          file as string,
          ...labelArgs(v.mode === 'create' ? '--label' : '--add-label', v.labels)
        ]
        const outcome =
          v.mode === 'create'
            ? await ops.createIssue({ ghArgs: common, validateOnly: true })
            : await ops.editIssue({ args: [String(v.issue), ...common], validateOnly: true })
        return issueOutcomeResult(outcome)
      })
    ),
    task_issue_surface: guarded(SurfaceInput, (v) =>
      withBodyFile(v.body, (file) => {
        const outcome = ops.printIssueSurface(['--body-file', file as string])
        if (!outcome.ok) {
          return refused([
            finding(
              'issue-surface',
              outcome.message.trim(),
              "Fix the draft body's `## Surface` and Boundary pins, then call the tool again."
            )
          ])
        }
        return succeeded({ text: outcome.text, set: outcome.set })
      })
    ),
    task_objectives_edit: guarded(ObjectivesInput, async (v) => {
      const flags =
        v.op === 'add'
          ? ['--add', v.sentence, ...(v.part ? ['--part', v.part] : [])]
          : v.op === 'drop'
            ? ['--drop', v.id]
            : ['--replace', v.id, v.sentence]
      const outcome = await ops.editObjectives([String(v.issue), ...flags, '--reason', v.reason])
      if (!outcome.ok) return refused(outcome.findings.map(fromCheckError))
      return succeeded({ version: outcome.version, url: outcome.url, supersedeUrl: outcome.supersedeUrl })
    }),
    brief_render: guarded(BriefInput, async (v) => {
      const outcome = await ops.renderBrief({
        trancheSlug: v.tranche,
        taskId: v.id,
        ...(v.globs ? { globs: v.globs } : {})
      })
      if (!outcome.ok) {
        return refused(
          outcome.missing.length > 0
            ? outcome.missing.map((m) =>
                finding(
                  'brief-render',
                  `the brief cannot be rendered: ${m}`,
                  'Supply the missing fact in the task Issue, then render again.'
                )
              )
            : [finding('brief-render', 'the brief cannot be rendered', 'Check the task Issue, then render again.')]
        )
      }
      return succeeded({ brief: outcome.brief })
    })
  }
}
