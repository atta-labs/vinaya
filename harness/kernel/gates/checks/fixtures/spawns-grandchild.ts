#!/usr/bin/env bun
// Fixture: spawns `sleep 1234` as a further subprocess, then hangs itself
// until killed. Proves the runner's timeout kill reaches the whole process
// GROUP, not just this direct child — without process-group kill, this
// grandchild `sleep` would survive the runner killing this fixture. The
// uncommon duration (not the round `60` an unrelated poll loop elsewhere on
// the machine is far more likely to also be running) is deliberate — the
// test's own survivor check greps for this exact command line system-wide.
import { spawn } from 'node:child_process'

spawn('sleep', ['1234'], { stdio: 'ignore' })
await new Promise(() => {})
