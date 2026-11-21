---
"@attalabs/vinaya": patch
"@attalabs/vinaya-log-sdk": patch
---

`vinaya task status --follow` shows the narrative again on every runner: a run that records no steps of its own (the Engine runner today) shows each agent step from the driver log, an agent turn converted from an earlier role attempt is narrated with its seat ("The developer finished its turn." instead of "A role finished its turn."), and a run read from its local copy no longer reports a false "sequence 0 never arrived" gap, because a Log SDK writer numbers its records from 1.
