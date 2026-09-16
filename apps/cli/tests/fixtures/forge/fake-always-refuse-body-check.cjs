// Fixture for `runBodyChecks` (apps/cli/tests/lib/dev-review-loop.test.ts,
// Issue #639): a `validates: 'body'` config-registered check that always
// refuses, regardless of `PR_BODY` content — deterministically drives
// `refuse()`'s real `process.exit(1)` path during a driver-owned evidence-
// report push, without needing a live PR or a specific body shape.
process.stderr.write(
  `${JSON.stringify({
    schema: 1,
    check: 'fixture/always-refuse-body',
    severity: 'error',
    message: 'fake-always-refuse-body: fixture forces a body-check refusal',
    agent_recovery_prompt: 'fixture only — no real fix'
  })}\n`
)
process.exit(1)
