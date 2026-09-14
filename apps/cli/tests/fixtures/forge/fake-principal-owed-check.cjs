// Fixture for `runBodyChecks` (apps/cli/tests/lib/forge-write.test.ts, task
// driver-lifecycle-v1/5): a `validates: 'body'`, `principalOwed: true`
// config-registered check whose outcome is driven entirely by a marker in
// `PR_BODY` — standing in for `test-plan`'s real unticked-`[principal]`
// (pending) vs. no-`## Test Plan`-section (structural) distinction without
// needing a live PR.
const body = process.env.PR_BODY || ''

function emit(pending) {
  const error = {
    schema: 1,
    check: 'fixture/principal-owed',
    severity: 'error',
    message: 'fake-principal-owed: fixture finding',
    agent_recovery_prompt: 'fixture only — no real fix'
  }
  if (pending) error.pending = true
  process.stderr.write(`${JSON.stringify(error)}\n`)
}

if (body.includes('CASE_PENDING_ONLY')) {
  emit(true)
  process.exit(1)
} else if (body.includes('CASE_STRUCTURAL')) {
  emit(false)
  process.exit(1)
} else if (body.includes('CASE_MIXED')) {
  emit(true)
  emit(false)
  process.exit(1)
} else {
  process.exit(0)
}
