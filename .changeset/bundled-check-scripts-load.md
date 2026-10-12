---
'@attalabs/vinaya': patch
'@attalabs/aeg-core': patch
---

Bundled check scripts, including `verify-dispatch`, decide whether they are the entry point through one ES-module-safe helper, so the built files no longer crash on load with `__require is not defined` and the dispatch-readiness gate runs for consumers of the published CLI.
