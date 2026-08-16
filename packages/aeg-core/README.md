# @attalabs/aeg-core

The pure, no-I/O core of the AEG (Agentic Engineering Governance) engine.

Two capabilities:

- **Parse** a repo's AEG artifacts — registry, tranche files, Issue/PR bodies, doc-owners bindings — into a typed model.
- **Derive** — `deriveTranche(tranche, forgeFacts)` produces per-task derived status, the dependency/conflict graph, and dispatch eligibility. Status is never stored; it is always derived from forge facts.

The `bin/` directory carries the check binaries (`verify-dispatch`, `verify-docs`, `verify-coherence`, `open-pr`, `open-issue`, …) that mechanize the AEG gates. They are consumed through the `@attalabs/vinaya` CLI, which bundles this package at build time.

This package is published as TypeScript source (`main` points at `./src/index.ts`) — consume it with Bun or a TS-aware bundler, not plain Node.

Part of the fixed release group `@attalabs/aeg-types` / `@attalabs/aeg-forge-state` / `@attalabs/aeg-core` / `@attalabs/vinaya-sources` / `@attalabs/vinaya`: all five always share one version, and internal dependencies are pinned exactly.

## License

Apache-2.0
