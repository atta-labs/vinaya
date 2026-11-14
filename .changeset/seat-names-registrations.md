---
"@attalabs/vinaya": patch
---

Generating the tool-server registrations (`.mcp.json` and the Codex `[mcp_servers]` tables) now reads the seat and server names from a names-only module instead of loading the tool server and every role's tools, so `init`, `upgrade` and `doctor` load less, and a change to one role's tools no longer selects every configuration-generating test. The generated registrations are byte-identical.
