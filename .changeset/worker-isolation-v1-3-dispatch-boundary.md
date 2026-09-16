---
"@attalabs/vinaya": patch
"@attalabs/vinaya-sources": patch
---

An unattended dispatch (the automated `task run`/`dev-review-loop` driver, or `vinaya dispatch --unattended`) can now run inside an OS-level confinement boundary (Seatbelt on macOS: a named environment allowlist, a scoped working directory, no parent credentials) instead of inheriting the full operator environment. `dispatch.requireWorkerIsolation` defaults to `true` on macOS (the only currently supported host) and `false` elsewhere; set it explicitly in `vinaya.config.json` to override either default. With it on, a dispatch refuses before spawning rather than running unconfined when the boundary cannot be established.
