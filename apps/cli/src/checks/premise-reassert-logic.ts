/**
 * Pure wiring for the `dispatch-readiness` check's optional `PREMISE_FILE`
 * re-assertion path (task 10, #59). No `fs` of its own — `body` (the
 * already-read file content, or `null` when the path could not be read) and
 * `fileReader` (the per-pin on-disk-content lookup `checkPremises` needs) are
 * both supplied by the caller, so this is unit-testable with plain string
 * fixtures alone. `check-dispatch-readiness.ts`'s bin is the thin wiring
 * that reads `process.env.PREMISE_FILE` and the real filesystem and calls
 * this — mirrors `evidence-fresh-logic.ts`'s split between pure decision
 * logic and a bin's `fs`/`gh` I/O.
 *
 * Consumes, never re-implements, `@attalabs/aeg-core`'s
 * `parsePremiseBlock`/`checkPremises` — the pin grammar and its three
 * assertion kinds are frozen (out of this task's surface). This module only
 * decides which `CheckError`s to emit for the three failure shapes
 * `packages/aeg-core/bin/verify-dispatch.ts --premise` already distinguishes:
 * an unreadable file, a file with zero pins, and one or more failed pins.
 */
import { checkPremises, parsePremiseBlock } from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, type CheckError } from './contract'

export type PremiseReassertResult = { pass: boolean; errors: CheckError[] }

/**
 * Re-asserts `PREMISE_FILE`'s `Premise:` pins.
 *
 * @param checkName the emitting check's name (`CheckError.check`), ALSO the
 *   command name every recovery prompt below tells the agent to re-run
 *   (`vinaya check <checkName>`) — passed in rather than hardcoded so this
 *   module stays free of any one check's identity. Two callers register
 *   under different names (`dispatch-readiness`'s `PREMISE_FILE` path,
 *   `pr-premise-reassert`'s PR-body path); a prompt naming the wrong one
 *   sends an agent to re-run a check that was never the one that failed.
 * @param premiseFilePath the `PREMISE_FILE` path, for error messages only.
 * @param body the file's already-read content, or `null` when it does not
 *   exist or could not be read.
 * @param fileReader resolves a pinned path's current on-disk content, or
 *   `null` when absent — the same shape `checkPremises` itself requires.
 */
export function reassertPremiseFile(
  checkName: string,
  premiseFilePath: string,
  body: string | null,
  fileReader: (path: string) => string | null
): PremiseReassertResult {
  if (body === null) {
    return {
      pass: false,
      errors: [
        {
          schema: CHECK_SCHEMA_VERSION,
          check: checkName,
          severity: 'error',
          message: `dispatch-gate premise: PREMISE_FILE "${premiseFilePath}" does not exist or is unreadable.`,
          agent_recovery_prompt: `Confirm the path passed via PREMISE_FILE is correct and readable, then re-run \`vinaya check ${checkName}\`.`
        }
      ]
    }
  }

  const assertions = parsePremiseBlock(body)
  if (assertions.length === 0) {
    return {
      pass: false,
      errors: [
        {
          schema: CHECK_SCHEMA_VERSION,
          check: checkName,
          severity: 'error',
          message: `dispatch-gate premise: PREMISE_FILE "${premiseFilePath}" carries no \`Premise:\` assertions — a premise file with no pins is a mistake, not a pass.`,
          agent_recovery_prompt: `Add a \`Premise:\` block with at least one \`contains\`/\`absent\`/\`sha256\` pin to the brief file, then re-run \`vinaya check ${checkName}\`.`
        }
      ]
    }
  }

  const result = checkPremises(assertions, fileReader)
  if (!result.pass) {
    return {
      pass: false,
      errors: result.failures.map((failure) => ({
        schema: CHECK_SCHEMA_VERSION,
        check: checkName,
        severity: 'error' as const,
        message: `dispatch-gate premise: ${failure}`,
        agent_recovery_prompt: `The surface moved since this brief was authored — re-dig the affected pin, correct the brief, and re-run \`vinaya check ${checkName}\` before continuing.`
      }))
    }
  }

  return { pass: true, errors: [] }
}
