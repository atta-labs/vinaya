---
'@attalabs/vinaya': minor
---

The package exposes two typed library entries beside its commands. `@attalabs/vinaya/harness` exports `resolveRepo`, which finds the repository's owner and name, and `loadProcess`, which reads and validates a process folder, with their types. `@attalabs/vinaya/process` exports `COMMIT_TYPE_STYLE`, `scanRetiredVocabulary`, `checkLocalAnchorCoverage` and `evaluateVocabularyCitation` with the types `AnchorSourceFile`, `VocabularyHit` and `VocabularyPattern`. Importing an entry installs and prints nothing. Importing the package root stays unsupported.
