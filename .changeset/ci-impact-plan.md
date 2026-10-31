---
'@attalabs/vinaya': patch
---

This repository's CI now runs what one plan, computed in its build job from the shared test selection and the test inventory, says a pull request requires — tests, typecheck, lint, the root-configuration probe and the Linux sandbox suite — and its `Vinaya CI` check passes only for a valid plan bound to the run's head whose every required job succeeded; a change to the planner, the inventory, a runner configuration or the workflow still runs everything.
