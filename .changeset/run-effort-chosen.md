---
"@attalabs/vinaya": minor
---

`vinaya task run` takes `--effort <level>` (one of `low`, `medium`, `high` or `xhigh`), and so do `vinaya-dispatch` and `vinaya-dev-review-loop`. On the standalone runner the developer and both reviewers are launched at the run's effort, `medium` when none is given: Claude Code with `--effort`, Codex with `-c model_reasoning_effort`. A resume keeps the effort its pause holds unless it is given another, the driver's re-exec and hand-off pass it on, and every printed resume command carries it. Any other value is refused with `--effort takes one of low, medium, high, xhigh.`, and the atta-engine runner refuses an explicit `--effort` for now.
