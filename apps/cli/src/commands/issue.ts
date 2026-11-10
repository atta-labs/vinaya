import { printJson } from '../../../../harness/kernel/effects/envelope'
import { emitCheckError } from '../../../../harness/kernel/gates/checks/contract'
import {
  type IssueWriteOutcome,
  createIssue,
  editIssue,
  printIssueSurface
} from '../../../../harness/processes/vinaya-strict/thinking/planner/tools/planner-operations'

export { parseIssueNumberFromRef } from '../../../../harness/processes/vinaya-strict/tools/task-contract/forge/forge-write'

const io = {
  warning: emitCheckError,
  notice: (text: string) => {
    process.stderr.write(text)
  }
}

/**
 * The plan-time result. `renderSkipped` non-null means the brief render
 * never ran (no template/repo/work-tree, a tranche create whose title yields no
 * task id, or a tranche edit whose Issue is not yet in the derived task list):
 * the output then reports the skip and its cause rather than a clean pass, so a
 * pass is never claimed for a render that did not happen. The schema/content
 * gates that DID run still passed, which the line says plainly.
 */
function reportPass(json: boolean, command: string, renderSkipped: string | null = null): void {
  if (json) {
    printJson({
      validated: true,
      written: false,
      briefRenderRan: renderSkipped === null,
      ...(renderSkipped !== null ? { briefRenderSkipReason: renderSkipped } : {}),
      command
    })
  } else if (renderSkipped !== null) {
    process.stdout.write(
      `⚠ brief-schema gates PASS, but the brief render was SKIPPED (${renderSkipped}) — NOT a full plan-time pass; \`vinaya task run\` may still refuse this Issue at brief render. Nothing written (--validate-only).\n`
    )
  } else {
    process.stdout.write('✓ all brief-schema gates PASS — nothing written (--validate-only).\n')
  }
}

/** Prints an Issue-write outcome exactly as the command always has: a refusal as findings and exit 1, a failed `gh` write as its raw error, a pass as the link (or the validate-only report). */
function printOutcome(outcome: IssueWriteOutcome, json: boolean, validateOnly: boolean, command: string): void {
  if (!outcome.ok) {
    if (outcome.forgeError !== undefined) throw outcome.forgeError
    for (const e of outcome.findings) emitCheckError(e)
    process.exit(1)
  }
  if (validateOnly) {
    reportPass(json, command, outcome.renderSkipped)
    return
  }
  if (json) printJson({ validated: true, written: true, url: outcome.url })
  else if (outcome.url) process.stdout.write(`${outcome.url}\n`)
}

// --- commands ----------------------------------------------------------------

export async function issueCreateCommand(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const validateOnly = args.includes('--validate-only')
  const ghArgs = args.filter((a) => a !== '--json' && a !== '--validate-only')
  printOutcome(await createIssue({ ghArgs, validateOnly }, io), json, validateOnly, 'issue create')
}

export async function issueEditCommand(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const validateOnly = args.includes('--validate-only')
  const rest = args.filter((a) => a !== '--json' && a !== '--validate-only')
  printOutcome(await editIssue({ args: rest, validateOnly }, io), json, validateOnly, 'issue edit')
}

/**
 * `vinaya issue surface --body-file <path>` — prints what a draft Issue's
 * Boundary pins force on its Surface. Writes nothing.
 * Exits 0 with the report, or 2 when the body cannot be read or its
 * `## Surface` does not parse.
 */
export function issueSurfaceCommand(args: string[]): void {
  const outcome = printIssueSurface(args)
  if (!outcome.ok) {
    process.stderr.write(outcome.message)
    process.exit(outcome.exitCode)
  }
  if (outcome.json) printJson(outcome.set)
  else process.stdout.write(outcome.text)
}
