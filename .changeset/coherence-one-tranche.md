---
'@attalabs/vinaya': patch
'@attalabs/aeg-forge-state': patch
---

The coherence check reads only its own tranche's Milestone facts, so one run makes a constant number of GraphQL reads instead of one Issue list read per tranche label in the repository.
