import { prReportRefreshArgs } from '../../../apps/cli/src/lib/dev-review-loop'
import type { CliRun } from '../../../harness/gates/run-checks'

/**
 * The line `pr report --push <pr>` prints once the live pull request body was
 * updated. The CLI does not export it, so a test reads the `pr report` source
 * and fails if its wording drifts from this one.
 */
export const pushedEvidenceMarker = (prNumber: number): string => `Pushed AEG:EVIDENCE block to PR ${prNumber}`

/** What refreshing the Evidence block needs; every forge, git and CLI reach is injected. */
export interface RefreshEvidenceDeps {
  cliEntry: string
  worktreePath: string
  /** The open pull request's number; throws when there is none. */
  prNumber: () => number
  readHead: (worktreePath: string) => string | null
  runCli: (cliEntry: string, cwd: string, args: readonly string[]) => CliRun
}

/**
 * Regenerates the pull request body's Evidence block for the worktree's head and
 * writes it back, as `pr report --push <pr>` in the worktree, the way the
 * standalone loop's `refresh_evidence` does. A non-zero exit alone is not a
 * failure (`pr report` exits non-zero on a red gate after pushing); it throws
 * only when the push marker is missing, so nothing reached the forge.
 */
export function refreshPrEvidence(deps: RefreshEvidenceDeps): {
  head: string
  checksPassed: boolean
  evidence: string
} {
  const prNumber = deps.prNumber()
  const res = deps.runCli(deps.cliEntry, deps.worktreePath, prReportRefreshArgs(prNumber))
  const output = `${res.stdout}${res.stderr}`
  let head = ''
  try {
    head = deps.readHead(deps.worktreePath) ?? ''
  } catch {
    head = ''
  }
  if (!res.stdout.includes(pushedEvidenceMarker(prNumber)))
    throw new Error(`pr report --push ${prNumber} failed:\n${output}`)
  return { head, checksPassed: res.status === 0, evidence: output }
}
