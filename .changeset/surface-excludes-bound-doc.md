---
"@attalabs/aeg-core": patch
"@attalabs/vinaya": patch
---

`vinaya issue create` and `vinaya issue edit` now refuse a task Issue whose `## Surface` `out:` list excludes a document `.vinaya/doc-owners` binds to a path its `in:` list covers, naming the binding and the two contradicting lines — the same predicate also runs as coherence check R2 over open task Issues, so an Issue written before this gate is reported instead of silently failing at the Developer's first commit.
