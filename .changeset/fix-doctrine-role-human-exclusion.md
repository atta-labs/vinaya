---
"@attalabs/vinaya": patch
---

`vinaya doctrine --role <name>` now excludes roles whose frontmatter declares `actor: human` (`principal`) from its live-enumerated valid set. Every `--role` consumer — the CLI itself, and the `.agents/skills/`/`.claude/commands/`/`.gemini/commands/` emitters that shell out to it — is fixed by this one change: a third-party AI tool can no longer be told to act as the human-only Principal role.
