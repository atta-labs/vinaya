---
'@attalabs/vinaya': patch
---

After a rerun of failed checks, an unchanged Developer turn is judged against the head's CI as it reads now: a head that has turned green goes to review without another Developer turn, and a stall names only the checks still failing on that head.
