---
'@attalabs/vinaya': patch
---

An invalid `vinaya.config.json` (or global config) is now reported instead of silently ignored: every command that loads configuration prints one diagnostic on standard error naming the file and each failing key, once per process, and still proceeds on built-in defaults. Inside a check the runner spawned, the same report arrives as one `warning` check-error line naming that check, so an invalid configuration never turns a passing check into a malformed-output error.
