---
'@attalabs/vinaya': patch
---

The version 2 ready push runs its pre-push hook and each explicit Test Plan command under a wrapper that stays the live leader of the command's process group: a command that exits leaving a descendant behind, even one holding its output open, now has that descendant stopped and its own result reported, instead of pausing the round with "refusing to signal an unowned group" or waiting out the ready-push deadline. A command killed by a signal is reported by the signal's name.
