---
'@attalabs/vinaya': minor
---

The installed package now carries its doctrine under `vinaya-strict/`, laid out as the Vinaya process keeps it: each role's doctrine in its role folder, the process-wide pages under `doctrine/`, the templates under `artifacts/templates/`. `vinaya doctrine` resolves it as before, with every flag unchanged; the front door it prints is now `vinaya-strict/doctrine/skills/vinaya/SKILL.md`. A Log header's `meta.doctrine` from a source checkout is now `doctrine@<id>`, an identity that changes only when a doctrine file changes.
