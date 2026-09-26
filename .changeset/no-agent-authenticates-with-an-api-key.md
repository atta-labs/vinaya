---
"@attalabs/vinaya": patch
---

No dispatched agent authenticates with an API key any more. Every API-key route is removed: the per-vendor credential allowlist a confined worker inherited is gone (`buildWorkerEnv` no longer takes a passthrough parameter at all, so there is no key to thread one through under), the pre-spawn credential check now asks the one question that remains — was a subscription login staged — and the excluded sibling key in a task-scoped Codex home goes with it. Codex keeps its subscription login unchanged, bootstrap token included: that token is read from the operator's own cached session and replayed through `codex login --with-access-token`, never set on a confined child's environment.

A dispatch that finds no subscription login now says where it looked and how to sign in — the `.credentials.json` path under the Claude config directory and `claude`'s own `/login`, or `auth.json` under `CODEX_HOME` and `codex login` — instead of naming a missing environment variable.

Dispatching `gemini` unattended refuses before any spawn, on every host, because Gemini has no subscription login in Vinaya yet. An attended `gemini` dispatch is unchanged, as is every dispatch with the worker sandbox off: the agent still inherits the operator's environment whole and signs in with its own login.
