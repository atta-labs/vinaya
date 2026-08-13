# Vinaya

Private monorepo for **Vinaya** — the agentic engineering harness — and the **AEG** engine that powers it.

This repository is the extraction target of the AEG implementation currently living in the public
[`atta-labs/attalabs`](https://github.com/atta-labs/attalabs) monorepo. The engine packages
(`aeg-core`, `aeg-forge-state`, `aeg-types`), the Vinaya CLI, and the AEG doctrine move here so that
AEG's implementation stops being world-readable.

**This repository is private and is intended to stay private.**

## Layout

```
vinaya/
├── apps/
│   └── cli/                  # Vinaya CLI
├── packages/
│   ├── aeg-core/             # Pure gate evaluators
│   ├── aeg-forge-state/      # Forge-derived tranche/task state
│   ├── aeg-types/            # Shared types
│   ├── sources/              # State and doctrine sources
│   └── typescript-config/    # Shared TypeScript configs
└── aeg-root/                 # AEG doctrine
```

Only `packages/typescript-config` exists today; the remaining workspaces arrive with the extraction.

## Tooling

Bun + Turborepo, Biome for formatting and linting, TypeScript in strict mode.

```bash
bun install
bunx turbo typecheck
bunx turbo build
bunx biome check .
```
