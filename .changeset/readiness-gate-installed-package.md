---
'@attalabs/vinaya': patch
---

The loop's dispatch-readiness gate now runs from an installed package: both of its steps are resolved through the CLI's own distribution rather than paths relative to the current directory, and the existing-work dispatch verification is bundled beside the core checks. A step that cannot be found pauses the round with a refusal naming it and saying the installed package is incomplete, instead of a raw "Module not found".
