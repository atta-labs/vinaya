import type { StepNodeResult } from '@atta/executor-agent-spawn'
import type { CheckpointProvenance } from './sqlite-checkpointer'

// Owner: agent A (the execution round as checkpoint authority; the agent in checkpoint provenance).
// Shared interface only: types and stubs, no behaviour yet. Other agents read the execution round and the
// recorded agent through these functions and never change the checkpoint format themselves.
//
// The execution round lives in the result of the step that advances it, under the graph's existing `results`
// channel (the executor's state schema is fixed, so there is no top-level field). Recovery reads it from the
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

function notImplemented(name: string): never {
  throw new Error(`${name}: not implemented`)
}

/** Encodes `record` into the advancing step's stdout so the executor stores it under `results`. */
export function encodeExecutionRound(_record: ExecutionRoundRecord): string {
  return notImplemented('encodeExecutionRound')
}

/** The execution round recorded in `state`, or null when no step has advanced it yet. */
export function readExecutionRound(_state: EffectiveResumedState): ExecutionRoundRecord | null {
  return notImplemented('readExecutionRound')
}

/** Reads the effective resumed state of `threadId`, pending writes included. */
export function readEffectiveResumedState(_checkpointPath: string, _threadId: string): Promise<EffectiveResumedState> {
  return notImplemented('readEffectiveResumedState')
}

/**
 * Writes the control-store mirror once the saver's database write has succeeded. A failure throws: it is a
 * required write, and the caller pauses progression without re-running the committed transition.
 */
export function writeExecutionRoundMirror(_mirror: ExecutionRoundMirror): void {
  notImplemented('writeExecutionRoundMirror')
}

/** The provenance of the latest checkpoint of `threadId`, including the agent it was started with. */
export function readAgentProvenance(_checkpointPath: string, _threadId: string): AgentCheckpointProvenance | null {
  return notImplemented('readAgentProvenance')
}
