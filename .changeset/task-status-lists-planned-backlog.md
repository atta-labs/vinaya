---
'@attalabs/vinaya': patch
---

`vinaya task status` and `task_status` now show a planned backlog task — an open Issue with a frozen brief that has never been started — as `not started`, so the Operator no longer reads "no open task matches" for it and refuses to start it. Naming the Issue reads it directly; the full listing finds such Issues with one extra forge search however many there are. An open backlog Issue with no frozen brief is still left out.
