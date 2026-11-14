#!/usr/bin/env bun
// Fixture: sleeps for `argv[0]` ms (default 0), then exits 0. Used to test
// runner-enforced timeouts and concurrency capping. An optional second
// argument names a file: before sleeping, the fixture appends its own identity
// (pid and start time) to it as one JSON line, so a test can check that this
// exact process is gone afterwards instead of searching the machine for a
// command line.
import { appendFileSync } from 'node:fs'
import { identityOf } from '../../../conformance/unit/process-registry'

const ms = Number(process.argv[2] ?? '0')
const pidFile = process.argv[3]
if (pidFile !== undefined) {
  const identity = identityOf(process.pid)
  if (identity === null) throw new Error(`sleeper: cannot read the start time of pid ${process.pid}`)
  appendFileSync(pidFile, `${JSON.stringify({ ...identity, label: 'sleeper' })}\n`)
}
await new Promise((resolve) => setTimeout(resolve, ms))
process.exit(0)
