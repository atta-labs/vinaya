---
"@attalabs/aeg-core": patch
"@attalabs/aeg-forge-state": patch
"@attalabs/vinaya-sources": patch
"@attalabs/aeg-types": patch
---

Adds a `files` allowlist to all four packages that previously had none, so `npm pack`/`npm publish`
ships only each package's real entry-point surface instead of the whole working directory (`#180`).
`aeg-core` no longer ships its `bin/` CLI scripts, `*.test.ts` files, or `src/fixtures/**`; the other
three drop their `*.test.ts` files. Test fixtures for all four packages — including `aeg-forge-state`'s
six verbatim internal Issue-body fixtures and `aeg-core`'s `docs-coherence` synthetic doctrine trees —
move from `src/fixtures/` to a `tests/fixtures/` directory beside the suites that read them, so the
disclosure is closed by relocation regardless of the allowlist. No behavior change for any real import:
each package's documented entry point and named sub-exports were proven to resolve from a fresh
`npm install` of the packed tarball outside this workspace.
