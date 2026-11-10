import { printJson } from '../../../../harness/kernel/effects/envelope'
import { emitCheckError } from '../../../../harness/kernel/gates/checks/contract'
import { editObjectives } from '../../../../harness/processes/vinaya-strict/thinking/planner/tools/planner-operations'

export {
  appendPartLine,
  fetchIssueBodyAndComments,
  removePartLinesCitingOnly,
  spliceObjectivesSection,
  withoutObjectivesSection
} from '../../../../harness/processes/vinaya-strict/thinking/planner/tools/planner-operations'

/** `vinaya issue objectives edit` — argv, one library call, printing. */
export async function issueObjectivesEditCommand(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const outcome = await editObjectives(
    args.filter((a) => a !== '--json'),
    { warning: emitCheckError }
  )
  if (!outcome.ok) {
    for (const e of outcome.findings) emitCheckError(e)
    process.exit(1)
  }
  if (json) printJson({ written: true, version: outcome.version, url: outcome.url, supersedeUrl: outcome.supersedeUrl })
  else {
    process.stdout.write(`${outcome.url}\n`)
    if (outcome.supersedeUrl) process.stdout.write(`${outcome.supersedeUrl}\n`)
  }
}

import type { SurfaceExemption } from '../../../../harness/processes/vinaya-strict/tools/pr-report/surface-exemption'

export const SURFACE_EXEMPTIONS: Record<string, SurfaceExemption> = {
  'issue objectives edit': { date: '2026-09-14', callsToday: 12, retiresVia: 'forgeWrite' }
}
