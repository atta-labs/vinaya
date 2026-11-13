---
'@attalabs/vinaya': patch
---

Every test file that this repository's CI schedule, a local push and a review round run now starts in a runner process of its own, with its suite's runner, folder, configuration, environment and preload. The fifteen-minute runner limit now holds per file and applies on a push and in a review round as it already did in CI: a file still running at the limit is stopped, run once more alone, and on a second stop fails alone. Before, a local runner served up to forty files with no limit, so one hanging or crashing file cost the result of every file in its group.
