/**
 * The longest one dev-tools call may run before the agent's MCP client gives
 * up on it: thirty minutes, enough for `publish_changes` to run the pre-push
 * hook's affected test suite and push. Codex's default is 60 seconds, which
 * would abandon a publication mid-push; Claude Code's default is longer, and
 * its entry states the same limit so both agents declare one bound.
 *
 * One constant for every runner that registers the dev-tools server — the
 * standalone loop and the Engine adapters alike — so none of them can drift
 * to a shorter limit.
 */
export const DEV_TOOLS_TOOL_TIMEOUT_SEC = 1800
