---
'@attalabs/vinaya': patch
---

The `doc-claims` check sweeps the doctrine pages under `proseGates.doctrineRoot` (`aeg-root` when unset) instead of a fixed `aeg-root`, and a root outside the repository leaves that half of its sweep empty. The `quoted-command` check is registered as a full-scope check, matching its whole-tree sweep: the pre-commit run skips it, the pre-push hook and CI still run it.
