---
'@attalabs/vinaya': patch
---

A Codex agent's commands, file changes, tool calls and messages become the same plain actions as a Claude agent's, built from a recorded real Codex stream. The agent's final turn-result message is reported as one action with its status and confidence instead of being printed, and the driver's own tools (fetching documentation, running checks, publishing, opening and reading the pull request) read as plain actions for both agents.
