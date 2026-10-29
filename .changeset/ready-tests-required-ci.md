---
"@attalabs/vinaya": minor
"@attalabs/vinaya-sources": patch
---

A self-hosting repository can opt its version-2 ready push, and the driver-owned repair pushes on its own open pull request, into required-CI testing with `prePush.readyTests` on its default branch. Those pushes keep Biome, every registered local check and the affected typecheck, then defer the selected test suite to the named required check instead of running it locally. The driver still runs the approved explicit Test Plan commands on the published head and records their receipts. The Evidence block and `vinaya pr report` show the deferred suite as pending in required CI, never as a pass. The run completes only once that check succeeds on the approved head. A CI setup or provider failure, or a stalled queue or run, pauses for the Operator; a code failure goes back to the Developer. Absent the setting, every push tests locally as before.
