---
'@attalabs/vinaya': patch
---

The dev-tools bridge runs as its own program file inside the installed package (`dist/kernel/tools/host/dev-tools-bridge.js`) instead of the `task-tools dev-bridge` command, which is removed. An agent's sandbox runs that file with `--socket <path>` and an optional `--capability <value>` and reaches the driver's tool host exactly as before.
