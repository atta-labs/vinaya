---
'@attalabs/vinaya': minor
'@attalabs/vinaya-sources': minor
'@attalabs/aeg-core': minor
---

The version 2 ready push's test-run limit is now `reviewPolicy.readyPushTimeoutMinutes` (default 20, a positive integer), read from the default branch like `maxRounds` and overridable in the gitignored local configuration file. A run stopped at its limit pauses for a person, naming the limit and the number of selected test files, instead of being sent back to the Developer as a test failure. The setting is not part of the policy digest.
