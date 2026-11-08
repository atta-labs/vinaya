---
'@attalabs/vinaya': patch
---

Test selection keeps a test's own read record in three cases that sent it to static selection or made it read everything:

- The module resolver opening a `node_modules` folder no longer counts as a read of the whole lockfile. Bun opens that folder on every bare import, so nearly every test looked like a whole-lockfile reader and any dependency change selected them all.
- Git finding the repository (`HEAD`, `config`, the refs, an access of the objects folder) no longer marks a test for static fallback. Only a read of an object or the index does, and a `git show <rev>:<path>` style read is recorded as a read of that path.
- A push from macOS uses the same Linux record CI uses, so the push and CI select the same tests.
