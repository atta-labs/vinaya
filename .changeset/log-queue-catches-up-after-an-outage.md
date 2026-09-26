---
"@attalabs/vinaya": patch
---

A `logs.url` server destination's local retry queue now catches up after an outage of any length. The drain delivers the queue from its head in chunks of at most 5 MiB, oldest first, and removes each chunk's bytes as soon as the server acknowledges them — a queue that grew past one POST during an outage is an ordinary backlog delivered over several POSTs, where before every drain refused it and nothing was ever sent again. A chunk the server does not accept ends the drain with the queue holding exactly what was never confirmed, and a retry after a lost acknowledgement re-sends the identical head chunk for the server to deduplicate by event identity.

Events the queue's rotation moved into its one backup slot are now delivered too, ahead of the live queue file and in order, instead of waiting there unread until the next rotation overwrote them.

A queued line the storage contract cannot vouch for — one that fails re-validation, carries an unknown schema version, or is by itself larger than one POST — is moved to a `<name>.rejected.ndjson` file beside the queue, with its reason, and the lines after it keep delivering. Before, any one such line made every drain throw before posting anything, forever. One line reaches stderr per process for this, however many lines are set aside.
