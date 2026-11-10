---
'@attalabs/vinaya': patch
---

Every entry point — the command line, the program entry, the Engine runner, the ring-2 audit, the test preload, the push-progress programs and the evaluation programs — installs Vinaya's Log sink factory, configuration provider and check registry through one kernel call on the integration module `process.yaml` declares, which refuses an integration that lacks a part; a test ties each entry point to the declared module.
