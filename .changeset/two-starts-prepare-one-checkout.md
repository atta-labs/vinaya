---
'@attalabs/vinaya': patch
---

Two task starts that prepare the same clean checkout at once both finish: a start whose fetch or fast-forward lost to the other reads the checkout again and continues when it is at the remote tip, with no request to update it by hand.
