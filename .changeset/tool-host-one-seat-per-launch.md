---
'@attalabs/vinaya': patch
---

The task-tools server serves one seat per launch: a `--seat <name>` launch argument picks the seat, and a launch with none serves the Operator exactly as before, so every MCP configuration already generated keeps working. A seat the process does not declare refuses to start, naming the seats it does declare. The Operator keeps exactly its six tools, and the generated Claude and Codex configurations are unchanged.
