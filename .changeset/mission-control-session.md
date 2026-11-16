---
'@attalabs/vinaya': patch
---

`vinaya studio` now opens the repository you launch it from, or each `--repo <path>` you name, behind a one-time local session: the browser link works once and becomes an HttpOnly cookie, every request and WebSocket upgrade needs it, and Studio reports an invalid `logs` configuration or a missing read credential instead of choosing another source.
