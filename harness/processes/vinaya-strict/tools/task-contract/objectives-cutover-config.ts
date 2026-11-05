import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `vinaya.config.json`'s `gateCutovers.objectivesSinceIssue` — the Objectives
 * gate's cutover, read as plain JSON because aeg-core cannot depend on
 * `apps/cli`'s zod resolver (`resolveGateCutovers`). Kept impure and OUT of
 * `gate-cutovers.ts` (which is deliberately pure — the caller resolves config
 * and passes the value in); the two aeg-core authoring bins (`open-issue.ts`,
 * `verify-brief.ts`) ARE such callers and share this one reader rather than
 * each declaring their own (the symbol-collision gate refuses a name that
 * resolves to two source files).
 *
 * `null` for an absent key OR a malformed/missing config: NO cutover, so the
 * Objectives gate applies to every task Issue, from Issue 1 (a repository that
 * declares no `gateCutovers`, O1). This repository restates its historical
 * value in its own config (O2), so this returns `404` here and the gate is
 * unchanged. `repoRoot` defaults to the current working directory; a caller
 * that has not `chdir`'d to the repo root passes it explicitly.
 */
export function readConfigObjectivesSinceIssue(repoRoot = '.'): number | null {
  try {
    const raw = JSON.parse(readFileSync(join(repoRoot, 'vinaya.config.json'), 'utf8')) as {
      gateCutovers?: { objectivesSinceIssue?: unknown }
    }
    const value = raw.gateCutovers?.objectivesSinceIssue
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
  } catch {
    return null
  }
}
