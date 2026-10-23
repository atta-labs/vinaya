---
'@attalabs/vinaya': patch
---

The Engine Flow reads the forge's mergeability, its CI and the premise pins as their own steps, in the standalone round order: a conflicting head goes back to the Developer with its files before any CI wait, a pending CI read is waited on, a red one is part of the gate and an unchanged red head's failed jobs are rerun once, and a stale pin pauses before any reviewer. The mergeability poll, the premise re-check and the conflict prompt now live in the shared gate-reading module.
