---
'@attalabs/vinaya': patch
---

The process registry reads a process start time from `/proc` where it exists and from `ps` elsewhere, without naming the platform. Every test loads it, and the read recorder marked each such test as branching on the platform, so a push from a Mac left almost every test to static selection.
