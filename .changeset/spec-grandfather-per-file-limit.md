---
'@attalabs/vinaya': patch
'@attalabs/aeg-core': patch
'@attalabs/vinaya-sources': patch
---

`proseGates.specGrandfather` now also accepts an object mapping each listed spec path to the most spec-class findings that file may carry. A listed file above its number fails `reader-resolvable-prose`, naming the file, its count and its limit; a file at or below it passes. A grandfathered spec can therefore no longer gain a plan reference, and its number is lowered as the spec is rewritten. The array form keeps exempting a whole file, and now prints one warning per entry saying so and naming the object form; nothing that passed before fails.
