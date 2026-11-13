#!/usr/bin/env bun
// Fixture: spawns a SIGTERM-trapping grandchild (stubborn-sleeper.ts), then
// hangs itself WITHOUT trapping SIGTERM. Proves the runner's SIGKILL
// escalation still reaches a grandchild that outlives the DIRECT child's
// own close — this process dies fast on the group's initial SIGTERM (no
// handler), while the grandchild (which ignores SIGTERM) does not, and can
// only be reaped by the awaited escalation. An optional first argument names
// a file: this fixture appends its own identity (pid and start time) to it
// and hands the same file to the grandchild, which appends its own once its
// SIGTERM trap is installed.
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { identityOf } from '../../../conformance/unit/process-registry'

const pidFile = process.argv[2]
const stubborn = join(import.meta.dir, 'stubborn-sleeper.ts')
// Recorded before the grandchild starts, so a failed read never leaves a
// started grandchild behind. The grandchild sleeps far longer than any
// timeout a test gives this fixture, so only the runner's kill can end it.
if (pidFile !== undefined) {
  const identity = identityOf(process.pid)
  if (identity === null) throw new Error(`spawns-stubborn-grandchild: cannot read the start time of pid ${process.pid}`)
  appendFileSync(pidFile, `${JSON.stringify({ ...identity, label: 'fixture' })}\n`)
}
spawn('bun', [stubborn, '60000', ...(pidFile === undefined ? [] : [pidFile])], { stdio: 'ignore' })
await new Promise(() => {})
