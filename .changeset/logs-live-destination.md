---
"@attalabs/vinaya-sources": patch
"@attalabs/vinaya": patch
---

`vinaya.config.json` gains a `logs` setting: a folder (the default, under the repository's own `runtimeDir`) or a server, mutually exclusive, with header values that may reference an environment variable so a credential never sits in the config. Events reach this destination live, as they occur — a folder is appended to directly, a server is drained from a local retry queue immediately after each append, in order, surviving an outage. Honoured from the working tree for an attended caller; an unattended one only honours a value the repository's default branch also declares.

The developer-review loop's round-end flush, its flush on every pause exit, its final flush, and `vinaya dispatch`'s own trailing flush are all removed — there is nothing left to batch or ship after the fact, since every event already reached its configured destination the moment it was logged. `vinaya log flush`/`vinaya log collect-artifact` are unaffected: `logPublish` still backs those two commands' own manual, one-shot posting.
