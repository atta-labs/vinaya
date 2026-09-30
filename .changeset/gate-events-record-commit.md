---
'@attalabs/vinaya': patch
---

Gate events in the Vinaya Log record the commit they were checked at as `subject.sha`, so a repeated run on unchanged code can be told from a re-run on new code.
