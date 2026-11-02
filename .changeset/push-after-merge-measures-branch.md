---
'@attalabs/vinaya': patch
---

A push made after merging the default branch now measures only the branch's own change: when the branch's first-parent history after the starting base holds a merge of a commit that base does not already hold, the pre-push hook's changed-file list and test selection are measured from the newest such merged commit. The rule reads only the branch's own history, so a merge of a commit fetched by URL, which leaves the remote-tracking ref stale, and a ready push whose named base is that stale ref are measured the same way. With no such merge, every push resolves its base as before.
