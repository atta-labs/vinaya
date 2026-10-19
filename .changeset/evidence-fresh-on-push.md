---
'@attalabs/vinaya': minor
---

The generated `vinaya-review.yml` gains a second job, `vinaya check evidence-fresh`, which runs `evidence-fresh` on every push to a pull request and again when its body is edited, so a push with no following `vinaya pr report --push` turns that check red instead of producing no run at all. The job runs only the default branch's own CLI: it fetches the pull request head's commits as git objects to recompute the diff and never checks out, installs, builds or executes pull-request content. The review workflow now also triggers on `edited`. Run `vinaya upgrade` to regenerate the workflow, then add `vinaya check evidence-fresh` to the default branch's required status checks.
