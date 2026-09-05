# @attalabs/aeg-core

The pure, no-I/O core of the AEG (Agentic Engineering Governance) engine.

Two capabilities, plus two small non-pure helpers:

- **Parse** a repo's AEG artifacts — registry, tranche files, Issue/PR bodies, doc-owners bindings — into a typed model.
- **Derive** — `deriveTranche(tranche, forgeFacts)` produces per-task derived status, the dependency/conflict graph, and dispatch eligibility. Status is never stored; it is always derived from forge facts.
- **`ensureLabelExists`** (`src/ensure-label.ts`) — the idempotent "list, check, create" decision shared by every forge label-minting call site in this repo. Callers inject their own `listLabelNames`/`createLabel` I/O so this stays agnostic to shell mechanism and error-handling policy.
- **`hardenedMeteringDeps`** (`src/metering-io-guard.ts`) — the `MeteringCapabilityDeps` every real caller of `resolveMeteringCapability` should build from, rather than hand-rolling `existsSync`/`readFileSync`. Refuses a symlink, a FIFO/blocking special file, or a foreign-owned file at the transcript-pointer path (`O_NOFOLLOW | O_NONBLOCK` + an `fstat` owner check) instead of following/hanging on/trusting one. `claude-code-transcript.ts` itself stays pure — this is a sibling module, the one other deliberate exception alongside `ensure-label.ts` to this package otherwise being no-I/O.
- **The Vinaya Log's typed policy layer** (`src/log/`) — `LogEventSchema` (a zod union over the `dispatch` and `dev_review_loop` families), the pure `buildHeader(input)` envelope builder, and `redact(value, home)`. No filesystem, network, or process here; the one write lives in `@attalabs/vinaya`'s `apps/cli/src/lib/log-sink.ts` (`apps/cli/specs/log.md`).

The `bin/` directory carries the check binaries (`verify-dispatch`, `verify-docs`, `verify-coherence`, `open-pr`, `open-issue`, …) that mechanize the AEG gates. They are consumed through the `@attalabs/vinaya` CLI, which bundles this package at build time. `verify-dispatch`'s `Depends-on`/`Conflicts-with` resolver understands three edge shapes — a same-tranche bare task id, a bare `#NNN` Issue reference, and the cross-tranche `<slug> <n>` form — resolving the last one via the same tranche derivation used for the task's own tranche; an edge matching none of these reports `UNRESOLVABLE` rather than being read as an unmerged dependency.

Two `src/*.test.ts` files double as self-audit gates over this package's own tree, both `src/` and `bin/`: `symbol-collisions.test.ts` refuses a name declared in more than one non-test source file (a baselined `KNOWN_COLLISIONS` set covers what's already there), and `no-binary-sources.test.ts` refuses a tracked file that git treats as binary — either a literal NUL byte or a `.gitattributes` `binary` marking.

This package is published as TypeScript source (`main` points at `./src/index.ts`) — consume it with Bun or a TS-aware bundler, not plain Node.

Part of the fixed release group `@attalabs/aeg-types` / `@attalabs/aeg-forge-state` / `@attalabs/aeg-core` / `@attalabs/vinaya-sources` / `@attalabs/vinaya`: all five always share one version, and internal dependencies are pinned exactly.

## License

Apache-2.0
