---
'@attalabs/vinaya': minor
---

A layer-G evaluation trial can run inside a container that is its own sandbox: an explicit, off-by-default container mode runs the role in the given working tree, authenticates Claude from the subscription token in `CLAUDE_CODE_OAUTH_TOKEN`, and lets the one-task container be the boundary only when the trial entry set it, the process runs on Linux with `/.dockerenv` present and no other driver-run socket exists.
