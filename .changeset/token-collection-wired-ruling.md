---
"@attalabs/vinaya": patch
"@attalabs/aeg-core": patch
---

A stale transcript pointer no longer refuses a commit.

Two reviewers reached opposite conclusions on this. The first read a stale
pointer as wiring that resolved and could not be reached — a defect. The second
showed that refusing it blocks a correctly wired host: a second agent session in
the same project directory sees the first session's pointer until its own Stop
hook fires, which by construction is only after its first turn completes, so its
very first commit is refused — and the remedy the message named (`--transcript`)
is a flag `vinaya check` does not accept, leaving no action that clears it.

The second reading wins. A pointer whose recorded session id disagrees with the
current one is provably NOT this session's, which is the can't-claim-it case,
not a broken-wiring case. `corroborated` now means one thing everywhere — "can
we show this pointer is ours" — which is also what the three shipped docs had
said all along while the code did something else.

Two related corrections ride along. A verdict degraded to
`no-transcript-resolved` now carries a detail consistent with that reason, where
before it kept a detail asserting a transcript HAD been resolved and was
unreadable — a contradictory pair that reached `vinaya doctor` and `pr report`'s
token cell. And `isTokenCollectionWiringBroken` returns a plain boolean again:
as a type predicate it was unsound, since `false` also covers the sanctioned
incapable case, so the negative branch narrowed to `capable: true` and a
`.summary` dereference compiled clean while throwing at runtime.
