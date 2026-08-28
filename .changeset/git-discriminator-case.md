---
"@attalabs/vinaya": patch
---

A managed-block path in `vinaya.config.json` that isn't byte-exactly
`.git/…`, `.husky/…`, or `.vinaya/hooks/…` is now refused at the parse
layer. Closes two escapes from the `.git/` prefix check in `lib/ops.ts`:
a case variant (`.GIT/config`, on case-insensitive filesystems) and a bare
`.git` with no trailing slash (on every filesystem, previously an unhandled
`EISDIR` crash rather than a clean refusal). Neither escape is reachable
from a vinaya-generated manifest — this only changes what a hand-edited or
hostile manifest can do.
