---
'@attalabs/vinaya': patch
---

A Claude agent's tool calls can now be translated into plain actions — reading, searching, editing, creating, removing, running tests, type-checking, git, GitHub, tool request, skill, fetching, delegating — each with the file or command it acted on, the lines an edit added and removed, and whether it worked and how long it took. A call still waiting for its result is listed with how long it has waited. Nothing from a tool result is kept except a failure's first line, shortened and redacted. Nothing prints this yet.
