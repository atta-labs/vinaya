#!/usr/bin/env bun
/**
 * This repository's read recorder: on a push to the default branch, records every scheduled test file through the
 * selection package's recorder (`recordReads` and `recordCommand` of `@attalabs/test-selection`), the same code a
 * consumer's `test-selection-record` command runs. It injects everything that decides this repository's record
 * (`REPOSITORY_RECORDER`): its inventory reader (`readTestInventory`), its scheduler's runner launch (`runnerLaunch`),
 * run-outcome check (`groupOutcomeOf`, which reads the junit or Vitest report the launch asks the runner to write, so
 * a test is recorded only when its report says it passed) and per-run time limit (`GROUP_TIME_LIMIT_MS`), and
 * `bun.lock` as the input installed dependencies derive from.
 *
 * The record (schema version 2: each test's reads and listed folders, how many times its own process opened each
 * read and which reads a child process opened, and, for a Bun run, its line coverage per source file) is the
 * selection's input for later changes (`scripts/test-suites/read-records.ts` fetches it by
 * commit). A test file that does not pass while it is recorded gets no record, so its selection stays static. The
 * recorder is outside the required `Vinaya CI` aggregate: a failure here never blocks a merge.
 *
 *   bun scripts/ci/record-reads.ts --out <dir> [--commit <sha>] [--concurrency <n>] [--shard <i>/<n>] [--only <test,test>] [--expect <test>=<path>] [--summary <file>]
 *   bun scripts/ci/record-reads.ts --merge <dir> --out <dir> [--commit <sha>] [--summary <file>]
 */
import {
  type ReadRecord,
  type RecordCommandOptions,
  type RecorderSetup,
  type RecordSummary,
  recordCommand,
  recordReads as recordThroughPackage,
  type Shard
} from '@attalabs/test-selection'
import { readTestInventory } from '../test-suites/inventory-check.js'
import { GROUP_TIME_LIMIT_MS, groupOutcomeOf, runnerLaunch } from '../test-suites/schedule.js'

/** Everything that decides this repository's record, handed to the package's recorder. */
export const REPOSITORY_RECORDER: Required<RecorderSetup> = {
  inventory: (repoRoot, commit) => readTestInventory(repoRoot, { head: commit }).head,
  launch: runnerLaunch,
  outcome: groupOutcomeOf,
  timeLimitMs: GROUP_TIME_LIMIT_MS,
  dependencyInput: 'bun.lock'
}

/** The command's own name and usage, unchanged by the move into the package. */
export const REPOSITORY_COMMAND: RecordCommandOptions = {
  ...REPOSITORY_RECORDER,
  name: 'vinaya record-reads',
  usage:
    'usage: record-reads.ts --out <dir> [--commit <sha>] [--concurrency <n>] [--shard <i>/<n>] [--only <test,test>] [--summary <file>]\n' +
    '       record-reads.ts --merge <dir> --out <dir> [--commit <sha>] [--summary <file>]\n'
}

/** Records every test (or `only`) of the commit checked out at `repoRoot`, as this repository's CI does. */
export async function recordReads(options: {
  repoRoot: string
  commit: string
  concurrency: number
  only?: readonly string[]
  shard?: Shard
  log?: (line: string) => void
}): Promise<{ record: ReadRecord; summary: RecordSummary }> {
  return recordThroughPackage({ ...options, ...REPOSITORY_RECORDER, name: REPOSITORY_COMMAND.name })
}

if (import.meta.main) process.exitCode = await recordCommand(process.argv.slice(2), REPOSITORY_COMMAND)
