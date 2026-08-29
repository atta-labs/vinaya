# @attalabs/aeg-core

The pure, no-I/O core of the AEG (Agentic Engineering Governance) engine.

Two capabilities, plus one small shared I/O-injected helper:

- **Parse** a repo's AEG artifacts — registry, tranche files, Issue/PR bodies, doc-owners bindings — into a typed model.
- **Derive** — `deriveTranche(tranche, forgeFacts)` produces per-task derived status, the dependency/conflict graph, and dispatch eligibility. Status is never stored; it is always derived from forge facts.
- **`ensureLabelExists`** (`src/ensure-label.ts`) — the idempotent "list, check, create" decision shared by every forge label-minting call site in this repo. Callers inject their own `listLabelNames`/`createLabel` I/O so this stays agnostic to shell mechanism and error-handling policy.

The `bin/` directory carries the check binaries (`verify-dispatch`, `verify-docs`, `verify-coherence`, `open-pr`, `open-issue`, …) that mechanize the AEG gates. They are consumed through the `@attalabs/vinaya` CLI, which bundles this package at build time.

Two `src/*.test.ts` files double as self-audit gates over this package's own tree, both `src/` and `bin/`: `symbol-collisions.test.ts` refuses a name declared in more than one non-test source file (a baselined `KNOWN_COLLISIONS` set covers what's already there), and `no-binary-sources.test.ts` refuses a tracked file that git treats as binary — either a literal NUL byte or a `.gitattributes` `binary` marking.

This package is published as TypeScript source (`main` points at `./src/index.ts`) — consume it with Bun or a TS-aware bundler, not plain Node.

Part of the fixed release group `@attalabs/aeg-types` / `@attalabs/aeg-forge-state` / `@attalabs/aeg-core` / `@attalabs/vinaya-sources` / `@attalabs/vinaya`: all five always share one version, and internal dependencies are pinned exactly.

## License

Apache-2.0
