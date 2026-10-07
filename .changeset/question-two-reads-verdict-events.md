---
'@attalabs/vinaya': patch
---

The Vinaya Log's question "are reviewers strict?" now reads each round's verdict event instead of a dispatch's outcome, which no longer records a verdict. For each reviewer role (code review and security) it reports the verdicts given, how many approved and how many asked for changes, and the findings and blockers by severity. A role comes from the round's per-reviewer entries where the event has them, and from each finding's severity scale otherwise; its coverage states how many rounds it could attribute to a role and how many it could not.
