---
'@attalabs/vinaya': patch
---

A task whose Surface names a folder inside the dispatched agent's own configuration — `.claude/rules` for Claude, `.agents/skills` for Codex — now lets the Developer write there, and only there: every other configuration path, `.mcp.json` included, stays write-denied. Claude Code and Codex give the same answer for the same Surface, a missing folder named with a trailing `/**` is created before the turn, and a symbolic link anywhere on the path opens nothing.
