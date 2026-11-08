---
'@attalabs/vinaya': patch
---

After a default-branch merge, a refused or passing push re-runs only what the branch itself changed: when a merge lies since the recorded head, the native push keeps comparing with that head and runs its failed tests plus only the planned tests the branch's own changes reach — the paths that still differ from the commit the merge brought in. A root configuration change only the default branch brought in no longer turns the push into a merge-base comparison; one the branch made, in its commits or in the merge resolution, still does. The printed plan says how many planned tests the branch-side set left out.
