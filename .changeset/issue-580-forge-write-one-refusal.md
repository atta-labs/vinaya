---
"@attalabs/vinaya": patch
---

`issue create`/`issue edit`'s write gate now runs every gate group (title grammar, issue content, rendered-brief shape, the registry's `validates: 'issue'` checks) over one buffered body and refuses once with the union of every finding, instead of stopping at the first failing group — a body with three independent defects used to cost three separate runs, one fix per run, because each run only ever saw the group it happened to reach first. Every recovery prompt this gate composes now also quotes the specific line or field it refuses, then states the edit that clears it, rather than only restating the rule.
