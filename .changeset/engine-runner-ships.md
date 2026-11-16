---
'@attalabs/vinaya': minor
---

The published package carries the Atta Engine runner and can run it. The runner and the wrapper its ready push runs each supervised command under are built programs of the package (`vinaya-run-engine`, `vinaya-supervised-command`), and the package carries a copy of every file the process loader pins under `dist/vinaya-strict`, so the process loads from an install with the digest it has in a checkout. The runner finds the process folder, the role files, the command line entry, the dev-tools bridge, the check program and the wrapper from the package's built files, and reads the Engine's version from its bundled manifest. `task run` starts the built runner with Bun in an install and the runner's source file in a checkout; the Engine runner needs Bun.
