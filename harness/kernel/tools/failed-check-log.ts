/** One failed check run on a head, with its own sanitized job-log tail — `null` when the log could not be read. */
export type FailedCheckLog = { check: string; runId: number; logTail: string | null }
