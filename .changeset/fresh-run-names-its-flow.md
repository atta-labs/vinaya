---
'@attalabs/vinaya': patch
---

A fresh Engine run that names no flow now records the flow it loaded (the process default, v2). Before, its arguments said no flow while it ran v2, so a round reviewed before any pull request existed handed both reviewers an empty pull request body instead of the one the Developer staged, fetched CI for a pull request that did not exist, and reviewed a repair against the whole diff. A run continued from its checkpoint was not affected.
