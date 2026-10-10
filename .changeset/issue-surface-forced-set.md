---
'@attalabs/aeg-core': minor
'@attalabs/vinaya': minor
'@attalabs/vinaya-sources': minor
---

New `vinaya issue surface --body-file <path>` prints what a draft Issue's Boundary pins force on its `## Surface`: every tracked source or test importing a pinned file, marked reached by an `in:` glob, disclaimed in the Boundary's `Out:` clause, or uncovered with the glob that would reach it; plus the CI shard list for a new pinned test file and the loop invariant map for a new pinned loop file. It writes nothing and exits 0, or 2 when the body does not parse. `vinaya issue create` and `vinaya issue edit` now refuse an Issue when any importer of a pinned file is undecided — one covered importer no longer silences the rule for the others — and both the report and the refusal come from one function, `decidePinnedFileImporters`.
