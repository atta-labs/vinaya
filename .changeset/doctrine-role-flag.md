---
"@attalabs/vinaya": minor
---

`vinaya doctrine --role <name>` resolves straight to a specific role's doctrine (`aeg-root/roles/<name>.md`) under the same root `vinaya doctrine` (no flag) already resolves — the same `resolveDoctrineRoot()` logic, one new join applied after root resolution succeeds. The requested name is validated against the role names actually enumerated under `roles/*.md` at request time, never a hardcoded list, so an unknown name fails cleanly with the valid names listed rather than a silent bad path. This is the shared foundation every future per-agent-CLI doctrine wrapper (Claude Code, Codex, Gemini CLI, …) builds on top of.
