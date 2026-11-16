---
'@attalabs/vinaya': patch
---

A tag-only push of commits the remote default branch already reaches, such as the release's `git push origin --tags`, runs the Vinaya checks in this repository's pre-push hook and then stops, without the typecheck or the tests.
