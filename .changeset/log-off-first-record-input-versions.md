---
"@attalabs/vinaya": patch
"@attalabs/vinaya-log-sdk": patch
---

Three Log fixes. With `logs: false` in the settings, a harness process now writes no local copy at all, also when it was handed its runtime directory or runs unattended; an unattended process reads the switch from the default branch's settings, as it does its OpenTelemetry address. A Log SDK reader started at a run's beginning now expects each writer's first record to be numbered 1, the number every SDK writer gives it, so a run read from its start reports no gap; a writer whose records start at 0 is still read in full. An agent turn dispatched with review inputs records the brief, objectives, ruling and policy versions of those inputs on its records (`vinaya.input.*`), on the standalone dispatch and on the Engine runner, while the run's other records and a turn with none carry no versions.
