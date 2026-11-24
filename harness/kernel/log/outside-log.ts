import type { LogHandle } from '../../../packages/log-sdk/src/index.js'
import { runRecorder } from './run-recorder.js'

/** One outside action, as the Log records it: the action, its target, and success, failure or uncertain. */
export type ActionRecord = Parameters<LogHandle['action']['verified']>[0]
/** One command that finished, as the Log records it: the command, its target, its result and the error kind when there is one. */
export type CommandRecord = Parameters<LogHandle['command']['completed']>[0]
/** One forge write the gate checked or made: the action and its target. */
export type ForgeRecord = Parameters<LogHandle['forge']['validated']>[0]
/** One forge write the gate refused: the action, its target and why. */
export type ForgeRefusalRecord = Parameters<LogHandle['forge']['refused']>[0]

/** Where a record belongs when the process works for more than one task: the task a task tool acts on. */
export type RecordScope = { task?: number; runId?: string }

let warned = false

/** A Log that cannot be written gives one warning on stderr, never a different result for what it observes. */
function warnOnce(error: unknown): void {
  if (warned) return
  warned = true
  try {
    process.stderr.write(`vinaya: a record could not be written to the Log — ${String(error)}\n`)
  } catch {
    // A warning that cannot be written is not a failure of what it reports.
  }
}

/** Runs one write through the process's own run handle; recording off, or any failure to write, ends quietly or with the one warning. */
function through(scope: RecordScope | undefined, write: (log: LogHandle) => void): void {
  try {
    const handle = runRecorder().handle(
      scope?.runId,
      undefined,
      scope?.task === undefined ? undefined : String(scope.task)
    )
    if (handle !== undefined) write(handle)
  } catch (error) {
    warnOnce(error)
  }
}

/** One person the harness asks, as the Log records it: the kind, a key naming the question, why, the decision asked for and how to answer. */
export type PersonAskedRecord = Parameters<LogHandle['person']['asked']>[0]
/** One person's answer: the kind, the question's span id, the answer and who gave it. */
export type PersonAnsweredRecord = Parameters<LogHandle['person']['answered']>[0]

/** Writes one outside action's final outcome. */
export function writeAction(record: ActionRecord, scope?: RecordScope): void {
  through(scope, (log) => log.action.verified(record))
}

/** Writes one command that finished. */
export function writeCommand(record: CommandRecord, scope?: RecordScope): void {
  through(scope, (log) => log.command.completed(record))
}

/** Writes a forge write the gate checked and found sound. */
export function writeForgeValidated(record: ForgeRecord, scope?: RecordScope): void {
  through(scope, (log) => log.forge.validated(record))
}

/** Writes a forge write the gate refused, with why as a short code. */
export function writeForgeRefused(record: ForgeRefusalRecord, scope?: RecordScope): void {
  through(scope, (log) => log.forge.refused(record))
}

/** Writes a forge write that was made. */
export function writeForgeWritten(record: ForgeRecord, scope?: RecordScope): void {
  through(scope, (log) => log.forge.written(record))
}

/** Writes a person being asked; the question stays open in the run's local copy until a process answers it. */
export function writePersonAsked(record: PersonAskedRecord, scope?: RecordScope): void {
  through(scope, (log) => log.person.asked(record))
}

/** Writes a person's answer, from whichever process resolves the question; the Log finds the question in the run's local copy. */
export function writePersonAnswered(record: PersonAnsweredRecord, scope?: RecordScope): void {
  through(scope, (log) => log.person.answered(record))
}
