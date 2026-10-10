---
'@attalabs/vinaya': minor
---

Role skills now reach Claude Code as well as Codex and Gemini CLI. With the `claude` agent vendor selected, `init` writes `.claude/skills/vinaya-<role>/SKILL.md` beside the `/vinaya` command; the `skills` vendor keeps writing `.agents/skills/vinaya-<role>/SKILL.md`. Both are the same three-line pointer to `vinaya doctrine --role <role> --print` with the same `name` and `description`; the Claude-only `allowed-tools` grant now appears only in the Claude file. `upgrade` removes a retired role's skill from both directories. Hand-authored skills beside them are never touched.
