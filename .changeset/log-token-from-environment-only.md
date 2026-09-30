---
'@attalabs/vinaya': patch
'@attalabs/vinaya-sources': patch
---

The log delivery token now comes only from the environment; the macOS Keychain source and `vinaya log set-credential` are removed.

A `logs.headers` value referencing `${VAR_NAME}` is substituted from the process environment alone (`resolveLogsHeaderValues`). The macOS login Keychain fallback added in 0.36.0 (service `Vinaya Log`, read with `security find-generic-password`) is gone from every path — header substitution, `logsCredentialMissing`, `vinaya doctor`'s `[logs]` credential-source line, and `vinaya log selftest` — so no code reads, writes or probes the Keychain for a log credential on any platform. `vinaya doctor` and `vinaya log selftest` report a missing credential by naming the environment variable to set, never the Keychain.

`vinaya log set-credential` is removed: the command, its tests and its command-reference entry are gone, and `vinaya log` lists only `selftest` and `send`. It served no consumer — a consumer points `logs.url` at a server and exports the token — and its tests read the real login Keychain, which failed every push from a Mac holding the token. An adopter that stored its token only in the Keychain must now export the variable instead.
