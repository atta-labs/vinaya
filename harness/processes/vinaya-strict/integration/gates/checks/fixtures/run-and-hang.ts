#!/usr/bin/env bun
// Fixture: a tiny wrapper CLI around `runChecks`, used to test the runner's
// own SIGINT/SIGTERM forwarding from OUTSIDE the test process itself (so
// sending the signal doesn't kill the test runner too). Starts a check that
// sleeps far longer than this script will be allowed to live, then just
// awaits it — the only way it ever exits is via the signal-forwarding path
// under test, or the 60s ceiling neither test should ever reach. An optional
// first argument names a file, handed on to the sleeping check, which appends
// its own identity (pid and start time) to it once it is running.
import { join } from 'node:path'
import { installVinayaLogSinkFactory } from '../../../log/log-sink-factory'
import { runChecks } from '../../../../../../kernel/gates/checks/runner'
import { installVinayaConfigProvider } from '../../../config/compose'

// This program is its own composition root: the runner's log sink reads
// configuration only through the provider one installs.
installVinayaConfigProvider()

const SLEEPER = join(import.meta.dir, '../../../../../../kernel/gates/checks/fixtures/sleeper.ts')

// An entry point, as `vinaya check` is: the runner's gate lines go through the default sink.
installVinayaLogSinkFactory()

const pidFile = process.argv[2]

await runChecks(
  [{ name: 'hang', run: SLEEPER, args: ['60000', ...(pidFile === undefined ? [] : [pidFile])], scope: 'full' }],
  {
    parallel: 1,
    diffOnly: false,
    changedFiles: null,
    defaultTimeoutMs: 60_000
  }
)
