---
'@attalabs/vinaya': patch
---

A refused `publish_changes` no longer advances the loop's recorded publication base: a local rebase onto a newer default-branch tip is refused by the base check itself, and undoing it publishes again against the base the turn started from. The base still moves forward at a Developer turn start, after a publication that pushed, and through the fast-forward-onto-the-default-tip rule.
