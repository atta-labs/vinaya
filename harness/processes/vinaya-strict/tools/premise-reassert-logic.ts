/**
 * Pure wiring for the `dispatch-readiness` check's optional `PREMISE_FILE`
 * re-assertion path. No `fs` of its own — `body` (the
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
 * `harness/processes/vinaya-strict/checks/standalone/verify-dispatch.ts --premise` already distinguishes:
 * an unreadable file, a file with zero pins, and one or more failed pins.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { sep } from 'node:path'
import { checkPremises, parsePremiseBlock } from './task-contract/premise-check'
import { CHECK_SCHEMA_VERSION, type CheckError } from '../../../kernel/gates/checks/contract'
import { containedAbs } from '../../../kernel/gates/ops'

const CHECK_NAME = 'pr-premise-reassert'

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
          agent_recovery_prompt: `Confirm the path passed via PREMISE_FILE is correct and readable, then re-run \`vinaya-check ${checkName}\`.`
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
          agent_recovery_prompt: `Add a \`Premise:\` block with at least one \`contains\`/\`absent\`/\`sha256\` pin to the brief file, then re-run \`vinaya-check ${checkName}\`.`
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
        agent_recovery_prompt: `The surface moved since this brief was authored — re-dig the affected pin, correct the brief, and re-run \`vinaya-check ${checkName}\` before continuing.`
      }))
    }
  }

  return { pass: true, errors: [] }
}

/**
 * `containedAbs(root, p)`, then re-verified through the REAL (symlink-
 * resolved) path — the identical escape-closing shape
 * `check-dispatch-readiness.ts`'s own `containedRealPath` uses for the same
 * reason: a pin's `path` field comes from the frozen `parsePremiseBlock`
 * grammar, which imposes no containment of its own, and a PR body is
 * PR-author-controlled content on that same PR's own branch checkout.
 */
function containedRealPath(root: string, p: string): string | null {
  const abs = containedAbs(root, p)
  if (abs === null) return null
  try {
    const real = realpathSync(abs)
    const realRoot = realpathSync(root)
    return real === realRoot || real.startsWith(realRoot + sep) ? real : null
  } catch {
    return null
  }
}

function defaultFileReader(p: string): string | null {
  const real = containedRealPath(process.cwd(), p)
  if (real === null) return null
  try {
    return readFileSync(real, 'utf8')
  } catch {
    return null
  }
}

/**
 * `null` means "no `Premise:` block in this body — nothing to reassert",
 * the O3 silent case. A non-null result is `reassertPremiseFile`'s own
 * verdict over the pins the body actually carries.
 *
 * `fileReader` defaults to the real, cwd-rooted, symlink-safe reader — real
 * callers (`main()` below) never pass a second argument. Tests inject a
 * fixture map instead of the real filesystem, the same way
 * `premise-reassert-logic.test.ts` tests `reassertPremiseFile` directly: the
 * real reader is `process.cwd()`-relative, which is the repo root when
 * `vinaya check` spawns this bin for real (no chdir — see
 * `check-dispatch-readiness.ts`'s identical reasoning) but is this PACKAGE's
 * own root when a monorepo test runner invokes `apps/cli`'s `bun test`
 * directly — a real-filesystem-dependent test would pass or fail by which of
 * those happened to be cwd, not by what this function does.
 */
export function reassertPrBodyPremise(
  prBody: string,
  fileReader: (path: string) => string | null = defaultFileReader
): PremiseReassertResult | null {
  const assertions = parsePremiseBlock(prBody)
  if (assertions.length === 0) return null

  // Delegates to the frozen pair for the actual re-assertion. Routed through
  // `reassertPremiseFile` (not `checkPremises` directly) so the emitted
  // `CheckError` shape/wording matches the existing `PREMISE_FILE` caller
  // exactly — one message format for "a pin failed", not two.
  return reassertPremiseFile(CHECK_NAME, 'PR body', prBody, fileReader)
}
