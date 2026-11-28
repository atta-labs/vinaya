---
"@attalabs/vinaya": patch
---

Staging a Codex home for a loop dispatch, and refreshing its login copy before a later dispatch, now read the operator's Codex login from the directory `CODEX_HOME` names, and from `.codex` under the home directory when it is unset, through the same `operatorCodexAuthPath` rule the rest of the kernel uses. An operator whose login lives in another directory is no longer told there is no login. With `CODEX_HOME` set to a directory that holds no login, staging returns null and refreshing changes nothing; the login under the home directory is never read in its place. `stageCodexPolicyHome` and `refreshStagedCodexLogin` take an optional `env` input, defaulting to the process environment, so no caller changes.
