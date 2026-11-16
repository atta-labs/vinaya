---
'@attalabs/vinaya': patch
---

Built files no longer carry the `// @bun` pragma line Bun's bundler writes, so Bun 1.4.4 decodes them as UTF-8: the dispatch-readiness check's title pattern matches a task title written `[<slug>] <n> — <title>` again, instead of finding no task of any tranche.
