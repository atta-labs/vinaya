---
"@attalabs/vinaya": minor
"@attalabs/aeg-core": minor
"@attalabs/vinaya-sources": minor
---

Register the task-operator tools on Claude and Codex, and start one authorized run.

A shared, transport-agnostic MCP server (`vinaya task-tools serve`) binds the
task-tool catalog to its handlers and speaks newline-delimited JSON-RPC 2.0 over
stdio. Two runtime adapters register the same server: Claude via a generated
`.mcp.json`, Codex via its documented `[mcp_servers]` TOML. `task_start` wraps
the existing `runTask` composition — attended mode only, requiring an
authenticated caller from the invocation context, idempotent per request
identity, returning the durable run identity; there is no unattended path yet.
