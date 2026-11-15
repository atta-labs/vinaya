---
'@attalabs/vinaya': patch
---

A reviewer's scratch copy now follows the judged head. When a run resumed inside the same round after the Developer moved the head, the stager rebuilt the shared review candidate but handed each reviewer the scratch copy built for the earlier head, so both reviewers read old files and an old diff. The scratch copy is now cached under the staged head as well as the round, role, attempt, candidate folder and repair, so a moved head rebuilds it and an unchanged head still reuses it.
