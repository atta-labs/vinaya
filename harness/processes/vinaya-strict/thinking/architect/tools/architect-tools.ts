/** Architect-only Milestone tools; status and close live in the shared folder. */
import { z } from 'zod'
import {
  createMilestone,
  editMilestone,
  deleteMilestone,
  adoptMilestone
} from '../../../tools/milestone/milestone-operations'
import {
  milestoneHandler,
  milestoneEntry,
  milestoneNumber,
  validateOnly,
  numberSchema,
  textSchema,
  validateOnlySchema
} from '../../../tools/milestone/milestone-tools'

export const ARCHITECT_TOOL_NAMES = [
  'milestone_create',
  'milestone_edit',
  'milestone_delete',
  'milestone_adopt'
] as const
export const ARCHITECT_TOOL_ENTRIES = [
  milestoneEntry(
    'milestone_create',
    'Create a validated product-goal Milestone.',
    { title: textSchema, body: textSchema, validateOnly: validateOnlySchema },
    ['title', 'body']
  ),
  milestoneEntry(
    'milestone_edit',
    'Edit a Milestone description through the same validation as create.',
    { number: numberSchema, body: textSchema, validateOnly: validateOnlySchema },
    ['number', 'body']
  ),
  milestoneEntry(
    'milestone_delete',
    'Delete an empty Milestone. Refuses missing Milestones and names every attached Issue and pull request. No CLI fallback.',
    { number: numberSchema },
    ['number']
  ),
  milestoneEntry(
    'milestone_adopt',
    'Adopt existing tranches after validating the entire batch.',
    { target: textSchema, slugs: { type: 'array', items: textSchema, minItems: 1 }, validateOnly: validateOnlySchema },
    ['target', 'slugs']
  )
]
export type ArchitectOperations = {
  createMilestone: typeof createMilestone
  editMilestone: typeof editMilestone
  deleteMilestone: typeof deleteMilestone
  adoptMilestone: typeof adoptMilestone
}
export function architectToolHandlers(
  ops: ArchitectOperations = { createMilestone, editMilestone, deleteMilestone, adoptMilestone }
) {
  return {
    milestone_create: milestoneHandler(
      z.object({ title: z.string().min(1), body: z.string().min(1), validateOnly }).strict(),
      (v) => ops.createMilestone(v)
    ),
    milestone_edit: milestoneHandler(
      z.object({ number: milestoneNumber, body: z.string().min(1), validateOnly }).strict(),
      (v) => ops.editMilestone(v)
    ),
    milestone_delete: milestoneHandler(z.object({ number: milestoneNumber }).strict(), (v) => ops.deleteMilestone(v)),
    milestone_adopt: milestoneHandler(
      z.object({ target: z.string().min(1), slugs: z.array(z.string().min(1)).min(1), validateOnly }).strict(),
      (v) => ops.adoptMilestone(v)
    )
  }
}
