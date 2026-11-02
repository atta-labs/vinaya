---
'@attalabs/vinaya': patch
---

A `bun.lock` change that only moves workspace folders or local paths no longer selects every test at a local push: the selection library reads a `bun-lock` input as its dependency identity — the whole lockfile with only its path text replaced and its workspaces keyed by name — so a package, version, integrity, range, override or setting change, or a lockfile that does not parse, still reaches every reader.
