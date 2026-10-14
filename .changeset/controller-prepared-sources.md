---
'@attalabs/vinaya': patch
'@attalabs/aeg-core': patch
---

The controller now prepares every required source of a brief before each Developer turn — every round and every resume — pinning a repository source by its git object at the frozen base and a public page by the digest it fetched, and pauses with `missing_source` and a typed reason when one cannot be prepared, including a page behind a login. The required-source manifest and every delivery receipt live in a controller-owned store outside both agents' writable roots, `fetch_documentation` records each delivery against that manifest by source identity with any revision mismatch decided by policy, and completion reads only those receipts; the agents' Stop hooks remain as reminders only.
