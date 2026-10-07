---
'@attalabs/vinaya': patch
---

A change to a published package's shipped files can no longer be pushed without a changeset. The pre-push hook and CI now refuse it, and the message names both remedies: add a changeset describing the change, or add an empty one (`bunx changeset add --empty`) when the change ships nothing users see.
