---
"@attalabs/aeg-core": patch
---

Adds an `effect` record kind to the control store: one file per key, carrying an external write's identity (operation, target, input version, payload digest) and its status (`started`/`verified`/`uncertain`), fenced by the task's current ownership epoch the same way every other write already is. `writeEffect`/`readEffect`/`parseEffectRecord`/`InvalidEffectKeyError` are the new exports.
