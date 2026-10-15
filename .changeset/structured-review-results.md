---
'@attalabs/vinaya': patch
---

Production code and security reviewers return one structured ReviewResult through each CLI's native structured output (Claude Code `--json-schema`, Codex `--output-schema`) on fresh sessions; the controller binds it to run, round, attempt, role, head and the review-input manifest, refuses a reviewer resume, and no longer writes or reads the three reviewer result files.
