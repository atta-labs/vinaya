---
"@attalabs/vinaya": patch
---

`vinaya init product --path` now refuses a backtick, closing a silent round-trip
corruption: the registry parser strips backticks from every cell (its own
code-span convention), so a declared path containing one was written verbatim
and read back as a different path, with nothing reporting the difference.
