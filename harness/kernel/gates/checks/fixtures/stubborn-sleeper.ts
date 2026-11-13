#!/usr/bin/env bun
// Fixture: traps/ignores SIGTERM, so only a SIGKILL escalation can actually
// terminate it. Proves the runner's timeout kill doesn't just fire-and-forget
// a single SIGTERM against a check that refuses to die. An optional second
// argument names a file: once the trap is installed, the fixture appends its
// own identity (pid and start time) to it as one JSON line, so a test knows
// the trap was in place before any signal arrived and can check that this
// exact process is gone afterwards.
import { appendFileSync } from 'node:fs'
import { identityOf } from '../../../conformance/unit/process-registry'

process.on('SIGTERM', () => {})
const ms = Number(process.argv[2] ?? '0')
const pidFile = process.argv[3]
if (pidFile !== undefined) {
  const identity = identityOf(process.pid)
  if (identity === null) throw new Error(`stubborn-sleeper: cannot read the start time of pid ${process.pid}`)
  appendFileSync(pidFile, `${JSON.stringify({ ...identity, label: 'stubborn-sleeper' })}\n`)
}
await new Promise((resolve) => setTimeout(resolve, ms))
process.exit(0)
