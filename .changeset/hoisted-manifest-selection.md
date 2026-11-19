---
"@attalabs/test-selection": minor
---

Skip dependency-list-only edits to workspace manifests for recorded Bun tests whose only manifest open came from the module loader. This applies to hoisted installs, where installed module resolution comes from `node_modules`. Manifest data reads and independent selection reasons still select tests.
