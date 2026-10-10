---
'@attalabs/vinaya': patch
---

A new `doc-claims` check runs on every `vinaya check --all` — in the pre-push hook, in CI and through the controller's check tool. It fails when a documentation-claim marker parses as neither form, or when a bound sentence's cited file no longer holds the text it cites.
