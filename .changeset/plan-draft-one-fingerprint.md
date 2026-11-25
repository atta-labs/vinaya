---
"@attalabs/vinaya": patch
---

The Planner can hold a whole plan as one draft with stable task numbers and one fingerprint, stored on the machine outside the repository. `plan_draft_submit` stores it and `plan_draft_read` reads it back. A premise can now be written `after task <n>:` to name a task of the plan, while `after #<n>:` keeps meaning a published Issue.
