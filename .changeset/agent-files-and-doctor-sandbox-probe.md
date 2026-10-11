---
'@attalabs/vinaya': patch
---

`vinaya doctor` on Linux now runs the dispatch's own sandbox probe and reports, before any task is launched, whether a dispatched Claude agent could run a command on this host — naming `VINAYA_LINUX_SANDBOX_ALLOW_UNIX_SOCKETS` when the kernel refuses the sandbox's Unix-socket filter. A conformance test pins every generated agent file to the path and frontmatter its vendor documents.
