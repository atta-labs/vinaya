---
'@attalabs/vinaya': patch
---

An Engine agent turn whose dispatch lost its role's dev-tools host (the socket was removed before the dispatch's bridge connected) is dispatched again once, the same turn with the same prompt and session, after the host is replaced on the same path. A re-dispatch that is lost again pauses the run, naming both losses.
