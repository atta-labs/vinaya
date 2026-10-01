---
'@attalabs/vinaya': patch
'@attalabs/vinaya-sources': patch
---

An unattended Claude run inside the worker sandbox now signs in with the operator's own Keychain subscription login on macOS, and the sandbox is always on where it is supported.

The Controller reads the `Claude Code-credentials` Keychain entry outside the sandbox and stages only the subscription login into the child's scratch config directory; the file copy stays the route for hosts that have one. `USER`/`LOGNAME` join the worker environment allowlist. The no-login refusal names the Keychain entry. `dispatch.requireWorkerIsolation` is removed. An unattended Codex dispatch refuses where the sandbox is unsupported rather than running against the real `~/.codex`.
