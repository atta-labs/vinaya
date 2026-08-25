---
"@attalabs/vinaya": patch
---

`bundle-doctrine.ts`'s `FILES` allowlist never got `milestone-model.md`/`task-model.md` added when they shipped — publishing would have bundled `tranche-model.md` but not its two new siblings, while `skills/aeg/SKILL.md`'s reading order (which does ship) pointed adopters at both. Fixed, with a regression test that runs the real script against the real `aeg-root/` and asserts every non-excluded top-level doctrine file actually lands in the bundled output.
