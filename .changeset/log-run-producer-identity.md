---
'@attalabs/vinaya': patch
---

Every Vinaya Log event a run writes names the run that produced it: a standalone run records runner `standalone` at the CLI's version and, in a checkout, the Vinaya process's version and digest, on a fresh start and on a resume alike; both runners record the agent they dispatch as `meta.runtime`, and dispatched roles carry the same identity. A command run by hand keeps today's header.
