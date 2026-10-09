---
'@attalabs/vinaya': patch
---

A Developer turn after the first no longer gets a result schema that allows no `sourceUses` while the driver demands every Documentation source. The schema now requires the same sources the driver checks: those in the run's sources manifest, which the first turn writes and later turns keep.
