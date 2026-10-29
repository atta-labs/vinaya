---
'@attalabs/vinaya': patch
---

The commit-msg hook now accepts the message of a merge commit: it recognises a merge by the merge in progress instead of a source keyword that git never passes to this hook, so the driver's pre-turn merge and a person's merge both land.
