---
"@attalabs/aeg-core": patch
"@attalabs/vinaya": patch
---

A transcript pointer written with an empty session id no longer refuses every
commit.

The shipped Stop hook writes `(hook.session_id || "") + "\t" + transcript_path`,
so a Stop payload carrying no `session_id` produces a pointer whose first
character is a tab. `resolveMeteringCapability` read it with `.trim()`, which ate
that leading tab; the subsequent `split('\t')` found no separator and classified
the pointer malformed. A pointer naming a present, readable, summarizable
transcript therefore refused every commit on a host that meters perfectly — the
expensive false-positive class this check was written to avoid. The read now
strips a trailing newline only.

The refusal condition is also stated honestly for the first time. It rests on two
grounds, and only one of them involves a session id: the pointer's recorded id
matches ours and the transcript it named could not be reached, or the id could
not be read at all and the file nonetheless sits at this project's own pointer
path owned by this user. An earlier revision set a single `corroborated` flag
from `Boolean(currentSessionId)` on branches where the id was never read, which
asserted a match that had not been established and left three shipped documents
describing a rule the code did not implement. Those documents now describe both
grounds.
