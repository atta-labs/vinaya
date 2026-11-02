---
'@attalabs/vinaya': patch
---

A push's local test runs never start a runner for more than 40 files: a native group over that cap is split into ordered chunks, each its own runner start, so the runner's memory is released between chunks. The CI schedule is unchanged.
