import { SANDBOX_PROBE_MARKER } from '../../../src/lib/worker-boundary.js'

/**
 * Shell lines a fake `claude` puts right after its shebang. On Linux, a
 * fixture that stubs `bwrap` and `socat` makes the dispatch confined, so the
 * driver first runs its sandbox probe through the fake binary. The probe's
 * argv names the marker command; these lines answer that call the way a
 * working sandbox would — one Bash tool result carrying the marker — and exit
 * before the fake records anything, so the fixture sees only the real dispatch.
 */
export const FAKE_CLAUDE_PROBE_ANSWER = `case "$*" in *${SANDBOX_PROBE_MARKER}*) cat > /dev/null; printf '%s\\n' '${JSON.stringify(
  {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'probe', content: SANDBOX_PROBE_MARKER }] }
  }
)}'; exit 0;; esac\n`
