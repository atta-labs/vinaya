---
'@attalabs/vinaya': patch
'@attalabs/vinaya-sources': patch
---

The dev-review-loop now runs a configured agent-configuration scanner before the security pass, outside the driver's trust, and the security pass reads its result instead of trying to run a scanner it has no permission for.

A new top-level config key, `securityScan.command`, names the scanner as an argv list with its version pinned (`["npx", "--yes", "ecc-agentshield@1.6.0", "scan"]`). When it is set and a pull request touches agent configuration — `.claude/**`, `.mcp.json`, `.agents/**`, a list fixed in code — the driver runs it once per round on the head-verified candidate copy, in a constructed environment carrying no forge credential, with a time limit and an output cap, and appends the directory to scan as a final argument (spawned via `execFile`, never a shell). The scanner's output reaches the security reviewer's prompt only, as input to its `CONFIG_SCAN` judgement, never the verdict. When no scanner is configured, the change touches no agent configuration, or the scan fails or times out, the security pass is told which it was and the round proceeds — the scan never pauses the loop. Every outcome is recorded in the driver Log. The key is read only from the default-branch trust anchor, never a pull request's own checkout.

The code-reviewer and security passes are now denied `npx`, and the security role doctrine tells a dispatched pass to read the provided scan and never install or run a scanner itself. This repository configures the scanner, so its own pull requests are scanned; adopters that want the same must set `securityScan.command` in their own `vinaya.config.json`.

`vinaya review post` now requires a `SECRETS: none found` evidence file to tie the passing `atta-labs/secret-scan` result to the judged head: the file must name the judged head's sha beside the passing line and no other commit's sha, so a scan result read on a different commit, or one tied to no commit at all, no longer backs the claim.
