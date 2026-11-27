---
"@attalabs/vinaya": patch
---

`vinaya doctor` reports the OpenTelemetry address finding at info, not as a warning, in a CI job (`GITHUB_ACTIONS` or `CI` set) that holds no log credential, so the doctor step passes there as it does for the log destination finding. On a person's machine an unset credential variable is still warned of and named.
