---
"@attalabs/vinaya": minor
---

`vinaya dispatch`/`vinaya task dispatch` now accept `--model <name>`, passed to the chosen vendor through that vendor's own model flag; a dispatch's log line now records the model that actually ran instead of the vendor name. Naming no model lets a task's own "Suggested agent-class" rationale (`high`/`mid`/`fast`) resolve to a concrete model for vendors with a verified, non-stale class-to-model mapping (Claude today); an explicit `--model` always wins over that resolution. A model shaped as another vendor's own (a Claude alias or a `claude-`/`gemini-`/`gemma-`-prefixed name passed to the wrong vendor) is refused by name before any child spawns, naming the vendor and what it accepts.
