---
"@attalabs/vinaya": patch
"@attalabs/aeg-core": patch
---

`token-collection-wired` gated on the wrong condition in both directions.

`resolveMeteringCapability` returned `no-transcript-resolved` for four distinct
situations, and the predicate treated all four as "nothing was ever wired, pass".
Only one of them is: a pointer file that exists but is unreadable, malformed, or
stale for this session is wiring that resolved and could not be reached — exactly
the state the check exists to refuse — and all three passed silently.

The opposite failure was reachable too: a plain human terminal, with no
`CLAUDE_CODE_SESSION_ID` to cross-check against, holding an earlier session's
leftover pointer in a shared `TMPDIR`, had its commits refused.

Both now turn on one condition — whether the pointer can be **corroborated** as
this session's. A new `pointer-unusable` reason distinguishes a broken pointer
from an absent one, and any incapable verdict on an uncorroborated pointer
degrades to the sanctioned operator-metered case rather than gating a commit.
