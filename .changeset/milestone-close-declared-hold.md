---
'@attalabs/vinaya': patch
'@attalabs/vinaya-sources': patch
---

`vinaya milestone close` refuses to close a Milestone whose `### Tranche intents` section declares a tranche that is not complete, naming each unfinished tranche and its lifecycle, and a dry run with `--validate-only` refuses with the same reasons; it shares that decision with `vinaya archive tranche`.
