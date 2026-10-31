---
'@attalabs/vinaya': patch
---

Test selection no longer treats a package's own test, spec or fixture data as a change to the whole package: a non-source file under its `tests`, `test`, `__tests__`, `specs` or `fixtures` folder selects only the tests that import it or that the test inventory declares as reading it, while its `package.json`, `tsconfig.json` or a shipped asset still selects every test that resolves through the package.
