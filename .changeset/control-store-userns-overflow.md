---
'@attalabs/aeg-core': patch
---

The control store runs inside a Linux user-namespace sandbox: when the uid map leaves root unmapped, a directory owned by the kernel overflow uid is trusted strictly above the store's own root, never at or below it.
