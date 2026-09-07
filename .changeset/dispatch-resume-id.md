---
"@attalabs/vinaya": patch
"@attalabs/vinaya-sources": patch
---

`dispatchRole`'s returned `DispatchHandle` now carries `resumeId` — the vendor's own session/thread identifier (claude/gemini: `session_id`; codex: `thread_id`) parsed from a successful dispatch's stdout, `null` on any failure. `dispatchRole` also accepts an optional `resumeId` on `DispatchOpts` that swaps in each vendor's own resume invocation (`claude -p -r <id> --output-format json`; `codex exec resume <id> --json -`; `gemini -p '' --resume <id> --output-format json --skip-trust`) instead of its first-dispatch args. `vinaya dispatch <role> --agent <vendor> ... --resume <id>` exposes this at the command line, printing `resumeId` alongside the existing fields.
