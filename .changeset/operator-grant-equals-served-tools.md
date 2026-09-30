---
'@attalabs/aeg-core': minor
'@attalabs/vinaya': patch
---

The Operator is granted exactly the task tools the task-tools server serves; the unserved `task_status_follow` tool is dropped.

The Operator's grant named a seventh tool, `task_status_follow`, that the server never listed, so a call to it was refused as "no such task tool" and the grant check could never refuse anything on the real call path. `OPERATOR_TOOL_GRANT` is now the catalog's tool names, so the role file, its contracts, the planner reference and the conformance spec say "the task tools the server serves" and carry no fixed count. `bun apps/cli/src/index.ts task status --follow` is unchanged and stays a command for the Principal.

**Breaking for `@attalabs/aeg-core` consumers:** the `OPERATOR_STATUS_FOLLOW` export is removed. `apps/cli/tests/lib/operator-grant.test.ts` now asserts the grant, the catalog, the role file's `allowed-tools`, the generated skill and the server's `tools/list` are the same set.
