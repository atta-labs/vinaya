---
'@attalabs/vinaya': patch
---

Issue and pull-request reads handle more than 1 MiB of comments. One shared forge reader pages an Issue's comments through the REST listing and holds the whole read under a declared 64 MiB ceiling; the Issue write and edit gate, the dispatch lookup for an existing brief, the review publication that binds the frozen brief, the Objectives reader and the brief-shape check all read through it. A response above the ceiling is a typed refusal naming the Issue, the ceiling and the observed size, reported the same way by every caller, instead of a raw buffer overflow.
