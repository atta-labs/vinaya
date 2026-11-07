// Fixture for `runBodyChecks`/`collectBodyCheckErrors`
// (apps/cli/tests/lib/forge-write.test.ts): a `validates: 'body'`
// config-registered check whose outcome is driven entirely by a marker in
// `PR_BODY` — standing in for a real check's pending (a wait state only
// someone else can clear) vs. structural (the author's own to fix)
// distinction without needing a live PR.
//
// One binary serves two config entries with DIFFERENT specs: one registered
// `principalOwed: true` (standing in for `test-plan`), one registered WITHOUT
// that flag (standing in for `principal-test-plan-wait`, which must never
// carry it — see its registry entry). `argv[2]` is the entry's own check
// name, so each marker drives exactly ONE of them and the other passes: the
// two registrations must never both report on one body, or a case meant to
// isolate the unflagged entry would refuse through the flagged one too.
const body = process.env.PR_BODY || ''
const selfName = process.argv[2] || ''

const FLAGGED = 'fixture/principal-owed'
const UNFLAGGED = 'fixture/unflagged-wait'

function emit(pending) {
  const error = {
    schema: 1,
    check: selfName,
    severity: 'error',
    message: `${selfName}: fixture finding`,
    agent_recovery_prompt: 'fixture only — no real fix'
  }
  if (pending) error.pending = true
  process.stderr.write(`${JSON.stringify(error)}\n`)
}

/** `[reporting entry, pending flags to emit]` for the body's marker, or null to pass. */
function caseFor(text) {
  // `CASE_UNFLAGGED_*` first: each of those markers also contains the shorter
  // `CASE_*` substring, so matching that family first would make them
  // unreachable.
  if (text.includes('CASE_UNFLAGGED_PENDING_ONLY')) return [UNFLAGGED, [true]]
  if (text.includes('CASE_UNFLAGGED_STRUCTURAL')) return [UNFLAGGED, [false]]
  if (text.includes('CASE_UNFLAGGED_MIXED')) return [UNFLAGGED, [true, false]]
  // Fails emitting no error at all — a crash/malformed-stderr stand-in. This
  // aggregation reports emitted errors, so such a failure surfaces no finding
  // at all: pre-existing behavior, asserted as a boundary guard, never as
  // something the pending-only exclusion decides.
  if (text.includes('CASE_UNFLAGGED_SILENT_FAILURE')) return [UNFLAGGED, []]
  if (text.includes('CASE_PENDING_ONLY')) return [FLAGGED, [true]]
  if (text.includes('CASE_STRUCTURAL')) return [FLAGGED, [false]]
  if (text.includes('CASE_MIXED')) return [FLAGGED, [true, false]]
  return null
}

const found = caseFor(body)
if (found === null || found[0] !== selfName) {
  process.exit(0)
}
for (const pending of found[1]) emit(pending)
process.exit(1)
