---
'@attalabs/vinaya': patch
---

A local push selects tests again from the files that directly import a change, as it did before tests were selected from recorded reads, so a change in a widely imported package no longer selects nearly every test while no read record exists; CI keeps the full import closure. The folder-scanning test declarations are a plain literal again, so the push reads them and a changed doc file selects the tests that scan it instead of every test.
