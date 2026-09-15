---
"@attalabs/vinaya": patch
"@attalabs/vinaya-sources": patch
---

An unattended dispatch (the automated `task run`/`dev-review-loop` driver, or `vinaya dispatch --unattended`) can now run inside an OS-level confinement boundary (Seatbelt on macOS: a named environment allowlist, a scoped working directory, no parent credentials) instead of inheriting the full operator environment. Off by default — set `dispatch.requireWorkerIsolation: true` in `vinaya.config.json` once a repo's own unattended runs happen on a supported host; with it on, a dispatch refuses before spawning rather than running unconfined when the boundary cannot be established.
