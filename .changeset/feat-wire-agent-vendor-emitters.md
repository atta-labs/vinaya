---
"@attalabs/vinaya": patch
---

Wire the three agent-native emitters (`.agents/skills/`, `.claude/commands/`, `.gemini/commands/`) into `init`/`upgrade`/`eject`/`doctor`. Add `vinaya init --agents=<comma-list|all|none>` (default `all`) and persist the selection into `vinaya.config.json`'s `managed.agents` so `upgrade`/`doctor` read it back instead of re-deriving a default.
