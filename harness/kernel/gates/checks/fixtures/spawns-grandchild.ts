#!/usr/bin/env bun
// Fixture: spawns `sleep 1234` as a further subprocess, then hangs itself
// until killed. Proves the runner's timeout kill reaches the whole process
// GROUP, not just this direct child — without process-group kill, this
// grandchild `sleep` would survive the runner killing this fixture. An
// optional first argument names a file: the fixture appends the identity
// (pid and start time) of the grandchild, then of itself, to it as one JSON
// line each, so a test checks that these exact processes are gone instead of
// searching the machine for a command line.
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { identityOf } from '../../../conformance/unit/process-registry'

const pidFile = process.argv[2]
const grandchild = spawn('sleep', ['1234'], { stdio: 'ignore' })
if (pidFile !== undefined) {
  const record = (pid: number | undefined, label: string): void => {
    const identity = pid === undefined ? null : identityOf(pid)
    if (identity === null) throw new Error(`spawns-grandchild: cannot read the start time of the ${label} (pid ${pid})`)
    appendFileSync(pidFile, `${JSON.stringify({ ...identity, label })}\n`)
  }
  record(grandchild.pid, 'grandchild')
  record(process.pid, 'fixture')
}
await new Promise(() => {})
