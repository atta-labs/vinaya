/** Shared Milestone status and close tools for the Architect and Tranche Archivist. */
import { z } from 'zod'
import { taskToolError } from '../../../../kernel/tools/catalog/task-tools'
import type { SeatCallResult, SeatHandler } from '../../../../kernel/tools/host/seat-host.js'
import type { McpToolListEntry } from '../../../../kernel/tools/mcp-protocol.js'
import { closeMilestone, milestoneStatus, type Refused } from './milestone-operations'

export const MILESTONE_TOOL_NAMES = ['milestone_status', 'milestone_close'] as const
export const milestoneNumber = z.string().regex(/^[0-9]+$/, 'a Milestone number is digits only')
export const validateOnly = z.boolean().default(false)

/** Preserve successes and all refusal findings, including partial-write diagnostics. */
export function milestoneOutcome(outcome: { ok: true } | Refused): SeatCallResult {
  if (outcome.ok) return { ok: true, result: outcome }
  const findings = outcome.findings.map((e) => ({
    check: e.check,
    message: e.message,
    recovery: e.agent_recovery_prompt
  }))
  if (outcome.partialWrite)
    findings.push({
      check: 'milestone-partial-write',
      message: outcome.partialWrite,
      recovery: 'Re-run the identical adoption to finish the idempotent writes.'
    })
  return {
    ok: false,
    error: taskToolError(
      'validation',
      findings[0]?.message ?? 'the operation was refused without a finding',
      JSON.stringify(findings)
    )
  }
}

/** Validate before effects; unexpected failures must not terminate the server. */
export function milestoneHandler<S extends z.ZodTypeAny>(
  schema: S,
  run: (input: z.infer<S>) => Promise<{ ok: true } | Refused>
): SeatHandler<unknown> {
  return async (input) => {
    const parsed = schema.safeParse(input ?? {})
    if (!parsed.success) {
      const findings = parsed.error.issues.map((e) => ({
        check: 'tool-input',
        message: `${e.path.join('.')}: ${e.message}`,
        recovery: 'Correct the tool input to match its schema, then call again.'
      }))
      return {
        ok: false,
        error: taskToolError('validation', findings[0]?.message ?? 'Invalid input', JSON.stringify(findings))
      }
    }
    try {
      return milestoneOutcome(await run(parsed.data))
    } catch (e) {
      return { ok: false, error: taskToolError('infrastructure', e instanceof Error ? e.message : String(e)) }
    }
  }
}

export const numberSchema = { type: 'string', pattern: '^[0-9]+$' } as const
export const validateOnlySchema = { type: 'boolean', default: false } as const
export const textSchema = { type: 'string', minLength: 1 } as const
export function milestoneEntry(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[]
): McpToolListEntry {
  return {
    name,
    description: `${description} Returns the library outcome; refusals carry every finding as {check, message, recovery} JSON in error.detail.`,
    inputSchema: { type: 'object', properties, required, additionalProperties: false }
  }
}

export const MILESTONE_TOOL_ENTRIES = [
  milestoneEntry(
    'milestone_status',
    'Read a Milestone and each declared tranche lifecycle. Writes nothing.',
    { number: numberSchema },
    ['number']
  ),
  milestoneEntry(
    'milestone_close',
    'Close a tranche Milestone after its attachment and lifecycle gates pass.',
    { slug: textSchema, validateOnly: validateOnlySchema },
    ['slug']
  )
]
export type SharedMilestoneOperations = {
  milestoneStatus: typeof milestoneStatus
  closeMilestone: typeof closeMilestone
}
export function milestoneToolHandlers(ops: SharedMilestoneOperations = { milestoneStatus, closeMilestone }) {
  return {
    milestone_status: milestoneHandler(z.object({ number: milestoneNumber }).strict(), (v) => ops.milestoneStatus(v)),
    milestone_close: milestoneHandler(z.object({ slug: z.string().min(1), validateOnly }).strict(), (v) =>
      ops.closeMilestone(v)
    )
  }
}
