---
'@attalabs/vinaya': minor
---

One decision function now decides every loop stop. Both runners take the Developer-turn pause and the uncaught-round-error pause from it, with today's pause as the default for every event, and the Atta Engine runner retries a forge connection failure on the newest-ruling read (thirty seconds apart, three minutes in all) before it pauses.
