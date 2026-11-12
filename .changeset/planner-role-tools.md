---
'@attalabs/vinaya': minor
---

The Planner now has its own seat on the tool host (`--seat planner`, registered as `vinaya-planner-tools`), granted exactly six tools: `task_issue_create`, `task_issue_edit`, `task_issue_surface`, `task_objectives_edit`, `brief_render` and `task_issue_validate` (a dry run of the Issue write gate that writes nothing). Each calls the Planner library and returns its outcome; a refusal is a `validation` error whose `detail` is the JSON text of every finding as `{check, message, recovery}`. The generated Claude and Codex MCP configurations register both servers, and `.mcp.json` is a managed file that `vinaya upgrade` regenerates. The Planner's doctrine names the tools, with the commands as today's fallback.
