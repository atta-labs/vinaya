---
'@attalabs/vinaya': patch
---

Test selection no longer treats a package's `README.md`, `CHANGELOG.md` or `LICENSE` as a change to the whole package: a file with exactly one of those names selects only the tests that declare it as an input or scan its folder, while every other non-source file outside the package's test-data folders still selects every test that resolves through the package.
