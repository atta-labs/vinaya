---
'@attalabs/vinaya': patch
---

A Codex dispatch whose task already has a staged home now replaces that home's login copy when the operator's own `~/.codex/auth.json` is newer (compared by modification time, never by content), so a re-login reaches the next dispatch. The copy stays a separate file per home and is never written back to the operator's home. The helper is the exported `refreshStagedCodexLogin`.
