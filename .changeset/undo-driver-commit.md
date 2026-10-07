---
'@attalabs/vinaya': patch
---

When the driver's own commit did not push and the Developer moves the branch back to the task branch's remote head with that commit's changes kept uncommitted, the next `publish_changes` publishes them as one commit instead of refusing that the head moved. Any other moved head is still refused.
