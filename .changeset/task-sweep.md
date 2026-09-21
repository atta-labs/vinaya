---
"@attalabs/vinaya": minor
"@attalabs/vinaya-sources": minor
---

`vinaya task sweep [--include-legacy] [--json]` removes the folder of every task whose Issue is closed or whose pull request is merged or closed, keeping a folder with an open pull request, a live driver, or a pause — every folder removed or kept prints its reason, and a forge read failure removes nothing rather than guessing. `--include-legacy` also lists the seven top-level folders an earlier layout left under the Vinaya home, attributed to this repository only through their own path or record content, and removes only what it can both attribute this way and classify finished. The driver (`dev-review-loop`/`task run`) now calls the same sweep at the start of every run, before dispatching anyone, so a finished task's folder never accumulates just because no one ran the command by hand; a sweep failure there is reported and ignored, never a reason a run stops.
