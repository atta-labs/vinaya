import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import type { StepNodeResult } from '@atta/executor-agent-spawn'
import { type CheckpointCommit, type CheckpointProvenance, SqliteCheckpointer } from './sqlite-checkpointer'

// The execution round as checkpoint authority, and the agent in checkpoint provenance. Other runner code reads the
// execution round and the recorded agent through these functions and never changes the checkpoint format itself.
//
// The execution round lives in the result of the step that advances it, under the graph's existing `results`
// channel (the executor's state schema is fixed, so there is no top-level field): a mechanical step carries it in its
// `stderr`, which no reader of the step's own `stdout` sees and which the executor's narrowing keeps whole. Recovery reads it from the
// effective resumed state, which includes the pending writes LangGraph keeps apart from full checkpoints, never
// from the last full checkpoint's results alone.

/** The vendor a run was started with. A checkpoint is only ever resumed on the same one. */
export type CheckpointAgent = 'claude' | 'codex'

/** The execution round as the advancing step records it inside its own result. */
export interface ExecutionRoundRecord {
  /** The round the run is in once this step has completed. */
  round: number
  /** The step id that advanced the round; nothing else increments it. */
  advancedBy: string
}

/** The results a run would continue from on resume: the last full checkpoint plus its committed pending writes. */
export interface EffectiveResumedState {
  results: Readonly<Record<string, StepNodeResult>>
  /** The checkpoint id these results were read at, for the control-store mirror's key. */
  checkpointId: string
}

/** Checkpoint provenance including the agent; `agent` is null on a checkpoint written before it was recorded. */
export interface AgentCheckpointProvenance extends CheckpointProvenance {
  agent: CheckpointAgent | null
}

/** The control-store mirror of the execution round, written after the checkpoint commits. The checkpoint wins. */
export interface ExecutionRoundMirror {
  repository: string
  task: number
  threadId: string
  checkpointId: string
  round: number
}

const isAgent = (value: unknown): value is CheckpointAgent => value === 'claude' || value === 'codex'

/** Encodes `record` into the advancing step's `stderr`, so the executor stores it under `results` with the step. */
export function encodeExecutionRound(record: ExecutionRoundRecord): string {
  if (!Number.isInteger(record.round) || record.round < 1) throw new Error(`not an execution round: ${record.round}`)
  return JSON.stringify({ executionRound: { round: record.round, advancedBy: record.advancedBy } })
}

/** The execution round one step's recorded output carries, or null when it carries none. */
export function decodeExecutionRound(text: string): ExecutionRoundRecord | null {
  if (!text.startsWith('{"executionRound"')) return null
  try {
    const parsed = (JSON.parse(text) as { executionRound?: { round?: unknown; advancedBy?: unknown } }).executionRound
    return typeof parsed?.round === 'number' &&
      Number.isInteger(parsed.round) &&
      parsed.round >= 1 &&
      typeof parsed.advancedBy === 'string'
      ? { round: parsed.round, advancedBy: parsed.advancedBy }
      : null
  } catch {
    return null
  }
}

/**
 * The execution round recorded in `state`, or null when no step has recorded one yet. The round never moves back, so
 * of the records the steps carry, the highest is the one the run is in.
 */
export function readExecutionRound(state: Pick<EffectiveResumedState, 'results'>): ExecutionRoundRecord | null {
  let found: ExecutionRoundRecord | null = null
  for (const result of Object.values(state.results)) {
    if (result === null || typeof result !== 'object' || result.kind !== 'mechanical') continue
    const record = typeof result.stderr === 'string' ? decodeExecutionRound(result.stderr) : null
    if (record !== null && (found === null || record.round > found.round)) found = record
  }
  return found
}

/** The effective resumed state of `threadId` on an open saver, pending writes included; null with no checkpoint. */
export async function readEffectiveResumedStateFrom(
  saver: Pick<SqliteCheckpointer, 'effectiveResults'>,
  threadId: string
): Promise<EffectiveResumedState | null> {
  const effective = await saver.effectiveResults(threadId)
  if (effective === undefined) return null
  return { checkpointId: effective.checkpointId, results: effective.results as Record<string, StepNodeResult> }
}

/** Reads the effective resumed state of `threadId`, pending writes included; throws when it has no checkpoint. */
export async function readEffectiveResumedState(
  checkpointPath: string,
  threadId: string
): Promise<EffectiveResumedState> {
  const saver = new SqliteCheckpointer({ path: checkpointPath, revision: 'unknown' })
  try {
    const state = await readEffectiveResumedStateFrom(saver, threadId)
    if (state === null) throw new Error(`the checkpoint file ${checkpointPath} holds no checkpoint of ${threadId}`)
    return state
  } finally {
    saver.close()
  }
}

/**
 * Writes the control-store mirror once the saver's database write has succeeded, through `write` (the control
 * store's own writer). A failure throws: it is a required write, and the caller pauses progression without
 * re-running the committed transition.
 */
export function writeExecutionRoundMirror(
  mirror: ExecutionRoundMirror,
  write: (mirror: ExecutionRoundMirror) => void
): void {
  write(mirror)
}

/**
 * The saver's `onCommit` that mirrors the execution round: after each committed write that carries a round other
 * than the one last mirrored for its thread, it writes the mirror. A failed write throws to the saver, which keeps
 * it for the run's persistence barrier.
 */
export function mirrorExecutionRoundOnCommit(
  identity: { repository: string; task: number },
  write: (mirror: ExecutionRoundMirror) => void
): (commit: CheckpointCommit) => void {
  const mirrored = new Map<string, number>()
  return (commit) => {
    const record = readExecutionRound({ results: commit.results as Record<string, StepNodeResult> })
    if (record === null || mirrored.get(commit.threadId) === record.round) return
    writeExecutionRoundMirror(
      { ...identity, threadId: commit.threadId, checkpointId: commit.checkpointId, round: record.round },
      write
    )
    mirrored.set(commit.threadId, record.round)
  }
}

/**
 * The provenance of the latest checkpoint of `threadId`, including the agent it was started with; null when the file
 * or the thread has no checkpoint. Read-only: a file written before the agent was recorded is read as it stands, its
 * agent null, and is never migrated by the read.
 */
export function readAgentProvenance(checkpointPath: string, threadId: string): AgentCheckpointProvenance | null {
  if (!existsSync(checkpointPath)) return null
  const db = new Database(checkpointPath, { readonly: true })
  try {
    const columns = new Set(
      db
        .query<{ name: string }, []>('PRAGMA table_info(checkpoints)')
        .all()
        .map((column) => column.name)
    )
    if (columns.size === 0) return null
    const optional = (name: string) => (columns.has(name) ? name : `NULL AS ${name}`)
    const row = db
      .query<
        {
          revision: string
          model: string
          format_version: number | null
          runtime_version: string | null
          agent: string | null
        },
        [string]
      >(
        `SELECT revision, model, ${optional('format_version')}, ${optional('runtime_version')}, ${optional('agent')}
         FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = '' ORDER BY checkpoint_id DESC LIMIT 1`
      )
      .get(threadId)
    if (!row) return null
    return {
      revision: row.revision,
      model: row.model,
      formatVersion: row.format_version,
      runtimeVersion: row.runtime_version,
      agent: isAgent(row.agent) ? row.agent : null
    }
  } finally {
    db.close()
  }
}
