---
"@attalabs/vinaya": minor
---

The pre-push test selector now resolves imports and exports with the TypeScript compiler instead of regular expressions, and selects by the exported names a diff changed rather than by the changed file.

Three behaviours change. A relative specifier written with the extension the emit will have — `./thing.js` for `./thing.ts`, and the `.jsx`/`.mjs`/`.cjs` equivalents — resolves to its TypeScript source; on a repository that writes imports that way, those edges were previously absent from the graph entirely, so changing a file could select no test at all. Named imports, re-export chains and bare workspace-package specifiers now resolve through the compiler's own module resolution and alias chain, with the workspace entrypoint taken from each package's manifest rather than from whatever an installer linked into `node_modules`; every shape the compiler cannot prove — a namespace or default import, `export *`, a side-effect or dynamic import, an ambiguous star export, a package with no derivable entrypoint — keeps the coarse whole-package edge, so selection can widen but never omits. And each changed file's diff hunks are attributed to the top-level declarations they touch, closed over intra-file references, so a test is selected only when its import closure reaches a use of an affected name; any hunk that cannot be attributed to one declaration makes the whole file affected.

A test whose input is the repository TREE rather than its own imports — one that walks source files from disk and asserts something about all of them — is now selected from the directory it scans. No import edge can reach such a test's real inputs, so previously only explicit configuration could select it.

The compiler is resolved at runtime from the repository being analyzed, never bundled: package size and install footprint are unchanged, and a repository with no `typescript` installed falls back to the previous text-scan graph, which also gained the output-extension resolution.
