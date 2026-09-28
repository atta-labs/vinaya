---
'@attalabs/vinaya': minor
'@attalabs/vinaya-sources': minor
---

On macOS a `logs.headers` credential referenced as `${VAR_NAME}` now falls back to the login Keychain when that variable is unset in the process environment, so an Operator the Claude desktop app starts — whose environment carries no `VINAYA_LOG_TOKEN` — delivers logs with no token copied into any settings file (issue #841). The value is read from a generic-password item under the service `Vinaya Log`, keyed by the variable name as its account. The environment still wins wherever the variable is set, and Linux behaviour is unchanged (the read is darwin-only).

A new command, `vinaya log set-credential <VAR_NAME>`, stores that value into the Keychain from standard input — never a command-line argument a `ps` listing could show — and prints nothing of it.

`vinaya doctor`'s `[logs]` check now reports where each log credential was found — the environment, the macOS login Keychain, or nowhere — never its value.
