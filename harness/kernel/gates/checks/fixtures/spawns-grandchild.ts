#!/usr/bin/env bun
// Fixture: spawns `sleep 1234` as a further subprocess, then hangs itself
// until killed. Proves the runner's timeout kill reaches the whole process
// GROUP, not just this direct child — without process-group kill, this
// grandchild `sleep` would survive the runner killing this fixture. An
// optional first argument names a file: the fixture appends its own identity
// (pid and start time), then the grandchild's, to it as one JSON line each,
// so a test checks that these exact processes are gone instead of searching
// the machine for a command line. Its own identity is read before the
// grandchild exists, and a grandchild whose identity cannot be read is killed
// before the fixture fails, so a failed recording never leaves an unrecorded
// `sleep` behind.
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { identityOf } from '../../../conformance/unit/process-registry'

const pidFile = process.argv[2]
const record = (file: string, pid: number, label: string): boolean => {
  const identity = identityOf(pid)
  if (identity === null) return false
  appendFileSync(file, `${JSON.stringify({ ...identity, label })}\n`)
  return true
}

if (pidFile !== undefined && !record(pidFile, process.pid, 'fixture')) {
  throw new Error(`spawns-grandchild: cannot read the start time of pid ${process.pid}`)
}
const grandchild = spawn('sleep', ['1234'], { stdio: 'ignore' })
if (pidFile !== undefined && (grandchild.pid === undefined || !record(pidFile, grandchild.pid, 'grandchild'))) {
  grandchild.kill('SIGKILL')
  throw new Error(`spawns-grandchild: cannot read the start time of the grandchild (pid ${grandchild.pid})`)
}
await new Promise(() => {})
