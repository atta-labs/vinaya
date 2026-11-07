#!/usr/bin/env bun
// Fixture: emits one CheckError JSON line marked `pending: true` (waiting on
// a step outside the diff, e.g. a Principal tick), exits 1.
process.stderr.write(
  `${JSON.stringify({
    schema: 1,
    check: 'fixture-pending',
    severity: 'error',
    message: 'The fixture is waiting on a later step.',
    agent_recovery_prompt: 'Complete the step this fixture is waiting on.',
    pending: true
  })}\n`
)
process.exit(1)
