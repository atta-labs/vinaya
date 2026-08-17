---
"@attalabs/vinaya": patch
"@attalabs/aeg-core": patch
"@attalabs/aeg-forge-state": patch
"@attalabs/aeg-types": patch
"@attalabs/vinaya-sources": patch
---

The four generated workflows now invoke `npx --yes @attalabs/vinaya@<exact-installed-version>`, the same exact-version pin the generated git hooks already carried and from the same source (`ownVersion()`). Previously they emitted a bare `npx --yes @attalabs/vinaya`, which reads as "always latest" and is not: `vinaya-checks.yml` installs the adopter's own dependencies before that line, so a repo carrying the CLI as a devDependency resolved `node_modules/.bin/vinaya` instead of the registry — measured, the same bare command printed `0.8.2` inside an adopter repo and `0.9.0` in `/tmp`. Unpinned, an adopter's CI version was an accident of a dependency no workflow referenced, and changing that dependency moved CI to registry latest with no commit and no diff. The generated workflows are managed artifacts, so `vinaya upgrade` rewrites an existing install's unpinned workflows to the pinned shape and re-pins them on each version bump; `vinaya doctor` reports a stale pin as drift. The git hooks are unchanged.
