---
'@attalabs/vinaya': patch
---

The Engine's CI read never polls a head the remote branch does not hold: with a pull request open and a local commit not yet pushed, both the version 1 and version 2 flows send the round back to the Developer to publish it, with no CI read. A remote head that cannot be read keeps its existing handling.
