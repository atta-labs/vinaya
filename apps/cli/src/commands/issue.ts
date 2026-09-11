import { findTrancheSlug, isTaskIssueLabelSet } from '@attalabs/aeg-core'
import { printJson } from '../lib/envelope'
import {
  type BodyResult,
  ForgeArgError,
  ensureTrancheLabelExists,
  extractLabels,
  extractTitle,
  fetchForgeLabels,
  locateBody,
  makeCheckError,
  parseIssueNumberFromRef,
  refuse,
  refuseFrozenSectionChange,
  refuseUnlabeledTaskShapedBody,
  resolveMilestoneAttachArgs,
  runGhWrite,
  validateTaskIssue,
  writeValidatedIssueEdit
} from '../lib/forge-write'

export { parseIssueNumberFromRef } from '../lib/forge-write'

const RETRY_CREATE = 'vinaya issue create --validate-only …'
const RETRY_EDIT = 'vinaya issue edit <n> --validate-only …'

function locateBodyOrRefuse(ghArgs: string[], retryCommand: string): BodyResult | null {
  try {
    return locateBody(ghArgs)
  } catch (e) {
    if (e instanceof ForgeArgError) {
      refuse([makeCheckError('forge-args', e.message, `Fix the invocation, then re-run \`${retryCommand}\`.`)])
    }
    throw e
  }
}

function reportPass(json: boolean, command: string): void {
  if (json) {
    printJson({ validated: true, written: false, command })
  } else {
    process.stdout.write('✓ all brief-schema gates PASS — nothing written (--validate-only).\n')
  }
}

// --- commands ----------------------------------------------------------------

export function issueCreateCommand(args: string[]): void {
  const json = args.includes('--json')
  const validateOnly = args.includes('--validate-only')
  const ghArgs = args.filter((a) => a !== '--json' && a !== '--validate-only')

  const bodyResult = locateBodyOrRefuse(ghArgs, RETRY_CREATE)
  const body = bodyResult?.body ?? null
  const title = extractTitle(ghArgs)
  const labels = extractLabels(ghArgs)

  refuseUnlabeledTaskShapedBody(body, labels, RETRY_CREATE)

  if (isTaskIssueLabelSet(labels)) {
    // No number exists until the write completes — `checkIssueObjectives`
    // treats `null` as NOT exempted (fail-closed), never as "old enough to
    // skip"; every Issue this repo can newly mint is already far past
    // `OBJECTIVES_SINCE_ISSUE`, so this never blocks a legitimate create.
    validateTaskIssue(body, title, labels, RETRY_CREATE, null, { kind: 'create', ghArgs })
  }

  if (validateOnly) {
    reportPass(json, 'issue create')
    return
  }

  const slugToEnsure = findTrancheSlug(labels)
  if (slugToEnsure) ensureTrancheLabelExists(slugToEnsure)

  runGhWrite(['issue', 'create'], resolveMilestoneAttachArgs(ghArgs, labels), bodyResult, json)
}

export function issueEditCommand(args: string[]): void {
  const json = args.includes('--json')
  const validateOnly = args.includes('--validate-only')
  const rest = args.filter((a) => a !== '--json' && a !== '--validate-only')

  const issueRef = rest[0]
  if (!issueRef || issueRef.startsWith('-')) {
    refuse([
      makeCheckError(
        'forge-args',
        '`issue edit` requires the target Issue number/URL as the first argument.',
        'Pass the Issue number, e.g. `vinaya issue edit 123 --body-file <path>`.'
      )
    ])
  }
  const ghArgs = rest.slice(1)

  const bodyResult = locateBodyOrRefuse(ghArgs, RETRY_EDIT)

  if (validateOnly) {
    const body = bodyResult?.body ?? null
    const title = extractTitle(ghArgs)
    // Union the forge's real labels with any passed on argv — argv is
    // normally silent on edit, so the forge is what decides task-Issue
    // applicability.
    const labels = [...new Set([...fetchForgeLabels(issueRef, RETRY_EDIT), ...extractLabels(ghArgs)])]
    refuseUnlabeledTaskShapedBody(body, labels, RETRY_EDIT)
    if (isTaskIssueLabelSet(labels)) {
      refuseFrozenSectionChange(issueRef, body, RETRY_EDIT)
      validateTaskIssue(body, title, labels, RETRY_EDIT, parseIssueNumberFromRef(issueRef), {
        kind: 'edit',
        issueRef
      })
    }
    reportPass(json, 'issue edit')
    return
  }

  writeValidatedIssueEdit({ issueRef, ghArgs, bodyResult, json, retryCommand: RETRY_EDIT })
}
