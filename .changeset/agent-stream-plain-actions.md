---
'@attalabs/vinaya': patch
---

Each agent's live stream now reads as plain actions with real marks. A dispatched Claude Code, Codex or Gemini run shows "Editing apps/cli/src/lib/dispatch.ts +14 −3", a done line with its duration and a failed line with its first error line, instead of event names such as `item.completed`. The agent's own words and a command's text sit beneath the action, and the driver log file carries each line's working, done or failed mark and always keeps those detail lines.
