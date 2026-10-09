---
'@attalabs/vinaya': patch
---

The live result proof now checks that each turn's schema blocks a missing source and an unknown finding id. Both cases pass when the provider refuses the invalid value or the agent reports a valid one instead, print which of the two happened, and fail only when the driver accepts the invalid value.
