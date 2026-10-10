---
'@attalabs/vinaya': patch
---

`vinaya task brief --supersede --surface-in` now grades the widened Issue body instead of the live body before the widen, so a frozen Issue the write gate refuses only for a Surface too narrow can be widened by the one sanctioned path. The gate still refuses when the widened body fails for any other reason, and a supersede without `--surface-in` grades the live body as before.
