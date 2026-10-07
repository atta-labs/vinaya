---
'@attalabs/aeg-core': patch
---

One function in the log module, `narrate`, turns a loop or dispatch record into one plain line with a kind and the words, so the terminal log and a live screen use the same wording. A round end states the confidence as recorded, a pause or stop says who has to act, and a record it has no wording for returns nothing.
