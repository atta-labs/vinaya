#!/usr/bin/env bun
// Fixture: spawns `sleep 60` as a further subprocess, then hangs itself
// until killed. Proves the runner's timeout kill reaches the whole process
// GROUP, not just this direct child — without process-group kill, this
// grandchild `sleep` would survive the runner killing this fixture.
//
// The grandchild's own pid is written to `GRANDCHILD_PID_FILE` (task-run-v1
// 20, O2) so the test can probe that EXACT pid rather than grepping the
// system process list for the literal string "sleep 60" — a plain `sleep
// 60` is not a distinctive enough pattern to rule out an unrelated process
// elsewhere on a shared machine happening to run the same command.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const grandchild = spawn('sleep', ['60'], { stdio: 'ignore' })
const pidFile = process.env.GRANDCHILD_PID_FILE
if (pidFile && grandchild.pid !== undefined) writeFileSync(pidFile, String(grandchild.pid))
await new Promise(() => {})
