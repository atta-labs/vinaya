---
'@attalabs/aeg-core': patch
'@attalabs/vinaya': patch
---

The repeat-finding stop now identifies a finding by reviewer role, file and a normalized description fingerprint instead of the positional identifier, so a new finding that reuses an earlier round's F1 no longer pauses the loop as a repeat.
