---
'@attalabs/vinaya': patch
---

A cancel ends a run waiting out an agent's usage limit within 30 seconds, since the wait is slept in slices and the pause's resolution is read after each. `vinaya task switch` stops a driver that only waits in a held pause (refusing one working a turn, or one that does not exit within 30 seconds), and after a successful switch starts the run on the new agent in the background.
