import type { VerdictObservation } from '@attalabs/aeg-core'
import { LOG_FOLDER_ONLY_ENV } from '../../../apps/cli/src/lib/log-sink'
import { RUNTIME_DIR_ENV_KEY, resetRuntimeDirCache } from '../../../apps/cli/src/lib/run-paths'

// Recorded results the round's deciding steps read, for tests that replace the steps that would write them.

/** A completed Developer turn result whose confidence clears the assessment's threshold. */
export const confidentTurn = {
  turnResult: {
    schemaVersion: 1,
    status: 'completed',
    summary: 'Done.',
    confidence: 90,
    confidenceExplanation: 'Stub result.',
    addressedFindingIds: [],
    sourceUses: [],
    reportedChecks: null
  }
}

/** The stdout lines a vendor's CLI prints for one turn whose structured result is `output`. */
export function vendorLines(agent: 'claude' | 'codex' | 'claude-code', output: unknown): string[] {
  return agent === 'codex'
    ? [
        '{"type":"thread.started","thread_id":"s"}',
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(output) } }),
        '{"type":"turn.completed"}'
      ]
    : [
        '{"type":"system","session_id":"s"}',
        JSON.stringify({ type: 'result', session_id: 's', structured_output: output })
      ]
}

/** The reviewer-output step's result for a round whose two verdicts were held. */
export function heldReviews(
  round: number,
  verdicts: readonly VerdictObservation[],
  rendered = 'rendered verdict'
): { exitCode: number; stdout: string } {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      round,
      attempt: 1,
      next: 'hold',
      accepted: {
        reviewer: { observation: verdicts[0], rendered },
        security: { observation: verdicts[1], rendered }
      },
      events: [],
      decision: { type: 'hold' }
    })
  }
}

/** The environment a scenario run sets, so a test restores it afterwards. */
export const SCENARIO_ENV_KEYS: readonly string[] = [RUNTIME_DIR_ENV_KEY, LOG_FOLDER_ONLY_ENV]

/** Points the control-store writers at `dir`, or clears the cached runtime directory when null. */
export function useRuntimeDir(dir: string | null): void {
  if (dir !== null) process.env[RUNTIME_DIR_ENV_KEY] = dir
  resetRuntimeDirCache()
}

/** Keeps every Log event a run writes in its local folder. */
export function keepLogLocal(): void {
  process.env[LOG_FOLDER_ONLY_ENV] = '1'
}
