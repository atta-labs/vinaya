---
'@attalabs/vinaya': patch
---

The log credential check now counts a token stored in the macOS Keychain, so `vinaya log selftest` finds it.

`logsCredentialMissing` — the check that gates `vinaya log selftest`'s ingest-credential step and the CI destination path — tested the process environment only. But header substitution (`resolveLogsHeaderValues`) already falls back to the macOS login Keychain for a `${VAR}` a `logs.headers` value references, so a token stored with `vinaya log set-credential VINAYA_LOG_TOKEN` and left out of the environment read back as *missing*: the self-test failed with "this host holds no ingest credential" even though a real send would have delivered it.

The check now consults the same two sources delivery does, in the same order — the environment, then (its fallback) the Keychain — through the same `readLogHeaderKeychainCredential` reader, so the check and the delivery it gates can never disagree about whether a credential exists. The environment still wins, and an empty value from either source is no credential (a withheld fork-PR secret stays "missing"). The Keychain reader is darwin-only, so on Linux and in CI, where it is a no-op, a variable set in neither place still reads as missing exactly as before.
