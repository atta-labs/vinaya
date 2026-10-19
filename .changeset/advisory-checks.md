---
'@attalabs/vinaya': patch
---

A check can be declared advisory with `advisory: true` — in the core registry or in a `vinaya.config.json` check entry, documented as `checks.advisory` in the configuration reference. `doc-coverage-push`, `quoted-command`, `doctrine-portability` and `workspace-escape` carry it: `vinaya check --plan` shows an `ADVISORY` column (and `advisory: true` in `--plan --json`), and each result line `vinaya check` prints for an advisory check ends with ` — advisory`. The field is a label only; it changes nothing about how a check runs or how a run's exit code is computed.
