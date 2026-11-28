---
"@attalabs/vinaya-log-sdk": patch
"@attalabs/vinaya": patch
---

Sending the local copy skips what an earlier send finished at a fixed cost: one summary in the delivery folder lists the files staged to their end with their sizes, so a file at that size is neither read nor marked again, and a record whose sent receipt is listed is not opened. A missing or unreadable summary is rebuilt from the size markers. A send now stages the newest file first and posts each record as soon as it is staged, with up to eight requests in flight, before the records earlier sends left unsent.
