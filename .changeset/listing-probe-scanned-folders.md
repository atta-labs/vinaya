---
'@attalabs/test-selection': minor
'@attalabs/vinaya': patch
---

A read record can now say which folders a test's own code listed (`scanned`), apart from the folders Bun's module resolver listed to load a module (`listed`). With `scanned` in the record, a file added to or deleted from a folder selects only the tests whose code listed that folder, the tests that read a name there the new name can shadow (`mod.tsx` or `mod/` beside `mod.ts`), and, for a name the loader reads by convention (`package.json`, `tsconfig.json`, `jsconfig.json`, `bunfig.toml`, a `.env` name), every test that listed it. A new module beside modules a test only loads no longer selects that test. A record without `scanned` selects as before, and pass reuse still covers every listed folder. The read recorder fills `scanned` from a listing probe it preloads first in each Bun run, from the listings of every process the probe did not run in, and from tests whose source resolves a module specifier or mocks a module.
